/**
 * btest session layer — handshake state machine + TCP/UDP data engines.
 *
 * Two tiers, both router-free:
 *   1. Deterministic unit checks of the pure helpers (timing, loss accounting)
 *      and the control handshake (none + EC-SRP5 both roles, success + reject)
 *      over a real loopback socket pair — no timers, so they are fast and stable.
 *   2. Full client↔server loopback runs of the data engines on `127.0.0.1` with
 *      short durations, asserting that bytes flow in the negotiated direction and
 *      the summaries aggregate. Exact throughput is not asserted (that is the
 *      CHR integration test's job); these pin structure + interoperation.
 *
 * Sequencing is grounded on `manawenuz/btest-rs` (see `btest-session.ts`).
 */

import { describe, expect, test } from "bun:test";
import { type AddressInfo, connect, createServer } from "node:net";
import {
	applyEmbeddedStatus,
	BandwidthCounters,
	type BtestControlChannel,
	type BtestRunSummary,
	type BtestSessionResult,
	calcSendIntervalMs,
	channelFromSocket,
	clientHandshake,
	handleBtestServerConnection,
	runBtestClientSession,
	serverHandshake,
	speedFeedbackBps,
} from "../../src/protocols/btest-session.ts";
import { udpLoopbackSupported } from "./udp-loopback.ts";

// The UDP data-engine runs use btest's plain UDP loopback path (no
// SO_REUSEPORT). Skip only when that plain UDP bind is unavailable; TCP runs and
// TCP-only handshakes remain covered. (issue #69)
const UDP_LOOPBACK = await udpLoopbackSupported();

/**
 * EC-SRP5 runs ~6–8 sequential Curve25519 scalar multiplications across both
 * roles in the pure-BigInt core, so a full handshake takes a few seconds. These
 * tests get a generous timeout rather than masking the (expected, CHR-validated)
 * crypto cost.
 */
const EC_SRP5_TIMEOUT_MS = 30000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A connected loopback channel pair (server-accepted side + client side). */
function connectedPair(): Promise<{
	server: BtestControlChannel;
	client: BtestControlChannel;
	close: () => void;
}> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as AddressInfo).port;
			const clientSocket = connect({ host: "127.0.0.1", port });
			let serverChannel: BtestControlChannel | undefined;
			let clientChannel: BtestControlChannel | undefined;
			srv.once("connection", (socket) => {
				serverChannel = channelFromSocket(socket);
				if (clientChannel) finish();
			});
			clientSocket.once("connect", () => {
				clientChannel = channelFromSocket(clientSocket);
				if (serverChannel) finish();
			});
			clientSocket.once("error", reject);
			function finish(): void {
				resolve({
					server: serverChannel as BtestControlChannel,
					client: clientChannel as BtestControlChannel,
					close: () => {
						serverChannel?.close();
						clientChannel?.close();
						srv.close();
					},
				});
			}
		});
	});
}

interface LoopbackResult {
	client: BtestRunSummary;
	server: BtestSessionResult;
}

/** Run a full client session against a one-shot centrs server on loopback. */
async function runLoopback(opts: {
	server: Parameters<typeof handleBtestServerConnection>[1];
	client: Omit<
		Parameters<typeof runBtestClientSession>[0],
		"host" | "controlPort"
	>;
}): Promise<LoopbackResult> {
	const srv = createServer();
	await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
	const port = (srv.address() as AddressInfo).port;

	const serverDone = new Promise<BtestSessionResult>((resolve, reject) => {
		srv.once("connection", (socket) => {
			handleBtestServerConnection(channelFromSocket(socket), opts.server).then(
				resolve,
				reject,
			);
		});
	});

	const client = await runBtestClientSession({
		host: "127.0.0.1",
		controlPort: port,
		...opts.client,
	});
	const server = await serverDone;
	srv.close();
	return { client, server };
}

/** A high, unlikely-to-collide UDP base port for a loopback test. */
function randomUdpBase(): number {
	return 30000 + Math.floor(Math.random() * 20000);
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe("btest timing + accounting", () => {
	test("calcSendIntervalMs matches bandwidth.rs", () => {
		// 100 Mbps, 1500-byte packets → (1e3 * 1500*8) / 1e8 = 0.12 ms
		expect(calcSendIntervalMs(100_000_000, 1500)).toBeCloseTo(0.12, 5);
		// Unlimited
		expect(calcSendIntervalMs(0, 1500)).toBeNull();
		// A very slow rate clamps to 1 s (matches the >500ms→1s rule)
		expect(calcSendIntervalMs(1000, 1500)).toBe(1000);
	});

	test("speedFeedbackBps is bytes*8*1.5, clamped to u32", () => {
		expect(speedFeedbackBps(125_000)).toBe(1_500_000);
		expect(speedFeedbackBps(0)).toBe(0);
		expect(speedFeedbackBps(0xffffffff)).toBe(0xffffffff);
	});

	// #85: in TCP `direction=both` the server interleaves 12-byte status frames into
	// the bulk RX stream; the client must demux them and pace its TX, or its TX
	// saturates the link and starves server→client RX. `applyEmbeddedStatus` is that
	// demux. A frame is `[0x07][cpu][0x00][0x00][seq LE][bytesReceived LE]`.
	const embeddedStatusFrame = (
		cpu: number,
		seq: number,
		bytesReceived: number,
		highBit: boolean,
	): Uint8Array => {
		const f = new Uint8Array(12);
		f[0] = 0x07;
		f[1] = (highBit ? 0x80 : 0x00) | (cpu & 0x7f);
		new DataView(f.buffer).setUint32(4, seq, true);
		new DataView(f.buffer).setUint32(8, bytesReceived, true);
		return f;
	};
	const bulkWithStatus = (
		preZeros: number,
		frame: Uint8Array,
		postZeros: number,
	): Uint8Array => {
		const buf = new Uint8Array(preZeros + frame.length + postZeros);
		buf.set(frame, preZeros);
		return buf;
	};
	type StatusCtx = Parameters<typeof applyEmbeddedStatus>[0];

	test("applyEmbeddedStatus adapts client TX from a server status frame (#85)", () => {
		const counters = new BandwidthCounters();
		const ctx = { counters, adaptTxFromStatus: true } as unknown as StatusCtx;
		// RouterOS server frame: CPU high bit CLEAR (0x07 1e 00 00 …) embedded in zeros.
		const frame = embeddedStatusFrame(30, 7, 125_000, false);
		applyEmbeddedStatus(ctx, bulkWithStatus(1500, frame, 1500));
		expect(counters.remoteCpu).toBe(30);
		expect(counters.txSpeed).toBe(speedFeedbackBps(125_000));
		expect(counters.txSpeedChanged).toBe(true);
	});

	test("applyEmbeddedStatus records CPU but does not pace when not adapting (#85)", () => {
		const counters = new BandwidthCounters();
		const ctx = { counters, adaptTxFromStatus: false } as unknown as StatusCtx;
		applyEmbeddedStatus(
			ctx,
			bulkWithStatus(0, embeddedStatusFrame(42, 1, 999_999, true), 64),
		);
		expect(counters.remoteCpu).toBe(42);
		expect(counters.txSpeed).toBe(0); // server / receive-only never paces from feedback
		expect(counters.txSpeedChanged).toBe(false);
	});

	test("applyEmbeddedStatus applies the freshest (last) frame in a chunk (#85)", () => {
		const counters = new BandwidthCounters();
		const ctx = { counters, adaptTxFromStatus: true } as unknown as StatusCtx;
		const a = embeddedStatusFrame(10, 1, 50_000, false);
		const b = embeddedStatusFrame(20, 2, 200_000, false);
		const buf = new Uint8Array(8 + a.length + 16 + b.length + 8);
		buf.set(a, 8);
		buf.set(b, 8 + a.length + 16);
		applyEmbeddedStatus(ctx, buf);
		expect(counters.remoteCpu).toBe(20); // the later frame wins
		expect(counters.txSpeed).toBe(speedFeedbackBps(200_000));
	});

	test("applyEmbeddedStatus rejects implausible windows (--random-data guard, #98)", () => {
		// A random `0x07 ?? 00 00` window in --random-data bulk must not rewrite
		// txSpeed. Reject on an impossible CPU (>100) or a non-monotonic random seq.
		const counters = new BandwidthCounters();
		const ctx = { counters, adaptTxFromStatus: true } as unknown as StatusCtx;

		// CPU byte 0x7e = 126 (> 100) → rejected, even though the marker matches.
		const badCpu = Uint8Array.of(0x07, 0x7e, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0);
		applyEmbeddedStatus(ctx, bulkWithStatus(64, badCpu, 64));
		expect(counters.txSpeed).toBe(0);
		expect(counters.txSpeedChanged).toBe(false);

		// A random-looking 32-bit seq (0x40302010) → rejected.
		const bigSeq = embeddedStatusFrame(20, 0x40302010, 999_999, false);
		applyEmbeddedStatus(ctx, bulkWithStatus(64, bigSeq, 64));
		expect(counters.txSpeed).toBe(0);

		// A real frame interleaved *after* a false match still wins.
		const falseMatch = embeddedStatusFrame(20, 0x12345678, 123_456, false);
		const real = embeddedStatusFrame(15, 5, 250_000, false);
		const buf = new Uint8Array(falseMatch.length + 32 + real.length);
		buf.set(falseMatch, 0);
		buf.set(real, falseMatch.length + 32);
		applyEmbeddedStatus(ctx, buf);
		expect(counters.txSpeed).toBe(speedFeedbackBps(250_000));
		expect(counters.remoteCpu).toBe(15);
	});

	test("BandwidthCounters tracks UDP sequence-gap loss", () => {
		const c = new BandwidthCounters();
		c.observeUdpSeq(0, 100);
		c.observeUdpSeq(1, 100);
		c.observeUdpSeq(4, 100); // gap: expected 2, got 4 → 2 lost
		expect(c.rxPackets).toBe(3);
		expect(c.rxBytes).toBe(300);
		expect(c.rxLost).toBe(2);
		expect(c.swapLost()).toBe(2);
		expect(c.swapLost()).toBe(0); // reset after swap
	});

	test("stopped() resolves once stop() is called", async () => {
		const c = new BandwidthCounters();
		let resolved = false;
		const p = c.stopped().then(() => {
			resolved = true;
		});
		expect(resolved).toBe(false);
		c.stop();
		await p;
		expect(resolved).toBe(true);
		// After stop, stopped() resolves immediately.
		await c.stopped();
	});
});

// ── Handshake (deterministic, loopback socket pair) ───────────────────────────

describe("btest handshake — no auth", () => {
	test("TCP transmit negotiates with authKind none", async () => {
		const pair = await connectedPair();
		const serverP = serverHandshake(pair.server, {
			authenticate: false,
		}).catch((e) => e);
		const clientP = clientHandshake(pair.client, {
			protocol: "tcp",
			direction: "transmit",
		}).catch((e) => e);

		const serverRes = await serverP;
		const clientRes = await clientP;
		pair.close();

		expect(serverRes.authKind).toBe("none");
		expect(serverRes.command.protocol).toBe("tcp");
		expect(serverRes.command.serverReceives).toBe(true); // client transmit
		expect(clientRes.authKind).toBe("none");
	});

	test("UDP negotiates the +256 client port", async () => {
		const pair = await connectedPair();
		const base = randomUdpBase();
		const serverP = serverHandshake(pair.server, {
			authenticate: false,
			serverUdpPort: base,
		}).catch((e) => e);
		const clientP = clientHandshake(pair.client, {
			protocol: "udp",
			direction: "receive",
		}).catch((e) => e);

		const serverRes = await serverP;
		const clientRes = await clientP;
		pair.close();

		expect(clientRes.serverUdpPort).toBe(base);
		expect(clientRes.clientUdpPort).toBe(base + 256);
		expect(serverRes.clientUdpPort).toBe(base + 256);
	});
});

describe("btest handshake — EC-SRP5", () => {
	test(
		"matching credentials authenticate both roles",
		async () => {
			const pair = await connectedPair();
			const serverP = serverHandshake(pair.server, {
				authenticate: true,
				username: "tester",
				password: "swordfish",
			}).catch((e) => e);
			const clientP = clientHandshake(pair.client, {
				protocol: "tcp",
				direction: "receive",
				username: "tester",
				password: "swordfish",
			}).catch((e) => e);

			const serverRes = await serverP;
			const clientRes = await clientP;
			pair.close();

			expect(serverRes.authKind).toBe("ec-srp5");
			expect(serverRes.username).toBe("tester");
			expect(clientRes.authKind).toBe("ec-srp5");
			expect(clientRes.username).toBe("tester");
		},
		EC_SRP5_TIMEOUT_MS,
	);

	test(
		"a wrong password is rejected by the server verifier",
		async () => {
			const pair = await connectedPair();
			const serverP = serverHandshake(pair.server, {
				authenticate: true,
				username: "tester",
				password: "swordfish",
			}).catch((e) => e);
			const clientP = clientHandshake(pair.client, {
				protocol: "tcp",
				direction: "receive",
				username: "tester",
				password: "wrong",
			}).catch((e) => e);

			const serverRes = await serverP;
			pair.server.close();
			pair.client.close();
			const clientRes = await clientP;
			pair.close();

			expect(serverRes).toBeInstanceOf(Error);
			expect(serverRes.code).toBe("transport/auth-failed");
			expect(clientRes).toBeInstanceOf(Error); // client cannot complete either
		},
		EC_SRP5_TIMEOUT_MS,
	);

	test(
		"an unknown username is rejected",
		async () => {
			const pair = await connectedPair();
			const serverP = serverHandshake(pair.server, {
				authenticate: true,
				username: "tester",
				password: "swordfish",
			}).catch((e) => e);
			const clientP = clientHandshake(pair.client, {
				protocol: "tcp",
				direction: "receive",
				username: "someone-else",
				password: "swordfish",
			}).catch((e) => e);

			const serverRes = await serverP;
			pair.server.close();
			pair.client.close();
			await clientP;
			pair.close();

			expect(serverRes).toBeInstanceOf(Error);
			expect(serverRes.code).toBe("transport/auth-failed");
		},
		EC_SRP5_TIMEOUT_MS,
	);

	test(
		"client refuses an EC-SRP5 server without credentials",
		async () => {
			const pair = await connectedPair();
			const serverP = serverHandshake(pair.server, {
				authenticate: true,
				username: "tester",
				password: "swordfish",
			}).catch((e) => e);
			const clientP = clientHandshake(pair.client, {
				protocol: "tcp",
				direction: "receive",
			}).catch((e) => e);

			const clientRes = await clientP;
			pair.close();
			await serverP;

			expect(clientRes).toBeInstanceOf(Error);
			expect(clientRes.code).toBe("transport/auth-failed");
		},
		EC_SRP5_TIMEOUT_MS,
	);
});

// ── Full data-engine loopback ─────────────────────────────────────────────────

describe("btest loopback data engine", () => {
	const short = { durationMs: 300, statusIntervalMs: 40 };

	test("TCP receive: client downloads, server uploads", async () => {
		const { client, server } = await runLoopback({
			server: { authenticate: false, statusIntervalMs: 40, durationMs: 3000 },
			client: { protocol: "tcp", direction: "receive", ...short },
		});
		expect(client.stopReason).toBe("duration-elapsed");
		expect(client.totalRxBytes).toBeGreaterThan(0);
		expect(server.totalTxBytes).toBeGreaterThan(0);
		expect(client.intervals).toBeGreaterThanOrEqual(1);
	});

	test("TCP transmit: client uploads, server receives + sends status", async () => {
		const { client, server } = await runLoopback({
			server: { authenticate: false, statusIntervalMs: 40, durationMs: 3000 },
			client: { protocol: "tcp", direction: "transmit", ...short },
		});
		expect(client.totalTxBytes).toBeGreaterThan(0);
		expect(server.totalRxBytes).toBeGreaterThan(0);
	});

	test("TCP both: both sides account tx and rx (no dropped server tx)", async () => {
		const { client, server } = await runLoopback({
			server: { authenticate: false, statusIntervalMs: 40, durationMs: 3000 },
			client: { protocol: "tcp", direction: "both", ...short },
		});
		// The client drives bytes in both directions and accounts both halves.
		expect(client.totalTxBytes).toBeGreaterThan(0);
		expect(client.totalRxBytes).toBeGreaterThan(0);
		// The server receives the client's transmit half...
		expect(server.totalRxBytes).toBeGreaterThan(0);
		// ...and transmits the client's receive half — that tx must be recorded in
		// the session total, not dropped. (Regression: the server's bulk-TX loop
		// swapped rx into the interval but never its own tx, so a `both` TCP session
		// reported totalTxBytes=0 / txAvgBps=0 despite sending hundreds of MB.)
		expect(server.totalTxBytes).toBeGreaterThan(0);
	});

	test.skipIf(!UDP_LOOPBACK)(
		"UDP both: data flows in both directions with loss accounting",
		async () => {
			const base = randomUdpBase();
			const { client, server } = await runLoopback({
				server: {
					authenticate: false,
					statusIntervalMs: 40,
					durationMs: 3000,
					serverUdpPort: base,
					udpBindHost: "127.0.0.1",
				},
				client: {
					protocol: "udp",
					direction: "both",
					txSize: 1000,
					...short,
				},
			});
			expect(client.totalTxBytes).toBeGreaterThan(0);
			expect(client.totalRxBytes).toBeGreaterThan(0);
			expect(server.totalRxBytes).toBeGreaterThan(0);
			expect(client.totalLostPackets).toBeGreaterThanOrEqual(0);
			expect(client.serverUdpPort).toBe(base);
		},
	);

	test.skipIf(!UDP_LOOPBACK)(
		"EC-SRP5 client↔server over UDP receive",
		async () => {
			const base = randomUdpBase();
			const { client, server } = await runLoopback({
				server: {
					authenticate: true,
					username: "u",
					password: "p",
					statusIntervalMs: 40,
					durationMs: 3000,
					serverUdpPort: base,
					udpBindHost: "127.0.0.1",
				},
				client: {
					protocol: "udp",
					direction: "receive",
					username: "u",
					password: "p",
					...short,
				},
			});
			expect(client.authKind).toBe("ec-srp5");
			expect(server.negotiated.authKind).toBe("ec-srp5");
			expect(client.totalRxBytes).toBeGreaterThan(0);
			expect(server.totalTxBytes).toBeGreaterThan(0);
		},
		EC_SRP5_TIMEOUT_MS,
	);

	test("connection-refused when nothing is listening", async () => {
		// Bind+close to grab a definitely-free port, then dial it.
		const srv = createServer();
		await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
		const port = (srv.address() as AddressInfo).port;
		await new Promise<void>((r) => srv.close(() => r()));

		const err = await runBtestClientSession({
			host: "127.0.0.1",
			controlPort: port,
			protocol: "tcp",
			direction: "receive",
			durationMs: 200,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe("transport/connection-refused");
	});
});

describe("btest TCP multi-connection fan-out (client, #87)", () => {
	const hex = (b: Uint8Array): string =>
		[...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

	/**
	 * A minimal multi-connection btest server: HELLO on every connection, a session
	 * token in the primary's OK, and it accepts secondaries that present the token.
	 * It counts bulk bytes received per connection so a `direction=transmit` fan-out
	 * can be asserted (the client drives data on every connection). Models exactly the
	 * RouterOS behavior grounded in the btest-session.ts header.
	 */
	function multiConnServer(token: number): {
		port: Promise<number>;
		connections: () => { joins: string[]; bytesByConn: number[] };
		close: () => void;
	} {
		const joins: string[] = [];
		const bytesByConn: number[] = [];
		let seq = 0;
		const okWithToken = Uint8Array.of(
			0x01,
			(token >> 8) & 0xff,
			token & 0xff,
			0x00,
		);
		const srv = createServer((socket) => {
			const index = seq++;
			bytesByConn[index] = 0;
			socket.write(Uint8Array.of(0x01, 0x00, 0x00, 0x00)); // HELLO
			let handshakeDone = false;
			let buf = Buffer.alloc(0);
			socket.on("data", (chunk: Buffer) => {
				if (!handshakeDone) {
					buf = Buffer.concat([buf, chunk]);
					if (buf.length >= 16) {
						handshakeDone = true;
						const first16 = buf.subarray(0, 16);
						if (index > 0) {
							// Secondary join: like RouterOS, send no pre-data ack — the
							// client must not block waiting for one.
							joins.push(hex(first16));
						} else {
							socket.write(okWithToken); // primary OK carries the token
						}
						const rest = buf.subarray(16);
						bytesByConn[index] = (bytesByConn[index] ?? 0) + rest.length;
					}
					return;
				}
				bytesByConn[index] = (bytesByConn[index] ?? 0) + chunk.length;
			});
			socket.on("error", () => {});
		});
		const port = new Promise<number>((resolve) =>
			srv.listen(0, "127.0.0.1", () =>
				resolve((srv.address() as AddressInfo).port),
			),
		);
		return {
			port,
			connections: () => ({ joins, bytesByConn }),
			close: () => srv.close(),
		};
	}

	test("opens connection-count data connections and drives data on all", async () => {
		const TOKEN = 0x0100;
		const server = multiConnServer(TOKEN);
		const port = await server.port;
		try {
			const summary = await runBtestClientSession({
				host: "127.0.0.1",
				controlPort: port,
				protocol: "tcp",
				direction: "transmit",
				tcpConnectionCount: 3,
				durationMs: 300,
				statusIntervalMs: 40,
			});
			// The realized fan-out is 1 primary + 2 secondaries.
			expect(summary.activeConnections).toBe(3);
			const { joins, bytesByConn } = server.connections();
			// Two secondaries, each presenting the grounded join `[token BE][0x02][0]`.
			expect(joins.length).toBe(2);
			for (const join of joins) {
				expect(join).toBe("01 00 02 00 00 00 00 00 00 00 00 00 00 00 00 00");
			}
			// Every connection (primary + both secondaries) carried bulk client→server.
			expect(bytesByConn.length).toBe(3);
			for (const bytes of bytesByConn) expect(bytes).toBeGreaterThan(0);
			expect(summary.totalTxBytes).toBeGreaterThan(0);
		} finally {
			server.close();
		}
	});

	test("a single connection request opens no secondaries", async () => {
		const server = multiConnServer(0x0100);
		const port = await server.port;
		try {
			const summary = await runBtestClientSession({
				host: "127.0.0.1",
				controlPort: port,
				protocol: "tcp",
				direction: "transmit",
				tcpConnectionCount: 1,
				durationMs: 200,
				statusIntervalMs: 40,
			});
			expect(summary.activeConnections).toBe(1);
			expect(server.connections().joins.length).toBe(0);
		} finally {
			server.close();
		}
	});
});
