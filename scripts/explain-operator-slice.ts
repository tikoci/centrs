#!/usr/bin/env bun
/**
 * Cut the committed slice of the #255 operator sweep captures.
 *
 * `bun run explain:probe:operators` writes one ~1 MB capture per RouterOS
 * version to `.scratch/` — every carrier's raw IL, every per-character
 * `highlight` class, all 576 precedence pairs. That is the working record and
 * it stays in-flight, per `scripts/probes/AGENTS.md`. This script reduces it to
 * the reviewable answer that lands under `test/fixtures/` and is read by
 * `src/explain/operators.ts`.
 *
 * ## What it derives, rather than transcribes
 *
 * Everything in the `sweep` block is computed from the captures. Nothing here
 * is a judgement typed in by hand — the prose that interprets these rows lives
 * in `src/explain/operators.ts`, where a reviewer can see it is prose.
 *
 * - **verdict** comes from the probe (`operator` / `lowered` /
 *   `not-an-operator`), which requires the device to have built a node whose
 *   HEAD IS THE SPELLING. See the probe's `verdictOf` for why an acceptance is
 *   not enough: `(1 zzz 2)` parses.
 * - **precedence** is a rank, not an assertion: over every ordered pair of
 *   binary operators, count how often each ended up OUTERMOST. A looser-binding
 *   operator is outer more often. The counts land on
 *   `2 x (tighter operators) + (same-level operators)`, which is what a strict
 *   weak order looks like — so the levels below are read off it rather than
 *   assumed, and a future version that breaks the pattern shows up as a
 *   non-conforming count instead of being silently rounded into a level.
 * - **associativity** is the IL shape of `(1 A 2 A 3)`: `(A 1 2 3)` is
 *   variadic (the device flattens), `(A (A 1 2) 3)` is left, `(A 1 (A 2 3))`
 *   is right.
 * - **whyNot**, for a non-operator, is which of the three device behaviors
 *   produced it — rejected outright, absorbed into the unnamed juxtaposition
 *   node, or accepted only by lexing part of the spelling as a variable.
 *
 * ## Two versions, and what a difference means
 *
 * The slice carries both captures and computes their differences rather than
 * merging them. A row that differs is the only kind of version-dependent datum
 * here, and there is exactly one on 7.23.3 vs 7.24rc4.
 *
 * Run: bun run explain:operator-slice [--capture <path>]... [--out <path>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	loweredSpellings,
	nonOperators,
	routerosOperators,
} from "../src/explain/operators.ts";

const FIXTURE_PATH = join(
	import.meta.dir,
	"..",
	"test",
	"fixtures",
	"explain",
	"operators.json",
);

interface CaptureCarrier {
	source: string;
	il: string;
	accepted: boolean;
	ilHead: string | null;
	ilArity: number | null;
	juxtaposition: boolean;
	residualVariable: boolean;
}

interface CaptureCandidate {
	token: string;
	carriers: Record<string, CaptureCarrier>;
	operatorArities: number[];
	ilHeads: string[];
	highlight: {
		input: string;
		run: { text: string; class: string } | null;
		runIsTokenExactly: boolean;
	};
	verdict: "operator" | "lowered" | "not-an-operator";
}

interface CapturePrecedence {
	a: string;
	b: string;
	il: string;
	accepted: boolean;
	outerHead: string | null;
}

interface Capture {
	version: string;
	architecture: string;
	buildTime: string;
	candidates: CaptureCandidate[];
	precedence: CapturePrecedence[];
	controls: { id: string; source: string; il: string; accepted: boolean }[];
	opAxis: {
		id: string;
		source: string;
		note: string;
		il: string;
		ilHead: string | null;
		ilArity: number | null;
		accepted: boolean;
	}[];
	runtime: { id: string; source: string; expect: string; output: string }[];
}

/** `(A 1 2 3)` variadic, `(A (A 1 2) 3)` left, `(A 1 (A 2 3))` right. */
export function associativityOf(
	token: string,
	rows: readonly CapturePrecedence[],
): "variadic" | "left" | "right" | null {
	const self = rows.find((r) => r.a === token && r.b === token);
	if (self === undefined || !self.accepted) return null;
	const body = self.il.slice(self.il.indexOf("(", 1));
	if (body.startsWith(`(${token} (${token} `)) return "left";
	if (body.includes(`(${token} 1 (${token} `)) return "right";
	return body.startsWith(`(${token} 1 2 3)`) ? "variadic" : null;
}

/**
 * Outer-count per spelling over every distinct ordered pair.
 *
 * Attribution is exact: the pair sweep runs only over spellings whose verdict
 * is `operator`, and that verdict requires head === spelling, so the outer head
 * IS one of the two. A row where it is neither is dropped and counted, never
 * charged to a guess.
 */
export function outerCounts(rows: readonly CapturePrecedence[]): {
	outer: Map<string, number>;
	seen: Map<string, number>;
	dropped: number;
} {
	const outer = new Map<string, number>();
	const seen = new Map<string, number>();
	let dropped = 0;
	for (const row of rows) {
		if (!row.accepted || row.a === row.b) continue;
		if (row.outerHead !== row.a && row.outerHead !== row.b) {
			dropped++;
			continue;
		}
		for (const token of [row.a, row.b])
			seen.set(token, (seen.get(token) ?? 0) + 1);
		outer.set(row.outerHead, (outer.get(row.outerHead) ?? 0) + 1);
	}
	return { outer, seen, dropped };
}

/**
 * Turn outer-counts into precedence LEVELS, 1 = binds loosest.
 *
 * Equal counts are one level, and the levels are checked against the strict
 * weak order they should form: with `t` operators binding tighter and `s`
 * others at the same level, a spelling must be outer exactly `2t + s` times.
 * A count that does not fit is reported rather than rounded — a device whose
 * precedence is not a strict weak order is a finding, not a rendering problem.
 */
export function precedenceLevels(counts: {
	outer: Map<string, number>;
	seen: Map<string, number>;
}): { levels: Map<string, number>; nonConforming: string[] } {
	const tokens = [...counts.seen.keys()];
	const byCount = new Map<number, string[]>();
	for (const token of tokens) {
		const n = counts.outer.get(token) ?? 0;
		byCount.set(n, [...(byCount.get(n) ?? []), token]);
	}
	const ordered = [...byCount.entries()].sort((a, b) => b[0] - a[0]);
	const levels = new Map<string, number>();
	const nonConforming: string[] = [];
	let tighter = 0;
	for (const [level, [count, members]] of ordered.entries()) {
		// Walk loosest-first, so everything not yet assigned binds tighter.
		const remaining = tokens.length - tighter - members.length;
		const expected = 2 * remaining + (members.length - 1);
		if (count !== expected)
			nonConforming.push(
				`${members.join(",")}: outer ${count}, a strict weak order wants ${expected}`,
			);
		for (const member of members) levels.set(member, level + 1);
		tighter += members.length;
	}
	return { levels, nonConforming };
}

/** Which device behaviour kept a spelling out of the operator set. */
export function whyNot(row: CaptureCandidate): string {
	const carriers = Object.values(row.carriers);
	if (carriers.every((c) => !c.accepted)) return "rejected";
	if (carriers.some((c) => c.residualVariable))
		return "residual-variable: part of the spelling lexed as a $name";
	if (carriers.some((c) => c.juxtaposition))
		return "juxtaposition: accepted only inside the unnamed node";
	return "no node headed by this spelling";
}

function flagValues(args: readonly string[], name: string): string[] {
	const out: string[] = [];
	for (const [i, arg] of args.entries())
		if (arg === name && args[i + 1] !== undefined)
			out.push(args[i + 1] as string);
	return out;
}

export function buildSweep(
	captures: readonly Capture[],
): Record<string, unknown> {
	const primary = captures[0];
	if (primary === undefined) throw new Error("no captures given");
	const counts = outerCounts(primary.precedence);
	const { levels, nonConforming } = precedenceLevels(counts);

	const operators = primary.candidates
		.filter((row) => row.verdict === "operator")
		.map((row) => ({
			spelling: row.token,
			ilHead: row.token,
			arities: row.operatorArities,
			precedence: levels.get(row.token) ?? null,
			associativity: associativityOf(row.token, primary.precedence),
			outerCount: counts.outer.get(row.token) ?? null,
			highlightClass: row.highlight.run?.class ?? null,
			highlightRun: row.highlight.run?.text ?? null,
			highlightRunIsTokenExactly: row.highlight.runIsTokenExactly,
		}));

	const lowered = primary.candidates
		.filter((row) => row.verdict === "lowered")
		.map((row) => ({
			spelling: row.token,
			ilHeads: row.ilHeads,
			highlightClass: row.highlight.run?.class ?? null,
			example: Object.values(row.carriers).find(
				(c) => c.accepted && c.ilHead !== null && c.ilHead !== "",
			)?.il,
		}));

	const notOperators = primary.candidates
		.filter((row) => row.verdict === "not-an-operator")
		.map((row) => ({
			spelling: row.token,
			highlightClass: row.highlight.run?.class ?? null,
			whyNot: whyNot(row),
			example: Object.values(row.carriers)[0]?.il,
		}));

	// A per-row diff rather than a merge: a version-dependent row is the only
	// datum here that is not simply "the language", and burying it in a union
	// would lose exactly the thing the second CHR was booted for.
	const versionDifferences: Record<string, unknown>[] = [];
	for (const other of captures.slice(1)) {
		for (const [i, row] of primary.runtime.entries()) {
			const mirror = other.runtime[i];
			if (mirror === undefined || mirror.output === row.output) continue;
			versionDifferences.push({
				kind: "runtime",
				id: row.id,
				source: row.source,
				[primary.version]: row.output,
				[other.version]: mirror.output,
			});
		}
		for (const row of primary.candidates) {
			const mirror = other.candidates.find((c) => c.token === row.token);
			if (mirror === undefined || mirror.verdict === row.verdict) continue;
			versionDifferences.push({
				kind: "verdict",
				spelling: row.token,
				[primary.version]: row.verdict,
				[other.version]: mirror.verdict,
			});
		}
	}

	return {
		_source: {
			versions: captures.map((c) => `${c.version} (${c.architecture})`),
			buildTimes: captures.map((c) => c.buildTime),
			probe: "bun run explain:probe:operators",
			slice: "bun run explain:operator-slice",
			oracles:
				"`:parse` IL names the operator and its arity. `highlight` cannot: " +
				"syntax-meta is the device's residual structure class (it also covers " +
				"quotes, braces, brackets and whitespace) and adjacent runs are merged, " +
				"so an operator boundary is not recoverable from it. The one thing it " +
				"decides is structure-vs-word, which is what rules `not` out.",
			precedenceMethod:
				"rank by how often a spelling is the OUTER node over every ordered " +
				"pair; a looser-binding operator is outer more often. Levels are read " +
				"off the counts and checked against 2*(tighter) + (same level).",
			precedenceNonConforming: nonConforming,
			precedencePairsDropped: counts.dropped,
			unaryPrecedenceNotMeasured:
				"`!` and `any` are prefix-only, so the pair sweep never carries them " +
				"and they have no measured level.",
		},
		operators,
		lowered,
		notOperators,
		controls: primary.controls.map((c) => ({
			id: c.id,
			source: c.source,
			il: c.il,
			accepted: c.accepted,
		})),
		opAxis: primary.opAxis.map((row) => ({
			id: row.id,
			source: row.source,
			note: row.note,
			il: row.il,
			ilHead: row.ilHead,
			ilArity: row.ilArity,
			accepted: row.accepted,
		})),
		runtime: primary.runtime.map((row) => ({
			id: row.id,
			source: row.source,
			output: row.output,
		})),
		versionDifferences,
	};
}

const README_PATH = join(
	import.meta.dir,
	"..",
	"commands",
	"explain",
	"README.md",
);

const BLOCK_BEGIN =
	"<!-- BEGIN GENERATED operator-table — regenerate with `bun run explain:operator-readme` -->";
const BLOCK_END = "<!-- END GENERATED operator-table -->";

/**
 * Split on either line ending, so a checkout with `core.autocrlf=true` still
 * finds the markers instead of failing the gate for a `\r` (#282).
 */
export function splitLines(text: string): string[] {
	return text.split(/\r?\n/);
}

function lineEndingOf(text: string): string {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Render the README's operator tables from `src/explain/operators.ts`.
 *
 * The chain is capture -> fixture -> table -> README, and every link has its own
 * gate: `explain:operator-slice` writes the fixture from the captures,
 * `explain-operators.test.ts` holds the table to the fixture, and this block is
 * held to the table. Rendering from the TABLE rather than the fixture is what
 * gives `src/explain/operators.ts` a consumer while the emission work (#264 B2)
 * is still ahead of it — a table nothing reads is a table nothing catches
 * drifting.
 *
 * Every figure is a counter rather than an assertion, so a regenerated block
 * states a regression instead of quietly contradicting itself (#260).
 */
/**
 * A code span safe to put in a markdown table cell.
 *
 * A `|` inside backticks still ends the cell — GFM resolves table pipes before
 * inline code — so `|`, `||` and the IL example containing them have to be
 * escaped. Missed on the first render, and it split three rows in half.
 */
function cell(text: string): string {
	return `\`${text.replaceAll("|", "\\|")}\``;
}

export function renderReadmeBlock(): string[] {
	const operators = routerosOperators();
	const lowered = loweredSpellings();
	const notOperators = nonOperators();
	const byPrecedence = [...operators]
		.filter((entry) => entry.precedence !== null)
		.sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0));
	const prefixOnly = operators.filter((entry) => entry.precedence === null);

	const lines: string[] = [
		`The device builds a node for **${operators.length}** spellings, reads **${lowered.length}**`,
		`as something else, and refuses the other **${notOperators.length}** the sweep asked about.`,
		"",
		"| operator | arity | precedence | associativity | category |",
		"| -------- | ----- | ---------- | ------------- | -------- |",
		...byPrecedence.map(
			(entry) =>
				`| ${cell(entry.spelling)} | ${entry.arities.join(", ")} | ${entry.precedence} ` +
				`| ${entry.associativity} | ${entry.category} |`,
		),
		...prefixOnly.map(
			(entry) =>
				`| ${cell(entry.spelling)} | ${entry.arities.join(", ")} | not measured | not measured ` +
				`| ${entry.category} |`,
		),
		"",
		`Precedence runs 1 (loosest) to ${byPrecedence.at(-1)?.precedence ?? 0} (tightest), measured over every`,
		"ordered pair rather than transcribed. `variadic` means the device FLATTENS",
		"the operator — `(1 + 2 + 3)` is one node with three children, not two nested",
		"ones. The two prefix-only operators never appear in a pair and so carry no",
		"measured level.",
		"",
		"Spellings the device reads as something else:",
		"",
		"| spelling | reads as | kind |",
		"| -------- | -------- | ---- |",
		...lowered.map(
			(entry) =>
				`| ${cell(entry.spelling)} | ${cell(entry.example)} | ${entry.kind} |`,
		),
		"",
		"And the grounded complement — asked, and refused:",
		"",
		"| spelling | why not |",
		"| -------- | ------- |",
		...notOperators.map(
			(entry) => `| ${cell(entry.spelling)} | ${entry.reason} |`,
		),
	];
	return lines;
}

/** Rewrite or verify the README's generated block. Returns a process exit code. */
export function runReadme(check: boolean): number {
	const rendered = renderReadmeBlock();
	const readme = readFileSync(README_PATH, "utf8");
	const lines = splitLines(readme);
	const begin = lines.indexOf(BLOCK_BEGIN);
	const end = lines.indexOf(BLOCK_END);
	if (begin < 0 || end < begin) {
		console.error(
			"::error title=explain operator table::commands/explain/README.md is missing the generated operator-table block markers",
		);
		return 1;
	}
	const current = lines.slice(begin + 1, end);
	if (current.join("\n") === rendered.join("\n")) {
		if (!check) console.error("operator-table README block already current");
		return 0;
	}
	if (check) {
		console.error(
			"::error title=explain operator table::commands/explain/README.md no longer matches " +
				"src/explain/operators.ts. Run `bun run explain:operator-readme`.",
		);
		console.error(`--- README\n${current.join("\n")}`);
		console.error(`+++ table\n${rendered.join("\n")}`);
		return 1;
	}
	writeFileSync(
		README_PATH,
		[...lines.slice(0, begin + 1), ...rendered, ...lines.slice(end)].join(
			lineEndingOf(readme),
		),
	);
	console.error(
		"rewrote the operator-table block in commands/explain/README.md",
	);
	return 0;
}

export async function main(args: readonly string[]): Promise<number> {
	// Before any capture handling: the doc gate reads the committed table, so it
	// must run in `lint:ci` and from a bare clone, with no `.scratch/` present.
	if (args.includes("--readme")) return runReadme(args.includes("--check"));
	const paths = flagValues(args, "--capture");
	if (paths.length === 0) {
		console.error(
			"::error title=explain operator slice::name at least one capture with " +
				"--capture .scratch/explain-255-operator-sweep-<version>.json " +
				"(produced by `bun run explain:probe:operators`)",
		);
		return 1;
	}
	const captures = paths.map(
		(path) => JSON.parse(readFileSync(path, "utf8")) as Capture,
	);
	const sweep = buildSweep(captures);
	const outPath = flagValues(args, "--out")[0] ?? FIXTURE_PATH;
	const fixture = JSON.parse(readFileSync(outPath, "utf8")) as Record<
		string,
		unknown
	>;
	// The corpus block is the census's, not this script's: rewriting the whole
	// file would silently drop it and take the README gate's input with it.
	writeFileSync(
		outPath,
		`${JSON.stringify({ ...fixture, sweep }, null, "\t")}\n`,
	);
	// `JSON.stringify` expands every array onto its own lines and Biome collapses
	// the short ones, so a fixture written here fails `bun run lint` the moment
	// it is regenerated. Formatting it now makes re-cutting the slice idempotent
	// against the repo's own gate instead of leaving a diff for the next run to
	// trip over.
	const formatted = Bun.spawnSync([
		"bunx",
		"@biomejs/biome",
		"format",
		"--write",
		outPath,
	]);
	if (formatted.exitCode !== 0)
		console.error(
			"::warning title=explain operator slice::could not run Biome on the " +
				"fixture; run `bun run lint:fix` before committing",
		);
	console.error(`wrote the sweep block of ${outPath}`);
	const operators = (sweep["operators"] as unknown[]).length;
	const lowered = (sweep["lowered"] as unknown[]).length;
	const notOperators = (sweep["notOperators"] as unknown[]).length;
	console.error(
		`${operators} operators, ${lowered} lowered, ${notOperators} not operators, ` +
			`${(sweep["versionDifferences"] as unknown[]).length} version differences`,
	);
	return 0;
}

if (import.meta.main) {
	main(Bun.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(`::error title=explain operator slice::${String(error)}`);
			process.exit(1);
		});
}
