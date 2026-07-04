import { describe, expect, spyOn, test } from "bun:test";
import { createSocket, Socket } from "node:dgram";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeMndpPacket, type MndpNeighbor } from "../../src/data/mndp.ts";
import { MndpCache } from "../../src/data/mndp-cache.ts";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	encryptWinBoxCdb,
	type WinBoxCdbRecord,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";
import { loadCdb, showDevice } from "../../src/devices.ts";
import {
	type DiscoverEnvelope,
	defaultMndpReusePort,
	discover,
	type ListenMndpResult,
	listenMndp,
	saveDiscoveredNeighbors,
} from "../../src/discover.ts";
import { parseCommentKv } from "../../src/resolver/comment-kv.ts";
import { udpLoopbackSupported } from "./udp-loopback.ts";

// Mirror MNDP's production bind default. On Windows that avoids SO_REUSEPORT;
// on platforms that use SO_REUSEPORT, skip only when that exact bind is
// unavailable. The real L2 path remains covered by CHR integration. (#69)
const MNDP_LOOPBACK = await udpLoopbackSupported({
	reusePort: defaultMndpReusePort(),
});

describe("defaultMndpReusePort", () => {
	test("disables SO_REUSEPORT by default on Windows only", () => {
		expect(defaultMndpReusePort("win32")).toBe(false);
		expect(defaultMndpReusePort("darwin")).toBe(true);
		expect(defaultMndpReusePort("linux")).toBe(true);
	});
});

function neighbor(
	mac: string,
	overrides: Partial<MndpNeighbor> = {},
): MndpNeighbor {
	return {
		sequence: 0,
		macAddress: mac,
		identity: "rt",
		unknownTlvs: [],
		...overrides,
	};
}

function fakeListen(
	neighbors: readonly MndpNeighbor[],
): (options: unknown) => Promise<ListenMndpResult> {
	return async () => {
		const cache = new MndpCache({ now: () => 1_000 });
		for (const item of neighbors) {
			cache.observe(item, 1_000);
		}
		return {
			cache,
			port: 5678,
			packetsReceived: neighbors.length,
			packetsDecoded: neighbors.length,
			packetsRejected: 0,
			warnings: [],
		};
	};
}

async function scratchCdbDir(prefix: string): Promise<string> {
	const dir = join(
		process.cwd(),
		".scratch",
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(dir, { recursive: true });
	return dir;
}

async function tempCdb(records: readonly WinBoxCdbRecord[]): Promise<{
	path: string;
	cleanup: () => Promise<void>;
}> {
	const dir = await scratchCdbDir("centrs-discover");
	const path = join(dir, "winbox.cdb");
	await writeFile(path, encodeOpenWinBoxCdb(records));
	return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function seedRecord(target: string): WinBoxCdbRecord {
	return buildWinBoxCdbEntryRecord({
		recordType: winBoxCdbRecordType.ipAdmin,
		target,
		user: "admin",
	});
}

describe.skipIf(!MNDP_LOOPBACK)("listenMndp (loopback)", () => {
	test("decodes crafted packets and ends after the timeout window", async () => {
		const packets = [
			encodeMndpPacket(
				neighbor("e4:8d:8c:00:00:01", { identity: "alpha", ipv4: "192.0.2.1" }),
			),
			encodeMndpPacket(
				neighbor("e4:8d:8c:00:00:02", { identity: "beta", ipv4: "192.0.2.2" }),
			),
		];

		const started = Date.now();
		const result = await listenMndp({
			host: "127.0.0.1",
			port: 0,
			timeoutMs: 400,
			sendRefresh: false,
			onBound: (port) => {
				const sender = createSocket("udp4");
				let sent = 0;
				for (const packet of packets) {
					sender.send(packet, port, "127.0.0.1", () => {
						sent += 1;
						if (sent === packets.length) {
							sender.close();
						}
					});
				}
			},
		});

		expect(Date.now() - started).toBeGreaterThanOrEqual(380);
		expect(result.port).toBeGreaterThan(0);
		expect(result.packetsDecoded).toBe(2);
		const macs = result.cache
			.entries()
			.map((entry) => entry.neighbor.macAddress);
		expect(macs).toEqual(["e4:8d:8c:00:00:01", "e4:8d:8c:00:00:02"]);
	});

	test("ignores the MAC-less refresh echo", async () => {
		const result = await listenMndp({
			host: "127.0.0.1",
			port: 0,
			timeoutMs: 300,
			sendRefresh: false,
			onBound: (port) => {
				const sender = createSocket("udp4");
				sender.send(new Uint8Array(9), port, "127.0.0.1", () => sender.close());
			},
		});
		expect(result.packetsReceived).toBe(1);
		expect(result.packetsDecoded).toBe(0);
		expect(result.packetsRejected).toBe(1);
		// A MAC-less echo parses fine — it is not a malformed datagram.
		expect(result.warnings).toHaveLength(0);
	});

	test("surfaces a malformed datagram as an aggregated mndp/malformed warning", async () => {
		const result = await listenMndp({
			host: "127.0.0.1",
			port: 0,
			timeoutMs: 300,
			sendRefresh: false,
			onBound: (port) => {
				const sender = createSocket("udp4");
				// 2 bytes is shorter than the 4-byte MNDP header, so the parser
				// throws and the receive path counts it as malformed.
				sender.send(new Uint8Array(2), port, "127.0.0.1", () => sender.close());
			},
		});
		expect(result.packetsRejected).toBe(1);
		const malformed = result.warnings.find((w) => w.code === "mndp/malformed");
		expect(malformed).toBeDefined();
		expect(malformed?.context?.["count"]).toBe(1);
	});

	test("warns discover/broadcast-unavailable when setBroadcast is rejected", async () => {
		const spy = spyOn(Socket.prototype, "setBroadcast").mockImplementation(
			() => {
				throw Object.assign(new Error("broadcast forbidden"), {
					code: "EPERM",
				});
			},
		);
		try {
			const result = await listenMndp({
				host: "127.0.0.1",
				port: 0,
				timeoutMs: 150,
				sendRefresh: true,
				refreshIntervalMs: 0,
			});
			const warning = result.warnings.find(
				(w) => w.code === "discover/broadcast-unavailable",
			);
			expect(warning).toBeDefined();
			expect(warning?.context?.["cause"]).toBe("EPERM");
		} finally {
			spy.mockRestore();
		}
	});

	test("rejects a bind on an already-used port with mndp/listen-failed", async () => {
		const blocker = createSocket("udp4");
		await new Promise<void>((resolve) =>
			blocker.bind(0, "127.0.0.1", () => resolve()),
		);
		const port = blocker.address().port;
		try {
			let caught: unknown;
			try {
				await listenMndp({
					host: "127.0.0.1",
					port,
					timeoutMs: 200,
					sendRefresh: false,
					reuseAddr: false,
					reusePort: false,
				});
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeDefined();
			expect((caught as { code: string }).code).toBe("mndp/listen-failed");
		} finally {
			blocker.close();
		}
	});
});

describe("discover", () => {
	test("returns a sorted neighbor set without saving", async () => {
		const envelope = await discover({
			listen: fakeListen([
				neighbor("ff:00:00:00:00:00", { identity: "z" }),
				neighbor("00:00:00:00:00:01", { identity: "a" }),
			]),
		});
		expect(envelope.ok).toBe(true);
		if (!envelope.ok) {
			return;
		}
		expect(envelope.data.count).toBe(2);
		expect(envelope.data.neighbors.map((n) => n.mac)).toEqual([
			"00:00:00:00:00:01",
			"ff:00:00:00:00:00",
		]);
		expect(envelope.meta.via).toBe("mndp");
		expect(envelope.meta.operation?.saved).toBeUndefined();
	});

	test("tips to use --save when neighbors are found but not saved", async () => {
		const envelope = await discover({
			listen: fakeListen([neighbor("00:00:00:00:00:01", { identity: "a" })]),
		});
		expect(envelope.ok).toBe(true);
		expect(envelope.tips.map((tip) => tip.code)).toContain("tip/discover-save");
	});

	test("no --save tip when nothing was discovered", async () => {
		const envelope = await discover({ listen: fakeListen([]) });
		expect(envelope.ok).toBe(true);
		expect(envelope.tips).toHaveLength(0);
	});
});

describe("discover --save", () => {
	test("writes new neighbors with group=discovered and source=mndp", async () => {
		const { path, cleanup } = await tempCdb([seedRecord("198.51.100.1")]);
		try {
			const envelope = await discover({
				save: true,
				cdbFile: path,
				env: {},
				listen: fakeListen([
					neighbor("e4:8d:8c:11:22:33", {
						identity: "edge",
						board: "RB4011iGS+5HacQ2HnD",
						version: "7.18 (stable)",
						ipv4: "192.0.2.50",
					}),
				]),
			});

			expect(envelope.ok).toBe(true);
			if (!envelope.ok) {
				return;
			}
			expect(envelope.meta.operation?.saved?.added).toBe(1);
			expect(envelope.meta.operation?.saved?.group).toBe("discovered");

			const cdb = await loadCdb({ cdbFile: path, env: {} });
			const shown = showDevice({ cdb, target: "192.0.2.50" });
			expect(shown.ok).toBe(true);
			if (!shown.ok) {
				return;
			}
			expect(shown.data.entry.group).toBe("discovered");
			const kv = parseCommentKv(shown.data.entry.comment);
			expect(kv.values.source).toBe("mndp");
			expect(kv.warnings).toHaveLength(0);
			// Identity/MAC are written as resolvable lookup keys, not inert detail.
			expect(kv.lookups.identity).toBe("edge");
			expect(kv.lookups.mac).toBe("e4:8d:8c:11:22:33");
			expect(shown.data.entry.comment).not.toContain("identity: edge");
			// The advertised identity now resolves the IP-targeted record directly.
			const byIdentity = showDevice({ cdb, target: "edge" });
			expect(byIdentity.ok).toBe(true);
			if (byIdentity.ok) {
				expect(byIdentity.data.entry.target).toBe("192.0.2.50");
			}
		} finally {
			await cleanup();
		}
	});

	test("uses macTarget record type when the neighbor has no IPv4", async () => {
		const { path, cleanup } = await tempCdb([seedRecord("198.51.100.1")]);
		try {
			const result = await saveDiscoveredNeighbors({
				loadOptions: { cdbFile: path, env: {} },
				neighbors: [neighbor("aa:bb:cc:dd:ee:ff", { identity: "l2-only" })],
			});
			expect(result.summary.added).toBe(1);
			const cdb = await loadCdb({ cdbFile: path, env: {} });
			const shown = showDevice({ cdb, target: "aa:bb:cc:dd:ee:ff" });
			expect(shown.ok).toBe(true);
			if (!shown.ok) {
				return;
			}
			expect(shown.data.entry.recordType).toBe(winBoxCdbRecordType.macTarget);
			// identity= is the only added lookup key (the MAC *is* the target, so no
			// redundant mac= key); the record resolves by its advertised identity.
			const kv = parseCommentKv(shown.data.entry.comment);
			expect(kv.lookups.identity).toBe("l2-only");
			expect(kv.lookups.mac).toBeUndefined();
			const byIdentity = showDevice({ cdb, target: "l2-only" });
			expect(byIdentity.ok).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("de-dupes on the MAC even when the IP differs (mac= lookup key)", async () => {
		// Seed an IP record that already carries the neighbor's MAC as a mac= lookup
		// key. A later announcement at a *different* IP but the same MAC must be
		// recognized as the same device and skipped.
		const seeded = buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: "192.0.2.50",
			user: "admin",
			comment: "mac=AA:BB:CC:DD:EE:FF",
		});
		const { path, cleanup } = await tempCdb([seeded]);
		try {
			const result = await saveDiscoveredNeighbors({
				loadOptions: { cdbFile: path, env: {} },
				neighbors: [neighbor("aa:bb:cc:dd:ee:ff", { ipv4: "192.0.2.99" })],
			});
			expect(result.summary.added).toBe(0);
			expect(result.summary.skipped).toBe(1);
			const cdb = await loadCdb({ cdbFile: path, env: {} });
			expect(cdb.entries.map((entry) => entry.target)).toEqual(["192.0.2.50"]);
		} finally {
			await cleanup();
		}
	});

	test("de-dupes: a neighbor whose target already exists is skipped", async () => {
		const { path, cleanup } = await tempCdb([seedRecord("192.0.2.50")]);
		try {
			const result = await saveDiscoveredNeighbors({
				loadOptions: { cdbFile: path, env: {} },
				neighbors: [
					neighbor("e4:8d:8c:11:22:33", { ipv4: "192.0.2.50" }),
					neighbor("e4:8d:8c:11:22:34", { ipv4: "192.0.2.51" }),
				],
			});
			expect(result.summary.added).toBe(1);
			expect(result.summary.skipped).toBe(1);
			const skipped = result.summary.records.find(
				(record) => record.action === "skipped-existing",
			);
			expect(skipped?.target).toBe("192.0.2.50");

			const cdb = await loadCdb({ cdbFile: path, env: {} });
			const targets = cdb.entries.map((entry) => entry.target).sort();
			expect(targets).toEqual(["192.0.2.50", "192.0.2.51"]);
		} finally {
			await cleanup();
		}
	});

	test("persists discovered neighbors into an encrypted CDB", async () => {
		const dir = await scratchCdbDir("centrs-discover-enc");
		const path = join(dir, "winbox.cdb");
		try {
			const open = encodeOpenWinBoxCdb([seedRecord("198.51.100.1")]);
			await writeFile(path, encryptWinBoxCdb(open, "centrs-test"));

			const envelope: DiscoverEnvelope = await discover({
				save: true,
				cdbFile: path,
				cdbPassword: "centrs-test",
				env: {},
				listen: fakeListen([
					neighbor("e4:8d:8c:11:22:33", { ipv4: "192.0.2.50" }),
				]),
			});

			expect(envelope.ok).toBe(true);
			if (!envelope.ok) {
				return;
			}

			const cdb = await loadCdb({
				cdbFile: path,
				cdbPassword: "centrs-test",
				env: {},
			});
			expect(cdb.encrypted).toBe(true);
			const targets = cdb.entries.map((entry) => entry.target).sort();
			expect(targets).toEqual(["192.0.2.50", "198.51.100.1"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
