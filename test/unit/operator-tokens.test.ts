/**
 * #290 B2 — operatorSpans traps.
 *
 * Every row in the table is a device-measured trap from #255 + #290.
 * Vocabulary is provisional: one `operator` class (ev e10), `<>` re-lexes to
 * two tokens, `&&`/`||` lower but get spans, and the scanner never claims a
 * byte that `spans[]` already holds.
 *
 * The fill runs on the residual only — fill order is structural, not lexical
 * (#290 design decision 1). Its three abstentions — `, / = -` outside `( )`,
 * bytes glued after an argument `=`, and bytes glued into an argument name —
 * are asserted here and via explainCommand. Each is grounded on the corpus
 * device oracle; see the `operator-tokens.ts` header for the IL evidence.
 */

import { describe, expect, test } from "bun:test";
import { analyzeCoordinates } from "../../src/explain/coordinates.ts";
import { operatorSpans } from "../../src/explain/operator-tokens.ts";
import { explainCommand, residualRanges } from "../../src/explain.ts";

function opsViaExplain(input: string): string[] {
	const data = explainCommand(input, { tokens: true });
	const analyzed = new TextDecoder().decode(analyzeCoordinates(input).analyzed);
	return (data.tokens ?? [])
		.filter((t) => t.class === "operator")
		.map((t) => analyzed.slice(t.start, t.end));
}

function opsDirect(
	analyzed: string,
	residual: { start: number; end: number }[],
): string[] {
	return operatorSpans(analyzed, residual).map((s) =>
		analyzed.slice(s.start, s.end),
	);
}

describe("#290 operator fill — direct residual scanner", () => {
	test("longest-match: <= before <, << before <, -> before -", () => {
		expect(opsDirect("a<=b", [{ start: 0, end: 4 }])).toEqual(["<="]);
		expect(opsDirect("a<<b", [{ start: 0, end: 4 }])).toEqual(["<<"]);
		expect(opsDirect("a->b", [{ start: 0, end: 4 }])).toEqual(["->"]);
		expect(opsDirect("a<%%b", [{ start: 0, end: 5 }])).toEqual(["<%%"]);
	});

	test("word-bounded: and/or/in/any only when not part of a word", () => {
		// Residual is whole input for these direct tests.
		expect(opsDirect("and", [{ start: 0, end: 3 }])).toEqual(["and"]);
		expect(opsDirect("xand", [{ start: 0, end: 4 }])).toEqual([]);
		expect(opsDirect("andx", [{ start: 0, end: 4 }])).toEqual([]);
		expect(opsDirect("a and b", [{ start: 0, end: 7 }])).toEqual(["and"]);
		// reads-as-variable spellings never emitted even though word-shaped
		expect(opsDirect("not", [{ start: 0, end: 3 }])).toEqual([]);
		expect(opsDirect("xor", [{ start: 0, end: 3 }])).toEqual([]);
	});

	test("respects residual — never claims a byte outside it", () => {
		// Simulate a prior fill claiming [1,3)
		expect(
			opsDirect("a+b", [
				{ start: 0, end: 1 },
				{ start: 3, end: 3 },
			]),
		).toEqual([]);
		expect(opsDirect("a+b", [{ start: 0, end: 3 }])).toEqual(["+"]);
	});

	test("skips quoted strings, no depth accounting inside", () => {
		expect(opsDirect('"a + b" + c', [{ start: 0, end: 10 }])).toEqual(["+"]);
	});

	test("dot traps: 1. variable, 1.2 IP, (.1) time, .. second dot", () => {
		// 1. variable — dot glued to left alnum and followed by space
		expect(opsDirect("(1. 2)", [{ start: 0, end: 6 }])).toEqual([]);
		// IP literal tight digit.digit
		expect(opsDirect("(1.2)", [{ start: 0, end: 5 }])).toEqual([]);
		// Time literal (.1)
		expect(opsDirect("(.1)", [{ start: 0, end: 4 }])).toEqual([]);
		// .. -> only first dot
		expect(opsDirect("a..b", [{ start: 0, end: 4 }])).toEqual(["."]);
		// Leading dot with space separation is operator
		expect(opsDirect("(1 .2)", [{ start: 0, end: 6 }])).toEqual(["."]);
		expect(opsDirect("(1 . 2)", [{ start: 0, end: 7 }])).toEqual(["."]);
	});

	test("slash trap: second byte of //", () => {
		expect(opsDirect("(a//b)", [{ start: 0, end: 6 }])).toEqual(["/"]);
		// Top-level slash is left for path fill — not claimed here.
		expect(opsDirect("a//b", [{ start: 0, end: 4 }])).toEqual([]);
	});

	test("expression conservatism: , / = - only directly inside ( )", () => {
		// residual is whole input; no opener so these are skipped
		expect(opsDirect("a,b", [{ start: 0, end: 3 }])).toEqual([]);
		expect(opsDirect("a/b", [{ start: 0, end: 3 }])).toEqual([]);
		expect(opsDirect("a=b", [{ start: 0, end: 3 }])).toEqual([]);
		expect(opsDirect("a-b", [{ start: 0, end: 3 }])).toEqual([]);
		// Inside parens
		expect(opsDirect("(a,b)", [{ start: 0, end: 5 }])).toEqual([","]);
		expect(opsDirect("(a/b)", [{ start: 0, end: 5 }])).toEqual(["/"]);
		expect(opsDirect("(a=b)", [{ start: 0, end: 5 }])).toEqual(["="]);
		expect(opsDirect("(a-b)", [{ start: 0, end: 5 }])).toEqual(["-"]);
		// -> is allowed with no opener at all
		expect(opsDirect("a->b", [{ start: 0, end: 4 }])).toEqual(["->"]);
	});

	test("`[` is command substitution, not an expression group", () => {
		// The IL for a bracketed command is `(evl /path/segments arg=value)` —
		// the `/` are path separators and the `=` an argument separator, with no
		// division and no comparison node. So `, / = -` abstain inside `[ ]`.
		expect(opsDirect("[a,b]", [{ start: 0, end: 5 }])).toEqual([]);
		expect(
			opsDirect("[/ip/route/find where x=1]", [{ start: 0, end: 25 }]),
		).toEqual([]);
		expect(
			opsDirect("[/interface/get $x default-name]", [{ start: 0, end: 32 }]),
		).toEqual([]);
		// A `(` nested inside `[ ]` restores expression context.
		expect(opsDirect("[f ($a/$b)]", [{ start: 0, end: 11 }])).toEqual(["/"]);
		// …and a `[ ]` nested inside `(` takes it away again.
		expect(
			opsDirect("(x . [/ip/route/print])", [{ start: 0, end: 23 }]),
		).toEqual(["."]);
		// `{` (block or array literal) is command context too.
		expect(
			opsDirect("do={/ip/route/add x=1}", [{ start: 0, end: 22 }]),
		).toEqual([]);
		// Non-ambiguous spellings are unaffected by the opener.
		expect(opsDirect("[$a->1]", [{ start: 0, end: 7 }])).toEqual(["->"]);
		expect(opsDirect("[find where a>1]", [{ start: 0, end: 16 }])).toEqual([
			">",
		]);
	});

	test("glued after `=` is an argument value, never an operator", () => {
		// `!LAN`, `*2`, `.1.3.6.1…` are value bytes on the device.
		expect(
			opsDirect("in-interface-list=!LAN", [{ start: 0, end: 22 }]),
		).toEqual([]);
		expect(opsDirect("(x=!y)", [{ start: 0, end: 6 }])).toEqual(["="]);
		expect(opsDirect("[find where .id=*2]", [{ start: 0, end: 19 }])).toEqual(
			[],
		);
		expect(opsDirect("oid=.1.3.6.1", [{ start: 0, end: 12 }])).toEqual([]);
		// A space breaks the glue — that is an ordinary operand position.
		expect(opsDirect("(a = -1)", [{ start: 0, end: 8 }])).toEqual(["=", "-"]);
	});

	test("glued into an argument name is a name byte", () => {
		// `:foreach x in=$list` is `/foreach counter=$x` in the IL — no `(in …)`.
		expect(opsDirect("in=$list", [{ start: 0, end: 8 }])).toEqual([]);
		expect(opsDirect("(a in $b)", [{ start: 0, end: 9 }])).toEqual(["in"]);
		// Dotted argument names stay one name: `.id=`, `configuration.ssid=`.
		expect(opsDirect("[find where .id=1]", [{ start: 0, end: 18 }])).toEqual(
			[],
		);
		expect(
			opsDirect("[find where configuration.ssid=$s]", [{ start: 0, end: 34 }]),
		).toEqual([]);
		expect(
			opsDirect("[set x security.authentication-types=wpa2]", [
				{ start: 0, end: 42 },
			]),
		).toEqual([]);
		// The dot abstains on its own merit — inside `( )` the `=` is still a
		// comparison, but the name-joining dot is not concatenation.
		expect(
			opsDirect("(configuration.ssid=$s)", [{ start: 0, end: 23 }]),
		).toEqual(["="]);
		// A dot NOT ending at an `=` is still concatenation.
		expect(opsDirect("(a . b)", [{ start: 0, end: 7 }])).toEqual(["."]);
		expect(opsDirect("(a .b)", [{ start: 0, end: 6 }])).toEqual(["."]);
	});

	test("lowered spellings: && and || as length-2 operators, <> as two tokens", () => {
		expect(opsDirect("a && b", [{ start: 0, end: 6 }])).toEqual(["&&"]);
		expect(opsDirect("a || b", [{ start: 0, end: 6 }])).toEqual(["||"]);
		expect(opsDirect("1<>2", [{ start: 0, end: 4 }])).toEqual(["<", ">"]);
	});
});

describe("#290 operator fill — via explainCommand (masking + depth)", () => {
	test.each([
		[":put (1+2)", ["+"]],
		[":put (1 .2)", ["."]],
		[":put (1. 2)", []],
		[":put (1.2)", []],
		[":put (.1)", []],
		[":put (a..b)", ["."]],
		[":put (a//b)", ["/"]],
		[":put (a && b)", ["&&"]],
		[":put (a || b)", ["||"]],
		[":put (1<>2)", ["<", ">"]],
		[":put (a and b)", ["and"]],
		[':put "a + b" + 1', ["+"]],
		["# comment + plus\n:put (1+2)", ["+"]],
		[":put (1,2)", [","]],
		[":put 1,2", []],
		[":put (1<=2)", ["<="]],
		[":put (1<<2)", ["<<"]],
		[":put (1->2)", ["->"]],
		[":put (1<%%2)", ["<%%"]],
		[":put (1 / 2)", ["/"]],
		[":put 1 / 2", []],
	])("%s → %j", (input, expected) => {
		expect(opsViaExplain(input as string)).toEqual(expected as string[]);
	});

	test("variable spans mask operators — $x + 1 claims $x bytes first", () => {
		// $x is a variable-local span — its bytes are not residual. The `$` byte
		// itself is operator-agnostic; the `x` byte is claimed by the symbol pass.
		const input = ":local x 1; :put ($x + 1)";
		const data = explainCommand(input, { tokens: true });
		const analyzed = new TextDecoder().decode(
			analyzeCoordinates(input).analyzed,
		);
		const tokens = data.tokens ?? [];
		const plus = tokens.filter((t) => analyzed.slice(t.start, t.end) === "+");
		expect(plus.length).toBe(1);
		expect(plus[0]?.class).toBe("operator");
		// The variable `x` at 19 is not an operator token.
		const varAt19 = tokens.find((t) => t.start === 19 && t.end === 20);
		expect(varAt19?.class).toBe("variable-local");
	});

	test("every operator token carries ev e10 and evidence cites it", () => {
		const data = explainCommand(":put (1+2*3)", { tokens: true });
		const ops = (data.tokens ?? []).filter((t) => t.class === "operator");
		expect(ops.length).toBe(2);
		for (const t of ops) expect(t.ev).toBe("e10");
		expect(data.evidence.some((e) => e.id === "e10")).toBe(true);
		// No operator → no e10
		const noOp = explainCommand("/ip address add address=1.1.1.1", {
			tokens: true,
		});
		expect(noOp.evidence.some((e) => e.id === "e10")).toBe(false);
	});

	test("residualRanges is the complement — used by fill order", () => {
		expect(residualRanges(5, [{ start: 1, end: 3 }])).toEqual([
			{ start: 0, end: 1 },
			{ start: 3, end: 5 },
		]);
	});
});
