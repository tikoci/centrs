#!/usr/bin/env bun
/**
 * Value-surface census over the `explain` corpus (#225).
 *
 * The `corpus` block of `test/fixtures/explain/values.json` states what the
 * value emission does across every corpus script, and those figures are cited
 * from the command README. #242 published them from a throwaway script, so when
 * #225's interior work changed the emission there was no way to recompute them
 * under the same definitions — only to guess which definition had produced
 * each number. This is that script, checked in for the same reason the genre
 * census is (`scripts/explain-corpus-census.ts`).
 *
 * ```
 * bun run explain:value-census              # markdown
 * bun run explain:value-census --json       # the fixture's `corpus` block
 * bun run explain:value-census --db PATH    # override the corpus.sqlite location
 * bun run explain:value-census:check        # gate: fresh census vs the fixture
 * bun run explain:value-census:readme       # rewrite the README block from the fixture
 * bun run explain:value-census:readme:check # gate: README block vs the fixture
 * ```
 *
 * The corpus is not in this repo. A sibling `lsp-routeros-ts` checkout is used
 * when present, otherwise the snapshot pinned by `bun run corpus:fetch`; the
 * source and its sha256 are announced on stderr. See `corpus-fetch.ts` (#186).
 *
 * ## Two gates, because the figures live in three places (#260)
 *
 * Committing this script made the figures **re-derivable**; it did not make
 * them **checked**. #256 changed the emission, regenerated the fixture and the
 * unit assertions, and shipped with the README prose still quoting the
 * pre-change numbers — three review comments found that, not CI.
 *
 * The chain is corpus → fixture → README, and each link now has its own gate,
 * separated by what data it needs:
 *
 * - `--check` re-runs the census and asserts it against
 *   `test/fixtures/explain/values.json` → `corpus`. It needs the corpus, so it
 *   runs in ci.yaml's `corpus` job (the one #186 gave `corpus:fetch`
 *   reachability for) and never in the offline `lint:ci`.
 * - `--readme --check` asserts the README paragraph against that same fixture
 *   block. The README is now a GENERATED projection of it, so the drift that
 *   actually happened is caught with no corpus at all — that one is in
 *   `lint:ci` and in `bun test`.
 *
 * The fixture is the hinge: it is the one copy a human writes, and both gates
 * point at it rather than at each other.
 *
 * ## What each figure means
 *
 * - **strictComparableAnchors** — emitted values in statements the STRICT REST
 *   lexer also read. Only these can contradict anything: where both readings
 *   exist, they must agree byte for byte.
 * - **boundaryContradictions** — of those, values whose span or decoded text
 *   differs from the strict token's. This is the number that must stay 0; it is
 *   the whole reason the advisory scan reuses the strict readers instead of
 *   carrying a second grammar.
 * - **recoveredPrefixAnchors** / **unreadStatementsWithAnchors** — what the
 *   prefix-safe scan retains in statements the strict lexer refuses outright,
 *   and how many statements those come from. Array members land here by
 *   construction: a structured value makes the strict lexer refuse the whole
 *   statement, so a member never has a strict counterpart.
 * - **invalidSpans** — spans that do not address their own source bytes. Also
 *   must stay 0.
 *
 * The walk doubles as the standing termination check on the argument lexer: a
 * scanner that stops advancing hangs here on real input rather than in a user's
 * terminal (the #244 non-termination was found exactly this way).
 */

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lexArguments, lexValueAnchors } from "../src/explain/args.ts";
import { valueShapeHints } from "../src/explain/values.ts";
import { resolveVerbs } from "../src/explain/verbsplit.ts";
import {
	describeResolution,
	resolveCorpusDb,
	unreachableMessage,
} from "./corpus-fetch.ts";

export interface ValueCensus {
	sourceScripts: number;
	valueOccurrences: number;
	elementOccurrences: number;
	keyedElements: number;
	nestedElements: number;
	strictComparableAnchors: number;
	boundaryContradictions: number;
	unreadStatementsWithAnchors: number;
	recoveredPrefixAnchors: number;
	invalidSpans: number;
	danglingParents: number;
	containmentBreaks: number;
	shapeCounts: Record<string, number>;
	elementShapeCounts: Record<string, number>;
}

/** One emitted value, as `src/explain.ts` composes it. */
interface Emitted {
	kind: string;
	parent: number | undefined;
	valueSpan: { start: number; end: number };
	tokenSpan: { start: number; end: number };
	value: string;
	shapes: string[];
	/** An array member's key, present only on a keyed `element`. */
	name?: string;
}

function bump(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

export function census(scripts: readonly string[]): ValueCensus {
	const result: ValueCensus = {
		sourceScripts: scripts.length,
		valueOccurrences: 0,
		elementOccurrences: 0,
		keyedElements: 0,
		nestedElements: 0,
		strictComparableAnchors: 0,
		boundaryContradictions: 0,
		unreadStatementsWithAnchors: 0,
		recoveredPrefixAnchors: 0,
		invalidSpans: 0,
		danglingParents: 0,
		containmentBreaks: 0,
		shapeCounts: {},
		elementShapeCounts: {},
	};

	for (const text of scripts) {
		for (const split of resolveVerbs(text).splits) {
			if (split.resolution !== "resolved" || split.argsAt === null) continue;
			const statement = split.text;
			const anchored = lexValueAnchors(statement, split.argsAt, {
				...(split.path === "/" ? { directiveVerb: split.verb } : {}),
			});
			const emitted: (Emitted | null)[] = anchored.anchors.map((anchor) => {
				const shapes =
					anchor.sourceShape === "array"
						? ["array"]
						: valueShapeHints(anchor.value, {
								quoted: anchor.quoted,
								allowBareString: anchor.kind === "attribute",
								context:
									anchor.kind === "element" ? "array-member" : "argument",
							});
				if (shapes.length === 0) return null;
				return {
					kind: anchor.kind,
					parent: anchor.parent,
					valueSpan: anchor.valueSpan,
					tokenSpan: anchor.tokenSpan,
					value: anchor.value,
					shapes,
					...(anchor.name === undefined ? {} : { name: anchor.name }),
				};
			});
			const kept = emitted.filter((entry): entry is Emitted => entry !== null);
			result.valueOccurrences += kept.length;

			for (const [index, entry] of emitted.entries()) {
				if (entry === null) continue;
				for (const shape of entry.shapes) bump(result.shapeCounts, shape);
				if (
					entry.valueSpan.start < 0 ||
					entry.valueSpan.end > statement.length ||
					entry.valueSpan.start > entry.valueSpan.end
				)
					result.invalidSpans++;
				if (entry.kind !== "element") continue;
				result.elementOccurrences++;
				if (entry.name !== undefined) result.keyedElements++;
				for (const shape of entry.shapes)
					bump(result.elementShapeCounts, shape);
				const parent =
					entry.parent === undefined ? null : emitted[entry.parent];
				if (parent === undefined || parent === null) {
					result.danglingParents++;
					continue;
				}
				if (parent.kind === "element") result.nestedElements++;
				if (
					entry.valueSpan.start < parent.valueSpan.start ||
					entry.valueSpan.end > parent.valueSpan.end ||
					(entry.valueSpan.start === parent.valueSpan.start &&
						entry.valueSpan.end === parent.valueSpan.end &&
						index !== entry.parent)
				)
					result.containmentBreaks++;
			}

			const strict = lexArguments(statement, split.argsAt);
			if (strict.read) {
				// Members are excluded because the strict lexer has no token to compare
				// them against. It is a no-op today — a structured value makes that
				// lexer refuse the whole statement, so a statement it reads has 0
				// elements (measured over the corpus) — but the counter has to match
				// the definition it publishes rather than rely on that staying true.
				const comparable = kept.filter((entry) => entry.kind !== "element");
				result.strictComparableAnchors += comparable.length;
				for (const entry of comparable) {
					const token = strict.tokens.find(
						(candidate) =>
							candidate.span.start === entry.tokenSpan.start &&
							candidate.span.end === entry.tokenSpan.end,
					);
					if (token?.valueSpan === undefined) continue;
					if (
						token.valueSpan.start !== entry.valueSpan.start ||
						token.valueSpan.end !== entry.valueSpan.end ||
						token.value !== entry.value
					)
						result.boundaryContradictions++;
				}
			} else if (kept.length > 0) {
				result.unreadStatementsWithAnchors++;
				result.recoveredPrefixAnchors += kept.length;
			}
		}
	}
	return result;
}

function renderMarkdown(result: ValueCensus): string {
	const lines = [
		"| figure | value |",
		"| ------ | ----- |",
		...Object.entries(result)
			.filter(([, value]) => typeof value === "number")
			.map(([key, value]) => `| \`${key}\` | ${value} |`),
		"",
		`shapes: ${JSON.stringify(result.shapeCounts)}`,
		`element shapes: ${JSON.stringify(result.elementShapeCounts)}`,
	];
	return lines.join("\n");
}

function flag(args: readonly string[], name: string): string | undefined {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
}

const README_PATH = join(
	import.meta.dir,
	"..",
	"commands",
	"explain",
	"README.md",
);
const FIXTURE_PATH = join(
	import.meta.dir,
	"..",
	"test",
	"fixtures",
	"explain",
	"values.json",
);

/**
 * The generated paragraph sits inside a list item, so both markers and every
 * rendered line carry the item's two-space continuation indent.
 */
const BLOCK_INDENT = "  ";
const BLOCK_BEGIN = `${BLOCK_INDENT}<!-- BEGIN GENERATED value-census — regenerate with \`bun run explain:value-census:readme\` -->`;
const BLOCK_END = `${BLOCK_INDENT}<!-- END GENERATED value-census -->`;
const WRAP_COLUMNS = 78;

/**
 * Greedy word wrap that never breaks inside a `code span`.
 *
 * A token is a maximal run of non-space characters in which a whole
 * backtick-delimited span counts as one character, so `` `bun run x` `` and any
 * punctuation glued to it stay on one line. CommonMark would in fact fold a
 * newline inside a code span into a space, but a command the reader may want to
 * copy should not be split across lines in the source either.
 */
function wrap(text: string): string[] {
	const lines: string[] = [];
	let line = BLOCK_INDENT;
	for (const word of text.match(/(?:`[^`]*`|\S)+/g) ?? []) {
		if (line !== BLOCK_INDENT && line.length + 1 + word.length > WRAP_COLUMNS) {
			lines.push(line);
			line = BLOCK_INDENT;
		}
		line += line === BLOCK_INDENT ? word : ` ${word}`;
	}
	if (line !== BLOCK_INDENT) lines.push(line);
	return lines;
}

const count = (value: number): string => value.toLocaleString("en-US");

/**
 * Render the README's census paragraph from a census result.
 *
 * Every sentence stays true at any value: the invariants are reported as
 * counters rather than asserted as held, so a regenerated block states a
 * regression instead of quietly contradicting itself.
 */
export function renderReadmeBlock(result: ValueCensus): string[] {
	const idCount = result.shapeCounts["id"] ?? 0;
	const idClause =
		idCount === 0
			? "the corpus holds no source-literal `id` example"
			: `${count(idCount)} are \`id\``;
	return wrap(
		`The corpus census is re-derivable with \`bun run explain:value-census\` and ` +
			`covers ${count(result.sourceScripts)} source scripts. The figures below are generated from ` +
			"`test/fixtures/explain/values.json` → `corpus` by " +
			"`bun run explain:value-census:readme` and gated against it by " +
			"`bun run explain:value-census:readme:check`; the fixture itself is gated " +
			"against a fresh corpus run by `bun run explain:value-census:check`. Of the " +
			`${count(result.strictComparableAnchors)} emitted values in a statement the strict argument lexer ` +
			`ALSO read, ${count(result.boundaryContradictions)} disagree with it on half-open byte span or ` +
			`decoded text, while the prefix-safe scan retains a further ${count(result.recoveredPrefixAnchors)} ` +
			`values across ${count(result.unreadStatementsWithAnchors)} statements whose strict REST reading ` +
			`abstains. Of ${count(result.valueOccurrences)} emitted occurrences, ` +
			`${count(result.elementOccurrences)} are array members (${count(result.keyedElements)} keyed, ` +
			`${count(result.nestedElements)} nested inside another member) and ` +
			`${count(result.shapeCounts["array"] ?? 0)} are arrays; ${idClause}. The three structural ` +
			"counters — spans addressing bytes outside their own source, members " +
			"naming a container that does not exist, members escaping the container " +
			`they name — read ${count(result.invalidSpans)}, ${count(result.danglingParents)} and ` +
			`${count(result.containmentBreaks)}, and each must stay 0.`,
	);
}

/** The `corpus` block of the values fixture, which the README block projects. */
function readFixtureCensus(): ValueCensus {
	const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
		corpus?: ValueCensus;
	};
	if (fixture.corpus === undefined)
		throw new Error(`${FIXTURE_PATH} has no \`corpus\` block`);
	return fixture.corpus;
}

/**
 * Compare a fresh census against the committed fixture, figure by figure.
 *
 * `censusCommand` is the fixture's own provenance note, not a measurement, so
 * it is excluded here; `explain-values.test.ts` pins it instead.
 */
export function diffAgainstFixture(
	fresh: ValueCensus,
	pinned: ValueCensus,
): string[] {
	const measured = fresh as unknown as Record<string, unknown>;
	const committed = pinned as unknown as Record<string, unknown>;
	const render = (value: unknown): string =>
		typeof value === "number" ? String(value) : JSON.stringify(value);
	const drift: string[] = [];
	for (const key of Object.keys(measured)) {
		const a = render(measured[key]);
		const b = render(committed[key]);
		if (a !== b) drift.push(`${key}: fixture ${b}, measured ${a}`);
	}
	// A figure the fixture carries and the census no longer emits is drift too:
	// silently keeping it would leave the README quoting a retired definition.
	for (const key of Object.keys(committed)) {
		if (key in measured || key === "censusCommand") continue;
		drift.push(`${key}: in the fixture, not measured`);
	}
	return drift;
}

/**
 * Rewrite or verify the README's generated block. Returns a process exit code.
 */
export function runReadme(check: boolean): number {
	const rendered = renderReadmeBlock(readFixtureCensus());
	const readme = readFileSync(README_PATH, "utf8");
	const lines = readme.split("\n");
	const begin = lines.indexOf(BLOCK_BEGIN);
	const end = lines.indexOf(BLOCK_END);
	if (begin < 0 || end < begin) {
		console.error(
			`::error title=explain value census::commands/explain/README.md is missing the generated value-census block markers`,
		);
		return 1;
	}
	const current = lines.slice(begin + 1, end);
	if (current.join("\n") === rendered.join("\n")) {
		if (!check) console.error("value-census README block already current");
		return 0;
	}
	if (check) {
		console.error(
			"::error title=explain value census::commands/explain/README.md no longer matches " +
				"test/fixtures/explain/values.json → corpus. Run `bun run explain:value-census:readme`.",
		);
		console.error(`--- README\n${current.join("\n")}`);
		console.error(`+++ fixture\n${rendered.join("\n")}`);
		return 1;
	}
	writeFileSync(
		README_PATH,
		[...lines.slice(0, begin + 1), ...rendered, ...lines.slice(end)].join("\n"),
	);
	console.error("rewrote the value-census block in commands/explain/README.md");
	return 0;
}

export async function main(args: readonly string[]): Promise<number> {
	// Before any corpus resolution: the doc gate reads the fixture, so it must
	// run in CI and from a bare clone, where `corpus.sqlite` does not exist.
	if (args.includes("--readme")) return runReadme(args.includes("--check"));
	const resolution = resolveCorpusDb(flag(args, "--db"));
	// All of this goes to stderr, not stdout: `--json` is piped into the fixture.
	// The warning is emitted before the reachability check because a corrupt
	// cache both warns and fails to resolve, and "why" beats "no".
	if (resolution.warning) {
		console.error(
			`::warning title=explain value census::${resolution.warning}`,
		);
	}
	const dbPath = resolution.path;
	if (dbPath === undefined || !(await Bun.file(dbPath).exists())) {
		console.error(unreachableMessage("explain value census"));
		return 1;
	}
	console.error(describeResolution(resolution));
	const db = new Database(dbPath, { readonly: true });
	let scripts: string[];
	try {
		scripts = (
			db.query("SELECT text FROM source_scripts").all() as { text: string }[]
		).map((row) => row.text);
	} finally {
		db.close();
	}
	const result = census(scripts);
	if (args.includes("--check")) {
		const drift = diffAgainstFixture(result, readFixtureCensus());
		if (drift.length > 0) {
			console.error(
				"::error title=explain value census::the census no longer matches " +
					"test/fixtures/explain/values.json → corpus. Repin with " +
					"`bun run explain:value-census --json`, then " +
					"`bun run explain:value-census:readme`, and update the assertions in " +
					"test/unit/explain-values.test.ts.",
			);
			for (const line of drift) console.error(`  ${line}`);
			return 1;
		}
		console.error("value census matches the committed fixture");
		return 0;
	}
	// Written rather than logged: `console.log` followed by `process.exit` can
	// truncate a piped stdout in Bun, and this output is normally piped into a
	// file or `jq`.
	await Bun.write(
		Bun.stdout,
		`${
			args.includes("--json")
				? JSON.stringify(result, null, 2)
				: renderMarkdown(result)
		}\n`,
	);
	return 0;
}

if (import.meta.main) {
	main(Bun.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(`::error title=explain value census::${String(error)}`);
			process.exit(1);
		});
}
