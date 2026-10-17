/**
 * The leading path-token run of a statement, for `explain`.
 *
 * A leaf module (it imports only the leaf data tables) so that `segment.ts` and
 * `scope-brace.ts` can ask the question `verbsplit.ts` asks — "does this run
 * already name a command verb?" (#496) — without the import cycle
 * `verbsplit.ts` → `segment.ts` would make.
 * It is the one word scanner both use; a second one written beside it would be
 * free to disagree with the boundary rule. `verbsplit.ts` re-exports the public
 * names, so the Q6 surface is unchanged.
 */

import { commandVerbIndex } from "./catalog.ts";
import type { Span } from "./pathresolve.ts";
import { VERBS } from "./verbs.ts";

const BARE_WORD = /^[A-Za-z][A-Za-z0-9._-]*$/;
/**
 * A word that ends the leading run: it carries `=` (V2) or opens a group /
 * string / variable (V3). `:` is deliberately NOT here — RouterOS uses it only
 * to start a scripting directive, not as a mid-statement opener, and a
 * `:`-prefixed token is already rejected by `BARE_WORD` below, so it ends the
 * run regardless.
 */
const RUN_TERMINATOR = /^[[({"$]/;

export function isAsciiWhitespace(char: string | undefined): boolean {
	return char === " " || char === "\t" || char === "\r" || char === "\n";
}

/** One whitespace-separated word, and where it sits in the text it came from. */
export interface Word {
	name: string;
	/** offset of the word's first character, inclusive. */
	start: number;
	/** offset just past its last character, exclusive. */
	end: number;
	/** Source span of each character retained in `name`. */
	chars: Span[];
}

/**
 * The words of a statement, WITH their offsets (#202c).
 *
 * The one word scanner this module has. It replaced a
 * `replace(/\\\r?\n/g,"").split(whitespace)` pair whose output could not be
 * mapped back to the text it came from — and a second scanner written beside it
 * for the offsets would be free to disagree with the boundary rule, which is the
 * failure #202b hit three times in argument handling.
 *
 * H5 from the Q1 segmenter: a `\<newline>` is removed before RouterOS parses the
 * continued line, so it JOINS the words either side of it rather than separating
 * them (`na\<nl>me` is the single word `name`) and contributes no character to
 * the name. That is why a word's `end - start` is not its `name.length`: the span
 * covers the continuation bytes, the name does not. A caller taking an interior
 * offset from a name is therefore wrong on continued statements, and
 * {@link describeStatement} only ever publishes the run's END.
 */
export function* asciiWordSpans(text: string): Generator<Word> {
	// Yielded ONE WORD AT A TIME rather than returned as a list. Both readers
	// stop at the first word the leading run cannot take, and a statement's text
	// carries its whole nested `do={…}` subtree — so building a word (and a span
	// per character of it) for the rest of that subtree was work no caller ever
	// looked at, once per enclosing level (#322). A word is complete when the
	// next one starts, which is why the yield happens on the following boundary
	// rather than at the point the word is opened.
	let current: Word | null = null;
	let i = 0;
	while (i < text.length) {
		const c = text[i] as string;
		if (
			c === "\\" &&
			(text[i + 1] === "\n" || (text[i + 1] === "\r" && text[i + 2] === "\n"))
		) {
			// Inside a word this joins; between words it is whitespace that opens
			// none — matching the removal-then-split the rule replaced.
			i += text[i + 1] === "\r" ? 3 : 2;
			if (current !== null) current.end = i;
			continue;
		}
		if (isAsciiWhitespace(c)) {
			if (current !== null) yield current;
			current = null;
			i++;
			continue;
		}
		if (current === null) {
			current = {
				name: c,
				start: i,
				end: i + 1,
				chars: [{ start: i, end: i + 1 }],
			};
		} else {
			current.name += c;
			current.end = i + 1;
			current.chars.push({ start: i, end: i + 1 });
		}
		i++;
	}
	if (current !== null) yield current;
}

/** Separator that precedes a run token (V1). */
export type Sep = "start" | "slash" | "space";

/** One token of the leading path run, with the punctuation that introduced it. */
export interface RunToken {
	name: string;
	sep: Sep;
}

/** A run token mapped back to the statement bytes that spell it. */
export interface LocatedRunToken extends RunToken {
	/** Name bytes, split where a `\<newline>` continuation interrupts them. */
	nameSpans: Span[];
	/** One valid `/` immediately before this token, if present. */
	slashBefore?: Span;
	/** One trailing `/` after this token, if present. */
	slashAfter?: Span;
}

function coalesceChars(chars: readonly Span[]): Span[] {
	const out: Span[] = [];
	for (const char of chars) {
		const last = out.at(-1);
		if (last !== undefined && last.end === char.start) last.end = char.end;
		else out.push({ start: char.start, end: char.end });
	}
	return out;
}

/**
 * The leading path-token run WITH separators preserved (V1). Same stopping
 * rules as `pathresolve`'s run (V2/V3), so the two stay comparable: a slash-
 * joined word expands to several `slash`-separated tokens; a space-separated
 * word is one `space` token. Stops at the first `=`/group/string/var word, and
 * at any word carrying a non-`BARE_WORD` segment (a variable segment truncates
 * the run before the verb).
 */
export function locatedRunTokens(text: string): LocatedRunToken[] {
	const out: LocatedRunToken[] = [];
	for (const word of asciiWordSpans(text)) {
		if (word.name.includes("=") || RUN_TERMINATOR.test(word.name)) break;
		const parts: {
			name: string;
			start: number;
			end: number;
			slashBefore?: Span;
		}[] = [];
		let start = 0;
		for (let i = 0; i <= word.name.length; i++) {
			if (i < word.name.length && word.name[i] !== "/") continue;
			if (start < i) {
				const slashRunStart = start;
				let slashCount = 0;
				while (
					slashRunStart - slashCount - 1 >= 0 &&
					word.name[slashRunStart - slashCount - 1] === "/"
				)
					slashCount++;
				const slashIndex = slashCount === 1 ? slashRunStart - 1 : -1;
				parts.push({
					name: word.name.slice(start, i),
					start,
					end: i,
					...(slashIndex < 0 ? {} : { slashBefore: word.chars[slashIndex] }),
				});
			}
			start = i + 1;
		}
		if (parts.length === 0) continue;
		if (!parts.every((p) => BARE_WORD.test(p.name))) break;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i] as (typeof parts)[number];
			const leadingSlash = word.name.startsWith("/") && i === 0;
			const trailingSlash =
				i === parts.length - 1 &&
				word.name.endsWith("/") &&
				!word.name.endsWith("//")
					? word.chars.at(-1)
					: undefined;
			out.push({
				name: part.name,
				sep:
					out.length === 0
						? "start"
						: i > 0 || leadingSlash
							? "slash"
							: "space",
				nameSpans: coalesceChars(word.chars.slice(part.start, part.end)),
				...(part.slashBefore === undefined
					? {}
					: { slashBefore: part.slashBefore }),
				...(trailingSlash === undefined ? {} : { slashAfter: trailingSlash }),
			});
		}
	}
	return out;
}

export function runTokens(text: string): RunToken[] {
	return locatedRunTokens(text).map(({ name, sep }) => ({ name, sep }));
}

/**
 * #496 — the run before a `{` already names a command, so the brace is that
 * command's operand and not a `/menu { … }` container. `/system/script add
 * name beep source { :beep }` is one `add` whose `source` is the body, and
 * `/ip/route/print {1;2}` is a positional brace the device rejects (CHR
 * 7.22.1/7.24.5 `:parse`); neither is a command followed by a menu body.
 * `segment.ts` (H7) and `scope-brace.ts` each spelled the container rule
 * lexically, and both ask here. The two tables are the ones `verbsplit`
 * decides a verb with — the frozen vocabulary and the catalog's command axis —
 * and both are floors: a run naming neither keeps the container reading
 * (`/system script { print }`).
 */
export function runNamesCommand(prefix: string): boolean {
	const names = runTokens(prefix).map((token) => token.name);
	return (
		names.some((name) => VERBS.has(name)) || commandVerbIndex(names) !== null
	);
}
