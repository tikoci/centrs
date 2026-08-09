import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lexValueAnchors } from "../../src/explain/args.ts";
import { type ValueShape, valueShapeHints } from "../../src/explain/values.ts";
import { explainCommand } from "../../src/explain.ts";

interface ValueFixture {
	provenance: {
		stable: string;
		testing: string;
		contextRowsPerChannel: number;
		matrixRowsMatch: boolean;
		quotedScalarRowsPerChannel: number;
		quotedScalarType: string;
		quotedScalarValuesPreserved: boolean;
		auxiliaryDifference: string;
		controls: {
			knownFailure: string;
			badParse: string;
			parseAcceptsBadValue: string;
			typeChangingAssignment: string;
		};
	};
	booleanGrounding: {
		captured: string;
		channelsMatch: boolean;
		scalars: {
			literal: string;
			bareType: string;
			bareValue: string;
			quotedType: string;
		}[];
		assignmentTypes: string[];
		cliDisabled: { accepted: string[]; rejected: string[] };
		restDisabled: { accepted: unknown[]; rejected: unknown[] };
		toBool: { literal: string; type: string; value: string }[];
	};
	corpus: {
		sourceScripts: number;
		strictComparableAnchors: number;
		boundaryContradictions: number;
		recoveredPrefixAnchors: number;
		invalidSpans: number;
	};
	scalars: {
		literal: string;
		hints: ValueShape[];
		bareType: string;
		bareValue: string;
	}[];
	rejectionControls: {
		literal: string;
		hints: ValueShape[];
		attributeHints: ValueShape[];
		bareType: string;
	}[];
	contexts: { input: string; il: string }[];
}

const fixture = JSON.parse(
	readFileSync(
		new URL("../fixtures/explain/values.json", import.meta.url),
		"utf8",
	),
) as ValueFixture;

describe("#225 value-shape grounding matrix", () => {
	test("the fixture records both CHR channels and a failing harness control", () => {
		expect(fixture.provenance.stable).toBe("7.23.3");
		expect(fixture.provenance.testing).toBe("7.24rc3");
		expect(fixture.provenance.contextRowsPerChannel).toBe(170);
		expect(fixture.provenance.matrixRowsMatch).toBe(true);
		expect(fixture.provenance.quotedScalarRowsPerChannel).toBe(17);
		expect(fixture.provenance.quotedScalarType).toBe("str");
		expect(fixture.provenance.quotedScalarValuesPreserved).toBe(true);
		expect(fixture.provenance.auxiliaryDifference).toContain(":tonsec");
		expect(fixture.provenance.controls.knownFailure).toBe("CONTROL-OK");
		expect(fixture.provenance.controls.badParse).toContain("column 1");
		expect(fixture.provenance.controls.parseAcceptsBadValue).toContain(
			"address=not-an-ip",
		);
		expect(fixture.provenance.controls.typeChangingAssignment).toBe(
			"ip\nip\nstr",
		);
		expect(fixture.corpus.sourceScripts).toBe(948);
		expect(fixture.corpus.strictComparableAnchors).toBe(13_143);
		expect(fixture.corpus.boundaryContradictions).toBe(0);
		expect(fixture.corpus.recoveredPrefixAnchors).toBe(3_749);
		expect(fixture.corpus.invalidSpans).toBe(0);
	});

	test("boolean spellings, slots, and conversions remain separate observations", () => {
		expect(fixture.booleanGrounding.channelsMatch).toBe(true);
		expect(
			fixture.booleanGrounding.scalars.map((row) => [
				row.literal,
				row.bareType,
				row.quotedType,
			]),
		).toEqual([
			["true", "bool", "str"],
			["false", "bool", "str"],
			["yes", "bool", "str"],
			["no", "bool", "str"],
			["0", "num", "str"],
			["1", "num", "str"],
		]);
		expect(fixture.booleanGrounding.assignmentTypes).toEqual([
			"bool",
			"str",
			"bool",
			"str",
		]);
		expect(fixture.booleanGrounding.cliDisabled.accepted).toEqual([
			"yes",
			"no",
			'"yes"',
			'"no"',
		]);
		expect(fixture.booleanGrounding.restDisabled.accepted).toContain(true);
		expect(fixture.booleanGrounding.restDisabled.accepted).toContain("true");
		expect(
			fixture.booleanGrounding.toBool.every((row) => row.type === "bool"),
		).toBe(true);
	});

	for (const row of fixture.scalars) {
		test(`${row.literal}: bare hints, observed type, and quoted control`, () => {
			expect(valueShapeHints(row.literal, { quoted: false })).toEqual(
				row.hints,
			);
			// The captured live answer is deliberately not inferred into the result.
			expect(row.bareType.length).toBeGreaterThan(0);
			expect(row.bareValue.length).toBeGreaterThan(0);
			expect(valueShapeHints(row.literal, { quoted: true })).toEqual(["str"]);
		});
	}

	for (const row of fixture.rejectionControls) {
		test(`${row.literal}: a type-looking rejection does not earn a hint`, () => {
			expect(row.bareType).toBe("str");
			expect(valueShapeHints(row.literal, { quoted: false })).toEqual(
				row.hints,
			);
			expect(
				valueShapeHints(row.literal, {
					quoted: false,
					allowBareString: true,
				}),
			).toEqual(row.attributeHints);
		});
	}

	test("argument context changes IL without changing lexical shape", () => {
		const address = fixture.contexts.find((row) =>
			row.input.startsWith("/ip/address/add address=2.2"),
		);
		const firewall = fixture.contexts.find((row) =>
			row.input.includes("src-address=2.2"),
		);
		const invalid = fixture.contexts.find((row) =>
			row.input.includes("src-address=not-an-ip"),
		);
		expect(address?.il).toContain("address=2.0.0.2");
		expect(address?.il).toContain("comment=2.2");
		expect(firewall?.il).toContain("src-address=;2.0.0.2");
		expect(invalid?.il).toContain("src-address=;not-an-ip");
		expect(
			fixture.contexts.find((row) => row.input.includes("interval=2.2"))?.il,
		).toContain("interval=00:00:02.200");
		expect(
			fixture.contexts.find((row) => row.input.includes("disabled=2.2"))?.il,
		).toContain("syntax error");
		expect(
			fixture.contexts.find((row) => row.input.includes("distance=2.2"))?.il,
		).toContain("distance=2.2");
		expect(valueShapeHints("2.2", { quoted: false })).toEqual(["ip"]);
	});

	test("`num` is integer-only, because a dotted decimal is observed as `ip`", () => {
		for (const integer of ["0", "-1", "123"])
			expect(valueShapeHints(integer, { quoted: false })).toEqual(["num"]);
		// Every one of these is an IPv4 shortcut on the device (`2.2` -> 2.0.0.2),
		// and RouterOS numbers are integers, so `num` would contradict `bareType`.
		for (const decimal of ["1.1", "2.2", "1.5", "3.14159"])
			expect(valueShapeHints(decimal, { quoted: false })).toEqual(["ip"]);
		expect(
			fixture.scalars.every(
				(row) => !row.hints.includes("num") || row.bareType === "num",
			),
		).toBe(true);
		// A decimal no address spelling can claim abstains rather than inventing one.
		expect(valueShapeHints("-1.5", { quoted: false })).toEqual([]);
		expect(
			valueShapeHints("-1.5", { quoted: false, allowBareString: true }),
		).toEqual(["str"]);
	});

	test("only an IPv6-shaped colon run counts as an address attempt", () => {
		// One colon is never IPv6, so a named attribute keeps its string hint.
		for (const text of ["foo:bar", "a:b", "9:00"])
			expect(
				valueShapeHints(text, { quoted: false, allowBareString: true }),
			).toEqual(["str"]);
		// Hex-and-colon runs stay fail-closed: a MAC or a colon time spelling has
		// no lexicon member yet (#243) and must not be relabeled `str`.
		for (const text of ["1:2:3", "00:00:02", "00:11:22:33:44:55"])
			expect(
				valueShapeHints(text, { quoted: false, allowBareString: true }),
			).toEqual([]);
		expect(valueShapeHints("1::1", { quoted: false })).toEqual(["ip6"]);
		expect(valueShapeHints("face::b00c", { quoted: false })).toEqual(["ip6"]);
	});
});

describe("value anchors", () => {
	test("an unreadable later substitution does not erase an earlier literal", () => {
		const input = "/ip/address/add address=1.1.1.1 comment=[find]";
		const reading = lexValueAnchors(input, "/ip/address/add".length);
		expect(reading).toEqual({
			complete: false,
			anchors: [
				{
					kind: "attribute",
					tokenSpan: { start: 16, end: 31 },
					name: "address",
					valueSpan: { start: 24, end: 31 },
					value: "1.1.1.1",
					quoted: false,
				},
			],
			why: "a substitution or expression value",
		});
	});

	test("the anchor scan and strict REST lexer share literal boundaries", () => {
		const input = '/ip/address/add address="1.1.1.1" disabled=no';
		const reading = lexValueAnchors(input, "/ip/address/add".length);
		expect(reading.complete).toBe(true);
		expect(reading.anchors.map((anchor) => anchor.value)).toEqual([
			"1.1.1.1",
			"no",
		]);
		expect(
			reading.anchors.map((anchor) =>
				input.slice(anchor.valueSpan.start, anchor.valueSpan.end),
			),
		).toEqual(['"1.1.1.1"', "no"]);
	});

	test("quote state comes from literal decoding, including an empty value", () => {
		const input = '/ip/address/add comment=""';
		expect(lexValueAnchors(input, "/ip/address/add".length).anchors).toEqual([
			{
				kind: "attribute",
				tokenSpan: { start: 16, end: 26 },
				name: "comment",
				valueSpan: { start: 24, end: 26 },
				value: "",
				quoted: true,
			},
		]);
	});

	for (const [suffix, why] of [
		["comment=it's", "a single quote"],
		["comment=a\\ b", "an escape"],
		["comment=x\fdisabled=no", "a form feed"],
	] as const) {
		test(`a later ${why} cannot erase a prior value`, () => {
			const input = `/ip/address/add address=1.1.1.1 ${suffix}`;
			const reading = lexValueAnchors(input, "/ip/address/add".length);
			expect(reading.complete).toBe(false);
			expect(reading.anchors.map((anchor) => anchor.name)).toEqual(["address"]);
			if (!reading.complete) expect(reading.why).toContain(why);
		});
	}
});

describe("explain value facts", () => {
	for (const suffix of [
		"comment=[find]",
		"comment=it's",
		"comment=a\\ b",
		"comment=x\fdisabled=no",
	]) {
		test(`the public envelope retains a safe prefix before ${JSON.stringify(suffix)}`, () => {
			const data = explainCommand(`/ip/address/add address=1.1.1.1 ${suffix}`);
			expect(data.values.occurrences).toHaveLength(1);
			expect(data.values.occurrences[0]).toMatchObject({
				name: "address",
				facts: { shapeHints: { values: ["ip"] } },
			});
			expect(data.structure.statements[0]?.arguments?.read).toBe(false);
		});
	}

	test("three axes have stable homes and only offline hints are populated", () => {
		const data = explainCommand(':local x 2.2; :set x "2.2"');
		expect(data.values.occurrences).toEqual([
			{
				id: "v0",
				span: { start: 9, end: 12 },
				tokenSpan: { start: 9, end: 12 },
				kind: "positional",
				quoted: false,
				facts: { shapeHints: { values: ["ip"], ev: "e9" } },
			},
			{
				id: "v1",
				span: { start: 21, end: 26 },
				tokenSpan: { start: 21, end: 26 },
				kind: "positional",
				quoted: true,
				facts: { shapeHints: { values: ["str"], ev: "e9" } },
			},
		]);
		expect(data.evidence.find((entry) => entry.id === "e9")).toEqual({
			id: "e9",
			source: "canonicalizer",
			probe: "valueShapeHints",
			basis: "heuristic",
			outcome: "ok",
		});
	});

	test("generic positional words abstain while named attributes can hint string", () => {
		const data = explainCommand("/ip/address/add comment=uplink");
		expect(data.values.occurrences).toHaveLength(1);
		expect(data.values.occurrences[0]).toMatchObject({
			name: "comment",
			facts: { shapeHints: { values: ["str"] } },
		});
	});

	test("all shape vocabulary reaches the public envelope without query values", () => {
		const data = explainCommand(
			"/ip/firewall/filter/add count=123 to-addresses=1.1.1.1 src-address=10.9.0.0/16 dst-address=1::1 comment=plain disabled=yes interval=200ms ip6-prefix=2008:1::2/128 ?name",
		);
		expect(
			data.values.occurrences.flatMap(
				(occurrence) => occurrence.facts.shapeHints?.values ?? [],
			),
		).toEqual([
			"num",
			"ip",
			"ip-prefix",
			"ip6",
			"str",
			"bool",
			"time",
			"ip6-prefix",
		]);
		expect(data.values.occurrences.some((value) => value.name === "name")).toBe(
			false,
		);
	});

	test("malformed address-like attributes abstain in the public envelope", () => {
		expect(
			explainCommand("/ip/address/add address=1.1.1.1/99").values.occurrences,
		).toEqual([]);
	});

	test("value ranges stay document-byte based after non-ASCII source", () => {
		const input = ':put "🚀"; /ip/address/add address=1.1.1.1';
		const occurrence = explainCommand(input).values.occurrences.at(-1);
		const bytes = Buffer.from(input);
		const start = bytes.indexOf(Buffer.from("1.1.1.1"));
		expect(occurrence?.span).toEqual({ start, end: start + 7 });
		expect(occurrence?.tokenSpan).toEqual({ start: start - 8, end: start + 7 });
		expect(bytes.subarray(start, start + 7).toString()).toBe("1.1.1.1");
	});
});
