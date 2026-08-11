#!/usr/bin/env bun
/**
 * Genre census over the phase-0/0.5 `explain` corpus (issue #203, deliverable 0).
 *
 * The corpus (`lsp-routeros-ts/test-data/corpus.sqlite`, `source_scripts`
 * table) is a self-selected subset of forum-scraped scripts — 96.8% from two
 * forum authors, genuine `/export` output ~1%. That bias is load-bearing on
 * every module promoted out of the phase-0.5 lab, and #203 requires it be
 * re-derivable from a checked-in script rather than re-discovered from an
 * ad-hoc regex pass. This is that script.
 *
 * Markers are independent booleans (a file can trip several). Against the
 * frozen 913-script corpus #203 was filed on, eight of the eleven baseline
 * markers reproduce the issue's manually-eyeballed figures exactly. The other
 * three differ, and in two of them the script — not the issue — is right:
 *
 * - **`export-banner` 9, issue 8.** The issue's own correction says a naive
 *   `# … by RouterOS` pass returns 22 and that 13 of those are eworm `#!rsc`
 *   shebangs. 22 − 13 = 9, so the "8" was an arithmetic slip. Both the naive
 *   22 and the shebang 13 reproduce exactly here.
 * - **`pure-config` 21, issue 23.** The first cut read "zero `:` directives"
 *   as any `:` before a letter, which also excludes MAC addresses
 *   (`02:23:06:EB`), IPv6 literals (`2001:db8::a`) and DHCP client-ids
 *   (`1:c0:25:…`) — i.e. it systematically under-counts exactly the config
 *   genre #203 is about, giving 17. `SCRIPTING_COLON_TOKEN` below keys on
 *   *position* instead, which is the intended reading and lands at 21.
 * - **`export-idiom` 37, issue 35.** "Bare menu line **then** `add`/`set`" is
 *   read here as genuine adjacency at column 0 (the shape a device emits).
 *   Treating the two conditions as an unordered conjunction gives 40;
 *   allowing indented pastes gives 45.
 *
 * Review found five detector defects after those figures were first
 * published. All five reproduce on hand-written input; the three baseline
 * markers above were unaffected by every one of them, but the `terse-*`
 * markers were **not** — see below. The corpus is well-formed and one genre,
 * so a detector being corpus-green is not evidence it is right (the lesson
 * #201 drew, and the reason #203 exists), and each fix carries a regression:
 *
 * - `isTerseStatement` — a verb-shaped *positional operand* read as a verb
 *   (`/system script run add` runs a script named `add`).
 * - `isBareMenuLine` — a slash-led *command* accepted as navigation
 *   (`/system resource print`).
 * - `SCRIPTING_COLON_TOKEN` — a colon inside an ordinary value read as a
 *   directive (`comment="policy:allow"`).
 * - `pathSegments` — the two path detectors split on whitespace only, hiding
 *   a command word inside a slash-joined path. RouterOS treats `/` and
 *   whitespace as interchangeable, so all four spellings of
 *   `/system script run` must tokenize alike. **This one moved the numbers:**
 *   it was also under-counting the fully slash-joined statement form
 *   (`/file/add name=x`, the eworm style), taking `terse-statement`
 *   100 -> 141 and `terse-export-doc` 19 -> 29 on the frozen corpus. Both are
 *   corrected under-counts, verified file by file; `eworm` moves 0 -> 7 on
 *   `terse-statement` and stays 0 on `terse-export-doc`.
 * - `maskOpaqueQuotedValues` — position alone cannot separate
 *   `comment=":allow"` from `source=":put x"`; inside quotes they are the
 *   same shape and only the key says which is script.
 * - `SCRIPT_BEARING_KEY` — the key list behind that mask was a closed set and
 *   was wrong three rounds running, missing `up-script`, `down-script`,
 *   `lease-script`, `on-boot`, `on-message`, `on-master` and `on-backup`, all
 *   present in the corpus. It is now a shape rule over RouterOS's own naming
 *   convention (`…script`, `on-…`), because enumerating a schema by review
 *   round is the failure mode, not the missing entries.
 *
 * The two `terse-*` markers have no #203 baseline: they were added after the
 * tangentsoft import (35 genuine `/export … terse` device captures) showed
 * that every baseline config marker scores **zero** on one-line-per-statement
 * export output, because `export-idiom` and `pure-config` both assume the
 * multi-line `compact`/`verbose` shape where the menu path sits on its own
 * line. A census blind to a whole serialization of the genre it exists to
 * measure would have reported "the import changed nothing".
 *
 * Re-deriving is the point: this script is the source of truth, not a replica
 * of the issue's prose.
 *
 * Usage:
 *   bun run explain:corpus-census              # markdown report to stdout
 *   bun run explain:corpus-census --json        # machine-readable, for #203 deliverable 2 scoring
 *   bun run explain:corpus-census --compare     # markdown report + delta vs the #203 baseline table
 *   bun run explain:corpus-census --db <path>   # override the corpus.sqlite location
 *
 * The corpus lives in the sibling `lsp-routeros-ts` repo, not in centrs — see
 * `docs/CONSTITUTION.md` / #203 "Longer term" for the corpus-ownership split.
 * A sibling checkout is used when present; otherwise the pinned snapshot from
 * `bun run corpus:fetch`. `CENTRS_CORPUS_DB` or `--db` point elsewhere, and the
 * source plus its sha256 are announced on stderr — see `corpus-fetch.ts`.
 */

import { Database } from "bun:sqlite";
import {
	describeResolution,
	resolveCorpusDb,
	unreachableMessage,
} from "./corpus-fetch.ts";

export interface CorpusRow {
	path: string;
	collection: string;
	text: string;
	hasCliPrompt: boolean;
}

export interface Marker {
	key: string;
	label: string;
	/**
	 * Count from the #203 issue table, for `--compare`. Absent for markers
	 * added after the issue was filed — those have nothing to compare against.
	 */
	baseline?: number;
	test: (row: CorpusRow) => boolean;
}

/**
 * Total scripts in the frozen corpus #203's baseline figures were measured on.
 * `--compare` deltas are only marker-vs-marker when the corpus still has this
 * many rows; past that, part of every delta is corpus growth.
 */
export const BASELINE_TOTAL = 913;

function firstLine(text: string): string {
	const newline = text.indexOf("\n");
	return newline === -1 ? text : text.slice(0, newline);
}

function lines(text: string): string[] {
	return text.split(/\r?\n/);
}

const ADD_OR_SET_LINE = /^(?:add|set)\b/m;

// The nine control-flow/declaration keywords that reproduce the issue's 491
// exactly: :local :global :if :foreach :while :do :for :function :execute.
const CORE_SCRIPTING_DIRECTIVES =
	/:(?:local|global|if|foreach|while|do|for|function|execute)\b/;

// Any colon-prefixed identifier — `:put`, `[:deserialize`, `:toarray`. What
// separates a directive from a colon inside a *value* is position, not
// content: a directive only ever opens a token. Matching on content alone
// (even with a hex-digit guard for `02:23:06:EB` and `2001:db8::a`) counts
// `comment="policy:allow"` as scripting and under-counts config.
//
// Position alone is not sufficient either. Inside quotes, `comment=":allow"`
// and `source=":put x"` are the same shape, and only the *key* says which is
// script text. So quoted values are masked first unless their key carries
// script (below), and the position rule runs over what is left — quotes stay
// openers so a directive at the very start of a `source="…"` still registers.
const SCRIPTING_COLON_TOKEN = /(?:^|[\s[{(;,"'!]):[A-Za-z]/m;

/**
 * Keys whose value is RouterOS script text rather than opaque data.
 *
 * This is a **shape rule, not an enumeration**, and deliberately so: a closed
 * list was wrong three times in a row, missing `up-script`, `down-script`,
 * `lease-script`, `on-boot`, `on-message`, `on-master` and `on-backup` — all
 * of which appear in the corpus today. RouterOS names these consistently:
 *
 * - anything ending in `script` (`source` aside): `script`, `up-script`,
 *   `down-script`, `test-script`, `lease-script`;
 * - anything beginning `on-`, the event-hook convention: `on-event`,
 *   `on-error`, `on-boot`, `on-login`, `on-logout`, `on-master`, `on-backup`,
 *   `on-up`, `on-down`, `on-message`.
 *
 * A hook may hold a script *name* rather than inline code, which is
 * indistinguishable offline — treating both as script is the safe direction
 * for this marker, since it errs toward "this document contains script".
 */
const SCRIPT_BEARING_KEY = /(?:^source$|script$|^on-)/;

/** A quoted value, with backslash escapes, captured together with its key. */
const KEYED_QUOTED_VALUE = /([A-Za-z][\w-]*)=("(?:\\.|[^"\\])*")/g;

/**
 * Blank out quoted values that cannot be script, so a colon inside ordinary
 * prose (`comment="policy :allow"`) is not read as a directive. Length is
 * preserved so nothing else shifts.
 */
function maskOpaqueQuotedValues(text: string): string {
	return text.replace(
		KEYED_QUOTED_VALUE,
		(match, key: string, value: string) =>
			SCRIPT_BEARING_KEY.test(key.toLowerCase())
				? match
				: `${key}=${" ".repeat(value.length)}`,
	);
}

function hasScriptingColonToken(text: string): boolean {
	return SCRIPTING_COLON_TOKEN.test(maskOpaqueQuotedValues(text));
}

/**
 * RouterOS commands that are not export verbs. Their presence proves a line is
 * doing something other than navigating or writing configuration, so they end
 * a path: in `/system script run add`, `add` is the script's *name*, and in
 * `/system resource print` the line is a command, not a menu.
 *
 * Offline this is a heuristic — telling a path segment from a command word is
 * Q6's irreducible ambiguity — but a closed list of common commands removes
 * the cases a census would otherwise miscount.
 */
const NON_EXPORT_COMMANDS = new Set([
	"print",
	"run",
	"get",
	"find",
	"monitor",
	"export",
	"import",
	"reset",
	"enable",
	"disable",
	"move",
	"edit",
	"scan",
	"check-installation",
]);

/**
 * Split a statement's leading path into segments. RouterOS accepts `/` and
 * whitespace interchangeably as separators, so `/system script run`,
 * `/system/script/run` and the mixed `/system script/run` are the same path
 * and must tokenize the same way — splitting on whitespace alone hides a
 * command word inside a slash-joined path.
 *
 * Splitting stops at the first argument, because values legitimately contain
 * slashes (`address=1.2.3.4/24`).
 */
function pathSegments(line: string): string[] {
	const segments: string[] = [];
	for (const token of line.trim().split(/\s+/)) {
		if (token.includes("=")) break;
		for (const segment of token.split("/")) {
			if (segment !== "") segments.push(segment);
		}
	}
	return segments;
}

/**
 * A menu path on its own line at column 0 — the `compact`/`verbose` shape.
 * `/system resource print` is a command, not a menu, so it is not one, in any
 * of its separator spellings.
 */
function isBareMenuLine(line: string): boolean {
	if (line.length <= 1 || !line.startsWith("/") || line.includes("=")) {
		return false;
	}
	if (line.trimEnd() !== line) return false;
	return !pathSegments(line).some((segment) =>
		NON_EXPORT_COMMANDS.has(segment),
	);
}

/**
 * The `compact`/`verbose` export idiom: a bare menu line whose next statement
 * (blank lines and comments skipped) is a relative `add`/`set`.
 */
function hasExportIdiom(text: string): boolean {
	const all = lines(text);
	for (let i = 0; i < all.length - 1; i++) {
		if (!isBareMenuLine(all[i] as string)) continue;
		for (let j = i + 1; j < all.length; j++) {
			const next = all[j] as string;
			if (next.trim() === "" || next.trimStart().startsWith("#")) continue;
			if (ADD_OR_SET_LINE.test(next)) return true;
			break;
		}
	}
	return false;
}

const EXPORT_VERBS = new Set(["add", "set", "remove", "unset"]);

/**
 * A `terse` export statement: absolute path and verb on one line, e.g.
 * `/ip address add address=192.168.88.1/24` or `/port set 0 name=serial0`.
 *
 * The verb must be the first path segment that is not a menu name — anything
 * later means the word is an operand, not the command. `/system script run
 * add` runs a script *named* `add`, in every separator spelling.
 */
function isTerseStatement(line: string): boolean {
	if (!line.trim().startsWith("/")) return false;
	const segments = pathSegments(line);
	for (let i = 1; i < segments.length; i++) {
		const segment = segments[i] as string;
		// A command already claimed the line, so no verb can follow.
		if (NON_EXPORT_COMMANDS.has(segment)) return false;
		if (EXPORT_VERBS.has(segment)) return true;
	}
	return false;
}

/** A document whose every non-blank, non-comment line is a terse statement. */
function isTerseExportDocument(text: string): boolean {
	const body = lines(text)
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
	return body.length > 0 && body.every(isTerseStatement);
}

export const MARKERS: readonly Marker[] = [
	{
		key: "harness-header",
		label:
			"harness-injected `# Source: https://forum.mikrotik.com/…` first line",
		baseline: 884,
		test: (row) =>
			firstLine(row.text).startsWith("# Source: https://forum.mikrotik.com"),
	},
	{
		key: "scripting-directives",
		label: "carries `:local`/`:global`/`:if`/… scripting directives",
		baseline: 491,
		test: (row) => CORE_SCRIPTING_DIRECTIVES.test(row.text),
	},
	{
		key: "cli-prompt-paste",
		label: "CLI-prompt paste (`[admin@…] >`)",
		baseline: 75,
		test: (row) => row.hasCliPrompt,
	},
	{
		key: "terse-statement",
		label: "carries a `terse` one-line statement (`/ip address add …`)",
		test: (row) => lines(row.text).some(isTerseStatement),
	},
	{
		key: "line-continuation",
		label: "line continuation (`\\` at EOL)",
		baseline: 63,
		test: (row) => /\\\r?\n/.test(row.text),
	},
	{
		key: "terse-export-doc",
		label: "wholly `terse` export document (every statement a one-liner)",
		test: (row) => isTerseExportDocument(row.text),
	},
	{
		key: "export-idiom",
		label: "bare menu line then `add`/`set` (the export idiom)",
		baseline: 35,
		test: (row) => hasExportIdiom(row.text),
	},
	{
		key: "pure-config",
		label: "pure `add`/`set` config, zero scripting directives",
		baseline: 23,
		test: (row) =>
			ADD_OR_SET_LINE.test(row.text) && !hasScriptingColonToken(row.text),
	},
	{
		key: "eworm-shebang",
		label: "`#!rsc by RouterOS` shebang (eworm style)",
		baseline: 13,
		test: (row) => /^#!rsc by RouterOS/m.test(row.text),
	},
	{
		key: "export-banner",
		label: "genuine `/export` banner (`# <date> by RouterOS <version>`)",
		baseline: 8,
		// Excludes the eworm shebang above (`#!`) — the issue's own correction:
		// shebang and timestamped banner are different genres, not one count.
		test: (row) => /^#(?!!) .*by RouterOS \S/m.test(row.text),
	},
	{
		key: "software-id",
		label: "`# software id =`",
		baseline: 6,
		test: (row) => /^# software id =/m.test(row.text),
	},
	{
		key: "script-in-string",
		label: 'script-in-string (`source="…"`)',
		baseline: 3,
		test: (row) => /source="/.test(row.text),
	},
	{
		key: "script-in-brace",
		label: "script-in-brace (`source={…}`)",
		baseline: 2,
		test: (row) => /source=\{/.test(row.text),
	},
];

export interface MarkerResult {
	key: string;
	label: string;
	baseline?: number;
	files: number;
	/** Files tripping this marker, per collection — #203 deliverable 2 forbids
	 * quoting a blended figure, so the strata are always carried. */
	byCollection: Record<string, number>;
}

export interface CensusResult {
	total: number;
	baselineTotal: number;
	byCollection: { collection: string; files: number }[];
	byMarker: MarkerResult[];
}

export function census(rows: readonly CorpusRow[]): CensusResult {
	const byCollectionMap = new Map<string, number>();
	for (const row of rows) {
		byCollectionMap.set(
			row.collection,
			(byCollectionMap.get(row.collection) ?? 0) + 1,
		);
	}
	const byCollection = [...byCollectionMap.entries()]
		.map(([collection, files]) => ({ collection, files }))
		.sort(
			(a, b) => b.files - a.files || a.collection.localeCompare(b.collection),
		);

	const byMarker = MARKERS.map((marker) => {
		const strata: Record<string, number> = {};
		for (const { collection } of byCollection) strata[collection] = 0;
		let files = 0;
		for (const row of rows) {
			if (!marker.test(row)) continue;
			files++;
			strata[row.collection] = (strata[row.collection] ?? 0) + 1;
		}
		const result: MarkerResult = {
			key: marker.key,
			label: marker.label,
			files,
			byCollection: strata,
		};
		if (marker.baseline !== undefined) result.baseline = marker.baseline;
		return result;
	});

	return {
		total: rows.length,
		baselineTotal: BASELINE_TOTAL,
		byCollection,
		byMarker,
	};
}

function pct(n: number, total: number): string {
	return total === 0 ? "0.0%" : `${((n / total) * 100).toFixed(1)}%`;
}

export function renderMarkdown(
	result: CensusResult,
	opts: { compare: boolean },
): string {
	const out: string[] = [
		"# explain corpus genre census",
		"",
		`Total scripts: ${result.total}`,
		"",
		"## By collection",
		"",
		"| Source | Scripts | Share |",
		"| ------ | ------- | ----- |",
	];
	for (const { collection, files } of result.byCollection) {
		out.push(`| \`${collection}\` | ${files} | ${pct(files, result.total)} |`);
	}

	out.push("", "## By genre marker", "");
	if (opts.compare) {
		if (result.total !== result.baselineTotal) {
			out.push(
				`> The #203 baseline was measured on ${result.baselineTotal} scripts,`,
				`> this corpus has ${result.total}. Deltas below mix marker drift with`,
				"> corpus growth — read them with the per-collection table.",
				"",
			);
		}
		out.push(
			"| Marker | Files | Share | #203 baseline | Delta |",
			"| ------ | ----- | ----- | -------------- | ----- |",
		);
		for (const { label, files, baseline } of result.byMarker) {
			const cells =
				baseline === undefined
					? "— | —"
					: `${baseline} | ${files - baseline > 0 ? `+${files - baseline}` : `${files - baseline}`}`;
			out.push(
				`| ${label} | ${files} | ${pct(files, result.total)} | ${cells} |`,
			);
		}
	} else {
		out.push("| Marker | Files | Share |", "| ------ | ----- | ----- |");
		for (const { label, files } of result.byMarker) {
			out.push(`| ${label} | ${files} | ${pct(files, result.total)} |`);
		}
	}

	out.push(
		"",
		"## Genre marker by collection",
		"",
		"Per #203 deliverable 2, never quote a marker as one blended figure.",
		"",
	);
	const collections = result.byCollection.map((c) => c.collection);
	out.push(
		`| Marker | ${collections.join(" | ")} |`,
		`| ------ | ${collections.map(() => "---").join(" | ")} |`,
	);
	for (const marker of result.byMarker) {
		const cells = collections.map((c) => String(marker.byCollection[c] ?? 0));
		out.push(`| ${marker.label} | ${cells.join(" | ")} |`);
	}

	out.push("");
	return out.join("\n");
}

export function flag(
	args: readonly string[],
	name: string,
): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	const value = args[index + 1];
	// A missing value would otherwise swallow the next option and report it as
	// a missing corpus — `--db --json` must not read as "no corpus at --json".
	if (value === undefined || value.startsWith("-")) {
		throw new Error(`${name} requires a value`);
	}
	return value;
}

function has(args: readonly string[], name: string): boolean {
	return args.includes(name);
}

function loadRows(dbPath: string): CorpusRow[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.query(
				"SELECT path, collection, text, has_cli_prompt FROM source_scripts",
			)
			.all()
			.map((r) => {
				const row = r as {
					path: string;
					collection: string;
					text: string;
					has_cli_prompt: number;
				};
				return {
					path: row.path,
					collection: row.collection,
					text: row.text,
					hasCliPrompt: row.has_cli_prompt === 1,
				};
			});
	} finally {
		db.close();
	}
}

export async function main(args: readonly string[]): Promise<number> {
	const resolution = resolveCorpusDb(flag(args, "--db"));
	// All of this goes to stderr, not stdout: `--json` is consumed as JSON. The
	// warning is emitted before the reachability check because a corrupt cache
	// both warns and fails to resolve, and "why" beats "no".
	if (resolution.warning) {
		console.error(
			`::warning title=explain corpus census::${resolution.warning}`,
		);
	}
	const dbPath = resolution.path;
	if (dbPath === undefined || !(await Bun.file(dbPath).exists())) {
		console.error(unreachableMessage("explain corpus census"));
		return 1;
	}
	console.error(describeResolution(resolution));

	const rows = loadRows(dbPath);
	const result = census(rows);

	if (has(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(renderMarkdown(result, { compare: has(args, "--compare") }));
	}
	return 0;
}

if (import.meta.main) {
	main(Bun.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(`::error title=explain corpus census::${String(error)}`);
			process.exit(1);
		});
}
