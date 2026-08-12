/**
 * #289 B1 — the token partition census is re-derivable; these tests make it drift-gated.
 *
 * The census figures live in two places: `test/fixtures/explain/tokens.json` → `corpus`
 * (the measurement) and the prose in `commands/explain/README.md`. The second copy
 * is a generated projection of the first, checked here as well as in `bun run lint:ci`.
 * Nothing here needs `corpus.sqlite`; corpus → fixture is gated by `bun run explain:token-census:check`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	diffAgainstFixture,
	renderReadmeBlock,
	splitLines,
	type TokenCensus,
} from "../../scripts/explain-token-census.ts";
import { analyzeCoordinates } from "../../src/explain/coordinates.ts";
import { explainCommand } from "../../src/explain.ts";

const README = readFileSync(
	new URL("../../commands/explain/README.md", import.meta.url),
	"utf8",
);
const fixture = JSON.parse(
	readFileSync(
		new URL("../fixtures/explain/tokens.json", import.meta.url),
		"utf8",
	),
) as { corpus: TokenCensus };

const BEGIN =
	"  <!-- BEGIN GENERATED token-census — regenerate with `bun run explain:token-census:readme` -->";
const END = "  <!-- END GENERATED token-census -->";

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

describe("#289 B1 — token partition invariant over representative inputs", () => {
	for (const input of [
		"",
		'/ip/address/add address=1.2.3.4/24 interface=ether1 comment="hi"',
		"/interface/print .proplist=name,comment",
		':local x 1.3; :put [:typeof $x]; /ip route print where comment~"a"',
		"# comment only",
		"   ",
		":if (true) do={ :put 1 }",
		'/system identity set name="router-🚀"',
		"/ip address add # hello\naddress=1.1.1.1",
	]) {
		test(JSON.stringify(input).slice(0, 60) || "(empty)", () => {
			const data = explainCommand(input, { tokens: true });
			const tokensLocal = data.tokens ?? [];
			const bytes = data.input.bytes;
			const analyzed = new TextDecoder().decode(
				analyzeCoordinates(input).analyzed,
			);
			if (bytes === 0) {
				expect(tokensLocal).toEqual([]);
				return;
			}
			expect(tokensLocal.length).toBeGreaterThan(0);
			expect(tokensLocal[0]?.start).toBe(0);
			expect(tokensLocal[tokensLocal.length - 1]?.end).toBe(bytes);
			for (let i = 1; i < tokensLocal.length; i++) {
				expect(tokensLocal[i]?.start).toBe(tokensLocal[i - 1]?.end);
			}
			for (const t of tokensLocal) {
				expect(t.start).toBeGreaterThanOrEqual(0);
				expect(t.end).toBeLessThanOrEqual(bytes);
				expect(t.start).toBeLessThan(t.end);
			}
			const recon = tokensLocal
				.map((t) => analyzed.slice(t.start, t.end))
				.join("");
			expect(recon).toBe(analyzed);
			// Every `spans` entry is a token with the same class.
			for (const s of data.spans) {
				const covering = tokensLocal.find(
					(t) => t.start === s.start && t.end === s.end,
				);
				expect(covering).toBeDefined();
				expect(covering?.class).toBe(s.class);
			}
		});
	}

	test("without --tokens the facet is absent", () => {
		const data = explainCommand("/ip address add address=1.1.1.1");
		expect(data.tokens).toBeUndefined();
	});

	test("`unclassified` is a first-class class, not a gap", () => {
		// Whitespace-only input has no analyzer claim, so the partition is a
		// single `unclassified` token — this holds regardless of how many B2
		// fills land. Tying the assertion to a specific command (e.g.
		// `/ip/address/add ...`) would make it fail once that command becomes
		// fully classified.
		const data = explainCommand("   ", {
			tokens: true,
		});
		expect(data.tokens?.every((t) => typeof t.class === "string")).toBe(true);
		expect(data.tokens).toEqual([
			{ start: 0, end: 3, class: "unclassified", ev: "e0" },
		]);
		// The pinned census still has unclassified bytes (the deliverable number)
		expect(fixture.corpus.classCounts["unclassified"]).toBeGreaterThan(0);
	});

	test("normalized input: offsets on analyzed text, join(slice) === analyzed", () => {
		const input = '/system identity set name="router-🚀"';
		const data = explainCommand(input, { tokens: true });
		const analyzed = new TextDecoder().decode(
			analyzeCoordinates(input).analyzed,
		);
		expect(data.input.normalized).toBe(true);
		expect(data.input.bytes).toBe(analyzed.length);
		const recon = (data.tokens ?? [])
			.map((t) => analyzed.slice(t.start, t.end))
			.join("");
		expect(recon).toBe(analyzed);
		expect(data.tokens?.at(-1)?.end).toBe(analyzed.length);
	});
});

describe("#289 B1 — token-census drift gate", () => {
	test("the README block is the fixture's `corpus` block, rendered", () => {
		expect(readmeBlock().join("\n")).toBe(
			renderReadmeBlock(fixture.corpus).join("\n"),
		);
	});

	test("the block locator survives a CRLF checkout", () => {
		const crlf = README.replace(/\r?\n/g, "\r\n");
		const { begin, end } = markers();
		expect(splitLines(crlf).indexOf(BEGIN)).toBe(begin);
		expect(splitLines(crlf).indexOf(END)).toBe(end);
		expect(crlf.split("\n").indexOf(BEGIN)).toBe(-1);
	});

	test("a rendered line never breaks a code span", () => {
		for (const line of readmeBlock())
			expect(line.split("`").length % 2).toBe(1);
	});

	test("the fixture comparator finds drift in a scalar and inside a count map", () => {
		expect(diffAgainstFixture(fixture.corpus, fixture.corpus)).toEqual([]);
		expect(
			diffAgainstFixture(
				{
					...fixture.corpus,
					totalBytes: fixture.corpus.totalBytes + 1,
					classCounts: { ...fixture.corpus.classCounts, unclassified: 0 },
				},
				fixture.corpus,
			).map((line) => line.split(":")[0]),
		).toEqual(["totalBytes", "classCounts.unclassified"]);
	});

	test("a tally is compared by entry, so key ORDER is not census data", () => {
		const reversed = Object.fromEntries(
			Object.entries(fixture.corpus.classCounts).reverse(),
		);
		expect(Object.keys(reversed)).not.toEqual(
			Object.keys(fixture.corpus.classCounts),
		);
		expect(
			diffAgainstFixture(
				{ ...fixture.corpus, classCounts: reversed },
				fixture.corpus,
			),
		).toEqual([]);
	});
});
