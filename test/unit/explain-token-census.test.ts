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
import {
	buildTokens,
	type ExplainSpan,
	explainCommand,
	explainEnvelope,
	renderExplainEnvelope,
	residualRanges,
} from "../../src/explain.ts";

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
		// `ev` is the pass that produced the byte: an UNCLAIMED byte comes from
		// the coordinate analysis (`e1`), not the execute canonicalizer (`e0`).
		expect(data.tokens).toEqual([
			{ start: 0, end: 3, class: "unclassified", ev: "e1" },
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

describe("#289 B1 — buildTokens rejects a span set it cannot partition", () => {
	// These guards are unreachable from `explainCommand` today (the only span
	// producers are the comment and symbol walkers, and 40k fuzzed inputs never
	// trip them). Reachable only by calling `buildTokens` directly — which is
	// exactly why they need a direct test, or nothing goes red when one is
	// deleted.
	const span = (start: number, end: number): ExplainSpan => ({
		start,
		end,
		class: "comment",
		ev: "e2",
	});

	test("a non-integer offset", () => {
		expect(() => buildTokens("abcdef", [span(0.5, 3)])).toThrow(
			/non-integer span/,
		);
	});

	test("a negative start reports bounds, not overlap", () => {
		expect(() => buildTokens("abcdef", [span(-1, 3)])).toThrow(
			/span out of bounds/,
		);
	});

	test("an end past the input", () => {
		expect(() => buildTokens("abcdef", [span(2, 99)])).toThrow(
			/span out of bounds/,
		);
	});

	test("an empty or reversed span", () => {
		expect(() => buildTokens("abcdef", [span(3, 3)])).toThrow(
			/span out of bounds/,
		);
		expect(() => buildTokens("abcdef", [span(5, 3)])).toThrow(
			/span out of bounds/,
		);
	});

	test("two spans that overlap, in either input order", () => {
		expect(() => buildTokens("abcdef", [span(0, 4), span(2, 6)])).toThrow(
			/overlapping spans/,
		);
		expect(() => buildTokens("abcdef", [span(2, 6), span(0, 4)])).toThrow(
			/overlapping spans/,
		);
	});

	test("unsorted but disjoint spans still partition", () => {
		expect(buildTokens("abcdef", [span(4, 6), span(0, 2)])).toEqual([
			{ start: 0, end: 2, class: "comment", ev: "e2" },
			{ start: 2, end: 4, class: "unclassified", ev: "e1" },
			{ start: 4, end: 6, class: "comment", ev: "e2" },
		]);
	});

	test("empty input has no tokens", () => {
		expect(buildTokens("", [])).toEqual([]);
	});
});

describe("#289 B1 — `--tokens` changes the DEFAULT surface, not just `--json`", () => {
	const input = ":local x 1 # note $x";

	test("the text render gains a tokens section with the coverage number", () => {
		const off = renderExplainEnvelope(explainEnvelope(input), "text");
		const on = renderExplainEnvelope(
			explainEnvelope(input, { tokens: true }),
			"text",
		);
		expect(off).not.toContain("tokens:");
		expect(on).toContain("tokens:");
		const header = splitLines(on).find((l) => l.startsWith("tokens:"));
		expect(header).toMatch(
			/^tokens: \d+ token\(s\), \d+\/\d+ byte\(s\) classified \(\d+\.\d%\), class provisional$/,
		);
	});

	test("every token is a row, `unclassified` runs included", () => {
		const envelope = explainEnvelope(input, { tokens: true });
		const rows = splitLines(renderExplainEnvelope(envelope, "text"));
		const at = rows.findIndex((l) => l.startsWith("tokens:"));
		const tokens = envelope.data.tokens ?? [];
		expect(tokens.length).toBeGreaterThan(1);
		expect(rows.slice(at + 1, at + 1 + tokens.length)).toEqual(
			tokens.map((t) => `  ${`[${t.start},${t.end})`.padEnd(12)} ${t.class}`),
		);
		expect(tokens.some((t) => t.class === "unclassified")).toBe(true);
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

describe("#290 B2 — residualRanges seam and multi-fill buildTokens", () => {
	test("residual of empty claimed is the whole input", () => {
		expect(residualRanges(5, [])).toEqual([{ start: 0, end: 5 }]);
		expect(residualRanges(0, [])).toEqual([]);
	});

	test("residual coalesces and sorts claimed spans", () => {
		expect(
			residualRanges(6, [
				{ start: 4, end: 6 },
				{ start: 0, end: 2 },
			]),
		).toEqual([{ start: 2, end: 4 }]);
	});

	test("buildTokens output is byte-ordered whatever order the fills arrive in", () => {
		// Fill order IS the fill order (#290 design decision 1), but it decides
		// who may CLAIM a byte — not the emitted order. The partition is always
		// sorted by `start`, so passing the same two fills either way round is the
		// same stream. A fill offering only residual can never overlap; the throw
		// below is the safety net for a caller that violates that.
		const op: ExplainSpan = { start: 2, end: 4, class: "comment", ev: "e10" };
		const comment: ExplainSpan = {
			start: 0,
			end: 2,
			class: "comment",
			ev: "e2",
		};
		const spansFirst = buildTokens("abcdef", [[comment], [op]]);
		const opFirst = buildTokens("abcdef", [[op], [comment]]);
		expect(spansFirst).toEqual(opFirst);
		expect(spansFirst.map((t) => t.start)).toEqual([0, 2, 4]);
		// The trailing gap is `unclassified`, attributed to the coordinates pass.
		expect(spansFirst.map((t) => t.ev)).toEqual(["e2", "e10", "e1"]);
		expect(spansFirst[2]?.class).toBe("unclassified");
		// Overlap across fills is a hard throw, not a silent merge.
		expect(() =>
			buildTokens("abcdef", [
				[{ start: 0, end: 4, class: "comment", ev: "e2" }],
				[{ start: 2, end: 6, class: "comment", ev: "e10" }],
			]),
		).toThrow(/overlapping spans/);
	});

	test("operator class is a first-class token class with ev e10", () => {
		const data = explainCommand(":put (1+2)", { tokens: true });
		const ops = (data.tokens ?? []).filter((t) => t.class === "operator");
		expect(ops.length).toBeGreaterThan(0);
		for (const t of ops) expect(t.ev).toBe("e10");
		// `spans` stays proof-only — no operator class there.
		expect(data.spans.some((s) => (s.class as string) === "operator")).toBe(
			false,
		);
		// Evidence cites e10 only when operator tokens exist.
		const hasOperatorEvidence = data.evidence.some((e) => e.id === "e10");
		expect(hasOperatorEvidence).toBe(true);
		const noOp = explainCommand("/ip address add address=1.1.1.1", {
			tokens: true,
		});
		expect(noOp.evidence.some((e) => e.id === "e10")).toBe(false);
		expect(fixture.corpus.classCounts["operator"]).toBeGreaterThan(0);
		expect(fixture.corpus.classByteCounts["operator"]).toBeGreaterThan(0);
	});

	test("B3 string scanning cannot start from a quote owned by a comment", () => {
		const input = '# unmatched "\n:put {1}';
		const tokens = explainCommand(input, { tokens: true }).tokens ?? [];
		const statementStart = input.indexOf(":put");
		expect(
			tokens.some(
				(token) => token.start >= statementStart && token.class === "string",
			),
		).toBe(false);
		expect(
			tokens
				.filter((token) => token.class === "brace")
				.map((token) => input.slice(token.start, token.end)),
		).toEqual(["{", "}"]);
	});

	test("B3 strings stay on the residual around higher-priority symbol spans", () => {
		const input = ':put "a $x b"';
		const tokens = explainCommand(input, { tokens: true }).tokens ?? [];
		expect(
			tokens
				.filter((token) => token.class === "string")
				.map((token) => input.slice(token.start, token.end)),
		).toEqual(['"a $', ' b"']);
		expect(
			tokens
				.filter((token) => token.class === "variable-parameter")
				.map((token) => input.slice(token.start, token.end)),
		).toEqual(["x"]);
	});

	test("resolved path and verb bytes are dir/cmd tokens with ev e12", () => {
		const input = "/ip/route/add dst-address=10.0.0.0/8";
		const data = explainCommand(input, { tokens: true });
		const pathTokens = (data.tokens ?? []).filter(
			(token) => token.class === "dir" || token.class === "cmd",
		);
		expect(
			pathTokens.map((token) => ({
				text: input.slice(token.start, token.end),
				class: token.class,
				ev: token.ev,
			})),
		).toEqual([
			{ text: "/ip/route/", class: "dir", ev: "e12" },
			{ text: "add", class: "cmd", ev: "e12" },
		]);
		expect(data.spans.some((span) => ["dir", "cmd"].includes(span.class))).toBe(
			false,
		);
		expect(data.evidence.some((evidence) => evidence.id === "e12")).toBe(true);
	});

	test("navigation and nested command paths fill without claiming spaces or brackets", () => {
		const navigation = explainCommand("/ip route", { tokens: true });
		expect(
			navigation.tokens
				?.filter((token) => token.class === "dir")
				.map((token) => "/ip route".slice(token.start, token.end)),
		).toEqual(["/ip", "route"]);

		const nestedInput = "/ip route remove [find comment=x]";
		const nested = explainCommand(nestedInput, { tokens: true });
		expect(
			nested.tokens
				?.filter((token) => token.class === "cmd")
				.map((token) => nestedInput.slice(token.start, token.end)),
		).toEqual(["remove", "find"]);
		expect(
			nested.tokens?.find(
				(token) =>
					token.start <= nestedInput.indexOf("[") &&
					token.end > nestedInput.indexOf("["),
			),
		).toMatchObject({ class: "unclassified" });
	});

	test("colon directives use the same stripped-body coordinates as verb resolution", () => {
		for (const input of [
			":put 1",
			':log info "hi"',
			":foreach i in={1;2} do={ :put $i }",
			":put [:len $x]",
		]) {
			const data = explainCommand(input, { tokens: true });
			expect(
				data.tokens
					?.filter((token) => token.class === "cmd")
					.map((token) => input.slice(token.start, token.end)),
			).toContain(input.startsWith(":log") ? "info" : "put");
			expect(
				data.tokens
					?.filter((token) => token.class === "dir")
					.map((token) => input.slice(token.start, token.end)),
			).toContainEqual(expect.stringMatching(/^:/));
		}
	});

	test("ambiguous, malformed, and source-unmapped runs remain unclassified", () => {
		for (const input of [
			"/not/a/known/path",
			"/ip//address print",
			"/ip//",
			"/ip///",
		]) {
			const data = explainCommand(input, { tokens: true });
			expect(
				data.tokens?.some(
					(token) => token.class === "dir" || token.class === "cmd",
				),
			).toBe(false);
		}
		const normalized = explainCommand("/ip/route add comment=🚀", {
			tokens: true,
		});
		expect(
			normalized.tokens?.some(
				(token) => token.class === "dir" || token.class === "cmd",
			),
		).toBe(false);
	});

	test("fill order conservatism: top-level , / = - stay unclassified for path/arg fills", () => {
		const commaTop = explainCommand(":put 1,2", { tokens: true });
		expect(
			commaTop.tokens?.some((t) => t.class === "operator" && t.start === 7),
		).toBe(false);
		const commaInside = explainCommand(":put (1,2)", { tokens: true });
		expect(
			commaInside.tokens?.some((t) => t.class === "operator" && t.start === 7),
		).toBe(true);
		// Slash and equals share the same conservatism.
		expect(
			explainCommand(":put 1 / 2", { tokens: true }).tokens?.some(
				(t) => t.class === "operator",
			),
		).toBe(false);
		expect(
			explainCommand(":put (1 / 2)", { tokens: true }).tokens?.some(
				(t) => t.class === "operator",
			),
		).toBe(true);
		// …and a `[ ]` is a command substitution, so it does NOT lift the
		// conservatism the way a `( )` does: every byte of this line is path or
		// argument structure and none of it is an operator.
		expect(
			explainCommand(
				":put [/ip/route/find where dst-address=0.0.0.0/0 gateway-status=reachable]",
				{ tokens: true },
			).tokens?.some((t) => t.class === "operator"),
		).toBe(false);
	});
});
