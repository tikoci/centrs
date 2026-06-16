import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	effectiveHostCandidate,
	isIpTransport,
	isMacAddress,
	normalizeMac,
	parseArpTable,
	parseResolvePolicy,
	resolveMacTarget,
	resolveMacViaArp,
} from "../../src/resolver/mac.ts";

describe("MAC recognition and normalization", () => {
	test("recognizes colon- and dash-separated MACs", () => {
		expect(isMacAddress("96:5D:80:7D:BF:59")).toBe(true);
		expect(isMacAddress("96-5d-80-7d-bf-59")).toBe(true);
		expect(isMacAddress("8a:6:1c:a:2:1f")).toBe(true); // macOS unpadded
	});

	test("rejects non-MAC strings", () => {
		expect(isMacAddress("192.168.74.1")).toBe(false);
		expect(isMacAddress("bigdude")).toBe(false);
		expect(isMacAddress("96:5D:80:7D:BF")).toBe(false); // 5 octets
		expect(isMacAddress("http://host")).toBe(false);
	});

	test("normalizes to lower-case, zero-padded octets", () => {
		expect(normalizeMac("8A:6:1C:A:2:1F")).toBe("8a:06:1c:0a:02:1f");
		expect(normalizeMac("96-5D-80-7D-BF-59")).toBe("96:5d:80:7d:bf:59");
		expect(normalizeMac("not-a-mac")).toBeUndefined();
	});
});

describe("isIpTransport", () => {
	test("true for IP-based transports", () => {
		for (const via of ["rest-api", "native-api", "ssh", "snmp"]) {
			expect(isIpTransport(via)).toBe(true);
		}
	});

	test("false for L2/identity transports", () => {
		for (const via of ["mac-telnet", "romon", "mndp", "winbox-terminal"]) {
			expect(isIpTransport(via)).toBe(false);
		}
	});
});

describe("parseArpTable", () => {
	test("parses macOS `arp -an` output and normalizes MACs", () => {
		const output = [
			"? (192.168.74.1) at 96:5d:80:7d:bf:59 on en0 ifscope [ethernet]",
			"? (192.168.74.9) at 8a:6:1c:a:2:1f on en0 ifscope [ethernet]",
			"? (192.168.74.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]",
		].join("\n");
		expect(parseArpTable(output)).toEqual([
			{ ip: "192.168.74.1", mac: "96:5d:80:7d:bf:59" },
			{ ip: "192.168.74.9", mac: "8a:06:1c:0a:02:1f" },
			{ ip: "192.168.74.255", mac: "ff:ff:ff:ff:ff:ff" },
		]);
	});

	test("skips incomplete entries", () => {
		const output = "? (192.168.74.2) at (incomplete) on en0 ifscope";
		expect(parseArpTable(output)).toEqual([]);
	});
});

describe("resolveMacViaArp", () => {
	const table =
		"? (192.168.74.1) at 96:5d:80:7d:bf:59 on en0 ifscope [ethernet]";

	test("returns the IP for a known MAC (padding-insensitive)", async () => {
		const ip = await resolveMacViaArp("96:5D:80:7D:BF:59", async () => table);
		expect(ip).toBe("192.168.74.1");
	});

	test("returns undefined for an unknown MAC", async () => {
		const ip = await resolveMacViaArp("aa:bb:cc:dd:ee:ff", async () => table);
		expect(ip).toBeUndefined();
	});

	test("returns undefined when the arp spawn fails", async () => {
		const ip = await resolveMacViaArp("96:5d:80:7d:bf:59", async () => {
			throw new Error("spawn failed");
		});
		expect(ip).toBeUndefined();
	});
});

describe("parseResolvePolicy", () => {
	test("defaults to none", () => {
		expect(parseResolvePolicy(undefined)).toBe("none");
		expect(parseResolvePolicy("")).toBe("none");
	});

	test("accepts none and arp case-insensitively", () => {
		expect(parseResolvePolicy("ARP")).toBe("arp");
		expect(parseResolvePolicy("None")).toBe("none");
	});

	test("rejects unknown values with an actionable error", () => {
		expect(() => parseResolvePolicy("dns")).toThrow(CentrsError);
		try {
			parseResolvePolicy("dns");
		} catch (error) {
			expect((error as CentrsError).code).toBe("validation/option");
		}
	});
});

describe("effectiveHostCandidate", () => {
	test("uses explicit host over everything", () => {
		expect(
			effectiveHostCandidate({
				host: "10.0.0.1",
				targetInput: "mac",
				cdbTarget: "10.9.9.9",
				env: { CENTRS_HOST: "10.8.8.8" },
			}),
		).toBe("10.0.0.1");
	});

	test("falls back env > cdb > positional", () => {
		expect(
			effectiveHostCandidate({
				targetInput: "positional",
				cdbTarget: "cdb-host",
				env: { CENTRS_HOST: "env-host" },
			}),
		).toBe("env-host");
		expect(
			effectiveHostCandidate({
				targetInput: "positional",
				cdbTarget: "cdb-host",
				env: {},
			}),
		).toBe("cdb-host");
		expect(effectiveHostCandidate({ targetInput: "positional", env: {} })).toBe(
			"positional",
		);
	});
});

describe("resolveMacTarget", () => {
	const arp = async () =>
		"? (192.168.74.1) at 96:5d:80:7d:bf:59 on en0 ifscope [ethernet]";

	test("returns undefined when the target is not a MAC", async () => {
		const result = await resolveMacTarget({
			targetInput: "192.168.74.1",
			env: {},
			policy: "arp",
			operation: "retrieve",
			runArp: arp,
		});
		expect(result).toBeUndefined();
	});

	test("throws target/mac-unresolved when ARP is not opted into", async () => {
		try {
			await resolveMacTarget({
				targetInput: "96:5D:80:7D:BF:59",
				env: {},
				policy: "none",
				operation: "retrieve",
				runArp: arp,
			});
			throw new Error("expected throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("target/mac-unresolved");
		}
	});

	test("resolves a MAC to an IP via ARP when opted in", async () => {
		const result = await resolveMacTarget({
			targetInput: "96:5D:80:7D:BF:59",
			env: {},
			policy: "arp",
			operation: "retrieve",
			runArp: arp,
		});
		expect(result).toEqual({ mac: "96:5d:80:7d:bf:59", ip: "192.168.74.1" });
	});

	test("throws target/mac-not-in-arp when ARP has no entry", async () => {
		try {
			await resolveMacTarget({
				targetInput: "aa:bb:cc:dd:ee:ff",
				env: {},
				policy: "arp",
				operation: "execute",
				runArp: arp,
			});
			throw new Error("expected throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("target/mac-not-in-arp");
		}
	});

	test("terminal operation leads its remediation with the L2 alternative", async () => {
		// JG-01: a MAC over `--via ssh` should point at `--via mac-telnet` first,
		// since L2 needs no IP — both the no-opt-in and ARP-miss branches.
		const unresolved = await resolveMacTarget({
			targetInput: "aa:bb:cc:dd:ee:ff",
			env: {},
			policy: "none",
			operation: "terminal",
			runArp: arp,
		}).catch((caught: unknown) => caught);
		expect((unresolved as CentrsError).code).toBe("target/mac-unresolved");
		expect((unresolved as CentrsError).remediation).toContain(
			"--via mac-telnet",
		);

		const notInArp = await resolveMacTarget({
			targetInput: "aa:bb:cc:dd:ee:ff",
			env: {},
			policy: "arp",
			operation: "terminal",
			runArp: arp,
		}).catch((caught: unknown) => caught);
		expect((notInArp as CentrsError).code).toBe("target/mac-not-in-arp");
		expect((notInArp as CentrsError).remediation).toContain("--via mac-telnet");
	});
});
