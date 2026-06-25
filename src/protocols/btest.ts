/**
 * MikroTik bandwidth-test (btest) wire codec — the pure, side-effect-free half
 * of the btest protocol. TCP control on port 2000; UDP data on dynamic ports.
 *
 * Grounded on `manawenuz/btest-rs` — the authoritative layouts here follow
 * `src/protocol.rs` (the working Rust implementation, MITM-verified against
 * RouterOS 7.x), which corrects a couple of ambiguities in the prose
 * `docs/protocol.md`. Pinned to captured/derived vectors in
 * `test/unit/btest.test.ts`. The session state machine, EC-SRP5 handshake (which
 * wraps `ec-srp5.ts`), and the TCP/UDP data engines build on these primitives;
 * the orchestrator + envelopes live in `src/btest.ts`.
 *
 * This codec is strict on purpose: the btest **server** is a network listener, so
 * decoders reject malformed input (bad enum bytes, wrong lengths) rather than
 * coercing it, and encoders reject out-of-range fields rather than silently
 * masking them into valid-looking wire bytes (the preflight validator is the
 * user-facing gate; this is the defense-in-depth backstop).
 *
 * EC-SRP5 auth uses btest framing `[len:1][payload]` — Winbox's `[len][0x06]
 * [payload]` minus the `0x06` handler byte, since the auth context is implicit
 * after the server's `03 00 00 00`.
 */

import { CentrsError } from "../errors.ts";

// ── Constants (protocol.rs) ──────────────────────────────────────────────────

/** TCP control port. */
export const BTEST_PORT = 2000;
/** First server UDP data port (server allocates `2001 + offset`). */
export const BTEST_UDP_PORT_START = 2001;
/** Client UDP data port offset (`server_port + 256`). */
export const BTEST_UDP_CLIENT_OFFSET = 256;

/** 4-byte control words exchanged on the TCP channel. */
export const BTEST_HELLO = Uint8Array.of(0x01, 0x00, 0x00, 0x00);
export const BTEST_AUTH_OK = Uint8Array.of(0x01, 0x00, 0x00, 0x00);
export const BTEST_AUTH_MD5 = Uint8Array.of(0x02, 0x00, 0x00, 0x00);
export const BTEST_AUTH_EC_SRP5 = Uint8Array.of(0x03, 0x00, 0x00, 0x00);
export const BTEST_AUTH_FAILED = Uint8Array.of(0x00, 0x00, 0x00, 0x00);

/** Status message marker + size (12 bytes, exchanged ~1/s over TCP). */
export const BTEST_STATUS_MSG_TYPE = 0x07;
export const BTEST_STATUS_MSG_SIZE = 12;

/** 16-byte command packet size. */
export const BTEST_COMMAND_SIZE = 16;
/** EC-SRP5 server challenge (MSG2) payload size: pubkey(33) + salt(16). */
export const BTEST_EC_SRP5_CHALLENGE_LEN = 49;
/** Default per-packet sizes. */
export const BTEST_DEFAULT_TCP_TX_SIZE = 32768;
export const BTEST_DEFAULT_UDP_TX_SIZE = 1500;

// ── Types ───────────────────────────────────────────────────────────────────

/** Transport the test runs over. */
export type BtestProtocol = "udp" | "tcp";
/** Direction from the **client's** perspective (matches RouterOS `direction`). */
export type BtestDirection = "transmit" | "receive" | "both";

/** Server-perspective direction byte (the wire encoding inverts the client). */
export const BTEST_DIR_RX = 0x01; // client transmit  → server receives
export const BTEST_DIR_TX = 0x02; // client receive   → server transmits
export const BTEST_DIR_BOTH = 0x03; // both directions

/** What the server should do — `01..` (no auth) / `02` MD5 / `03` EC-SRP5 / `00` failed. */
export type BtestAuthKind = "none" | "md5" | "ec-srp5" | "failed" | "unknown";

/** Inputs the client encodes into the 16-byte command packet. */
export interface BtestCommandOptions {
	protocol: BtestProtocol;
	/** Client-perspective direction; encoded as the inverted server-perspective byte. */
	direction: BtestDirection;
	/** `true` = incompressible random payload; `false` (default) = zero fill. */
	randomData?: boolean;
	/** Parallel TCP data connections (TCP only); 0..255. */
	tcpConnectionCount?: number;
	/** Per-packet size; defaults to the protocol default when omitted. 0..65535. */
	txSize?: number;
	/** Client buffer size hint (0 = default); 0..65535. */
	clientBufferSize?: number;
	/** Server→client speed cap, bits/sec (0 = unlimited); 0..2^32-1. */
	remoteTxSpeed?: number;
	/** Client→server speed cap, bits/sec (0 = unlimited); 0..2^32-1. */
	localTxSpeed?: number;
}

/** Decoded command, from the server's perspective. */
export interface BtestCommand {
	protocol: BtestProtocol;
	directionByte: number;
	/** Server transmits to the client (client `receive`/`both`). */
	serverTransmits: boolean;
	/** Server receives from the client (client `transmit`/`both`). */
	serverReceives: boolean;
	randomData: boolean;
	tcpConnectionCount: number;
	txSize: number;
	clientBufferSize: number;
	remoteTxSpeed: number;
	localTxSpeed: number;
}

/** Decoded 12-byte status message. */
export interface BtestStatus {
	seq: number;
	bytesReceived: number;
	/** CPU load percentage 0..100 (the high bit MikroTik sets is stripped). */
	cpuLoad: number;
}

// ── Field guards (no silent truncation) ──────────────────────────────────────

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

/** Reject a field that does not fit its wire width rather than masking it. */
function assertField(value: number, max: number, field: string): void {
	if (!Number.isInteger(value) || value < 0 || value > max) {
		throw new CentrsError({
			code: "validation/option",
			summary: `btest ${field} must be an integer in 0..${max} (got ${value}).`,
			remediation: "Pass a value within the btest wire field's range.",
		});
	}
}

// ── Direction mapping ────────────────────────────────────────────────────────

/** Client-perspective direction → server-perspective wire byte. */
export function serverDirectionByte(direction: BtestDirection): number {
	switch (direction) {
		case "transmit":
			return BTEST_DIR_RX;
		case "receive":
			return BTEST_DIR_TX;
		case "both":
			return BTEST_DIR_BOTH;
	}
}

/** Default per-packet TX size for a protocol. */
export function defaultTxSize(protocol: BtestProtocol): number {
	return protocol === "tcp"
		? BTEST_DEFAULT_TCP_TX_SIZE
		: BTEST_DEFAULT_UDP_TX_SIZE;
}

// ── Command packet (16 bytes) ────────────────────────────────────────────────

/** Encode the client's 16-byte command packet (sent after HELLO). */
export function encodeCommand(options: BtestCommandOptions): Uint8Array {
	const txSize = options.txSize ?? defaultTxSize(options.protocol);
	const tcpConn = options.tcpConnectionCount ?? 0;
	const bufSize = options.clientBufferSize ?? 0;
	const remote = options.remoteTxSpeed ?? 0;
	const local = options.localTxSpeed ?? 0;
	assertField(tcpConn, 0xff, "connection-count");
	assertField(txSize, U16_MAX, "tx-size");
	assertField(bufSize, U16_MAX, "client-buffer-size");
	assertField(remote, U32_MAX, "remote-tx-speed");
	assertField(local, U32_MAX, "local-tx-speed");

	const buf = new Uint8Array(BTEST_COMMAND_SIZE);
	const view = new DataView(buf.buffer);
	buf[0] = options.protocol === "tcp" ? 1 : 0;
	buf[1] = serverDirectionByte(options.direction);
	buf[2] = options.randomData ? 0x00 : 0x01; // 0x00=random, 0x01=zeros
	buf[3] = tcpConn;
	view.setUint16(4, txSize, true);
	view.setUint16(6, bufSize, true);
	view.setUint32(8, remote, true);
	view.setUint32(12, local, true);
	return buf;
}

/**
 * Decode a 16-byte command packet (server side). Rejects an invalid protocol
 * byte (>1) or direction byte (not 1/2/3), matching `protocol.rs` `recv_command`.
 */
export function decodeCommand(buf: Uint8Array): BtestCommand {
	if (buf.length < BTEST_COMMAND_SIZE) {
		throw new CentrsError({
			code: "routeros/btest-protocol",
			summary: `btest command must be ${BTEST_COMMAND_SIZE} bytes (got ${buf.length}).`,
			remediation:
				"The peer sent a malformed command; confirm it is a btest client.",
		});
	}
	const proto = buf[0] as number;
	const directionByte = buf[1] as number;
	if (proto > 1 || directionByte === 0 || directionByte > 3) {
		throw new CentrsError({
			code: "routeros/btest-protocol",
			summary: `btest command has an invalid protocol/direction byte (proto=${proto}, dir=${directionByte}).`,
			remediation:
				"The peer sent a malformed command; confirm it is a btest client.",
		});
	}
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	return {
		protocol: proto === 1 ? "tcp" : "udp",
		directionByte,
		serverTransmits: (directionByte & BTEST_DIR_TX) !== 0,
		serverReceives: (directionByte & BTEST_DIR_RX) !== 0,
		randomData: buf[2] === 0x00,
		tcpConnectionCount: buf[3] as number,
		txSize: view.getUint16(4, true),
		clientBufferSize: view.getUint16(6, true),
		remoteTxSpeed: view.getUint32(8, true),
		localTxSpeed: view.getUint32(12, true),
	};
}

// ── Auth response + TCP multi-connection session token ───────────────────────

/**
 * Classify the server's 4-byte response to the command packet. A `0x01` first
 * byte is OK regardless of the rest — for a TCP multi-connection test the server
 * answers `01 <tokenHi> <tokenLo> 00`, carrying the session token (see
 * {@link sessionTokenFromResponse}).
 */
export function classifyAuthResponse(buf: Uint8Array): BtestAuthKind {
	if (buf.length < 4) return "unknown";
	switch (buf[0]) {
		case 0x00:
			return "failed";
		case 0x01:
			return "none";
		case 0x02:
			return "md5";
		case 0x03:
			return "ec-srp5";
		default:
			return "unknown";
	}
}

/** Build an OK response. `sessionToken` (0..65535) rides bytes 1-2 for TCP multi-conn. */
export function encodeAuthOk(sessionToken = 0): Uint8Array {
	assertField(sessionToken, U16_MAX, "session-token");
	return Uint8Array.of(
		0x01,
		(sessionToken >> 8) & 0xff,
		sessionToken & 0xff,
		0x00,
	);
}

/** Read the TCP multi-connection session token from an OK response (bytes 1-2, big-endian). */
export function sessionTokenFromResponse(buf: Uint8Array): number {
	return (((buf[1] ?? 0) << 8) | (buf[2] ?? 0)) >>> 0;
}

/**
 * The 16-byte "command" a secondary TCP connection sends to join an existing
 * session — the token in bytes 0-1 (big-endian), a constant `0x02` join marker in
 * byte 2, the rest zero. The server answers `01 <tokenHi> <tokenLo> 00` and the
 * connection joins without auth. Grounded byte-for-byte against RouterOS 7.23.1
 * (`12 34 02 00 …`, direction-independent — see the btest-session.ts header).
 */
export function encodeSecondaryJoin(sessionToken: number): Uint8Array {
	assertField(sessionToken, U16_MAX, "session-token");
	const buf = new Uint8Array(BTEST_COMMAND_SIZE);
	buf[0] = (sessionToken >> 8) & 0xff;
	buf[1] = sessionToken & 0xff;
	buf[2] = 0x02;
	return buf;
}

/** Read the session token a secondary connection sent (bytes 0-1, big-endian). */
export function sessionTokenFromSecondary(buf: Uint8Array): number {
	return (((buf[0] ?? 0) << 8) | (buf[1] ?? 0)) >>> 0;
}

// ── EC-SRP5 auth framing: [len:1][payload] ───────────────────────────────────

/** Wrap an EC-SRP5 payload in btest's single-byte length frame. */
export function encodeAuthFrame(payload: Uint8Array): Uint8Array {
	if (payload.length > 0xff) {
		throw new CentrsError({
			code: "routeros/btest-protocol",
			summary: `btest auth payload too long (${payload.length} > 255).`,
			remediation: "Shorten the username; btest frames are single-byte-length.",
		});
	}
	const out = new Uint8Array(payload.length + 1);
	out[0] = payload.length;
	out.set(payload, 1);
	return out;
}

/** MSG1: `[username\0][publicKey:33]`. `publicKey` is the 33-byte EC-SRP5 encoding. */
export function encodeClientHello(
	username: string,
	publicKey: Uint8Array,
): Uint8Array {
	const name = new TextEncoder().encode(username);
	const payload = new Uint8Array(name.length + 1 + publicKey.length);
	payload.set(name, 0);
	payload[name.length] = 0x00;
	payload.set(publicKey, name.length + 1);
	return encodeAuthFrame(payload);
}

/** Parse a MSG1 payload (the exact bytes after the length prefix). */
export function parseClientHello(payload: Uint8Array): {
	username: string;
	publicKey: Uint8Array;
} {
	const nul = payload.indexOf(0x00);
	// Exact framing: username\0 + 33-byte key, no trailing bytes.
	if (nul < 0 || payload.length !== nul + 1 + 33) {
		throw new CentrsError({
			code: "routeros/btest-protocol",
			summary: "btest EC-SRP5 client hello is malformed.",
			remediation:
				"The peer sent a bad auth message; confirm it is a btest client.",
		});
	}
	return {
		username: new TextDecoder().decode(payload.subarray(0, nul)),
		publicKey: payload.subarray(nul + 1, nul + 1 + 33),
	};
}

/** MSG2: `[serverPublicKey:33][salt:16]`. */
export function encodeServerChallenge(
	serverPublicKey: Uint8Array,
	salt: Uint8Array,
): Uint8Array {
	const payload = new Uint8Array(serverPublicKey.length + salt.length);
	payload.set(serverPublicKey, 0);
	payload.set(salt, serverPublicKey.length);
	return encodeAuthFrame(payload);
}

/** Parse a MSG2 payload (exactly 49 bytes: pubkey 33 + salt 16). */
export function parseServerChallenge(payload: Uint8Array): {
	serverPublicKey: Uint8Array;
	salt: Uint8Array;
} {
	if (payload.length !== BTEST_EC_SRP5_CHALLENGE_LEN) {
		throw new CentrsError({
			code: "routeros/btest-protocol",
			summary: `btest EC-SRP5 server challenge must be ${BTEST_EC_SRP5_CHALLENGE_LEN} bytes (got ${payload.length}).`,
			remediation: "The peer sent a bad auth message; confirm the server.",
		});
	}
	return {
		serverPublicKey: payload.subarray(0, 33),
		salt: payload.subarray(33, 49),
	};
}

/** MSG3/MSG4: `[confirmation:32]`. */
export function encodeConfirmation(confirmation: Uint8Array): Uint8Array {
	return encodeAuthFrame(confirmation);
}

// ── Status message (12 bytes, protocol.rs StatusMessage) ─────────────────────

/**
 * Encode the 12-byte status message: `[0x07][0x80|cpu][0][0][seq u32 LE][bytes
 * u32 LE]`. MikroTik sets the high bit on the CPU byte; `seq` and the received
 * byte counter are both **little-endian**.
 */
export function encodeStatus(
	seq: number,
	bytesReceived: number,
	cpuLoad = 0,
): Uint8Array {
	assertField(seq, U32_MAX, "status seq");
	assertField(bytesReceived, U32_MAX, "status bytes-received");
	assertField(cpuLoad, 100, "cpu-load");
	const buf = new Uint8Array(BTEST_STATUS_MSG_SIZE);
	const view = new DataView(buf.buffer);
	buf[0] = BTEST_STATUS_MSG_TYPE;
	buf[1] = 0x80 | (cpuLoad & 0x7f); // MikroTik high-bit CPU encoding
	// bytes 2-3 stay zero
	view.setUint32(4, seq, true); // little-endian seq
	view.setUint32(8, bytesReceived, true); // little-endian byte counter
	return buf;
}

/** Decode a 12-byte status message (tolerates RouterOS's no-high-bit CPU byte). */
export function decodeStatus(buf: Uint8Array): BtestStatus {
	if (buf.length < BTEST_STATUS_MSG_SIZE) {
		throw new CentrsError({
			code: "routeros/btest-protocol",
			summary: `btest status must be ${BTEST_STATUS_MSG_SIZE} bytes (got ${buf.length}).`,
			remediation:
				"Ignore the stray datagram; this is not a btest status message.",
		});
	}
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	return {
		cpuLoad: Math.min((buf[1] as number) & 0x7f, 100),
		seq: view.getUint32(4, true),
		bytesReceived: view.getUint32(8, true),
	};
}

// ── UDP data packet: [seq:u32 BE][payload] ───────────────────────────────────

/** Build a UDP data packet of `totalSize` bytes (≥4) with the given sequence number. */
export function encodeUdpPacket(
	seq: number,
	totalSize: number,
	randomData = false,
): Uint8Array {
	assertField(seq, U32_MAX, "udp seq");
	if (!Number.isInteger(totalSize) || totalSize < 4) {
		throw new CentrsError({
			code: "validation/option",
			summary: `btest UDP packet size must be ≥ 4 (got ${totalSize}).`,
			remediation:
				"Use a tx-size of at least 4 bytes (RouterOS allows 28..64000).",
		});
	}
	const buf = randomData
		? crypto.getRandomValues(new Uint8Array(totalSize))
		: new Uint8Array(totalSize);
	new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(
		0,
		seq,
		false,
	);
	return buf;
}

/** Read the big-endian sequence number from a UDP data packet. */
export function readUdpSequence(buf: Uint8Array): number {
	if (buf.length < 4) {
		throw new CentrsError({
			code: "routeros/btest-protocol",
			summary: "btest UDP packet shorter than its 4-byte sequence header.",
			remediation: "Drop the malformed datagram.",
		});
	}
	return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(
		0,
		false,
	);
}

/** Client UDP data port for a given server-assigned port. */
export function clientUdpPort(serverUdpPort: number): number {
	return serverUdpPort + BTEST_UDP_CLIENT_OFFSET;
}
