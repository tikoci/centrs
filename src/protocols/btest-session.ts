/**
 * btest session layer — the stateful half that drives the pure codec
 * (`btest.ts`) and the shared EC-SRP5 core (`ec-srp5.ts`) over real sockets.
 *
 * Sequencing is grounded byte-for-byte on `manawenuz/btest-rs`
 * (`src/protocol.rs`, `client.rs`, `server.rs`, `bandwidth.rs`, `ecsrp5.rs`),
 * the MITM-verified reference against RouterOS 7.x:
 *
 *   1. TCP control on port 2000. Server → HELLO `01 00 00 00`.
 *   2. Client → 16-byte command packet.
 *   3. Server → auth response: `01..`(none/OK) / `02`(MD5, legacy/unsupported) /
 *      `03`(EC-SRP5) / `00`(failed). EC-SRP5 then runs the 4-message
 *      `[len][payload]` exchange and the server sends a final `01 00 00 00`.
 *   4. **UDP only:** the server then writes the 2-byte big-endian server UDP
 *      port on the TCP channel; the client's UDP port is `+256`.
 *   5. Data: TCP bulk on the same socket, or UDP datagrams `[seq u32 BE][payload]`
 *      on the negotiated ports. Throughput/CPU are exchanged as 12-byte status
 *      messages (~1/s) — symmetrically on the TCP control channel for a UDP test;
 *      for a TCP test only the *receiving* server emits them (the client never
 *      sends TCP status). Senders adapt rate from the peer's reported
 *      `bytesReceived`: `newSpeed = bytesReceived * 8 * 3 / 2`.
 *
 * The transport seams (TCP control channel, UDP socket) are injectable so the
 * client↔server matrix is loopback-testable without a router; the CHR
 * integration test (`test/integration/btest.test.ts`) is the real-RouterOS gate.
 *
 * Scope: UDP, plus TCP single- **and** multi-connection. For `connection-count > 1`
 * the client reads the session token from the primary's OK, opens the extra data
 * connections (each: read the server HELLO, send the 16-byte join
 * `[token:u16 BE][0x02][0 …]`, then bulk data flows — the server sends **no** ack
 * before data), and drives them into one shared `BandwidthCounters` so throughput
 * aggregates. The secondary-join format is grounded byte-for-byte against RouterOS
 * 7.23.1 (captured all directions; the `0x02` marker is direction-independent).
 * Authenticated (EC-SRP5) multi-connection is not yet supported — the post-auth
 * token is not captured — so those sessions stay single-stream.
 */

import { createSocket } from "node:dgram";
import { connect as netConnect, type Socket } from "node:net";
import { CentrsError } from "../errors.ts";
import {
	BTEST_AUTH_EC_SRP5,
	BTEST_HELLO,
	BTEST_PORT,
	BTEST_STATUS_MSG_SIZE,
	BTEST_STATUS_MSG_TYPE,
	BTEST_UDP_PORT_START,
	type BtestAuthKind,
	type BtestCommand,
	type BtestCommandOptions,
	type BtestDirection,
	type BtestProtocol,
	type BtestStatus,
	classifyAuthResponse,
	clientUdpPort,
	decodeCommand,
	decodeStatus,
	defaultTxSize,
	encodeAuthFrame,
	encodeAuthOk,
	encodeClientHello,
	encodeCommand,
	encodeConfirmation,
	encodeSecondaryJoin,
	encodeServerChallenge,
	encodeStatus,
	encodeUdpPacket,
	parseClientHello,
	parseServerChallenge,
	readUdpSequence,
	serverDirectionByte,
} from "./btest.ts";
import {
	bytesToBigIntBE,
	ecSrp5ClientConfirm,
	ecSrp5ClientShared,
	ecSrp5Id,
	ecSrp5Keygen,
	ecSrp5ServerConfirm,
	ecSrp5ServerPublicKey,
	ecSrp5ServerShared,
} from "./ec-srp5.ts";

/** Default status-exchange cadence (RouterOS uses ~1s). */
export const BTEST_STATUS_INTERVAL_MS = 1000;
/** Auth control words the server can return (`02` = legacy MD5). */
export const BTEST_AUTH_MD5_BYTE = 0x02;

// ── ByteReader: sequential async reader over a chunk stream ───────────────────

/**
 * Buffers inbound byte chunks and serves them either as exact-length frames
 * ({@link readExact}, for the control handshake/status) or as the next available
 * run ({@link read}, for bulk TCP data). A channel only ever uses one mode at a
 * time, so the two never race.
 */
class ByteReader {
	private chunks: Uint8Array[] = [];
	private buffered = 0;
	private exactWaiters: {
		need: number;
		resolve: (bytes: Uint8Array) => void;
		reject: (error: Error) => void;
	}[] = [];
	private anyWaiter:
		| {
				resolve: (bytes: Uint8Array | null) => void;
				reject: (e: Error) => void;
		  }
		| undefined;
	private ended = false;
	private failure: Error | undefined;

	push(chunk: Uint8Array): void {
		if (chunk.length === 0) return;
		this.chunks.push(chunk);
		this.buffered += chunk.length;
		this.drain();
	}

	end(): void {
		this.ended = true;
		this.drain();
	}

	fail(error: Error): void {
		this.failure ??= error;
		this.drain();
	}

	/** Bytes currently buffered (for tests/diagnostics). */
	get available(): number {
		return this.buffered;
	}

	private take(n: number): Uint8Array {
		const out = new Uint8Array(n);
		let offset = 0;
		while (offset < n) {
			const head = this.chunks[0] as Uint8Array;
			const want = n - offset;
			if (head.length <= want) {
				out.set(head, offset);
				offset += head.length;
				this.chunks.shift();
			} else {
				out.set(head.subarray(0, want), offset);
				this.chunks[0] = head.subarray(want);
				offset += want;
			}
		}
		this.buffered -= n;
		return out;
	}

	private takeAll(): Uint8Array {
		const out = this.take(this.buffered);
		return out;
	}

	private drain(): void {
		// Satisfy exact-length frame waiters in order.
		while (this.exactWaiters.length > 0) {
			const waiter = this.exactWaiters[0] as (typeof this.exactWaiters)[number];
			if (this.failure) {
				this.exactWaiters.shift();
				waiter.reject(this.failure);
				continue;
			}
			if (this.buffered >= waiter.need) {
				this.exactWaiters.shift();
				waiter.resolve(this.take(waiter.need));
				continue;
			}
			if (this.ended) {
				this.exactWaiters.shift();
				waiter.reject(
					new CentrsError({
						code: "routeros/btest-protocol",
						summary: `btest control stream ended mid-frame (needed ${waiter.need} more bytes).`,
						remediation: "The peer closed the connection during the handshake.",
					}),
				);
				continue;
			}
			break;
		}
		// Satisfy a pending bulk reader.
		if (this.anyWaiter) {
			if (this.failure) {
				const w = this.anyWaiter;
				this.anyWaiter = undefined;
				w.reject(this.failure);
			} else if (this.buffered > 0) {
				const w = this.anyWaiter;
				this.anyWaiter = undefined;
				w.resolve(this.takeAll());
			} else if (this.ended) {
				const w = this.anyWaiter;
				this.anyWaiter = undefined;
				w.resolve(null);
			}
		}
	}

	readExact(n: number): Promise<Uint8Array> {
		return new Promise((resolve, reject) => {
			this.exactWaiters.push({ need: n, resolve, reject });
			this.drain();
		});
	}

	/** Resolve with the next available bytes, or `null` at clean EOF. */
	read(): Promise<Uint8Array | null> {
		return new Promise((resolve, reject) => {
			if (this.anyWaiter) {
				reject(new Error("btest ByteReader: concurrent read() not supported"));
				return;
			}
			this.anyWaiter = { resolve, reject };
			this.drain();
		});
	}
}

// ── Control channel (TCP) ─────────────────────────────────────────────────────

/** Bidirectional, framed control channel — the btest TCP/2000 stream. */
export interface BtestControlChannel {
	/** Read exactly `n` bytes (handshake + status frames). */
	readExact(n: number): Promise<Uint8Array>;
	/** Read the next available bytes (bulk TCP data); `null` at EOF. */
	read(): Promise<Uint8Array | null>;
	/** Write bytes, resolving once flushed past backpressure. */
	write(bytes: Uint8Array): Promise<void>;
	/** Close the underlying transport. */
	close(): void;
	/** Peer address label for envelopes/logs, when known. */
	readonly remoteAddress?: string;
}

/**
 * Wrap a connected `node:net` socket as a {@link BtestControlChannel}. `node:net`
 * is used (rather than the native-API path's `Bun.connect`) because btest pushes
 * bulk bidirectional data: `node:net`'s internal write queue + `drain`
 * backpressure is the right fit for a throughput sender, where the native API
 * only ever writes small command sentences.
 */
export function channelFromSocket(socket: Socket): BtestControlChannel {
	const reader = new ByteReader();
	let closed = false;
	socket.on("data", (chunk: Buffer) => reader.push(new Uint8Array(chunk)));
	socket.on("end", () => reader.end());
	socket.on("close", () => {
		closed = true;
		reader.end();
	});
	socket.on("error", (error: Error) => {
		closed = true;
		reader.fail(error);
	});
	const remote = socket.remoteAddress;
	return {
		readExact: (n) => reader.readExact(n),
		read: () => reader.read(),
		write: (bytes) =>
			new Promise<void>((resolve, reject) => {
				if (closed) {
					reject(new Error("btest channel is closed"));
					return;
				}
				let settled = false;
				const onClose = (): void =>
					finish(new Error("btest channel closed during write"));
				const finish = (error?: Error): void => {
					if (settled) return;
					settled = true;
					socket.removeListener("close", onClose);
					socket.removeListener("error", onClose);
					socket.removeListener("drain", onDrain);
					if (error) reject(error);
					else resolve();
				};
				const onDrain = (): void => finish();
				// A destroyed socket never emits `drain`, so a write parked on
				// backpressure must also unblock on close/error — otherwise the TX
				// loop (and the whole session) hangs when the peer/abort tears down
				// the connection mid-transfer.
				socket.once("close", onClose);
				socket.once("error", onClose);
				const flushed = socket.write(bytes, (error) => {
					if (error) finish(error);
				});
				if (flushed) finish();
				else socket.once("drain", onDrain);
			}),
		close: () => {
			closed = true;
			try {
				socket.destroy();
			} catch {
				/* already closed */
			}
		},
		...(remote ? { remoteAddress: remote } : {}),
	};
}

/** Connect a TCP control channel to a btest server. */
export function connectBtestControl(
	host: string,
	port: number = BTEST_PORT,
): Promise<BtestControlChannel> {
	return new Promise((resolve, reject) => {
		const socket = netConnect({ host, port });
		socket.setNoDelay(true);
		const onError = (error: NodeJS.ErrnoException): void => {
			const code = error.code;
			if (code === "ECONNREFUSED") {
				reject(
					new CentrsError({
						code: "transport/connection-refused",
						summary: `No btest server answered on ${host}:${port}.`,
						remediation:
							"Enable /tool/bandwidth-server on the device (or start `centrs btest server`) and check the host/--port.",
						context: { host, port, cause: code },
						cause: error,
					}),
				);
				return;
			}
			reject(
				new CentrsError({
					code: "transport/network",
					summary: `Failed to open the btest control connection to ${host}:${port}.`,
					remediation: "Check the host, --port, and network reachability.",
					context: { host, port, cause: code },
					cause: error,
				}),
			);
		};
		socket.once("error", onError);
		socket.once("connect", () => {
			socket.removeListener("error", onError);
			resolve(channelFromSocket(socket));
		});
	});
}

// ── UDP data socket ───────────────────────────────────────────────────────────

/** Datagram socket seam for the UDP data path. */
export interface BtestUdpSocket {
	/** Bind to `host:port`; resolves with the actually-bound port. */
	bind(port: number, host: string): Promise<number>;
	/** Pin the default destination (so {@link send} needs no address). */
	connect(port: number, host: string): Promise<void>;
	/** Send a datagram; `port`/`host` override the connected default. */
	send(bytes: Uint8Array, port?: number, host?: string): void;
	/** Register the inbound-datagram handler. */
	onMessage(handler: (bytes: Uint8Array) => void): void;
	close(): void;
}

/** Production UDP socket over `node:dgram` (udp4). */
export function createBtestUdpSocket(): BtestUdpSocket {
	const socket = createSocket({ type: "udp4", reuseAddr: true });
	let handler: ((bytes: Uint8Array) => void) | undefined;
	socket.on("message", (message: Buffer) => handler?.(new Uint8Array(message)));
	return {
		bind: (port, host) =>
			new Promise<number>((resolve, reject) => {
				// Keep a permanent error listener so runtime errors (e.g. ICMP
				// "port unreachable" → ECONNREFUSED when a SLIRP peer is
				// unreachable) don't crash the process as unhandled events.
				// Only reject on errors that arrive before the socket is bound.
				let bound = false;
				socket.on("error", (error: Error): void => {
					if (!bound) reject(error);
					// Post-bind errors are swallowed: the UDP TX loop already
					// handles send failures via try/catch; ICMP-driven errors
					// arriving on the event queue are expected when the peer is
					// behind NAT (e.g. SLIRP) and cannot receive our datagrams.
				});
				socket.bind(port, host, () => {
					bound = true;
					resolve(socket.address().port);
				});
			}),
		connect: (port, host) =>
			new Promise<void>((resolve, reject) => {
				socket.connect(port, host, (error?: Error) =>
					error ? reject(error) : resolve(),
				);
			}),
		send: (bytes, port, host) => {
			if (port === undefined) socket.send(bytes);
			else socket.send(bytes, port, host);
		},
		onMessage: (next) => {
			handler = next;
		},
		close: () => {
			try {
				socket.close();
			} catch {
				/* already closed */
			}
		},
	};
}

// ── Bandwidth accounting + timing (bandwidth.rs) ──────────────────────────────

/** Per-interval sample handed to the orchestrator's report/CSV stream. */
export interface BtestIntervalSample {
	seq: number;
	txBytes: number;
	rxBytes: number;
	lostPackets: number;
	txBps: number;
	rxBps: number;
	localCpu: number;
	remoteCpu: number;
}

export type BtestStopReason =
	| "duration-elapsed"
	| "interrupted"
	| "peer-closed"
	| "transport-error";

/**
 * Mutable throughput counters shared between a session's TX/RX/status loops —
 * the TS analog of btest-rs `BandwidthState`. Interval counters are read with a
 * swap-to-zero; cumulative totals only grow.
 */
export class BandwidthCounters {
	txBytes = 0;
	rxBytes = 0;
	rxPackets = 0;
	rxLost = 0;
	totalTx = 0;
	totalRx = 0;
	totalLost = 0;
	intervals = 0;
	/** Sender's current target rate (bits/sec); 0 = unlimited. */
	txSpeed = 0;
	txSpeedChanged = false;
	remoteCpu = 0;
	running = true;
	private lastSeq: number | undefined;
	private stopResolvers: (() => void)[] = [];

	addTx(n: number): void {
		this.txBytes += n;
	}
	addRx(n: number): void {
		this.rxBytes += n;
	}

	/** Account a received UDP packet and its sequence-gap loss. */
	observeUdpSeq(seq: number, byteLength: number): void {
		this.rxBytes += byteLength;
		this.rxPackets += 1;
		if (this.lastSeq !== undefined) {
			const expected = (this.lastSeq + 1) >>> 0;
			if (seq > expected) this.rxLost += seq - expected;
		}
		this.lastSeq = seq;
	}

	swapTx(): number {
		const v = this.txBytes;
		this.txBytes = 0;
		return v;
	}
	swapRx(): number {
		const v = this.rxBytes;
		this.rxBytes = 0;
		return v;
	}
	swapLost(): number {
		const v = this.rxLost;
		this.rxLost = 0;
		return v;
	}

	recordInterval(tx: number, rx: number, lost: number): void {
		this.totalTx += tx;
		this.totalRx += rx;
		this.totalLost += lost;
		this.intervals += 1;
	}

	stop(): void {
		if (!this.running) return;
		this.running = false;
		for (const resolve of this.stopResolvers) resolve();
		this.stopResolvers = [];
	}

	/** Resolve as soon as {@link stop} is called — lets blocked reads bail out. */
	stopped(): Promise<void> {
		if (!this.running) return Promise.resolve();
		return new Promise((resolve) => this.stopResolvers.push(resolve));
	}

	summary(): {
		totalTx: number;
		totalRx: number;
		totalLost: number;
		intervals: number;
	} {
		return {
			totalTx: this.totalTx,
			totalRx: this.totalRx,
			totalLost: this.totalLost,
			intervals: this.intervals,
		};
	}
}

/**
 * Inter-packet send interval in milliseconds for a target rate, or `null` for
 * unlimited (speed 0). Mirrors `bandwidth::calc_send_interval`: intervals over
 * 500 ms clamp to 1 s.
 */
export function calcSendIntervalMs(
	speedBps: number,
	txSize: number,
): number | null {
	if (speedBps <= 0) return null;
	const bitsPerPacket = txSize * 8;
	const intervalMs = (1000 * bitsPerPacket) / speedBps;
	if (intervalMs > 500) return 1000;
	return Math.max(intervalMs, 0);
}

/** Speed-feedback rule: the peer's bytes/interval → our target bits/sec. */
export function speedFeedbackBps(bytesReceived: number): number {
	return Math.min(Math.floor((bytesReceived * 8 * 3) / 2), 0xffffffff);
}

// ── Handshake ─────────────────────────────────────────────────────────────────

/** What both sides agree on after the control handshake. */
export interface BtestNegotiated {
	command: BtestCommand;
	authKind: BtestAuthKind;
	username?: string;
	/** UDP only. */
	serverUdpPort?: number;
	clientUdpPort?: number;
	/** TCP multi-connection only. */
	sessionToken?: number;
}

export interface BtestClientHandshakeOptions extends BtestCommandOptions {
	username?: string;
	password?: string;
	/** UDP server port base, for computing the client port locally if needed. */
}

function authFailed(detail: string, cause?: unknown): CentrsError {
	return new CentrsError({
		code: "transport/auth-failed",
		summary: `btest authentication failed: ${detail}`,
		remediation:
			"Check --user/--password against the server's bandwidth-server credentials.",
		...(cause !== undefined ? { cause } : {}),
	});
}

/** Read a btest `[len][payload]` auth frame off the control channel. */
async function readAuthFrame(
	channel: BtestControlChannel,
): Promise<Uint8Array> {
	const lenByte = await channel.readExact(1);
	const len = lenByte[0] as number;
	return len === 0 ? new Uint8Array(0) : channel.readExact(len);
}

/** Drive the client side of the control handshake. */
export async function clientHandshake(
	channel: BtestControlChannel,
	options: BtestClientHandshakeOptions,
): Promise<BtestNegotiated> {
	await channel.readExact(4); // HELLO (not strictly validated, like btest-rs)
	const command = encodeCommand(options);
	await channel.write(command);

	const response = await channel.readExact(4);
	const kind = classifyAuthResponse(response);

	if (kind === "failed") {
		throw authFailed("the server rejected the connection");
	}
	if (kind === "md5") {
		throw authFailed(
			"the server requires legacy pre-6.43 MD5 auth, which centrs does not implement",
		);
	}
	if (kind === "unknown") {
		throw new CentrsError({
			code: "routeros/btest-protocol",
			summary: `Unexpected btest auth response 0x${(response[0] as number).toString(16)}.`,
			remediation: "Confirm the peer is a btest bandwidth server.",
		});
	}

	let username = options.username;
	if (kind === "ec-srp5") {
		if (!options.username || !options.password) {
			throw authFailed(
				"the server requires EC-SRP5 auth but no --user/--password were given",
			);
		}
		try {
			await runClientEcSrp5(channel, options.username, options.password);
			username = options.username;
			// After EC-SRP5 the server sends a final AUTH_OK.
			const post = await channel.readExact(4);
			if (classifyAuthResponse(post) !== "none") {
				throw authFailed("unexpected response after the EC-SRP5 exchange");
			}
		} catch (error) {
			// A mid-exchange close means the server rejected our proof and hung up —
			// surface that as an auth failure, not a raw protocol/stream error.
			if (
				error instanceof CentrsError &&
				error.code === "transport/auth-failed"
			) {
				throw error;
			}
			throw authFailed(
				"the server closed the connection during EC-SRP5 (likely bad credentials)",
				error,
			);
		}
	}

	const negotiated: BtestNegotiated = {
		command: decodeCommand(command),
		authKind: kind,
	};
	if (username !== undefined) negotiated.username = username;

	// TCP multi-connection: the OK carries a 2-byte session token.
	if (options.protocol === "tcp" && (options.tcpConnectionCount ?? 0) > 0) {
		const token =
			kind === "none"
				? ((response[1] as number) << 8) | (response[2] as number)
				: 0;
		if (token) negotiated.sessionToken = token;
	}

	if (options.protocol === "udp") {
		const portBytes = await channel.readExact(2);
		const serverUdpPort =
			((portBytes[0] as number) << 8) | (portBytes[1] as number);
		negotiated.serverUdpPort = serverUdpPort;
		negotiated.clientUdpPort = clientUdpPort(serverUdpPort);
	}
	return negotiated;
}

async function runClientEcSrp5(
	channel: BtestControlChannel,
	username: string,
	password: string,
): Promise<void> {
	const keypair = ecSrp5Keygen();
	await channel.write(encodeClientHello(username, keypair.publicKey));

	const challenge = parseServerChallenge(await readAuthFrame(channel));
	const validator = ecSrp5Id(username, password, challenge.salt);
	const shared = ecSrp5ClientShared(
		keypair.privateKey,
		challenge.serverPublicKey,
		keypair.publicKey,
		validator,
	);
	const clientCc = ecSrp5ClientConfirm(shared);
	await channel.write(encodeConfirmation(clientCc));

	const serverCc = await readAuthFrame(channel);
	const expected = ecSrp5ServerConfirm(shared, clientCc);
	if (!timingSafeEqualBytes(serverCc, expected)) {
		throw authFailed("the server confirmation did not verify");
	}
}

export interface BtestServerHandshakeOptions {
	/** Server-perspective command (already read elsewhere) is decoded here. */
	authenticate: boolean;
	username?: string;
	password?: string;
	/** Allocated server UDP data port (UDP tests only). */
	serverUdpPort?: number;
	/** OK response (carries a session token for TCP multi-connection). */
	sessionToken?: number;
}

/**
 * Drive the server side of the control handshake on an accepted connection.
 * Reads the 16-byte command, performs auth (none or EC-SRP5), sends the OK, and
 * (for UDP) writes the server UDP port. Throws `transport/auth-failed` on a bad
 * proof so the caller can log it and drop the connection.
 */
export async function serverHandshake(
	channel: BtestControlChannel,
	options: BtestServerHandshakeOptions,
): Promise<BtestNegotiated> {
	// Fail fast on a misconfigured listener: authenticate=true with no (or empty)
	// credential would otherwise accept an empty-username/empty-password proof,
	// which is a silent foot-gun for a network-exposed surface.
	if (options.authenticate && (!options.username || !options.password)) {
		throw new CentrsError({
			code: "validation/option",
			summary:
				"btest server authentication requires a non-empty username and password.",
			remediation:
				"Pass credentials, or run the server with authenticate=false.",
		});
	}
	await channel.write(BTEST_HELLO);
	const commandBytes = await channel.readExact(16);
	const command = decodeCommand(commandBytes);

	const okResponse = encodeAuthOk(options.sessionToken ?? 0);

	let username: string | undefined;
	let authKind: BtestAuthKind = "none";
	if (options.authenticate) {
		authKind = "ec-srp5";
		// Prompt for EC-SRP5 (03 00 00 00) before the framed exchange, then the OK.
		await channel.write(BTEST_AUTH_EC_SRP5);
		username = await runServerEcSrp5(
			channel,
			options.username ?? "",
			options.password ?? "",
		);
		await channel.write(okResponse);
	} else {
		await channel.write(okResponse);
	}

	const negotiated: BtestNegotiated = { command, authKind };
	if (username !== undefined) negotiated.username = username;
	if (options.sessionToken) negotiated.sessionToken = options.sessionToken;

	if (command.protocol === "udp") {
		const serverUdpPort = options.serverUdpPort ?? BTEST_UDP_PORT_START;
		await channel.write(
			Uint8Array.of((serverUdpPort >> 8) & 0xff, serverUdpPort & 0xff),
		);
		negotiated.serverUdpPort = serverUdpPort;
		negotiated.clientUdpPort = clientUdpPort(serverUdpPort);
	}
	return negotiated;
}

async function runServerEcSrp5(
	channel: BtestControlChannel,
	expectedUser: string,
	password: string,
): Promise<string> {
	const hello = parseClientHello(await readAuthFrame(channel));
	if (hello.username !== expectedUser) {
		throw authFailed(`unknown user "${hello.username}"`);
	}
	const salt = ecSrp5RandomSalt();
	const validatorScalar = bytesToBigIntBE(
		ecSrp5Id(expectedUser, password, salt),
	);
	const keypair = ecSrp5Keygen();
	const serverPublicKey = ecSrp5ServerPublicKey(
		keypair.privateKey,
		validatorScalar,
	);
	await channel.write(encodeServerChallenge(serverPublicKey, salt));

	const shared = ecSrp5ServerShared(
		keypair.privateKey,
		validatorScalar,
		hello.publicKey,
		serverPublicKey,
	);
	const clientCc = await readAuthFrame(channel);
	const expectedCc = ecSrp5ClientConfirm(shared);
	if (!timingSafeEqualBytes(clientCc, expectedCc)) {
		throw authFailed("the client proof did not verify");
	}
	await channel.write(
		encodeConfirmation(ecSrp5ServerConfirm(shared, clientCc)),
	);
	return hello.username;
}

function ecSrp5RandomSalt(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(16));
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1)
		diff |= (a[i] as number) ^ (b[i] as number);
	return diff === 0;
}

// ── Loop primitives ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}

/** `readExact(n)`, but resolve `null` if the session stops or the read fails. */
async function readExactOrStop(
	ctx: RunContext,
	n: number,
): Promise<Uint8Array | null> {
	return Promise.race([
		ctx.channel.readExact(n).then(
			(bytes) => bytes,
			() => null,
		),
		ctx.counters.stopped().then(() => null),
	]);
}

/** `read()`, but resolve `null` if the session stops or the read fails. */
async function readOrStop(ctx: RunContext): Promise<Uint8Array | null> {
	return Promise.race([
		ctx.channel.read().then(
			(bytes) => bytes,
			() => null,
		),
		ctx.counters.stopped().then(() => null),
	]);
}

/** Resolve when `ms` elapses or the next animation/IO tick (unlimited mode). */
function pace(ms: number | null): Promise<void> {
	if (ms === null) return new Promise((resolve) => setImmediate(resolve));
	return sleep(ms);
}

// ── Data engines ──────────────────────────────────────────────────────────────

interface RunContext {
	channel: BtestControlChannel;
	udp?: BtestUdpSocket;
	command: BtestCommand;
	counters: BandwidthCounters;
	/** Bytes per data packet/write. */
	txSize: number;
	/** Initial sender rate cap (bits/sec); 0 = unlimited. */
	txSpeed: number;
	randomData: boolean;
	statusIntervalMs: number;
	clientUdpPort?: number;
	serverUdpPort?: number;
	/** Peer host for UDP (client: server host; server: client host). */
	udpPeerHost?: string;
	/**
	 * Adapt this side's TX rate from peer status frames (client transmit / both).
	 * Set so the merged-stream status reader in `tcpRxLoop` and the dedicated
	 * `tcpStatusReaderLoop` share one feedback gate.
	 */
	adaptTxFromStatus?: boolean;
	onInterval?: (sample: BtestIntervalSample) => void;
}

/** A side's view of which directions it sends/receives. */
interface RoleDirections {
	shouldTx: boolean;
	shouldRx: boolean;
}

function clientDirections(command: BtestCommand): RoleDirections {
	// client_tx = dir & RX(1); client_rx = dir & TX(2)
	return {
		shouldTx: command.serverReceives,
		shouldRx: command.serverTransmits,
	};
}

function serverDirections(command: BtestCommand): RoleDirections {
	return {
		shouldTx: command.serverTransmits,
		shouldRx: command.serverReceives,
	};
}

/**
 * Open one secondary TCP data connection that joins an existing multi-connection
 * test. Grounded against RouterOS 7.23.1: the server sends the 4-byte HELLO, the
 * client replies with the 16-byte join `[token:u16 BE][0x02][0 …]`
 * ({@link encodeSecondaryJoin}), and bulk data then flows. The server sends **no**
 * acknowledgement before the data — it waits for *all* connections to join before
 * streaming — so the join must not block on a reply read, or the sequential opens
 * would deadlock (the server stalls waiting for the rest while the client stalls
 * waiting for a reply that never comes, and the server eventually drops the
 * connection). The caller drives the returned channel into the primary session's
 * shared counters so throughput aggregates across all streams.
 */
async function openSecondaryConnection(
	connect: (host: string, port: number) => Promise<BtestControlChannel>,
	host: string,
	port: number,
	token: number,
): Promise<BtestControlChannel> {
	const channel = await connect(host, port);
	try {
		await channel.readExact(4); // server HELLO (01 00 00 00)
		await channel.write(encodeSecondaryJoin(token));
		return channel;
	} catch (error) {
		channel.close();
		throw error;
	}
}

/**
 * Run the bulk TX/RX loops for a secondary data connection. No status or report
 * loops — the primary connection owns those; a secondary only moves bulk bytes
 * into the shared counters. TX paces from the shared `counters.txSpeed` the primary
 * adapts from server feedback.
 */
async function runSecondaryDataLoops(
	ctx: RunContext,
	dirs: RoleDirections,
): Promise<void> {
	const tasks: Promise<void>[] = [];
	if (dirs.shouldTx) tasks.push(tcpTxLoop(ctx, false));
	if (dirs.shouldRx) tasks.push(tcpRxLoop(ctx));
	await Promise.all(tasks);
}

/** Bulk TCP send loop: writes `txSize` zero/random payloads until stopped. */
async function tcpTxLoop(ctx: RunContext, sendStatus: boolean): Promise<void> {
	await sleep(100);
	const { counters } = ctx;
	const packet = ctx.randomData
		? crypto.getRandomValues(new Uint8Array(ctx.txSize))
		: new Uint8Array(ctx.txSize);
	let interval = calcSendIntervalMs(counters.txSpeed, ctx.txSize);
	let statusSeq = 0;
	let nextStatus = Date.now() + ctx.statusIntervalMs;

	while (counters.running) {
		if (sendStatus && Date.now() >= nextStatus) {
			statusSeq += 1;
			const rx = counters.swapRx();
			// `sendStatus` is the server's `both` TCP role: it transmits bulk here
			// *and* receives the client's transmit half. The wire status reports rx
			// (so the client adapts its send rate), but the interval accounting must
			// flush both halves — the bulk tx is in `txBytes` via addTx and would
			// otherwise never reach the session total (a `both` session then showed
			// totalTxBytes=0). A pure TX-only sender uses sendStatus=false and is
			// accounted by reportOnlyLoop, so there is no double-count here.
			const tx = counters.swapTx();
			try {
				await ctx.channel.write(encodeStatus(statusSeq, rx & 0xffffffff, 0));
			} catch {
				counters.stop();
				break;
			}
			counters.recordInterval(tx, rx, 0);
			emitInterval(ctx, statusSeq, tx, rx, 0);
			nextStatus = Date.now() + ctx.statusIntervalMs;
		}
		try {
			await ctx.channel.write(packet);
		} catch {
			counters.stop();
			break;
		}
		counters.addTx(ctx.txSize);
		if (counters.txSpeedChanged) {
			counters.txSpeedChanged = false;
			interval = calcSendIntervalMs(counters.txSpeed, ctx.txSize);
		}
		await pace(interval);
	}
}

/**
 * Apply a decoded peer status to the counters: record the peer CPU and, when this
 * side adapts (client transmit / both), retarget TX from the peer's `bytesReceived`
 * speed-feedback. Shared by the dedicated `tcpStatusReaderLoop` (pure status stream)
 * and the merged-stream demux in `tcpRxLoop`.
 */
function applyStatusFeedback(ctx: RunContext, status: BtestStatus): void {
	const { counters } = ctx;
	counters.remoteCpu = status.cpuLoad;
	if (ctx.adaptTxFromStatus && status.bytesReceived > 0) {
		counters.txSpeed = speedFeedbackBps(status.bytesReceived);
		counters.txSpeedChanged = true;
	}
}

/**
 * Demux the most recent 12-byte status frame embedded in a bulk TCP chunk and apply
 * it. In `direction=both` the peer interleaves status frames into the same bulk
 * stream with no length framing, so they are found structurally: a frame is
 * `[0x07][cpu][0x00][0x00][seq u32 LE][bytesReceived u32 LE]` — the two reserved
 * bytes are always zero, making `0x07 ?? 00 00` a reliable marker in the default
 * zero-filled payload, and it matches both client (CPU high-bit set) and RouterOS
 * server (high-bit clear) frames. A `--random-data` payload can yield a rare false
 * positive, and a frame split across a read boundary is missed, but TX speed is a
 * soft pacing target that self-corrects on the next interval's frame. Only the last
 * frame in the chunk is applied (the freshest feedback); the scan is in place, so it
 * adds no copy on the RX hot path. The frame bytes stay counted in `rx` (matching
 * RouterOS, which bills the overhead as stream bytes).
 */
/**
 * Sanity ceiling for an embedded-status sequence number. Status frames are emitted
 * once per `statusIntervalMs` (≥ 20 ms). We bound plausibility to a conservative
 * long-session window: 6 hours at the minimum 20 ms cadence yields
 * `(6 * 60 * 60 * 1000) / 20 = 1_080_000` frames, so any candidate sequence above
 * that is treated as random-noise fallout from a false marker match.
 */
const BTEST_STATUS_MIN_INTERVAL_MS = 20;
const BTEST_STATUS_MAX_RUN_HOURS = 6;
const BTEST_STATUS_SEQ_SANE_MAX = Math.ceil(
	(BTEST_STATUS_MAX_RUN_HOURS * 60 * 60 * 1000) / BTEST_STATUS_MIN_INTERVAL_MS,
);

/**
 * Validate a candidate embedded-status window before trusting it. The structural
 * marker `0x07 ?? 00 00` is only a 24-bit sentinel, so in a `--random-data` bulk
 * stream it false-matches roughly once per 16 MB (~once/second at 100 Mb/s) — and a
 * false frame would feed a garbage `bytesReceived` into `applyStatusFeedback`,
 * rewriting `counters.txSpeed`. Two cheap, payload-independent invariants reject
 * those: the CPU byte is a 0..100 percentage (decodeStatus *clamps* it, so check the
 * raw byte), and the status sequence is a small monotonic counter, never a random
 * 32-bit value (a bounded run can't reach `BTEST_STATUS_SEQ_SANE_MAX`). Together with
 * the marker this drops the false-apply rate to negligible while leaving real frames
 * untouched.
 */
function plausibleStatusFrame(frame: Uint8Array): boolean {
	if (((frame[1] as number) & 0x7f) > 100) return false;
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	return view.getUint32(4, true) <= BTEST_STATUS_SEQ_SANE_MAX;
}

export function applyEmbeddedStatus(ctx: RunContext, chunk: Uint8Array): void {
	if (chunk.length < BTEST_STATUS_MSG_SIZE) return;
	const limit = chunk.length - BTEST_STATUS_MSG_SIZE;
	let lastValid: BtestStatus | undefined;
	let i = 0;
	while (i <= limit) {
		const frame = chunk.subarray(i, i + BTEST_STATUS_MSG_SIZE);
		if (
			chunk[i] === BTEST_STATUS_MSG_TYPE &&
			chunk[i + 2] === 0 &&
			chunk[i + 3] === 0 &&
			plausibleStatusFrame(frame)
		) {
			// A real status frame's own seq/bytes fields can contain `0x07 ?? 00 00`
			// (e.g. seq 7), so consume the whole frame before scanning on — never
			// re-match a matched frame's payload as a second, garbage frame.
			lastValid = decodeStatus(frame);
			i += BTEST_STATUS_MSG_SIZE;
		} else {
			i += 1;
		}
	}
	if (lastValid) applyStatusFeedback(ctx, lastValid);
}

/** Bulk TCP receive loop: counts bytes and demuxes interleaved status frames. */
async function tcpRxLoop(ctx: RunContext): Promise<void> {
	const { counters } = ctx;
	while (counters.running) {
		const chunk = await readOrStop(ctx);
		if (chunk === null) {
			counters.stop();
			break;
		}
		counters.addRx(chunk.length);
		applyEmbeddedStatus(ctx, chunk);
	}
}

/** Read server→client status frames (client TX-only TCP) and adapt rate. */
async function tcpStatusReaderLoop(ctx: RunContext): Promise<void> {
	const { counters } = ctx;
	while (counters.running) {
		const frame = await readExactOrStop(ctx, BTEST_STATUS_MSG_SIZE);
		if (frame === null) break;
		if (frame[0] !== BTEST_STATUS_MSG_TYPE) continue;
		applyStatusFeedback(ctx, decodeStatus(frame));
	}
}

/** Send server→client status frames (server RX-only TCP). */
async function tcpStatusSenderLoop(ctx: RunContext): Promise<void> {
	const { counters } = ctx;
	let seq = 0;
	while (counters.running) {
		await sleep(ctx.statusIntervalMs);
		if (!counters.running) break;
		seq += 1;
		const rx = counters.swapRx();
		try {
			await ctx.channel.write(encodeStatus(seq, rx & 0xffffffff, 0));
		} catch {
			counters.stop();
			break;
		}
		counters.recordInterval(0, rx, 0);
		emitInterval(ctx, seq, 0, rx, 0);
	}
}

/** TX-side local status reporting that emits no wire frames (server/client TX). */
async function reportOnlyLoop(
	ctx: RunContext,
	dirs: RoleDirections,
): Promise<void> {
	const { counters } = ctx;
	let seq = 0;
	while (counters.running) {
		await sleep(ctx.statusIntervalMs);
		if (!counters.running) break;
		seq += 1;
		const tx = dirs.shouldTx ? counters.swapTx() : 0;
		const rx = dirs.shouldRx ? counters.swapRx() : 0;
		const lost = dirs.shouldRx ? counters.swapLost() : 0;
		counters.recordInterval(tx, rx, lost);
		emitInterval(ctx, seq, tx, rx, lost);
	}
}

/** UDP send loop: `[seq u32 BE][payload]` datagrams until stopped. */
async function udpTxLoop(
	ctx: RunContext,
	target?: { port: number; host: string },
): Promise<void> {
	const udp = ctx.udp as BtestUdpSocket;
	const { counters } = ctx;
	let seq = 0;
	let interval = calcSendIntervalMs(counters.txSpeed, ctx.txSize);
	// A bandwidth test emits a huge number of datagrams, so a fresh allocation per
	// packet is pure GC pressure. Rotate through a small ring of pre-allocated
	// buffers instead, writing only the 4-byte BE seq each send. node:dgram must
	// not see a buffer mutated while an earlier send is still queued, but pace()
	// yields the event loop every iteration (sleep, or setImmediate when
	// unlimited), so a slot's prior send has flushed long before we cycle back to
	// it. The first allocation also runs encodeUdpPacket's size guard (≥ 4 bytes).
	// Keep 8 slots so each buffer is only reused after multiple pace() yields;
	// this gives node:dgram ample time to flush queued sends before a slot cycles.
	const RING = 8;
	const ring = Array.from({ length: RING }, (_, i) => {
		const buf =
			i === 0
				? encodeUdpPacket(0, ctx.txSize, ctx.randomData)
				: new Uint8Array(ctx.txSize);
		if (i !== 0 && ctx.randomData) crypto.getRandomValues(buf);
		return {
			buf,
			view: new DataView(buf.buffer, buf.byteOffset, buf.byteLength),
		};
	});
	let slot = 0;
	while (counters.running) {
		const cell = ring[slot] as (typeof ring)[number];
		slot = (slot + 1) % RING;
		cell.view.setUint32(0, seq, false);
		try {
			if (target) udp.send(cell.buf, target.port, target.host);
			else udp.send(cell.buf);
		} catch {
			await sleep(1);
			continue;
		}
		seq = (seq + 1) >>> 0;
		counters.addTx(ctx.txSize);
		if (counters.txSpeedChanged) {
			counters.txSpeedChanged = false;
			interval = calcSendIntervalMs(counters.txSpeed, ctx.txSize);
		}
		await pace(interval);
	}
}

/**
 * UDP receive accounting. Datagrams arrive via {@link BtestUdpSocket.onMessage};
 * this loop just keeps the task alive until the test stops (the message handler
 * does the counting + loss accounting).
 */
async function udpRxLoop(ctx: RunContext): Promise<void> {
	const { counters } = ctx;
	(ctx.udp as BtestUdpSocket).onMessage((bytes) => {
		if (bytes.length < 4) return;
		counters.observeUdpSeq(readUdpSequence(bytes), bytes.length);
	});
	while (counters.running) await sleep(ctx.statusIntervalMs);
}

/**
 * UDP status exchange on the TCP control channel. Both sides run this: an
 * interval sender emits our status (bytes received this interval) and a
 * background reader consumes the peer's status, driving speed feedback. This
 * decoupled model is equivalent to btest-rs's pselect interleave without the
 * partial-frame hazard of racing a timeout against a framed read.
 */
async function udpStatusExchange(
	ctx: RunContext,
	dirs: RoleDirections,
): Promise<void> {
	const { counters } = ctx;

	const reader = (async () => {
		while (counters.running) {
			const frame = await readExactOrStop(ctx, BTEST_STATUS_MSG_SIZE);
			if (frame === null) {
				counters.stop();
				break;
			}
			if (frame[0] !== BTEST_STATUS_MSG_TYPE) continue;
			const status = decodeStatus(frame);
			counters.remoteCpu = status.cpuLoad;
			if (status.bytesReceived > 0 && dirs.shouldTx) {
				counters.txSpeed = speedFeedbackBps(status.bytesReceived);
				counters.txSpeedChanged = true;
			}
		}
	})();

	let seq = 0;
	while (counters.running) {
		await sleep(ctx.statusIntervalMs);
		if (!counters.running) break;
		seq += 1;
		const rx = counters.swapRx();
		const tx = counters.swapTx();
		const lost = counters.swapLost();
		const report = dirs.shouldTx && !dirs.shouldRx ? tx : rx;
		try {
			await ctx.channel.write(encodeStatus(seq, report & 0xffffffff, 0));
		} catch {
			counters.stop();
			break;
		}
		counters.recordInterval(tx, rx, lost);
		emitInterval(ctx, seq, tx, rx, lost);
	}
	await reader;
}

function emitInterval(
	ctx: RunContext,
	seq: number,
	txBytes: number,
	rxBytes: number,
	lostPackets: number,
): void {
	if (!ctx.onInterval) return;
	const secs = ctx.statusIntervalMs / 1000;
	ctx.onInterval({
		seq,
		txBytes,
		rxBytes,
		lostPackets,
		txBps: secs > 0 ? (txBytes * 8) / secs : 0,
		rxBps: secs > 0 ? (rxBytes * 8) / secs : 0,
		localCpu: 0,
		remoteCpu: ctx.counters.remoteCpu,
	});
}

// ── Session drivers ───────────────────────────────────────────────────────────

export interface BtestClientSessionOptions {
	host: string;
	controlPort?: number;
	protocol: BtestProtocol;
	direction: BtestDirection;
	username?: string;
	password?: string;
	localTxSpeed?: number;
	remoteTxSpeed?: number;
	/** UDP per-packet size; TCP uses its bulk default. */
	txSize?: number;
	/** Parallel TCP data connections (TCP only); encoded in command byte 3. */
	tcpConnectionCount?: number;
	randomData?: boolean;
	natMode?: boolean;
	durationMs?: number;
	statusIntervalMs?: number;
	signal?: AbortSignal;
	onInterval?: (sample: BtestIntervalSample) => void;
	/** Injection seams (tests). */
	connect?: (host: string, port: number) => Promise<BtestControlChannel>;
	createUdpSocket?: () => BtestUdpSocket;
}

export interface BtestRunSummary {
	protocol: BtestProtocol;
	direction: BtestDirection;
	authKind: BtestAuthKind;
	username?: string;
	totalTxBytes: number;
	totalRxBytes: number;
	totalLostPackets: number;
	intervals: number;
	durationMs: number;
	stopReason: BtestStopReason;
	serverUdpPort?: number;
	clientUdpPort?: number;
	/**
	 * TCP data connections actually driven (1 primary + joined secondaries). For a
	 * `connection-count > 1` request this is the realized fan-out; it stays 1 when
	 * the server negotiates no session token (e.g. authenticated sessions).
	 */
	activeConnections: number;
}

/** Run a full btest **client** session and return its aggregate summary. */
export async function runBtestClientSession(
	options: BtestClientSessionOptions,
): Promise<BtestRunSummary> {
	const start = Date.now();
	const controlPort = options.controlPort ?? BTEST_PORT;
	const connect = options.connect ?? connectBtestControl;
	const channel = await connect(options.host, controlPort);

	const txSize = options.txSize ?? defaultTxSize(options.protocol);
	const handshakeOptions: BtestClientHandshakeOptions = {
		protocol: options.protocol,
		direction: options.direction,
		...(options.randomData !== undefined
			? { randomData: options.randomData }
			: {}),
		...(options.txSize !== undefined ? { txSize: options.txSize } : {}),
		...(options.tcpConnectionCount !== undefined
			? { tcpConnectionCount: options.tcpConnectionCount }
			: {}),
		...(options.localTxSpeed !== undefined
			? { localTxSpeed: options.localTxSpeed }
			: {}),
		...(options.remoteTxSpeed !== undefined
			? { remoteTxSpeed: options.remoteTxSpeed }
			: {}),
		...(options.username !== undefined ? { username: options.username } : {}),
		...(options.password !== undefined ? { password: options.password } : {}),
	};

	let negotiated: BtestNegotiated;
	try {
		negotiated = await clientHandshake(channel, handshakeOptions);
	} catch (error) {
		channel.close();
		throw error;
	}

	const counters = new BandwidthCounters();
	counters.txSpeed = options.localTxSpeed ?? 0;
	const dirs = clientDirections(negotiated.command);

	// Reuse the IP node already resolved for the TCP control connection as the UDP
	// peer address. The client now addresses every datagram explicitly (no
	// connect()), so passing a hostname here would make node:dgram run a DNS
	// lookup per send on the UDP hot path; channel.remoteAddress is already an IP.
	const udpPeerHost = channel.remoteAddress ?? options.host;

	let udp: BtestUdpSocket | undefined;
	if (options.protocol === "udp") {
		udp = (options.createUdpSocket ?? createBtestUdpSocket)();
		try {
			await udp.bind(negotiated.clientUdpPort as number, "0.0.0.0");
			// Do NOT connect() the socket: connect() installs a kernel receive filter
			// that silently drops datagrams whose source port differs from the connected
			// peer. RouterOS may send UDP data from a different source port than the
			// negotiated serverUdpPort (separate TX socket), so the filter would discard
			// all incoming packets and leave rx at 0 bps throughout. Instead, keep the
			// socket unconnected (like the server side) and always address sends
			// explicitly via udpTxLoop's target argument.
			if (options.natMode || dirs.shouldRx) {
				// Originate a flow so the server's datagrams can return (NAT/SLIRP).
				udp.send(
					new Uint8Array(0),
					negotiated.serverUdpPort as number,
					udpPeerHost,
				);
			}
		} catch (error) {
			// bind()/send() can throw before the normal close path runs; release the
			// socket and the control channel so a UDP bootstrap failure leaks neither.
			udp.close();
			channel.close();
			throw error;
		}
	}

	const ctx: RunContext = {
		channel,
		...(udp ? { udp } : {}),
		command: negotiated.command,
		counters,
		txSize,
		txSpeed: options.localTxSpeed ?? 0,
		randomData: options.randomData ?? false,
		statusIntervalMs: options.statusIntervalMs ?? BTEST_STATUS_INTERVAL_MS,
		...(negotiated.clientUdpPort !== undefined
			? { clientUdpPort: negotiated.clientUdpPort }
			: {}),
		...(negotiated.serverUdpPort !== undefined
			? { serverUdpPort: negotiated.serverUdpPort }
			: {}),
		udpPeerHost,
		...(options.onInterval ? { onInterval: options.onInterval } : {}),
	};

	// TCP multi-connection fan-out: the server negotiated a session token, so open
	// the requested extra data connections and drive them into the **shared**
	// counters, concurrently with the primary, so throughput aggregates across all
	// streams (grounded against RouterOS 7.23.1). A secondary that fails to open
	// degrades to fewer streams rather than failing the test — the primary already
	// carries the session. They share `counters.running`, so the primary's
	// duration/abort stop unblocks them too.
	const secondaryChannels: BtestControlChannel[] = [];
	if (
		options.protocol === "tcp" &&
		negotiated.sessionToken !== undefined &&
		(options.tcpConnectionCount ?? 1) > 1
	) {
		// Dial secondaries at the **same peer** the primary control socket resolved
		// to, not a fresh `options.host` lookup: a hostname that load-balances across
		// addresses could otherwise land a secondary on a different RouterOS, where
		// the session token is unknown and the join fails.
		const secondaryHost = channel.remoteAddress ?? options.host;
		const extra = (options.tcpConnectionCount as number) - 1;
		for (let i = 0; i < extra; i += 1) {
			try {
				secondaryChannels.push(
					await openSecondaryConnection(
						connect,
						secondaryHost,
						controlPort,
						negotiated.sessionToken,
					),
				);
			} catch {
				break;
			}
		}
	}
	const secondaryLoops = secondaryChannels.map((secondaryChannel) =>
		runSecondaryDataLoops(
			{
				channel: secondaryChannel,
				command: negotiated.command,
				counters,
				txSize,
				txSpeed: options.localTxSpeed ?? 0,
				randomData: options.randomData ?? false,
				statusIntervalMs: options.statusIntervalMs ?? BTEST_STATUS_INTERVAL_MS,
			},
			dirs,
		),
	);

	// Close every socket even if a loop throws — a rejected Promise.all must not leak
	// the UDP socket or any open TCP channel.
	let stopReason: BtestStopReason;
	try {
		const [primaryStopReason] = await Promise.all([
			driveSession(ctx, dirs, "client", {
				...(options.durationMs !== undefined
					? { durationMs: options.durationMs }
					: {}),
				...(options.signal ? { signal: options.signal } : {}),
			}),
			...secondaryLoops,
		]);
		stopReason = primaryStopReason;
	} finally {
		udp?.close();
		channel.close();
		for (const secondaryChannel of secondaryChannels) secondaryChannel.close();
	}

	const sum = counters.summary();
	const summary: BtestRunSummary = {
		protocol: options.protocol,
		direction: options.direction,
		authKind: negotiated.authKind,
		totalTxBytes: sum.totalTx,
		totalRxBytes: sum.totalRx,
		totalLostPackets: sum.totalLost,
		intervals: sum.intervals,
		durationMs: Date.now() - start,
		stopReason,
		activeConnections: 1 + secondaryChannels.length,
	};
	if (negotiated.username !== undefined) summary.username = negotiated.username;
	if (negotiated.serverUdpPort !== undefined)
		summary.serverUdpPort = negotiated.serverUdpPort;
	if (negotiated.clientUdpPort !== undefined)
		summary.clientUdpPort = negotiated.clientUdpPort;
	return summary;
}

export interface BtestServerConnectionOptions {
	authenticate: boolean;
	username?: string;
	password?: string;
	/** Allocated server UDP data port (UDP tests). */
	serverUdpPort?: number;
	/** Bind host for the server's UDP data socket. Default `0.0.0.0`. */
	udpBindHost?: string;
	statusIntervalMs?: number;
	signal?: AbortSignal;
	durationMs?: number;
	onInterval?: (sample: BtestIntervalSample) => void;
	createUdpSocket?: () => BtestUdpSocket;
}

export interface BtestSessionResult {
	negotiated: BtestNegotiated;
	totalTxBytes: number;
	totalRxBytes: number;
	totalLostPackets: number;
	intervals: number;
	durationMs: number;
	stopReason: BtestStopReason;
}

/**
 * Handle one accepted btest **server** control connection: run the handshake,
 * then the data/status engine for the negotiated direction, returning the
 * session's aggregate. The listener/accept loop and multi-session map live in
 * the orchestrator.
 */
export async function handleBtestServerConnection(
	channel: BtestControlChannel,
	options: BtestServerConnectionOptions,
): Promise<BtestSessionResult> {
	const start = Date.now();
	// Closing the channel on abort unblocks **any** pending read — including the
	// handshake, which (unlike the data loops) does not poll a running flag. This
	// guarantees the session task settles when the server stops, so a peer whose
	// handshake diverges from ours surfaces as a fast error, not a hang.
	if (options.signal) {
		if (options.signal.aborted) channel.close();
		else
			options.signal.addEventListener("abort", () => channel.close(), {
				once: true,
			});
	}
	const handshakeOptions: BtestServerHandshakeOptions = {
		authenticate: options.authenticate,
		...(options.username !== undefined ? { username: options.username } : {}),
		...(options.password !== undefined ? { password: options.password } : {}),
		...(options.serverUdpPort !== undefined
			? { serverUdpPort: options.serverUdpPort }
			: {}),
	};
	const negotiated = await serverHandshake(channel, handshakeOptions);

	const counters = new BandwidthCounters();
	counters.txSpeed = negotiated.command.remoteTxSpeed;
	const dirs = serverDirections(negotiated.command);

	let udp: BtestUdpSocket | undefined;
	if (negotiated.command.protocol === "udp") {
		udp = (options.createUdpSocket ?? createBtestUdpSocket)();
		await udp.bind(
			negotiated.serverUdpPort as number,
			options.udpBindHost ?? "0.0.0.0",
		);
		// The server leaves its UDP socket **unconnected** and addresses the client
		// with `send_to`: a connected socket only accepts the connected peer, but a
		// client behind NAT (e.g. a QEMU SLIRP guest) appears from a rewritten
		// source port, so the server must receive from any source.
	}

	const ctx: RunContext = {
		channel,
		...(udp ? { udp } : {}),
		command: negotiated.command,
		counters,
		txSize:
			negotiated.command.protocol === "udp"
				? negotiated.command.txSize
				: defaultTxSize("tcp"),
		txSpeed: negotiated.command.remoteTxSpeed,
		randomData: negotiated.command.randomData,
		statusIntervalMs: options.statusIntervalMs ?? BTEST_STATUS_INTERVAL_MS,
		...(negotiated.clientUdpPort !== undefined
			? { clientUdpPort: negotiated.clientUdpPort }
			: {}),
		...(negotiated.serverUdpPort !== undefined
			? { serverUdpPort: negotiated.serverUdpPort }
			: {}),
		...(channel.remoteAddress ? { udpPeerHost: channel.remoteAddress } : {}),
		...(options.onInterval ? { onInterval: options.onInterval } : {}),
	};

	const stopReason = await driveSession(ctx, dirs, "server", {
		...(options.durationMs !== undefined
			? { durationMs: options.durationMs }
			: {}),
		...(options.signal ? { signal: options.signal } : {}),
	});

	udp?.close();

	const sum = counters.summary();
	return {
		negotiated,
		totalTxBytes: sum.totalTx,
		totalRxBytes: sum.totalRx,
		totalLostPackets: sum.totalLost,
		intervals: sum.intervals,
		durationMs: Date.now() - start,
		stopReason,
	};
}

/**
 * Spin up the right TX/RX/status tasks for the role + direction + protocol,
 * arm duration/abort, and await completion. Returns why the session stopped.
 */
async function driveSession(
	ctx: RunContext,
	dirs: RoleDirections,
	role: "client" | "server",
	bounds: { durationMs?: number; signal?: AbortSignal },
): Promise<BtestStopReason> {
	const { counters } = ctx;
	let stopReason: BtestStopReason = "peer-closed";

	let durationTimer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = (): void => {
		stopReason = "interrupted";
		counters.stop();
	};
	if (bounds.signal) {
		if (bounds.signal.aborted) onAbort();
		else bounds.signal.addEventListener("abort", onAbort, { once: true });
	}
	if (bounds.durationMs !== undefined) {
		durationTimer = setTimeout(() => {
			stopReason = "duration-elapsed";
			counters.stop();
		}, bounds.durationMs);
	}

	const tasks: Promise<void>[] = [];
	if (ctx.command.protocol === "udp") {
		// Both client and server address sends explicitly (no connected-socket
		// default): client → serverUdpPort, server → clientUdpPort. An unconnected
		// socket accepts datagrams from any source, avoiding the BSD receive filter
		// that connect() installs and that silently drops packets when RouterOS
		// sends from an unexpected source port.
		let target: { port: number; host: string } | undefined;
		if (ctx.udpPeerHost !== undefined) {
			if (role === "server" && ctx.clientUdpPort !== undefined) {
				target = { port: ctx.clientUdpPort, host: ctx.udpPeerHost };
			} else if (role === "client" && ctx.serverUdpPort !== undefined) {
				target = { port: ctx.serverUdpPort, host: ctx.udpPeerHost };
			}
		}
		if (dirs.shouldTx) tasks.push(udpTxLoop(ctx, target));
		if (dirs.shouldRx) tasks.push(udpRxLoop(ctx));
		tasks.push(udpStatusExchange(ctx, dirs));
	} else {
		// A transmitting client paces its TX from the server's status feedback. For
		// `transmit` that arrives on the dedicated status stream (tcpStatusReaderLoop);
		// for `both` it is interleaved into the bulk RX stream (tcpRxLoop's demux).
		// Either way this gate routes the feedback into counters.txSpeed.
		ctx.adaptTxFromStatus = role === "client" && dirs.shouldTx;
		if (dirs.shouldTx && dirs.shouldRx) {
			tasks.push(tcpTxLoop(ctx, role === "server"));
			tasks.push(tcpRxLoop(ctx));
			if (role === "client") tasks.push(reportOnlyLoop(ctx, dirs));
		} else if (dirs.shouldTx) {
			tasks.push(tcpTxLoop(ctx, false));
			if (role === "client") tasks.push(tcpStatusReaderLoop(ctx));
			tasks.push(reportOnlyLoop(ctx, dirs));
		} else if (dirs.shouldRx) {
			tasks.push(tcpRxLoop(ctx));
			if (role === "server") tasks.push(tcpStatusSenderLoop(ctx));
			else tasks.push(reportOnlyLoop(ctx, dirs));
		}
	}

	try {
		await Promise.all(tasks);
	} catch {
		stopReason = "transport-error";
	} finally {
		if (durationTimer) clearTimeout(durationTimer);
		bounds.signal?.removeEventListener("abort", onAbort);
		// Flush the final partial interval. The per-interval loops record totals on
		// a tick cadence (statusIntervalMs) and exit without capturing bytes that
		// arrived after the last tick — or before the first tick, when a slow/loaded
		// host delays it past a short run's end. Fold the remaining counter bytes
		// into the totals (per this role's directions) so a real transfer is never
		// reported as zero, and `data.reports[]` stays lossless against the totals.
		// Guarded so a tick-aligned run gains no phantom interval.
		const tx = dirs.shouldTx ? counters.swapTx() : 0;
		const rx = dirs.shouldRx ? counters.swapRx() : 0;
		const lost = dirs.shouldRx ? counters.swapLost() : 0;
		if (tx > 0 || rx > 0 || lost > 0) {
			counters.recordInterval(tx, rx, lost);
			emitInterval(ctx, counters.intervals, tx, rx, lost);
		}
	}
	return stopReason;
}

// Re-export commonly paired codec helpers for orchestrator convenience.
export {
	type BtestCommand,
	type BtestCommandOptions,
	encodeAuthFrame,
	serverDirectionByte,
};
