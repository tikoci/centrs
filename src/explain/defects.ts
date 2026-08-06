/**
 * Defect regions for `explain` (centrs canonicalizer).
 *
 * Ratified by the phase-0 lab, question Q14 (#185), whose coordinate half
 * `commands/explain/README.md` states as "**Malformed input carries a defect
 * *region*** — each diagnostic points at the byte span of its defect". This
 * module is that span, and since #202 it is the ONLY structural-surprise channel
 * an analyzer carries.
 *
 * WHY ONE CHANNEL
 *
 *   It was two for exactly one issue. Every analyzer used to carry a flat
 *   `notes: string[]` beside this one, and #192 added the regions additively so
 *   that any movement in a `notes` value during that change was a real bug rather
 *   than refactor noise. The convergence is this: a note answered "did anything
 *   go wrong", a defect answers that AND "where", so the note channel was
 *   strictly weaker and is gone. The two questions a caller actually asks are
 *   {@link hasStructuralDefect} (the abstention gate the notes used to serve) and
 *   the regions themselves.
 *
 *   The swap was measured, not assumed: over the frozen 913-document corpus and
 *   19,972 targeted mutations (delimiter, quote, escape and non-ASCII injections
 *   that made the gate fire on 6,908 of them), `notes.length > 0` and
 *   `hasStructuralDefect(defects)` disagreed on ZERO inputs in all five analyzers,
 *   and no `containsWrite` tristate moved.
 *
 * COORDINATES
 *
 *   `start`/`end` are ANALYZED-byte offsets, half-open, in exactly the space
 *   `coordinates.ts` contracts. Because that normalization is byte-count
 *   preserving, a defect region is directly comparable to a device `highlight`
 *   span with no fixup. Every region is non-empty: a defect that is "at" one
 *   byte spans that byte (`[i, i+1)`), never `[i, i)`.
 *
 * WHY REGIONS ARE NOT MERELY THE NOTE STRINGS PARSED
 *
 *   Two real losses in the retired note channel are what this module fixed, and
 *   neither was recoverable by parsing `over-depth:<n>` back out of a string. Both are
 *   reproduced in `test/unit/explain-defects.test.ts`:
 *
 *   - `pathresolve` collected notes into a `Set`, so several `over-depth` events
 *     at different offsets collapsed into ONE entry and every offset was lost.
 *     Two independent 260-deep block chains in one document produced a single
 *     `"over-depth"` note; they are two distinct defects.
 *   - `pathresolve` emitted a BARE `over-depth` with no offset at all, while
 *     `segment` and `symbols` emitted `over-depth:<byte>` — the same class in two
 *     shapes, only one of them locatable.
 *
 *   A third suspected loss did NOT survive checking, and is recorded so it is
 *   not re-derived: segmenting a block body and discarding its findings LOOKS
 *   like it would hide a defect inside `do={…}`. It does not. The top-level
 *   segmenter scans the whole byte range including block bodies, and
 *   `scopeBlocks` only returns depth-0 braces, so the outer scan is a strict
 *   superset — six probe shapes (unterminated strings, stray closes and
 *   unclosed delimiters inside bodies, nested two deep) surfaced no body-only
 *   defect. Body defects propagate and `ScopeBlock.start` exists because that is
 *   what lets a defect the WALKER itself raises (its block-descent
 *   `over-depth`) carry a document-space region — not because either recovers a
 *   hidden class.
 *
 * CLASSES DELIBERATELY NOT DETECTED
 *
 *   `truncation` and `stray mid-token delimiter` appeared in the phase-0 draft
 *   of the detectable set and are deferred. **The decision and its reasoning
 *   live in `commands/explain/README.md` (the executable spec), not here** —
 *   this vocabulary follows that list rather than narrowing it. In short:
 *   truncation is indistinguishable from a finished token without a schema (it
 *   is a `--complete` continuation-state question against a live target), and
 *   the stray-delimiter class needs a probe matrix before a detector is worth
 *   having — the #201 round is the standing evidence that a lexical rule
 *   curated from intuition produces defects the corpus cannot reach.
 *
 *   Re-opening either means grounding it first and amending the README's list;
 *   `test/unit/explain-defects.test.ts` asserts they stay undetected so the two
 *   cannot silently drift apart.
 */

/**
 * One structural defect, located in analyzed-byte space.
 *
 * The `code` vocabulary is the one the retired note channel used, so a fixture
 * or transcript from before #202 is still comparable entry for entry.
 */
export interface Defect {
	code: DefectCode;
	/** analyzed-byte offset, inclusive. */
	start: number;
	/** analyzed-byte offset, exclusive. Always `> start`. */
	end: number;
	/**
	 * The delimiter or byte that raised it, when the class has one — `"}"` for
	 * `unbalanced-close`, the opener for `unclosed`. Never a sentence: prose
	 * belongs in a rendered diagnostic, not in the structural record.
	 */
	detail?: string;
}

export type DefectCode =
	| "over-depth"
	| "bad-escape"
	| "bad-sigil"
	| "unterminated-string"
	| "unclosed"
	| "unbalanced-close"
	| "bom"
	| "non-ascii";

/**
 * `bom` and `non-ascii` are POSITIONAL FACTS, not errors.
 *
 * This predicate exists so a renderer cannot give them error severity by
 * accident, and it is a guard rather than a comment because the failure it
 * prevents is silent and user-facing: `/system identity set name="router-🚀"`
 * (`commands/explain/examples.md` example 22) is a perfectly legal command whose
 * value is non-ASCII by design. Failing it under `--fail-on error` would be a
 * false positive on correct input, and RouterOS comments and string values carry
 * non-ASCII routinely.
 *
 * What these two regions actually record is where the byte-count-preserving
 * normalization stood in for bytes the analyzer cannot read — i.e. the spans a
 * consumer needs in order to map back to the original text. That is a coordinate
 * fact. The other six codes mark input the analyzer could not structurally
 * resolve, which is a different thing.
 *
 * {@link hasStructuralDefect} is where that distinction is enforced, so a UTF-8
 * comment can never flip a document's write tristate to `unknown`.
 */
export function isPositionalFact(code: DefectCode): boolean {
	return code === "bom" || code === "non-ascii";
}

/**
 * Does this list carry a defect an analyzer must ABSTAIN on?
 *
 * The abstention gate, and the reason {@link isPositionalFact} is a function
 * rather than a comment: a defect list is not uniformly "bad input". Six codes
 * mark structure the analyzer could not resolve — part of the document was never
 * walked, so no verdict over it is safe. The other two are coordinate facts about
 * bytes that were read perfectly well. Gating on `defects.length > 0` would
 * abstain on `/system identity set name="router-🚀"`, a legal command, and on the
 * ~12% of the phase-0 corpus that carries non-ASCII.
 */
export function hasStructuralDefect(defects: readonly Defect[]): boolean {
	return defects.some((d) => !isPositionalFact(d.code));
}

/** A defect spanning exactly the byte at `at`. */
export function defectAt(
	code: DefectCode,
	at: number,
	detail?: string,
): Defect {
	return detail === undefined
		? { code, start: at, end: at + 1 }
		: { code, start: at, end: at + 1, detail };
}

/**
 * Shift every defect by `base` — the move that carries a block body's
 * body-relative regions into document space.
 *
 * Always returns a new ARRAY, so a caller may accumulate into the result without
 * touching the input; at `base === 0` the elements themselves are shared, which
 * is safe because a Defect is never mutated after construction.
 */
export function rebaseDefects(
	defects: readonly Defect[],
	base: number,
): Defect[] {
	if (base === 0) return [...defects];
	return defects.map((d) =>
		d.detail === undefined
			? { code: d.code, start: d.start + base, end: d.end + base }
			: {
					code: d.code,
					start: d.start + base,
					end: d.end + base,
					detail: d.detail,
				},
	);
}

/**
 * Concatenate defect lists, dropping exact duplicates.
 *
 * Identity is `code + start + end + detail` — the WHOLE region, never the code
 * alone. That distinction is the entire point: the retired note channel
 * de-duplicated by stringified note, so two `over-depth` events at bytes 40 and
 * 900 became one `"over-depth"` entry and the second offset was gone. Here they
 * are two defects.
 *
 * Order is stable (first occurrence wins) so a caller can report defects in
 * discovery order without sorting; callers that want source order should sort by
 * `start` themselves, since discovery order differs between the statement walk
 * and the bracket walk.
 *
 * The key is JSON rather than a joined string so that an ABSENT `detail` and an
 * empty-string one stay distinguishable, and so the separator cannot be a raw
 * control byte sitting invisibly in this file.
 */
export function mergeDefects(
	...lists: readonly (readonly Defect[])[]
): Defect[] {
	const seen = new Set<string>();
	const out: Defect[] = [];
	for (const list of lists) {
		for (const d of list) {
			const key = JSON.stringify([d.code, d.start, d.end, d.detail]);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(d);
		}
	}
	return out;
}
