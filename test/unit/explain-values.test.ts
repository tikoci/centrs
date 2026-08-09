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
		expect(valueShapeHints("2.2", { quoted: false })).toEqual(["num", "ip"]);
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
	test("three axes have stable homes and only offline hints are populated", () => {
		const data = explainCommand(':local x 2.2; :set x "2.2"');
		expect(data.values.occurrences).toEqual([
			{
				id: "v0",
				span: { start: 9, end: 12 },
				tokenSpan: { start: 9, end: 12 },
				kind: "positional",
				quoted: false,
				facts: { shapeHints: { values: ["num", "ip"], ev: "e9" } },
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

	test("value ranges stay document-byte based after non-ASCII source", () => {
		const input = ':put "🚀"; /ip/address/add address=1.1.1.1';
		const occurrence = explainCommand(input).values.occurrences.at(-1);
		const bytes = Buffer.from(input);
		const start = bytes.indexOf(Buffer.from("1.1.1.1"));
		expect(occurrence?.span).toEqual({ start, end: start + 7 });
		expect(bytes.subarray(start, start + 7).toString()).toBe("1.1.1.1");
	});
});
