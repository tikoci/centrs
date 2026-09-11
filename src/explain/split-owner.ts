/**
 * "Which statement owns this span?" as an index rather than a scan (#317).
 *
 * `symbol-values.ts` asks this question once per symbol, once per value and
 * once per scope brace. Answering it by scanning every statement split makes
 * the product quadratic: on 62 KiB of `:local v<i> <i>; :put $v<i>;` the scan
 * ran 6,144 queries over 4,096 splits — 25.2 M visits, 42% of total analysis
 * time — and the visit count quadrupled for every doubling of the input.
 *
 * ## The answer that has to be preserved, exactly
 *
 * The **shortest ADDRESSABLE split span containing `[start, end)`**, and on a
 * length tie the **earliest split index**. Addressable means the span slices
 * back to the split's own text: `pathresolve.ts` can hand back a *widened
 * fallback* span, and a span that is not this statement's own bytes cannot
 * prove statement ownership (the same gate `valuesOf`/`argumentsOf` apply to
 * their own reads).
 * Shortest — not first, not outermost — is what keeps `:local f do={:put 1}`
 * from claiming the body's `1` for `f`.
 *
 * ## Why a parent chain is enough
 *
 * Statement spans NEST: a parent statement's span contains its scope bodies'
 * statements. If the addressable spans are a laminar family — every pair
 * either nested or disjoint, never crossing — then the spans containing a
 * given point form a chain, so the answer is reachable by walking up from the
 * deepest span that starts at or before `start`.
 *
 * Laminarity is **measured, not assumed**. Over the pinned 948-script corpus
 * (`corpus-pin.json`), all 18,487 addressable spans of 18,648 splits are
 * laminar: zero crossings, zero duplicate `(start, end)` pairs, maximum
 * nesting depth 11. That is one genre of input (see #203 on the corpus bias),
 * so it is a measurement, not a proof — {@link buildSplitOwnerIndex} therefore
 * DETECTS a crossing while it builds and falls back to the exhaustive scan for
 * that document. The fallback is the old code, so a crossing costs speed and
 * never correctness, and `test/unit/explain-split-owner.test.ts` drives both
 * paths against a brute-force oracle on randomly generated span families.
 */

import type { DocumentVerbSplit } from "./verbsplit.ts";

/** A prepared owner lookup over one document's splits. */
export interface SplitOwnerIndex {
	/**
	 * The owning split index for `[start, end)`, or `undefined` when no
	 * addressable span contains it.
	 */
	ownerOf(start: number, end: number): number | undefined;
	/**
	 * Were the addressable spans laminar? `false` means this index answers by
	 * exhaustive scan. Exposed so the unit test can prove it drove both paths,
	 * not for callers to branch on.
	 */
	readonly laminar: boolean;
}

interface Entry {
	start: number;
	end: number;
	/** Index into the original `splits` array. */
	split: number;
}

/** The addressable spans, in split order. */
function addressableEntries(
	analyzed: string,
	splits: readonly DocumentVerbSplit[],
): Entry[] {
	const entries: Entry[] = [];
	for (let i = 0; i < splits.length; i++) {
		const split = splits[i] as DocumentVerbSplit;
		const { start, end } = split.span;
		// A widened fallback span cannot prove statement ownership: it is not
		// this statement's own bytes.
		if (analyzed.slice(start, end) !== split.text) continue;
		entries.push({ start, end, split: i });
	}
	return entries;
}

/**
 * The exhaustive scan, over the addressable entries rather than over `splits`.
 * Same answer as the pre-#317 loop: the filter it applied per candidate is the
 * one `addressableEntries` applied once, and `length < ownerLength` is strict,
 * so ascending split order still resolves a length tie to the earliest index.
 */
function scanOwner(
	entries: readonly Entry[],
	start: number,
	end: number,
): number | undefined {
	let owner: number | undefined;
	let ownerLength = Number.POSITIVE_INFINITY;
	for (const entry of entries) {
		if (entry.start > start || end > entry.end) continue;
		const length = entry.end - entry.start;
		if (length < ownerLength) {
			owner = entry.split;
			ownerLength = length;
		}
	}
	return owner;
}

/**
 * Prepare the owner lookup for one document. Build once per analysis and reuse
 * it for every query: building it per query would be the scan it replaces.
 */
export function buildSplitOwnerIndex(
	analyzed: string,
	splits: readonly DocumentVerbSplit[],
): SplitOwnerIndex {
	const entries = addressableEntries(analyzed, splits);
	// Parents first: ascending start, and on equal starts the longer span
	// (the container) before the shorter one. The last entry with
	// `start <= query.start` is then the deepest candidate, which is what the
	// binary search below relies on.
	const ordered = [...entries].sort(
		(a, b) => a.start - b.start || b.end - a.end || a.split - b.split,
	);
	// Two splits can claim exactly the same span; the sort has made them
	// adjacent, and dropping all but the first keeps the earliest index. It
	// also leaves the nesting STRICT, which is what lets the walk stop at the
	// first long-enough span: after this, two distinct entries of equal length
	// cannot both contain one query, because in a laminar family nested plus
	// equal length means identical.
	const sorted = ordered.filter((entry, i) => {
		const previous = ordered[i - 1];
		return (
			previous === undefined ||
			previous.start !== entry.start ||
			previous.end !== entry.end
		);
	});
	const parent = new Int32Array(sorted.length).fill(-1);
	const stack: number[] = [];
	let laminar = true;
	for (let i = 0; i < sorted.length; i++) {
		const cur = sorted[i] as Entry;
		while (stack.length > 0) {
			const top = sorted[stack[stack.length - 1] as number] as Entry;
			if (top.end <= cur.start) stack.pop();
			else break;
		}
		const topIndex = stack[stack.length - 1];
		if (topIndex !== undefined) {
			const top = sorted[topIndex] as Entry;
			// Overlapping but not containing: the family is not laminar, so the
			// containing spans of a point are not a chain and the walk below
			// could miss the real owner.
			if (top.end < cur.end) laminar = false;
			parent[i] = topIndex;
		}
		stack.push(i);
	}

	if (!laminar)
		return {
			laminar,
			ownerOf: (start, end) => scanOwner(entries, start, end),
		};

	return {
		laminar,
		ownerOf(start, end) {
			// A ZERO-WIDTH query is outside the nesting model and takes the scan.
			// Containment of `[p, p)` is satisfied by a span that merely TOUCHES
			// `p`, so `[a, p)` and `[p, b)` both "contain" it while being disjoint
			// — the containing spans stop being a chain and the walk below can
			// reach only one of them. No real query is zero-width (a symbol, a
			// value anchor and a scope brace all span at least one byte; measured
			// 0 of 19,292 symbol occurrences over the pinned corpus), so this
			// costs nothing in practice and keeps the answer exact if that ever
			// stops being true.
			if (start >= end) return scanOwner(entries, start, end);
			// Last entry whose span starts at or before `start`.
			let lo = 0;
			let hi = sorted.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if ((sorted[mid] as Entry).start <= start) lo = mid + 1;
				else hi = mid;
			}
			// Ends grow as the walk rises, so the first span long enough to
			// cover `end` is the shortest one that does. Entries that stop
			// before `start` are simply skipped by the same test.
			for (let i = lo - 1; i >= 0; i = parent[i] as number) {
				const entry = sorted[i] as Entry;
				if (entry.end >= end) return entry.split;
			}
			return undefined;
		},
	};
}
