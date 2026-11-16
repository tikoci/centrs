/**
 * `discover` over MNDP against a real CHR, over a real layer-2 path.
 *
 * MNDP is a UDP/5678 L2 broadcast; a `user`/SLIRP CHR terminates L2 in a
 * userspace NAT, so the host sees nothing. The harness gives the CHR a second
 * `socket-connect` NIC (QEMU streams every guest frame to a host TCP server),
 * and {@link startMndpL2Bridge} lifts the UDP/5678 payload out of each frame and
 * re-delivers it to centrs's real `discover()` UDP listener on loopback. The
 * code under test — `listenMndp` → `parseMndpPacket` → cache → envelope, plus
 * the `--save` write path — runs unmodified against genuine RouterOS
 * announcements. See `commands/discover/README.md` (L2 validation policy) and
 * `@tikoci/quickchr` `docs/mndp.md`.
 *
 * centrs runs with `sendRefresh: false`: its own UDP broadcast cannot reach the
 * guest through the bridge, so the bridge performs the L2 refresh injection (the
 * same write-back primitive MAC-Telnet will reuse). centrs's refresh-send path
 * stays covered by the loopback unit test. The test injects exactly one
 * {@link mndpRefreshPacket} after the listener goes quiet and asserts that
 * RouterOS answers it, so it proves the refresh bytes work rather than passing
 * on a triggered or periodic announcement (tikoci/m2ir#5).
 *
 * Covers examples 1 (passive discover + neighbor fields), 2 (scan packet-count
 * meta), and 4 (`--save` into a CDB) from `commands/discover/examples.md` on
 * real L2. The pure-logic examples (3 port-in-use, 5 group, 6 de-dupe, 7
 * encrypted CDB) stay validated by the fixture/loopback unit tests.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mndpRefreshPacket } from "../../src/data/mndp.ts";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";
import { loadCdb, showDevice } from "../../src/devices.ts";
import { discover } from "../../src/discover.ts";
import { parseCommentKv } from "../../src/resolver/comment-kv.ts";
import {
	isChrIntegrationEnabled,
	MNDP_DISCOVER_INTERVAL_SINCE,
	MNDP_RUNNING_TLV_SINCE,
	MNDP_TTL_TLV_SINCE,
	recordIntegrationEvidence,
	routerOsAtLeast,
	startIntegrationChr,
} from "./chr.ts";
import { startMndpL2Bridge } from "./mndp-l2-bridge.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

const IDENTITY = "centrs-mndp";

/** m2ir#5 saw replies 21 ms to 1.96 s after a request on 7.x. */
const REFRESH_REPLY_WINDOW_MS = 3_000;
/** The listener counts as quiet after this long with no forwarded datagram. */
const QUIET_SPELL_MS = 3_000;
/** Fixed periodic interval before `discover-interval` existed (pre-7.16). */
const LEGACY_ANNOUNCE_INTERVAL_MS = 60_000;
/** Quiet gap that ends one announcement event (its copies arrive together). */
const EVENT_DRAIN_QUIET_MS = 500;

/**
 * Wait until `forwarded()` stops changing for `quietMs`, or `deadlineMs`
 * passes. Returns whether the quiet spell completed.
 */
async function waitForQuiet(
	forwarded: () => number,
	quietMs: number,
	deadlineMs: number,
	pollMs: number,
): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	let seen = forwarded();
	let quietSince = Date.now();
	while (Date.now() - quietSince < quietMs) {
		if (Date.now() >= deadline) {
			return false;
		}
		await Bun.sleep(pollMs);
		const now = forwarded();
		if (now !== seen) {
			seen = now;
			quietSince = Date.now();
		}
	}
	return true;
}

/** Seconds in a RouterOS duration such as `30s`, `10m` or `1h30m`. */
function routerOsDurationSeconds(text: string): number | undefined {
	const match =
		/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
	if (!match || text === "") return undefined;
	const [, w, d, h, m, sec] = match.map((part) => Number(part ?? 0));
	return (
		(w ?? 0) * 604_800 +
		(d ?? 0) * 86_400 +
		(h ?? 0) * 3_600 +
		(m ?? 0) * 60 +
		(sec ?? 0)
	);
}

function asRecord(value: unknown): Record<string, string> {
	return (value ?? {}) as Record<string, string>;
}

describeFast("discover over MNDP against CHR (socket-connect L2)", () => {
	test("captures a real MNDP announcement, decodes it, and saves it to the CDB", async () => {
		// Scratch CDB for --save, seeded with one unrelated record so the new
		// neighbor is an addition (mirrors the unit test's setup).
		const dir = join(
			process.cwd(),
			".scratch",
			`centrs-discover-int-${Date.now()}`,
		);
		await mkdir(dir, { recursive: true });
		const cdbPath = join(dir, "winbox.cdb");
		await writeFile(
			cdbPath,
			encodeOpenWinBoxCdb([
				buildWinBoxCdbEntryRecord({
					recordType: winBoxCdbRecordType.ipAdmin,
					target: "198.51.100.1",
					user: "admin",
				}),
			]),
		);

		// Host TCP server first — QEMU is the connecting side. No auto-refresh:
		// the test injects one refresh itself and checks RouterOS answers it.
		const bridge = await startMndpL2Bridge({
			refreshPayload: mndpRefreshPacket(),
		});

		let chr: Awaited<ReturnType<typeof startIntegrationChr>>["chr"] | undefined;
		try {
			const started = await startIntegrationChr({
				name: `centrs-mndp-${Date.now()}`,
				networks: ["user", { type: "socket-connect", port: bridge.tcpPort }],
			});
			chr = started.chr;
			expect(await chr.waitForBoot(180_000)).toBe(true);

			// Make discovery deterministic: a known identity + MNDP on every NIC.
			// Where discover-interval exists (7.16+), stretch it so no periodic
			// announcement can land in the refresh window below. Older senders
			// announce every 60 s with no setting; the watcher phase-aligns
			// to that period instead.
			const routerOs = chr.state.version;
			const stretchInterval = routerOsAtLeast(
				routerOs,
				MNDP_DISCOVER_INTERVAL_SINCE,
			);
			await chr.exec(`/system/identity/set name=${IDENTITY}`);
			await chr.exec(
				`/ip/neighbor/discovery-settings/set discover-interface-list=all${
					stretchInterval ? " discover-interval=10m" : ""
				}`,
			);

			// Run centrs's real discover() against the bridged UDP feed. Once the
			// announcements triggered by the settings above have drained, inject
			// one refresh, wait for its reply, then abort the listen.
			const controller = new AbortController();
			const discoverPromise = discover({
				host: "127.0.0.1",
				port: 0,
				timeoutMs: stretchInterval ? 40_000 : 120_000,
				sendRefresh: false,
				save: true,
				cdbFile: cdbPath,
				env: {},
				signal: controller.signal,
				onBound: (port) => bridge.setUdpTarget(port, "127.0.0.1"),
			});
			let refreshReplyMs: number | undefined;
			// Set when the watcher could not set up a clean refresh window; the
			// refresh is then not injected, so a stray announcement can't pass
			// for its reply.
			let setupFailure: string | undefined;
			const forwarded = (): number => bridge.stats().forwarded;
			const watcher = (async () => {
				if (!(await waitForQuiet(forwarded, QUIET_SPELL_MS, 20_000, 250))) {
					setupFailure = `the listener never went ${QUIET_SPELL_MS} ms without a datagram within 20 s`;
					controller.abort();
					return;
				}
				if (!stretchInterval) {
					// A quiet spell says nothing about where the next periodic
					// announcement falls. Wait for one, then inject at once: the
					// following periodic one is ~60 s away, far outside the window.
					const periodic = forwarded();
					const periodicDeadline =
						Date.now() + LEGACY_ANNOUNCE_INTERVAL_MS + 10_000;
					while (forwarded() === periodic && Date.now() < periodicDeadline) {
						await Bun.sleep(50);
					}
					if (forwarded() === periodic) {
						setupFailure = `no periodic announcement within ${
							LEGACY_ANNOUNCE_INTERVAL_MS + 10_000
						} ms on a pre-${MNDP_DISCOVER_INTERVAL_SINCE} sender`;
						controller.abort();
						return;
					}
					// Drain the rest of that announcement event (any further
					// copies) before the snapshot, so none counts as the reply.
					if (
						!(await waitForQuiet(forwarded, EVENT_DRAIN_QUIET_MS, 5_000, 50))
					) {
						setupFailure =
							"the periodic announcement event did not drain within 5 s";
						controller.abort();
						return;
					}
				}
				const before = bridge.stats().forwarded;
				const sentAt = Date.now();
				bridge.injectRefresh();
				while (Date.now() - sentAt < REFRESH_REPLY_WINDOW_MS) {
					if (bridge.stats().forwarded > before) {
						refreshReplyMs = Date.now() - sentAt;
						break;
					}
					await Bun.sleep(50);
				}
				await Bun.sleep(750); // let the datagram land + decode
				controller.abort();
			})();
			const envelope = await discoverPromise;
			await watcher;

			expect(bridge.stats().connected).toBe(true);
			expect(setupFailure, setupFailure).toBeUndefined();
			expect(
				refreshReplyMs,
				`no announcement within ${REFRESH_REPLY_WINDOW_MS} ms of the injected refresh`,
			).toBeDefined();

			expect(envelope.ok).toBe(true);
			if (!envelope.ok) return;
			expect(envelope.meta.via).toBe("mndp");
			expect(envelope.meta.operation?.packetsDecoded ?? 0).toBeGreaterThan(0);

			const match = envelope.data.neighbors.find(
				(neighbor) => neighbor.identity === IDENTITY,
			);
			expect(
				match,
				`no MNDP neighbor with identity=${IDENTITY}; captured ${
					bridge.stats().forwarded
				} datagram(s), decoded ${envelope.meta.operation?.packetsDecoded}`,
			).toBeDefined();
			if (!match) return;

			// Cross-check the L2-decoded values against REST (source of truth).
			const identity = asRecord(await chr.rest("/system/identity"));
			const resource = asRecord(await chr.rest("/system/resource"));
			expect(match.identity).toBe(identity["name"]);
			expect(match.platform).toBe(resource["platform"]); // "MikroTik"
			// MNDP's board TLV (type 12) is the short board id — "CHR" — while REST
			// `board-name` is the verbose hardware string ("CHR QEMU Standard PC …")
			// that begins with it. (On real hardware the two are equal, so startsWith
			// holds in both cases.) A fixture test would never surface this gap.
			expect(match.board).toBeTruthy();
			expect((resource["board-name"] ?? "").startsWith(match.board ?? "")).toBe(
				true,
			);
			expect(typeof match.version).toBe("string");
			expect((match.version ?? "").startsWith(resource["version"] ?? "")).toBe(
				true,
			);
			expect(match.mac).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);

			// Grounded wire map (#668): TLV 14 is the IPv6-enabled flag, TLV 18
			// the running bitmask (7.20+), TLV 19 the TTL (7.24+). The header is
			// kept raw: a u32 counter in the sender's byte order. TLV 14 tracks
			// disable-ipv6 only on newer senders (7.17 always sends 01; 7.18–7.20
			// latch a disable until reboot), so this holds on the default config, which
			// never toggles it.
			const ipv6Settings = asRecord(await chr.rest("/ipv6/settings"));
			expect(match.ipv6Enabled).toBe(ipv6Settings["disable-ipv6"] !== "true");
			if (routerOsAtLeast(routerOs, MNDP_RUNNING_TLV_SINCE)) {
				expect(match.running).toEqual([]);
			}
			if (routerOsAtLeast(routerOs, MNDP_TTL_TLV_SINCE)) {
				const discovery = asRecord(
					await chr.rest("/ip/neighbor/discovery-settings"),
				);
				const interval = routerOsDurationSeconds(
					discovery["discover-interval"] ?? "",
				);
				expect(interval, "discover-interval").toBeDefined();
				expect(match.ttlSeconds).toBe(Math.min((interval ?? 0) * 4 + 1, 255));
			}
			expect(match.headerHex).toMatch(/^[0-9a-f]{8}$/);

			// --save persisted the neighbor (no IPv4 on ether2 → MAC target).
			expect(envelope.meta.operation?.saved?.added ?? 0).toBeGreaterThan(0);
			expect(envelope.meta.operation?.saved?.group).toBe("discovered");
			const cdb = await loadCdb({ cdbFile: cdbPath, env: {} });
			const shown = showDevice({ cdb, target: match.mac ?? "" });
			expect(shown.ok).toBe(true);
			if (!shown.ok) return;
			expect(shown.data.entry.recordType).toBe(winBoxCdbRecordType.macTarget);
			expect(shown.data.entry.group).toBe("discovered");
			const kv = parseCommentKv(shown.data.entry.comment);
			expect(kv.values.source).toBe("mndp");
			// The advertised identity is written as a resolvable lookup key, so the
			// saved device answers to `centrs <verb> <identity>` too.
			expect(kv.lookups.identity).toBe(match.identity);
			expect(match.identity).toBeDefined();
			const byIdentity = showDevice({ cdb, target: match.identity as string });
			expect(byIdentity.ok).toBe(true);

			await recordIntegrationEvidence({
				suite: "discover over MNDP against CHR (socket-connect L2)",
				command: "discover",
				protocol: "mndp",
				routerosVersion: resource["version"] ?? chr.state.version,
				boardName: resource["board-name"],
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [1, 2, 4],
			});

			console.log(
				`  MNDP via L2: identity=${match.identity} board=${match.board} version="${match.version}" mac=${match.mac}`,
			);
		} finally {
			await chr?.destroy();
			await bridge.close();
			await rm(dir, { recursive: true, force: true });
		}
	}, 300_000);
});
