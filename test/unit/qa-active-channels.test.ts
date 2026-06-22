import { describe, expect, spyOn, test } from "bun:test";
import {
	activeMatrixSummary,
	type Channel,
	type ChannelStatus,
	isConcreteChannel,
	main,
	matrixChannels,
	type QuickChrVersionApi,
	resolveChannelPlan,
} from "../../scripts/qa-active-channels.ts";

// quickchr ships raw `.ts`; import it through a runtime specifier (as the script
// and chr.ts do) so its source stays out of this file's strict typecheck.
async function loadQuickChr(): Promise<{
	classifyChannels: QuickChrVersionApi["classifyChannels"];
	selectActiveChannels: QuickChrVersionApi["selectActiveChannels"];
}> {
	const moduleName = "@tikoci/quickchr";
	return (await import(moduleName)) as unknown as {
		classifyChannels: QuickChrVersionApi["classifyChannels"];
		selectActiveChannels: QuickChrVersionApi["selectActiveChannels"];
	};
}

describe("isConcreteChannel", () => {
	test("accepts the four RouterOS channels, rejects sentinels", () => {
		for (const channel of ["stable", "long-term", "testing", "development"]) {
			expect(isConcreteChannel(channel)).toBe(true);
		}
		expect(isConcreteChannel("all")).toBe(false);
		expect(isConcreteChannel("")).toBe(false);
		expect(isConcreteChannel("nightly")).toBe(false);
	});
});

describe("matrixChannels", () => {
	test("a concrete channel pins a single leg (active set ignored)", () => {
		expect(matrixChannels("testing", ["stable", "long-term"])).toEqual([
			"testing",
		]);
	});

	test('"all" / "" fan the active set with the must-pass floor merged in', () => {
		expect(
			matrixChannels("all", ["stable", "long-term", "development"]),
		).toEqual(["stable", "long-term", "development"]);
		expect(matrixChannels("", ["stable", "long-term"])).toEqual([
			"stable",
			"long-term",
		]);
	});

	test("a degraded active set can never drop the must-pass channels", () => {
		// Even if recency resolution returned only a pre-release leg, the released
		// floor (stable, long-term) is always booted so the gate has something to
		// evaluate.
		expect(matrixChannels("all", ["development"])).toEqual([
			"stable",
			"long-term",
			"development",
		]);
	});
});

describe("resolveChannelPlan", () => {
	const versions: Record<Channel, string> = {
		stable: "7.23.1",
		"long-term": "7.21.4",
		testing: "7.23rc4",
		development: "7.24beta2",
	};

	test("classifies and selects through an injected quickchr api", async () => {
		const api: QuickChrVersionApi = {
			resolveAllVersions: async () => versions,
			classifyChannels: () => [
				{
					channel: "stable",
					version: "7.23.1",
					maturity: "released",
					aheadOfStable: true,
				},
			],
			selectActiveChannels: () => ["stable", "long-term", "development"],
		};
		const plan = await resolveChannelPlan(async () => api);
		expect(plan?.active).toEqual(["stable", "long-term", "development"]);
		expect(plan?.statuses[0]?.channel).toBe("stable");
	});

	test("degrades to null (not a throw) when quickchr cannot resolve", async () => {
		const plan = await resolveChannelPlan(async () => {
			throw new Error("offline");
		});
		expect(plan).toBeNull();
	});
});

describe("recency contract via quickchr (pure, fixture-driven)", () => {
	const base = { stable: "7.23.1", "long-term": "7.21.4" } as const;

	test("excludes a testing build that sits behind stable", async () => {
		const { selectActiveChannels } = await loadQuickChr();
		const versions: Record<Channel, string> = {
			...base,
			testing: "7.23rc4", // 7.23rc4 < 7.23.1 → stale rc, not worth booting
			development: "7.24beta2", // ahead → worth booting
		};
		expect(matrixChannels("all", selectActiveChannels(versions))).toEqual([
			"stable",
			"long-term",
			"development",
		]);
	});

	test("includes a testing build once it leapfrogs stable", async () => {
		const { selectActiveChannels } = await loadQuickChr();
		const versions: Record<Channel, string> = {
			...base,
			testing: "7.24rc1", // 7.24rc1 > 7.23.1 → now worth booting
			development: "7.24beta2",
		};
		expect(matrixChannels("all", selectActiveChannels(versions))).toEqual([
			"stable",
			"long-term",
			"testing",
			"development",
		]);
	});
});

describe("main — explicit version pins a single leg (no network)", () => {
	async function emittedChannels(args: string[]): Promise<string[]> {
		const logged: string[] = [];
		const spy = spyOn(console, "log").mockImplementation((m: unknown) => {
			logged.push(String(m));
		});
		try {
			const code = await main(args);
			expect(code).toBe(0);
		} finally {
			spy.mockRestore();
		}
		return JSON.parse(logged.at(-1) ?? "[]");
	}

	test('version + "all" pins one stable-labelled leg', async () => {
		expect(
			await emittedChannels([
				"--requested-channel",
				"all",
				"--requested-version",
				"7.25.0",
			]),
		).toEqual(["stable"]);
	});

	test("version keeps a concrete channel's label", async () => {
		expect(
			await emittedChannels([
				"--requested-channel",
				"testing",
				"--requested-version",
				"7.25.0",
			]),
		).toEqual(["testing"]);
	});
});

describe("activeMatrixSummary", () => {
	const statuses: ChannelStatus[] = [
		{
			channel: "stable",
			version: "7.23.1",
			maturity: "released",
			aheadOfStable: true,
		},
		{
			channel: "long-term",
			version: "7.21.4",
			maturity: "released",
			aheadOfStable: false,
		},
		{
			channel: "testing",
			version: "7.23rc4",
			maturity: "prerelease",
			aheadOfStable: false,
		},
		{
			channel: "development",
			version: "7.24beta2",
			maturity: "prerelease",
			aheadOfStable: true,
		},
	];

	test("marks booted channels and renders every channel's recency", () => {
		const summary = activeMatrixSummary(
			statuses,
			["stable", "long-term", "development"],
			false,
		);
		expect(summary).toContain("| testing | 7.23rc4 | prerelease | no | — |");
		expect(summary).toContain(
			"| development | 7.24beta2 | prerelease | yes | ✅ |",
		);
		expect(summary).not.toContain("could not be resolved");
	});

	test("notes the fallback when recency could not be resolved", () => {
		const summary = activeMatrixSummary([], ["stable", "long-term"], true);
		expect(summary).toContain("could not be resolved");
		expect(summary).toContain("`stable`, `long-term`");
	});
});
