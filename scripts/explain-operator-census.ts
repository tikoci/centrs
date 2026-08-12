#!/usr/bin/env bun
/**
 * Operator-head census over the corpus's DEVICE `:parse` IL (#255).
 *
 * #255 asks for the operator axis to be grounded rather than transcribed from
 * the manual — the mistake #252 had to undo for string escapes. Before any CHR
 * boots, the corpus already holds 2,739 device `:parse` captures across three
 * RouterOS versions, and IL is written in prefix form with the operator as the
 * head of its node:
 *
 * ```text
 * :put (0.0.0.0 + 2130706433)  ->  /;(evl /putmessage=(+ 0.0.0.0 2130706433))
 * :put [:typeof (>[])]         ->  /;(evl /putmessage=(evl (evl /typeofvalue=(> (evl /)))))
 * ```
 *
 * So the device itself names the operators it has, and how many operands each
 * one took. That is the candidate list the CHR sweep then decides.
 *
 * ## This census is a CANDIDATE GENERATOR, not an answer
 *
 * **IL is a debug rendering, not a serialization, and it does not quote
 * strings.** A string literal is emitted bare when nothing in it would re-lex
 * (`"0."` -> `0.`) and wrapped in parentheses when something would
 * (`"num|str"` -> `(num|str)`) — which is indistinguishable, to any reader,
 * from a node whose head is `num|str`. There is no escape convention that would
 * let a parser tell them apart, so a perfectly correct reader still reports
 * string content in head position. The first exploratory run of this idea
 * produced `e.g.`, `https://rsc.eworm.de/;` and `2[0-4]|[01]` as "operators".
 *
 * The census therefore reports every head-position token it sees, tagged by
 * SHAPE, and leaves the decision to the device:
 *
 * - `punctuation` — no letters or digits (`+`, `->`, `<%%`). Real candidates.
 * - `word` — `[a-z][a-z-]*` (`and`, `or`, `in`, `evl`). Real candidates, and
 *   the bucket where #255's `not` would appear if it were an operator.
 * - `other` — anything mixed. Presumed string noise; reported, never trusted.
 *
 * Frequency is a prior, not evidence. `distinctScripts` is the more honest
 * column: a head seen in one script is one author's string, a head seen in
 * three hundred is a language feature.
 *
 * ```
 * bun run explain:operator-census              # markdown
 * bun run explain:operator-census --json       # the fixture's `corpus` block
 * bun run explain:operator-census --db PATH    # override the corpus.sqlite location
 * bun run explain:operator-census --check      # gate: fresh census vs the fixture
 * bun run explain:operator-census --candidates # the sweep's candidate list, one per line
 * ```
 *
 * The corpus is not in this repo; it is resolved through `corpus-fetch.ts` and
 * the source plus its sha256 are announced on stderr (#186). Read
 * `parseil_results.il_text` and NEVER the `ok` column: `:parse` returns its
 * diagnostic as a value, so a rejected script still records `ok=1`.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	describeResolution,
	resolveCorpusDb,
	unreachableMessage,
} from "./corpus-fetch.ts";

/**
 * A RouterOS console rejection is PROSE where a result would be IL, and always
 * opens with one of these verbs. Same predicate as
 * `test/integration/explain-string-escape.test.ts` — matching the opening word
 * rather than `expected .* value` keeps `expected end of command` and `bad
 * command name` on the reject side.
 */
const CONSOLE_REJECTION =
	/^(syntax error|expected |missing |invalid |unknown |unexpected |no such |bad )/i;

export type HeadShape = "punctuation" | "word" | "other";

export function headShape(head: string): HeadShape {
	if (head.length === 0) return "other";
	if (!/[a-zA-Z0-9]/.test(head)) return "punctuation";
	return /^[a-z][a-z-]*$/.test(head) ? "word" : "other";
}

/**
 * The census figures, as the fixture's `corpus` block stores them.
 *
 * Every per-head tally is a FLAT `Record<string, number>` rather than a nested
 * object, so {@link diffAgainstFixture} can compare it entry by entry the way
 * `explain-value-census.ts` does. Comparing serialized tallies would make JSON
 * key order — which is corpus visit order — read as drift (#260).
 */
export interface OperatorCensus {
	sourceScripts: number;
	ilRows: number;
	acceptedRows: number;
	rejectedRows: number;
	/** IL the tolerant reader could not balance. Reported, never swallowed. */
	unbalancedRows: number;
	versions: string;
	distinctHeads: number;
	/** `head` -> occurrences in head position, across every accepted IL row. */
	headOccurrences: Record<string, number>;
	/** `head` -> distinct source scripts whose IL contains it in head position. */
	headScripts: Record<string, number>;
	/** `head|version` -> occurrences, so a version-gated head is visible. */
	headVersions: Record<string, number>;
	/** `head|arity` -> occurrences, where arity is the node's child count. */
	headArities: Record<string, number>;
	/** `head` -> shape tag; the noise filter, stated rather than applied. */
	headShapes: Record<string, string>;
}

/**
 * One `(head …)` group. A child is either a nested group or a bare atom, kept
 * as a string — the reader does not try to type atoms, because IL does not
 * distinguish a number from a string from a path.
 */
export interface IlNode {
	head: string;
	children: (IlNode | string)[];
}

export interface IlTree {
	/** Groups at the outermost level; IL is a statement list, so there can be several. */
	roots: IlNode[];
	balanced: boolean;
}

/**
 * Read one IL string into a tree of `(head …)` groups.
 *
 * Tolerant by design: IL is a debug rendering (see the header), so the reader
 * cannot be correct in the parser sense and does not pretend to be. It tracks
 * parenthesis depth, takes the first whitespace-delimited token after each `(`
 * as that group's head, and treats every following nested group or maximal run
 * of non-space, non-paren bytes as one child.
 *
 * An unbalanced string (more `)` than `(`, or unclosed at the end) is reported
 * rather than thrown: one malformed capture must not take the census down, and
 * the flag is published so a rise is visible. Bytes outside any group are
 * top-level IL text (`/;` between statements) and are dropped.
 */
export function readIlTree(il: string): IlTree {
	const roots: IlNode[] = [];
	const stack: IlNode[] = [];
	let balanced = true;
	let i = 0;
	const push = (child: IlNode | string): void => {
		const parent = stack.at(-1);
		if (parent === undefined) {
			if (typeof child !== "string") roots.push(child);
			return;
		}
		parent.children.push(child);
	};
	while (i < il.length) {
		const c = il[i] as string;
		if (c === "(") {
			// The head is the token immediately after `(`, up to the next space,
			// paren or end. `(+ 1 2)` heads `+`; `( a b)` heads the empty string.
			let j = i + 1;
			while (j < il.length && !/[\s()]/.test(il[j] as string)) j++;
			const node: IlNode = { head: il.slice(i + 1, j), children: [] };
			push(node);
			stack.push(node);
			i = j;
			continue;
		}
		if (c === ")") {
			if (stack.pop() === undefined) balanced = false;
			i++;
			continue;
		}
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		let j = i;
		while (j < il.length && !/[\s()]/.test(il[j] as string)) j++;
		push(il.slice(i, j));
		i = j;
	}
	if (stack.length > 0) balanced = false;
	return { roots, balanced };
}

/** Every group in the tree, parents before children. */
export function flattenIl(tree: IlTree): IlNode[] {
	const out: IlNode[] = [];
	const walk = (node: IlNode): void => {
		out.push(node);
		for (const child of node.children)
			if (typeof child !== "string") walk(child);
	};
	for (const root of tree.roots) walk(root);
	return out;
}

function bump(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

export interface IlRow {
	scriptId: number;
	version: string;
	il: string;
}

export function census(
	rows: readonly IlRow[],
	sourceScripts: number,
): OperatorCensus {
	const result: OperatorCensus = {
		sourceScripts,
		ilRows: rows.length,
		acceptedRows: 0,
		rejectedRows: 0,
		unbalancedRows: 0,
		versions: "",
		distinctHeads: 0,
		headOccurrences: {},
		headScripts: {},
		headVersions: {},
		headArities: {},
		headShapes: {},
	};
	const versions = new Set<string>();
	/** `head` -> the script ids it was seen in, so scripts are counted once. */
	const scriptsPerHead = new Map<string, Set<number>>();

	for (const row of rows) {
		versions.add(row.version);
		if (CONSOLE_REJECTION.test(row.il)) {
			result.rejectedRows++;
			continue;
		}
		result.acceptedRows++;
		const tree = readIlTree(row.il);
		if (!tree.balanced) result.unbalancedRows++;
		for (const node of flattenIl(tree)) {
			bump(result.headOccurrences, node.head);
			bump(result.headVersions, `${node.head}|${row.version}`);
			bump(result.headArities, `${node.head}|${node.children.length}`);
			result.headShapes[node.head] = headShape(node.head);
			let seen = scriptsPerHead.get(node.head);
			if (seen === undefined) {
				seen = new Set();
				scriptsPerHead.set(node.head, seen);
			}
			seen.add(row.scriptId);
		}
	}
	for (const [head, seen] of scriptsPerHead)
		result.headScripts[head] = seen.size;
	result.versions = [...versions].sort().join(",");
	result.distinctHeads = Object.keys(result.headOccurrences).length;
	return result;
}

/**
 * The candidate list handed to the CHR sweep.
 *
 * `punctuation` and `word` heads only, ordered by distinct scripts. The `other`
 * bucket is presumed string noise and never promoted automatically — if a real
 * operator ever lands there, the sweep's manual list is where it gets added, by
 * a human who wrote down why.
 */
export function candidates(result: OperatorCensus, minScripts = 2): string[] {
	return Object.keys(result.headOccurrences)
		.filter((head) => {
			const shape = result.headShapes[head];
			if (shape !== "punctuation" && shape !== "word") return false;
			return (result.headScripts[head] ?? 0) >= minScripts;
		})
		.sort(
			(a, b) =>
				(result.headScripts[b] ?? 0) - (result.headScripts[a] ?? 0) ||
				a.localeCompare(b),
		);
}

/** The arities a head was observed with, ascending. */
export function aritiesOf(result: OperatorCensus, head: string): number[] {
	return Object.keys(result.headArities)
		.filter((key) => key.slice(0, key.lastIndexOf("|")) === head)
		.map((key) => Number(key.slice(key.lastIndexOf("|") + 1)))
		.sort((a, b) => a - b);
}

function renderMarkdown(result: OperatorCensus): string {
	const heads = Object.keys(result.headOccurrences).sort(
		(a, b) =>
			(result.headScripts[b] ?? 0) - (result.headScripts[a] ?? 0) ||
			(result.headOccurrences[b] ?? 0) - (result.headOccurrences[a] ?? 0) ||
			a.localeCompare(b),
	);
	const versions = result.versions.split(",");
	const lines = [
		`corpus: ${result.sourceScripts} scripts, ${result.ilRows} IL rows ` +
			`(${result.acceptedRows} accepted, ${result.rejectedRows} rejected, ` +
			`${result.unbalancedRows} unbalanced), versions ${result.versions}`,
		`distinct heads: ${result.distinctHeads}`,
		"",
		`| head | shape | scripts | occurrences | arities | ${versions.join(" | ")} |`,
		`| ---- | ----- | ------: | ----------: | ------- | ${versions.map(() => "---:").join(" | ")} |`,
		...heads.map((head) => {
			const perVersion = versions.map(
				(v) => result.headVersions[`${head}|${v}`] ?? 0,
			);
			// A `|` inside a code span still ends a GFM table cell, and IL carries
			// unquoted string content into head position — `num|str` and
			// `2[0-4]|[01]` are both real heads here. Unescaped, those rows grow
			// extra columns and shift `shape`, `scripts` and `occurrences` sideways
			// in the CI job summary this renders into.
			const cell = head.replaceAll("|", "\\|");
			return (
				`| \`${cell}\` | ${result.headShapes[head]} | ${result.headScripts[head] ?? 0} ` +
				`| ${result.headOccurrences[head] ?? 0} | ${aritiesOf(result, head).join(",")} ` +
				`| ${perVersion.join(" | ")} |`
			);
		}),
	];
	return lines.join("\n");
}

function flag(args: readonly string[], name: string): string | undefined {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
}

const FIXTURE_PATH = join(
	import.meta.dir,
	"..",
	"test",
	"fixtures",
	"explain",
	"operators.json",
);

/** The `corpus` block of the operators fixture. */
export function readFixtureCensus(): OperatorCensus {
	const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
		corpus?: OperatorCensus;
	};
	if (fixture.corpus === undefined)
		throw new Error(`${FIXTURE_PATH} has no \`corpus\` block`);
	return fixture.corpus;
}

/** A per-head tally, as opposed to a scalar figure. */
function isCountMap(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compare a fresh census against the committed fixture, entry by entry.
 *
 * Never as serialized text: JSON object order is insertion order and every
 * tally here is built in corpus visit order, so `JSON.stringify` would call a
 * reordering drift and print two blobs a reviewer cannot tell apart (#260).
 */
export function diffAgainstFixture(
	fresh: OperatorCensus,
	pinned: OperatorCensus,
): string[] {
	const measured = fresh as unknown as Record<string, unknown>;
	const committed = pinned as unknown as Record<string, unknown>;
	const drift: string[] = [];
	for (const key of Object.keys(measured)) {
		const a = measured[key];
		const b = committed[key];
		if (isCountMap(a) || isCountMap(b)) {
			const am = isCountMap(a) ? a : {};
			const bm = isCountMap(b) ? b : {};
			for (const name of [
				...new Set([...Object.keys(am), ...Object.keys(bm)]),
			].sort()) {
				if (am[name] === bm[name]) continue;
				drift.push(
					`${key}.${name}: fixture ${bm[name] ?? "absent"}, measured ${am[name] ?? "absent"}`,
				);
			}
			continue;
		}
		if (a !== b) drift.push(`${key}: fixture ${b}, measured ${a}`);
	}
	for (const key of Object.keys(committed)) {
		if (key in measured) continue;
		drift.push(`${key}: in the fixture, not measured`);
	}
	return drift;
}

export async function main(args: readonly string[]): Promise<number> {
	const resolution = resolveCorpusDb(flag(args, "--db"));
	// stderr, not stdout: `--json` is piped into the fixture.
	if (resolution.warning)
		console.error(
			`::warning title=explain operator census::${resolution.warning}`,
		);
	const dbPath = resolution.path;
	if (dbPath === undefined || !(await Bun.file(dbPath).exists())) {
		console.error(unreachableMessage("explain operator census"));
		return 1;
	}
	console.error(describeResolution(resolution));
	const db = new Database(dbPath, { readonly: true });
	let rows: IlRow[];
	let sourceScripts: number;
	try {
		rows = (
			db
				.query(
					"SELECT script_id AS scriptId, routeros_version AS version, il_text AS il " +
						"FROM parseil_results WHERE il_text IS NOT NULL " +
						"ORDER BY routeros_version, script_id",
				)
				.all() as IlRow[]
		).map((row) => row);
		sourceScripts = (
			db.query("SELECT COUNT(*) AS n FROM source_scripts").get() as {
				n: number;
			}
		).n;
	} finally {
		db.close();
	}
	const result = census(rows, sourceScripts);

	if (args.includes("--check")) {
		// A gate cannot pass on an unstated premise. `resolveCorpusDb` prefers a
		// sibling checkout over the pinned cache and only WARNS when it is not the
		// pin, so without this a green "matches the committed fixture" could have
		// been measured against a corpus nobody else has.
		if (resolution.warning) {
			console.error(
				"::error title=explain operator census::refusing to check against a " +
					"corpus that is not the pinned snapshot — the result would not be " +
					"comparable to CI's.",
			);
			return 1;
		}
		const drift = diffAgainstFixture(result, readFixtureCensus());
		if (drift.length > 0) {
			console.error(
				"::error title=explain operator census::the census no longer matches " +
					"test/fixtures/explain/operators.json → corpus. Repin with " +
					"`bun run explain:operator-census --json`.",
			);
			for (const line of drift) console.error(`  ${line}`);
			return 1;
		}
		console.error("operator census matches the committed fixture");
		return 0;
	}
	if (args.includes("--candidates")) {
		await Bun.write(Bun.stdout, `${candidates(result).join("\n")}\n`);
		return 0;
	}
	// Written rather than logged: `console.log` + `process.exit` can truncate a
	// piped stdout in Bun, and this output is normally piped into a file.
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
			console.error(`::error title=explain operator census::${String(error)}`);
			process.exit(1);
		});
}
