/**
 * Defect regions for `explain` (centrs canonicalizer).
 *
 * Ratified by the phase-0 lab, question Q14 (#185), whose coordinate half
 * `commands/explain/README.md` states as "**Malformed input carries a defect
 * *region*** — each diagnostic points at the byte span of its defect". This
 * module is that span: the structured twin of the `notes: string[]` channel
 * every analyzer carries.
 *
 * WHY TWO CHANNELS
 *
 *   `notes` is a flat `string[]` whose CONTENT no caller reads — `write.ts`
 *   tests only `notes.length > 0`, as a pure abstention gate. Defects are read
 *   for their regions. Keeping them separate means the two questions ("did
 *   anything go wrong" and "where") need not be answered by parsing one string,
 *   and a class that belongs to only one of them (see `isPositionalFact`) has
 *   somewhere to go.
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
 *   Two real losses in the note channel are what this module fixes, and neither
 *   is recoverable by parsing `over-depth:<n>` back out of a string. Both are
 *   reproduced in `test/unit/explain-defects.test.ts`:
 *
 *   - `pathresolve` collects notes into a `Set`, so several `over-depth` events
 *     at different offsets collapse into ONE entry and every offset is lost.
 *     Two independent 260-deep block chains in one document produce a single
 *     `"over-depth"` note and two distinct defects.
 *   - `pathresolve` emits a BARE `over-depth` with no offset at all, while
 *     `segment` and `symbols` emit `over-depth:<byte>` — the same class in two
 *     shapes, only one of them locatable.
 *
 *   A third suspected loss did NOT survive checking, and is recorded so it is
 *   not re-derived: segmenting a block body and discarding its notes LOOKS like
 *   it would hide a defect inside `do={…}`. It does not. The top-level
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
 *   `commands/explain/README.md` lists eight detectable classes; six are
 *   implemented here, plus `bom` and `non-ascii` which come free from the
 *   coordinate pass. Two are refused on purpose:
 *
 *   - `truncation` — offline cannot tell a truncated complete-LOOKING token from
 *     a finished one without a schema; `commands/explain/README.md` says so
 *     itself. What is actually detectable is the *continuation state* (a
 *     trailing `=`, an open delimiter), which is a `--complete` concern and a
 *     live-target question, not a defect. Emitting it here would be exactly the
 *     confident-claim-on-ambiguous-input posture Q14 forbids.
 *   - `stray mid-token delimiter` — plausible, but a lexical rule curated from
 *     intuition is what the #201 round warns against: all seven of its P1s were
 *     in lexical plumbing and none was reachable from the 913-script corpus.
 *     This class needs a probe matrix (spellings × positions × accepted-form
 *     neighbors) before it is worth a detector.
 */

/**
 * One structural defect, located in analyzed-byte space.
 *
 * The `code` vocabulary is deliberately the same one the note channel uses, so
 * the two are comparable entry for entry.
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
 * They also stay out of the note channel entirely, so `write.ts`'s
 * `notes.length > 0` abstention gate cannot see them — a UTF-8 comment must
 * never flip a document's write tristate to `unknown`.
 */
export function isPositionalFact(code: DefectCode): boolean {
	return code === "bom" || code === "non-ascii";
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
 * alone. That distinction is the entire point: the note channel de-duplicates by
 * stringified note, so two `over-depth` events at bytes 40 and 900 become one
 * `"over-depth"` entry and the second offset is gone. Here they are two defects.
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
