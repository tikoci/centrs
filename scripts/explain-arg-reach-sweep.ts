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
 * that point. The `--verify` pass asserts that equivalence against the strict
 * lexer on every corpus statement rather than assuming it.
 *
 * The reported figure that decides the fork is **separator runs found**: the
 * reach numbers alone make A look adequate, and the run counts are what show it
 * is not.
 *
 * ```
 * bun run scripts/probes/explain-arg-reach-sweep.ts
 * bun run scripts/probes/explain-arg-reach-sweep.ts --json
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
import {
	describeResolution,
	resolveCorpusDb,
	unreachableMessage,
} from "./corpus-fetch.ts";

interface Reach {
	scripts: number;
	/** Resolved statements carrying an argument list this lexer may read. */
	candidates: number;
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
}

export function sweep(scripts: readonly string[]): Reach {
	const out: Reach = {
		scripts: scripts.length,
		candidates: 0,
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
	};

	for (const [index, text] of scripts.entries()) {
		const analyzed = new TextDecoder().decode(
			analyzeCoordinates(text).analyzed,
		);
		const verbs = resolveVerbsFromStatements(resolveStatements(text));
		for (const split of verbs.splits) {
			if (split.argsAt === null) continue;
			const { start, end } = split.span;
			const slice = analyzed.slice(start, end);
			if (slice !== split.text) continue;
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
				if (designA.length > 0) out.refusedWithPrefix++;
				else if (tolerant.tokens.length > 0) out.onlyReachedByB++;
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
	return out;
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
- boundary mismatches between the two walks: ${r.boundaryMismatches.length}

| strict refusal reason | statements |
| --- | ---: |
${reasons}
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
