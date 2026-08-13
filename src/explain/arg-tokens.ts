/**
 * B2 arg fill — claims argument names and their `=` on the residual.
 *
 * This is the second B2 fill of #264, after the operator fill. It runs **after**
 * the proof-only spans (`comment` + `variable-*`) and **before** the operator
 * fill, so the fill order is structural: `spans` claims first, then `arg`,
 * then `operator` sees only what neither wanted. That ordering is why the
 * operator fill can abstain on `, / = -` outside `( )`, on bytes glued after
 * an argument `=`, and on bytes glued into an argument name — those bytes
 * belong to a later fill, not to a smarter operator scanner.
 *
 * The source is `src/explain/args.ts`'s `Argument` — `span` and `valueSpan`
 * already rebased into document analyzed-byte space by `src/explain.ts`. The
 * name run is `[span.start, valueSpan.start - 1)` and the `=` is the single
 * byte at `valueSpan.start - 1`; the value itself is `valueSpan` and is left
 * for the next fill (see #293). A `positional` has no `name`/`valueSpan` and a
 * `query` is a `?` word whose interior `args.ts` explicitly refuses to split
 * (see `Argument.value`'s doc comment), so both are ignored — the `=` is
 * derived from the token shape, never by scanning for the byte.
 *
 * `Argument.value` is not `Argument.text` and is never read: `value` is absent
 * whenever the source spells a substitution or an escape this phase does not
 * decode. This slice claims `span`/`valueSpan` *positions* only.
 *
 * A statement whose bytes were normalized is not addressable: `explain.ts`
 * already refuses those (`its text was normalized`), and this fill inherits the
 * refusal — it only sees tokens from `read === true` statements, which are
 * exactly the addressable ones.
 *
 * Vocabulary is provisional until #264 B5: one `arg` class for both the name
 * bytes and the `=` separator (design decision 2 of #293 — emit first, name
 * later; `highlight`'s `syntax-meta` is a residual merge and never a source).
 * If B5 splits the `=` into its own class, the byte coverage does not move,
 * only the retag.
 */

import type { ExplainToken } from "../explain.ts";

export interface ArgCandidate {
	kind: string;
	span: { start: number; end: number };
	valueSpan?: { start: number; end: number };
	name?: string;
	text: string;
}

function clipToResidual(
	start: number,
	end: number,
	residual: readonly { start: number; end: number }[],
): { start: number; end: number }[] {
	if (start >= end) return [];
	const out: { start: number; end: number }[] = [];
	for (const r of residual) {
		if (r.end <= start) continue;
		if (r.start >= end) break;
		const oStart = Math.max(start, r.start);
		const oEnd = Math.min(end, r.end);
		if (oStart < oEnd) out.push({ start: oStart, end: oEnd });
	}
	return out;
}

/**
 * Argument name + `=` spans on the residual.
 *
 * `analyzed` is the ASCII-normalized document text (only used for length
 * checks); `residual` is the gap set left by earlier fills (sorted, no
 * overlaps); `candidates` are the already-rebased `Argument` tokens from
 * `read === true` statements. Every emitted span's bytes are fully inside
 * `residual`, sorted by `start`, non-overlapping, and carry
 * `class: "arg"` + `ev: "e11"`.
 */
export function argSpans(
	analyzed: string,
	residual: readonly { start: number; end: number }[],
	candidates: readonly ArgCandidate[],
): ExplainToken[] {
	const len = analyzed.length;
	if (len === 0 || residual.length === 0 || candidates.length === 0) return [];

	function isResidual(pos: number): boolean {
		let lo = 0;
		let hi = residual.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const r = residual[mid] as { start: number; end: number };
			if (pos < r.start) hi = mid - 1;
			else if (pos >= r.end) lo = mid + 1;
			else return true;
		}
		return false;
	}

	const out: ExplainToken[] = [];

	for (const candidate of candidates) {
		if (candidate.kind !== "attribute") continue;
		if (candidate.valueSpan === undefined) continue;
		if (candidate.name === undefined) continue;
		const nameStart = candidate.span.start;
		const eqEnd = candidate.valueSpan.start;
		const eqStart = eqEnd - 1;
		const nameEnd = eqStart;
		// Defensive: token shape must give non-empty name and single-byte `=`.
		if (
			!Number.isInteger(nameStart) ||
			!Number.isInteger(nameEnd) ||
			!Number.isInteger(eqStart) ||
			!Number.isInteger(eqEnd)
		)
			continue;
		if (nameStart < 0 || nameEnd < nameStart || eqEnd > len) continue;
		if (nameStart >= nameEnd) continue;
		if (eqStart < nameStart || eqEnd !== eqStart + 1) continue;
		// The whole token's `=` byte must be `=` in the analyzed text — a cheap
		// shape check that catches a caller that passed un-rebased or misaligned
		// spans. Not a scan for `=`; the position is derived from `valueSpan`.
		if (analyzed[eqStart] !== "=") continue;
		// Also ensure the candidate lies fully inside the analyzed length.
		if (candidate.span.start < 0 || candidate.span.end > len) continue;
		if (candidate.valueSpan.start < 0 || candidate.valueSpan.end > len)
			continue;

		// Clip each run to the residual — a `variable-*` span may already claim
		// bytes that look like an arg name/value (e.g. `comment=$c` is unread,
		// so it never reaches here, but a future variable inside a quoted value
		// would). Offering only residual keeps `buildTokens`'s cross-fill overlap
		// throw as a safety net rather than a production path.
		if (!isResidual(eqStart)) {
			// `=` not residual → name is also not useful in isolation? But a
			// `variable-*` claiming the `=` does not imply it claims the name
			// bytes, so still clip the name separately.
		}
		const nameClipped = clipToResidual(nameStart, nameEnd, residual);
		const eqClipped = clipToResidual(eqStart, eqEnd, residual);
		for (const r of nameClipped) {
			out.push({
				start: r.start,
				end: r.end,
				class: "arg" as const,
				ev: "e11",
			});
		}
		for (const r of eqClipped) {
			out.push({
				start: r.start,
				end: r.end,
				class: "arg" as const,
				ev: "e11",
			});
		}
	}

	out.sort((a, b) => a.start - b.start || a.end - b.end);
	// Coalesce adjacent `arg` runs that were split only by the name/`=` boundary
	// when both were residual: `[name][=]` of the same attribute becomes one
	// maximal `arg` run rather than two adjacent tokens of the same class. The
	// two bytes remain distinguishable by the `=` position, but the partition
	// itself need not multiply tokens for a single name+separator.
	const coalesced: ExplainToken[] = [];
	for (const t of out) {
		const last = coalesced[coalesced.length - 1];
		if (
			last !== undefined &&
			last.class === t.class &&
			last.ev === t.ev &&
			last.end === t.start
		) {
			last.end = t.end;
		} else {
			coalesced.push({ ...t });
		}
	}
	return coalesced;
}
