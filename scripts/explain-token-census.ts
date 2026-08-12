#!/usr/bin/env bun
/**
 * Token-partition census over the `explain` corpus (#264 B1).
 *
 * B1 emits `data.tokens[]`: a total, gapless byte partition where every byte in
 * `[0, input.bytes)` belongs to exactly one token, sorted by `start`, with no
 * gaps and `join(slice) === input`. Every byte no analyzer claims is
 * `unclassified`; filling those holes is B2. The `class` field is provisional
 * until #264 B5, and the deliverable here is a **number**: percent of corpus
 * bytes classified (not `unclassified`), reported the way the other census
 * figures are — a counter in a generated block, never prose (#260).
 *
 * That number is the progress bar for every B2 fill, and each fill PR should
 * move it.
 *
 * ```
 * bun run explain:token-census              # markdown
 * bun run explain:token-census --json       # the fixture's `corpus` block
 * bun run explain:token-census --check      # gate: fresh census vs the fixture
 * bun run explain:token-census --readme     # rewrite the README block from the fixture
 * bun run explain:token-census --readme --check # gate: README block vs the fixture
 * ```
 *
 * The corpus is not in this repo (see `corpus-fetch.ts` / #186). A sibling
 * `lsp-routeros-ts` checkout is used when present, otherwise the snapshot
 * pinned by `bun run corpus:fetch` (source + sha256 announced on stderr).
 */

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeCoordinates } from "../src/explain/coordinates.ts";
import { explainCommand } from "../src/explain.ts";
import {
	describeResolution,
	resolveCorpusDb,
	unreachableMessage,
} from "./corpus-fetch.ts";

export interface TokenCensus {
	sourceScripts: number;
	totalBytes: number;
	classifiedBytes: number;
	unclassifiedBytes: number;
	classifiedPct: number;
	totalTokens: number;
	avgTokensPerScript: number;
	classCounts: Record<string, number>;
	classByteCounts: Record<string, number>;
}

function bump(counts: Record<string, number>, key: string, by = 1): void {
	counts[key] = (counts[key] ?? 0) + by;
}

function flag(args: readonly string[], name: string): string | undefined {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
}

export function census(scripts: readonly string[]): TokenCensus {
	let totalBytes = 0;
	let classifiedBytes = 0;
	let totalTokens = 0;
	const classCounts: Record<string, number> = {};
	const classByteCounts: Record<string, number> = {};
	const invariantFailures: string[] = [];

	for (const text of scripts) {
		const data = explainCommand(text, { tokens: true });
		const tokensLocal = data.tokens ?? [];
		const bytes = data.input.bytes;
		totalBytes += bytes;
		totalTokens += tokensLocal.length;

		// Invariant checks (also the fact B1 must not break).
		if (bytes === 0) {
			if (tokensLocal.length !== 0)
				invariantFailures.push("empty input should have 0 tokens");
			continue;
		}
		if (tokensLocal.length === 0) {
			invariantFailures.push(`no tokens for non-empty input of ${bytes} bytes`);
			continue;
		}
		if (tokensLocal[0]?.start !== 0)
			invariantFailures.push("first token not at 0");
		if (tokensLocal[tokensLocal.length - 1]?.end !== bytes)
			invariantFailures.push("last token not at bytes");
		let hasInvalidRange = false;
		for (const t of tokensLocal) {
			if (
				!Number.isInteger(t.start) ||
				!Number.isInteger(t.end) ||
				t.start < 0 ||
				t.end <= t.start ||
				t.end > bytes ||
				t.start >= bytes
			) {
				invariantFailures.push(
					`invalid token range [${t.start},${t.end}) for bytes ${bytes}`,
				);
				hasInvalidRange = true;
				break;
			}
		}
		if (!hasInvalidRange) {
			for (let i = 1; i < tokensLocal.length; i++) {
				const cur = tokensLocal[i] as { start: number; end: number };
				const prev = tokensLocal[i - 1] as { start: number; end: number };
				if (cur.start !== prev.end) {
					invariantFailures.push(`gap/overlap at ${i}`);
					break;
				}
			}
			const analyzed = new TextDecoder().decode(
				analyzeCoordinates(text).analyzed,
			);
			const recon = tokensLocal
				.map((t) => analyzed.slice(t.start, t.end))
				.join("");
			if (recon !== analyzed) invariantFailures.push("join(slice) !== input");
		}

		for (const t of tokensLocal) {
			bump(classCounts, t.class);
			bump(classByteCounts, t.class, t.end - t.start);
			if (t.class !== "unclassified") classifiedBytes += t.end - t.start;
		}
	}

	if (invariantFailures.length > 0) {
		throw new Error(
			`token partition invariant violated: ${invariantFailures.slice(0, 5).join("; ")}`,
		);
	}

	const total = totalBytes;
	return {
		sourceScripts: scripts.length,
		totalBytes,
		classifiedBytes,
		unclassifiedBytes: total - classifiedBytes,
		classifiedPct: total === 0 ? 0 : (classifiedBytes / total) * 100,
		totalTokens,
		avgTokensPerScript: scripts.length === 0 ? 0 : totalTokens / scripts.length,
		classCounts,
		classByteCounts,
	};
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
	"tokens.json",
);

const BLOCK_INDENT = "  ";
const BLOCK_BEGIN = `${BLOCK_INDENT}<!-- BEGIN GENERATED token-census — regenerate with \`bun run explain:token-census:readme\` -->`;
const BLOCK_END = `${BLOCK_INDENT}<!-- END GENERATED token-census -->`;
const WRAP_COLUMNS = 78;

export function splitLines(text: string): string[] {
	return text.split(/\r?\n/);
}

function lineEndingOf(text: string): string {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

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

export function renderReadmeBlock(result: TokenCensus): string[] {
	const pct = result.classifiedPct.toFixed(2);
	return wrap(
		`The token census is re-derivable with \`bun run explain:token-census\` and ` +
			`covers ${count(result.sourceScripts)} source scripts. The figures below are generated from ` +
			"`test/fixtures/explain/tokens.json` → `corpus` by " +
			"`bun run explain:token-census:readme` and gated against it by " +
			"`bun run explain:token-census:readme:check`; the fixture itself is gated " +
			"against a fresh corpus run by `bun run explain:token-census:check`. " +
			`Of ${count(result.totalBytes)} analyzed bytes, ${count(result.classifiedBytes)} are ` +
			`classified (${pct}%), the remaining ${count(result.unclassifiedBytes)} are \`unclassified\`. ` +
			`The census emits ${count(result.totalTokens)} tokens ` +
			`(avg ${result.avgTokensPerScript.toFixed(1)} per script). ` +
			"Every byte belongs to exactly one token — sorted by `start`, no gaps, no overlaps, " +
			"`join(slice) === input` — and the `class` field is provisional until #264 B5. " +
			"Each B2 fill should move the classified percentage.",
	);
}

function readFixtureCensus(): TokenCensus {
	const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
		corpus?: TokenCensus;
	};
	if (fixture.corpus === undefined)
		throw new Error(`${FIXTURE_PATH} has no \`corpus\` block`);
	return fixture.corpus;
}

const PROVENANCE_KEYS: ReadonlySet<string> = new Set<string>([]);

function isCountMap(value: unknown): value is Record<string, number> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function diffAgainstFixture(
	fresh: TokenCensus,
	pinned: TokenCensus,
): string[] {
	const measured = fresh as unknown as Record<string, unknown>;
	const committed = pinned as unknown as Record<string, unknown>;
	const drift: string[] = [];
	for (const key of Object.keys(measured)) {
		if (PROVENANCE_KEYS.has(key)) continue;
		const a = measured[key];
		const b = committed[key];
		if (isCountMap(a) || isCountMap(b)) {
			const am = isCountMap(a) ? a : {};
			const bm = isCountMap(b) ? b : {};
			const names = [
				...new Set([...Object.keys(am), ...Object.keys(bm)]),
			].sort();
			for (const name of names) {
				if (am[name] === bm[name]) continue;
				drift.push(
					`${key}.${name}: fixture ${bm[name] ?? "absent"}, measured ${am[name] ?? "absent"}`,
				);
			}
			continue;
		}
		// classifiedPct is derived; compare with tolerance to 2 decimal places.
		if (key === "classifiedPct") {
			const da = typeof a === "number" ? a : 0;
			const db = typeof b === "number" ? b : 0;
			if (Math.abs(da - db) < 0.0001) continue;
			drift.push(`${key}: fixture ${b}, measured ${a}`);
			continue;
		}
		if (a !== b) drift.push(`${key}: fixture ${b}, measured ${a}`);
	}
	for (const key of Object.keys(committed)) {
		if (key in measured || PROVENANCE_KEYS.has(key)) continue;
		drift.push(`${key}: in the fixture, not measured`);
	}
	return drift;
}

export function runReadme(check: boolean): number {
	const rendered = renderReadmeBlock(readFixtureCensus());
	const readme = readFileSync(README_PATH, "utf8");
	const lines = splitLines(readme);
	const begin = lines.indexOf(BLOCK_BEGIN);
	const end = lines.indexOf(BLOCK_END);
	if (begin < 0 || end < begin) {
		console.error(
			`::error title=explain token census::commands/explain/README.md is missing the generated token-census block markers`,
		);
		return 1;
	}
	const current = lines.slice(begin + 1, end);
	if (current.join("\n") === rendered.join("\n")) {
		if (!check) console.error("token-census README block already current");
		return 0;
	}
	if (check) {
		console.error(
			"::error title=explain token census::commands/explain/README.md no longer matches " +
				"test/fixtures/explain/tokens.json → corpus. Run `bun run explain:token-census:readme`.",
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
	console.error("rewrote the token-census block in commands/explain/README.md");
	return 0;
}

export async function main(args: readonly string[]): Promise<number> {
	if (args.includes("--readme")) return runReadme(args.includes("--check"));
	const resolution = resolveCorpusDb(flag(args, "--db"));
	if (resolution.warning) {
		console.error(
			`::warning title=explain token census::${resolution.warning}`,
		);
	}
	if (args.includes("--check") && resolution.warning) {
		console.error(
			"::error title=explain token census::refusing to check against a " +
				"corpus that is not the pinned snapshot — the result would not be " +
				"comparable to CI's.",
		);
		return 1;
	}
	const dbPath = resolution.path;
	if (dbPath === undefined || !(await Bun.file(dbPath).exists())) {
		console.error(unreachableMessage("explain token census"));
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
				"::error title=explain token census::the census no longer matches " +
					"test/fixtures/explain/tokens.json → corpus. Repin with " +
					"`bun run explain:token-census --json`, then " +
					"`bun run explain:token-census:readme`, and update the assertions in " +
					"test/unit/explain-token-census.test.ts.",
			);
			for (const line of drift) console.error(`  ${line}`);
			return 1;
		}
		console.error("token census matches the committed fixture");
		return 0;
	}
	const out = args.includes("--json")
		? JSON.stringify(result, null, 2)
		: [
				"| figure | value |",
				"| ------ | ----- |",
				...Object.entries(result)
					.filter(([, v]) => typeof v === "number")
					.map(([k, v]) => `| \`${k}\` | ${v} |`),
				"",
				`classCounts: ${JSON.stringify(result.classCounts)}`,
				`classByteCounts: ${JSON.stringify(result.classByteCounts)}`,
			].join("\n");
	await Bun.write(Bun.stdout, `${out}\n`);
	return 0;
}

if (import.meta.main) {
	main(Bun.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(
				`::error title=explain token census::${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		});
}
