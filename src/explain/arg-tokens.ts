/**
 * B2 arg fill — claims argument names and their `=` on the residual.
 *
 * This is the second B2 fill of #264, added after the operator fill. It runs
 * **after** the proof-only spans (`comment` + `variable-*`) and **before** the
 * operator fill, so the fill order is structural: `spans` claims first, then
 * `arg`, then `operator` sees only what neither wanted. That ordering is why the
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

import type { ExplainArgumentToken, ExplainToken } from "../explain.ts";
import { clipToResidual } from "./token-ranges.ts";

export type ArgCandidate = ExplainArgumentToken;

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
		if (nameStart < 0 || eqEnd > len) continue;
		// Non-empty name. This is also what rejects `valueSpan.start === 0`, where
		// `eqStart` would be -1: `nameEnd` is -1 too, so any `nameStart >= 0` trips
		// it. `analyzed[-1]` on the next line would be `undefined` and continue
		// anyway, so the order is safe either way — but the name check is the one
		// that carries the intent.
		if (nameStart >= nameEnd) continue;
		// The whole token's `=` byte must be `=` in the analyzed text — a cheap
		// shape check that catches a caller that passed un-rebased or misaligned
		// spans. Not a scan for `=`; the position is derived from `valueSpan`.
		if (analyzed[eqStart] !== "=") continue;
		// Also ensure the candidate lies fully inside the analyzed length.
		if (candidate.span.start < 0 || candidate.span.end > len) continue;
		if (candidate.valueSpan.start < 0 || candidate.valueSpan.end > len)
			continue;

		// The name run and the `=` are contiguous (`nameEnd === eqStart`), so
		// clip them as ONE range per candidate. That yields the maximal `[name=]`
		// run for free — split only where the residual itself has a hole — and
		// makes cross-candidate fusion structurally impossible rather than merely
		// unreachable: coalescing adjacent runs globally would merge two distinct
		// attributes into one token if `lexArguments` ever stopped guaranteeing a
		// separator between them. A `variable-*` span claiming only the `=` still
		// leaves the name run behind, because the residual hole does the splitting.
		for (const r of clipToResidual(nameStart, eqEnd, residual)) {
			out.push({
				start: r.start,
				end: r.end,
				class: "arg" as const,
				ev: "e11",
			});
		}
	}

	out.sort((a, b) => a.start - b.start || a.end - b.end);
	return out;
}
