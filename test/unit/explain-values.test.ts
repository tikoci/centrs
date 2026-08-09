import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lexValueAnchors } from "../../src/explain/args.ts";
import {
	VALUE_SHAPES,
	type ValueShape,
	valueShapeHints,
} from "../../src/explain/values.ts";
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
	timeOrdering: {
		channelsMatch: boolean;
		literals: { literal: string; type: string; value: string }[];
	};
	v2Grounding: {
		stable: string;
		testing: string;
		channelsMatch: boolean;
		colonTime: { literal: string; type: string; value: string }[];
		mac: {
			literal: string;
			scalarType: string;
			schemaType: string;
			parsePreserved: boolean;
			shorterThreeGroupType: string;
			shorterFiveGroupType: string;
		};
		arrays: { literal: string; type: string; value: string }[];
		concat: { literal: string; type: string; value: string }[];
		producedTypes: { expression: string; type: string; value: string }[];
		uninitializedType: string;
		nothingCommandType: string;
		emptyArrayElementType: string;
	};
	corpus: {
		sourceScripts: number;
		valueOccurrences: number;
		strictComparableAnchors: number;
		boundaryContradictions: number;
		unreadStatementsWithAnchors: number;
		recoveredPrefixAnchors: number;
		invalidSpans: number;
		shapeCounts: Record<string, number>;
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
		expect(fixture.corpus.valueOccurrences).toBe(17_304);
		expect(fixture.corpus.unreadStatementsWithAnchors).toBe(1_603);
		expect(fixture.corpus.recoveredPrefixAnchors).toBe(4_161);
		expect(fixture.corpus.invalidSpans).toBe(0);
		expect(fixture.corpus.shapeCounts).toMatchObject({ array: 420, mac: 3 });
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

	test("time units are order-independent and additive, so shape must not order them", () => {
		expect(fixture.timeOrdering.channelsMatch).toBe(true);
		for (const row of fixture.timeOrdering.literals) {
			// The device typed every one of these `time` on 7.23.3 and 7.24rc3, so a
			// shape that rejected repeats or descending order would contradict it.
			expect(row.type).toBe("time");
			expect(valueShapeHints(row.literal, { quoted: false })).toEqual(["time"]);
		}
		expect(
			fixture.timeOrdering.literals.find((row) => row.literal === "1m1m")
				?.value,
		).toBe("00:02:00");
	});

	test("V2 records source spellings separately from produced and schema types", () => {
		expect(fixture.v2Grounding).toMatchObject({
			stable: "7.23.3",
			testing: "7.24rc3",
			channelsMatch: true,
			mac: {
				scalarType: "str",
				schemaType: "macAddr",
				parsePreserved: true,
				shorterThreeGroupType: "time",
				shorterFiveGroupType: "str",
			},
			uninitializedType: "nothing",
			nothingCommandType: "nil",
			emptyArrayElementType: "nothing",
		});
		expect(
			fixture.v2Grounding.colonTime.every((row) => row.type === "time"),
		).toBe(true);
		expect(
			fixture.v2Grounding.arrays.every((row) => row.type === "array"),
		).toBe(true);
		expect(fixture.v2Grounding.producedTypes.map((row) => row.type)).toEqual([
			"array",
			"code",
			"id",
			"id",
		]);
		expect(fixture.v2Grounding.concat.map((row) => row.type)).toEqual([
			"array",
			"array",
			"str",
		]);
	});

	test("colon time, IPv6, and MAC spellings remain distinct", () => {
		// One colon is never IPv6, so a named attribute keeps its string hint.
		for (const text of ["foo:bar", "a:b"])
			expect(
				valueShapeHints(text, { quoted: false, allowBareString: true }),
			).toEqual(["str"]);
		for (const text of ["9:00", "1:2:3", "00:00:02", "00:11:22"])
			expect(
				valueShapeHints(text, { quoted: false, allowBareString: true }),
			).toEqual(["time"]);
		expect(
			valueShapeHints("00:11:22:33:44:55", {
				quoted: false,
				allowBareString: true,
			}),
		).toEqual(["mac"]);
		for (const text of ["00:11:22:33:44", "00:11:22:33:44:55:66"])
			expect(
				valueShapeHints(text, { quoted: false, allowBareString: true }),
			).toEqual([]);
		expect(valueShapeHints("1::1", { quoted: false })).toEqual(["ip6"]);
		expect(valueShapeHints("face::b00c", { quoted: false })).toEqual(["ip6"]);
	});
});

describe("value anchors", () => {
	test("array literals are anchored without widening the strict REST lexer", () => {
		for (const source of ["(1,2,3)", '{1;"abc";3}', "{a=1;b=2}"]) {
			const input = `:local z ${source}`;
			const reading = lexValueAnchors(input, ":local z".length);
			expect(reading).toMatchObject({
				complete: true,
				anchors: [
					{
						kind: "positional",
						sourceShape: "array",
						quoted: false,
					},
				],
			});
			expect(
				input.slice(
					reading.anchors[0]?.valueSpan.start,
					reading.anchors[0]?.valueSpan.end,
				),
			).toBe(source);
			expect(reading.anchors[0]?.value).toBe(source);
			expect(
				explainCommand(input).structure.statements[0]?.arguments?.read,
			).toBe(false);
		}
		const followed = lexValueAnchors(
			"/x/cmd list={1;2} in=foo",
			"/x/cmd".length,
		);
		expect(followed.complete).toBe(true);
		expect(followed.anchors.map((anchor) => anchor.name)).toEqual([
			"list",
			"in",
		]);
		for (const dotted of [".id=*1", ".proplist=.id,name"]) {
			const input = `/x/cmd list={1;2} ${dotted}`;
			const reading = lexValueAnchors(input, "/x/cmd".length);
			expect(reading.complete).toBe(true);
			expect(reading.anchors.map((anchor) => anchor.name)).toEqual([
				"list",
				dotted.slice(0, dotted.indexOf("=")),
			]);
		}
		const continued = lexValueAnchors(
			"/x/cmd list={1;2}.id=*1",
			"/x/cmd".length,
		);
		expect(continued.complete).toBe(false);
		expect(continued.anchors).toEqual([]);
	});

	test("grouping, empty groups, scopes, and concat do not fabricate arrays", () => {
		for (const input of [
			":local z (1)",
			":local z ()",
			":local z {}",
			":local z (1,)",
			":local z (,1)",
			":local z (1,,2)",
			':local z ((1,2,3)."a")',
			':local z ((1,2,3) . "a")',
			':local z ("a" . (1,2,3))',
			':local z [:toarray ""]',
		])
			expect(lexValueAnchors(input, ":local z".length).anchors).toEqual([]);
		expect(
			lexValueAnchors(":if true do={ :put 1 }", ":if".length).anchors.map(
				(anchor) => anchor.sourceShape,
			),
		).not.toContain("array");
	});

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
			"/ip/firewall/filter/add count=123 to-addresses=1.1.1.1 src-address=10.9.0.0/16 dst-address=1::1 comment=plain disabled=yes interval=200ms ip6-prefix=2008:1::2/128 id=*A mac-address=00:11:22:33:44:55 list={1;2} ?name",
		);
		const shapes = data.values.occurrences.flatMap(
			(occurrence) => occurrence.facts.shapeHints?.values ?? [],
		);
		expect(shapes).toEqual([
			"num",
			"ip",
			"ip-prefix",
			"ip6",
			"str",
			"bool",
			"time",
			"ip6-prefix",
			"id",
			"mac",
			"array",
		]);
		expect(new Set(shapes)).toEqual(new Set(VALUE_SHAPES));
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
