#!/usr/bin/env bun
/**
 * Price the two argument-reach designs of #316 against the pinned corpus.
 *
 * `lexArguments` is all-or-nothing: the first token it declines discards every
 * token already decoded, so ~48% of resolved argument lists reach no
 * token-level rule at all. #316 names two ways out and says the fork is
 * load-bearing rather than cosmetic:
 *
 *   - **A, stop-at-first-refusal** — publish the prefix decoded before the
 *     refusal, which is what `lexValueAnchors` already does for values.
 *   - **B, skip-and-continue** — keep walking past the undecodable token,
 *     publishing it located, with no `value`.
 *
 * Both are measured from ONE implementation: `lexArgumentTokens` is B, and A is
 * exactly its token list truncated at the first `undecided` token, because the
 * two walks share `args.ts`'s boundary rules and so agree token for token up to
 * that point. The sweep asserts that equivalence rather than assuming it, on
 * every corpus statement and in both directions — a READ statement's strict
 * tokens must be the tolerant walk's prefix, and a REFUSED one's design-A
 * prefix must be what the strict lexer returns when handed exactly those bytes.
 * It exits non-zero if any statement disagrees.
 *
 * The reported figure that decides the fork is **separator runs found**: the
 * reach numbers alone make A look adequate, and the run counts are what show it
 * is not.
 *
 * It also prices the reach one layer up, which is what #264 B5 read to split
 * the `=` out of `arg`. `tokens[]` paints from the tolerant reading, but the
 * ENVELOPE publishes `structure.statements[].arguments` only where the STRICT
 * one read. The `envelope*` figures count how many painted `arg-sep` runs a
 * consumer could NOT have located for itself by subtracting one from a
 * published `ExplainArgumentToken.valueSpan`, and name the argument spellings
 * that dominate them. That gap is measured through `explainCommand` rather than
 * the lexer, because it is a claim about the shipped result.
 *
 * ```
 * bun run explain:arg-reach
 * bun run explain:arg-reach --json
 * ```
 *
 * The corpus is not in this repo; see `scripts/corpus-fetch.ts` / #186.
 */

import { Database } from "bun:sqlite";
import { lexArguments, lexArgumentTokens } from "../src/explain/args.ts";
import { analyzeCoordinates } from "../src/explain/coordinates.ts";
import { resolveStatements } from "../src/explain/pathresolve.ts";
import { findMissingSeparators } from "../src/explain/separator.ts";
import { resolveVerbsFromStatements } from "../src/explain/verbsplit.ts";
import { explainCommand } from "../src/explain.ts";
import {
	describeResolution,
	resolveCorpusDb,
	unreachableMessage,
} from "./corpus-fetch.ts";

interface Reach {
	scripts: number;
	/** Resolved statements carrying an argument list this lexer may read. */
	candidates: number;
	/**
	 * Statements EXCLUDED from `candidates` because their bytes are not
	 * addressable — a normalized (non-ASCII) statement, or one whose span was
	 * widened to the enclosing statement. Reported rather than silently dropped,
	 * so the denominator above is honest: `explain.ts` refuses these too
	 * (`its text was normalized`), and a sweep that lexed them anyway would be
	 * measuring a reading the product does not offer.
	 */
	notAddressable: number;
	strictRead: number;
	strictRefused: number;
	/** Of the refused, those whose decoded PREFIX is non-empty (design A's reach). */
	refusedWithPrefix: number;
	tokensStrict: number;
	tokensDesignA: number;
	tokensDesignB: number;
	/** Statements design B reaches at all but design A does not (empty prefix). */
	onlyReachedByB: number;
	/** Tokens published with `undecided` — located, never rendered. */
	undecidedTokens: number;
	/** Statements where even B cannot resume: unterminated string, unbalanced, `;`. */
	incomplete: number;
	separatorRunsStrict: number;
	separatorRunsDesignA: number;
	separatorRunsDesignB: number;
	refusalReasons: Record<string, number>;
	/** Boundary agreement between the strict walk and the tolerant one. */
	boundaryMismatches: string[];
	/** `arg-sep` runs in `data.tokens[]` — one per attribute the fill painted. */
	envelopeSeparators: number;
	/**
	 * Of those, the ones NOT inside any published `ExplainArgumentToken` span, so
	 * a consumer holding the envelope has no `valueSpan` to derive them from.
	 */
	envelopeSeparatorsUnpublished: number;
	/** Scripts carrying at least one of those. */
	envelopeScriptsAffected: number;
	/** The argument NAMES that dominate the unpublished set, most frequent first. */
	envelopeTopUnpublished: [string, number][];
}

export function sweep(scripts: readonly string[]): Reach {
	const out: Reach = {
		scripts: scripts.length,
		candidates: 0,
		notAddressable: 0,
		strictRead: 0,
		strictRefused: 0,
		refusedWithPrefix: 0,
		tokensStrict: 0,
		tokensDesignA: 0,
		tokensDesignB: 0,
		onlyReachedByB: 0,
		undecidedTokens: 0,
		incomplete: 0,
		separatorRunsStrict: 0,
		separatorRunsDesignA: 0,
		separatorRunsDesignB: 0,
		refusalReasons: {},
		boundaryMismatches: [],
		envelopeSeparators: 0,
		envelopeSeparatorsUnpublished: 0,
		envelopeScriptsAffected: 0,
		envelopeTopUnpublished: [],
	};
	const unpublishedNames = new Map<string, number>();

	for (const [index, text] of scripts.entries()) {
		const analyzed = new TextDecoder().decode(
			analyzeCoordinates(text).analyzed,
		);
		measureEnvelopeGap(text, analyzed, out, unpublishedNames);
		const verbs = resolveVerbsFromStatements(resolveStatements(text));
		for (const split of verbs.splits) {
			if (split.argsAt === null) continue;
			const { start, end } = split.span;
			const slice = analyzed.slice(start, end);
			if (slice !== split.text) {
				out.notAddressable++;
				continue;
			}
			out.candidates++;

			const strict = lexArguments(slice, split.argsAt);
			const tolerant = lexArgumentTokens(slice, split.argsAt);
			const firstUndecided = tolerant.tokens.findIndex(
				(t) => t.undecided !== undefined,
			);
			const designA =
				firstUndecided < 0
					? tolerant.tokens
					: tolerant.tokens.slice(0, firstUndecided);

			if (strict.read) {
				out.strictRead++;
				out.tokensStrict += strict.tokens.length;
				// Every strict token must survive the tolerant walk unchanged.
				if (
					JSON.stringify(strict.tokens) !==
					JSON.stringify(tolerant.tokens.slice(0, strict.tokens.length))
				)
					out.boundaryMismatches.push(
						`script #${index}: strict tokens differ from the tolerant prefix at ${JSON.stringify(slice.slice(0, 80))}`,
					);
			} else {
				out.strictRefused++;
				out.refusalReasons[strict.why] =
					(out.refusalReasons[strict.why] ?? 0) + 1;
				if (designA.length > 0) {
					out.refusedWithPrefix++;
					// The claim "design A is the prefix the strict walk discards" is not
					// observable on a refused statement — `lexArguments` publishes
					// nothing — so verify it against the only thing that can: the strict
					// lexer handed exactly those bytes. The cut is at a token start,
					// hence at a whitespace boundary, so the slice is a well-formed
					// argument list on its own.
					const cutAt = tolerant.tokens[firstUndecided]?.span.start ?? 0;
					const prefixOnly = lexArguments(slice.slice(0, cutAt), split.argsAt);
					if (
						!prefixOnly.read ||
						JSON.stringify(prefixOnly.tokens) !== JSON.stringify(designA)
					)
						out.boundaryMismatches.push(
							`script #${index}: design A's prefix is not what the strict lexer returns for those bytes at ${JSON.stringify(slice.slice(0, 80))}`,
						);
				} else if (tolerant.tokens.length > 0) out.onlyReachedByB++;
				// Design A's prefix IS the strict walk's discarded prefix, so the
				// refusal reason the two report must be the same string.
				if (
					firstUndecided >= 0 &&
					tolerant.tokens[firstUndecided]?.undecided !== strict.why
				)
					out.boundaryMismatches.push(
						`script #${index}: strict refused "${strict.why}" but the tolerant walk said "${tolerant.tokens[firstUndecided]?.undecided}"`,
					);
				if (firstUndecided < 0 && tolerant.complete)
					out.boundaryMismatches.push(
						`script #${index}: strict refused "${strict.why}" but the tolerant walk decided every token`,
					);
			}
			if (!tolerant.complete) out.incomplete++;
			out.tokensDesignA += designA.length;
			out.tokensDesignB += tolerant.tokens.length;
			out.undecidedTokens += tolerant.tokens.filter(
				(t) => t.undecided !== undefined,
			).length;

			if (split.resolution !== "resolved") continue;
			if (strict.read)
				out.separatorRunsStrict += findMissingSeparators(strict.tokens).length;
			out.separatorRunsDesignA += findMissingSeparators(designA).length;
			out.separatorRunsDesignB += findMissingSeparators(tolerant.tokens).length;
		}
	}
	out.envelopeTopUnpublished = [...unpublishedNames.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 6);
	return out;
}

/**
 * How much of the painted `arg-sep` stream the envelope cannot account for.
 *
 * Measured through `explainCommand` on purpose: the claim is about the SHIPPED
 * result, not about what the lexer could reach. The fill withdraws statements
 * the lexer knows nothing about (#311's second command-shaped run, a gate-parity
 * disagreement, a normalized statement), so counting tolerant tokens here would
 * over-report. A separator is "published" when some read statement's
 * `ExplainArgumentToken` span covers it — that is exactly the case where a
 * consumer could have derived the `=` as `valueSpan.start - 1` for itself.
 *
 * A throw here is deliberately NOT caught. `explainCommand` carries a no-throw
 * contract (`commands/explain/README.md` -> Offline baseline acceptance), so
 * swallowing one would hide a contract violation behind a report that still
 * printed a number.
 */
function measureEnvelopeGap(
	text: string,
	analyzed: string,
	out: Reach,
	names: Map<string, number>,
): void {
	const data = explainCommand(text, { tokens: true });
	const published: { start: number; end: number }[] = [];
	for (const statement of data.structure.statements) {
		const args = statement.arguments;
		if (args?.read !== true) continue;
		for (const token of args.tokens) published.push(token.span);
	}
	let affected = false;
	for (const token of data.tokens ?? []) {
		if (token.class !== "arg-sep") continue;
		out.envelopeSeparators++;
		if (published.some((s) => token.start >= s.start && token.end <= s.end))
			continue;
		out.envelopeSeparatorsUnpublished++;
		affected = true;
		// The name run is the bytes immediately before the `=`, back to the last
		// whitespace or delimiter — enough to name the spelling in the report.
		let from = token.start;
		while (from > 0 && /[^\s={};[\]()]/.test(analyzed[from - 1] as string))
			from--;
		const name = `${analyzed.slice(from, token.start)}=`;
		if (name.length > 1) names.set(name, (names.get(name) ?? 0) + 1);
	}
	if (affected) out.envelopeScriptsAffected++;
}

function render(r: Reach): string {
	const pct = (n: number, of: number): string =>
		of === 0 ? "—" : `${((n / of) * 100).toFixed(1)}%`;
	const reachedA = r.strictRead + r.refusedWithPrefix;
	const reachedB = reachedA + r.onlyReachedByB;
	const reasons = Object.entries(r.refusalReasons)
		.sort((a, b) => b[1] - a[1])
		.map(([why, n]) => `| \`${why}\` | ${n} |`)
		.join("\n");
	return `# explain argument reach — strict vs A vs B (#316)

Scripts: ${r.scripts} · candidate statements: ${r.candidates}

| | strict | design A (prefix) | design B (skip) |
| --- | ---: | ---: | ---: |
| statements reached | ${r.strictRead} (${pct(r.strictRead, r.candidates)}) | ${reachedA} (${pct(reachedA, r.candidates)}) | ${reachedB} (${pct(reachedB, r.candidates)}) |
| argument tokens | ${r.tokensStrict} | ${r.tokensDesignA} | ${r.tokensDesignB} |
| **separator runs found** | **${r.separatorRunsStrict}** | **${r.separatorRunsDesignA}** | **${r.separatorRunsDesignB}** |

- strict refused: ${r.strictRefused} (${pct(r.strictRefused, r.candidates)})
- refused WITH a non-empty decoded prefix (all design A recovers): ${r.refusedWithPrefix}
- refused with an EMPTY prefix, reached only by B: ${r.onlyReachedByB}
- tokens published \`undecided\` (located, no value): ${r.undecidedTokens}
- statements where even B stops early (unterminated/unbalanced/\`;\`): ${r.incomplete}
- excluded as not addressable, so outside every column: ${r.notAddressable}
- boundary mismatches between the two walks: ${r.boundaryMismatches.length}

| strict refusal reason | statements |
| --- | ---: |
${reasons}

## What the envelope cannot account for (#264 B5)

\`tokens[]\` paints an \`arg-sep\` run per attribute; the envelope publishes an
\`ExplainArgumentToken\` only where the STRICT reading read. The difference is
what a consumer could not have derived as \`valueSpan.start - 1\` for itself,
and it is why B5 gave the \`=\` its own class rather than leaving it merged
into \`arg\`.

- \`arg-sep\` runs painted: ${r.envelopeSeparators}
- of those, NOT covered by any published argument token: **${r.envelopeSeparatorsUnpublished}** (${pct(r.envelopeSeparatorsUnpublished, r.envelopeSeparators)})
- scripts carrying at least one: ${r.envelopeScriptsAffected} of ${r.scripts}

| unpublished spelling | runs |
| --- | ---: |
${r.envelopeTopUnpublished.map(([name, n]) => `| \`${name}\` | ${n} |`).join("\n")}
${
	r.boundaryMismatches.length === 0
		? ""
		: `\n## Boundary mismatches\n\n${r.boundaryMismatches
				.slice(0, 20)
				.map((m) => `- ${m}`)
				.join("\n")}\n`
}`;
}

export async function main(args: readonly string[]): Promise<number> {
	const at = args.indexOf("--db");
	// A bare trailing `--db` would otherwise fall through to the environment, a
	// sibling checkout or the cache, and announce THAT snapshot as the measured
	// one. Which bytes were measured is the whole provenance claim here.
	if (at >= 0 && args[at + 1] === undefined) {
		console.error(
			"::error title=explain arg reach sweep::`--db` needs a path to a corpus " +
				"sqlite; omit the flag entirely to use the pinned snapshot.",
		);
		return 1;
	}
	const resolution = resolveCorpusDb(at < 0 ? undefined : args[at + 1]);
	const dbPath = resolution.path;
	if (dbPath === undefined || !(await Bun.file(dbPath).exists())) {
		console.error(unreachableMessage("explain arg reach sweep"));
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
	const result = sweep(scripts);
	console.log(
		args.includes("--json") ? JSON.stringify(result, null, 2) : render(result),
	);
	return result.boundaryMismatches.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
