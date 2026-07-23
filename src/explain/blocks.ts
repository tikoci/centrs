/**
 * Block / scope-brace classification for `explain` (centrs canonicalizer).
 *
 * Ratified by the phase-0 lab, question Q2 (#185) and promoted from the
 * throwaway probe `.scratch/explain-lab-blocktree.ts`. Q2 asks: can an offline,
 * schema-free brace tracker reproduce the `do=`/`else=`/`on-error=` block tree
 * that `:parse` IL adjacency shows? The sharp corner is a `name={…}` LITERAL
 * value versus a `{…}` SCOPE — the case prior art (canonicalize-audit #8 / H5)
 * gets wrong by descending into a literal body as if it held statements.
 *
 * The device settles it: a scope lowers to `name=;(evl …)`, while a literal has
 * its braces stripped and its body kept as RAW text, never lowered. Harvested
 * across the 913-script corpus, the source-visible scope set is a small CLOSED
 * set, so the distinction is schema-free — it reads the argument name (and, for
 * the one head-dependent case, the leading directive) off the statement itself.
 *
 * This stage sits on top of the Q1 segmenter: `blockTree` segments the input
 * with `segmentStatements` and then, per statement, finds its depth-0 scope
 * braces and recurses into their bodies. A literal `{…}` is never descended.
 */

import { segmentStatements } from "./segment.ts";

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

/** One scope block: its IL/source name and the statements it contains. */
export interface Block {
	name: string;
	children: Node[];
}

/** One statement and the scope blocks attached to it. */
export interface Node {
	text: string;
	blocks: Block[];
}

/** Statement texts of `text`, via the Q1 segmenter. */
function statementTexts(text: string): string[] {
	return segmentStatements(text).segments.map((s) => s.text);
}

/**
 * The offline block tree: each top-level statement, with its scope blocks (and
 * their nested statements) resolved. Literal `{…}` values are not descended.
 */
export function blockTree(text: string): Node[] {
	return statementTexts(text).map((t) => ({ text: t, blocks: findBlocks(t) }));
}

function findBlocks(text: string): Block[] {
	const blocks: Block[] = [];
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		if (c === '"') {
			i++;
			while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
			continue;
		}
		if (c === "[" || c === "(") {
			depth++;
			continue;
		}
		if (c === "]" || c === ")") {
			depth--;
			continue;
		}
		if (c === "{") {
			const end = matchBrace(text, i);
			if (depth === 0) {
				const name = scopeNameAt(text, i);
				if (name !== null)
					blocks.push({ name, children: blockTree(text.slice(i + 1, end)) });
			}
			// A literal `{…}` is NOT descended into: its contents are a value, and
			// treating them as statements is exactly the audit's #8/H5 bug.
			i = end;
			continue;
		}
		if (c === "}") depth--;
	}
	return blocks;
}

/**
 * The scope name for the `{` at `open`, or null when the brace is a value.
 * Two shapes qualify: `<name>={` with name in the closed set (or head-scoped
 * under the right leading directive), and a brace body directly following a
 * body-taking directive (`:do {`, `:retry {`, `:onerror Err {`).
 */
export function scopeNameAt(text: string, open: number): string | null {
	const before = text.slice(0, open);
	const named = before.match(/([A-Za-z][A-Za-z0-9.-]*)=\s*$/);
	if (named) {
		const name = (named[1] as string).toLowerCase();
		if (SCOPE_ARG_NAMES.has(name)) return name;
		const heads = HEAD_SCOPED_ARG_NAMES[name];
		if (heads !== undefined) {
			const head = (text.trim().split(/\s+/)[0] ?? "").toLowerCase();
			return heads.has(head) ? name : null;
		}
		return null;
	}
	// `:do {`, `:retry {`, `:onerror Err {` — the directive may carry one bare
	// word (the error variable) between itself and the brace.
	const words = before.trim().split(/\s+/);
	const first = (words[0] ?? "").toLowerCase();
	const body = DIRECTIVE_BODY[first];
	if (body === undefined) return null;
	return words.length <= 2 ? body : null;
}

/** True when the `{` at `open` opens a scope rather than a literal value. */
export function isScopeBrace(text: string, open: number): boolean {
	return scopeNameAt(text, open) !== null;
}

/** Bodies of the depth-0 scope `{…}` in a statement (for block recursion). */
export function scopeBodies(text: string): string[] {
	const bodies: string[] = [];
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			i++;
			while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
			continue;
		}
		if (c === "[" || c === "(") depth++;
		else if (c === "]" || c === ")") depth--;
		else if (c === "{") {
			const end = matchBrace(text, i);
			if (depth === 0 && isScopeBrace(text, i))
				bodies.push(text.slice(i + 1, end));
			i = end;
		}
	}
	return bodies;
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

/**
 * Canonical structural fingerprint: block names and nesting, no leaf text.
 * Sibling blocks are emitted in NAME order because IL stores arguments in
 * (alphabetized) KV-array order, so `on-error={…} command={…}` comes back as
 * `command…on-error…`; source order is not recoverable from that oracle, so
 * the fingerprint does not encode it.
 */
export function topology(nodes: Node[]): string {
	const byName = (a: Block, b: Block): number =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	return nodes
		.map((n) =>
			[...n.blocks]
				.sort(byName)
				.map((b) => `${b.name}[${topology(b.children)}]`)
				.join(""),
		)
		.join(",");
}
