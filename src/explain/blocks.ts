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
 */

const ASCII_WHITESPACE = /[ \t\r\n]+/;

function isAsciiWhitespace(char: string | undefined): boolean {
	return char === " " || char === "\t" || char === "\r" || char === "\n";
}

function trimAscii(text: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && isAsciiWhitespace(text[start])) start++;
	while (end > start && isAsciiWhitespace(text[end - 1])) end--;
	return text.slice(start, end);
}

function asciiWords(text: string): string[] {
	const trimmed = trimAscii(text);
	return trimmed.length === 0 ? [] : trimmed.split(ASCII_WHITESPACE);
}

/**
 * Source-visible argument names whose `{…}` is a scope. Closed set, harvested
 * from every projected corpus capture (`do` 5623, `else` 720, `command` 177,
 * `on-error` 132).
 *
 * `command` is here because users DO write it explicitly:
 * `:retry delay=1s max=3 on-error={…} command={…}`
 * (topic-169237/post-0021-snippet-01 @ 7.22.1).
 *
 * `in` is deliberately NOT here even though IL lowers `:onerror V { … }` under
 * that name — in SOURCE, `in={…}` is always an array literal
 * (`:foreach Type in={ "p12"; "pem" }` → `in=p12;pem`,
 * eworm/check-certificates.rsc @ 7.22.1). The IL name and the source name
 * collide; only the source spelling governs offline.
 */
export const SCOPE_ARG_NAMES: ReadonlySet<string> = new Set([
	"do",
	"else",
	"on-error",
	"command",
]);

/** Argument names that are a scope only under a specific head directive. */
export const HEAD_SCOPED_ARG_NAMES: Record<string, ReadonlySet<string>> = {
	in: new Set([":onerror", "onerror"]),
};

/**
 * Directives whose brace body attaches to the directive itself, with the IL
 * name the body is lowered under. The colon is optional in practice: `do {`
 * opens a body the same way `:do {` does (topic-142687/post-0010-snippet-01 @
 * 7.22.1).
 */
export const DIRECTIVE_BODY: Record<string, string> = {
	":do": "command",
	":retry": "command",
	":onerror": "in",
	do: "command",
	retry: "command",
	onerror: "in",
};

/** One depth-0 scope block found in a statement: its name and raw body text. */
export interface ScopeBlock {
	name: string;
	body: string;
}

/**
 * The scope name for the `{` at `open`, or null when the brace is a value.
 * Two shapes qualify: `<name>={` with name in the closed set (or head-scoped
 * under the right leading directive), and a brace body directly following a
 * body-taking directive (`:do {`, `:retry {`, `:onerror Err {`).
 */
export function scopeNameAt(text: string, open: number): string | null {
	const before = text.slice(0, open);
	const named = before.match(/([A-Za-z][A-Za-z0-9.-]*)=[ \t\r\n]*$/);
	if (named) {
		const name = (named[1] as string).toLowerCase();
		if (SCOPE_ARG_NAMES.has(name)) return name;
		const heads = HEAD_SCOPED_ARG_NAMES[name];
		if (heads !== undefined) {
			const head = (asciiWords(text)[0] ?? "").toLowerCase();
			return heads.has(head) ? name : null;
		}
		return null;
	}
	// `:do {`, `:retry {`, `:onerror Err {` — the directive may carry one bare
	// word (the error variable) between itself and the brace.
	const words = asciiWords(before);
	const first = (words[0] ?? "").toLowerCase();
	const body = DIRECTIVE_BODY[first];
	if (body === undefined) return null;
	return words.length <= 2 ? body : null;
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
	const blocks: ScopeBlock[] = [];
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			i++;
			while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
			continue;
		}
		if (c === "[" || c === "(") depth++;
		else if (c === "]" || c === ")") {
			if (depth > 0) depth--;
		} else if (c === "{") {
			const end = matchBrace(text, i);
			if (depth === 0) {
				const name = scopeNameAt(text, i);
				if (name !== null) blocks.push({ name, body: text.slice(i + 1, end) });
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

/** Index of the `}` matching the `{` at `open`, honoring strings. */
export function matchBrace(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			i++;
			while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return text.length;
}
