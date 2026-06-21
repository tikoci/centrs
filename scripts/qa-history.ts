/**
 * QA history accumulator + must-pass gate (the cross-run half of JG-18).
 *
 * Per-leg `qa.yaml` matrix runs each record one CHR run to their own
 * `qa-results.sqlite` artifact (see `qa-results-db.ts`). This script runs once
 * after the matrix, in the `accumulate-and-gate` job:
 *
 *   1. Read every downloaded per-leg DB (`--legs <dir>`) → the current run's set.
 *   2. Append those rows to the accumulating `--history` JSONL (the file that
 *      lives on the durable `qa-history` branch — artifact retention is finite,
 *      and the channel→version drift is exactly what we want long history of).
 *   3. Evaluate the must-pass gate (`evaluateMustPassGate`): a `fail` on a
 *      released channel (stable, long-term) exits non-zero and reds the merge;
 *      beta/test channels are recorded but never gate.
 *
 * The history file is written before the gate verdict, so the caller's
 * `if: always()` commit step persists the run even when the gate fails — a
 * failure must still land in history.
 *
 * CLI (used by `.github/workflows/qa.yaml`):
 *   bun run scripts/qa-history.ts --legs ./incoming \
 *     --history ./qa-history/qa-runs.jsonl [--summary "$GITHUB_STEP_SUMMARY"]
 */

import { Database } from "bun:sqlite";
import { Glob } from "bun";
import {
	allRuns,
	channelPolicy,
	channelStatuses,
	evaluateMustPassGate,
	parseHistoryJsonl,
	type QaRunRow,
	rebuildHistoryDb,
	serializeRun,
} from "./qa-results-db.ts";

/** Collect every run row from the per-leg DBs under `legsDir`. */
async function collectLegRuns(legsDir: string): Promise<QaRunRow[]> {
	const runs: QaRunRow[] = [];
	const glob = new Glob("**/qa-results.sqlite");
	for await (const rel of glob.scan({ cwd: legsDir, onlyFiles: true })) {
		const path = `${legsDir}/${rel}`;
		let db: Database | undefined;
		try {
			db = new Database(path, { readonly: true });
			runs.push(...allRuns(db));
		} catch (error) {
			console.error(
				`::warning title=QA history::skipped ${path}: ${String(error)}`,
			);
		} finally {
			db?.close();
		}
	}
	return runs;
}

function gateSummaryMarkdown(
	currentRuns: QaRunRow[],
	historyDb: Database,
	gateOk: boolean,
	failures: readonly { channel: string }[],
): string {
	const lines: string[] = ["## QA accumulation + must-pass gate", ""];
	lines.push(gateOk ? "✅ **Gate passed**" : "❌ **Gate failed**");
	if (failures.length > 0) {
		lines.push(
			"",
			`Released (must-pass) channels that failed: ${failures
				.map((f) => `\`${f.channel}\``)
				.join(", ")}`,
		);
	}
	lines.push("", "### This run", "");
	if (currentRuns.length === 0) {
		lines.push("_No per-leg results were found._");
	} else {
		lines.push(
			"| Channel | Version | Outcome | Policy |",
			"| --- | --- | --- | --- |",
		);
		for (const run of currentRuns) {
			const mark = run.outcome === "pass" ? "✅ pass" : "❌ fail";
			lines.push(
				`| ${run.channel} | ${run.resolved_version ?? "?"} | ${mark} | ${channelPolicy(run.channel)} |`,
			);
		}
	}
	lines.push("", "### History (latest per channel)", "");
	const statuses = channelStatuses(historyDb);
	if (statuses.length === 0) {
		lines.push("_History is empty._");
	} else {
		lines.push(
			"| Channel | Latest version | Latest | Runs | Policy |",
			"| --- | --- | --- | --- | --- |",
		);
		for (const status of statuses) {
			lines.push(
				`| ${status.channel} | ${status.latestResolvedVersion ?? "?"} | ${status.latestOutcome ?? "?"} | ${status.runs} | ${channelPolicy(status.channel)} |`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

function flag(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

export async function main(args: readonly string[]): Promise<number> {
	const legsDir = flag(args, "--legs");
	const historyPath = flag(args, "--history");
	if (!legsDir || !historyPath) {
		console.error(
			"usage: qa-history.ts --legs DIR --history JSONL [--summary FILE]",
		);
		return 2;
	}

	const currentRuns = await collectLegRuns(legsDir);
	if (currentRuns.length === 0) {
		console.error("::warning title=QA history::no per-leg results found");
	}

	// Gate over THIS run only (the durable history is for drift, not gating, so a
	// stale historical fail never reds a fresh clean run). A QaRunRow is a
	// QaRunRecord plus an id, so the leg rows feed rebuildHistoryDb directly.
	const currentDb = rebuildHistoryDb(currentRuns);
	const gate = evaluateMustPassGate(channelStatuses(currentDb));

	// Append this run to the accumulating history (written before the verdict so
	// an `if: always()` commit persists even a failing run).
	const existing = (await Bun.file(historyPath).exists())
		? await Bun.file(historyPath).text()
		: "";
	const appended = currentRuns.map(serializeRun).join("\n");
	const prefix =
		existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
	const next = appended ? `${prefix}${appended}\n` : prefix;
	await Bun.write(historyPath, next);

	const historyDb = rebuildHistoryDb(parseHistoryJsonl(next));
	const summary = gateSummaryMarkdown(
		currentRuns,
		historyDb,
		gate.ok,
		gate.failures,
	);
	const summaryPath = flag(args, "--summary");
	if (summaryPath) {
		await Bun.write(summaryPath, summary);
	}
	console.log(summary);

	if (!gate.ok) {
		console.error(
			`::error title=QA must-pass gate::released channels failed: ${gate.failures
				.map((f) => f.channel)
				.join(", ")}`,
		);
	}
	currentDb.close();
	historyDb.close();
	return gate.ok ? 0 : 1;
}

if (import.meta.main) {
	try {
		process.exit(await main(Bun.argv.slice(2)));
	} catch (error) {
		console.error(`::error title=QA history::${String(error)}`);
		process.exit(1);
	}
}
