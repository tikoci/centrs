/**
 * Block / scope-brace classification for `explain` (centrs canonicalizer).
 *
 * Ratified by the phase-0 lab, question Q2 (#185) and promoted from the
 * throwaway probe `.scratch/explain-lab-blocktree.ts`. Q2 asks: can an offline,
 * schema-free brace tracker tell a `{…}` SCOPE (`do=`/`else=`/`on-error=`, which
 * IL lowers to `name=;(evl …)`) from a `name={…}` LITERAL value (braces
 * stripped, body kept as RAW text, never lowered)? Descending into a literal
 * body as if it held statements is the prior-art bug (canonicalize-audit #8/H5).
 *
 * The source-visible scope set is a small CLOSED set harvested across the
 * 913-script corpus, so the distinction is schema-free — it reads the argument
 * name (and, for the one head-dependent case, the leading directive) off the
 * statement itself.
 *
 * This module ships only the (single-pass, non-recursive) classification
 * primitives the path resolver needs. The recursive block *tree* / topology
 * surface stays in the lab until it can be promoted with a bounded, index-based
 * traversal of its own.
 *
 * Every string skip here goes through `segment.ts`'s `scanQuotedString` rather
 * than a local quote-to-quote loop, so this module and the segmenter cannot
 * drift on where a string ends: a `}` inside the nested string of a `$[…]`
 * substitution is not a brace, and reading it as one truncated the scope body
 * (#199).
 */

import {
	DIRECTIVE_BODY,
	HEAD_SCOPED_ARG_NAMES,
	SCOPE_ARG_NAMES,
	scopeNameFromMasked,
} from "./scope-brace.ts";
import {
	documentRange,
	type MaskedRange,
	maskComments,
	scanQuotedString,
} from "./segment.ts";

export { DIRECTIVE_BODY, HEAD_SCOPED_ARG_NAMES, SCOPE_ARG_NAMES };
/** One depth-0 scope block found in a statement: its name and raw body text. */
export interface ScopeBlock {
	name: string;
	body: string;
	/**
	 * Offset of `body`'s first character within the text `scopeBlocks` was given
	 * — i.e. one past the opening `{`.
	 *
	 * Without it a caller that re-segments `body` gets BODY-RELATIVE offsets and
	 * no way to rebase them, so a span or region found inside a `do={…}` cannot
	 * be reported in document space. `pathresolve` is that caller.
	 */
	start: number;
}

/**
 * The scope name for the `{` at `open`, or null when the brace is a value.
 * Two shapes qualify: `<name>={` with name in the closed set (or head-scoped
 * under the right leading directive), and a brace body directly following a
 * body-taking directive (`:do {`, `:retry {`, `:onerror Err {`).
 */
export function scopeNameAt(text: string, open: number): string | null {
	return scopeNameFromMasked(maskComments(text), open);
}

/** True when the `{` at `open` opens a scope rather than a literal value. */
export function isScopeBrace(text: string, open: number): boolean {
	return scopeNameAt(text, open) !== null;
}

/**
 * The depth-0 scope `{…}` in a statement, with names and raw body text. A
 * single left-to-right pass (no recursion): each scope's body is returned raw
 * for the caller to segment/recurse under its own depth budget. Literal `{…}`
 * values are skipped, not descended.
 */
export function scopeBlocks(text: string): ScopeBlock[] {
	return scopeBlocksIn(documentRange(text));
}

/**
 * The same scan over a RANGE of a document, reading the document's own mask.
 *
 * `ScopeBlock.start` stays relative to the range, which is what its contract
 * already promises ("within the text `scopeBlocks` was given") and what a
 * caller rebasing through `Loc` needs. Every other offset here is absolute.
 */
export function scopeBlocksIn(range: MaskedRange): ScopeBlock[] {
	// Scan a comment-masked copy for structure so a `#`-comment `}`/`[` cannot
	// truncate a body or shift depth; slice the ORIGINAL for the body text.
	const { text, masked, start: lo, end: hi } = range;
	const blocks: ScopeBlock[] = [];
	let depth = 0;
	for (let i = lo; i < hi; i++) {
		const c = masked[i];
		if (c === '"') {
			i = scanQuotedString(masked, i, hi).end - 1;
			continue;
		}
		if (c === "[" || c === "(") depth++;
		else if (c === "]" || c === ")") {
			if (depth > 0) depth--;
		} else if (c === "{") {
			const end = matchBraceInMasked(masked, i, hi);
			if (depth === 0) {
				const name = scopeNameFromMasked(masked, i, lo);
				if (name !== null)
					blocks.push({
						name,
						body: text.slice(i + 1, end),
						start: i + 1 - lo,
					});
			}
			i = end;
		} else if (c === "}") {
			if (depth > 0) depth--;
		}
	}
	return blocks;
}

/** Bodies of the depth-0 scope `{…}` in a statement (for block recursion). */
export function scopeBodies(text: string): string[] {
	return scopeBlocks(text).map((b) => b.body);
}

/** Whether a range holds any depth-0 scope `{…}` — `scopeBodies().length > 0`. */
export function hasScopeBlockIn(range: MaskedRange): boolean {
	return scopeBlocksIn(range).length > 0;
}

function matchBraceInMasked(
	masked: string,
	open: number,
	limit: number = masked.length,
): number {
	let depth = 0;
	for (let i = open; i < limit; i++) {
		const c = masked[i];
		if (c === '"') {
			i = scanQuotedString(masked, i, limit).end - 1;
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return limit;
}

/** Index of the `}` matching the `{` at `open`, honoring strings and comments. */
export function matchBrace(text: string, open: number): number {
	return matchBraceInMasked(maskComments(text), open);
}
