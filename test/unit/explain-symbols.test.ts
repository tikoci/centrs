import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	analyzeCoordinates,
	byteToPosition,
} from "../../src/explain/coordinates.ts";
import {
	HIGHLIGHT_CLASS,
	resolveSymbols,
	type SymbolClass,
} from "../../src/explain/symbols.ts";
import * as centrs from "../../src/index.ts";

/**
 * Q13 symbol-scope anchor tests (phase 0.5, #185/#186).
 *
 * Promoted from the throwaway lab probe `.scratch/explain-lab-symbols.ts` (the
 * SUT) and its 22 constructed corners, scored against the device's own
 * per-occurrence highlight streams as oracle. The production module is
 * `src/explain/symbols.ts`.
 *
 * The ratified answer these tests pin is an ABSTENTION rule, so the strongest
 * assertions here are negative: the resolver never emits `undefined`, and it
 * never asserts a class for a bare word it cannot resolve. The naive rule from
 * the device's own documentation ("a bare identifier that resolves to nothing is
 * undefined") measured 2.5% precision — 39 false positives against 1 true
 * positive — which is why `cls: null` is a first-class outcome rather than a
 * failure.
 *
 * Fixture provenance: `test/fixtures/explain/symbols.json`. C1-C22 are the lab
 * corners verbatim, F1a-F2d are the branch anchors for the two behaviors
 * promoted beyond the lab SUT (device-verified on CHR 7.23.2 before freezing),
 * X1-X6 anchor surfaces the oracle cannot express.
 */

interface Case {
	id: string;
	class: string;
	name: string;
	input: string;
	expect: { name: string; cls: SymbolClass | null }[];
	rule: string;
	verified?: string;
	notes?: string[];
}

const fixtures: { cases: Case[] } = JSON.parse(
	readFileSync(
		new URL("../fixtures/explain/symbols.json", import.meta.url),
		"utf8",
	),
);

const observed = (input: string): { name: string; cls: SymbolClass | null }[] =>
	resolveSymbols(input).occurrences.map((o) => ({ name: o.name, cls: o.cls }));

describe("explain/symbols — frozen fixtures", () => {
	for (const c of fixtures.cases) {
		test(`${c.id} (${c.class}) — ${c.name}`, () => {
			expect(observed(c.input)).toEqual(c.expect);
			if (c.notes !== undefined)
				expect(resolveSymbols(c.input).notes).toEqual(c.notes);
		});
	}

	test("every fixture case is present and uniquely identified", () => {
		const ids = fixtures.cases.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.filter((id) => id.startsWith("C"))).toHaveLength(22);
		expect(ids.filter((id) => id.startsWith("F"))).toHaveLength(7);
		expect(ids.filter((id) => id.startsWith("H"))).toHaveLength(9);
		expect(ids.filter((id) => id.startsWith("E"))).toHaveLength(10);
	});

	test("no fixture is hand-asserted: every promoted-beyond anchor is device-verified", () => {
		for (const c of fixtures.cases.filter((c) =>
			c.class.includes("device-verified"),
		))
			expect(c.verified).toContain("CHR 7.23.2");
	});
});

describe("explain/symbols — pre-registered thresholds", () => {
	test("`undefined` is never emitted: the resolver abstains instead", () => {
		for (const c of fixtures.cases)
			for (const o of resolveSymbols(c.input).occurrences)
				expect(o.cls).not.toBe("undefined");
	});

	test("an unresolvable bare word abstains and says why, never asserts", () => {
		for (const input of [
			":if (someBareWord = 1) do={:put 1}",
			"/ip route print where dst-address=0.0.0.0/0",
			"/certificate print where (common-name or subject-alt-name)",
			"/interface print where running",
		]) {
			const bare = resolveSymbols(input).occurrences.filter((o) => !o.sigil);
			// non-vacuous: each input must actually produce an abstaining bare word,
			// so dropping the occurrences entirely cannot pass this test
			expect(bare.length).toBeGreaterThan(0);
			expect(
				bare.filter((o) => !o.declaration && o.cls === null).length,
			).toBeGreaterThan(0);
			for (const o of bare) {
				if (o.declaration) continue;
				if (o.cls !== null) continue;
				expect(o.note).toBeDefined();
			}
			expect(bare.some((o) => o.cls === "undefined")).toBe(false);
		}
	});

	test("an undeclared `$name` is `parameter`, never an error or an abstention", () => {
		const [occurrence] = resolveSymbols(":put $surelyUndeclared").occurrences;
		expect(occurrence?.cls).toBe("parameter");
		expect(occurrence?.sigil).toBe(true);
	});

	test("`:set` on an undeclared name abstains — a hard device error is not a class", () => {
		const [occurrence] = resolveSymbols(":set neverDeclared 1").occurrences;
		expect(occurrence?.cls).toBeNull();
		expect(occurrence?.note).toContain(":set");
	});
});

describe("explain/symbols — F2 closure scope", () => {
	test("a named-function body hides the enclosing local", () => {
		const r = resolveSymbols(":local outer 1\n:local fn do={ :put $outer }");
		expect(r.occurrences.map((o) => o.cls)).toEqual([
			"local",
			"local",
			"parameter",
		]);
	});

	test("a control-flow body shares the enclosing scope", () => {
		for (const body of [
			":local v 1\n:if (true) do={ :put $v }",
			":local v 1\n:while ($v < 2) do={ :put $v }",
			":local v 1\n:foreach i in={1} do={ :put $v }",
		]) {
			const refs = resolveSymbols(body).occurrences.filter(
				(o) => o.name === "v" && !o.declaration,
			);
			expect(refs.length).toBeGreaterThan(0);
			for (const o of refs) expect(o.cls).toBe("local");
		}
	});

	test("a global reads `global` only with an in-body re-import", () => {
		const withImport = resolveSymbols(
			":global G 1\n:global f do={ :global G\n :put $G }",
		);
		expect(withImport.occurrences.at(-1)?.cls).toBe("global");
		const without = resolveSymbols(":global G 1\n:global f do={ :put $G }");
		expect(without.occurrences.at(-1)?.cls).toBe("parameter");
	});

	test("a declaration inside the function body is visible there", () => {
		const r = resolveSymbols(
			":local outer 1\n:local fn do={ :local inner 2\n :put $inner }",
		);
		expect(r.occurrences.at(-1)?.cls).toBe("local");
	});

	test("the closure boundary applies to `auto` bindings too", () => {
		const r = resolveSymbols(
			":foreach i in={1;2} do={ :put $i }\n:local fn do={ :put $i }",
		);
		expect(r.occurrences.map((o) => o.cls)).toEqual([
			"auto",
			"auto",
			"local",
			"parameter",
		]);
	});

	test("a nested function body hides its parent function's locals", () => {
		const r = resolveSymbols(
			":local f do={ :local mid 1\n :local g do={ :put $mid } }",
		);
		expect(r.occurrences.at(-1)?.cls).toBe("parameter");
	});
});

describe("explain/symbols — sigil-optional heads and line continuations", () => {
	test("a declaration survives an escaped newline", () => {
		const r = resolveSymbols(":local \\\nfoo 1\n:put $foo");
		expect(r.occurrences.map((o) => o.cls)).toEqual(["local", "local"]);
	});

	test("an escaped newline before `do={` keeps the closure boundary", () => {
		const r = resolveSymbols(
			":local outer 1\n:local fn do=\\\n{ :put $outer }",
		);
		// the outer local must NOT leak into the function body
		expect(r.occurrences.at(-1)?.cls).toBe("parameter");
	});

	test("an immediate continuation comment preserves a pending declaration", () => {
		// #215, CHR 7.23.3: `# $ghost` is one comment line, `foo` is then still the
		// name the pending `:local` declares (`variable-local`), and so is `$foo`.
		expect(
			resolveSymbols(":local \\\n# $ghost\nfoo 1\n:put $foo").occurrences.map(
				(o) => [o.name, o.cls],
			),
		).toEqual([
			["foo", "local"],
			["foo", "local"],
		]);
		// Consecutive comment lines, and an indented CONTENT line after one, are
		// both still inside the statement.
		expect(
			resolveSymbols(
				":local \\\n# one\n# two\nfoo 1\n:put $foo",
			).occurrences.map((o) => [o.name, o.cls]),
		).toEqual([
			["foo", "local"],
			["foo", "local"],
		]);
		expect(
			resolveSymbols(":local \\\n# x\n   foo 1\n:put $foo").occurrences.map(
				(o) => [o.name, o.cls],
			),
		).toEqual([
			["foo", "local"],
			["foo", "local"],
		]);
	});

	test("a blank line after a continuation comment ends the declaration", () => {
		// The reach of the `\` run is spent by the comment line: the device classes
		// `foo` `obj-inactive` (a new statement's head) and the later `$foo` an
		// unresolved `variable-parameter`. Directly after the `\`, the same blank
		// line keeps the statement alive — both readings are pinned here.
		expect(
			resolveSymbols(
				":local \\\n# one\n# two\n   \nfoo 1\n:put $foo",
			).occurrences.map((o) => [o.name, o.cls]),
		).toEqual([["foo", "parameter"]]);
		expect(
			resolveSymbols(":local \\\n   \nfoo 1\n:put $foo").occurrences.map(
				(o) => [o.name, o.cls],
			),
		).toEqual([
			["foo", "local"],
			["foo", "local"],
		]);
	});

	test("a continuation does not move statement-leading position", () => {
		// device: `do={\<nl>:local x 1` still reads `:local` as the head and binds
		// `x` `variable-local` — with or without a comment line in between.
		for (const t of [
			":if (true) do={\\\n:local x 1\n:put $x\n}",
			":if (true) do={\\\n# c\n:local x 1\n:put $x\n}",
			"\\\n:local x 1\n:put $x",
			"\\\n# c\n:local x 1\n:put $x",
		]) {
			expect(resolveSymbols(t).occurrences.map((o) => [o.name, o.cls])).toEqual(
				[
					["x", "local"],
					["x", "local"],
				],
			);
		}
	});

	test("every scripting head binds with `:`, with `/`, and bare", () => {
		// the head word is written by the loop, so each spelling is a real input
		// rather than a substitution into one
		const heads: [string, SymbolClass][] = [
			["local foo 1\n:put $foo", "local"],
			["global foo 1\n:put $foo", "global"],
			["foreach i in={1} do={:put $i}", "auto"],
			["for i from=1 to=3 do={:put $i}", "auto"],
		];
		for (const [statement, expected] of heads)
			for (const sigil of [":", "/", ""]) {
				const r = resolveSymbols(`${sigil}${statement}`);
				expect(r.occurrences).toHaveLength(2);
				for (const o of r.occurrences) expect(o.cls).toBe(expected);
			}
	});

	test("an unresolved `set` target follows the spelling", () => {
		// bare `set` is the MENU verb: the device reports no variable at all
		expect(resolveSymbols("set foo 2").occurrences).toEqual([]);
		// `:set` / `/set` are the scripting command: a hard device error, so abstain
		for (const input of [":set foo 2", "/set foo 2"]) {
			const [occurrence] = resolveSymbols(input).occurrences;
			expect(occurrence?.cls).toBeNull();
			expect(occurrence?.note).toContain(":set");
		}
	});

	test("a head word is only a head at statement start", () => {
		for (const input of [
			"$fn local foo 1\n:put $foo",
			"[:len $x] local foo 1\n:put $foo",
			'"text" local foo 1\n:put $foo',
		]) {
			const r = resolveSymbols(input);
			expect(r.occurrences.some((o) => o.declaration)).toBe(false);
			expect(r.occurrences.at(-1)?.cls).toBe("parameter");
		}
	});

	test("a doubled sigil is not a scripting head", () => {
		for (const input of ["//local foo 1", "/:local foo 1", ":/local foo 1"])
			expect(resolveSymbols(input).occurrences.some((o) => o.declaration)).toBe(
				false,
			);
	});

	test("a deeper menu path is not a declaration", () => {
		for (const input of ["/ip/local foo 1", "/interface local foo 1"])
			expect(resolveSymbols(input).occurrences).toEqual([]);
	});
});

describe("explain/symbols — escape validity (F4)", () => {
	test("only whitespace and newline may follow a backslash in code", () => {
		for (const input of [
			":local v 1\n:put \\ $v",
			":local v 1\n:put \\\t$v",
			":local v 1 \\\n:put $v",
			":local v 1 \\\r\n:put $v",
		])
			expect(resolveSymbols(input).notes).toEqual([]);
	});

	test("a malformed escape stops the analysis and says where", () => {
		for (const input of [
			":local \\\\\nfoo 1\n:put $foo",
			":local v 1\n:put \\a $v",
			":local v 1\n:put \\$v",
		]) {
			const r = resolveSymbols(input);
			expect(r.notes.some((n) => n.startsWith("bad-escape:"))).toBe(true);
			// nothing is reported after the defect …
			expect(r.occurrences.some((o) => o.name === "foo")).toBe(false);
		}
	});

	test("occurrences BEFORE a malformed escape still stand (X1)", () => {
		const r = resolveSymbols(":local outer 1\n:local fn do=\\{ :put $outer }");
		expect(r.occurrences.map((o) => o.cls)).toEqual(["local", "local"]);
		expect(r.notes).toEqual(["bad-escape:28"]);
	});

	test("every valid escape is transparent to the `do=` lookback", () => {
		// the walker and the closure test must accept the same escapes, or a body
		// silently stops being a closure
		for (const separator of ["\\ ", "\\\t", "\\\n", " "]) {
			const r = resolveSymbols(
				`:local outer 1\n:local fn do=${separator}{ :put $outer }`,
			);
			expect(r.notes).toEqual([]);
			expect(r.occurrences.at(-1)?.cls).toBe("parameter");
		}
	});

	test("a lone escaped carriage return is whitespace, not a defect", () => {
		const r = resolveSymbols(":local v 1\n:put \\\r$v");
		expect(r.notes).toEqual([]);
		expect(r.occurrences.map((o) => o.cls)).toEqual(["local", "local"]);
	});

	test("a malformed escape cannot fabricate a closure", () => {
		// `do=\{` is not `do={`: the body is never entered, so no reference in it
		// can be reported at all — let alone with a confident class
		const r = resolveSymbols(":local outer 1\n:local fn do=\\{ :put $outer }");
		expect(r.occurrences).toHaveLength(2);
	});

	test("an escape inside a string is unaffected", () => {
		const r = resolveSymbols(':local a "x\\\\"\n:put $a');
		expect(r.notes).toEqual([]);
		expect(r.occurrences.map((o) => o.cls)).toEqual(["local", "local"]);
	});
});

describe("explain/symbols — F1 substitutions inside strings", () => {
	test("a nested string inside `$[…]` does not flip the scan's quote phase", () => {
		const r = resolveSymbols(
			':local cs ""\n:set cs "$cs$[[:parse "(\\"x\\")"]]"\n:local pos 0\n:put $pos',
		);
		expect(r.occurrences.at(-1)?.cls).toBe("local");
		expect(r.notes).toEqual([]);
	});

	test("a `#` line after such a substitution is still a comment", () => {
		const r = resolveSymbols(
			':local a "$[[:parse "(\\"x\\")"]]"\n# :put $a\n:put $a',
		);
		expect(r.occurrences).toHaveLength(2);
		expect(r.occurrences.at(-1)?.start).toBeGreaterThan(30);
	});

	test("a reference inside a substitution inside a string resolves", () => {
		const r = resolveSymbols(':local v 1\n:put "value $[:tostr $v]"');
		expect(r.occurrences.map((o) => o.cls)).toEqual(["local", "local"]);
	});

	test("`$(…)` substitutions are treated the same way", () => {
		const r = resolveSymbols(':local v 1\n:put "$($v)"\n:put $v');
		expect(r.occurrences.map((o) => o.cls)).toEqual([
			"local",
			"local",
			"local",
		]);
	});
});

describe("explain/symbols — structural recovery", () => {
	test("a mismatched close is reported and does NOT unwind a scope", () => {
		const r = resolveSymbols(":local f do={ :local v 1 ]\n :put $v }");
		expect(r.notes).toEqual(["unbalanced-close:]"]);
		// the `]` must not pop the `do={` scope, which would drop `v` early
		expect(r.occurrences.at(-1)?.cls).toBe("local");
	});

	test("closes past the depth cap do not unwind real scopes", () => {
		const depth = 300;
		const r = resolveSymbols(
			`:local v 1\n${"{".repeat(depth)}${"}".repeat(depth)}\n:put $v`,
		);
		expect(r.notes.some((n) => n.startsWith("over-depth:"))).toBe(true);
		// every suppressed open consumed its own close, so the document scope —
		// and `v` with it — is still standing at the end
		expect(r.occurrences.at(-1)?.cls).toBe("local");
	});

	test("a quoted reference never has its span cut inside the quotes (S19)", () => {
		const input = ':local a 1\n:put $"a-b"';
		const reference = resolveSymbols(input).occurrences.at(-1);
		expect(reference?.name).toBe("a-b");
		expect(input.slice(reference?.start, reference?.end)).toBe('"a-b"');
		expect(reference?.cls).toBe("parameter");
	});
});

describe("explain/symbols — spans are analyzed-byte offsets", () => {
	test("a span slices the name out of an ASCII document", () => {
		const input = ":local vlanid 1\n:put $vlanid";
		for (const o of resolveSymbols(input).occurrences)
			expect(input.slice(o.start, o.end)).toBe("vlanid");
	});

	test("spans stay in byte space when the document has non-ASCII text", () => {
		// non-ASCII written as escapes so the fixture text stays reviewable
		const input = ':local n "\u65e5\u672c\u8a9e"\n:put $n';
		const analysis = analyzeCoordinates(input);
		const bytes = new TextEncoder().encode(input);
		const reference = resolveSymbols(input).occurrences.at(-1);
		expect(reference).toBeDefined();
		const span = reference as NonNullable<typeof reference>;
		expect(new TextDecoder().decode(bytes.slice(span.start, span.end))).toBe(
			"n",
		);
		// and the span maps back through the contract to the second (0-based) line
		expect(byteToPosition(analysis, span.start).line).toBe(1);
	});

	test("a quoted declaration's span includes the quotes but its name does not", () => {
		const input = ':global "set-dns" do={:put 1}';
		const [declaration] = resolveSymbols(input).occurrences;
		expect(declaration?.name).toBe("set-dns");
		expect(input.slice(declaration?.start, declaration?.end)).toBe('"set-dns"');
	});

	test("S19 stops the span at the resolving prefix, not the operator", () => {
		const input = ":local octive 4\n:put ($octive-1)";
		const reference = resolveSymbols(input).occurrences.at(-1);
		expect(reference?.name).toBe("octive");
		expect(input.slice(reference?.start, reference?.end)).toBe("octive");
	});

	test("every span is in bounds, non-empty, and ordered", () => {
		for (const c of fixtures.cases) {
			const bytes = new TextEncoder().encode(c.input).length;
			let previous = -1;
			for (const o of resolveSymbols(c.input).occurrences) {
				expect(o.start).toBeGreaterThanOrEqual(0);
				expect(o.end).toBeGreaterThan(o.start);
				expect(o.end).toBeLessThanOrEqual(bytes);
				expect(o.start).toBeGreaterThanOrEqual(previous);
				previous = o.start;
			}
		}
	});
});

describe("explain/symbols — invariants", () => {
	const adversarial = [
		"",
		"\n\n\n",
		"#",
		'"',
		'"unterminated $x',
		"${",
		"$",
		"$$$",
		"]]]}}}",
		":local",
		":local ",
		":global\n",
		":set",
		":onerror",
		":foreach",
		"$0 $1 $99",
		"$-",
		"$->x",
		"$.",
		"$a->b.c",
		":local a-b 1\n:put $a-b-c",
		"/ip route print where",
		"[find",
		':put "$[[:parse "',
		"$v",
		"\u65e5\u672c\u8a9e $v",
		":local v 1\r\n:put $v",
	];

	test("never throws", () => {
		for (const input of [...adversarial, ...fixtures.cases.map((c) => c.input)])
			expect(() => resolveSymbols(input)).not.toThrow();
	});

	test("is deterministic", () => {
		for (const c of fixtures.cases)
			expect(resolveSymbols(c.input)).toEqual(resolveSymbols(c.input));
	});

	test("every reported class is one of the five device classes", () => {
		const known = new Set(Object.keys(HIGHLIGHT_CLASS));
		for (const input of [...adversarial, ...fixtures.cases.map((c) => c.input)])
			for (const o of resolveSymbols(input).occurrences)
				if (o.cls !== null) expect(known.has(o.cls)).toBe(true);
	});

	test("declarations always carry a class; only references may abstain", () => {
		for (const c of fixtures.cases)
			for (const o of resolveSymbols(c.input).occurrences)
				if (o.declaration) expect(o.cls).not.toBeNull();
	});

	test("nesting is depth-bounded and reported, not thrown", () => {
		const deep = `${"{".repeat(600)}:local v 1\n:put $v${"}".repeat(600)}`;
		const r = resolveSymbols(deep);
		expect(r.notes.some((n) => n.startsWith("over-depth:"))).toBe(true);
	});

	test("a large document is resolved without loss", () => {
		const line = ':local v 1\n:put "$v $[:tostr $v]"\n';
		const r = resolveSymbols(line.repeat(4000));
		expect(r.occurrences.length).toBeGreaterThan(10000);
	});

	// No wall-clock assertion (shared runners): the signal is that a quadratic
	// scan of a long SINGLE line — the shape a per-word backward paren scan blew
	// up on — cannot finish inside the runner's per-test timeout.
	test("a long single-line document stays linear", () => {
		const words = Array.from({ length: 6000 }, (_, k) => `(w${k} = 1)`).join(
			" ) ",
		);
		const r = resolveSymbols(`:if ${words} do={:put 1}`);
		expect(r.occurrences.length).toBeGreaterThan(1000);
	});

	test("HIGHLIGHT_CLASS covers every class and maps to device names", () => {
		expect(HIGHLIGHT_CLASS).toEqual({
			local: "variable-local",
			global: "variable-global",
			auto: "variable-auto",
			parameter: "variable-parameter",
			undefined: "variable-undefined",
		});
	});
});

/**
 * F6 — a `[…]` substitution is a nested STATEMENT context (#201, was the K1
 * known limit).
 *
 * Every expectation below is the device's own reading on CHR 7.23.2 (build
 * 2026-07-03), captured by `.scratch/explain-201-k1-chr-probe.ts` and its
 * round-2 companion. The claim carried on #201 was measured from a MID-statement
 * bracket and generalized to all of them; the device splits them:
 *
 *   - a statement-LEADING `[` is TRANSPARENT — the names declared inside escape;
 *   - a MID-statement `[` confines its declarations, LOCAL AND GLOBAL alike;
 *   - either way the bracket SHARES the enclosing bindings (it is not a closure)
 *     and the `]` resumes the interrupted statement rather than starting one.
 *
 * The `:global`-shadowed variants that looked like the sharpest evidence are NOT
 * usable as scope probes — see the K3 known limit below for why.
 */
describe("explain/symbols — F6 bracket statement context (#201)", () => {
	const classes = (input: string): (string | null)[] =>
		resolveSymbols(input).occurrences.map((o) => o.cls);

	test("a directive inside a bracket is a HEAD and declares", () => {
		const r = resolveSymbols("[:local v 1; :put $v]");
		expect(r.occurrences.map((o) => [o.name, o.cls, o.declaration])).toEqual([
			["v", "local", true],
			["v", "local", false],
		]);
	});

	test("a statement-LEADING bracket is transparent — its names escape", () => {
		expect(classes("[:local b 1]\n:put $b")).toEqual(["local", "local"]);
		expect(classes("[:global g 1]\n:put $g")).toEqual(["global", "global"]);
		// still statement-leading after indentation and after a `;`
		expect(classes("  [:local b 1]\n:put $b")).toEqual(["local", "local"]);
		expect(classes(":put 1; [:local b 1]\n:put $b")).toEqual([
			"local",
			"local",
		]);
		// …and at the lead of a brace body
		expect(classes(":if (1=1) do={[:local b 1]; :put $b}")).toEqual([
			"local",
			"local",
		]);
	});

	test("a MID-statement bracket confines its names — globals included", () => {
		expect(classes(":put [:local b 1]\n:put $b")).toEqual([
			"local",
			"parameter",
		]);
		// the issue claimed a `:global` escapes a bracket; on the device only a
		// statement-LEADING one does.
		expect(classes(":put [:global g 1]\n:put $g")).toEqual([
			"global",
			"parameter",
		]);
		// value position is mid-statement too
		expect(classes(":local x [:local b 1]\n:put $b")).toEqual([
			"local",
			"local",
			"parameter",
		]);
		// and the confinement ends at the `]`, not at the line
		expect(classes(":local a 1\n:put [:local b 1]; :put $b")).toEqual([
			"local",
			"local",
			"parameter",
		]);
	});

	test("a confined global does not block a later document declaration", () => {
		expect(classes(":put [:global g 1]\n:local g 2\n:put $g")).toEqual([
			"global",
			"local",
			"local",
		]);
	});

	test("the bracket scope SHARES the enclosing bindings (not a closure)", () => {
		expect(classes(":local a 1\n:put [:put $a]")).toEqual(["local", "local"]);
		expect(classes(":local a 1\n[:put $a]")).toEqual(["local", "local"]);
		expect(classes(":global g 1\n:put [:put $g]")).toEqual([
			"global",
			"global",
		]);
		// a nested bracket still sees the outer bracket's declaration
		expect(classes("[:local v 1; :put [:put $v]]")).toEqual(["local", "local"]);
	});

	test("lead-vs-mid composes through nesting", () => {
		// the inner bracket leads its enclosing MID bracket, so it escapes INTO it,
		// and the MID bracket's `]` is what confines the name.
		expect(classes(":put [[:local b 1]; :put $b]\n:put $b")).toEqual([
			"local",
			"local",
			"parameter",
		]);
		// mirror image: a MID bracket inside a transparent LEAD one still confines.
		expect(classes("[:put [:local b 1]; :put $b]\n:put $b")).toEqual([
			"local",
			"parameter",
			"parameter",
		]);
	});

	test("a `$[…]` in a string is a bracket like any other, never leading", () => {
		expect(classes(':put "$[:local v 1; :put $v]"')).toEqual([
			"local",
			"local",
		]);
		expect(classes(':put "$[:local b 1]"\n:put $b')).toEqual([
			"local",
			"parameter",
		]);
	});

	test("the closure rule (F2) still decides across a bracket", () => {
		// a named-function body hides the outer name even inside a bracket…
		expect(classes(":local a 1\n:local f do={:put [:put $a]}")).toEqual([
			"local",
			"local",
			"parameter",
		]);
		// …while a control-flow body shares it.
		expect(classes(":local a 1\n:if (1=1) do={:put [:put $a]}")).toEqual([
			"local",
			"local",
		]);
		// and a bracket inside a closure confines to the bracket, not the body.
		expect(
			classes(":local f do={:put [:local b 1; :put $b]; :put $b}"),
		).toEqual(["local", "local", "local", "parameter"]);
	});

	test("the `]` resumes the enclosing statement, it does not start one", () => {
		// a `:local` after a `]` declares nothing (the device agrees; it is also
		// where the walker's pre-F6 comment about "after a bracket" came from).
		expect(classes(":local a 1\n:put [:put 1] :local v 1")).toEqual(["local"]);
		// an explicit `;` does restart it
		expect(classes(":put [:put 1]; :local v 1\n:put $v")).toEqual([
			"local",
			"local",
		]);
	});

	test("`(` is an EXPRESSION context, not a statement one", () => {
		// CHR 7.23.2 classes the `:local` text itself `variable-undefined` in
		// `(:local v 1)` — a directive there is an ordinary expression term. This
		// resolver never emits `undefined` (the ratified Q13 answer), so it
		// abstains and the trailing use stays `parameter`; what matters is that it
		// does NOT declare.
		const r = resolveSymbols("(:local v 1)\n:put $v");
		expect(r.occurrences.some((o) => o.declaration)).toBe(false);
		expect(r.occurrences.map((o) => o.cls)).toEqual([null, "parameter"]);
	});

	test("S8 filter regions survive `find` becoming a head", () => {
		// `[find comment=$tag]` is the commonest bracket in the corpus. Once `[`
		// opens a statement context its `find` is the HEAD, and the head branch has
		// to open the filter region itself or the field stops being reported.
		const r = resolveSymbols(
			'/ip route set [find comment="WAN1"] disabled=yes',
		);
		const comment = r.occurrences.find((o) => o.name === "comment");
		expect(comment).toBeDefined();
		expect(comment?.cls).toBeNull();
		// the same for a `/`-sigilled head, which must still open a menu path
		expect(
			resolveSymbols(
				":if ([:len [/interface list find name=LAN]] = 1) do={}",
			).occurrences.map((o) => o.name),
		).toEqual(["name"]);
		// a HEAD `find` opens the region outside a bracket too: CHR 7.23.2 reads
		// `comment` in `/ip route<nl>find comment=x` as `variable-local`, the same
		// as in the `where` spelling.
		expect(
			resolveSymbols("/ip route\nfind comment=x").occurrences.map((o) => [
				o.name,
				o.cls,
			]),
		).toEqual([["comment", null]]);
	});

	test("a `#` at the lead of a bracket is a COMMENT, and swallows the `]`", () => {
		// F6 makes the first position inside a `[` statement-leading, and H4 makes a
		// statement-leading `#` a comment; CHR 7.23.2 confirms the composition —
		// `[# c\n…` classes `# c\n` as `comment`, in both the lead and mid spellings.
		// Found by the F6 differential fuzz, which flagged the declarations that
		// appear AFTER a `]` the comment ate; the device says they are real.
		const classes = (input: string): (string | null)[] =>
			resolveSymbols(input).occurrences.map((o) => o.cls);
		expect(classes("[# c\n:local v 1]\n:put $v")).toEqual(["local", "local"]);
		expect(classes(":put [# c\n:local v 1]")).toEqual(["local"]);
		expect(classes("[:put 1; # c\n:local v 1]\n:put $v")).toEqual([
			"local",
			"local",
		]);
		// the fuzz case verbatim: the comment runs past `;] \` AND the newline, so
		// the bracket never closes and the `:local` still declares.
		expect(classes("[#;] \\\n:local v 1\n:put $v")).toEqual(["local", "local"]);
	});
});

/**
 * F7 — the FIRST declaration in a scope CLAIMS the name (#201, was the K3 known
 * limit).
 *
 * Every expectation below is the device's own reading on CHR 7.23.2 AND
 * 7.24rc2, which agreed on all 25 rows of the deciding round; captured by
 * `.scratch/explain-201-k3-chr-probe{,2,3,4,5}.ts` and replayed against this
 * module by `.scratch/explain-201-k3-probe-check.ts`.
 *
 * K3 claimed "an earlier `:global` outranks a later `:local`". The reverse order
 * loses too, so it is not a precedence between the classes at all — it is
 * first-declaration-wins, and three further rules fell out of probing its
 * extent (the global that does not escape, the promoting lead bracket, and the
 * statement scope). The control that made the difference measurable is Z: the
 * device's `highlight` is purely LEXICAL here — inspecting `:global zzz 1` does
 * not change how a later inspect reads `$zzz`, and `/system/script/environment`
 * stays empty throughout — so none of this is probe-ordering contamination.
 */
describe("explain/symbols — F7 declaration claim (#201)", () => {
	const classes = (input: string): (string | null)[] =>
		resolveSymbols(input).occurrences.map((o) => o.cls);

	test("the first declaration in a scope claims the name", () => {
		expect(classes(":global v 1\n:local v 2\n:put $v")).toEqual([
			"global",
			"local",
			"global",
		]);
		// …and it is not a precedence between the classes: the reverse order loses
		// the same way, which is what killed the K3 wording.
		expect(classes(":local v 1\n:global v 2\n:put $v")).toEqual([
			"local",
			"global",
			"local",
		]);
		// the loser's own span still reads its own head's class; it just binds
		// nothing.
		expect(classes(":global v 1\n:local v 2\n:local v 3\n:put $v")).toEqual([
			"global",
			"local",
			"local",
			"global",
		]);
		expect(classes(":local v 1\n:global v 2\n:local v 3\n:put $v")).toEqual([
			"local",
			"global",
			"local",
			"local",
		]);
		// `;` is a statement boundary like a newline, and neither resets the claim
		expect(classes(":global v 1; :local v 2; :put $v")).toEqual([
			"global",
			"local",
			"global",
		]);
	});

	test("a claim only applies from its own offset onwards", () => {
		// the first in-body use precedes the body's own claim, so it still reads
		// the enclosing binding.
		expect(classes(":global v 1\n{:put $v; :local v 2; :put $v}")).toEqual([
			"global",
			"global",
			"local",
			"local",
		]);
		expect(classes(":put $v\n:global v 1")).toEqual(["parameter", "global"]);
	});

	test("a NESTED scope's declaration never claims the enclosing one", () => {
		// the inner `:local` is confined, so the outer `:local` is still the
		// document's first declaration…
		expect(classes(":if (1=1) do={:local v 9}\n:local v 2\n:put $v")).toEqual([
			"local",
			"local",
			"local",
		]);
		// …and an inner declaration cannot claim ahead of the outer one either way.
		expect(
			classes(":global v 1\n:if (1=1) do={:local v 9}\n:local v 2\n:put $v"),
		).toEqual(["global", "local", "local", "global"]);
		expect(classes(":global v 1\n:if (1=1) do={:local v 2; :put $v}")).toEqual([
			"global",
			"local",
			"local",
		]);
		expect(classes(":global v 1\n{:put 1}\n:local v 2\n:put $v")).toEqual([
			"global",
			"local",
			"global",
		]);
	});

	test("a `:global` does NOT escape the body it was written in", () => {
		// This overturns S2 as ratified ("visible for the remainder of the document
		// regardless of brace nesting"). CHR 7.23.2 and 7.24rc2 agree: `:global`
		// and `:local` have IDENTICAL lexical visibility and differ only in the
		// class they emit.
		expect(classes(":if (1=1) do={:global v 1}\n:put $v")).toEqual([
			"global",
			"parameter",
		]);
		expect(classes(":while (false) do={:global v 1}\n:put $v")).toEqual([
			"global",
			"parameter",
		]);
		expect(classes("{:global v 1}\n{:put $v}")).toEqual([
			"global",
			"parameter",
		]);
		expect(classes(":local f do={:global v 1}\n:put $v")).toEqual([
			"local",
			"global",
			"parameter",
		]);
		expect(
			classes(":if (1=1) do={:if (1=1) do={:global v 1}; :put $v}"),
		).toEqual(["global", "parameter"]);
		// it IS visible for the rest of its own scope, inner scopes included…
		expect(classes(":if (1=1) do={:global v 1; :put $v}")).toEqual([
			"global",
			"global",
		]);
		expect(classes(":global v 1\n{:put $v}")).toEqual(["global", "global"]);
		// …and a re-import at the outer scope brings it back.
		expect(classes(":if (1=1) do={:global v 1}\n:global v\n:put $v")).toEqual([
			"global",
			"global",
			"global",
		]);
	});

	test("a statement-LEADING bracket PROMOTES its claims outwards", () => {
		// F6 called this "transparent", which is indistinguishable from promotion
		// until the enclosing scope already holds the name. It does not: the use
		// INSIDE the bracket takes the bracket's own declaration, the use after the
		// `]` takes the enclosing claim.
		expect(classes(":global x 1\n[:local x 2; :put $x]\n:put $x")).toEqual([
			"global",
			"local",
			"local",
			"global",
		]);
		expect(classes(":local x 1\n[:global x 2; :put $x]\n:put $x")).toEqual([
			"local",
			"global",
			"global",
			"local",
		]);
		// with no conflict the promotion is what makes the name escape at all
		expect(classes("[:local x 1; :put $x]\n:put $x")).toEqual([
			"local",
			"local",
			"local",
		]);
		expect(classes("[:local x 1]\n[:put $x]")).toEqual(["local", "local"]);
		// a MID bracket promotes nothing (F6)
		expect(classes(":put [:local x 1]\n[:put $x]")).toEqual([
			"local",
			"parameter",
		]);
		// promotion composes through nesting, and stops at the enclosing claim
		expect(classes(":global x 1\n[[:local x 2]; :put $x]\n:put $x")).toEqual([
			"global",
			"local",
			"local",
			"global",
		]);
		// promoted INTO a body scope, and gone with it
		expect(classes(":if (1=1) do={[:local x 1]; :put $x}\n:put $x")).toEqual([
			"local",
			"local",
			"parameter",
		]);
		// the promoted claim wins over a later declaration, bracket or not
		expect(classes("[:local x 1]\n[:global x 2; :put $x]\n:put $x")).toEqual([
			"local",
			"global",
			"global",
			"local",
		]);
	});

	test("loop variables live in a scope of their own, for the statement", () => {
		// not the enclosing scope: an enclosing claim does not swallow them…
		expect(classes(":global i 1\n:foreach i in={1;2} do={:put $i}")).toEqual([
			"global",
			"auto",
			"auto",
		]);
		expect(classes(":local i 1\n:foreach i in=$i do={:put 1}")).toEqual([
			"local",
			"auto",
			"auto",
		]);
		// …and not the body scope either: the body's own `:local` shadows them.
		expect(classes(":foreach i in={1;2} do={:local i 9; :put $i}")).toEqual([
			"auto",
			"local",
			"local",
		]);
		// they end with the statement, leaving no claim behind
		expect(classes(":foreach i in={1;2} do={:put 1}\n:put $i")).toEqual([
			"auto",
			"parameter",
		]);
		expect(classes(":for i from=1 to=2 do={:put 1}\n:put $i")).toEqual([
			"auto",
			"parameter",
		]);
		expect(
			classes(":local i 1\n:foreach i in={1;2} do={:put $i}\n:put $i"),
		).toEqual(["local", "auto", "auto", "local"]);
		expect(
			classes(":foreach i in={1} do={:put 1}\n:local i 2\n:put $i"),
		).toEqual(["auto", "local", "local"]);
		// `:foreach k,v` shares one scope; nested loops each get their own
		expect(classes(":foreach i,j in={1;2} do={:put $i; :put $j}")).toEqual([
			"auto",
			"auto",
			"auto",
			"auto",
		]);
		expect(
			classes(":foreach i in={1} do={:foreach i in={2} do={:put $i}; :put $i}"),
		).toEqual(["auto", "auto", "auto", "auto"]);
	});

	test("`:onerror` binds TWICE — statement scope and enclosing claim", () => {
		// the statement scope is what makes it `local` inside the body even under
		// an enclosing claim of the same name…
		expect(classes(":global e 1\n:onerror e in={:put 1} do={:put $e}")).toEqual(
			["global", "local", "local"],
		);
		expect(classes(":global e 1\n:onerror e in={:put $e} do={:put 1}")).toEqual(
			["global", "local", "local"],
		);
		expect(
			classes(
				":global e 1\n:onerror e in={:put 1} do={:if (1=1) do={:put $e}}",
			),
		).toEqual(["global", "local", "local"]);
		// …while the enclosing claim is what keeps it visible AFTER the statement,
		// which is where it parts company with a loop variable.
		expect(classes(":onerror e in={:put 1} do={:put 1}\n:put $e")).toEqual([
			"local",
			"local",
		]);
		expect(classes(":foreach e in={1} do={:put 1}\n:put $e")).toEqual([
			"auto",
			"parameter",
		]);
		// a failed claim stays failed: the enclosing scope keeps its own class
		expect(
			classes(":global e 1\n:onerror e in={:put 1} do={:put 1}; :put $e"),
		).toEqual(["global", "local", "global"]);
		expect(
			classes(
				":global e 1\n:onerror e in={:put 1} do={:put 1}\n:local e 2\n:put $e",
			),
		).toEqual(["global", "local", "local", "global"]);
	});

	test("a QUOTED name binds exactly like a bare one, for every head", () => {
		// The quoted branch used to call `bind` in the enclosing scope and set
		// `declaredHere` unconditionally, which broke every F7 rule for this
		// spelling. Found in review by CodeRabbit and Codex independently; each
		// row below is CHR 7.23.2 (`.scratch/explain-201-review-chr-probe.ts`).
		//
		// A quoted loop variable does not outlive its statement…
		expect(classes(':foreach "i" in={1} do={:put 1}\n:put $"i"')).toEqual([
			"auto",
			"parameter",
		]);
		expect(classes(':foreach "i" in={1} do={:put 1}\n:put $i')).toEqual([
			"auto",
			"parameter",
		]);
		// …an enclosing claim does not swallow it…
		expect(classes(':global i 1\n:foreach "i" in={1} do={:put $"i"}')).toEqual([
			"global",
			"auto",
			"auto",
		]);
		// …and it does not make the following `do={` an F2 closure.
		expect(classes(':for "i" from=1 to=2 do={:put $"i"}')).toEqual([
			"auto",
			"auto",
		]);
		expect(classes(':foreach "i" in={1} do={:put $"i"}\n:put $"i"')).toEqual([
			"auto",
			"auto",
			"parameter",
		]);
		// the body's own `:local` still shadows it (the statement scope is outside
		// the body, quoted or not)
		expect(classes(':foreach "i" in={1} do={:local i 9; :put $i}')).toEqual([
			"auto",
			"local",
			"local",
		]);
		// `:onerror` was not accepted by the quoted branch at all, so its pending
		// state survived to the next bare word and declared `in`. It binds in both
		// places like the bare spelling, and `in` is an argument, not a variable.
		expect(
			classes(':onerror "e" in={:put 1} do={:put $"e"}\n:put $"e"'),
		).toEqual(["local", "local", "local"]);
		expect(
			resolveSymbols(':onerror "e" in={:put 1} do={:put 1}').occurrences.map(
				(o) => o.name,
			),
		).toEqual(["e"]);
		// a quoted `:local`/`:global` declaration is unchanged: it still declares,
		// and still makes its own `do={` a closure (F2)
		expect(classes(':local "v" 1\n:put $"v"')).toEqual(["local", "local"]);
		expect(classes(':local "f" do={:put $outer}\n:local outer 1')).toEqual([
			"local",
			"parameter",
			"local",
		]);
	});

	test("the claim rule does not disturb the F2 closure boundary", () => {
		// a closure still hides every outer name, whichever class claimed it
		expect(classes(":global v 1\n:local v 2\n:local f do={:put $v}")).toEqual([
			"global",
			"local",
			"local",
			"parameter",
		]);
		expect(classes(":local v 1\n:global v 2\n:local f do={:put $v}")).toEqual([
			"local",
			"global",
			"local",
			"parameter",
		]);
		// a control-flow body still shares it
		expect(classes(":global v 1\n:local v 2\n:if (1=1) do={:put $v}")).toEqual([
			"global",
			"local",
			"global",
		]);
		// and an in-body re-import is still what a closure needs
		expect(
			classes(":global v 1\n:local f do={:global v; :local v 2; :put $v}"),
		).toEqual(["global", "local", "global", "local", "global"]);
	});
});

/**
 * F8 — a sigil is a DEFECT in menu-path position (#201, was the K2 known limit).
 *
 * Every offset below is the device's own error cliff on CHR 7.23.2, captured by
 * `.scratch/explain-201-k2-chr-probe{,2}.ts` and replayed against this module by
 * `.scratch/explain-201-k2-probe-check.ts` (71/73 rows, 0 false positives, 0
 * wrong offsets; the 2 remaining are the device's SEPARATE "argument before a
 * command" error, which lands on the `=`, not on a sigil).
 *
 * K2 said telling `/ip//address print` from `:put //foo` needed parser context
 * the lexical scan did not have. What it actually needs is the region that ends
 * at the COMMAND, and the device does not end it at a verb: `/ip address zzzz
 * //foo` is as clean as `/ip address print //foo`, while `/ip address //foo` —
 * nothing having ended the path — is a hard error. That is a menu-table
 * question, which `menus.ts` (#207) already answers.
 */
describe("explain/symbols — F8 mid-statement defect (#201)", () => {
	const stop = (input: string): string | null =>
		resolveSymbols(input).notes.find((n) => n.startsWith("bad-sigil:")) ?? null;

	test("a doubled separator inside a path stops at the SECOND sigil", () => {
		// `/` is a legal separator when adjacent to the segment before it, so the
		// error is the one that follows it.
		expect(stop("/ip//address print")).toBe("bad-sigil:4");
		expect(stop("/ip///address print")).toBe("bad-sigil:4");
		expect(stop("ip//address print")).toBe("bad-sigil:3");
		expect(stop("/interface//print")).toBe("bad-sigil:11");
		expect(stop("/ip/firewall//filter print")).toBe("bad-sigil:13");
		expect(stop("/ip address//print")).toBe("bad-sigil:12");
	});

	test("a `/` starting a space-separated segment stops at the FIRST sigil", () => {
		// after a space it is not a separator at all, so the slash itself is wrong
		// — single or doubled, the device errors on the same byte.
		expect(stop("/ip /address print")).toBe("bad-sigil:4");
		expect(stop("/ip //address print")).toBe("bad-sigil:4");
		expect(stop("/ip address /print")).toBe("bad-sigil:12");
		expect(stop("/ip address //print")).toBe("bad-sigil:12");
		expect(stop("/ip address //foo")).toBe("bad-sigil:12");
		expect(stop("ip /address print")).toBe("bad-sigil:3");
	});

	test("a `:` is never legal in a path, doubled or not", () => {
		expect(stop("/ip:address print")).toBe("bad-sigil:3");
		expect(stop("/ip::address print")).toBe("bad-sigil:3");
	});

	test("the path region ends at the first word that is not a menu", () => {
		// a verb ends it…
		expect(stop("/ip address print //foo")).toBeNull();
		expect(stop("/ip address find //foo")).toBeNull();
		expect(stop("/ip address print /foo")).toBeNull();
		// …and so does a word that is not a verb at all, which is why this is a
		// menu-table question and not a verb-list one.
		expect(stop("/ip address zzzz //foo")).toBeNull();
		expect(stop("/interface monitor //foo")).toBeNull();
		expect(stop("/ip address export //foo")).toBeNull();
		// a `:`-spelled head is a scripting directive, never a path
		expect(stop(":put //foo")).toBeNull();
		expect(stop(":put ::foo")).toBeNull();
		expect(stop(":put :/foo")).toBeNull();
		expect(stop(":put /:foo")).toBeNull();
		// …and a colon-less head that is not a known menu is a command
		expect(stop("put //foo")).toBeNull();
		expect(stop("put ::foo")).toBeNull();
	});

	test("a bracket opens its own path region (F6)", () => {
		expect(stop(":put [/ip//address print]")).toBe("bad-sigil:10");
		expect(stop("[/ip//address print]")).toBe("bad-sigil:5");
		// the bracket's own head decides it, not the enclosing statement's
		expect(stop("/ip route set [find //foo] disabled=yes")).toBeNull();
		expect(stop(":foreach i in=[/ip address find] do={:put $i}")).toBeNull();
	});

	test("the stop truncates like F4/F5: earlier bindings survive it", () => {
		// CHR 7.23.2 classes every byte after the cliff `none`, so a declaration
		// after it is not real and one before it is.
		const after = resolveSymbols("/ip//address print\n:local v 1\n:put $v");
		expect(after.notes).toEqual(["bad-sigil:4"]);
		expect(after.occurrences).toEqual([]);
		const before = resolveSymbols(":local v 1\n/ip//address print\n:put $v");
		expect(before.notes).toEqual(["bad-sigil:15"]);
		expect(before.occurrences.map((o) => [o.name, o.cls])).toEqual([
			["v", "local"],
		]);
	});

	test("the false-positive battery: real scripts must stay clean", () => {
		// The expensive failure mode is a WRONG stop — it truncates the analysis
		// and destroys every later binding. Over the whole 913-script frozen corpus
		// there is no file where this stops and the device is clean.
		for (const clean of [
			"/ipv6 address add address=fe80::1/64 interface=ether1",
			"/ipv6 route add dst-address=::/0 gateway=fe80::1",
			"/ip route add dst-address=0.0.0.0/0 gateway=1.1.1.1",
			"/interface bridge host print where mac-address=00:11:22:33:44:55",
			"/system clock set time=00:00:00",
			"/tool fetch url=https://example.com/a//b",
			"/tool fetch url=//example.com",
			"/ip address set 0 comment=a//b",
			"/ip firewall filter add chain=forward action=drop",
			"/user-manager user print",
			'/system script add name=s source="/ip//address print"',
			'/ip address print where address~"::"',
			'"/ip//address"',
			"# a//b",
			":put ::1",
			":local x //foo",
			":put http://example.com",
			"/ip address export file=backup",
		])
			expect(stop(clean)).toBeNull();
	});

	test("K4 a bare hyphenated reference to a quoted declaration", () => {
		// CHR 7.23.2: `:global "set-dns" 1` + `:put $set-dns` ERRORS at the `-` and
		// reads only `$set` as `variable-parameter` — a bare `$name` reference never
		// carries a hyphen, whatever the document declared, and `$"set-dns"` is the
		// spelling that resolves. S19 tries the FULL run first, so this reports a
		// confident `global` where the device errors out.
		//
		// Pre-existing and NOT part of F7: the same rows fail identically on the
		// pre-F7 module (`.scratch/explain-201-k3-probe-check-old.ts`). Found by the
		// F7 probe rounds and pinned here so a fix to S19 flips it on purpose.
		expect(
			resolveSymbols(':global "set-dns" 1\n:put $set-dns').occurrences.map(
				(o) => [o.name, o.cls],
			),
		).toEqual([
			["set-dns", "global"],
			["set-dns", "global"],
		]);
		// the quoted reference is the one the device accepts, and agrees already
		expect(
			resolveSymbols(':global "set-dns" 1\n:put $"set-dns"').occurrences.map(
				(o) => o.cls,
			),
		).toEqual(["global", "global"]);
	});

	test("a bare `//` at statement start does stop (F5, no word to carry it)", () => {
		const r = resolveSymbols("//\n:put $foo");
		expect(r.occurrences).toEqual([]);
		expect(r.notes).toEqual(["bad-sigil:1"]);
	});
});

describe("explain/symbols — public export surface", () => {
	test("is wired through the package barrel", () => {
		expect(centrs.resolveSymbols).toBe(resolveSymbols);
		expect(centrs.HIGHLIGHT_CLASS).toBe(HIGHLIGHT_CLASS);
	});
});
