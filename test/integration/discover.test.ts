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
 * stays covered by the loopback unit test.
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
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";
import { startMndpL2Bridge } from "./mndp-l2-bridge.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

const IDENTITY = "centrs-mndp";

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

		// Host TCP server first — QEMU is the connecting side. Inject a refresh
		// every 4s so RouterOS replies within a round-trip.
		const bridge = await startMndpL2Bridge({
			refreshPayload: mndpRefreshPacket(),
			autoRefreshMs: 4_000,
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
			await chr.exec(`/system/identity/set name=${IDENTITY}`);
			await chr.exec(
				"/ip/neighbor/discovery-settings/set discover-interface-list=all",
			);

			// Run centrs's real discover() against the bridged UDP feed. Abort the
			// listen shortly after the first real announcement is forwarded so the
			// test does not burn the whole timeout window.
			const controller = new AbortController();
			const discoverPromise = discover({
				host: "127.0.0.1",
				port: 0,
				timeoutMs: 40_000,
				sendRefresh: false,
				save: true,
				cdbFile: cdbPath,
				env: {},
				signal: controller.signal,
				onBound: (port) => bridge.setUdpTarget(port, "127.0.0.1"),
			});
			const watcher = (async () => {
				const deadline = Date.now() + 38_000;
				while (Date.now() < deadline) {
					if (bridge.stats().forwarded > 0) {
						await Bun.sleep(750); // let the datagram land + decode
						controller.abort();
						return;
					}
					await Bun.sleep(250);
				}
			})();
			const envelope = await discoverPromise;
			await watcher;

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
