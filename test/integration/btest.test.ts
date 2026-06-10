/**
 * `btest` server against a real CHR bandwidth-test **client**, over QEMU SLIRP.
 *
 * This is the gated `CHR-passed` evidence for the **server** cell (`docs/MATRIX.md`,
 * "Peer measurement"). A `user`/SLIRP CHR reaches the host at the gateway
 * `10.0.2.2`; the centrs btest server binds the host on TCP/UDP 2000, and the
 * CHR's `/tool/bandwidth-test address=10.0.2.2 …` dials it. Guest→host is plain
 * SLIRP outbound, so **no hostfwd** is needed.
 *
 * Hang-safety: RouterOS `/tool/bandwidth-test` is an interactive tool that does
 * not always return cleanly to a non-interactive console even with `duration=`,
 * so this suite never blocks on `chr.exec`. Each cycle's **centrs server bounds
 * itself with `durationMs`** (the source of truth) and the bandwidth-test is
 * fired without awaiting; a connectivity failure then surfaces as a fast
 * "0 sessions" assertion, not a multi-minute timeout. `startCentrsServer` also
 * fails fast if it cannot bind (e.g. a leftover server on 2000).
 *
 * Gated coverage (decided with the user, see `commands/btest/README.md`):
 *   - **TCP** any direction; **UDP transmit** (client→server, SLIRP-friendly);
 *     **EC-SRP5** auth (the net-new server verifier vs real RouterOS).
 *   - **UDP receive/both** rides server→guest datagrams back through SLIRP NAT;
 *     that path is a **soft smoke test** here (logged, never fails the suite)
 *     until grounded — see the README's Open questions.
 *
 * Covers `commands/btest/examples.md` 1–3. Multi-connection TCP (example 5) is a
 * follow-up (the server's parallel-stream fan-out is not built yet).
 */

import { describe, expect, test } from "bun:test";
import {
	type BtestServerEnvelope,
	type BtestServerRequest,
	btestServer,
} from "../../src/btest.ts";
import {
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

/** Host gateway as seen from a `user`/SLIRP CHR. */
const GATEWAY = "10.0.2.2";
/** Fixed btest control port — RouterOS `/tool/bandwidth-test` always dials 2000. */
const CONTROL_PORT = 2000;
/** Per-cycle server lifetime (must exceed connect + EC-SRP5 handshake + data). */
const CYCLE_MS = 15_000;
/** RouterOS-side test duration. */
const TEST_DURATION = "5s";

/**
 * Start a centrs btest server bound on the host for `cycleMs`, resolving once it
 * is listening. Throws fast if the bind fails (rather than hanging on `onBound`).
 */
async function startCentrsServer(
	options: Omit<BtestServerRequest, "bind" | "port" | "onBound" | "signal">,
): Promise<{ promise: Promise<BtestServerEnvelope> }> {
	let resolveBound: () => void = () => {};
	const bound = new Promise<void>((resolve) => {
		resolveBound = resolve;
	});
	const promise = btestServer({
		bind: "0.0.0.0",
		port: CONTROL_PORT,
		intervalMs: 1000,
		durationMs: CYCLE_MS,
		onBound: () => resolveBound(),
		...options,
	});
	// If the server settles before it ever binds, it failed to listen — surface
	// that instead of waiting on an `onBound` that will never fire.
	const failFast = promise.then((env) =>
		env.ok
			? new Promise<void>(() => {}) // success settles much later; never wins the race
			: Promise.reject(
					new Error(
						`btest server did not bind on ${CONTROL_PORT}: ${env.error.summary}`,
					),
				),
	);
	await Promise.race([bound, failFast]);
	return { promise };
}

describeFast("btest: CHR bandwidth-test client → centrs server (SLIRP)", () => {
	test("TCP + UDP-transmit + EC-SRP5 sessions land on the centrs server", async () => {
		let chr: Awaited<ReturnType<typeof startIntegrationChr>>["chr"] | undefined;
		try {
			const started = await startIntegrationChr({
				name: `centrs-btest-${Date.now()}`,
			});
			chr = started.chr;
			const ready = chr;
			expect(await ready.waitForBoot(180_000)).toBe(true);
			const resource = (await ready.rest("/system/resource")) as Record<
				string,
				string
			>;

			/**
			 * Run one cycle: start a host server, fire the CHR bandwidth-test (never
			 * awaited — it self-bounds with `duration=` and the server bounds the
			 * cycle), then await the server's aggregate. Logs the outcome (sessions +
			 * warnings) unconditionally so a failing run is diagnosable in one pass.
			 */
			const runCycle = async (
				label: string,
				serverOpts: Parameters<typeof startCentrsServer>[0],
				testArgs: string,
			): Promise<BtestServerEnvelope> => {
				const srv = await startCentrsServer(serverOpts);
				fireTest(testArgs);
				const env = await srv.promise;
				if (env.ok) {
					const sessions = env.data.sessions
						.map(
							(s) =>
								`{${s.protocol} ${s.direction} auth=${s.authKind} user=${s.user || "-"} tx=${s.totalTxBytes} rx=${s.totalRxBytes} lost=${s.totalLostPackets}}`,
						)
						.join(" ");
					console.log(
						`  [${label}] ok sessions=${env.data.sessions.length} ${sessions} warnings=${JSON.stringify(env.warnings)}`,
					);
				} else {
					console.log(
						`  [${label}] FAILED ${env.error.code}: ${env.error.summary}`,
					);
				}
				return env;
			};
			const fireTest = (args: string): void => {
				void ready
					.exec(`/tool/bandwidth-test address=${GATEWAY} ${args}`)
					.catch(() => {
						/* a non-returning interactive run is expected; the server is the truth */
					});
			};

			// Run all cycles first (logging each), then assert — so one run surfaces
			// every cycle's outcome rather than stopping at the first failure.
			const tcpRxEnv = await runCycle(
				"tcp-rx",
				{ authenticate: false },
				`protocol=tcp direction=receive duration=${TEST_DURATION}`,
			);
			const udpTxEnv = await runCycle(
				"udp-tx",
				{ authenticate: false },
				`protocol=udp direction=transmit local-udp-tx-size=1000 duration=${TEST_DURATION}`,
			);
			const ecRxEnv = await runCycle(
				"ec-srp5-tcp-rx",
				{ authenticate: true, username: "btestuser", password: "btestpass" },
				`protocol=tcp direction=receive user=btestuser password=btestpass duration=${TEST_DURATION}`,
			);
			const udpRxEnv = await runCycle(
				"udp-rx-smoke",
				{ authenticate: false },
				`protocol=udp direction=receive remote-udp-tx-size=1000 duration=${TEST_DURATION}`,
			);

			// 1. Unauthenticated TCP receive (server transmits to the CHR).
			expect(tcpRxEnv.ok).toBe(true);
			if (!tcpRxEnv.ok) return;
			expect(
				tcpRxEnv.data.sessions.length,
				`no TCP session reached the server (SLIRP/connectivity?); warnings: ${JSON.stringify(tcpRxEnv.warnings)}`,
			).toBeGreaterThanOrEqual(1);
			const rxSession = tcpRxEnv.data.sessions[0];
			expect(rxSession?.protocol).toBe("tcp");
			expect(rxSession?.direction).toBe("transmit"); // client receives
			expect(rxSession?.totalTxBytes).toBeGreaterThan(0);

			// 2. Unauthenticated UDP transmit (client→server; SLIRP-friendly).
			expect(udpTxEnv.ok).toBe(true);
			if (!udpTxEnv.ok) return;
			expect(udpTxEnv.data.sessions.length).toBeGreaterThanOrEqual(1);
			const udpSession = udpTxEnv.data.sessions[0];
			expect(udpSession?.protocol).toBe("udp");
			expect(udpSession?.direction).toBe("receive"); // client transmits
			expect(udpSession?.totalRxBytes).toBeGreaterThan(0);

			// 3. EC-SRP5-authenticated TCP receive — the net-new server verifier
			//    against real RouterOS (the key validation of this suite).
			expect(ecRxEnv.ok).toBe(true);
			if (!ecRxEnv.ok) return;
			const ecSession = ecRxEnv.data.sessions.find(
				(s) => s.authKind === "ec-srp5",
			);
			expect(
				ecSession,
				`no EC-SRP5 session; warnings: ${JSON.stringify(ecRxEnv.warnings)}`,
			).toBeDefined();
			expect(ecSession?.user).toBe("btestuser");
			expect(ecSession?.totalTxBytes).toBeGreaterThan(0);

			// Soft smoke only — never fails the suite (README, Open questions).
			const udpRxBytes =
				udpRxEnv.ok && udpRxEnv.data.sessions[0]
					? udpRxEnv.data.sessions[0].totalTxBytes
					: 0;
			console.log(
				`  UDP-receive SLIRP smoke: server→guest sent ${udpRxBytes} byte(s) ` +
					"(non-zero would mean the reverse NAT path works).",
			);

			await recordIntegrationEvidence({
				suite: "btest: CHR bandwidth-test client → centrs server (SLIRP)",
				command: "btest",
				protocol: "btest",
				routerosVersion: resource["version"] ?? ready.state.version,
				boardName: resource["board-name"],
				quickChrName: ready.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [1, 2, 3],
			});

			console.log(
				`  btest server validated: tcp-rx tx=${rxSession?.totalTxBytes}B, ` +
					`udp-tx rx=${udpSession?.totalRxBytes}B, ec-srp5 tx=${ecSession?.totalTxBytes}B`,
			);
		} finally {
			await chr?.destroy();
		}
	}, 300_000);
});
