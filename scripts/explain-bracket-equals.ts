#!/usr/bin/env bun
/**
 * Prices the operator fill's abstention on `=` inside `[ … ]` (#341).
 *
 * `src/explain/operator-tokens.ts` claims `, / = -` only when the innermost
 * open delimiter is `(`, because `(` opens an expression while `[` opens a
 * *command*. That abstention has a cost — a `find` query really does contain
 * comparisons — and `commands/explain/README.md` plus the module header quoted
 * it as `224` of `1,259` against `1,035` for three releases with **no script
 * behind it and no gate on it**. No universe reproduces `1,259`, so the
 * original methodology is unrecoverable; this script states a new one rather
 * than pretending to restore it (#341, found while remeasuring #336).
 *
 * ## Why the old figure could not survive
 *
 * It was measured when the operator fill was the SECOND fill (#290 B2, PR #292)
 * and saw every byte the proof-only spans left. It is now the **eighth and
 * last**: `pathSpans`, `argSpans`, `escapeSpans`, `valueSpans`, `stringSpans`
 * and `braceSpans` all claim first. Whatever universe the old scan walked, it
 * was not this one, and no reading of the current pipeline reproduces `1,259`.
 *
 * Worth stating because it is the obvious guess and it is WRONG: the `arg` fill
 * does not rescue these bytes. It claims exactly **0** of the bracket-interior
 * `=`, because it offers only the `=` its own located argument token names, and
 * a `[ … ]` substitution is not where it locates arguments. That is what
 * `ExplainTokenClass.arg-sep`'s own doc comment says — "one inside a `[ … ]`
 * substitution stays `unclassified` where the operator fill abstains" — and the
 * measurement agrees with it. The abstention is as wide as it ever was; only
 * the accounting of it was wrong.
 *
 * ## The measurement
 *
 * The universe is **source-structural**: every `=` byte whose innermost open
 * delimiter is `[`, with quoted strings and `#` comments skipped. That is a
 * property of the corpus, not of the pipeline, so it is stable across
 * fill-order changes — which is exactly what the old figure was not.
 * `source_scripts` is byte-identical across both #336 repins, so this
 * denominator cannot move without the corpus moving.
 *
 * The scan runs on the ANALYZED surface, not the original string: token offsets
 * are UTF-8 byte counts, and 112 of the 948 scripts carry non-ASCII. Mixing the
 * two coordinate spaces shifted the class attribution on the 35 of those that
 * also carry a bracket `=`. Both sides go through `analyzeCoordinates`, the
 * same helper `explainCommand` uses.
 *
 * Each such byte is then reported by the class `explainCommand` actually gives
 * it. Nothing re-derives the fill's delimiter stack, so nothing here can
 * drift from `operator-tokens.ts`:
 *
 * - `unclassified` — the operator fill abstained. **This is the live cost**, and
 *   it is essentially the whole universe.
 * - `arg-sep` — the `arg` fill claimed it. Measured 0; see above.
 * - anything else — the byte was inside a string, value or command run.
 *
 * ## The split is grounded on the device, not on intuition
 *
 * For `[find address=$IP list=demo]` the device emits
 * `(  (= $address $IP) (= $list demo))` — genuine `(= …)` comparison nodes —
 * while the argument list of `add address=$IP comment=$Site` stays flat inside
 * its node with no `=` head. So the discriminator is the **query verb**: an `=`
 * governed by `find`/`where` is a comparison, one in a command's argument list
 * is `arg=value`. It is emphatically NOT `where` alone — `find address=$IP`
 * carries no `where` in the source and still lowers to comparisons.
 *
 * ```
 * bun run explain:bracket-equals                   # markdown
 * bun run explain:bracket-equals --json            # the fixture block
 * bun run explain:bracket-equals --db PATH         # override the corpus.sqlite location
 * bun run explain:bracket-equals --check           # gate: fresh scan vs the fixture
 * bun run explain:bracket-equals --readme          # rewrite the README block
 * bun run explain:bracket-equals --readme --check  # gate: README vs the fixture
 * ```
 *
 * The chain is corpus → fixture → README with a gate on each link, matching
 * `explain-value-census.ts`. `--readme` reads the FIXTURE, never the corpus, so
 * the doc gate runs in CI and from a bare clone (#186).
 */

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareRouterOsVersion } from "../src/core/preflight.ts";
import { analyzeCoordinates } from "../src/explain/coordinates.ts";
import { scanQuotedString } from "../src/explain/quoted-string.ts";
import { explainCommand } from "../src/explain.ts";
import {
	describeResolution,
	resolveCorpusDb,
	unreachableMessage,
} from "./corpus-fetch.ts";

/** Mirrors `operator-tokens.ts`. Only `(` opens an expression. */
const OPENERS = "([{";
const CLOSERS = ")]}";

/**
 * Verbs that introduce a QUERY, whose `k=v` pairs are comparisons rather than
 * arguments. Grounded on the IL: `[find address=$IP]` lowers to
 * `(= $address $IP)`, and `where` marks the same thing when it appears
 * explicitly.
 */
const QUERY_VERBS = new Set(["find", "where"]);

export interface BracketEqualsCensus {
	/** `source_scripts` rows read. */
	scripts: number;
	/** Scripts carrying at least one bracket-interior `=`. */
	scriptsWithBracketEquals: number;
	/** The universe: `=` bytes whose innermost source opener is `[`. */
	bracketEquals: number;
	/** Of the universe, those governed by a `find`/`where` query. */
	queryComparisons: number;
	/** Of the universe, those in a command's argument list. */
	argumentSeparators: number;
	/** `=` bytes whose innermost source opener is `(` — the fill's own ground. */
	expressionEquals: number;
	/**
	 * The universe by the class `explainCommand` actually assigns. `arg-sep` is
	 * already solved by the `arg` fill; `unclassified` is the live abstention.
	 */
	bracketEqualsByClass: Record<string, number>;
	/**
	 * The live cost: bracket `=` bytes left `unclassified`, split by whether a
	 * query governs them. The `query` half is what a `where`-aware fill could
	 * still win; the `argument` half is what no fill has located.
	 */
	unclassifiedQuery: number;
	unclassifiedArgument: number;
	/**
	 * Device corroboration, per version-comparable build: `(= …)` head nodes in
	 * the corpus IL. Not equal to {@link queryComparisons} — IL comparison nodes
	 * also come from `:if ($a = $b)` and other contexts the fill already claims —
	 * but it is the oracle that says query `k=v` lowers to a comparison at all.
	 */
	ilComparisonNodes: Record<string, number>;
	/**
	 * Whether the device actually backs the query reading, script by script, on
	 * {@link CORROBORATION_BUILD}.
	 *
	 * `corroborated` means the IL holds at least as many `(= …)` nodes as this
	 * scan called query comparisons in that script. The shortfalls are NOT scan
	 * errors: they are scripts whose enclosing command the capture device could
	 * not resolve, so it emitted a diagnostic instead of a comparison — a forum
	 * snippet using `/interface wireless` on a build that answers `bad command
	 * name wireless` still has a perfectly good `find default-name=…` in its
	 * text. `rejectedParse` counts scripts the console refused outright, where
	 * the IL is prose and carries no nodes at all.
	 */
	ilCorroboration: {
		build: string;
		scriptsWithQueryEquals: number;
		corroborated: number;
		commandUnresolved: number;
		rejectedParse: number;
	};
}

/**
 * A console rejection is PROSE where IL would be. Same predicate as
 * `explain-operator-census.ts`.
 */
const CONSOLE_REJECTION =
	/^(syntax error|expected |missing |invalid |unknown |unexpected |no such |bad )/i;

/** The build the per-script corroboration is scored on: current stable. */
export const CORROBORATION_BUILD = "7.24.2";

interface EqualsSite {
	offset: number;
	/** The innermost open delimiter, or `""` at top level. */
	opener: string;
	/** True when a `find`/`where` governs this `=` within its group. */
	query: boolean;
}

/**
 * Every `=` byte in one script, tagged with the delimiter that governs it.
 *
 * Deliberately a stack, not a counter: `[ ( a = b ) ]` and `( [ a = b ] )` must
 * come out differently and a depth number cannot tell them apart.
 *
 * This is a SOURCE-structural scan — raw text, quoted strings and `#` comments
 * skipped — not a reconstruction of the fill's own residual-masked stack. An
 * earlier draft tried the latter and silently desynchronized on delimiters the
 * fill never saw, which is the same class of unverifiable claim #341 exists to
 * remove. What the pipeline did with each byte comes from the token stream
 * instead, where it cannot be guessed wrong.
 */
export function scanEqualsSites(text: string): EqualsSite[] {
	const out: EqualsSite[] = [];
	const openers: string[] = [];
	/** Whether a `find`/`where` has been seen in the current group. */
	const queryFlags: boolean[] = [];
	/** The byte that closes each open delimiter, innermost last. */
	const expectedClosers: string[] = [];
	let word = "";
	/**
	 * Offset where the current word began, so the byte IMMEDIATELY before it can
	 * be inspected. Immediacy is the whole point: `comment=find` is a value and
	 * `comment="a" find` is not, and a "last non-space byte" rule cannot tell
	 * them apart — it blocked both.
	 */
	let wordStart = -1;
	let i = 0;
	while (i < text.length) {
		const ch = text[i] as string;
		if (ch === "#") {
			const nl = text.indexOf("\n", i);
			i = nl < 0 ? text.length : nl;
			word = "";
			continue;
		}
		if (ch === '"') {
			const scan = scanQuotedString(text, i);
			i = scan.end > i + 1 ? scan.end : i + 1;
			word = "";
			continue;
		}
		if (OPENERS.includes(ch)) {
			openers.push(ch);
			expectedClosers.push(CLOSERS[OPENERS.indexOf(ch)] as string);
			queryFlags.push(false);
			word = "";
			i++;
			continue;
		}
		if (CLOSERS.includes(ch)) {
			// Pop only a MATCHING closer. A stray `)` in `[find x=1) y=2]` would
			// otherwise discard the `[` and move every later `=` in that script to
			// top level — and 37 of the 948 corpus scripts carry a mismatched
			// closer, so this is not a hypothetical. An unmatched closer is
			// malformed source: leave the stack alone and keep reading.
			if (expectedClosers[expectedClosers.length - 1] === ch) {
				openers.pop();
				expectedClosers.pop();
				queryFlags.pop();
			}
			word = "";
			i++;
			continue;
		}
		if (/[A-Za-z-]/.test(ch)) {
			if (word === "") wordStart = i;
			word += ch;
			i++;
			// A query verb governs every `k=v` after it, to the end of its group —
			// but only in COMMAND position. After `=` or `$` the word is a value or
			// a variable name, and `[set comment=find other=x]` must not read as a
			// query. The corpus carries three such spellings, one of them the
			// pathological `find=.id=*8;name=find`.
			const before = wordStart > 0 ? (text[wordStart - 1] as string) : "";
			if (
				QUERY_VERBS.has(word) &&
				!/[A-Za-z-]/.test(text[i] ?? "") &&
				before !== "=" &&
				before !== "$" &&
				before !== '"'
			) {
				if (queryFlags.length > 0) queryFlags[queryFlags.length - 1] = true;
			}
			continue;
		}
		if (ch === "=") {
			out.push({
				offset: i,
				opener: openers[openers.length - 1] ?? "",
				query: queryFlags[queryFlags.length - 1] ?? false,
			});
		}
		word = "";
		i++;
	}
	return out;
}

/**
 * The class `explainCommand` assigns to each `=` byte, keyed by ANALYZED offset.
 *
 * Token offsets index the analyzed surface — UTF-8 byte counts with every
 * non-ASCII byte substituted — not the original UTF-16 string. 112 of the 948
 * corpus scripts carry non-ASCII, 35 of them alongside a bracket `=`, so
 * indexing the original here shifted or missed the byte on every one of them.
 * Both sides now work in the analyzed space; see {@link analyzedSurface}.
 */
function classesOfEquals(analyzed: string, text: string): Map<number, string> {
	const classes = new Map<number, string>();
	const result = explainCommand(text, { tokens: true });
	for (const token of result.tokens ?? [])
		for (let at = token.start; at < token.end; at++)
			if (analyzed[at] === "=") classes.set(at, token.class);
	return classes;
}

/**
 * The surface `explainCommand` analyzes, as a string one char per byte.
 *
 * `analyzeCoordinates` is the same helper `explainCommand` uses, so this cannot
 * drift from it. Non-ASCII bytes arrive substituted, which is exactly right for
 * a structural scan: a substituted byte is never `=`, `[`, `"` or `#`, so it
 * can neither open a group nor be counted as a separator.
 */
function analyzedSurface(text: string): string {
	const bytes = analyzeCoordinates(text).analyzed;
	let out = "";
	for (let i = 0; i < bytes.length; i++)
		out += String.fromCharCode(bytes[i] as number);
	return out;
}

export function census(
	scripts: readonly { text: string; il?: string }[],
	ilComparisonNodes: Record<string, number>,
): BracketEqualsCensus {
	const result: BracketEqualsCensus = {
		scripts: scripts.length,
		scriptsWithBracketEquals: 0,
		bracketEquals: 0,
		queryComparisons: 0,
		argumentSeparators: 0,
		expressionEquals: 0,
		bracketEqualsByClass: {},
		unclassifiedQuery: 0,
		unclassifiedArgument: 0,
		ilComparisonNodes,
		ilCorroboration: {
			build: CORROBORATION_BUILD,
			scriptsWithQueryEquals: 0,
			corroborated: 0,
			commandUnresolved: 0,
			rejectedParse: 0,
		},
	};
	for (const { text, il } of scripts) {
		// Both sides in the ANALYZED coordinate space, or the class attribution
		// silently shifts on every script carrying non-ASCII.
		const analyzed = analyzedSurface(text);
		const sites = scanEqualsSites(analyzed);
		const classes = classesOfEquals(analyzed, text);
		let bracketHere = 0;
		for (const site of sites) {
			if (site.opener === "(") result.expressionEquals++;
			if (site.opener !== "[") continue;
			bracketHere++;
			result.bracketEquals++;
			if (site.query) result.queryComparisons++;
			else result.argumentSeparators++;
			const cls = classes.get(site.offset) ?? "<absent>";
			result.bracketEqualsByClass[cls] =
				(result.bracketEqualsByClass[cls] ?? 0) + 1;
			if (cls === "unclassified") {
				if (site.query) result.unclassifiedQuery++;
				else result.unclassifiedArgument++;
			}
		}
		if (bracketHere > 0) result.scriptsWithBracketEquals++;

		const queryHere = sites.filter(
			(site) => site.opener === "[" && site.query,
		).length;
		if (queryHere === 0 || il === undefined) continue;
		const co = result.ilCorroboration;
		co.scriptsWithQueryEquals++;
		if (CONSOLE_REJECTION.test(il)) co.rejectedParse++;
		else if ((il.match(/\(= /g) ?? []).length >= queryHere) co.corroborated++;
		else co.commandUnresolved++;
	}
	return result;
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
	"bracket-equals.json",
);

const BLOCK_BEGIN =
	"<!-- BEGIN GENERATED bracket-equals — regenerate with `bun run explain:bracket-equals:readme` -->";
const BLOCK_END = "<!-- END GENERATED bracket-equals -->";

export function splitLines(text: string): string[] {
	return text.split(/\r?\n/);
}

function lineEndingOf(text: string): string {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function pct(part: number, whole: number): string {
	return whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`;
}

/** Render the README's generated paragraph from a census result. */
export function renderReadmeBlock(c: BracketEqualsCensus): string[] {
	const argSep = c.bracketEqualsByClass["arg-sep"] ?? 0;
	const unclassified = c.bracketEqualsByClass["unclassified"] ?? 0;
	// Version order, not lexicographic: a plain `.sort()` puts `7.10` before
	// `7.9`. The three current builds happen to sort correctly either way,
	// which is exactly why this would have gone unnoticed.
	const builds = Object.keys(c.ilComparisonNodes).sort(compareRouterOsVersion);
	const co = c.ilCorroboration;
	return [
		`Measured by \`bun run explain:bracket-equals\` over the pinned corpus:`,
		`**${c.bracketEquals.toLocaleString()}** \`=\` bytes sit inside \`[ … ]\`, across`,
		`${c.scriptsWithBracketEquals} of ${c.scripts.toLocaleString()} scripts, and **${unclassified.toLocaleString()}** of them come back`,
		`\`unclassified\` — the operator fill abstains on essentially all of it. No`,
		`later fill rescues them: the \`arg\` fill claims **${argSep.toLocaleString()}**, because it offers only`,
		`the \`=\` its own located argument token names and a \`[ … ]\` substitution is`,
		`not where it locates arguments.`,
		"",
		`Of those ${unclassified.toLocaleString()}, **${c.unclassifiedQuery.toLocaleString()}** are governed by a \`find\`/\`where\` query and are`,
		`genuine comparisons — the device lowers \`[find address=$IP]\` to`,
		`\`(= $address $IP)\` — against **${c.unclassifiedArgument.toLocaleString()}** plain \`arg=value\`. So abstaining is`,
		`${pct(c.unclassifiedQuery, Math.max(unclassified, 1))} wrong and claiming the lot would be ${pct(c.unclassifiedArgument, Math.max(unclassified, 1))} wrong; a \`where\`-aware`,
		`fill can take the query half later. For contrast the fill does claim`,
		`**${c.expressionEquals.toLocaleString()}** \`=\` bytes whose innermost opener is \`(\`.`,
		"",
		`The query reading is the device's, not a guess: on ${co.build}, ${co.corroborated} of the`,
		`${co.scriptsWithQueryEquals} scripts carrying one have IL with at least as many \`(= …)\` nodes.`,
		`Of the rest, ${co.rejectedParse} are scripts the console refused outright — their IL is prose,`,
		`with no nodes of any kind — and ${co.commandUnresolved} use a menu the capture build could not`,
		`resolve (a forum snippet on \`/interface wireless\` answers \`bad command name`,
		`wireless\`), so the device never reached the query to lower it. Neither is a`,
		`counter-example to the reading. Whole-corpus \`(= …)\` head nodes, which also`,
		`count expression comparisons the fill already claims:`,
		`${builds.map((b) => `${b} ${(c.ilComparisonNodes[b] ?? 0).toLocaleString()}`).join(", ")}.`,
	];
}

function readFixtureCensus(): BracketEqualsCensus {
	return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as BracketEqualsCensus;
}

export function runReadme(check: boolean): number {
	const rendered = renderReadmeBlock(readFixtureCensus());
	const readme = readFileSync(README_PATH, "utf8");
	const lines = splitLines(readme);
	const begin = lines.indexOf(BLOCK_BEGIN);
	const end = lines.indexOf(BLOCK_END);
	if (begin < 0 || end < begin) {
		console.error(
			"::error title=explain bracket equals::commands/explain/README.md is missing the generated bracket-equals block markers",
		);
		return 1;
	}
	const current = lines.slice(begin + 1, end);
	if (current.join("\n") === rendered.join("\n")) {
		if (!check) console.error("bracket-equals README block already current");
		return 0;
	}
	if (check) {
		console.error(
			"::error title=explain bracket equals::commands/explain/README.md no longer matches " +
				"test/fixtures/explain/bracket-equals.json. Run `bun run explain:bracket-equals:readme`.",
		);
		console.error(`--- README\n${current.join("\n")}`);
		console.error(`+++ fixture\n${rendered.join("\n")}`);
		return 1;
	}
	writeFileSync(
		README_PATH,
		[...lines.slice(0, begin + 1), ...rendered, ...lines.slice(end)].join(
			lineEndingOf(readme),
		),
	);
	console.error(
		"rewrote the bracket-equals block in commands/explain/README.md",
	);
	return 0;
}

function renderMarkdown(c: BracketEqualsCensus): string {
	const byClass = Object.entries(c.bracketEqualsByClass).sort(
		(a, b) => b[1] - a[1],
	);
	return [
		`scripts: ${c.scripts} (${c.scriptsWithBracketEquals} carry a bracket \`=\`)`,
		"",
		`bracket-interior \`=\`: ${c.bracketEquals} ` +
			`(${c.queryComparisons} query, ${c.argumentSeparators} argument)`,
		`expression \`=\` the fill claims: ${c.expressionEquals}`,
		"",
		"| final class | `=` bytes | share |",
		"| ----------- | --------: | ----: |",
		...byClass.map(
			([cls, n]) => `| \`${cls}\` | ${n} | ${pct(n, c.bracketEquals)} |`,
		),
		"",
		`live abstention cost: ${c.unclassifiedQuery} query + ` +
			`${c.unclassifiedArgument} argument = ` +
			`${c.unclassifiedQuery + c.unclassifiedArgument}`,
		`IL \`(= …)\` nodes: ${Object.entries(c.ilComparisonNodes)
			.sort(([a], [b]) => compareRouterOsVersion(a, b))
			.map(([v, n]) => `${v} ${n}`)
			.join(", ")}`,
	].join("\n");
}

export async function main(args: readonly string[]): Promise<number> {
	// Before any corpus resolution: the doc gate reads the fixture, so it must
	// run in CI and from a bare clone, where `corpus.sqlite` does not exist.
	if (args.includes("--readme")) return runReadme(args.includes("--check"));
	const resolution = resolveCorpusDb(flag(args, "--db"));
	if (resolution.warning)
		console.error(
			`::warning title=explain bracket equals::${resolution.warning}`,
		);
	const dbPath = resolution.path;
	if (dbPath === undefined || !(await Bun.file(dbPath).exists())) {
		console.error(unreachableMessage("explain bracket equals"));
		return 1;
	}
	console.error(describeResolution(resolution));

	const db = new Database(dbPath, { readonly: true });
	let scripts: { text: string; il?: string }[];
	const ilComparisonNodes: Record<string, number> = {};
	try {
		// LEFT JOIN: `source_scripts` is version-independent and always holds all
		// 948, while a probe table may not — a script with no row on the
		// corroboration build must still count in the denominator.
		scripts = (
			db
				.query(
					"SELECT s.text AS text, p.il_text AS il FROM source_scripts s " +
						"LEFT JOIN parseil_results p " +
						"ON p.script_id = s.id AND p.routeros_version = ? " +
						"ORDER BY s.path",
				)
				.all(CORROBORATION_BUILD) as { text: string; il: string | null }[]
		).map((row) => ({ text: row.text, il: row.il ?? undefined }));
		// Only the version-comparable builds, for the same reason the operator
		// census filters: a partial capture cannot support a count.
		const complete = (
			db
				.query(
					"SELECT routeros_version AS version FROM v_version_coverage " +
						"WHERE coverage_class = 'complete' ORDER BY routeros_version",
				)
				.all() as { version: string }[]
		).map((row) => row.version);
		for (const version of complete) {
			const rows = db
				.query(
					"SELECT il_text AS il FROM parseil_results " +
						"WHERE routeros_version = ? AND il_text IS NOT NULL",
				)
				.all(version) as { il: string }[];
			let nodes = 0;
			for (const row of rows) nodes += (row.il.match(/\(= /g) ?? []).length;
			ilComparisonNodes[version] = nodes;
		}
	} finally {
		db.close();
	}

	const result = census(scripts, ilComparisonNodes);

	if (args.includes("--check")) {
		// A gate cannot pass on an unstated premise. `resolveCorpusDb` prefers a
		// sibling checkout over the pinned cache and only WARNS when it is not the
		// pin, so without this a green "matches the committed fixture" could have
		// been measured against a corpus nobody else has. Same guard, same reason,
		// as `explain-operator-census.ts`.
		if (resolution.warning) {
			console.error(
				"::error title=explain bracket equals::refusing to check against a " +
					"corpus that is not the pinned snapshot — the result would not be " +
					"comparable to CI's.",
			);
			return 1;
		}
		const committed = readFixtureCensus();
		const drift: string[] = [];
		for (const [key, value] of Object.entries(result)) {
			const was = (committed as unknown as Record<string, unknown>)[key];
			if (JSON.stringify(was) !== JSON.stringify(value))
				drift.push(
					`${key}: fixture ${JSON.stringify(was)}, measured ${JSON.stringify(value)}`,
				);
		}
		if (drift.length === 0) {
			console.error("bracket-equals census matches the committed fixture");
			return 0;
		}
		console.error(
			"::error title=explain bracket equals::the census no longer matches " +
				"test/fixtures/explain/bracket-equals.json. Re-adopt with " +
				"`bun run explain:bracket-equals --json`.",
		);
		for (const line of drift) console.error(`  ${line}`);
		return 1;
	}

	if (args.includes("--json")) {
		console.log(JSON.stringify(result, null, "\t"));
		return 0;
	}
	console.log(renderMarkdown(result));
	return 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
