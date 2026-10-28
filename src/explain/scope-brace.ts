/**
 * Source-visible brace roles shared by the explain walkers.
 *
 * RouterOS does not make every `{` a statement body. `do={...}` and stored
 * script attributes do, while `name={...}` is ordinarily an array literal.
 * Keeping this decision below `segment.ts` avoids a cycle with `blocks.ts` and
 * gives comment masking, segmentation, and symbol resolution one rule.
 */

import { commandVerbIndex } from "./catalog.ts";
import { isKnownMenuPath } from "./is-known-menu.ts";
import { scanQuotedString } from "./quoted-string.ts";
import { runNamesCommand, runTokens } from "./run-tokens.ts";
import { VERBS } from "./verbs.ts";

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

/**
 * Script-valued attribute naming convention, the corpus census's
 * `SCRIPT_BEARING_KEY` shape (`scripts/explain-corpus-census.ts`).
 *
 * A shape, not a list. It decides a brace's ROLE (statement body or value) for
 * every reader of {@link braceStartsStatements}: segmentation, the argument
 * lexer, symbols and path resolution, as well as the `invalid-command-brace`
 * exemption. A name inside the shape is read as a body; a name outside it as a
 * value. The shape errs toward body because the other error is the worse one:
 * reading a real `up-script={ :beep }` as an array hard-failed input the device
 * accepts. The cost is the fail-open direction. An argument the command does
 * not have, `zzz-script={ :beep }` or `on-zzz={ :beep }`, is a device
 * `syntax error` on CHR 7.24.5 that offline does not report, because naming the
 * command's arguments is schema. The `on-…` half of that predates #350.
 * Which slots take a body is per-menu and per-version schema: on CHR 7.24.5
 * `/tool/netwatch add … up-script={ :beep }` and `/ip/dhcp-server set 0
 * lease-script={ :beep }` both parse, while 7.22.1 accepts the first and
 * rejects the second; `comment={ :beep }` and `zzzscript={ :beep }` are
 * `syntax error` on both (#350). The earlier `^(?:source|script|on-.*)$` missed
 * every `…-script` argument and hard-failed the netwatch row the device accepts.
 * The suffix keeps its hyphen, which is how RouterOS spells these names: a bare
 * `…script` would take `:put myScript={#test}`, whose brace CHR 7.23.3 reads as
 * an array (#245).
 */
const SCRIPT_BODY_ARG = /^(?:source|script|.+-script|on-.+)$/;

/**
 * An abbreviation the {@link SCRIPT_BODY_ARG} shape still pins down (#496).
 * RouterOS takes any unique prefix of an argument name: on CHR 7.24.5 and
 * 7.23.8, `sour { :beep }` and `s={ :beep }` lower to `source=`, `on`/`o=` to
 * `on-event=`, and `down-scr`/`down-s=` to `down-script=`. These are the
 * prefixes of `source` and `script`, of `on-`, and a name ending in `-` plus a
 * prefix of `script`, so each can only abbreviate a script-valued name. Like
 * the shape, it errs toward body: `sc { :beep }` is rejected on device and
 * offline misses it.
 *
 * Abbreviating the FIRST segment (`down={ :beep }` for `down-script`, also
 * accepted on device) stays outside the PROVEN shape. Every word is a prefix
 * of `<word>-script`, so admitting it here would admit `comment={ :beep }` as
 * a confident body. Telling them apart needs the command's argument list,
 * which is schema — so a `name={` with a script-like body that reaches this
 * far reads as a body for every reader (comments inside are comments) but is
 * warned as a possible abbreviation instead of passing silently (#525,
 * `args.ts` → `invalidCommandBraceOffsets`).
 */
const SCRIPT_BODY_ABBREVIATION =
	/^(?:s(?:o(?:u(?:r(?:c)?)?)?)?|sc(?:r(?:i(?:p)?)?)?|on?|.+-(?:s(?:c(?:r(?:i(?:p)?)?)?)?)?)$/;

/** Whether `name` is a proven script-body slot (full or pinned abbreviation). */
export function isScriptBodyName(name: string): boolean {
	return SCRIPT_BODY_ARG.test(name) || SCRIPT_BODY_ABBREVIATION.test(name);
}

function isAsciiLetter(char: string | undefined): boolean {
	if (char === undefined) return false;
	return (char >= "A" && char <= "Z") || (char >= "a" && char <= "z");
}

/**
 * Whether the `{` at `open` holds a script-like body (#525). `end` is the
 * exclusive brace end (or the text length when unclosed).
 *
 * A body opens with a directive, an absolute command, or one bare command
 * word: `{ :beep }`, `{ /ip … }`, `{ beep }` and `{ # comment⏎:beep }` are
 * all accepted on CHR 7.25. A bare word followed by a top-level `;` is array
 * members, not commands — `.proplist={name;comment}` is device-rejected —
 * so it keeps the error, as do `{1;2}`, `{"x"}`, `{}` and `$`-led values,
 * which cannot open a command at all. The scan touches each byte between
 * the braces once, skipping strings and `#`-to-end-of-line runs, so it is
 * linear; it works on masked and unmasked text alike (a masked comment is
 * already whitespace).
 */
export function braceBodyIsScriptLike(
	text: string,
	open: number,
	end: number,
): boolean {
	let j = open + 1;
	for (;;) {
		if (j >= end) return false;
		const c = text[j] as string;
		if (c === " " || c === "\t" || c === "\r" || c === "\n") {
			j++;
			continue;
		}
		if (c === "#") {
			while (j < end && text[j] !== "\n") j++;
			continue;
		}
		if (c === ":" || c === "/") return true;
		if (!isAsciiLetter(c)) return false;
		break;
	}
	let depth = 0;
	while (j < end) {
		const c = text[j] as string;
		if (c === '"') {
			const scan = scanQuotedString(text, j);
			j = Math.min(scan.end, end);
			continue;
		}
		if (c === "#") {
			while (j < end && text[j] !== "\n") j++;
			continue;
		}
		if (c === "{" || c === "[" || c === "(") depth++;
		else if ((c === "}" || c === "]" || c === ")") && depth > 0) depth--;
		else if (c === ";" && depth === 0) return false;
		j++;
	}
	return true;
}

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
	/**
	 * The innermost open delimiter at each nested `;`/newline boundary. Sparse,
	 * because a per-offset array pushed a 540 KiB document past
	 * `BOUNDARY_CACHE_BYTE_LIMIT` and made every probe rebuild the index.
	 */
	nestedSeparators: Map<number, number>;
	matchingBrace: Map<number, number>;
}

const boundaryCache = new Map<string, StatementIndex>();
let boundaryCacheBytes = 0;
// Most probes in one walk ask about the same document. Bypass Map's string-key
// lookup for that hot path. The slot holds ONE string reference, which may be a
// content-equal twin of a cache key rather than the key itself (see
// `adoptBoundaryText`), so retention is the bounded cache plus that one string.
let recentBoundaryText: string | undefined;
let recentBoundaryIndex: StatementIndex | undefined;

/**
 * Adopt `text` as the single-slot key.
 *
 * A walk asks about several string objects with IDENTICAL content — the
 * `analyzed` surface, the raw input, and a comment mask with nothing to mask
 * are equal strings built by different steps. JavaScript cannot compare string
 * identity, so `recentBoundaryText === text` across two such objects is a full
 * content comparison: measured at 10 us per hit on a 64 KiB document versus
 * 0.01 us when the slot already holds that object. Leaving the slot pointing at
 * the first object made every later probe pay that comparison — a per-call cost
 * that grows with the document, which is the shape #313 saw as superlinear
 * growth through the public entry. Adopting the object on a hit pays it once.
 *
 * Sound because the index is a pure function of content: an index built for one
 * string describes every string equal to it.
 */
function adoptBoundaryText(text: string, index: StatementIndex): void {
	recentBoundaryText = text;
	recentBoundaryIndex = index;
}

function boundaryCacheEntryBytes(text: string, index: StatementIndex): number {
	// JavaScript strings use at most two bytes per UTF-16 code unit. Include the
	// key as well as the typed array so unusually large sources cannot be retained.
	return (
		text.length * 2 +
		index.boundaries.byteLength +
		index.firstContent.byteLength +
		index.lastForbidden.byteLength +
		index.nestedSeparators.size * 32 +
		index.matchingBrace.size * 32
	);
}

/** Whether one statement index fits the bounded cache's per-entry ceiling. */
export function canRetainStatementIndex(text: string): boolean {
	return (
		text.length * 2 + (text.length + 1) * Int32Array.BYTES_PER_ELEMENT * 3 <=
		BOUNDARY_CACHE_BYTE_LIMIT
	);
}

function cacheStatementIndex(text: string, index: StatementIndex): boolean {
	if (!canRetainStatementIndex(text)) return false;
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
	if (recentBoundaryText === text && recentBoundaryIndex !== undefined) {
		const hit = recentBoundaryIndex;
		adoptBoundaryText(text, hit);
		return hit;
	}
	const cached = boundaryCache.get(text);
	if (cached !== undefined) {
		// Move to the most-recent end. Eviction walks the Map in INSERTION order,
		// so without this the cache is FIFO: the document-wide index every ranged
		// reader shares is re-read constantly but never re-inserted, and a stream
		// of one-off statement indices ages it out and makes the next reader
		// rebuild it over the whole document (#322).
		boundaryCache.delete(text);
		boundaryCache.set(text, cached);
		adoptBoundaryText(text, cached);
		return cached;
	}

	const boundaries = new Int32Array(text.length + 1);
	boundaries.fill(-1);
	const firstContent = new Int32Array(text.length + 1);
	firstContent.fill(-1);
	const lastForbidden = new Int32Array(text.length + 1);
	lastForbidden.fill(-1);
	const nestedSeparators = new Map<number, number>();
	const matchingBrace = new Map<number, number>();
	const delimiters: { char: string; at: number }[] = [];
	let boundary = -1;
	let first = -1;
	let forbidden = -1;
	let comment = false;
	let i = 0;
	while (i < text.length) {
		boundaries[i] = boundary;
		firstContent[i] = first;
		lastForbidden[i] = forbidden;
		const c = text[i] as string;
		// A statement-leading `#` runs to the line end, and a `{`, `}` or `"` in
		// it is not structure: `/ip { # }⏎address { print {1;2} } }` is rejected
		// at the inner `{` on CHR 7.24.5 and 7.23.8, so the `}` must not close
		// `/ip {` (#351). Read raw, the bytes are blank, as `maskComments` makes
		// them; read masked, they already are.
		if (comment && c !== "\n") {
			i++;
			continue;
		}
		comment = false;
		if (c === "#" && first === -1 && delimiters.at(-1)?.char !== "(") {
			comment = true;
			i++;
			continue;
		}
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
		if (c === "{" || c === "[" || c === "(") {
			delimiters.push({ char: c, at: i });
		} else if (c === "}" || c === "]" || c === ")") {
			const want = c === "}" ? "{" : c === "]" ? "[" : "(";
			const delimiter = delimiters.pop();
			if (delimiter?.char === want && c === "}")
				matchingBrace.set(delimiter.at, i);
		}
		if (first === -1 && !isAsciiWhitespace(c)) first = i;
		if (c === "=" || c === "[" || c === "(" || c === "$") forbidden = i;
		if (c === "\n" || c === ";" || c === "{" || c === "[") {
			const open = delimiters.at(-1);
			if ((c === "\n" || c === ";") && open !== undefined)
				nestedSeparators.set(i, open.at);
			boundary = i;
			first = -1;
		}
		i++;
	}
	boundaries[text.length] = boundary;
	firstContent[text.length] = first;
	lastForbidden[text.length] = forbidden;
	const index = {
		boundaries,
		firstContent,
		lastForbidden,
		nestedSeparators,
		matchingBrace,
	};
	if (cacheStatementIndex(text, index)) adoptBoundaryText(text, index);
	return index;
}

/** Closing `}` paired with `open`, outside strings/comments, when one exists. */
export function matchingBraceEnd(
	text: string,
	open: number,
): number | undefined {
	return statementIndex(text).matchingBrace.get(open);
}

/**
 * Whether the index itself starts a fresh statement at `start`.
 *
 * Most readers index a comment mask, but segmentation must retain the raw
 * comments. A quote in an earlier comment can make that raw index skip a real
 * body opener as string content. Such a body must build its own local index:
 * clamping lookback alone cannot restore boundaries the outer index skipped.
 */
export function isIndexedStatementStart(text: string, start: number): boolean {
	return start === 0 || statementIndex(text).boundaries[start] === start - 1;
}

/**
 * The bare scope-slot word before a `{`, when the `=` is simply omitted (#347).
 *
 * The device settles this: `:if (1=1) do={…} else={…}`,
 * `:if (1=1) do={…} else {…}` and `:if (1=1) do {…} else {…}` all lower to
 * BYTE-IDENTICAL IL (`…;do=;(evl …);else=;(evl …)`) on 7.21.5, 7.23.5, 7.24.2
 * and 7.25beta3, with `:if (1=1) do={…} elsy {…}` rejected on all four as the
 * control. The `=` is optional punctuation, not part of the slot.
 *
 * Deliberately narrower than {@link trailingName} in two ways, because a bare
 * word is far weaker evidence than `name=`:
 *
 *   - the word must already be a {@link SCOPE_ARG_NAMES} member, so a positional
 *     never becomes a slot — `:local z {1;2}` keeps `z` a positional and its
 *     brace an array;
 *   - it may not be the statement's own leading directive. `:do {` reads its
 *     body through {@link DIRECTIVE_BODY} (as `command`, the IL name), and
 *     letting the head word match here would rename that slot to `do`.
 */
function trailingBareScopeName(
	text: string,
	start: number,
	end: number,
): string | null {
	const name = trailingBareArgumentName(text, start, end);
	return name !== null && SCOPE_ARG_NAMES.has(name) ? name : null;
}

/**
 * The bare word before a `{` when it can be an argument name: not the
 * statement's leading word, and not a `:` directive. Lower-cased.
 */
function trailingBareArgumentName(
	text: string,
	start: number,
	end: number,
): string | null {
	let i = end - 1;
	while (i >= start && isAsciiWhitespace(text[i])) i--;
	const nameEnd = i + 1;
	while (i >= start && /[A-Za-z0-9.-]/.test(text[i] as string)) i--;
	const nameStart = i + 1;
	if (nameStart === nameEnd) return null;
	const name = text.slice(nameStart, nameEnd).toLowerCase();
	// A COLON makes it a directive, never an argument name, and the device is
	// emphatic: `:if (1=1) :do { :put a }` is `expected end of command` on both
	// 7.21.5 and 7.24.2, while the bare `:if (1=1) do { :put a }` parses. So the
	// colon form is refused here and left to the `DIRECTIVE_BODY` branch below,
	// which is what legitimately reads a statement-head `:do { … }`.
	if (text[nameStart - 1] === ":") return null;
	if (leadingWords(text, start, nameStart, 1).length === 0) return null;
	return name;
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

/**
 * Scope name for an already comment-masked source view.
 *
 * `floor` is the start of the region the caller is reading, defaulting to the
 * whole view. Clamping the statement start to it makes an answer read off a
 * RANGE of a document identical to the same answer read off that range taken as
 * a string of its own: a fresh call cannot see before index 0, so a ranged call
 * must not see before `floor` (#322).
 *
 * It is a guard, not a correction. The clamp does fire on ordinary input —
 * 7,448 times over the 948-script corpus, where a region begins somewhere the
 * preceding boundary character does not — but removing it leaves every one of
 * those 948 results byte-identical, because the extra bytes a wider lookback
 * sees do not spell a scope name. What it buys is that the equality holds by
 * CONSTRUCTION rather than by a property of where today's ranges happen to
 * start, which is what the next reader to take a range will rely on.
 *
 * Nothing else needs clamping — `firstContent` and `lastForbidden` are only
 * ever compared against `start`, so a value from before the floor is already
 * excluded by being less than it.
 */
export function scopeNameFromMasked(
	masked: string,
	open: number,
	floor = 0,
): string | null {
	const index = statementIndex(masked);
	const start = Math.max((index.boundaries[open] ?? -1) + 1, floor);
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
	// `else {` / `do {` / `on-error {` — the same slot with the `=` left off.
	// Checked before the directive-body branch so the ARGUMENT reading wins over
	// the head reading for a word that can be either.
	const bare = trailingBareScopeName(masked, start, open);
	if (bare !== null) return bare;
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

/**
 * Whether this brace begins a context in which statement-leading comments exist.
 *
 * `floor` bounds the lookback exactly as in {@link scopeNameFromMasked}.
 * `unprovenName` decides the unproven `name={` guess below: `"body"` reads it
 * as a body, `"value"` as a value. Only the script-like disjunct is gated —
 * a proven slot stays a body either way. Readers that are themselves deciding
 * an error AT this brace pass `"value"` where the slot cannot bear a body
 * (`args.ts` for a root directive's slots and a `where` named comparison,
 * `group-faults.ts` for the bracketed form), so the guess does not swallow
 * their error; every other reader keeps `"body"`.
 */
export function braceStartsStatements(
	text: string,
	open: number,
	floor = 0,
	unprovenName: "body" | "value" = "body",
): boolean {
	if (scopeNameFromMasked(text, open, floor) !== null) return true;
	const index = statementIndex(text);
	const boundary = index.boundaries[open] ?? -1;
	const start = Math.max(boundary + 1, floor);
	const named = trailingName(text, start, open);
	if (named !== null) {
		// A `name={` with a script-like body reads as a body for every
		// reader, proven slot or not (#525): `down={ beep }` and
		// `down={ # comment⏎:beep }` are accepted on CHR 7.25, and the `#`
		// is only a comment when the brace bears statements. The warning
		// that marks the unproven slot lives in `args.ts`, which checks
		// ambiguity before this skip.
		if (isScriptBodyName(named.toLowerCase())) return true;
		if (unprovenName === "value") return false;
		const close = matchingBraceEnd(text, open);
		return braceBodyIsScriptLike(
			text,
			open,
			close === undefined ? text.length : close + 1,
		);
	}
	// `source { :beep }` — the same body with the `=` left out (#350). Every
	// grounded spelling lowers to the `source=` IL on CHR 7.22.1 and 7.24.5:
	// `/system/script add name=beep source { :beep }`, `/system/scheduler add
	// name=x on-event { :beep }`, `/tool/netwatch add … down-script { :beep }`.
	// The control is `comment { :beep }`, a `syntax error` on both. A
	// declaration's operand is a variable name, not an argument, so
	// `:local myscript {1;2}` keeps its brace an array.
	const bare = trailingBareArgumentName(text, start, open);
	if (bare !== null && isScriptBodyName(bare)) {
		const head = index.firstContent[open] ?? -1;
		const word =
			head < start ? "" : (leadingWords(text, head, open, 1)[0] ?? "");
		if (!/^:|^(?:local|global)$/i.test(word)) return true;
	}

	// H7's bare `{...}` and `/menu {...}` containers are statement bodies too,
	// but a run that already names a command makes the brace its operand (#496).
	// `start` follows the last `{`, so each brace reads its own run: linear.
	const first = index.firstContent[open] ?? -1;
	if (first < start) return true;
	if (text[first] === "/")
		return (
			(index.lastForbidden[open] ?? -1) < start &&
			!runNamesCommand(text.slice(first, open))
		);
	return menuBlockPath(text, open, floor) !== null;
}

/** Nesting a {@link menuBlockPath} lookup follows before it abstains. */
const MAX_MENU_BLOCK_DEPTH = 64;

/**
 * A relative run of bare path words, space- or slash-separated. Each word is
 * `pathresolve`'s `BARE_WORD`: the resolver reads no digit-led word as a path,
 * so admitting `6to4 {` here would flatten a block whose navigation it then
 * ignores, resolving the body's `print` against `/interface`.
 */
const RELATIVE_MENU_RUN =
	/^[A-Za-z][A-Za-z0-9._-]*(?:[ \t/]+[A-Za-z][A-Za-z0-9._-]*)*$/;

/**
 * The menu a `{` opens a statement block over, when the source alone says so
 * (#351). Null means offline cannot tell, not that the brace is a value.
 *
 * On CHR 7.24.5 and 7.23.8 a brace right after a menu word is always a
 * statement block, at any depth and whatever the body holds:
 * `/ip { address { 1;2 } }` is `bad command name 1` at the `1`, and
 * `/ip { address { a;b } }` reads `a` as `add`. A brace after a command word is
 * always an error at the `{` (`/ip { address { print {1;2} } }`). The `/`-led
 * spelling was already read as a block; the RELATIVE one (`address {` inside
 * `/ip { … }`) was read as `/ip address` with a brace operand. That is what
 * hard-failed the outer brace at depth three and hid every fault in the body.
 *
 * A relative run is a block only when the menu it names is known: the
 * enclosing container's path, read the same way outward, plus the run, named by
 * a shipped structure table. A miss abstains, so an unknown word keeps today's
 * reading and the resolver says `unresolved`. The path is lexical: a
 * navigation statement earlier in the same body (`/ip { firewall; address {`)
 * is not followed, and the resolver checks the flattened run against the real
 * context, so that residue can only abstain. Abbreviated menus (`addr {`) are
 * not expanded, as R13 does not expand them.
 *
 * `floor` keeps the ranged-call contract of {@link scopeNameFromMasked}: no
 * enclosing brace before it is consulted, so a range reads exactly as the same
 * text taken alone.
 */
export function menuBlockPath(
	text: string,
	open: number,
	floor = 0,
): readonly string[] | null {
	return blockPathAt(text, statementIndex(text), open, floor, 0);
}

function blockPathAt(
	text: string,
	index: StatementIndex,
	open: number,
	floor: number,
	depth: number,
): readonly string[] | null {
	if (depth > MAX_MENU_BLOCK_DEPTH) return null;
	const start = Math.max((index.boundaries[open] ?? -1) + 1, floor);
	const first = index.firstContent[open] ?? -1;
	if (first < start) return enclosingBlockPath(text, index, open, floor, depth);
	if ((index.lastForbidden[open] ?? -1) >= start) return null;
	const run = text.slice(first, open);
	if (text[first] === "/") {
		if (runNamesCommand(run)) return null;
		return runTokens(run).map((token) => token.name);
	}
	const trimmed = run.trim();
	if (!RELATIVE_MENU_RUN.test(trimmed)) return null;
	const names = trimmed.split(/[\s/]+/);
	if (names.some((name) => VERBS.has(name))) return null;
	const parent = enclosingBlockPath(text, index, open, floor, depth);
	if (parent === null) return null;
	const path = [...parent, ...names];
	if (commandVerbIndex(path) !== null || !isKnownMenuPath(path)) return null;
	return path;
}

/**
 * The path of the container `{` around the statement that holds `at`, when it
 * is one. The statement starts after a boundary: an opening `{`/`[` is the
 * enclosing delimiter itself, and a separator records it.
 */
function enclosingBlockPath(
	text: string,
	index: StatementIndex,
	at: number,
	floor: number,
	depth: number,
): readonly string[] | null {
	const boundary = index.boundaries[at] ?? -1;
	const outer =
		boundary < 0 || text[boundary] === "{" || text[boundary] === "["
			? boundary
			: (index.nestedSeparators.get(boundary) ?? -1);
	if (outer < floor || text[outer] !== "{") return null;
	return blockPathAt(text, index, outer, floor, depth + 1);
}

/**
 * Whether the `#` at `at` opens a comment line inside an array literal (#503).
 *
 * `frame` is the innermost open delimiter. CHR 7.24.5 and 7.22.1 agree: inside
 * a `{…}` that is not a statement body, a `#` at column 0 comments out the
 * rest of its line, at any nesting depth and in argument values too
 * (`:local z {a=1;⏎# c⏎b=2}` → `value=a=1;b=2`, `:foreach i in={1;⏎# c⏎2}`).
 * An indented `#` (space or tab), a `#` after a value or `;` on the same line,
 * and a `#` directly inside `( … )` are still syntax errors. A comment-only
 * array is rejected, but so is `{}`: that is the empty-array rule, not this one.
 */
export function startsArrayCommentLine(
	text: string,
	at: number,
	frame: { char: string; statements: boolean } | undefined,
): boolean {
	return (
		text[at - 1] === "\n" && frame?.char === "{" && frame.statements === false
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
	floor = 0,
): boolean {
	if (inExpression) return true;
	if (at <= floor || !isAsciiWhitespace(text[at - 1])) return false;

	let previous = at - 1;
	while (previous >= floor && isAsciiWhitespace(text[previous])) previous--;
	// The `}` must be inside the region: a fresh call on the region alone runs
	// off index 0 and finds nothing, so a ranged call must stop at `floor`.
	if (previous >= floor && text[previous] === "}") return true;

	const index = statementIndex(text);
	const start = Math.max((index.boundaries[at] ?? -1) + 1, floor);
	const first = index.firstContent[at] ?? -1;
	const words = first < start ? [] : leadingWords(text, first, at, 3, true);
	const rawHead = (words[0] ?? "").toLowerCase();
	if (!rawHead.startsWith(":") && !rawHead.startsWith("/")) return false;
	const head = rawHead.slice(1);
	const arity = DIRECTIVE_POSITIONAL_ARITY[head];
	return arity !== undefined && words.length - 1 >= arity;
}
