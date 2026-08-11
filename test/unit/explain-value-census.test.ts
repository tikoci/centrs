/**
 * #260 — the value census is re-derivable; these tests make it drift-gated.
 *
 * The census figures live in three places: `test/fixtures/explain/values.json`
 * → `corpus` (the measurement), the assertions in `explain-values.test.ts`
 * (which gate the fixture), and the prose in `commands/explain/README.md`. The
 * third copy was ungated and drifted in #256. It is now a generated projection
 * of the fixture, checked here as well as in `bun run lint:ci`, because a
 * `bun test` failure is the one most people see first.
 *
 * Nothing here needs `corpus.sqlite`. The corpus → fixture link is gated by
 * `bun run explain:value-census:check` in ci.yaml's `corpus` job; what this
 * file can still do offline is prove the COMPARATOR that gate depends on
 * actually reports drift.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	diffAgainstFixture,
	renderReadmeBlock,
	splitLines,
	type ValueCensus,
} from "../../scripts/explain-value-census.ts";

const README = readFileSync(
	new URL("../../commands/explain/README.md", import.meta.url),
	"utf8",
);
const fixture = JSON.parse(
	readFileSync(
		new URL("../fixtures/explain/values.json", import.meta.url),
		"utf8",
	),
) as { corpus: ValueCensus };

const BEGIN =
	"  <!-- BEGIN GENERATED value-census — regenerate with `bun run explain:value-census:readme` -->";
const END = "  <!-- END GENERATED value-census -->";

/** Marker line indices, located exactly as the gate itself locates them. */
function markers(): { lines: string[]; begin: number; end: number } {
	const lines = splitLines(README);
	const begin = lines.indexOf(BEGIN);
	const end = lines.indexOf(END);
	expect(begin).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(begin);
	return { lines, begin, end };
}

function readmeBlock(): string[] {
	const { lines, begin, end } = markers();
	return lines.slice(begin + 1, end);
}

describe("#260 value-census drift gate", () => {
	test("the README block is the fixture's `corpus` block, rendered", () => {
		expect(readmeBlock().join("\n")).toBe(
			renderReadmeBlock(fixture.corpus).join("\n"),
		);
	});

	test("the README quotes no census figure outside the generated block", () => {
		// The drift that happened in #256 was a number left behind in prose. Any
		// figure large enough to need a thousands separator is census-shaped, so
		// none may appear outside the block that regenerates.
		//
		// Sliced by marker index rather than by filtering out lines whose text
		// appears in the block: a substring test drops every blank line (the empty
		// string is "in" any block) and any line duplicating generated text, which
		// silently shrank the region this test actually scanned.
		const { lines, begin, end } = markers();
		const outside = [...lines.slice(0, begin), ...lines.slice(end + 1)].join(
			"\n",
		);
		for (const figure of [
			fixture.corpus.valueOccurrences,
			fixture.corpus.strictComparableAnchors,
			fixture.corpus.elementOccurrences,
			fixture.corpus.recoveredPrefixAnchors,
			fixture.corpus.nestedElements,
		]) {
			expect(outside).not.toContain(figure.toLocaleString("en-US"));
		}
	});

	test("the block locator survives a CRLF checkout", () => {
		// This repo ships no `.gitattributes`, so a Windows clone with the
		// Git-for-Windows default `core.autocrlf=true` gets CRLF here — and #142
		// wants the unit tier running there.
		const crlf = README.replace(/\r?\n/g, "\r\n");
		const { begin, end } = markers();
		expect(splitLines(crlf).indexOf(BEGIN)).toBe(begin);
		expect(splitLines(crlf).indexOf(END)).toBe(end);
		// The fix is load-bearing, not belt-and-braces: a bare "\n" split leaves a
		// trailing `\r` on every line and finds neither marker, which would fail
		// the gate for a line ending rather than for drift.
		expect(crlf.split("\n").indexOf(BEGIN)).toBe(-1);
	});

	test("a rendered line never breaks a code span", () => {
		for (const line of readmeBlock()) {
			expect(line.split("`").length % 2).toBe(1);
		}
	});

	test("the rendering states a regression rather than contradicting itself", () => {
		// The block's sentences have to stay true at any value, or regenerating
		// after a real regression would publish a reassuring lie.
		const regressed = renderReadmeBlock({
			...fixture.corpus,
			boundaryContradictions: 3,
			invalidSpans: 1,
			danglingParents: 2,
			containmentBreaks: 4,
			shapeCounts: { ...fixture.corpus.shapeCounts, id: 7 },
		})
			.join(" ")
			.replace(/\s+/g, " ");
		expect(regressed).toContain("3 disagree with it");
		expect(regressed).toContain("read 1, 2 and 4, and each must stay 0");
		expect(regressed).toContain("7 are `id`");
		expect(regressed).not.toContain("holds no source-literal");
	});

	test("the fixture comparator finds drift in a scalar and inside a shape map", () => {
		expect(diffAgainstFixture(fixture.corpus, fixture.corpus)).toEqual([]);
		// A nested `shapeCounts` change is the one a shallow compare would miss,
		// and it is exactly how a changed emission shows up first.
		expect(
			diffAgainstFixture(
				{
					...fixture.corpus,
					keyedElements: fixture.corpus.keyedElements + 1,
					shapeCounts: { ...fixture.corpus.shapeCounts, array: 0 },
				},
				fixture.corpus,
			).map((line) => line.split(":")[0]),
		).toEqual(["keyedElements", "shapeCounts"]);
	});
});
