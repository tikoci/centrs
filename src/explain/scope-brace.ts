/**
 * Source-visible brace roles shared by the explain walkers.
 *
 * RouterOS does not make every `{` a statement body. `do={...}` and stored
 * script attributes do, while `name={...}` is ordinarily an array literal.
 * Keeping this decision below `segment.ts` avoids a cycle with `blocks.ts` and
 * gives comment masking, segmentation, and symbol resolution one rule.
 */

import { scanQuotedString } from "./quoted-string.ts";

/** Error-variable shape for `:onerror V { … }` — a bare/`$`-prefixed name. */
const ERROR_VAR = /^\$?[A-Za-z][A-Za-z0-9._-]*$/;

function isAsciiWhitespace(char: string | undefined): boolean {
	return char === " " || char === "\t" || char === "\r" || char === "\n";
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

/** Argument names that are scopes only under a specific head directive. */
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
const BOUNDARY_CACHE_BYTE_LIMIT = 8 * 1024 * 1024;
interface StatementIndex {
	boundaries: Int32Array;
	firstContent: Int32Array;
	lastForbidden: Int32Array;
}

const boundaryCache = new Map<string, StatementIndex>();
let boundaryCacheBytes = 0;
// Most probes in one walk ask about the same document. Bypass Map's string-key
// lookup for that hot path without retaining anything outside the bounded cache.
let recentBoundaryText: string | undefined;
let recentBoundaryIndex: StatementIndex | undefined;

function boundaryCacheEntryBytes(text: string, index: StatementIndex): number {
	// JavaScript strings use at most two bytes per UTF-16 code unit. Include the
	// key as well as the typed array so unusually large sources cannot be retained.
	return (
		text.length * 2 +
		index.boundaries.byteLength +
		index.firstContent.byteLength +
		index.lastForbidden.byteLength
	);
}

function cacheStatementIndex(text: string, index: StatementIndex): boolean {
	const entryBytes = boundaryCacheEntryBytes(text, index);
	if (entryBytes > BOUNDARY_CACHE_BYTE_LIMIT) return false;

	while (
		boundaryCache.size >= BOUNDARY_CACHE_LIMIT ||
		boundaryCacheBytes + entryBytes > BOUNDARY_CACHE_BYTE_LIMIT
	) {
		const oldest = boundaryCache.entries().next().value;
		if (oldest === undefined) break;
		boundaryCache.delete(oldest[0]);
		boundaryCacheBytes -= boundaryCacheEntryBytes(oldest[0], oldest[1]);
		if (recentBoundaryText === oldest[0]) {
			recentBoundaryText = undefined;
			recentBoundaryIndex = undefined;
		}
	}
	boundaryCache.set(text, index);
	boundaryCacheBytes += entryBytes;
	return true;
}

/** Statement-boundary and prefix facts for every source offset, in one pass. */
function statementIndex(text: string): StatementIndex {
	if (recentBoundaryText === text && recentBoundaryIndex !== undefined)
		return recentBoundaryIndex;
	const cached = boundaryCache.get(text);
	if (cached !== undefined) {
		recentBoundaryText = text;
		recentBoundaryIndex = cached;
		return cached;
	}

	const boundaries = new Int32Array(text.length + 1);
	boundaries.fill(-1);
	const firstContent = new Int32Array(text.length + 1);
	firstContent.fill(-1);
	const lastForbidden = new Int32Array(text.length + 1);
	lastForbidden.fill(-1);
	let boundary = -1;
	let first = -1;
	let forbidden = -1;
	let i = 0;
	while (i < text.length) {
		boundaries[i] = boundary;
		firstContent[i] = first;
		lastForbidden[i] = forbidden;
		const c = text[i] as string;
		if (c === '"') {
			const end = Math.min(scanQuotedString(text, i).end, text.length);
			boundaries.fill(boundary, i + 1, end + 1);
			firstContent.fill(first === -1 ? i : first, i + 1, end + 1);
			lastForbidden.fill(i, i + 1, end + 1);
			if (first === -1) first = i;
			forbidden = i;
			i = end;
			continue;
		}
		if (first === -1 && !isAsciiWhitespace(c)) first = i;
		if (c === "=" || c === "[" || c === "(" || c === "$") forbidden = i;
		if (c === "\n" || c === ";" || c === "{" || c === "[") {
			boundary = i;
			first = -1;
		}
		i++;
	}
	boundaries[text.length] = boundary;
	firstContent[text.length] = first;
	lastForbidden[text.length] = forbidden;

	const index = { boundaries, firstContent, lastForbidden };
	if (cacheStatementIndex(text, index)) {
		recentBoundaryText = text;
		recentBoundaryIndex = index;
	}
	return index;
}

function trailingName(text: string, start: number, end: number): string | null {
	let i = end - 1;
	while (i >= start && isAsciiWhitespace(text[i])) i--;
	if (text[i] !== "=") return null;
	i--;
	const nameEnd = i + 1;
	while (i >= start && /[A-Za-z0-9.-]/.test(text[i] as string)) i--;
	let nameStart = i + 1;
	while (nameStart < nameEnd && !/[A-Za-z]/.test(text[nameStart] as string))
		nameStart++;
	if (nameStart === nameEnd || !/[A-Za-z]/.test(text[nameStart] as string))
		return null;
	return text.slice(nameStart, nameEnd);
}

function leadingWords(
	text: string,
	start: number,
	end: number,
	limit: number,
	removeContinuations = false,
): string[] {
	const words: string[] = [];
	let word = "";
	for (let i = start; i < end && words.length < limit; i++) {
		if (
			removeContinuations &&
			text[i] === "\\" &&
			(text[i + 1] === "\n" || (text[i + 1] === "\r" && text[i + 2] === "\n"))
		) {
			i += text[i + 1] === "\r" ? 2 : 1;
			continue;
		}
		const c = text[i] as string;
		if (isAsciiWhitespace(c)) {
			if (word.length > 0) {
				words.push(word);
				word = "";
			}
		} else {
			word += c;
		}
	}
	if (word.length > 0 && words.length < limit) words.push(word);
	return words;
}

/** Scope name for an already comment-masked source view. */
export function scopeNameFromMasked(
	masked: string,
	open: number,
): string | null {
	const index = statementIndex(masked);
	const start = (index.boundaries[open] ?? -1) + 1;
	const named = trailingName(masked, start, open);
	if (named !== null) {
		const name = named.toLowerCase();
		if (SCOPE_ARG_NAMES.has(name)) return name;
		const heads = HEAD_SCOPED_ARG_NAMES[name];
		if (heads !== undefined) {
			const first = index.firstContent[open] ?? -1;
			const head =
				first < start
					? ""
					: (leadingWords(masked, first, open, 1)[0] ?? "").toLowerCase();
			return heads.has(head) ? name : null;
		}
		return null;
	}
	// `:do {`, `:retry {`, `:onerror Err {` — the directive may carry ONE bare
	// error-variable word before the brace. A second token that is not an
	// identifier (`:onerror [find] {`) is not this form, so the brace is a value.
	const firstContentOffset = index.firstContent[open] ?? -1;
	const words =
		firstContentOffset < start
			? []
			: leadingWords(masked, firstContentOffset, open, 3);
	const firstWord = (words[0] ?? "").toLowerCase();
	const body = DIRECTIVE_BODY[firstWord];
	if (body === undefined) return null;
	if (words.length === 1) return body;
	if (words.length === 2 && ERROR_VAR.test(words[1] as string)) return body;
	return null;
}

/** Whether this brace begins a context in which statement-leading comments exist. */
export function braceStartsStatements(text: string, open: number): boolean {
	if (scopeNameFromMasked(text, open) !== null) return true;
	const index = statementIndex(text);
	const boundary = index.boundaries[open] ?? -1;
	const start = boundary + 1;
	const named = trailingName(text, start, open);
	if (named !== null) return SCRIPT_BODY_ARG.test(named.toLowerCase());

	// H7's bare `{...}` and `/menu {...}` containers are statement bodies too.
	const first = index.firstContent[open] ?? -1;
	return (
		first < start ||
		(text[first] === "/" && (index.lastForbidden[open] ?? -1) < start)
	);
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

	const index = statementIndex(text);
	const start = (index.boundaries[at] ?? -1) + 1;
	const first = index.firstContent[at] ?? -1;
	const words = first < start ? [] : leadingWords(text, first, at, 3, true);
	const rawHead = (words[0] ?? "").toLowerCase();
	if (!rawHead.startsWith(":") && !rawHead.startsWith("/")) return false;
	const head = rawHead.slice(1);
	const arity = DIRECTIVE_POSITIONAL_ARITY[head];
	return arity !== undefined && words.length - 1 >= arity;
}
