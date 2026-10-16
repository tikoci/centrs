import { describe, expect, test } from "bun:test";
import {
	changelogSection,
	nextBaseVersion,
	nextVersion,
	planRelease,
	qaVerdict,
	type WorkflowRun,
} from "../../scripts/release-plan.ts";

const SHA = "a".repeat(40);

function run(overrides: Partial<WorkflowRun>): WorkflowRun {
	return {
		event: "push",
		status: "completed",
		conclusion: "success",
		head_sha: SHA,
		...overrides,
	};
}

const CHANGELOG = `# Changelog

## 0.1.10 — next

### Fixed

- in progress

## 0.1.9 — 2026-10-20

### Added

- shipped

## 0.1.8 — 2026-10-12
`;

describe("next versions (#484)", () => {
	test("a -next package version heads to its own base", () => {
		expect(nextBaseVersion("0.1.9-next")).toBe("0.1.9");
		expect(nextBaseVersion("0.1.9-next.0")).toBe("0.1.9");
	});

	test("a plain package version has been cut, so next heads to the patch after it", () => {
		expect(nextBaseVersion("0.1.9")).toBe("0.1.10");
	});

	test("the run number is the pre-release counter", () => {
		expect(nextVersion("0.1.9-next", 23)).toBe("0.1.9-next.23");
	});

	test("SemVer orders a next cut below its stable and above earlier cuts", () => {
		expect(Bun.semver.order("0.1.9-next.23", "0.1.9")).toBe(-1);
		expect(Bun.semver.order("0.1.9-next.23", "0.1.9-next.0")).toBe(1);
		expect(Bun.semver.order("0.1.9-next.23", "0.1.9-next")).toBe(1);
	});
});

describe("changelogSection (#485)", () => {
	test("finds the in-progress section", () => {
		expect(changelogSection(CHANGELOG, "0.1.10")).toEqual({
			version: "0.1.10",
			label: "next",
			body: "### Fixed\n\n- in progress",
		});
	});

	test("finds a dated section and stops at the next heading", () => {
		expect(changelogSection(CHANGELOG, "0.1.9")).toEqual({
			version: "0.1.9",
			label: "2026-10-20",
			body: "### Added\n\n- shipped",
		});
	});

	test("an empty last section has an empty body; an absent one is null", () => {
		expect(changelogSection(CHANGELOG, "0.1.8")?.body).toBe("");
		expect(changelogSection(CHANGELOG, "0.1.7")).toBeNull();
	});

	test("does not read a -next.N heading as its base version", () => {
		expect(
			changelogSection("## 0.1.9-next.0 — 2026-10-13\n\n- x\n", "0.1.9"),
		).toBeNull();
	});
});

describe("qaVerdict (#484)", () => {
	test("a green run on the commit is reused", () => {
		expect(qaVerdict([run({})], SHA).action).toBe("reuse");
	});

	test("a green scheduled run counts, and wins over a cancelled push run", () => {
		const runs = [run({ conclusion: "cancelled" }), run({ event: "schedule" })];
		expect(qaVerdict(runs, SHA).action).toBe("reuse");
	});

	test("a run still in progress is waited for", () => {
		const runs = [run({ status: "in_progress", conclusion: null })];
		expect(qaVerdict(runs, SHA).action).toBe("wait");
	});

	test("only cancelled runs, or none, means the release sweeps itself", () => {
		expect(qaVerdict([run({ conclusion: "cancelled" })], SHA).action).toBe(
			"sweep",
		);
		expect(qaVerdict([], SHA).action).toBe("sweep");
	});

	test("a failed run refuses and names its conclusion", () => {
		const verdict = qaVerdict([run({ conclusion: "timed_out" })], SHA);
		expect(verdict.action).toBe("refuse");
		expect(verdict.message).toContain("timed_out");
	});

	test("a conclusion GitHub does not document is not echoed", () => {
		const verdict = qaVerdict([run({ conclusion: "x\n::error::y" })], SHA);
		expect(verdict.action).toBe("refuse");
		expect(verdict.message).toContain("unknown");
		expect(verdict.message).not.toContain("::error::");
	});

	test("dispatch runs and other commits do not count", () => {
		const runs = [
			run({ event: "workflow_dispatch" }),
			run({ head_sha: "b".repeat(40) }),
		];
		expect(qaVerdict(runs, SHA).action).toBe("sweep");
	});
});

describe("planRelease (#484)", () => {
	const npm = { versions: ["0.1.8", "0.1.9-next.0"], latest: "0.1.8" };
	const base = {
		packageVersion: "0.1.9-next",
		runNumber: 23,
		npm,
		changelog: CHANGELOG,
		tagExists: false,
	};

	test("next publishes the run-numbered version to the next tag", () => {
		expect(planRelease({ ...base, channel: "next" })).toEqual({
			channel: "next",
			version: "0.1.9-next.23",
			npmTag: "next",
			base: "0.1.9",
		});
	});

	test("next refuses a version that would sort below latest", () => {
		const result = planRelease({
			...base,
			channel: "next",
			npm: { versions: ["0.1.9"], latest: "0.1.9" },
		});
		expect(result).toBeInstanceOf(Error);
	});

	test("next after a stable cut heads to the following patch", () => {
		const result = planRelease({
			...base,
			channel: "next",
			packageVersion: "0.1.9",
			npm: { versions: ["0.1.9"], latest: "0.1.9" },
		});
		expect(result).toMatchObject({ version: "0.1.10-next.23", base: "0.1.10" });
	});

	test("latest publishes a committed plain version with a dated section", () => {
		expect(
			planRelease({ ...base, channel: "latest", packageVersion: "0.1.9" }),
		).toEqual({
			channel: "latest",
			version: "0.1.9",
			npmTag: "latest",
			base: "0.1.9",
		});
	});

	test("latest refuses a version that would move npm's latest backwards", () => {
		const result = planRelease({
			...base,
			channel: "latest",
			packageVersion: "0.1.9",
			npm: { versions: ["0.1.10"], latest: "0.1.10" },
			changelog: CHANGELOG,
		});
		expect(result).toBeInstanceOf(Error);
	});

	test("latest refuses a -next version, an undated section, a published version or an existing tag", () => {
		const refusals = [
			{ packageVersion: "0.1.9-next" },
			{ packageVersion: "0.1.10" },
			{ packageVersion: "0.1.8" },
			{ packageVersion: "0.1.9", tagExists: true },
			{ packageVersion: "0.1.7" },
		];
		for (const overrides of refusals) {
			expect(
				planRelease({ ...base, channel: "latest", ...overrides }),
			).toBeInstanceOf(Error);
		}
	});
});
