import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../scripts/qa-history.ts";
import {
	openQaResultsDb,
	type QaRunInput,
	recordQaRun,
} from "../../scripts/qa-results-db.ts";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "qa-history-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** Write a per-leg `qa-results.sqlite` under `incoming/qa-results-<channel>/`. */
async function writeLeg(channel: string, run: Omit<QaRunInput, "channel">) {
	const dir = join(root, "incoming", `qa-results-${channel}`);
	await mkdir(dir, { recursive: true });
	const db = openQaResultsDb(join(dir, "qa-results.sqlite"));
	recordQaRun(db, { channel, ...run });
	db.close();
}

function args(extra: string[] = []) {
	return [
		"--legs",
		join(root, "incoming"),
		"--history",
		join(root, "qa-history", "qa-runs.jsonl"),
		...extra,
	];
}

async function historyLines(): Promise<string[]> {
	const text = await readFile(
		join(root, "qa-history", "qa-runs.jsonl"),
		"utf8",
	);
	return text.split("\n").filter((l) => l.trim().length > 0);
}

describe("qa-history main", () => {
	test("passes the gate and accumulates every leg when released channels are green", async () => {
		await writeLeg("stable", { outcome: "pass", resolvedVersion: "7.23.1" });
		await writeLeg("long-term", { outcome: "pass", resolvedVersion: "7.21.4" });
		await writeLeg("development", {
			outcome: "fail",
			resolvedVersion: "7.24b",
		});

		const code = await main(args());
		expect(code).toBe(0); // dev fail is best-effort
		expect(await historyLines()).toHaveLength(3);
	});

	test("fails the gate on a released-channel regression but still records it", async () => {
		await writeLeg("stable", { outcome: "pass", resolvedVersion: "7.23.1" });
		await writeLeg("long-term", { outcome: "fail", resolvedVersion: "7.21.4" });

		const code = await main(args());
		expect(code).toBe(1);
		// History must capture the failing run (commit step is `if: always()`).
		expect(await historyLines()).toHaveLength(2);
	});

	test("accumulates across runs and writes a summary", async () => {
		await writeLeg("stable", { outcome: "pass", resolvedVersion: "7.23.0" });
		const summaryPath = join(root, "summary.md");
		expect(await main(args(["--summary", summaryPath]))).toBe(0);
		expect(await historyLines()).toHaveLength(1);

		// A second run (fresh runner => fresh leg dir) appends rather than
		// overwriting the accumulated history.
		await rm(join(root, "incoming"), { recursive: true, force: true });
		await writeLeg("stable", { outcome: "pass", resolvedVersion: "7.23.1" });
		expect(await main(args())).toBe(0);
		expect(await historyLines()).toHaveLength(2);

		const summary = await readFile(summaryPath, "utf8");
		expect(summary).toContain("must-pass gate");
		expect(summary).toContain("Gate passed");
	});

	test("an empty leg directory passes (no must-pass failure) and warns", async () => {
		await mkdir(join(root, "incoming"), { recursive: true });
		const code = await main(args());
		expect(code).toBe(0);
		expect(await historyLines()).toHaveLength(0);
	});
});
