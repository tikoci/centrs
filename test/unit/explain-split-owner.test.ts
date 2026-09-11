/**
 * `buildSplitOwnerIndex` against a brute-force oracle (#317).
 *
 * The index replaced an exhaustive scan whose answer the whole symbol→value
 * surface is built on, so the thing worth testing is not "does it look right"
 * but "does it return what the scan returned, on every span family we can
 * generate". The oracle below IS the scan the index replaced, written out
 * independently, and the randomized case drives both of the index's paths:
 * nested families take the parent walk, deliberately crossing ones take the
 * fallback.
 *
 * Spans are exercised directly rather than through `explainCommand` because the
 * fallback needs a CROSSING addressable family, and the pinned 948-script corpus
 * has none (18,487 addressable spans, zero crossings, max depth 11). A path that
 * real input never reaches is still a path that has to be right, and building
 * the input here is the only way to reach it.
 */

import { describe, expect, test } from "bun:test";
import { buildSplitOwnerIndex } from "../../src/explain/split-owner.ts";
import type { DocumentVerbSplit } from "../../src/explain/verbsplit.ts";

/**
 * A split carrying only what the index reads: its span and its own text. The
 * text must slice back out of `analyzed` for the span to be ADDRESSABLE; a
 * widened fallback span (`pathresolve.ts` → `Loc`) is what makes it not.
 */
function split(
	analyzed: string,
	start: number,
	end: number,
	options: { addressable?: boolean } = {},
): DocumentVerbSplit {
	const addressable = options.addressable ?? true;
	return {
		span: { start, end },
		text: addressable
			? analyzed.slice(start, end)
			: "<widened fallback, not this statement's bytes>",
	} as unknown as DocumentVerbSplit;
}

/** The exhaustive scan the index replaced: shortest span, earliest index. */
function oracle(
	analyzed: string,
	splits: readonly DocumentVerbSplit[],
	start: number,
	end: number,
): number | undefined {
	let owner: number | undefined;
	let ownerLength = Number.POSITIVE_INFINITY;
	for (let i = 0; i < splits.length; i++) {
		const s = splits[i] as DocumentVerbSplit;
		if (s.span.start > start || end > s.span.end) continue;
		if (analyzed.slice(s.span.start, s.span.end) !== s.text) continue;
		const length = s.span.end - s.span.start;
		if (length < ownerLength) {
			owner = i;
			ownerLength = length;
		}
	}
	return owner;
}

/** A deterministic PRNG, so a failing seed is a reproducible failing seed. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("buildSplitOwnerIndex (#317)", () => {
	const analyzed = "x".repeat(64);

	test("the innermost statement owns the span, not the first or the outermost", () => {
		// `:local f do={:put 1}` in miniature: an outer statement whose span
		// contains an inner one. The inner statement owns a span inside it.
		const splits = [split(analyzed, 0, 40), split(analyzed, 10, 20)];
		const index = buildSplitOwnerIndex(analyzed, splits);
		expect(index.laminar).toBe(true);
		expect(index.ownerOf(12, 14)).toBe(1);
		// A span straddling the inner statement's edge belongs to the outer one.
		expect(index.ownerOf(18, 25)).toBe(0);
		expect(index.ownerOf(41, 42)).toBeUndefined();
	});

	test("a widened fallback span cannot own anything", () => {
		const splits = [
			split(analyzed, 0, 40, { addressable: false }),
			split(analyzed, 10, 20),
		];
		const index = buildSplitOwnerIndex(analyzed, splits);
		expect(index.ownerOf(12, 14)).toBe(1);
		// Only the widened fallback span contains this, so there is no owner.
		expect(index.ownerOf(30, 31)).toBeUndefined();
	});

	test("two splits claiming the same span resolve to the earlier index", () => {
		const splits = [
			split(analyzed, 0, 40),
			split(analyzed, 5, 15),
			split(analyzed, 5, 15),
		];
		const index = buildSplitOwnerIndex(analyzed, splits);
		expect(index.ownerOf(6, 7)).toBe(1);
	});

	test("a crossing family is detected and falls back to the scan", () => {
		// [0,20) and [10,30) overlap without nesting, so the spans containing a
		// point are no longer a chain and the parent walk cannot be trusted.
		const splits = [split(analyzed, 0, 20), split(analyzed, 10, 30)];
		const index = buildSplitOwnerIndex(analyzed, splits);
		expect(index.laminar).toBe(false);
		expect(index.ownerOf(12, 14)).toBe(0);
		expect(index.ownerOf(22, 24)).toBe(1);
	});

	test("index and scan agree on random span families, nested and crossing", () => {
		const random = mulberry32(0x317);
		let laminarFamilies = 0;
		let crossingFamilies = 0;
		for (let trial = 0; trial < 400; trial++) {
			const splits: DocumentVerbSplit[] = [];
			const count = 1 + Math.floor(random() * 10);
			for (let i = 0; i < count; i++) {
				if (random() < 0.5 && splits.length > 0) {
					// Nest inside an existing span: the shape real splits have.
					const parent = splits[
						Math.floor(random() * splits.length)
					] as DocumentVerbSplit;
					const width = parent.span.end - parent.span.start;
					if (width < 2) continue;
					const start = parent.span.start + Math.floor(random() * (width - 1));
					const end =
						start + 1 + Math.floor(random() * (parent.span.end - start - 1));
					splits.push(
						split(analyzed, start, end, { addressable: random() < 0.85 }),
					);
					continue;
				}
				// Anywhere at all, which is how a crossing pair gets generated.
				const start = Math.floor(random() * analyzed.length);
				const end =
					start + 1 + Math.floor(random() * (analyzed.length - start));
				splits.push(
					split(analyzed, start, end, { addressable: random() < 0.85 }),
				);
			}
			const index = buildSplitOwnerIndex(analyzed, splits);
			if (index.laminar) laminarFamilies++;
			else crossingFamilies++;
			for (let start = 0; start <= analyzed.length; start++)
				for (const width of [0, 1, 3, 9]) {
					const end = Math.min(start + width, analyzed.length);
					expect({
						start,
						end,
						owner: index.ownerOf(start, end),
					}).toEqual({
						start,
						end,
						owner: oracle(analyzed, splits, start, end),
					});
				}
		}
		// Both paths were actually exercised; a run that only ever took one of
		// them would pass while leaving the other unmeasured.
		expect(laminarFamilies).toBeGreaterThan(20);
		expect(crossingFamilies).toBeGreaterThan(20);
	});
});
