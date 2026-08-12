/**
 * The pure halves of the #255 operator grounding tools.
 *
 * `scripts/probes/AGENTS.md` says a probe is not a test and asserts nothing —
 * and these do not test the probe's device work. They cover the four helpers
 * that decide what a device answer MEANS, because a bug in any of them turns a
 * capture into a wrong table quietly. `verdictOf` in particular is the piece
 * whose first version scored `not` as an operator; the sweep's own control
 * caught it, and this is the cheaper guard.
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
