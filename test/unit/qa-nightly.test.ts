import { describe, expect, test } from "bun:test";
import {
	FIXES_MAIN_LABEL,
	fingerprint,
	GATE_JOB,
	HEALTH_MAX_PAGES,
	HEALTH_PAGE_SIZE,
	type Job,
	mainHealth,
	mainHealthFromHistory,
	mustPassFailures,
	type NightlyRun,
	nightlyDecision,
	parseFingerprint,
	swept,
} from "../../scripts/qa-nightly.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const VERSIONS = {
	stable: "7.24.5",
	"long-term": "7.23.8",
	testing: "7.25rc1",
	development: "7.26beta1",
};

describe("nightlyDecision", () => {
	const previous = fingerprint(A, VERSIONS);

	test("nothing changed → skip", () => {
		const decision = nightlyDecision(
			{ sha: A, versions: { ...VERSIONS } },
			previous,
		);
		expect(decision.run).toBe(false);
	});

	test("main moved → sweep", () => {
		const decision = nightlyDecision({ sha: B, versions: VERSIONS }, previous);
		expect(decision.run).toBe(true);
		expect(decision.reason).toContain("main moved");
	});

	test("a channel version moved → sweep, naming it", () => {
		const decision = nightlyDecision(
			{ sha: A, versions: { ...VERSIONS, testing: "7.25rc2" } },
			previous,
		);
		expect(decision.run).toBe(true);
		expect(decision.reason).toContain("testing 7.25rc1 → 7.25rc2");
	});

	test("a channel appearing or disappearing → sweep", () => {
		const { development: _, ...three } = VERSIONS;
		expect(nightlyDecision({ sha: A, versions: three }, previous).run).toBe(
			true,
		);
	});

	test("unresolved versions or no previous fingerprint → sweep", () => {
		expect(nightlyDecision({ sha: A, versions: null }, previous).run).toBe(
			true,
		);
		expect(nightlyDecision({ sha: A, versions: VERSIONS }, null).run).toBe(
			true,
		);
	});
});

describe("fingerprint storage", () => {
	test("round-trips and is independent of key order", () => {
		const reversed = Object.fromEntries(Object.entries(VERSIONS).reverse());
		const stored = JSON.stringify(fingerprint(A, reversed));
		expect(stored).toBe(JSON.stringify(fingerprint(A, VERSIONS)));
		expect(parseFingerprint(stored)).toEqual(fingerprint(A, VERSIONS));
	});

	test("malformed content reads as absent", () => {
		expect(parseFingerprint("not json")).toBeNull();
		expect(parseFingerprint('{"sha":1,"versions":{}}')).toBeNull();
		expect(parseFingerprint('{"sha":"x","versions":{"stable":7}}')).toBeNull();
		expect(parseFingerprint('{"sha":"x","versions":{}}')).toBeNull();
		const odd = parseFingerprint(
			JSON.stringify({ sha: A, versions: { stable: "7.25\n::bad::7" } }),
		);
		expect(odd?.versions["stable"]).toBe("7.25bad7");
	});
});

const job = (name: string, conclusion: string | null): Job => ({
	name,
	status: "completed",
	conclusion,
});

const sweptJobs = (stable: string, longTerm = "success", dev = "success") => [
	job("Resolve active channels", "success"),
	job("CHR • stable", stable),
	job("CHR • long-term", longTerm),
	job("CHR • development", dev),
	job(
		GATE_JOB,
		stable === "success" && longTerm === "success" ? "success" : "failure",
	),
];

const skippedJobs = [
	job("Resolve active channels", "success"),
	job("CHR • matrix.routeros_channel", "skipped"),
	job(GATE_JOB, "skipped"),
];

const nightly = (
	id: number,
	jobs: Job[],
	conclusion: string | null = "success",
): NightlyRun => ({
	id,
	html_url: `https://github.com/tikoci/centrs/actions/runs/${id}`,
	head_sha: A,
	conclusion,
	jobs,
});

describe("swept / mustPassFailures", () => {
	test("a skipped nightly booted nothing", () => {
		expect(swept(skippedJobs)).toBe(false);
		expect(swept(sweptJobs("success"))).toBe(true);
	});

	test("only released legs count; a pre-release failure does not", () => {
		expect(
			mustPassFailures(sweptJobs("success", "success", "failure")),
		).toEqual([]);
		expect(mustPassFailures(sweptJobs("failure"))).toEqual(["stable"]);
		expect(mustPassFailures(sweptJobs("success", "timed_out"))).toEqual([
			"long-term",
		]);
	});

	test("any must-pass conclusion other than success blocks", () => {
		for (const conclusion of [
			"startup_failure",
			"action_required",
			"stale",
			"neutral",
			null,
		]) {
			expect(
				mustPassFailures(sweptJobs("success", conclusion as string)),
			).toEqual(["long-term"]);
		}
	});

	test("a missing must-pass leg or gate blocks", () => {
		const noLongTerm = sweptJobs("success").filter(
			(job) => job.name !== "CHR • long-term",
		);
		expect(mustPassFailures(noLongTerm)).toEqual(["long-term"]);
		const noGate = sweptJobs("success").filter((job) => job.name !== GATE_JOB);
		expect(mustPassFailures(noGate)).toEqual(["must-pass gate"]);
	});

	test("a failed gate with green legs still counts", () => {
		const jobs = [
			job("CHR • stable", "success"),
			job("CHR • long-term", "success"),
			job(GATE_JOB, "failure"),
		];
		expect(mustPassFailures(jobs)).toEqual(["must-pass gate"]);
	});
});

describe("mainHealth", () => {
	test("a green latest sweep is healthy", () => {
		expect(mainHealth([nightly(3, sweptJobs("success"))], []).ok).toBe(true);
	});

	test("a red latest sweep blocks, and names the run and channel", () => {
		const health = mainHealth([nightly(3, sweptJobs("failure"))], []);
		expect(health.ok).toBe(false);
		expect(health.message).toContain("actions/runs/3");
		expect(health.message).toContain("`stable`");
	});

	test("skipped and cancelled nightly runs are passed over", () => {
		const runs = [
			nightly(5, skippedJobs),
			nightly(4, sweptJobs("success"), "cancelled"),
			nightly(3, sweptJobs("failure"), "failure"),
		];
		expect(mainHealth(runs, []).ok).toBe(false);
		expect(
			mainHealth(
				[nightly(5, skippedJobs), nightly(3, sweptJobs("success"))],
				[],
			).ok,
		).toBe(true);
	});

	test(`the ${FIXES_MAIN_LABEL} label lets a repair through`, () => {
		const health = mainHealth(
			[nightly(3, sweptJobs("failure"))],
			[FIXES_MAIN_LABEL],
		);
		expect(health.ok).toBe(true);
		expect(health.message).toContain(FIXES_MAIN_LABEL);
	});

	test("no sweep yet is healthy", () => {
		expect(mainHealth([nightly(5, skippedJobs)], []).ok).toBe(true);
		expect(mainHealth([], []).ok).toBe(true);
	});
});

describe("mainHealthFromHistory", () => {
	/** Scheduled-run history, newest first, served in API-sized pages. */
	function history(runs: NightlyRun[]) {
		const jobs = new Map(runs.map((run) => [run.id, run.jobs]));
		return {
			listPage: async (page: number) =>
				runs
					.slice((page - 1) * HEALTH_PAGE_SIZE, page * HEALTH_PAGE_SIZE)
					.map(({ jobs: _, ...run }) => run),
			jobsFor: async (id: number) => jobs.get(id) ?? [],
		};
	}

	test("a red sweep behind more than a page of skipped nights still blocks", async () => {
		const skips = Array.from({ length: HEALTH_PAGE_SIZE + 5 }, (_, i) =>
			nightly(1000 - i, skippedJobs),
		);
		const { listPage, jobsFor } = history([
			...skips,
			nightly(3, sweptJobs("failure"), "failure"),
		]);
		const health = await mainHealthFromHistory(listPage, jobsFor, []);
		expect(health.ok).toBe(false);
		expect(health.message).toContain("actions/runs/3");
	});

	test("history that ends without a sweep is healthy", async () => {
		const { listPage, jobsFor } = history([nightly(5, skippedJobs)]);
		expect((await mainHealthFromHistory(listPage, jobsFor, [])).ok).toBe(true);
	});

	test("the page cap reached without a sweep is not healthy", async () => {
		const skips = Array.from(
			{ length: HEALTH_PAGE_SIZE * HEALTH_MAX_PAGES + 1 },
			(_, i) => nightly(10_000 - i, skippedJobs),
		);
		const { listPage, jobsFor } = history(skips);
		const health = await mainHealthFromHistory(listPage, jobsFor, []);
		expect(health.ok).toBe(false);
		expect(health.message).toContain("No nightly sweep");
		// The recovery it names must be one that clears it: a sweeping nightly.
		expect(health.message).toContain("nightly-fingerprint.json");
		expect(health.message).not.toContain("dispatch");
		expect(
			(await mainHealthFromHistory(listPage, jobsFor, [FIXES_MAIN_LABEL])).ok,
		).toBe(true);
	});

	test("after the recovery, the next nightly sweep decides", async () => {
		const skips = Array.from(
			{ length: HEALTH_PAGE_SIZE * HEALTH_MAX_PAGES + 1 },
			(_, i) => nightly(10_000 - i, skippedJobs),
		);
		const { listPage, jobsFor } = history([
			nightly(20_000, sweptJobs("success")),
			...skips,
		]);
		expect((await mainHealthFromHistory(listPage, jobsFor, [])).ok).toBe(true);
	});
});
