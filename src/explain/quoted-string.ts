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

/** Valid single-char escapes after `\` inside a RouterOS string. */
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
]);

function isHexUpper(c: string): boolean {
	return (c >= "0" && c <= "9") || (c >= "A" && c <= "F");
}

/**
 * Is the escape at `at` (where text[at] === `\`) inside a string valid?
 * Returns true for valid, false for invalid (unknown, lowercase hex, truncated).
 */
function isValidStringEscape(text: string, at: number): boolean {
	const next1 = text[at + 1];
	if (next1 === undefined) return false;
	if (VALID_SINGLE.has(next1)) return true;
	if (isHexUpper(next1)) {
		const next2 = text[at + 2];
		if (next2 !== undefined && isHexUpper(next2)) return true;
		return false;
	}
	return false;
}

/**
 * Bytes to skip past the escape at `at`. Always 2 or 3 so recovery advances
 * even when the escape is malformed (#199).
 */
function escapeLength(text: string, at: number): 2 | 3 {
	const next1 = text[at + 1];
	if (
		next1 !== undefined &&
		isHexUpper(next1) &&
		isHexUpper(text[at + 2] ?? "")
	)
		return 3;
	return 2;
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
		if (frames.length > MAX_STRING_FRAME_DEPTH) break;
		const top = frames[frames.length - 1] as string;
		const c = text[i] as string;
		if (top === '"') {
			if (c === "\\") {
				// Boundary recovery must skip the escaped byte even when the
				// escape itself is malformed, otherwise the closing quote is
				// lost and every later comment is swallowed (#199).
				// Validation is separate below; here we just advance.
				i += escapeLength(text, i);
				continue;
			}
			if (c === '"') {
				frames.pop();
				i++;
				if (frames.length === 0) return { end: i, closed: true };
				continue;
			}
			if (c === "$" && (text[i + 1] === "[" || text[i + 1] === "(")) {
				frames.push(text[i + 1] as string);
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		if (c === '"' || c === "[" || c === "(" || c === "{") {
			frames.push(c);
			i++;
			continue;
		}
		if (c === "]" || c === ")" || c === "}") {
			const want = c === "]" ? "[" : c === ")" ? "(" : "{";
			if (top === want) frames.pop();
			i++;
			continue;
		}
		i++;
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
		if (frames.length > MAX_STRING_FRAME_DEPTH) break;
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
		const top = frames[frames.length - 1] as string | undefined;
		const c = text[i] as string;
		if (top === '"') {
			if (c === "\\") {
				if (!isValidStringEscape(text, i)) {
					// Locate defect at the escaped byte the device marks `error`.
					// For `\q` it's `q`; for `\0a` it's `a`.
					// For truncated `\0` before `"` the device marks the closing
					// quote; centrs reports at the backslash instead, because that
					// byte is stable when the string is unterminated.
					const next1 = text[i + 1];
					let defectAtOffset: number;
					if (next1 === undefined) defectAtOffset = i;
					else if (isHexUpper(next1)) {
						const next2 = text[i + 2];
						if (next2 === undefined) defectAtOffset = i;
						else if (!isHexUpper(next2)) defectAtOffset = i + 2;
						else defectAtOffset = i;
					} else defectAtOffset = i + 1;
					return [defectAt("bad-string-escape", defectAtOffset)];
				}
				i += escapeLength(text, i);
				continue;
			}
			if (c === '"') {
				frames.pop();
				i++;
				continue;
			}
			if (c === "$" && (text[i + 1] === "[" || text[i + 1] === "(")) {
				frames.push(text[i + 1] as string);
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		// outside string
		if (c === '"') {
			frames.push('"');
			i++;
			continue;
		}
		if (c === "[" || c === "(" || c === "{") {
			frames.push(c);
			i++;
			continue;
		}
		if (c === "]" || c === ")" || c === "}") {
			const want = c === "]" ? "[" : c === ")" ? "(" : "{";
			if (top === want) frames.pop();
			i++;
			continue;
		}
		i++;
	}
	return [];
}
