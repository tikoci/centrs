/**
 * Shared RouterOS double-quoted string boundary scanner.
 *
 * Kept below both `segment.ts` and `scope-brace.ts` so statement-boundary
 * lookback can ignore separators inside strings without creating an import
 * cycle or growing a second, drifting quote scanner (#199/#246 review).
 */

/** Analyzer resource bound, not a RouterOS grammar limit. */
const MAX_STRING_FRAME_DEPTH = 256;

/** Where a double-quoted string ends, and whether it was closed at all. */
export interface QuotedStringScan {
	/** index just past the closing `"`, or `text.length` when unterminated. */
	end: number;
	closed: boolean;
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
				i += 2;
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
