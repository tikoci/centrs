/**
 * #295 B2 — valueSpans traps.
 *
 * Third B2 fill after arg. Claims argument value bytes and leaf array-literal
 * members on the residual left by `spans` + `arg`, before `operatorSpans` sees
 * it. Source is `data.values.occurrences` (prefix-safe, carries interiors), not
 * `Argument.valueSpan`. Vocabulary is provisional: one `value` class (ev e9),
 * quotes-INCLUDED by contract, containers skipped (leaf-only via Set<parent>),
 * clipped to residual — buildTokens overlap throw is the safety net.
 *
 * Most coverage is from args/values ground truth itself (values tests prove the
 * occurrences); these tests pin the fill's invariants that would otherwise go
 * red silently.
 */

import { describe, expect, test } from "bun:test";
import { analyzeCoordinates } from "../../src/explain/coordinates.ts";
import { valueSpans } from "../../src/explain/value-tokens.ts";
import {
	type ExplainValueOccurrence,
	explainCommand,
	residualRanges,
} from "../../src/explain.ts";

type DirectOccurrence = Pick<ExplainValueOccurrence, "id" | "span" | "parent">;

function valuesViaExplain(input: string): string[] {
	const data = explainCommand(input, { tokens: true });
	const analyzed = new TextDecoder().decode(analyzeCoordinates(input).analyzed);
	return (data.tokens ?? [])
		.filter((t) => t.class === "value")
		.map((t) => analyzed.slice(t.start, t.end));
}

function valuesDirect(
	analyzed: string,
	residual: { start: number; end: number }[],
	occurrences: DirectOccurrence[],
): string[] {
	const complete: ExplainValueOccurrence[] = occurrences.map((occurrence) => ({
		...occurrence,
		tokenSpan: occurrence.span,
		kind: occurrence.parent === undefined ? "attribute" : "element",
		quoted: false,
		facts: {},
	}));
	return valueSpans(analyzed, residual, complete).map((s) =>
		analyzed.slice(s.start, s.end),
	);
}

describe("#295 value fill — direct residual scanner", () => {
	test("leaf-only: container skipped, members claimed via parent", () => {
		// mirrors explainCommand(":local a {1;2;3}") occurrences
		const analyzed = ":local a {1;2;3}";
		const residual = [{ start: 0, end: analyzed.length }];
		const listed = [
			{ id: "v0", span: { start: 9, end: 16 } },
			{ id: "v1", span: { start: 10, end: 11 }, parent: "v0" },
			{ id: "v2", span: { start: 12, end: 13 }, parent: "v0" },
			{ id: "v3", span: { start: 14, end: 15 }, parent: "v0" },
		];
		expect(valuesDirect(analyzed, residual, listed)).toEqual(["1", "2", "3"]);
		// A lone container with no members IS a leaf — it is kept. In the
		// corpus it never appears alone (array members imply parent), but the
		// scanner must not invent a discard rule that throws away a one-member
		// scalar container that happens to be the only occurrence.
		expect(valuesDirect(analyzed, residual, listed.slice(0, 1))).toEqual([
			"{1;2;3}",
		]);
	});

	test("single attribute leaf claims its value span", () => {
		const analyzed = "address=1.1.1.1";
		const listed = [{ id: "v0", span: { start: 8, end: 15 } }];
		expect(valuesDirect(analyzed, [{ start: 0, end: 15 }], listed)).toEqual([
			"1.1.1.1",
		]);
	});

	test("quoted span is quotes-included", () => {
		// valueOccurrence.span contract: quotes included
		const analyzed = 'address="hi"';
		const listed = [{ id: "v0", span: { start: 8, end: 12 } }];
		expect(valuesDirect(analyzed, [{ start: 0, end: 12 }], listed)).toEqual([
			'"hi"',
		]);
	});

	test("respects residual — clipped, not re-claimed", () => {
		const analyzed = 'address="hi"';
		const listed = [{ id: "v0", span: { start: 8, end: 12 } }];
		// variable span claimed interior byte 10 (e.g. $x inside quoted value)
		expect(
			valuesDirect(
				analyzed,
				[
					{ start: 0, end: 10 },
					{ start: 11, end: 12 },
				],
				listed,
			),
		).toEqual(['"h', '"']);
		// fully masked
		expect(valuesDirect(analyzed, [{ start: 0, end: 8 }], listed)).toEqual([]);
	});

	test("sorted output — occurrences need not arrive sorted", () => {
		const analyzed = "a=1 b=2 c=3";
		const listed = [
			{ id: "v2", span: { start: 10, end: 11 } },
			{ id: "v0", span: { start: 2, end: 3 } },
			{ id: "v1", span: { start: 6, end: 7 } },
		];
		expect(valuesDirect(analyzed, [{ start: 0, end: 11 }], listed)).toEqual([
			"1",
			"2",
			"3",
		]);
	});

	test("nested array — only deepest leaves survive", () => {
		// {{1;2};3}: outer {…} contains inner {1;2}; inner contains 1,2
		const analyzed = "x={{1;2};3}";
		const listed = [
			{ id: "v0", span: { start: 2, end: 11 } }, // outer pos
			{ id: "v1", span: { start: 3, end: 8 }, parent: "v0" }, // inner arr
			{ id: "v2", span: { start: 4, end: 5 }, parent: "v1" }, // 1
			{ id: "v3", span: { start: 6, end: 7 }, parent: "v1" }, // 2
			{ id: "v4", span: { start: 9, end: 10 }, parent: "v0" }, // 3
		];
		expect(valuesDirect(analyzed, [{ start: 0, end: 11 }], listed)).toEqual([
			"1",
			"2",
			"3",
		]);
	});

	test("empty or out-of-bounds occurrences are ignored", () => {
		const analyzed = "address=1";
		expect(valuesDirect(analyzed, [], [])).toEqual([]);
		expect(
			valuesDirect(
				"",
				[{ start: 0, end: 1 } as never],
				[{ id: "v0", span: { start: 0, end: 1 } }],
			),
		).toEqual([]);
		expect(
			valuesDirect(
				analyzed,
				[{ start: 0, end: 9 }],
				[{ id: "v0", span: { start: 8, end: 8 } }],
			),
		).toEqual([]);
		expect(
			valuesDirect(
				analyzed,
				[{ start: 0, end: 9 }],
				[{ id: "v0", span: { start: 0, end: 99 } }],
			),
		).toEqual([]);
	});

	test("does not read tokenSpan/facts — only span + id/parent", () => {
		const analyzed = "comment=hello";
		const listed = [
			{
				id: "v0",
				span: { start: 8, end: 13 },
				tokenSpan: { start: 0, end: 13 },
				facts: { shapeHints: { values: ["ip" as const], ev: "e9" } },
			},
		];
		expect(
			valuesDirect(analyzed, [{ start: 0, end: 13 }], listed as never),
		).toEqual(["hello"]);
	});
});

describe("#295 value fill — via explainCommand (fill order + evidence)", () => {
	test.each([
		[
			'/ip/address/add address=1.2.3.4/24 interface=ether1 comment="hi"',
			["1.2.3.4/24", "ether1", '"hi"'],
		],
		["/ip/address/add address=1.1.1.1", ["1.1.1.1"]],
		[":local a {1;2;3}", ["1", "2", "3"]],
		[":local arr {a=1;b=2}", ["1", "2"]],
		[':local x "hello"', ['"hello"']],
		["/ip/dns/set servers=1.1.1.1,8.8.8.8", ["1.1.1.1,8.8.8.8"]],
		["/ip/dns/set servers=(1.1.1.1,8.8.8.8)", ["1.1.1.1", "8.8.8.8"]],
		["# comment only", []],
		["", []],
	])("%s → %j", (input, expected) => {
		expect(valuesViaExplain(input as string)).toEqual(expected as string[]);
	});

	test("prefix-safe: :local a {1;2;3} is lexArguments read:false but values still anchored", () => {
		// lexArguments refuses an array/block value wholesale; lexValueAnchors keeps prefix
		expect(valuesViaExplain(":local a {1;2;3}")).toEqual(["1", "2", "3"]);
		// whole document unverified statement still has no values
		expect(valuesViaExplain("/ip/route/add gateway=$gw")).toEqual([]);
	});

	test("container not emitted as a value token", () => {
		const data = explainCommand(":local a {1;2;3}", { tokens: true });
		const analyzed = new TextDecoder().decode(
			analyzeCoordinates(":local a {1;2;3}").analyzed,
		);
		const valSlices = (data.tokens ?? [])
			.filter((t) => t.class === "value")
			.map((t) => analyzed.slice(t.start, t.end));
		expect(valSlices).toEqual(["1", "2", "3"]);
		expect(valSlices.join(",")).not.toContain("{");
	});

	test("variable inside value clips it — no self-overlap", () => {
		// Corpus case: ($Attach, ($FilePath . ".backup")) contains a variable
		// span overlapping the positional value, clipped to residual. See the
		// 54 clipped scripts on the corpus where leaf value bytes overlap a
		// variable-* span — here shown as a direct residual shape.
		const gapless = explainCommand(":local a {1;2;3}", { tokens: true });
		for (let i = 1; i < (gapless.tokens ?? []).length; i++) {
			expect(gapless.tokens?.[i]?.start).toBe(gapless.tokens?.[i - 1]?.end);
		}
		const analyzed = "x=abcde";
		const residualWithHole = [
			{ start: 0, end: 3 }, // "x=a"
			{ start: 4, end: 7 }, // cspell:disable-next-line — cde is residual residue — byte 3 "b" is claimed by a variable span
		];
		const listed2 = [{ id: "v0", span: { start: 2, end: 7 } }]; // "abcde"
		expect(valuesDirect(analyzed, residualWithHole, listed2)).toEqual([
			"a",
			// cspell:disable-next-line
			"cde",
		]);
	});

	test("quoted value includes both quote bytes", () => {
		// Bare command with no path/verb is not eligible (valuesOf needs argsAt),
		// so assert the shape on a resolved command and on the anchored count.
		const bare = explainCommand('comment="hi"', { tokens: true });
		expect(bare.values.occurrences.length).toBe(0);
		const withVerb = explainCommand('/ip/dns/set name="hi"', { tokens: true });
		expect(withVerb.values.occurrences).toHaveLength(1);
		expect(withVerb.values.occurrences[0]?.span).toEqual({
			start: 17,
			end: 21,
		});
		expect(valuesViaExplain('/ip/dns/set name="hi"')).toEqual(['"hi"']);
		expect(withVerb.values.occurrences[0]?.quoted).toBe(true);
	});

	test("value fills before operator — dot inside value is not operator", () => {
		// "hello.world" as a value is one value token, not 2 unclassified + operator
		expect(valuesViaExplain("/ip/dns/set name=hello.world")).toEqual([
			"hello.world",
		]);
		const ops = (
			explainCommand("/ip/dns/set name=hello.world", { tokens: true }).tokens ??
			[]
		).filter((t) => t.class === "operator");
		expect(ops.length).toBe(0);
		// Outside a value, operators still claim
		expect(
			(explainCommand(":put (1+2)", { tokens: true }).tokens ?? []).filter(
				(t) => t.class === "operator",
			).length,
		).toBe(1);
	});

	test("every value token carries ev e9 and evidence cites it", () => {
		const data = explainCommand("/ip/address/add address=1.1.1.1", {
			tokens: true,
		});
		const vals = (data.tokens ?? []).filter((t) => t.class === "value");
		expect(vals.length).toBe(1);
		for (const t of vals) expect(t.ev).toBe("e9");
		expect(data.evidence.some((e) => e.id === "e9")).toBe(true);
		// No value → no e9
		const noVal = explainCommand("/ip address print", { tokens: true });
		expect(noVal.evidence.some((e) => e.id === "e9")).toBe(false);
		const noVal2 = explainCommand("# comment", { tokens: true });
		expect(noVal2.evidence.some((e) => e.id === "e9")).toBe(false);
	});

	test("spans stay proof-only — no value class there", () => {
		const data = explainCommand("/ip/address/add address=1.1.1.1", {
			tokens: true,
		});
		expect(data.spans.some((s) => (s.class as string) === "value")).toBe(false);
	});

	test("block-body value is on the same partition (flattened verbs)", () => {
		const input = ":if (1=1) do={ /ip/address/add address=1.1.1.1 }";
		const data = explainCommand(input, { tokens: true });
		expect(valuesViaExplain(input)).toEqual(["1.1.1.1"]);
		// partition still gapless
		const analyzed = new TextDecoder().decode(
			analyzeCoordinates(input).analyzed,
		);
		const recon = (data.tokens ?? [])
			.map((t) => analyzed.slice(t.start, t.end))
			.join("");
		expect(recon).toBe(analyzed);
	});

	test("normalized doc yields no value tokens (prefix-safe through addressability)", () => {
		// normalized statements fail the argsAt addressability check, so valuesOf sees no text
		expect(valuesViaExplain('/system identity set name="router-🚀"')).toEqual(
			[],
		);
	});

	test("mixed doc: a read statement claims, an unread one does not spill", () => {
		const input = "/ip/address/add address=1.1.1.1\n/ip/route/add gateway=$gw";
		const data = explainCommand(input, { tokens: true });
		const vals = (data.tokens ?? []).filter((t) => t.class === "value");
		expect(vals.length).toBe(1);
		expect(
			vals[0] !== undefined ? input.slice(vals[0].start, vals[0].end) : "",
		).toBe("1.1.1.1");
		const secondStart = input.indexOf("\n") + 1;
		for (const t of vals) expect(t.end).toBeLessThanOrEqual(secondStart);
	});

	test("residualRanges complement — used by fill order", () => {
		expect(residualRanges(5, [{ start: 1, end: 3 }])).toEqual([
			{ start: 0, end: 1 },
			{ start: 3, end: 5 },
		]);
	});
});
