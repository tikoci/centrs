/**
 * B2 value fill — claims argument value bytes and array-literal interiors on the residual.
 *
 * This is the third B2 fill of #264, after the argument `name=` fill. It runs
 * **after** proof-only `spans` (comment + variable-*) and the `arg` fill and
 * **before** the operator fill, so the fill order is structural:
 * `spans → arg → value → operator`. That ordering retires the glued-dot residue
 * already noted in `operator-tokens.ts`: once value bytes are claimed a `.`
 * inside a value is no longer read as concatenation.
 *
 * Source is `data.values.occurrences` (already rebased into document analyzed-byte
 * space by `src/explain.ts`), not `Argument.valueSpan`. That is the load-bearing
 * scoping fact (#295): `lexValueAnchors` is prefix-safe and already carries array
 * interiors (`kind: \"element\"`, `parent`), so a container/value that the strict
 * `lexArguments` refused wholesale still yields leaves.
 *
 * A container contains its members (`{1;2;3}` container `[9,16)` contains
 * `[10,11)`, `[12,13)`, `[14,15)`). Emitting both would be a self-overlap that
 * `buildTokens` throws on, so this fill **claims leaves only**: an occurrence
 * that is nobody's `parent`. Container detection is `Set` of `parent` ids — no
 * tree walk, members follow their container in the same flat list.
 *
 * `span` is quotes-INCLUDED by contract (deliberate; the quotes/escapes fill is
 * a separate staging row and must not double-claim them).
 *
 * Vocabulary is provisional until #264 B5: one `value` class for every leaf span,
 * regardless of shape/observed/schema type — the three #225 facts stay where
 * they already are, in `data.values[]`, joined by offset. Do not read
 * `ExplainValueOccurrence.facts` to pick a class. Whether `value` later splits
 * per shape is B5 and does not move byte coverage.
 *
 * ~1,720 leaf bytes are already held by `variable-*` spans (a variable inside
 * a quoted value). Reuses the clipping shape from `arg-tokens.ts`: offer only
 * residual and keep `buildTokens`'s overlap throw as the safety net.
 */

import type { ExplainToken, ExplainValueOccurrence } from "../explain.ts";
import { clipToResidual } from "./token-ranges.ts";

/**
 * Leaf value + array-member spans on the residual.
 *
 * `analyzed` is the ASCII-normalized document text (length checks only);
 * `residual` is the gap set left by earlier fills (sorted, no overlaps);
 * `occurrences` are the already-rebased `ExplainValueOccurrence` rows from
 * `data.values.occurrences`. Every emitted span's bytes are fully inside
 * `residual`, sorted by `start`, non-overlapping, and carry
 * `class: \"value\"` + `ev: \"e9\"`.
 */
export function valueSpans(
	analyzed: string,
	residual: readonly { start: number; end: number }[],
	occurrences: readonly ExplainValueOccurrence[],
): ExplainToken[] {
	const len = analyzed.length;
	if (len === 0 || residual.length === 0 || occurrences.length === 0) return [];

	const parentIds = new Set<string>();
	for (const occurrence of occurrences)
		if (occurrence.parent !== undefined) parentIds.add(occurrence.parent);

	const out: ExplainToken[] = [];
	for (const occurrence of occurrences) {
		if (parentIds.has(occurrence.id)) continue;
		const { start, end } = occurrence.span;
		if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
		if (start < 0 || end <= start || end > len) continue;
		for (const r of clipToResidual(start, end, residual)) {
			out.push({
				start: r.start,
				end: r.end,
				class: "value" as const,
				ev: "e9",
			});
		}
	}

	out.sort((a, b) => a.start - b.start || a.end - b.end);
	return out;
}
