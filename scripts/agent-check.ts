/**
 * Dense `bun test` summary for agents.
 *
 * Bare `bun test --coverage` prints one line per test plus a per-file coverage
 * table — readable for a human scrolling a terminal, expensive for an agent to
 * parse (it ends up grepping the raw log by hand). `ci.yaml`'s "Unit tests &
 * coverage" job already solves this for the GitHub step summary by grepping
 * `(fail)` lines and the coverage table (see .github/workflows/ci.yaml). This
 * script applies the same extraction locally, so an agent gets the same dense
 * signal `bun run` returns directly, without re-deriving the grep/awk each time.
 *
 * Default output: pass/skip/fail counts, failing test lines (if any), and the
 * aggregate `All files` coverage row. `--full-coverage` prints the per-file
 * table too; extra args pass through to `bun test` (e.g. a file filter).
 *
 * CLI:
 *   bun run check:agent
 *   bun run check:agent -- test/unit/transfer-fanout.test.ts
 *   bun run check:agent -- --full-coverage
 */

import { $ } from "bun";

const args = process.argv.slice(2);
const fullCoverage = args.includes("--full-coverage");
const testArgs = args.filter((arg) => arg !== "--full-coverage");

const report = await $`bun test --coverage ${testArgs} 2>&1`.nothrow().text();
const lines = report.split("\n");

const failLines = lines.filter((line) => line.includes("(fail)"));
const countLines = lines.filter((line) =>
	/^\s*\d+\s+(pass|skip|fail)\b/.test(line),
);
const summaryLine = lines.find((line) => /^Ran \d+ tests/.test(line.trim()));
const tableStart = lines.findIndex((line) => /^-{5,}\|/.test(line));
const allFilesRow = lines.find((line) => line.startsWith("All files"));

console.log(
	failLines.length > 0
		? `❌ ${failLines.length} failing`
		: "✅ all tests passed",
);
for (const line of countLines) console.log(line.trim());
if (summaryLine) console.log(summaryLine.trim());

if (failLines.length > 0) {
	console.log("\nFailing tests:");
	for (const line of failLines) console.log(`  ${line.trim()}`);
}

if (tableStart >= 0) {
	console.log("\nCoverage:");
	if (fullCoverage) {
		for (const line of lines.slice(tableStart)) {
			if (line.trim() === "") break;
			console.log(line);
		}
	} else if (allFilesRow) {
		console.log(allFilesRow);
	}
}

process.exit(failLines.length > 0 ? 1 : 0);
