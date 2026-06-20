/**
 * `centrs btest` orchestrator — option-grammar validation (the product claim,
 * examples 9–10) and the client↔server loopback (examples 6–8) driven through
 * the public `btestClient`/`btestServer` API on `127.0.0.1`.
 *
 * Validation rejects never open a socket; the loopback runs assert structure +
 * interoperation + the CSV/JSON/text renderings (exact throughput is the CHR
 * integration test's job). EC-SRP5 runs are slow (pure BigInt) and get a
 * generous timeout.
 */

import { describe, expect, test } from "bun:test";
import {
	BTEST_CLIENT_CSV_HEADER,
	type BtestServerEnvelope,
	type BtestServerRequest,
	btestClient,
	btestServer,
	renderBtestClientEnvelope,
} from "../../src/btest.ts";

const EC_SRP5_TIMEOUT_MS = 30000;

/** Start a loopback server on an ephemeral port; returns the port + a stopper. */
async function startServer(
	options: Omit<BtestServerRequest, "bind" | "port" | "onBound" | "signal">,
): Promise<{ port: number; stop: () => Promise<BtestServerEnvelope> }> {
	const abort = new AbortController();
	let resolvePort: (port: number) => void = () => {};
	const portReady = new Promise<number>((resolve) => {
		resolvePort = resolve;
	});
	const promise = btestServer({
		bind: "127.0.0.1",
		port: 0,
		signal: abort.signal,
		onBound: (port) => resolvePort(port),
		...options,
	});
	const port = await portReady;
	return {
		port,
		stop: async () => {
			abort.abort();
			return promise;
		},
	};
}

describe("btest option-grammar validation (no socket opened)", () => {
	test("connection-count with UDP is rejected", async () => {
		const env = await btestClient({
			host: "192.0.2.10",
			protocol: "udp",
			connectionCount: 4,
			env: {},
		});
		expect(env.ok).toBe(false);
		if (env.ok) return;
		expect(env.error.code).toBe("validation/option");
		expect(env.error.context?.["option"]).toBe("connection-count");
	});

	test("an out-of-range UDP size is rejected", async () => {
		const env = await btestClient({
			host: "192.0.2.10",
			protocol: "udp",
			localUdpTxSize: 99999,
			env: {},
		});
		expect(env.ok).toBe(false);
		if (env.ok) return;
		expect(env.error.code).toBe("validation/option");
		expect(env.error.context?.["option"]).toBe("local-udp-tx-size");
	});

	test("*-udp-tx-size with TCP is rejected", async () => {
		const env = await btestClient({
			host: "192.0.2.10",
			protocol: "tcp",
			remoteUdpTxSize: 1000,
			env: {},
		});
		expect(env.ok).toBe(false);
		if (env.ok) return;
		expect(env.error.context?.["option"]).toBe("remote-udp-tx-size");
	});

	test("server max-sessions out of range is rejected", async () => {
		const env = await btestServer({ maxSessions: 5000, env: {} });
		expect(env.ok).toBe(false);
		if (env.ok) return;
		expect(env.error.code).toBe("validation/option");
		expect(env.error.context?.["option"]).toBe("max-sessions");
	});

	test("a UDP port window that overruns 65535 is rejected", async () => {
		const env = await btestServer({
			authenticate: false,
			allocateUdpPortsFrom: 65500,
			maxSessions: 100,
			env: {},
		});
		expect(env.ok).toBe(false);
		if (env.ok) return;
		expect(env.error.code).toBe("validation/option");
		expect(env.error.context?.["option"]).toBe("allocate-udp-ports-from");
	});

	test("authenticate without a credential is rejected (no listener)", async () => {
		const env = await btestServer({ authenticate: true, env: {} });
		expect(env.ok).toBe(false);
		if (env.ok) return;
		expect(env.error.code).toBe("validation/option");
		expect(env.error.context?.["option"]).toBe("authenticate");
	});

	test("a connection-refused client surfaces transport/connection-refused", async () => {
		// Grab a free port then dial it (nothing listening).
		const probe = await startServer({ authenticate: false, durationMs: 50 });
		await probe.stop();
		const env = await btestClient({
			host: "127.0.0.1",
			controlPort: probe.port,
			protocol: "tcp",
			direction: "receive",
			durationMs: 200,
			env: {},
		});
		expect(env.ok).toBe(false);
		if (env.ok) return;
		expect(env.error.code).toBe("transport/connection-refused");
	});
});

describe("btest client↔server loopback (orchestrators)", () => {
	const short = { durationMs: 300, intervalMs: 40 };

	test("TCP receive: client downloads from a centrs server", async () => {
		const srv = await startServer({ authenticate: false, intervalMs: 40 });
		const client = await btestClient({
			host: "127.0.0.1",
			controlPort: srv.port,
			protocol: "tcp",
			direction: "receive",
			env: {},
			...short,
		});
		const server = await srv.stop();

		expect(client.ok).toBe(true);
		expect(server.ok).toBe(true);
		if (!client.ok || !server.ok) return;
		expect(client.meta.via).toBe("btest");
		expect(client.data.totalRxBytes).toBeGreaterThan(0);
		expect(client.data.reports.length).toBeGreaterThanOrEqual(1);
		expect(server.data.sessions.length).toBe(1);
		// Client receives → server transmits.
		expect(server.data.sessions[0]?.direction).toBe("transmit");
		expect(server.data.sessions[0]?.protocol).toBe("tcp");
	});

	test("TCP both, back-to-back: two sequential sessions both account tx+rx", async () => {
		const srv = await startServer({ authenticate: false, intervalMs: 40 });
		const run = () =>
			btestClient({
				host: "127.0.0.1",
				controlPort: srv.port,
				protocol: "tcp",
				direction: "both",
				env: {},
				...short,
			});
		const first = await run();
		const second = await run();
		const server = await srv.stop();

		// Both back-to-back clients complete — the second is not poisoned by the
		// first's teardown.
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok || !server.ok) return;
		expect(first.data.totalTxBytes).toBeGreaterThan(0);
		expect(first.data.totalRxBytes).toBeGreaterThan(0);

		// One server session per client, each a bidirectional `both` test whose tx
		// *and* rx land in the record (regression: a `both` server session reported
		// totalTxBytes=0 / txAvgBps=0 despite transmitting the client's receive half).
		expect(server.data.sessions.length).toBe(2);
		for (const session of server.data.sessions) {
			expect(session.direction).toBe("both");
			expect(session.totalRxBytes).toBeGreaterThan(0);
			expect(session.totalTxBytes).toBeGreaterThan(0);
			expect(session.txAvgBps).toBeGreaterThan(0);
		}
	});

	test("UDP both: CSV render carries header + rows", async () => {
		const base = 41000 + Math.floor(Math.random() * 10000);
		const srv = await startServer({
			authenticate: false,
			intervalMs: 40,
			allocateUdpPortsFrom: base,
		});
		const client = await btestClient({
			host: "127.0.0.1",
			controlPort: srv.port,
			protocol: "udp",
			direction: "both",
			localUdpTxSize: 1000,
			remoteUdpTxSize: 1000,
			env: {},
			...short,
		});
		await srv.stop();

		expect(client.ok).toBe(true);
		if (!client.ok) return;
		expect(client.data.totalTxBytes).toBeGreaterThan(0);
		const csv = renderBtestClientEnvelope(client, "csv");
		expect(csv.split("\n")[0]).toBe(BTEST_CLIENT_CSV_HEADER);
		expect(csv.split("\n").length).toBeGreaterThan(1);

		// JSON is lossless + round-trippable.
		const json = JSON.parse(renderBtestClientEnvelope(client, "json"));
		expect(json.ok).toBe(true);
		expect(json.meta.via).toBe("btest");
	});

	test(
		"EC-SRP5: matching credentials authenticate, wrong password is rejected",
		async () => {
			const srv = await startServer({
				authenticate: true,
				username: "u",
				password: "swordfish",
				intervalMs: 40,
			});

			const good = await btestClient({
				host: "127.0.0.1",
				controlPort: srv.port,
				protocol: "tcp",
				direction: "receive",
				username: "u",
				password: "swordfish",
				env: {},
				durationMs: 250,
				intervalMs: 40,
			});

			const bad = await btestClient({
				host: "127.0.0.1",
				controlPort: srv.port,
				protocol: "tcp",
				direction: "receive",
				username: "u",
				password: "nope",
				env: {},
				durationMs: 250,
				intervalMs: 40,
			});
			await srv.stop();

			expect(good.ok).toBe(true);
			if (good.ok) expect(good.data.authKind).toBe("ec-srp5");
			expect(bad.ok).toBe(false);
			if (!bad.ok) expect(bad.error.code).toBe("transport/auth-failed");
		},
		EC_SRP5_TIMEOUT_MS,
	);
});
