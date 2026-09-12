/**
 * Escape fill — claims valid string-internal escape sequences on the residual.
 *
 * The one split #264 B5's rule admits and PR #330 did not make. B5's rule is
 * that a merged class is split only where a consumer needs the distinction AND
 * cannot recover it by joining `tokens[]` to another published surface on byte
 * offsets. A valid escape passes both halves: only INVALID escapes surface
 * elsewhere (as `bad-string-escape` diagnostics), so a consumer holding the
 * token stream has no published surface to join against to find the valid ones,
 * and the device does name them — `escaped` is one of the 19 classes the Q13
 * capture observed.
 *
 * Unlike `arg-sep` this needs a real walk rather than a relabel of one
 * analyzer's own output, and it takes bytes out of TWO fills at once rather
 * than one. In byte terms it is still a retag: measured over the corpus
 * `escaped` claims 19,960 bytes, `string` gives up 17,672 and `value` 2,288,
 * and classified coverage is identical to the last decimal. Nothing that was
 * `unclassified` becomes claimed — an escape only ever lives inside a run some
 * fill already held.
 *
 * The walk is not this module's. `src/explain/quoted-string.ts` already owned
 * the escape grammar for `bad-string-escape`, and `walkStringEscapes` now
 * returns both halves of that single reading, so an `escaped` token and a
 * `bad-string-escape` diagnostic cannot disagree about which bytes are an
 * escape. This module only clips that list onto the residual.
 *
 * ## Fill order: before `value`, after `arg`
 *
 * An escape is interior to a quoted run, so it must claim before the two fills
 * that would otherwise swallow it whole (`value`, then `string`) — after them
 * it could claim nothing. It runs after `arg` because an argument NAME run is
 * the analyzer's own located token and nothing inside it is a string interior;
 * leaving `arg` ahead keeps the located reading winning over a byte scan, which
 * is the same precedence every earlier fill was given (#290 design decision 1).
 * Splitting a `value` or `string` run into fragments around an escape is the
 * mechanism those fills already have — `~1,720` leaf value bytes were already
 * being fragmented by `variable-*` spans before this fill existed.
 */

import type { ExplainToken } from "../explain.ts";
import type { StringEscapeSpan } from "./quoted-string.ts";
import { clipToResidual } from "./token-ranges.ts";

/**
 * Valid string-internal escape spans on the residual.
 *
 * `analyzed` is the ASCII-normalized document text (length checks only);
 * `residual` is the gap set left by earlier fills (sorted, no overlaps);
 * `escapes` are the valid escapes from `walkStringEscapes`, already in
 * analyzed-byte space. Every emitted span's bytes are fully inside `residual`,
 * sorted by `start`, non-overlapping, and carry `class: "escaped"`.
 */
export function escapeSpans(
	analyzed: string,
	residual: readonly { start: number; end: number }[],
	escapes: readonly StringEscapeSpan[],
): ExplainToken[] {
	const len = analyzed.length;
	if (len === 0 || residual.length === 0 || escapes.length === 0) return [];

	const out: ExplainToken[] = [];
	for (const { start, end } of escapes) {
		if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
		if (start < 0 || end <= start || end > len) continue;
		for (const r of clipToResidual(start, end, residual)) {
			out.push({
				start: r.start,
				end: r.end,
				class: "escaped" as const,
				ev: "e16",
			});
		}
	}

	out.sort((a, b) => a.start - b.start || a.end - b.end);
	return out;
}
