/**
 * Source-visible brace roles shared by the explain walkers.
 *
 * RouterOS does not make every `{` a statement body. `do={...}` and stored
 * script attributes do, while `name={...}` is ordinarily an array literal.
 * Keeping this decision below `segment.ts` avoids a cycle with `blocks.ts` and
 * gives comment masking, segmentation, and symbol resolution one rule.
 */

import { scanQuotedString } from "./quoted-string.ts";

const ASCII_WHITESPACE = /[ \t\r\n]+/;
const ERROR_VAR = /^\$?[A-Za-z][A-Za-z0-9._-]*$/;

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
 * Source-visible argument names whose `{…}` is a scope. Closed set harvested
 * from the projected corpus; `in` is deliberately excluded because
 * `:foreach in={…}` is an array even though `:onerror V {…}` lowers to `in`.
 */
export const SCOPE_ARG_NAMES: ReadonlySet<string> = new Set([
	"do",
	"else",
	"on-error",
	"command",
]);

/** Argument names that are scopes only under a specific head directive. */
export const HEAD_SCOPED_ARG_NAMES: Record<string, ReadonlySet<string>> = {
	in: new Set([":onerror", "onerror"]),
};

/** Directives whose brace body attaches directly rather than through `name=`. */
export const DIRECTIVE_BODY: Record<string, string> = {
	":do": "command",
	":retry": "command",
	":onerror": "in",
	do: "command",
	retry: "command",
	onerror: "in",
};

/** Script-valued attribute naming convention already used by the corpus census. */
const SCRIPT_BODY_ARG = /^(?:source|script|on-.*)$/;

/** Grounded scripting directives whose positional arity makes a later `#` fatal. */
const DIRECTIVE_POSITIONAL_ARITY: Readonly<Record<string, number>> = {
	local: 2,
	global: 2,
	set: 2,
	put: 1,
};

const BOUNDARY_CACHE_LIMIT = 4;
const boundaryCache = new Map<string, Int32Array>();

/** Last unquoted statement boundary before every source offset, in one pass. */
function statementBoundaries(text: string): Int32Array {
	const cached = boundaryCache.get(text);
	if (cached !== undefined) return cached;

	const boundaries = new Int32Array(text.length + 1);
	boundaries.fill(-1);
	let boundary = -1;
	let i = 0;
	while (i < text.length) {
		boundaries[i] = boundary;
		const c = text[i] as string;
		if (c === '"') {
			const end = Math.min(scanQuotedString(text, i).end, text.length);
			boundaries.fill(boundary, i + 1, end + 1);
			i = end;
			continue;
		}
		if (c === "\n" || c === ";" || c === "{" || c === "[") boundary = i;
		i++;
	}
	boundaries[text.length] = boundary;

	if (boundaryCache.size >= BOUNDARY_CACHE_LIMIT) boundaryCache.clear();
	boundaryCache.set(text, boundaries);
	return boundaries;
}

function statementPrefix(text: string, open: number): string {
	const braceBoundary = text.lastIndexOf("{", open - 1);
	if (braceBoundary !== -1) {
		const afterBrace = text.slice(braceBoundary + 1, open);
		if (!/[\n;["]/.test(afterBrace)) return afterBrace;
	}
	const baseBoundary = Math.max(
		text.lastIndexOf("\n", open - 1),
		text.lastIndexOf(";", open - 1),
		braceBoundary,
	);
	const suffix = text.slice(baseBoundary + 1, open);
	const bracket = suffix.lastIndexOf("[");
	const naiveBoundary =
		bracket === -1 ? baseBoundary : baseBoundary + bracket + 1;
	// The fast path is the original bounded reverse lookup. A quote after its
	// candidate means that candidate may be string content, so only then pay for
	// the shared quote-aware forward index (#246 review).
	const boundary = suffix.slice(bracket + 1).includes('"')
		? (statementBoundaries(text)[open] ?? -1)
		: naiveBoundary;
	return text.slice(boundary + 1, open);
}

/** Scope name for an already comment-masked source view. */
export function scopeNameFromMasked(
	masked: string,
	open: number,
): string | null {
	const before = statementPrefix(masked, open);
	const named = before.match(/([A-Za-z][A-Za-z0-9.-]*)=[ \t\r\n]*$/);
	if (named) {
		const name = (named[1] as string).toLowerCase();
		if (SCOPE_ARG_NAMES.has(name)) return name;
		const heads = HEAD_SCOPED_ARG_NAMES[name];
		if (heads !== undefined) {
			const head = (asciiWords(before)[0] ?? "").toLowerCase();
			return heads.has(head) ? name : null;
		}
		return null;
	}
	const words = asciiWords(before);
	const first = (words[0] ?? "").toLowerCase();
	const body = DIRECTIVE_BODY[first];
	if (body === undefined) return null;
	if (words.length === 1) return body;
	if (words.length === 2 && ERROR_VAR.test(words[1] as string)) return body;
	return null;
}

/** Whether this brace begins a context in which statement-leading comments exist. */
export function braceStartsStatements(text: string, open: number): boolean {
	if (scopeNameFromMasked(text, open) !== null) return true;
	const before = statementPrefix(text, open);
	const named = before.match(/([A-Za-z][A-Za-z0-9.-]*)=[ \t\r\n]*$/);
	if (named) return SCRIPT_BODY_ARG.test((named[1] as string).toLowerCase());

	// H7's bare `{...}` and `/menu {...}` containers are statement bodies too.
	const prefix = trimAscii(before);
	return prefix === "" || (prefix.startsWith("/") && !/[=[($"]/.test(prefix));
}

/**
 * Whether an unquoted, non-comment `#` is a device hard error (#245).
 *
 * `inExpression` is the caller's already-known delimiter role: arrays and
 * parenthesized expressions reject every unquoted hash. Outside them, a hash
 * joined to a value (`comment=a#b`) stays content. A whitespace-led hash is
 * rejected only where CHR proves the statement has already consumed the fixed
 * positional operands of a scripting directive, or after a closing scope.
 */
export function hashStartsHardError(
	text: string,
	at: number,
	inExpression: boolean,
): boolean {
	if (inExpression) return true;
	if (at <= 0 || !isAsciiWhitespace(text[at - 1])) return false;

	let previous = at - 1;
	while (previous >= 0 && isAsciiWhitespace(text[previous])) previous--;
	if (text[previous] === "}") return true;

	const words = asciiWords(
		statementPrefix(text, at).replaceAll(/\\\r?\n/g, ""),
	);
	const rawHead = (words[0] ?? "").toLowerCase();
	if (!rawHead.startsWith(":") && !rawHead.startsWith("/")) return false;
	const head = rawHead.slice(1);
	const arity = DIRECTIVE_POSITIONAL_ARITY[head];
	return arity !== undefined && words.length - 1 >= arity;
}
