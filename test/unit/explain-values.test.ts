import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lexValueAnchors } from "../../src/explain/args.ts";
import { braceArraySlotPairs } from "../../src/explain/brace-slots.ts";
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
	interiorGrounding: {
		captured: string;
		stable: string;
		maxTimeNanos: string;
		separators: {
			literal: string;
			type: string;
			length: number;
			il: string;
		}[];
		members: { literal: string; type: string; value: string }[];
		keyed: { literal: string; il: string; members: string[] }[];
		invalidLiterals: string[];
		nestedLiterals: { literal: string; parses: boolean; il: string }[];
		braceSlots: { verb: string; slot: string; outcome: string }[];
		positions: {
			input: string;
			parses: boolean;
			highlightErrorAt: number;
			highlightErrorByte: string | null;
		}[];
		addressShortcut: {
			literal: string;
			valueType: string;
			value: string;
			memberType: string;
			memberValue: string;
		}[];
		commaSpelling: {
			arguments: { input: string; il: string; highlightErrorAt: number }[];
			expressions: { literal: string; observed: string }[];
		};
	};
	corpus: {
		censusCommand: string;
		sourceScripts: number;
		valueOccurrences: number;
		elementOccurrences: number;
		keyedElements: number;
		nestedElements: number;
		strictComparableAnchors: number;
		boundaryContradictions: number;
		unreadStatementsWithAnchors: number;
		recoveredPrefixAnchors: number;
		invalidSpans: number;
		danglingParents: number;
		containmentBreaks: number;
		shapeCounts: Record<string, number>;
		elementShapeCounts: Record<string, number>;
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
		// Recomputed at #225 with `bun run explain:value-census`, checked in
		// precisely so these figures can be derived again under one stated
		// definition rather than guessed at from the number alone.
		expect(fixture.corpus.censusCommand).toBe(
			"bun run explain:value-census --json",
		);
		expect(fixture.corpus.sourceScripts).toBe(948);
		expect(fixture.corpus.strictComparableAnchors).toBe(13_168);
		expect(fixture.corpus.valueOccurrences).toBe(19_708);
		expect(fixture.corpus.unreadStatementsWithAnchors).toBe(569);
		expect(fixture.corpus.recoveredPrefixAnchors).toBe(6_540);
		expect(fixture.corpus.elementOccurrences).toBe(5_636);
		expect(fixture.corpus.keyedElements).toBe(529);
		expect(fixture.corpus.nestedElements).toBe(1_147);
		expect(fixture.corpus.shapeCounts).toMatchObject({ array: 813, mac: 3 });
		// The four invariants, none of which is a measurement of taste: where both
		// readings exist they agree, every span addresses its own bytes, every
		// member names a container, and every member sits strictly inside it.
		expect(fixture.corpus.boundaryContradictions).toBe(0);
		expect(fixture.corpus.invalidSpans).toBe(0);
		expect(fixture.corpus.danglingParents).toBe(0);
		expect(fixture.corpus.containmentBreaks).toBe(0);
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
		for (const decimal of ["1.1", "2.2", "1.5", "3.141"])
			expect(valueShapeHints(decimal, { quoted: false })).toEqual(["ip"]);
		// …but only while every field is one OCTET. `3.14159` is `time`
		// (`00:00:03.141590`) on 7.23.3, not `3.255.255.255`: the shortcut fills
		// the low octets and does not widen the last field, so a too-large part
		// stops the value being an address at all. Offline abstains there rather
		// than encoding the seconds fallback (see `1.256`, `1.1.256`).
		for (const wide of ["3.14159", "1.256", "1.16777215", "1.1.65535"])
			expect(valueShapeHints(wide, { quoted: false })).toEqual([]);
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

	/**
	 * The interior lexicon, scored against every member the device typed for us.
	 *
	 * The rule is one-sided on purpose: an abstention is always allowed, because
	 * a hint is advisory and silence never has to be unsaid; naming a type the
	 * device contradicts is not. That is what makes the row set a genuine
	 * falsifier rather than a restatement of the implementation.
	 */
	test("no member hint contradicts the type the device reported", () => {
		expect(fixture.interiorGrounding.stable).toBe("7.23.3");
		expect(fixture.interiorGrounding.members.length).toBeGreaterThan(50);
		const contradictions: string[] = [];
		for (const row of fixture.interiorGrounding.members) {
			const quoted = row.literal.startsWith('"') && row.literal.endsWith('"');
			const source = quoted ? row.literal.slice(1, -1) : row.literal;
			const hints = valueShapeHints(source, {
				quoted,
				context: "array-member",
			});
			if (hints.length === 0) continue;
			// `nothing` is the device saying "variable reference", i.e. not a literal
			// at all — any hint there is a fabrication.
			if (hints.length !== 1 || hints[0] !== row.type)
				contradictions.push(
					`${row.literal}: device ${row.type}, offline ${JSON.stringify(hints)}`,
				);
		}
		expect(contradictions).toEqual([]);
	});

	/**
	 * The short IPv4 spelling fills the LOW octets and never widens the final
	 * field, in either position. Scored the same one-sided way: `ip` may not be
	 * claimed where the device typed something else, and abstention is free.
	 */
	test("the address shortcut is octet-bounded in both positions", () => {
		const wrong: string[] = [];
		for (const row of fixture.interiorGrounding.addressShortcut) {
			expect(row.valueType).toBe(
				row.memberType === "nothing" ? "str" : row.memberType,
			);
			const hints = valueShapeHints(row.literal, { quoted: false });
			if (hints.length > 0 && hints[0] !== row.valueType)
				wrong.push(`${row.literal}: device ${row.valueType}, offline ${hints}`);
		}
		expect(wrong).toEqual([]);
		expect(
			fixture.interiorGrounding.addressShortcut
				.filter((row) => row.valueType === "ip")
				.map((row) => row.literal),
		).toContain("1.255");
		expect(
			fixture.interiorGrounding.addressShortcut
				.filter((row) => row.valueType !== "ip")
				.map((row) => row.literal),
		).toEqual([
			"1.256",
			"1.999",
			"1.65535",
			"1.16777215",
			"1.16777216",
			"3.14159",
			"256.1",
			"1.1.256",
			"1.1.65535",
			"1.1.1.256",
		]);
	});

	/**
	 * The one spelling with two device readings, and therefore the first hint
	 * that is genuinely plural. `{1;2}` is a syntax error in a command argument
	 * but `=1,2,3` is not, and only the argument's TYPE decides whether the run
	 * splits — which is a `schemaType` fact offline does not have.
	 */
	test("a bare comma run carries both readings, because the schema picks one", () => {
		const rows = fixture.interiorGrounding.commaSpelling;
		// Nothing here is a syntax error: the comma spelling is always accepted.
		expect(rows.arguments.every((row) => row.highlightErrorAt === -1)).toBe(
			true,
		);
		// A list-typed attribute lowers the run to a `;` list…
		expect(
			rows.arguments.find((row) => row.input.includes("servers=1.1.1.1,"))?.il,
		).toContain("servers=1.1.1.1;8.8.8.8");
		expect(
			rows.arguments.find((row) => row.input.includes("dst-port=80,443"))?.il,
		).toContain("dst-port=;80;443");
		// …while a single-valued one keeps the whole run, comma included.
		expect(
			rows.arguments.find((row) => row.input.includes("comment=a,b"))?.il,
		).toContain("comment=a,b");
		expect(
			rows.arguments.find((row) => row.input.includes("interface=ether1,"))?.il,
		).toContain("interface=ether1,ether2");
		// In an expression position there is no second reading to carry.
		expect(
			rows.expressions
				.filter((row) => row.literal.includes(","))
				.map((row) => row.observed.split("|")[0]),
		).toEqual(["array", "array", "array"]);

		const named = { quoted: false, allowBareString: true } as const;
		expect(valueShapeHints("1.1.1.1,8.8.8.8", named)).toEqual(["array", "str"]);
		expect(valueShapeHints("a,b", named)).toEqual(["array", "str"]);
		expect(valueShapeHints("established,related", named)).toEqual([
			"array",
			"str",
		]);
		// A directive's value slot has no text reading, so the hint is singular.
		expect(valueShapeHints("1,2", { quoted: false })).toEqual(["array"]);
		// Quoting still ends the question.
		expect(valueShapeHints("a,b", { quoted: true })).toEqual(["str"]);

		expect(
			explainCommand("/ip/dns/set servers=1.1.1.1,8.8.8.8").values
				.occurrences[0]?.facts.shapeHints?.values,
		).toEqual(["array", "str"]);
		// No members: whether the run splits at all is the schema's answer, so a
		// member span here would be a guess. The `(1,2)` spelling still descends.
		expect(
			explainCommand("/ip/dns/set servers=1.1.1.1,8.8.8.8").values.occurrences,
		).toHaveLength(1);
		expect(
			explainCommand("/ip/dns/set servers=(1.1.1.1,8.8.8.8)").values.occurrences
				.length,
		).toBe(3);
	});

	test("the member lexicon is not the argument lexicon", () => {
		const member = { quoted: false, context: "array-member" } as const;
		const argument = { quoted: false, allowBareString: true } as const;
		// Dropped in a member: a bare word is `$abc`, a MAC is a variable, and an
		// internal id does not parse at all.
		for (const spelling of ["abc", "00:11:22:33:44:55", "*1"]) {
			expect(valueShapeHints(spelling, member)).toEqual([]);
			expect(valueShapeHints(spelling, argument).length).toBe(1);
		}
		// Added in a member: hexadecimal is a number there, text everywhere else.
		expect(valueShapeHints("0x10", member)).toEqual(["num"]);
		expect(valueShapeHints("0x10", argument)).toEqual(["str"]);
		expect(valueShapeHints("0X10", member)).toEqual([]);
		// Range-checked in a member: the cliff sits at 2^63 nanoseconds.
		expect(fixture.interiorGrounding.maxTimeNanos).toBe("9223372036854775807");
		for (const inRange of ["15250w", "106751d", "9223372036s", "200ms"])
			expect(valueShapeHints(inRange, member)).toEqual(["time"]);
		for (const overflow of ["15251w", "106752d", "9223372037s", "100000w"]) {
			expect(valueShapeHints(overflow, member)).toEqual([]);
			expect(valueShapeHints(overflow, argument)).toEqual(["time"]);
		}
		// The colon spelling is bounded by the same count.
		expect(valueShapeHints("15250w00:00:00", member)).toEqual(["time"]);
		expect(valueShapeHints("15251w00:00:00", member)).toEqual([]);
	});
});

describe("value anchors", () => {
	test("array literals are anchored without widening the strict REST lexer", () => {
		for (const source of ["(1,2,3)", '{1;"abc";3}', "{a=1;b=2}"]) {
			const input = `:local z ${source}`;
			const reading = lexValueAnchors(input, ":local".length, {
				directiveVerb: "local",
			});
			expect(reading.complete).toBe(true);
			// `z` is positional #0 — the NAME slot, which takes no array — and the
			// literal is #1, so the walk starts at the verb the way `explain` does.
			const literal = reading.anchors[1];
			expect(literal).toMatchObject({
				kind: "positional",
				sourceShape: "array",
				quoted: false,
			});
			expect(
				input.slice(literal?.valueSpan.start, literal?.valueSpan.end),
			).toBe(source);
			expect(literal?.value).toBe(source);
			expect(reading.anchors.slice(2).every((a) => a.kind === "element")).toBe(
				true,
			);
			expect(
				explainCommand(input).structure.statements[0]?.arguments?.read,
			).toBe(false);
		}
		const followed = lexValueAnchors(
			"/x/cmd list=(1,2) in=foo",
			"/x/cmd".length,
		);
		expect(followed.complete).toBe(true);
		expect(
			followed.anchors
				.filter((anchor) => anchor.kind !== "element")
				.map((anchor) => anchor.name),
		).toEqual(["list", "in"]);
		for (const dotted of [".id=*1", ".proplist=.id,name"]) {
			const input = `/x/cmd list=(1,2) ${dotted}`;
			const reading = lexValueAnchors(input, "/x/cmd".length);
			expect(reading.complete).toBe(true);
			expect(
				reading.anchors
					.filter((anchor) => anchor.kind !== "element")
					.map((anchor) => anchor.name),
			).toEqual(["list", dotted.slice(0, dotted.indexOf("="))]);
		}
		const continued = lexValueAnchors(
			"/x/cmd list=(1,2).id=*1",
			"/x/cmd".length,
		);
		expect(continued.complete).toBe(false);
		expect(continued.anchors).toEqual([]);
	});

	/**
	 * A `{…}` is an array literal only where RouterOS parses an EXPRESSION, and a
	 * command argument is not one. On CHR 7.23.3 `/console/inspect` classes the
	 * `{` byte `error` and `:parse` refuses the statement for every row below —
	 * including `servers=`, whose attribute really is list-typed, which is what
	 * rules out a schema-shaped explanation. `(1,2)` in the same slot parses, so
	 * only the brace is gated.
	 */
	test("a brace array is refused outside a scripting directive's value", () => {
		for (const input of [
			"/ip/route/add comment={1;2}",
			"/ip/dns/set servers={1.1.1.1;8.8.8.8}",
			"/interface/print .proplist={name;comment}",
			"ip route add comment={1;2}",
			":log info message={1;2}",
		]) {
			expect(explainCommand(input).values.occurrences).toEqual([]);
			expect(explainCommand(input).verdict).toBe("pass");
		}
		// The same bytes one position over, where the device does accept them.
		for (const input of [
			":local z {1;2}",
			":put {1;2}",
			":foreach i in={1;2} do={:put $i}",
			"/ip/route/add comment=(1,2)",
		])
			expect(
				explainCommand(input).values.occurrences[0]?.facts.shapeHints?.values,
			).toEqual(["array"]);
	});

	test("a continuation comment is skipped, not read as a zero-length token", () => {
		// The comment-masked view decides whitespace for the walk as well as the
		// token scan. When only the scan saw the mask, the walk stalled on the `#`
		// and `explain` never returned. Found in review of #243.
		const input = "/x/cmd list=(1,2) \\\n# note\n in=foo";
		const reading = lexValueAnchors(input, "/x/cmd".length);
		expect(reading.complete).toBe(true);
		expect(
			reading.anchors
				.filter((anchor) => anchor.kind !== "element")
				.map((anchor) => [
					anchor.name,
					input.slice(anchor.valueSpan.start, anchor.valueSpan.end),
				]),
		).toEqual([
			["list", "(1,2)"],
			["in", "foo"],
		]);
		expect(
			explainCommand(input).values.occurrences.map(
				(occurrence) => occurrence.facts.shapeHints?.values,
			),
		).toEqual([["array"], ["num"], ["num"], ["str"]]);
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
			// Empty members are a device syntax error, so the enclosing `array`
			// shape is withdrawn with them: `{;}`, `{;1}`, `{1;;2}` and `(1,)` all
			// fail to parse on 7.23.3, while `{1;}` is a legal one-member array.
			":local z {;}",
			":local z {;1}",
			":local z {1;;2}",
		])
			expect(
				lexValueAnchors(input, ":local".length, {
					directiveVerb: "local",
				}).anchors.every((anchor) => anchor.sourceShape !== "array"),
			).toBe(true);
		expect(
			lexValueAnchors(":local z {1;}", ":local".length, {
				directiveVerb: "local",
			}).anchors.length,
		).toBe(3);
		expect(
			lexValueAnchors(":if true do={ :put 1 }", ":if".length).anchors.map(
				(anchor) => anchor.sourceShape,
			),
		).not.toContain("array");
	});

	/**
	 * Member structure, in the shapes the device's own `:foreach k,v` reported.
	 * The separator belongs to the delimiter: `{1,2}` is ONE member (a nested
	 * array), which is why the comma cannot simply be treated as a second
	 * separator inside braces.
	 */
	test("members are located, keyed, and nested the way the device groups them", () => {
		const shapes = (input: string) =>
			explainCommand(input).values.occurrences.map((value) => [
				value.kind,
				value.name ?? null,
				value.parent ?? null,
				value.facts.shapeHints?.values.join("|"),
			]);
		expect(shapes(":local z {1;2}")).toEqual([
			["positional", null, null, "array"],
			["element", null, "v0", "num"],
			["element", null, "v0", "num"],
		]);
		expect(shapes(":local z {1,2}")).toEqual([
			["positional", null, null, "array"],
			["element", null, "v0", "array"],
			["element", null, "v1", "num"],
			["element", null, "v1", "num"],
		]);
		expect(shapes(":local z {a=1;b=1d}")).toEqual([
			["positional", null, null, "array"],
			["element", "a", "v0", "num"],
			["element", "b", "v0", "time"],
		]);
		// `=` compares rather than binding a key in the paren form, so both
		// members are expressions and abstain.
		expect(shapes(":local z (a=1,b=2)")).toEqual([
			["positional", null, null, "array"],
		]);
		// `a=` is not an empty-valued key: `{a=;1}` is two members on the device,
		// the first the STRING `a` — the `=` disappears. Offline declines to
		// claim either reading of it and still reads the member beside it.
		expect(shapes(":local z {a=;1}")).toEqual([
			["positional", null, null, "array"],
			["element", null, "v0", "num"],
		]);
	});

	test("the brace-slot table is exactly the device's array rows", () => {
		// The drift gate for `src/explain/brace-slots.ts`: the fixture holds the
		// sweep's 222 (verb, slot) verdicts and the product table must equal its
		// `array` rows — no hand-added slot, no silently dropped one. `code` and
		// `error` rows are excluded on purpose; `inconclusive` rows are excluded
		// because the probe could not ask, which is not the same as a refusal.
		const rows = fixture.interiorGrounding.braceSlots;
		expect(rows.length).toBe(222);
		const device = rows
			.filter((row) => row.outcome === "array")
			.map((row) => `${row.verb} ${row.slot}`)
			.sort();
		expect(braceArraySlotPairs()).toEqual(device);
		// The same name is an array on one verb and a code block on another, which
		// is why a bare name set cannot express this.
		expect(device).toContain("foreach in");
		expect(rows).toContainEqual({
			verb: "onerror",
			slot: "in",
			outcome: "code",
		});
	});

	test("a brace is read as an array only in a slot the device proved", () => {
		const claimsArray = (input: string) =>
			explainCommand(input).values.occurrences.some((value) =>
				value.facts.shapeHints?.values?.includes("array"),
			);
		// Accepted: the seven verbs that carry every brace array in the corpus,
		// plus a named slot the old `in`-only rule refused.
		for (const input of [
			":local z {1;2}",
			":global g {1;2}",
			":set g {1;2}",
			":put {1;2}",
			":len {1;2}",
			":return {1;2}",
			":foreach i in={1;2} do={:put 1}",
			":for i from={1;2} to=2 do={:put 1}",
		])
			expect({ input, array: claimsArray(input) }).toEqual({
				input,
				array: true,
			});
		// A differently-cased directive is NOT the same verb. RouterOS accepts only
		// the lower-case spelling — `:LOCAL z {1;2}` draws `expected command name`
		// on 7.23.3 — so matching the verb verbatim gives the device's answer,
		// while normalizing it would open the gate on a statement that does not
		// parse. An argument's casing is free (`:local Z {1;2}` binds `$Z`).
		for (const input of [":LOCAL z {1;2}", ":Local z {1;2}", ":PUT {1;2}"])
			expect({ input, array: claimsArray(input) }).toEqual({
				input,
				array: false,
			});
		expect(claimsArray(":local Z {1;2}")).toBe(true);
		// Rejected by the device, and formerly called arrays by the path rule:
		// a scalar-typed slot, the NAME positional, a condition, a code block,
		// and a command argument.
		for (const input of [
			":delay {1;2}",
			":beep {1;2}",
			":resolve {1;2}",
			":local {1;2}",
			":local name={1;2}",
			":if condition={1;2}",
			":while condition={1;2}",
			":onerror e in={1;2} do={}",
			":retry command={1;2}",
			// Accepted by the device, but as script TEXT rather than an array:
			// `:execute script={(1,2)}` lowers to `script=(1,2)`, not `(, 1 2)`.
			":execute {1;2}",
			":execute script={1;2}",
			":grep script={1;2}",
			":log info message={1;2}",
			"/ip/dns/set servers={1.1.1.1;8.8.8.8}",
		])
			expect({ input, array: claimsArray(input) }).toEqual({
				input,
				array: false,
			});
	});

	test("a literal the device rejects never keeps its array shape", () => {
		// The falsifier for the nested case, scored one-sided: a literal `:parse`
		// rejects must not come back as a COMPLETE reading that calls those bytes
		// an array. Abstaining early is always allowed; naming a shape on a
		// statement the device refuses to parse is not. Eight rows here — the
		// nested empty-group and empty-comma-member family — were fabrications
		// before the container-withdrawal fix.
		const rejected = fixture.interiorGrounding.nestedLiterals.filter(
			(row) => !row.parses,
		);
		expect(rejected.length).toBeGreaterThan(8);
		for (const row of rejected) {
			const input = `:local z ${row.literal}`;
			const reading = lexValueAnchors(input, ":local".length, {
				directiveVerb: "local",
			});
			const claimed =
				reading.complete &&
				reading.anchors.some(
					(anchor) =>
						anchor.sourceShape === "array" &&
						anchor.valueSpan.start === input.indexOf(row.literal),
				);
			expect({ literal: row.literal, claimed }).toEqual({
				literal: row.literal,
				claimed: false,
			});
		}
	});

	test("the literals the device accepts are still read", () => {
		// A coverage anchor, not a contract: abstention stays legal, but a drop
		// here means the withdrawal rule got wider than the device is and should
		// be a deliberate edit rather than a silent loss.
		const read = fixture.interiorGrounding.nestedLiterals
			.filter((row) => row.parses)
			.filter((row) => {
				const input = `:local z ${row.literal}`;
				const reading = lexValueAnchors(input, ":local".length, {
					directiveVerb: "local",
				});
				return (
					reading.complete &&
					reading.anchors.some((anchor) => anchor.sourceShape === "array")
				);
			});
		expect(read).toHaveLength(9);
	});

	test("member descent is bounded, and the bound withdraws rather than guesses", () => {
		// Eight frames are read; deeper than that the interior is unverified, and
		// an unverified interior can hold a fault that makes the whole statement a
		// syntax error — `:parse` rejects `{{…{(1,)}…}}` at depth 9 exactly as at
		// depth 1. So the bound withdraws instead of keeping the shape.
		const at = (depth: number, body: string) =>
			`:local z ${"{".repeat(depth)}${body}${"}".repeat(depth)}`;
		const read = explainCommand(at(8, "1")).values.occurrences;
		expect(read[1]?.facts.shapeHints?.values).toEqual(["array"]);
		expect(read.filter((value) => value.kind === "element")).toHaveLength(8);

		for (const depth of [9, 40])
			expect(
				explainCommand(at(depth, "1")).values.occurrences.some((value) =>
					value.facts.shapeHints?.values?.includes("array"),
				),
			).toBe(false);
		// The fabrication the bound used to allow: a device-rejected member below
		// it came back `array` and complete.
		expect(
			lexValueAnchors(at(9, "(1,)"), ":local".length, {
				directiveVerb: "local",
			}),
		).toMatchObject({
			complete: false,
			why: "an array literal nested deeper than this phase reads",
		});
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
		// `list=(1,2)` rather than `list={1;2}`: a brace array is a device syntax
		// error in a command argument, while the paren spelling parses there.
		const data = explainCommand(
			"/ip/firewall/filter/add count=123 to-addresses=1.1.1.1 src-address=10.9.0.0/16 dst-address=1::1 comment=plain disabled=yes interval=200ms ip6-prefix=2008:1::2/128 id=*A mac-address=00:11:22:33:44:55 list=(1,2) ?name",
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
			"num",
			"num",
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
