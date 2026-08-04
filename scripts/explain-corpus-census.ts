#!/usr/bin/env bun
/**
 * Genre census over the phase-0/0.5 `explain` corpus (issue #203, deliverable 0).
 *
 * The corpus (`lsp-routeros-ts/test-data/corpus.sqlite`, `source_scripts`
 * table) is a self-selected subset of forum-scraped scripts — 96.8% from two
 * forum authors, genuine `/export` output only 0.9%. That bias is load-bearing
 * on every module promoted out of the phase-0.5 lab, and #203 requires it be
 * re-derivable from a checked-in script rather than re-discovered from an
 * ad-hoc regex pass. This is that script.
 *
 * Markers are independent booleans (a file can trip several), matching the
 * table in #203. Ten of eleven were reproduced exactly against the corpus at
 * the time #203 was filed; the "pure add/set, zero directives" and "export
 * idiom" markers depend on how loosely "bare menu line" and "zero directive"
 * are read, and land within 1-5 files of the issue's manually-eyeballed
 * figures (`--compare` prints the delta — see the comments on each marker's
 * regex for the reading it encodes). Re-deriving is the point: this script is
 * the new source of truth, not a replica of the issue's prose.
 *
 * Usage:
 *   bun run explain:corpus-census              # markdown report to stdout
 *   bun run explain:corpus-census --json        # machine-readable, for #203 deliverable 2 scoring
 *   bun run explain:corpus-census --compare     # markdown report + delta vs the #203 baseline table
 *   bun run explain:corpus-census --db <path>   # override the corpus.sqlite location
 *
 * The corpus lives in the sibling `lsp-routeros-ts` repo, not in centrs — see
 * `docs/CONSTITUTION.md` / #203 "Longer term" for the corpus-ownership split.
 */

import { Database } from "bun:sqlite";

export interface CorpusRow {
	path: string;
	collection: string;
	text: string;
	hasCliPrompt: boolean;
}

export interface Marker {
	key: string;
	label: string;
	/** Baseline count from the #203 issue table, for `--compare`. */
	baseline: number;
	test: (row: CorpusRow) => boolean;
}

function firstLine(text: string): string {
	const newline = text.indexOf("\n");
	return newline === -1 ? text : text.slice(0, newline);
}

// A bare menu-path line: starts with `/`, carries no `=` (pure navigation, not
// a command with arguments). Matches both slash-joined ("/ip/address") and
// legacy space-joined ("/ip address") forms.
const BARE_MENU_LINE = /^\/[^\n=]*$/m;
const ADD_OR_SET_LINE = /^(?:add|set)\b/m;

// The nine control-flow/declaration keywords that reproduce the issue's 491
// exactly: :local :global :if :foreach :while :do :for :function :execute.
const CORE_SCRIPTING_DIRECTIVES =
	/:(?:local|global|if|foreach|while|do|for|function|execute)\b/;

// Any colon-prefixed identifier at all (broader than the core set above) —
// the reading of "zero : directives" used for the pure-add/set marker.
const ANY_COLON_TOKEN = /:[A-Za-z]/;

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
		key: "line-continuation",
		label: "line continuation (`\\` at EOL)",
		baseline: 63,
		test: (row) => /\\\r?\n/.test(row.text),
	},
	{
		key: "export-idiom",
		label: "bare menu line then `add`/`set` (the export idiom)",
		baseline: 35,
		test: (row) =>
			BARE_MENU_LINE.test(row.text) && ADD_OR_SET_LINE.test(row.text),
	},
	{
		key: "pure-config",
		label: "pure `add`/`set` config, zero `:` directives",
		baseline: 23,
		test: (row) =>
			ADD_OR_SET_LINE.test(row.text) && !ANY_COLON_TOKEN.test(row.text),
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

export interface CensusResult {
	total: number;
	byCollection: { collection: string; files: number }[];
	byMarker: { key: string; label: string; baseline: number; files: number }[];
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
		.sort((a, b) => b.files - a.files);

	const byMarker = MARKERS.map((marker) => ({
		key: marker.key,
		label: marker.label,
		baseline: marker.baseline,
		files: rows.filter((row) => marker.test(row)).length,
	}));

	return { total: rows.length, byCollection, byMarker };
}

function pct(n: number, total: number): string {
	return total === 0 ? "0.0%" : `${((n / total) * 100).toFixed(1)}%`;
}

export function renderMarkdown(
	result: CensusResult,
	opts: { compare: boolean },
): string {
	const lines: string[] = [
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
		lines.push(
			`| \`${collection}\` | ${files} | ${pct(files, result.total)} |`,
		);
	}

	lines.push("", "## By genre marker", "");
	if (opts.compare) {
		lines.push(
			"| Marker | Files | Share | #203 baseline | Delta |",
			"| ------ | ----- | ----- | -------------- | ----- |",
		);
		for (const { label, files, baseline } of result.byMarker) {
			const delta = files - baseline;
			const deltaStr = delta === 0 ? "0" : delta > 0 ? `+${delta}` : `${delta}`;
			lines.push(
				`| ${label} | ${files} | ${pct(files, result.total)} | ${baseline} | ${deltaStr} |`,
			);
		}
	} else {
		lines.push("| Marker | Files | Share |", "| ------ | ----- | ----- |");
		for (const { label, files } of result.byMarker) {
			lines.push(`| ${label} | ${files} | ${pct(files, result.total)} |`);
		}
	}
	lines.push("");
	return lines.join("\n");
}

function flag(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function has(args: readonly string[], name: string): boolean {
	return args.includes(name);
}

function defaultDbPath(): string {
	const home = Bun.env["HOME"];
	if (!home) throw new Error("HOME is not set; pass --db <path> explicitly");
	return `${home}/GitHub/lsp-routeros-ts/test-data/corpus.sqlite`;
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
	const dbPath = flag(args, "--db") ?? defaultDbPath();
	if (!(await Bun.file(dbPath).exists())) {
		console.error(
			`::error title=explain corpus census::corpus.sqlite not found at ${dbPath}\n` +
				"Clone/update the sibling lsp-routeros-ts repo, or pass --db <path>.",
		);
		return 1;
	}

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
