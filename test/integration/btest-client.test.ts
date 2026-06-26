/**
 * centrs btest **client** against a real CHR `/tool/bandwidth-server`, over a
 * QEMU host→guest TCP forward.
 *
 * This is the gated `CHR-passed` evidence for the **client** cell (`docs/MATRIX.md`,
 * "Peer measurement"). It is the mirror of `btest.test.ts` (which gates the
 * *server* cell with a CHR client → centrs server): here centrs is the client and
 * real RouterOS is the bandwidth server, so it validates the half the server test
 * cannot — centrs's **EC-SRP5 client proof** verified by RouterOS's own server
 * verifier, plus the client's TCP receive data engine against a real peer.
 *
 * Topology: a `user`/SLIRP guest is unreachable from the host, so the CHR boots
 * with an `extraPorts` forward `{ name: "btest", host: 0, guest: 2000, proto: "tcp" }`
 * — a host TCP port mapped onto the guest's bandwidth server on 2000. The centrs client
 * dials `127.0.0.1:<host port>`. The same SLIRP inbound path already carries REST
 * and SSH, so no firewall change is needed. TCP only: UDP needs the server's
 * datagrams to traverse SLIRP back to the host, which this forward does not give
 * (README, Open questions) — UDP stays loopback/transitive.
 *
 * Hang-safety: unlike the server suite, every cycle here is a centrs *client* that
 * self-bounds with `durationMs`, so each `btestClient` returns on its own; the CHR
 * server just listens. Covers `commands/btest/examples.md` 6 (client TCP receive)
 * and 8 (EC-SRP5 client role, matching + wrong-password), now against real
 * RouterOS rather than a loopback centrs server, plus a TCP `direction=both`
 * regression guard for the #85 status-reader fix (bidirectional throughput is
 * sustained, not starved).
 */

import { describe, expect, test } from "bun:test";
import { btestClient } from "../../src/btest.ts";
import {
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

/** Dedicated bandwidth-test credential created on the CHR (known, non-empty). */
const BTEST_USER = "btestuser";
const BTEST_PASS = "btestpass";
/** Per-cycle RouterOS-side test length; the centrs client bounds itself with it. */
const CYCLE_MS = 4000;

describeFast(
	"btest: centrs client → CHR /tool/bandwidth-server (TCP, hostfwd)",
	() => {
		test("unauth + EC-SRP5 TCP receive land throughput from real RouterOS", async () => {
			let chr:
				| Awaited<ReturnType<typeof startIntegrationChr>>["chr"]
				| undefined;
			try {
				const started = await startIntegrationChr({
					name: `centrs-btest-client-${Date.now()}`,
					extraPorts: [{ name: "btest", host: 0, guest: 2000, proto: "tcp" }],
				});
				chr = started.chr;
				const ready = chr;
				expect(await ready.waitForBoot(180_000)).toBe(true);
				const resource = (await ready.rest("/system/resource")) as Record<
					string,
					string
				>;

				// Host port forwarded onto the guest's bandwidth server (guest TCP/2000).
				const controlPort = ready.ports["btest"];
				expect(typeof controlPort).toBe("number");

				// A dedicated full-group user with a known password for the EC-SRP5 case —
				// avoids depending on the provisioned admin password (and the empty-password
				// edge). bandwidth-server authenticate=yes verifies against the user DB.
				await ready.exec(
					`/user add name=${BTEST_USER} password=${BTEST_PASS} group=full`,
				);

				const runClient = (
					args: Partial<Parameters<typeof btestClient>[0]>,
				): Promise<Awaited<ReturnType<typeof btestClient>>> =>
					btestClient({
						host: "127.0.0.1",
						controlPort,
						protocol: "tcp",
						direction: "receive",
						durationMs: CYCLE_MS,
						intervalMs: 1000,
						env: {},
						...args,
					});

				// Run every cycle first (logging each) so one run surfaces all outcomes,
				// then assert.

				// 1. Unauthenticated TCP receive: download from the RouterOS server.
				await ready.exec(
					"/tool/bandwidth-server set enabled=yes authenticate=no",
				);
				const unauth = await runClient({});
				console.log(
					`  [unauth] ok=${unauth.ok} ${
						unauth.ok
							? `rx=${unauth.data.totalRxBytes} auth=${unauth.data.authKind} stop=${unauth.data.stopReason}`
							: `${unauth.error.code}: ${unauth.error.summary}`
					}`,
				);

				// 2. EC-SRP5 TCP receive: centrs's client proof verified by the real
				//    RouterOS bandwidth-server (the net-new client-cell grounding).
				await ready.exec("/tool/bandwidth-server set authenticate=yes");
				const authed = await runClient({
					username: BTEST_USER,
					password: BTEST_PASS,
				});
				console.log(
					`  [ec-srp5] ok=${authed.ok} ${
						authed.ok
							? `rx=${authed.data.totalRxBytes} auth=${authed.data.authKind} user=${authed.data.user}`
							: `${authed.error.code}: ${authed.error.summary}`
					}`,
				);

				// 3. A wrong password is rejected by the RouterOS server verifier.
				const bad = await runClient({
					username: BTEST_USER,
					password: "wrongpass",
				});
				console.log(
					`  [bad-pass] ok=${bad.ok} ${
						bad.ok ? `auth=${bad.data.authKind}` : bad.error.code
					}`,
				);

				// 4. TCP both: the #85 regression guard. The client both transmits and
				//    receives on the one TCP stream; without the status-reader fix its TX
				//    saturates the link and server→client RX collapses (issue #85 evidence
				//    had RX falling to ~17 Mbps after second 1). With the fix the client
				//    demuxes the server's interleaved status frames and paces its TX, so
				//    bidirectional throughput is sustained. The deterministic TX-pacing
				//    correctness is unit-tested (applyEmbeddedStatus); here we gate that the
				//    wired `both` path runs end to end against real RouterOS and produces
				//    real bidirectional bytes (the demux must not corrupt the bulk stream).
				await ready.exec("/tool/bandwidth-server set authenticate=no");
				const both = await runClient({ direction: "both" });
				const rxOverTx =
					both.ok && both.data.txTotalAvgBps > 0
						? both.data.rxTotalAvgBps / both.data.txTotalAvgBps
						: 0;
				console.log(
					`  [tcp-both] ok=${both.ok} ${
						both.ok
							? `tx=${both.data.totalTxBytes} rx=${both.data.totalRxBytes} ` +
								`txAvg=${Math.round(both.data.txTotalAvgBps / 1e6)}Mbps ` +
								`rxAvg=${Math.round(both.data.rxTotalAvgBps / 1e6)}Mbps ` +
								`rx/tx=${rxOverTx.toFixed(2)} ` +
								`rxPerInterval=[${both.data.reports.map((r) => Math.round(r.rxBps / 1e6)).join(",")}]Mbps`
							: `${both.error.code}: ${both.error.summary}`
					}`,
				);

				// ── assertions ──
				// 1. Unauth download produced bytes with no auth negotiated.
				expect(
					unauth.ok,
					`unauth client failed: ${unauth.ok ? "" : `${unauth.error.code} ${unauth.error.summary}`}`,
				).toBe(true);
				if (!unauth.ok) return;
				expect(unauth.data.authKind).toBe("none");
				expect(unauth.data.totalRxBytes).toBeGreaterThan(0);
				expect(unauth.meta.via).toBe("btest");

				// 2. EC-SRP5 authenticated download — centrs client ↔ real RouterOS verifier.
				expect(
					authed.ok,
					`ec-srp5 client failed: ${authed.ok ? "" : `${authed.error.code} ${authed.error.summary}`}`,
				).toBe(true);
				if (!authed.ok) return;
				expect(authed.data.authKind).toBe("ec-srp5");
				expect(authed.data.user).toBe(BTEST_USER);
				expect(authed.data.totalRxBytes).toBeGreaterThan(0);

				// 3. Wrong credentials are rejected, no throughput.
				expect(bad.ok).toBe(false);
				if (!bad.ok) expect(bad.error.code).toBe("transport/auth-failed");

				// 4. TCP both produced real bidirectional bytes against real RouterOS —
				//    the #85 status-demux path runs end to end without breaking the run.
				expect(
					both.ok,
					`tcp both client failed: ${both.ok ? "" : `${both.error.code} ${both.error.summary}`}`,
				).toBe(true);
				if (!both.ok) return;
				expect(both.data.totalTxBytes).toBeGreaterThan(0);
				expect(both.data.totalRxBytes).toBeGreaterThan(0);
				// The bug's signature was RX **collapsing** after the first interval while
				// TX dominated. Guard the *shape*, not an absolute Mbps floor (which would
				// flake on the asymmetric SLIRP loopback): every interval carried RX, and
				// the worst interval is within 4x of the mean — a real collapse (RX falling
				// to a fraction of its run average) trips this. The deterministic TX-pacing
				// proof is the `applyEmbeddedStatus` unit test.
				const rxIntervals = both.data.reports.map((r) => r.rxBps);
				expect(rxIntervals.length).toBeGreaterThanOrEqual(2);
				expect(Math.min(...rxIntervals)).toBeGreaterThan(0);
				const meanRx =
					rxIntervals.reduce((a, b) => a + b, 0) / rxIntervals.length;
				expect(Math.min(...rxIntervals)).toBeGreaterThan(meanRx * 0.25);

				await recordIntegrationEvidence({
					suite:
						"btest: centrs client → CHR /tool/bandwidth-server (TCP, hostfwd)",
					command: "btest",
					protocol: "btest",
					routerosVersion: resource["version"] ?? ready.state.version,
					boardName: resource["board-name"],
					quickChrName: ready.name,
					requestedChannel: started.requestedChannel,
					requestedVersion: started.requestedVersion,
					exampleIds: [6, 8],
				});

				console.log(
					`  btest client validated: unauth rx=${unauth.data.totalRxBytes}B, ` +
						`ec-srp5 rx=${authed.data.totalRxBytes}B (user=${authed.data.user}), ` +
						"wrong-password rejected.",
				);
			} finally {
				await chr?.destroy();
			}
		}, 300_000);
	},
);
