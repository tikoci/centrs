/**
 * The pure halves of the #255 operator grounding tools.
 *
 * `scripts/probes/AGENTS.md` says a probe is not a test and asserts nothing —
 * and these do not test the probe's device work. They cover the helpers that
 * decide what a device answer MEANS, in the probe and in the slice that derives
 * the published numbers from it, because a bug in any of them turns a capture
 * into a wrong table quietly. `verdictOf` in particular is the piece whose
 * first version scored `not` as an operator; the sweep's own control caught it,
 * and this is the cheaper guard.
 *
 * The committed fixture cannot stand in for these: it can only fail on a shape
 * the sweep happened to produce, and every case below is a shape the device
 * could produce tomorrow.
 *
 * The probe module gates its device work behind `import.meta.main`, which is
 * what makes importing it here possible without booting a CHR.
 */
import { describe, expect, test } from "bun:test";
import {
	candidates,
	headShape,
	readIlTree,
} from "../../scripts/explain-operator-census.ts";
import {
	associativityOf,
	buildSweep,
	outerCounts,
	precedenceLevels,
	unarySummary,
	whyNot,
	whyNotExample,
} from "../../scripts/explain-operator-slice.ts";
import {
	coalesce,
	quoteForParse,
	splitMarkers,
	verdictOf,
} from "../../scripts/probes/explain-operator-sweep.ts";

/** A carrier result, with only the fields `verdictOf` reads. */
const carrier = (over: {
	accepted?: boolean;
	ilHead?: string | null;
	ilArity?: number | null;
	residualVariable?: boolean;
}) => ({
	source: "",
	deviceSource: "",
	il: "",
	accepted: true,
	ilHead: null,
	ilArity: null,
	juxtaposition: false,
	residualVariable: false,
	...over,
});

describe("verdictOf", () => {
	test("a node headed by the spelling is an operator", () => {
		expect(
			verdictOf("+", [carrier({ ilHead: "+", ilArity: 2 })]),
		).toMatchObject({ verdict: "operator", arities: [2], heads: ["+"] });
	});

	test("the unnamed juxtaposition node is NOT an operator", () => {
		// The defect the `(1 zzz 2)` control found on the first run: `(1 not 2)`
		// parses and produces a node, so "accepted && a node exists" scored eleven
		// non-operators as operators.
		expect(
			verdictOf("not", [carrier({ ilHead: "", ilArity: 3 })]).verdict,
		).toBe("not-an-operator");
	});

	test("a head reached by inventing a variable is NOT an operator", () => {
		// `(1 .. 2)` is `(  (. 1 $.) 2)`. There IS a `.` node, and crediting `..`
		// with it would put a range operator in the table that RouterOS does not
		// have.
		expect(
			verdictOf("..", [
				carrier({ ilHead: ".", ilArity: 2, residualVariable: true }),
			]).verdict,
		).toBe("not-an-operator");
	});

	test("a different, honestly-reached head is `lowered`, not an operator", () => {
		const scored = verdictOf("&&", [carrier({ ilHead: "and", ilArity: 2 })]);
		expect(scored.verdict).toBe("lowered");
		expect(scored.arities).toEqual([]);
		expect(scored.heads).toEqual(["and"]);
	});

	test("arity comes from the DEVICE, not from the carrier's shape", () => {
		// `(> 1)` is written as a prefix carrier but the device reports arity 1 on
		// a node it built itself; taking the carrier's nominal arity would make
		// the table describe the probe rather than RouterOS.
		expect(
			verdictOf(">", [
				carrier({ ilHead: ">", ilArity: 1 }),
				carrier({ ilHead: ">", ilArity: 2 }),
			]).arities,
		).toEqual([1, 2]);
	});

	test("a rejected carrier contributes nothing", () => {
		expect(verdictOf("?", [carrier({ accepted: false })]).verdict).toBe(
			"not-an-operator",
		);
	});

	test("a head match with no reported arity does not promote a spelling", () => {
		// `arities` only grows when the device reported one, so a carrier the IL
		// reader could not measure leaves the spelling out rather than
		// entering the table at an arity nobody observed. Arity is the whole
		// discriminator between `(> x)` and `(2 > 1)`; a row without one would
		// be a table entry with no measurement behind it.
		const scored = verdictOf(">", [carrier({ ilHead: ">", ilArity: null })]);
		expect(scored.verdict).toBe("not-an-operator");
		expect(scored.arities).toEqual([]);
	});
});

describe("splitMarkers", () => {
	test("splits a batched run into one result per probe", () => {
		expect(
			splitMarkers(
				"#P0#\n(<%% (+ 1 2) )\n#P1#\nsyntax error (line 1 column 2)\n",
				2,
			),
		).toEqual(["(<%% (+ 1 2) )", "syntax error (line 1 column 2)"]);
	});

	test("a missing marker leaves a null rather than shifting the rest", () => {
		// This is what makes the batch safe: an incomplete chunk is detectable, so
		// the probe re-runs it one at a time instead of attributing probe 1's IL
		// to probe 0.
		expect(splitMarkers("#P0#\n(a)\n", 2)).toEqual(["(a)", null]);
		expect(splitMarkers("garbage\n", 2)).toEqual([null, null]);
	});

	test("a marker beyond the expected count is dropped, not written out of range", () => {
		expect(splitMarkers("#P0#\nx\n#P9#\ny\n", 1)).toEqual(["x"]);
	});
});

describe("quoteForParse", () => {
	test("`$` is delivered as the device-grounded `\\$` escape", () => {
		// Without this the console substitutes before `:parse` sees the program,
		// and the row silently describes a different one (#269).
		expect(quoteForParse("(1 + $x)")).toBe("(1 + \\$x)");
	});

	test("quotes and backslashes are escaped", () => {
		expect(quoteForParse('("a" . "b")')).toBe('(\\"a\\" . \\"b\\")');
		expect(quoteForParse("a\\b")).toBe("a\\\\b");
	});

	test("a multi-line program is refused rather than escaped", () => {
		// A `(line N column M)` diagnostic from a multi-line probe would be an
		// offset the row has no way to explain.
		expect(() => quoteForParse("a\nb")).toThrow("multi-line");
	});
});

describe("coalesce", () => {
	test("merges adjacent same-class bytes into one run", () => {
		// The evidence for the whole "`highlight` cannot give an operator
		// boundary" finding: the operator and the spaces around it arrive as one
		// token.
		const input = ":put (1 != 2)";
		const classes = input
			.split("")
			.map((c, i) =>
				i < 5 ? "cmd" : /[0-9]/.test(c) ? "none" : "syntax-meta",
			);
		const runs = coalesce(input, classes);
		expect(runs.map((run) => run.text)).toEqual([
			":put ",
			"(",
			"1",
			" != ",
			"2",
			")",
		]);
		expect(runs[3]?.class).toBe("syntax-meta");
	});

	test("a byte with no class is `(none)` rather than dropped", () => {
		expect(coalesce("ab", ["x"])).toEqual([
			{ text: "a", class: "x", start: 0, end: 1 },
			{ text: "b", class: "(none)", start: 1, end: 2 },
		]);
	});
});

describe("readIlTree", () => {
	test("reads nesting and arity", () => {
		const tree = readIlTree("(<%% (+ 1 (* 2 3)) )");
		expect(tree.balanced).toBe(true);
		const root = tree.roots[0];
		expect(root?.head).toBe("<%%");
		expect(root?.children).toHaveLength(1);
	});

	test("the unnamed node reads as an empty head", () => {
		expect(readIlTree("(  1 $zzz 2)").roots[0]).toEqual({
			head: "",
			children: ["1", "$zzz", "2"],
		});
	});

	test("unbalanced input is reported, not thrown", () => {
		// IL carries raw string content including stray parens, so one malformed
		// capture must not take the census down.
		expect(readIlTree("(a").balanced).toBe(false);
		expect(readIlTree("a)").balanced).toBe(false);
	});
});

describe("headShape and the candidate filter", () => {
	test("shapes separate real candidates from string noise", () => {
		expect(headShape("+")).toBe("punctuation");
		expect(headShape("<%%")).toBe("punctuation");
		expect(headShape("and")).toBe("word");
		// IL does not quote strings, so regex and prose fragments land in head
		// position. They are reported, never promoted.
		expect(headShape("2[0-4]|[01]")).toBe("other");
		expect(headShape("e.g.")).toBe("other");
	});

	test("`other` heads never reach the sweep's candidate list", () => {
		const census = {
			headOccurrences: { "+": 10, "e.g.": 10, rare: 10 },
			headScripts: { "+": 9, "e.g.": 9, rare: 1 },
			headShapes: { "+": "punctuation", "e.g.": "other", rare: "word" },
		} as unknown as Parameters<typeof candidates>[0];
		// `rare` is filtered by the distinct-script floor, not by its shape:
		// frequency is a prior, and one script is one author's string.
		expect(candidates(census)).toEqual(["+"]);
	});
});

/**
 * The slice's derivation helpers.
 *
 * These turn a capture into the numbers the README prints. They are as
 * load-bearing as `verdictOf` and were previously covered only through the
 * committed fixture — which cannot fail on a shape the sweep did not happen to
 * produce. Each case below is a shape the device could produce tomorrow.
 */
const pair = (
	a: string,
	b: string,
	outerHead: string | null,
	il = "",
	accepted = true,
) => ({ a, b, il, accepted, outerHead });

describe("outerCounts", () => {
	test("credits the outer spelling and counts both as seen", () => {
		const counts = outerCounts([pair("+", "*", "+"), pair("*", "+", "+")]);
		expect(counts.outer.get("+")).toBe(2);
		expect(counts.seen.get("*")).toBe(2);
		expect(counts.dropped).toBe(0);
	});

	test("a self-pair and a rejected pair are not counted", () => {
		// `(1 A 2 A 3)` is the ASSOCIATIVITY probe; counting it would credit
		// every operator once against itself and shift every level.
		const counts = outerCounts([
			pair("+", "+", "+"),
			pair("+", "*", "+", "", false),
		]);
		expect(counts.outer.size).toBe(0);
		expect(counts.seen.size).toBe(0);
	});

	test("an outer head that is neither side is dropped, never guessed", () => {
		// `(1 .. 2 + 3)` can re-lex into something headed by neither spelling.
		// Charging it to one of them is how a precedence table gets invented.
		const counts = outerCounts([pair("+", "*", "and")]);
		expect(counts.dropped).toBe(1);
		expect(counts.outer.size).toBe(0);
	});
});

describe("precedenceLevels", () => {
	test("equal counts are one level and conform", () => {
		// Three spellings, `a` loosest: with 2 tighter it must be outer 2*2+0=4;
		// `b` and `c` tie at one level, each outer 2*0+1=1.
		const counts = {
			outer: new Map([
				["a", 4],
				["b", 1],
				["c", 1],
			]),
			seen: new Map([
				["a", 4],
				["b", 4],
				["c", 4],
			]),
		};
		const { levels, nonConforming } = precedenceLevels(counts);
		expect(levels.get("a")).toBe(1);
		expect(levels.get("b")).toBe(2);
		expect(levels.get("c")).toBe(2);
		expect(nonConforming).toEqual([]);
	});

	test("a count that is not a strict weak order is REPORTED, not rounded", () => {
		// The gate that makes the levels a measurement rather than a ranking:
		// a device whose precedence is not a strict weak order is a finding.
		const counts = {
			outer: new Map([
				["a", 3],
				["b", 1],
			]),
			seen: new Map([
				["a", 2],
				["b", 2],
			]),
		};
		const { levels, nonConforming } = precedenceLevels(counts);
		expect(levels.get("a")).toBe(1);
		expect(nonConforming).toHaveLength(2);
		expect(nonConforming[0]).toContain("strict weak order wants");
	});

	test("a spelling never outer still gets the tightest level", () => {
		const { levels } = precedenceLevels({
			outer: new Map([["a", 2]]),
			seen: new Map([
				["a", 2],
				["b", 2],
			]),
		});
		expect(levels.get("a")).toBe(1);
		expect(levels.get("b")).toBe(2);
	});
});

describe("associativityOf", () => {
	const self = (token: string, il: string) => [pair(token, token, null, il)];

	test("the device flattening three operands is `variadic`", () => {
		expect(associativityOf("+", self("+", "(<%% (+ 1 2 3) )"))).toBe(
			"variadic",
		);
	});

	test("left and right nesting are distinguished", () => {
		expect(associativityOf("-", self("-", "(<%% (- (- 1 2) 3) )"))).toBe(
			"left",
		);
		expect(associativityOf("<<", self("<<", "(<%% (<< 1 (<< 2 3)) )"))).toBe(
			"right",
		);
	});

	test("no self-pair, or a rejected one, is `null` rather than a guess", () => {
		expect(associativityOf("!", [])).toBeNull();
		expect(
			associativityOf("+", [pair("+", "+", null, "(<%% (+ 1 2 3) )", false)]),
		).toBeNull();
	});
});

describe("whyNot and its example", () => {
	const row = (carriers: Record<string, Record<string, unknown>>) =>
		({
			token: "t",
			carriers: Object.fromEntries(
				Object.entries(carriers).map(([id, over]) => [
					id,
					{
						source: "",
						il: "",
						accepted: true,
						ilHead: null,
						ilArity: null,
						juxtaposition: false,
						residualVariable: false,
						...over,
					},
				]),
			),
		}) as unknown as Parameters<typeof whyNot>[0];

	test("every carrier refused is `rejected`", () => {
		expect(whyNot(row({ a: { accepted: false, il: "syntax error" } }))).toBe(
			"rejected",
		);
	});

	test("a residual variable outranks juxtaposition", () => {
		// `..` is both — accepted inside the unnamed node AND only by lexing `.`
		// as `$.`. The lexing is the more specific fact and the one that keeps a
		// range operator out of the table.
		expect(
			whyNot(
				row({ a: { juxtaposition: true }, b: { residualVariable: true } }),
			),
		).toContain("residual-variable");
	});

	test("the example is the carrier that EARNS the verdict", () => {
		// The `evl` shape: first carrier is a syntax error, the verdict comes
		// from a later one. Publishing the first would show an example arguing
		// for a different verdict than the one printed beside it.
		expect(
			whyNotExample(
				row({
					binary: { accepted: false, il: "syntax error (line 1 column 7)" },
					tight: { residualVariable: true, il: "(<%% $1evl2 )" },
				}),
			),
		).toBe("(<%% $1evl2 )");
	});

	test("with nothing more specific, the first carrier is the example", () => {
		expect(whyNotExample(row({ a: { il: "(<%% x )" } }))).toBe("(<%% x )");
	});
});

describe("unarySummary", () => {
	const u = (
		spelling: string,
		b: string,
		order: string,
		outerHead: string | null,
		accepted = true,
	) => ({ u: spelling, b, order, il: "", accepted, outerHead });

	test("counts the probes where the BINARY was outer", () => {
		// Binary outer means the unary bound tighter. Counters, not a verdict:
		// the fixture publishes the numbers and the table's prose reads them.
		const [row] = unarySummary([
			u("!", "+", "prefix-left", "+"),
			u("!", "+", "prefix-right", "+"),
		]);
		expect(row).toMatchObject({
			spelling: "!",
			probes: 2,
			accepted: 2,
			binaryOuter: 2,
			exceptions: [],
		});
	});

	test("a probe where the unary was outer is an EXCEPTION, not a rounding", () => {
		// The load-bearing case. If some binary ever bound tighter than `!`, the
		// lattice this table describes would be wrong, and the row has to say so
		// rather than let a count absorb it.
		const [row] = unarySummary([
			u("!", "+", "prefix-left", "+"),
			u("!", "->", "prefix-left", "!"),
		]);
		expect(row?.["binaryOuter"]).toBe(1);
		expect(row?.["exceptions"]).toEqual([
			{ binary: "->", order: "prefix-left", outerHead: "!", il: "" },
		]);
	});

	test("a rejected probe is not counted as agreement", () => {
		const [row] = unarySummary([u("any", "+", "prefix-left", null, false)]);
		expect(row).toMatchObject({ probes: 1, accepted: 0, binaryOuter: 0 });
	});
});

describe("buildSweep version differences", () => {
	/** A capture with just enough shape for `buildSweep` to run. */
	const capture = (
		version: string,
		over: Record<string, unknown> = {},
	): Parameters<typeof buildSweep>[0][number] =>
		({
			version,
			architecture: "x86_64",
			buildTime: "",
			candidates: [],
			precedence: [],
			unaryPrecedence: [],
			controls: [
				{
					id: "bogus-word",
					source: "(1 zzz 2)",
					il: "(<%% (  1 $zzz 2) )",
					accepted: true,
				},
			],
			opAxis: [],
			runtime: [],
			...over,
		}) as unknown as Parameters<typeof buildSweep>[0][number];

	const differences = (
		...captures: Parameters<typeof buildSweep>[0]
	): Record<string, unknown>[] =>
		buildSweep(captures)["versionDifferences"] as Record<string, unknown>[];

	test("identical captures produce no differences", () => {
		expect(differences(capture("a"), capture("b"))).toEqual([]);
	});

	test("a control that moved between versions is REPORTED", () => {
		// The controls calibrate the whole sweep, so a version where one moved
		// invalidates every other row taken from it. `(1 zzz 2)` is the
		// known-failing control: a build that rejected it would mean the harness
		// had been measuring something else, and that is the single difference
		// that must never be reported as "identical". It was published in the
		// fixture without being compared until CodeRabbit caught it on #287.
		const moved = differences(
			capture("a"),
			capture("b", {
				controls: [
					{
						id: "bogus-word",
						source: "(1 zzz 2)",
						il: "syntax error (line 1 column 4)",
						accepted: false,
					},
				],
			}),
		);
		expect(moved).toHaveLength(1);
		expect(moved[0]).toMatchObject({ kind: "control", id: "bogus-word" });
		expect(moved[0]?.["b"]).toEqual({
			il: "syntax error (line 1 column 4)",
			accepted: false,
		});
	});

	test("a control missing from a version is a difference, not a skip", () => {
		const missing = differences(capture("a"), capture("b", { controls: [] }));
		expect(missing).toHaveLength(1);
		expect(missing[0]?.["b"]).toBeNull();
	});
});
