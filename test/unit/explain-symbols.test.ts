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
 * usable as scope probes — see the S3 known limit below for why.
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

describe("explain/symbols — known limits (#201)", () => {
	// Pinned so a fix flips them deliberately, in the Q16 style: each carries the
	// device reading it does not yet reproduce.
	test("S3 a document `:local` after a `:global` of the same name", () => {
		// CHR 7.23.2: `:global v 1\n:local v 2\n:put $v` reads the trailing use
		// `variable-global` — the earlier global outranks the later local at the
		// same scope, where this resolver takes the nearest preceding binding and
		// says `local`. Found as the CONTROL for the #201 K1 probe: it is why the
		// `:global`-shadowing cases cannot be used to measure bracket scope extent.
		// Its own extent (same scope only? which spellings?) is not probed yet, so
		// it is carried rather than guessed at.
		expect(
			resolveSymbols(":global v 1\n:local v 2\n:put $v").occurrences.map(
				(o) => o.cls,
			),
		).toEqual(["global", "local", "local"]);
	});

	test("K2 the doubled-sigil stop is statement-leading only", () => {
		// CHR 7.23.2 errors at the doubled separator here too, but `:put //foo`
		// and `url=//example.com` are valid, so this needs parser context.
		const r = resolveSymbols("/ip//address print\n:put $foo");
		expect(r.notes).toEqual([]);
		expect(r.occurrences.map((o) => o.cls)).toEqual(["parameter"]);
		// the forms that MUST stay clean
		for (const valid of [":put //foo", "/tool fetch url=//example.com"])
			expect(resolveSymbols(valid).notes).toEqual([]);
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
