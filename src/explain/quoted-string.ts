/**
 * Shared RouterOS double-quoted string boundary scanner.
 *
 * Kept below both `segment.ts` and `scope-brace.ts` so statement-boundary
 * lookback can ignore separators inside strings without creating an import
 * cycle or growing a second, drifting quote scanner (#199/#246 review).
 */

import { type Defect, defectAt } from "./defects.ts";

/** Analyzer resource bound, not a RouterOS grammar limit. */
const MAX_STRING_FRAME_DEPTH = 256;

/** Where a double-quoted string ends, and whether it was closed at all. */
export interface QuotedStringScan {
	/** index just past the closing `"`, or `text.length` when unterminated. */
	end: number;
	closed: boolean;
}

/**
 * Valid single-char escapes after `\` inside a RouterOS string.
 *
 * This is the DEVICE's set, not the manual's table. The manual's
 * "Constant Escape Sequences" list is a lower bound: it omits `\?`, which
 * RouterOS classes `escaped` and evaluates to `?`. Swept byte by byte on CHR
 * 7.23.3 — `:put "\<c>"` for every 0x20–0x7E plus TAB/LF/CRLF, scored on both
 * the `/console/inspect request=highlight` class and the runtime result — and
 * the accepted set is exactly these plus whitespace continuations plus
 * two-digit uppercase hex (#252). Re-derive with
 * `bun run explain:probe:escapes` (#186).
 */
const VALID_SINGLE = new Set([
	'"',
	"\\",
	"n",
	"r",
	"t",
	"$",
	"_",
	"a",
	"b",
	"f",
	"v",
	"?",
]);

function isHexUpper(c: string): boolean {
	return (c >= "0" && c <= "9") || (c >= "A" && c <= "F");
}

/**
 * `\` before whitespace is a line continuation INSIDE a string too, not only in
 * code: the device swallows the pair and emits nothing (`:put "a\ b"` -> `ab`,
 * and the same for TAB/CR/LF/CRLF). The manual states it under "Line joining" —
 * "A backslash does not continue a token except for string". Every multi-line
 * `source=`/`on-event=` script in the wild relies on it.
 */
function isContinuationWhitespace(c: string): boolean {
	return c === " " || c === "\t" || c === "\r" || c === "\n";
}

/**
 * Is the escape at `at` (where text[at] === `\`) inside a string valid?
 * Returns true for valid, false for invalid (unknown, lowercase hex, truncated).
 */
function isValidStringEscape(text: string, at: number): boolean {
	const next1 = text[at + 1];
	if (next1 === undefined) return false;
	if (VALID_SINGLE.has(next1)) return true;
	if (isContinuationWhitespace(next1)) return true;
	if (isHexUpper(next1)) {
		const next2 = text[at + 2];
		if (next2 !== undefined && isHexUpper(next2)) return true;
		return false;
	}
	return false;
}

/**
 * Bytes to skip past the escape at `at`. Always 2 or 3 so recovery advances
 * even when the escape is malformed (#199). CRLF is ONE continuation, so it is
 * the only non-hex three-byte escape.
 */
function escapeLength(text: string, at: number): 2 | 3 {
	const next1 = text[at + 1];
	if (next1 === "\r" && text[at + 2] === "\n") return 3;
	if (
		next1 !== undefined &&
		isHexUpper(next1) &&
		isHexUpper(text[at + 2] ?? "")
	)
		return 3;
	return 2;
}

// ---------------------------------------------------------------------------
// Single source of truth for the frame grammar (#253).
//
// Both `scanQuotedString` and `collectStringEscapeDefects` walk the same
// nesting: a `"` frame is string phase, anything else is code phase where
// `$[`/`$(` inside a string push a bracket frame and brackets nest until
// matched. The helpers below own the transitions, the depth guard, and the
// phase dispatch once — callers differ only in what they do with an escape
// (skip vs validate) and whether they skip comment spans.
// ---------------------------------------------------------------------------

/**
 * One step of the shared frame machine. Owns the depth guard, the `top` read,
 * and the phase dispatch (`"` vs code) so callers cannot drift on them.
 * When inside a string at `\`, delegates to `onStringEscape` so callers can
 * validate or just skip. Returns bytes to advance, or a Defect, or 0 when the
 * shared depth cap is hit (caller must break).
 */
function stepFrame(
	text: string,
	i: number,
	frames: string[],
	onStringEscape: (at: number) => number | Defect,
): number | Defect {
	if (frames.length > MAX_STRING_FRAME_DEPTH) return 0;
	const top = frames[frames.length - 1] as string | undefined;
	const c = text[i] as string;
	if (top === '"') {
		if (c === "\\") return onStringEscape(i);
		if (c === '"') {
			frames.pop();
			return 1;
		}
		if (c === "$" && (text[i + 1] === "[" || text[i + 1] === "(")) {
			frames.push(text[i + 1] as string);
			return 2;
		}
		return 1;
	}
	if (c === '"') {
		frames.push('"');
		return 1;
	}
	if (c === "[" || c === "(" || c === "{") {
		frames.push(c);
		return 1;
	}
	if (c === "]" || c === ")" || c === "}") {
		const want = c === "]" ? "[" : c === ")" ? "(" : "{";
		if (top === want) frames.pop();
		return 1;
	}
	return 1;
}

/**
 * Boundary recovery must skip the escaped byte even when the escape itself
 * is malformed, otherwise the closing quote is lost and every later comment
 * is swallowed (#199). Validation is separate; here we just advance.
 */
function stringEscapeSkip(text: string, at: number): number {
	return escapeLength(text, at);
}

/**
 * Locate defect at the escaped byte the device marks `error`.
 * For `\q` it's `q`; for `\0a` it's `a`.
 * For truncated `\0` before `"` the device marks the closing quote;
 * centrs reports at the backslash instead, because that byte is stable
 * when the string is unterminated (#252).
 */
function stringEscapeValidated(text: string, at: number): number | Defect {
	if (!isValidStringEscape(text, at)) {
		const next1 = text[at + 1];
		let defectAtOffset: number;
		if (next1 === undefined) defectAtOffset = at;
		else if (isHexUpper(next1)) {
			const next2 = text[at + 2];
			if (next2 === undefined) defectAtOffset = at;
			else if (!isHexUpper(next2)) defectAtOffset = at + 2;
			else defectAtOffset = at;
		} else defectAtOffset = at + 1;
		return defectAt("bad-string-escape", defectAtOffset);
	}
	return escapeLength(text, at);
}

/**
 * Find the end of the double-quoted string that opens at `open`.
 *
 * A `$[…]` or `$(…)` substitution inside a string is code and may contain
 * nested strings, so the next quote is not necessarily the outer close.
 */
export function scanQuotedString(text: string, open: number): QuotedStringScan {
	const frames: string[] = ['"'];
	let i = open + 1;
	while (i < text.length) {
		const res = stepFrame(text, i, frames, (at) => stringEscapeSkip(text, at));
		if (typeof res !== "number") break;
		if (res === 0) break;
		i += res;
		if (frames.length === 0) return { end: i, closed: true };
	}
	return { end: text.length, closed: false };
}

/**
 * Collect the first invalid string-internal escape in `text`, if any.
 *
 * Walks the entire document with the same frame model as `scanQuotedString`,
 * but validates each `\` inside a string frame against the documented escape
 * table (capital hex, truncated, unknown). Returns an array with at most one
 * defect at the first invalid escape. Comment spans are skipped: a `"` inside
 * a comment is not a string.
 */
export function collectStringEscapeDefects(
	text: string,
	comments: readonly { start: number; end: number }[] = [],
): Defect[] {
	const frames: string[] = [];
	let i = 0;
	let ci = 0;
	while (i < text.length) {
		// Skip comment spans (analyzed-byte offsets, same space as `text`).
		while (
			ci < comments.length &&
			i >= (comments[ci] as { start: number; end: number }).end
		)
			ci++;
		if (ci < comments.length) {
			const c = comments[ci] as { start: number; end: number };
			if (i >= c.start && i < c.end) {
				i = c.end;
				continue;
			}
		}
		const res = stepFrame(text, i, frames, (at) =>
			stringEscapeValidated(text, at),
		);
		if (typeof res !== "number") return [res];
		if (res === 0) break;
		i += res;
	}
	return [];
}
