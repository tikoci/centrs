/**
 * B3 string fill — claims quoted-string spans on the residual.
 *
 * Every RouterOS double-quoted string is a lexical unit the device highlights
 * (even when its value is not a literal, the delimiters are). `data.values`
 * already claims argument value strings (quotes included), so this fill runs
 * **after** `value` and sees only the residual: quoted declaration names
 * (`:global "set-dns"`), quoted variable references (`$"set-dns"`), and
 * string content inside substitutions that value anchoring did not locate.
 *
 * All quoted runs are produced by the single shared scanner
 * `src/explain/quoted-string.ts` (`scanQuotedString`), the same primitive the
 * segmenter and symbol resolver use, so boundaries cannot drift.
 *
 * One `string` class per quoted run, delimiters included, regardless of whether
 * the string is a literal value, a name, or code. The delimiters are part of
 * the run because they are its own first and last byte, so nothing is gained by
 * naming them separately (#264 B5).
 *
 * A run is **not** necessarily one token, and escapes are why. The `escaped`
 * fill (`src/explain/escape-tokens.ts`) claims valid escapes two stages earlier,
 * so what reaches here is the run minus its escapes and this fill emits a
 * fragment either side of each one — `"a\nb"` is `string("a) escaped(\n)
 * string(b")`. Splitting the run that way is not new machinery: `clipToResidual`
 * already fragmented these runs around `variable-*` spans. #264 made that split
 * because a valid escape is recoverable from no other published surface, where a
 * delimiter is recoverable from the run's own first and last byte — which is why
 * the escapes are named and the delimiters are not.
 */

import type { ExplainToken } from "../explain.ts";
import { scanQuotedString } from "./quoted-string.ts";
import { clipToResidual } from "./token-ranges.ts";

/** Quoted-string spans on the residual. */
export function stringSpans(
	analyzed: string,
	residual: readonly { start: number; end: number }[],
): ExplainToken[] {
	const len = analyzed.length;
	if (len === 0 || residual.length === 0) return [];
	const raw: { start: number; end: number }[] = [];
	for (let i = 0; i < analyzed.length; i++) {
		if (analyzed[i] !== '"') continue;
		// Earlier fills own semantic regions. In particular, a quote inside a
		// comment must not open a string that paints later statements when that
		// comment has no matching quote. A real residual string always has its
		// opening delimiter on the residual; already-owned strings need no fill.
		if (clipToResidual(i, i + 1, residual).length === 0) continue;
		const scan = scanQuotedString(analyzed, i);
		if (!scan.closed) {
			// Unterminated strings are already a defect; claim from opener to
			// end so the residual does not stay gap-filled as unclassified
			// while the diagnostic says the same bytes are defective.
			raw.push({ start: i, end: analyzed.length });
			break;
		}
		raw.push({ start: i, end: scan.end });
		i = scan.end - 1;
	}
	if (raw.length === 0) return [];
	const out: ExplainToken[] = [];
	for (const { start, end } of raw) {
		if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
		if (start < 0 || end <= start || end > len) continue;
		for (const r of clipToResidual(start, end, residual)) {
			out.push({
				start: r.start,
				end: r.end,
				class: "string" as const,
				ev: "e13",
			});
		}
	}
	out.sort((a, b) => a.start - b.start || a.end - b.end);
	return out;
}
