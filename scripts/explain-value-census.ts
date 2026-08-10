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
 * bun run explain:value-census            # markdown
 * bun run explain:value-census --json     # the fixture's `corpus` block
 * bun run explain:value-census --db PATH  # override the corpus.sqlite location
 * ```
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
import { resolve } from "node:path";
import { lexArguments, lexValueAnchors } from "../src/explain/args.ts";
import { valueShapeHints } from "../src/explain/values.ts";
import { resolveVerbs } from "../src/explain/verbsplit.ts";

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
				braceArrays: split.path === "/",
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
				} as Emitted & { name?: string };
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
				if ((entry as { name?: string }).name !== undefined)
					result.keyedElements++;
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
				result.strictComparableAnchors += kept.length;
				for (const entry of kept) {
					if (entry.kind === "element") continue;
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

/** The corpus lives in the sibling `lsp-routeros-ts` checkout, as in #203. */
export function defaultDbPath(): string {
	const override = Bun.env["CENTRS_CORPUS_DB"];
	if (override) return override;
	return resolve(
		import.meta.dir,
		"../../lsp-routeros-ts/test-data/corpus.sqlite",
	);
}

export async function main(args: readonly string[]): Promise<number> {
	const dbPath = flag(args, "--db") ?? defaultDbPath();
	if (!(await Bun.file(dbPath).exists())) {
		console.error(
			`::error title=explain value census::corpus.sqlite not found at ${dbPath}\n` +
				"Clone/update the sibling lsp-routeros-ts repo, or pass --db <path>.",
		);
		return 1;
	}
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
	console.log(
		args.includes("--json")
			? JSON.stringify(result, null, 2)
			: renderMarkdown(result),
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
