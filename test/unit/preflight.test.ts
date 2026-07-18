import { describe, expect, test } from "bun:test";
import {
	assertCapability,
	type CapabilityRequirement,
	CentrsError,
	checkCapability,
	compareRouterOsVersion,
	parseRouterOsVersion,
	probeDeviceVersion,
	renderSupportedRanges,
	routerOsVersionAtLeast,
	versionFactFromComment,
	versionInRange,
} from "../../src/index.ts";
import type {
	ProtocolAdapter,
	ProtocolExecuteRequest,
	ProtocolExecuteResult,
} from "../../src/protocols/adapter.ts";

describe("parseRouterOsVersion", () => {
	test("parses major.minor[.patch] with beta/rc suffixes", () => {
		expect(parseRouterOsVersion("7.23")).toEqual({
			major: 7,
			minor: 23,
			patch: 0,
			stageRank: 2,
			stageIteration: 0,
		});
		expect(parseRouterOsVersion("7.21.4")).toMatchObject({
			major: 7,
			minor: 21,
			patch: 4,
		});
		expect(parseRouterOsVersion("7.23beta2")).toMatchObject({
			stageRank: 0,
			stageIteration: 2,
		});
		expect(parseRouterOsVersion("7.23rc1")).toMatchObject({
			stageRank: 1,
			stageIteration: 1,
		});
	});

	test("tolerates trailing channel/date noise from /system/resource", () => {
		expect(
			parseRouterOsVersion("7.21.4 (long-term) 2026-04-21 06:49:05"),
		).toMatchObject({ major: 7, minor: 21, patch: 4 });
	});

	test("returns undefined for versionless strings", () => {
		expect(parseRouterOsVersion("garbage")).toBeUndefined();
		expect(parseRouterOsVersion("")).toBeUndefined();
	});
});

describe("compareRouterOsVersion", () => {
	test("orders beta < rc < release < patch release", () => {
		const ascending = [
			"7.23beta1",
			"7.23beta2",
			"7.23rc1",
			"7.23",
			"7.23.1",
			"7.24beta1",
		];
		for (let i = 1; i < ascending.length; i += 1) {
			const lower = ascending[i - 1] as string;
			const higher = ascending[i] as string;
			expect(compareRouterOsVersion(lower, higher)).toBeLessThan(0);
			expect(compareRouterOsVersion(higher, lower)).toBeGreaterThan(0);
		}
		expect(compareRouterOsVersion("7.23", "7.23")).toBe(0);
	});

	test("unparseable sorts below parseable and equal to unparseable", () => {
		expect(compareRouterOsVersion("garbage", "7.0")).toBeLessThan(0);
		expect(compareRouterOsVersion("7.0", "garbage")).toBeGreaterThan(0);
		expect(compareRouterOsVersion("garbage", "junk")).toBe(0);
	});
});

describe("routerOsVersionAtLeast", () => {
	test("matches the promoted integration-harness semantics", () => {
		expect(routerOsVersionAtLeast("7.23", "7.21")).toBe(true);
		expect(routerOsVersionAtLeast("7.21.4", "7.23")).toBe(false);
		expect(routerOsVersionAtLeast("7.23.1 (stable)", "7.23beta2")).toBe(true);
		expect(routerOsVersionAtLeast("7.23beta1", "7.23beta2")).toBe(false);
		expect(routerOsVersionAtLeast("garbage", "7.0")).toBe(false);
	});
});

// A backported capability: present in a late 7.21.x, absent across 7.22.0/1,
// present again from 7.22.2. The window data here is illustrative for the
// range mechanics — real requirements pin their own grounded windows.
const backported: CapabilityRequirement = {
	capability: "example-backported",
	summary: "run the example operation",
	supported: [{ min: "7.21.4", maxExclusive: "7.22" }, { min: "7.22.2" }],
};

describe("versionInRange", () => {
	test("inclusive min, exclusive max", () => {
		const window = { min: "7.21.4", maxExclusive: "7.22" };
		expect(versionInRange("7.21.4", window)).toBe(true);
		expect(versionInRange("7.21.5", window)).toBe(true);
		expect(versionInRange("7.21.3", window)).toBe(false);
		expect(versionInRange("7.22", window)).toBe(false);
		// Prereleases sort below their release, so `7.22beta1` is still inside a
		// `maxExclusive: "7.22"` window. This is intentional: a `.x` backport bound
		// is expressed at release granularity. A consumer whose capability differs
		// across the 7.22 prerelease line must set an explicit prerelease bound
		// (e.g. `maxExclusive: "7.22beta1"`) at its definition site.
		expect(versionInRange("7.22beta1", window)).toBe(true);
		expect(
			versionInRange("7.22beta1", { min: "7.21.4", maxExclusive: "7.22beta1" }),
		).toBe(false);
	});

	test("open-ended range has no upper bound", () => {
		expect(versionInRange("8.1", { min: "7.22.2" })).toBe(true);
		expect(versionInRange("7.22.1", { min: "7.22.2" })).toBe(false);
	});

	test("a malformed range throws instead of failing open", () => {
		// An unparseable min would otherwise sort below every real version and mark
		// everything supported — a silent, dangerous fail-open. It is a definition
		// bug in the CapabilityRequirement, so it must be loud.
		expect(() => versionInRange("7.23", { min: "not-a-version" })).toThrow(
			/Invalid capability range min/,
		);
		expect(() =>
			versionInRange("7.23", { min: "7.21.4", maxExclusive: "oops" }),
		).toThrow(/Invalid capability range maxExclusive/);
		expect(() =>
			versionInRange("7.23", { min: "7.22", maxExclusive: "7.21" }),
		).toThrow(/Invalid capability range maxExclusive/);
	});
});

describe("checkCapability", () => {
	test("supported inside any window", () => {
		for (const version of ["7.21.4", "7.21.5", "7.22.2", "7.23.1"]) {
			expect(
				checkCapability(backported, { version, source: "live" }).state,
			).toBe("supported");
		}
	});

	test("unsupported between and below the windows", () => {
		for (const version of ["7.20.8", "7.21.3", "7.22", "7.22.1"]) {
			expect(
				checkCapability(backported, { version, source: "live" }).state,
			).toBe("unsupported");
		}
	});

	test("unknown when the version is missing or unparseable", () => {
		expect(checkCapability(backported).state).toBe("unknown");
		expect(
			checkCapability(backported, { version: "???", source: "cdb-fact" }).state,
		).toBe("unknown");
	});
});

describe("assertCapability", () => {
	test("passes through supported and unknown verdicts", () => {
		expect(
			assertCapability(backported, { version: "7.23", source: "live" }).state,
		).toBe("supported");
		expect(assertCapability(backported).state).toBe("unknown");
	});

	test("throws routeros/version-unsupported with actionable context", () => {
		let caught: CentrsError | undefined;
		try {
			assertCapability(backported, { version: "7.22.1", source: "live" });
		} catch (error) {
			caught = error as CentrsError;
		}
		expect(caught).toBeInstanceOf(CentrsError);
		expect(caught?.code).toBe("routeros/version-unsupported");
		expect(caught?.summary).toContain("7.22.1");
		expect(caught?.summary).toContain("run the example operation");
		expect(caught?.context).toMatchObject({
			capability: "example-backported",
			version: "7.22.1",
			versionSource: "live",
		});
	});

	test("a stale cdb-fact version gets refresh guidance", () => {
		let caught: CentrsError | undefined;
		try {
			assertCapability(backported, { version: "7.20", source: "cdb-fact" });
		} catch (error) {
			caught = error as CentrsError;
		}
		expect(caught?.remediation).toContain("stale");
	});
});

describe("renderSupportedRanges", () => {
	test("renders backport windows and open-ended ranges", () => {
		expect(renderSupportedRanges(backported.supported)).toBe(
			"7.21.4–7.22 (excl.), 7.22.2+",
		);
	});
});

describe("versionFactFromComment", () => {
	test("reads the version= comment fact with cdb-fact provenance", () => {
		expect(
			versionFactFromComment("source=mndp version=7.23.1 board=RB5009"),
		).toEqual({ version: "7.23.1", source: "cdb-fact" });
	});

	test("ignores missing or malformed version facts", () => {
		expect(versionFactFromComment("identity=lab")).toBeUndefined();
		expect(versionFactFromComment("version=latest")).toBeUndefined();
	});
});

function stubAdapter(overrides: Partial<ProtocolAdapter>): ProtocolAdapter {
	const reject = () => Promise.reject(new Error("not stubbed"));
	return {
		protocol: "rest-api",
		capabilities: { retrieve: true, execute: true, inspect: true },
		inspect: reject,
		getSingleton: reject,
		list: reject,
		execute: reject,
		apiRequest: reject,
		// biome-ignore lint/correctness/useYield: a reject-only async generator yields nothing.
		listen: async function* () {
			throw new Error("not stubbed");
		},
		close: () => Promise.resolve(),
		...overrides,
	};
}

describe("probeDeviceVersion", () => {
	test("reads /system/resource on retrieve-capable transports", async () => {
		const adapter = stubAdapter({
			getSingleton: (path: string) => {
				expect(path).toBe("/system/resource");
				return Promise.resolve({ version: "7.21.4 (long-term)" });
			},
		});
		expect(await probeDeviceVersion(adapter)).toEqual({
			version: "7.21.4 (long-term)",
			source: "live",
		});
	});

	test("falls back to a console :put on execute-only transports", async () => {
		const adapter = stubAdapter({
			capabilities: { retrieve: false, execute: true, inspect: false },
			execute: (request: ProtocolExecuteRequest) => {
				expect(request.script).toBe(":put [/system/resource/ get version]");
				return Promise.resolve<ProtocolExecuteResult>({
					records: [],
					ret: "7.16.2\n",
				});
			},
		});
		expect(await probeDeviceVersion(adapter)).toEqual({
			version: "7.16.2",
			source: "live",
		});
	});

	test("returns undefined when the reply carries no parseable version", async () => {
		const adapter = stubAdapter({
			getSingleton: () => Promise.resolve({ uptime: "1d" }),
		});
		expect(await probeDeviceVersion(adapter)).toBeUndefined();
	});
});
