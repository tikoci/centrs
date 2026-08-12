import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	ARRAY_COMPARISON_NOTE,
	isOperatorSpelling,
	loweredSpellings,
	MANUAL_OTHER_OPERATORS,
	nonOperatorRows,
	nonOperators,
	operatorFor,
	operatorRows,
	resolveSpelling,
	routerosOperators,
} from "../../src/explain/operators.ts";

interface SweepOperator {
	spelling: string;
	ilHead: string;
	arities: number[];
	precedence: number | null;
	associativity: string | null;
	outerCount: number | null;
	highlightClass: string | null;
	highlightRun: string | null;
	highlightRunIsTokenExactly: boolean;
}

interface OperatorFixture {
	corpus: {
		acceptedRows: number;
		rejectedRows: number;
		headOccurrences: Record<string, number>;
		headShapes: Record<string, string>;
		headVersions: Record<string, number>;
	};
	sweep: {
		_source: {
			versions: string[];
			precedenceNonConforming: string[];
			precedencePairsDropped: number;
		};
		operators: SweepOperator[];
		lowered: { spelling: string; ilHeads: string[]; example?: string }[];
		notOperators: {
			spelling: string;
			highlightClass: string | null;
			whyNot: string;
		}[];
		opAxis: {
			id: string;
			source: string;
			il: string;
			ilHead: string | null;
			ilArity: number | null;
			accepted: boolean;
		}[];
		runtime: { id: string; source: string; output: string }[];
		versionDifferences: Record<string, unknown>[];
	};
}

const fixture = JSON.parse(
	readFileSync("test/fixtures/explain/operators.json", "utf8"),
) as OperatorFixture;

const axis = (id: string) => {
	const row = fixture.sweep.opAxis.find((entry) => entry.id === id);
	if (row === undefined) throw new Error(`no op-axis row ${id}`);
	return row;
};

const runtime = (id: string) => {
	const row = fixture.sweep.runtime.find((entry) => entry.id === id);
	if (row === undefined) throw new Error(`no runtime row ${id}`);
	return row;
};

describe("operator table vs the device sweep", () => {
	// The whole point of the table: it must still be what the device said.
	// Compared as flat rows so a failure names the spelling that moved.
	test("every operator row matches the fixture", () => {
		expect(operatorRows()).toEqual(
			fixture.sweep.operators
				.map(
					(entry) =>
						`${entry.spelling} arities=${entry.arities.join(",")} ` +
						`precedence=${entry.precedence ?? "-"} assoc=${entry.associativity ?? "-"} ` +
						`hl=${entry.highlightClass}`,
				)
				.sort(),
		);
	});

	test("every non-operator row matches the fixture", () => {
		// The table's `reason` is the slice's derived category, renamed and
		// nothing more. Any judgement on top of it (`$` and `[` belong to the
		// substitution axis) lives in MANUAL_OTHER_OPERATORS, deliberately not
		// here, so a reader can tell measurement from reading.
		const expectedReason: Record<string, string> = {
			rejected: "rejected",
			"residual-variable: part of the spelling lexed as a $name":
				"reads-as-variable",
			"juxtaposition: accepted only inside the unnamed node":
				"juxtaposition-only",
		};
		expect(nonOperatorRows()).toEqual(
			fixture.sweep.notOperators
				.map(
					(entry) =>
						`${entry.spelling} ${expectedReason[entry.whyNot] ?? entry.whyNot} ` +
						`hl=${entry.highlightClass}`,
				)
				.sort(),
		);
	});

	test("the lowered spellings match the fixture", () => {
		expect(
			loweredSpellings()
				.map((entry) => entry.spelling)
				.sort(),
		).toEqual(fixture.sweep.lowered.map((entry) => entry.spelling).sort());
		for (const entry of loweredSpellings()) {
			const row = fixture.sweep.lowered.find(
				(candidate) => candidate.spelling === entry.spelling,
			);
			expect(row?.ilHeads).toEqual([...entry.ilHeads]);
			expect(row?.example).toBe(entry.example);
		}
	});

	test("the sweep covered both a stable and a testing build", () => {
		expect(fixture.sweep._source.versions).toEqual([
			"7.23.3 (stable) (x86_64)",
			"7.24rc4 (testing) (x86_64)",
		]);
	});
});

describe("the complement is grounded, not omitted", () => {
	// #252's lesson, as an assertion. A table that merely FAILS to list `not`
	// is not the same as one that scored it and recorded the rejection, and the
	// difference is invisible unless a test names it.
	test.each(["not", "..", "xor", "mod", "is", "div", "eq", "ne"])(
		"%s is recorded as a non-operator, not merely absent",
		(spelling) => {
			expect(isOperatorSpelling(spelling)).toBe(false);
			const row = nonOperators().find((entry) => entry.spelling === spelling);
			expect(row).toBeDefined();
			expect(row?.reason).toBe("reads-as-variable");
		},
	);

	test("a bare word inside parens is a variable reference on the device", () => {
		// The evidence behind `reads-as-variable`, and the reason the sweep's own
		// `(1 zzz 2)` control does not reject: RouterOS juxtaposes and substitutes.
		expect(axis("juxtaposition-word").accepted).toBe(true);
		expect(axis("juxtaposition-word").il).toContain("$zzz");
		expect(axis("juxtaposition").ilHead).toBe("");
	});

	test("the manual's `$`, `[`, `]` never head a node", () => {
		for (const spelling of MANUAL_OTHER_OPERATORS) {
			expect(isOperatorSpelling(spelling)).toBe(false);
			expect(nonOperators().some((entry) => entry.spelling === spelling)).toBe(
				true,
			);
		}
		// The positive evidence, which the carrier verdicts do not carry: `$x`
		// stays an ATOM under `+`, and `[…]` lowers to an `evl` node named after
		// the command rather than to a node named `[`.
		expect(axis("substitution").il).toBe("(<%% (+ 1 $x) )");
		expect(axis("bracket-substitution").ilHead).toBeNull();
		expect(axis("bracket-substitution").il).toContain("(evl ");
	});
});

describe("the `>` arity split", () => {
	// The reason a table keyed on spelling alone is wrong, and #255's own
	// question: the same byte is relational at arity 2 and the deferred
	// expression form at arity 1.
	test("`>` carries both arities", () => {
		expect(operatorFor(">")?.arities).toEqual([1, 2]);
	});

	test("arity 1 is the deferred form and arity 2 is the comparison", () => {
		expect(axis("defer-scalar").ilHead).toBe(">");
		expect(axis("defer-scalar").ilArity).toBe(1);
		expect(axis("relational").ilHead).toBe(">");
		expect(axis("relational").ilArity).toBe(2);
	});

	test("a deferred command body has runtime type `op`", () => {
		expect(runtime("typeof-deferred").output).toBe("op");
	});

	test("a deferred ARRAY is not an op — it is an array", () => {
		// `(>{"a"=1})` parses with head `>` exactly like `(>[:put 1])`, so IL
		// alone would say both are the same thing. They are not, and only the
		// runtime oracle can say so.
		expect(axis("defer-array").ilHead).toBe(">");
		expect(runtime("deferred-array-typeof").output).toBe("array");
	});

	test("`(>)` with no operand is a syntax error", () => {
		expect(axis("defer-bare").accepted).toBe(false);
	});
});

describe("`<%%` apply", () => {
	test("it is a binary, right-associative operator", () => {
		const apply = operatorFor("<%%");
		expect(apply?.arities).toEqual([2]);
		expect(apply?.associativity).toBe("right");
		expect(apply?.category).toBe("apply");
	});

	test("positionals bind from $0, unlike a do= function", () => {
		// Under apply, `{7;8}` binds $0=7 and $1=8. Under `do={…}` the same two
		// arguments bind $1 and $2, because $0 is the function's own name. Rule
		// S6 in `symbols.ts` classes `$0` as a parameter either way, but anything
		// that reports WHICH argument a positional refers to has to know these
		// disagree.
		expect(runtime("apply-positional-zero").output).toBe("7|8|");
		expect(runtime("do-block-positional-zero").output).toBe("$f255|7|8");
	});

	test("named arguments work through apply", () => {
		expect(runtime("apply-named-arg").output).toBe("5");
	});
});

describe("spelling resolution", () => {
	test("`&&` and `||` resolve to the operators they lower to", () => {
		expect(resolveSpelling("&&")?.spelling).toBe("and");
		expect(resolveSpelling("||")?.spelling).toBe("or");
		expect(isOperatorSpelling("&&")).toBe(false);
	});

	test("`<>` resolves to nothing because it is two operators", () => {
		// `(1 <> 2)` is `(< 1 (> 2))` — `<` applied to a DEFERRED 2. Returning
		// `!=` here, which is what a docs-derived alias table would do, would
		// misreport what the program computes.
		expect(resolveSpelling("<>")).toBeUndefined();
		expect(
			fixture.sweep.lowered.find((entry) => entry.spelling === "<>")?.example,
		).toBe("(<%% (< 1 (> 2)) )");
	});
});

describe("precedence and associativity", () => {
	test("the measured levels form a strict weak order", () => {
		// Not decoration: the levels are READ OFF the outer-counts, so if the
		// counts stop fitting `2*(tighter) + (same level)` the levels are a
		// fiction. The slice records any row that does not fit.
		expect(fixture.sweep._source.precedenceNonConforming).toEqual([]);
		expect(fixture.sweep._source.precedencePairsDropped).toBe(0);
	});

	test("`,` binds loosest and `->` binds tightest", () => {
		expect(operatorFor(",")?.precedence).toBe(1);
		expect(operatorFor("->")?.precedence).toBe(14);
	});

	test("prefix-only operators carry no measured precedence", () => {
		for (const spelling of ["!", "any"]) {
			expect(operatorFor(spelling)?.precedence).toBeNull();
			expect(operatorFor(spelling)?.associativity).toBeNull();
		}
	});

	test("variadic is a real third answer, not a missing one", () => {
		// The device FLATTENS these: `(1 + 2 + 3)` is one node with three
		// children, so a consumer building a binary tree builds a shape RouterOS
		// never produces.
		expect(operatorFor("+")?.associativity).toBe("variadic");
		expect(operatorFor("-")?.associativity).toBe("left");
		expect(operatorFor("<<")?.associativity).toBe("right");
	});
});

describe("what the device does that the manual does not say", () => {
	test("`any` is an operator and is not in the manual's list", () => {
		expect(operatorFor("any")?.arities).toEqual([1]);
	});

	test("`any` is a nil-check: false only for nil/nothing", () => {
		// Grounded on 7.23.3 + 7.24rc4 (and 7.21.5 long-term, corpus 7.20.8):
		// `any` is prefix arity 1, `:typeof (any x)` is always `bool`. It is
		// the idiom `:if (any $x) ...` to test a `:local` that may be `nil`.
		expect(runtime("any-undefined-var").output).toBe("false");
		expect(runtime("any-defined-var").output).toBe("true");
		expect(runtime("any-nothing").output).toBe("false");
		expect(runtime("any-true").output).toBe("true");
		expect(runtime("any-false").output).toBe("true");
		// `any` composes with the logical binaries without extra parens
		expect(runtime("any-and-nothing").output).toBe("false");
		expect(runtime("any-or-nothing").output).toBe("true");
		// Infix `any` is not an infix at all — space-separated `true any false`
		// is the unnamed juxtaposition node `(  true (any false))`, while
		// `1 . any [:nothing]` is concat `1` + `false`.
		expect(runtime("any-juxt").output).toBe("true");
		expect(runtime("any-concat").output).toBe("1false");
	});

	test("`any` has been an operator since at least 7.20.8", () => {
		// Offline corroboration: the corpus IL census (7.20.8, 7.22.1, 7.23rc1)
		// already saw head `any` with `any|7.20.8:2`.
		expect(fixture.corpus.headOccurrences["any"]).toBe(6);
		expect(fixture.corpus.headVersions["any|7.20.8"]).toBe(2);
		// Live: 7.21.5 long-term still answers `any`.
		expect(runtime("any-nothing").output).toBe("false");
	});

	test("spacing changes the LEXER, not just the parse", () => {
		// `(1.2)` is an IP literal and `(.1)` is a time literal — neither is a
		// concatenation. Any tokenizer that matches `.` as an operator without
		// looking at the tokens beside it gets both wrong.
		expect(axis("tight-dot-ip").il).toBe("(<%% 1.0.0.2 )");
		expect(axis("tight-dot-time").il).toBe("(<%% 00:00:00.100 )");
	});

	test("only one fact in the sweep is version-dependent", () => {
		expect(fixture.sweep.versionDifferences).toHaveLength(1);
		expect(fixture.sweep.versionDifferences[0]?.["id"]).toBe("array-compare");
		expect(ARRAY_COMPARISON_NOTE).toContain("7.24rc4");
	});
});

describe("the corpus census that generated the candidates", () => {
	test("`not` never appears as an IL head in 948 corpus scripts", () => {
		// Corroboration, not proof: the corpus can only falsify. But a spelling
		// the device never emits as a head in 1,710 accepted parses is not one it
		// has an operator for.
		expect(fixture.corpus.headOccurrences["not"]).toBeUndefined();
	});

	test("every operator in the table that the corpus saw is a punctuation or word head", () => {
		for (const entry of routerosOperators()) {
			const shape = fixture.corpus.headShapes[entry.ilHead];
			if (shape === undefined) continue;
			expect(["punctuation", "word"]).toContain(shape);
		}
	});
});
