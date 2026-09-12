import { describe, expect, test } from "bun:test";
import {
	collectStringEscapeDefects,
	scanQuotedString,
	walkStringEscapes,
} from "../../src/explain/quoted-string.ts";
import { explainCommand } from "../../src/explain.ts";

describe("string escape validation (#247)", () => {
	test("valid single-char escapes pass", () => {
		for (const esc of [
			'\\"',
			"\\\\",
			"\\n",
			"\\r",
			"\\t",
			"\\$",
			"\\_",
			"\\a",
			"\\b",
			"\\f",
			"\\v",
			// `\?` is absent from the manual's escape table but the device classes
			// it `escaped` and evaluates it to `?` (#252 CHR 7.23.3 byte sweep).
			"\\?",
		]) {
			expect(explainCommand(`:put "${esc}"`).verdict).toBe("pass");
		}
	});

	// #252 — the manual's table is a LOWER bound on what RouterOS accepts. The
	// accepted set below is the CHR 7.23.3 sweep of `:put "\<c>"` over every
	// 0x20–0x7E byte plus the whitespace forms, scored on the `highlight` class
	// and the runtime result. Re-derive with `bun run explain:probe:escapes`.
	test("backslash before whitespace continues the line inside a string", () => {
		for (const [label, esc] of [
			["space", "\\ "],
			["tab", "\\\t"],
			["LF", "\\\n"],
			["CR", "\\\r"],
			["CRLF", "\\\r\n"],
		] as const) {
			const r = explainCommand(`:put "a${esc}b"`);
			expect(`${label}:${r.verdict}`).toBe(`${label}:pass`);
		}
	});

	test("a CRLF continuation is consumed as one escape, not two", () => {
		// If the CR were consumed alone the LF would re-enter the string as a
		// stray byte and the closing quote bookkeeping would drift.
		const scan = scanQuotedString('"a\\\r\nb"', 0);
		expect(scan.closed).toBe(true);
		expect(scan.end).toBe(7);
	});

	test("whitespace continuation does not swallow a following bad escape", () => {
		const r = explainCommand(':put "a\\\n\\q"');
		expect(r.verdict).toBe("fail");
		expect(
			r.diagnostics.some(
				(d) => d.code === "explain/canonicalizer/bad-string-escape",
			),
		).toBe(true);
	});

	test("a multi-line source= string is accepted (the #252 regression)", () => {
		// 26 corpus scripts are shaped like this; #251 flagged every one.
		const input =
			'/system/scheduler/add name=x on-event=":global AT;\\\n    :put $AT"';
		expect(explainCommand(input).verdict).not.toBe("fail");
	});

	// #254 review — the message is the one place the valid set is printed, and it
	// shipped with a literal TAB where `\t` was meant, so an entry rendered as
	// whitespace. Pin the exact literal: any future edit that lets a real control
	// character back in fails here.
	test("the diagnostic message prints escapes literally, never as control characters", () => {
		const message = explainCommand(':put "\\q"').diagnostics.find(
			(d) => d.code === "explain/canonicalizer/bad-string-escape",
		)?.message;
		expect(message).toBe(
			'invalid escape in string: unknown escape, truncated hex, or lowercase hex digit — use \\n \\r \\t \\" \\\\ \\$ \\_ \\? \\a \\b \\f \\v, \\XX with uppercase hex, or \\ before whitespace to continue the line',
		);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the bug being pinned.
		expect(/[\x00-\x1f]/.test(message ?? "")).toBe(false);
	});

	test("the message names every case that raises it", () => {
		// Copilot #254: truncated hex raises `bad-string-escape` too, so the text
		// must not read as if only unknown/lowercase-hex escapes do.
		const message = explainCommand(':put "\\q"').diagnostics.find(
			(d) => d.code === "explain/canonicalizer/bad-string-escape",
		)?.message;
		for (const cause of ["unknown escape", "truncated hex", "lowercase hex"])
			expect(message).toContain(cause);
		for (const input of [':put "\\q"', ':put "\\0"', ':put "\\0a"'])
			expect(explainCommand(input).verdict).toBe("fail");
	});

	test("valid uppercase hex escapes pass", () => {
		for (const esc of ["\\00", "\\48", "\\0A", "\\FF", "\\5F", "\\4C"]) {
			expect(explainCommand(`:put "${esc}"`).verdict).toBe("pass");
		}
	});

	test("unknown escapes are hard errors", () => {
		for (const esc of ["\\q", "\\x", "\\c", "\\e", "\\z"]) {
			const r = explainCommand(`:put "${esc}"`);
			expect(r.verdict).toBe("fail");
			expect(
				r.diagnostics.some(
					(d) => d.code === "explain/canonicalizer/bad-string-escape",
				),
			).toBe(true);
		}
	});

	test("lowercase hex second digit is a hard error", () => {
		for (const esc of ["\\0a", "\\4c", "\\5f"]) {
			const r = explainCommand(`:put "${esc}"`);
			expect(r.verdict).toBe("fail");
		}
	});

	test("truncated single hex digit is a hard error", () => {
		for (const esc of ["\\0", "\\5", "\\A"]) {
			const r = explainCommand(`:put "${esc}"`);
			expect(r.verdict).toBe("fail");
		}
	});

	test("lowercase hex error is at the second hex byte, unknown escape at the escaped char", () => {
		const badSpan = (input: string) =>
			explainCommand(input).diagnostics.find(
				(d) => d.code === "explain/canonicalizer/bad-string-escape",
			)?.span;
		expect(badSpan(':put "\\q"')).toEqual({ start: 7, end: 8 });
		expect(badSpan(':put "\\0a"')).toEqual({ start: 8, end: 9 });
		expect(badSpan(':put "\\x0a"')).toEqual({ start: 7, end: 8 });
	});

	test("first invalid escape wins; boundary recovery keeps the closing quote", () => {
		const r = explainCommand(':put "\\48\\q"');
		expect(r.verdict).toBe("fail");
		expect(r.diagnostics).toHaveLength(1);
		// still recovers the closing quote
		const txt = ':put "\\48\\q"';
		expect(scanQuotedString(txt, txt.indexOf('"')).closed).toBe(true);
	});

	test("nested substitution escapes are validated with the same shared walk", () => {
		expect(explainCommand(':put "$[ :put "\\q" ]"').verdict).toBe("fail");
		expect(explainCommand(':put "$[ :put "\\0A" ]"').verdict).toBe("pass");
	});

	test("valid escapes \\ff and \\aF are not misread as invalid hex", () => {
		// \\ff = \\f (BEL) + literal f; \\aF = \\a + F
		expect(explainCommand(':put "\\ff"').verdict).toBe("pass");
		expect(explainCommand(':put "\\aF"').verdict).toBe("pass");
	});

	test("string escape defect is a hard error that drives verdict fail and is reported once", () => {
		const r = explainCommand(':put "\\q"');
		expect(r.verdict).toBe("fail");
		expect(
			r.diagnostics.filter(
				(d) => d.code === "explain/canonicalizer/bad-string-escape",
			),
		).toHaveLength(1);
		expect(
			r.diagnostics.find(
				(d) => d.code === "explain/canonicalizer/bad-string-escape",
			)?.severity,
		).toBe("error");
	});

	test("collectStringEscapeDefects shares scanQuotedString's substitution frames", () => {
		const text = ':put "$[ :put "hi" ]"';
		expect(collectStringEscapeDefects(text)).toEqual([]);
		expect(scanQuotedString(text, text.indexOf('"')).closed).toBe(true);
	});

	test("escape defects inside strings do not depend on string position in document", () => {
		// A valid string followed by an invalid one should still report the second
		expect(explainCommand(':put "\\0A"; :put "\\0a"').verdict).toBe("fail");
	});

	test("unterminated string with malformed escape reports bad-string-escape and no closed string", () => {
		const input = ':put "\\q';
		expect(scanQuotedString(input, input.indexOf('"')).closed).toBe(false);
		expect(scanQuotedString(input, input.indexOf('"')).end).toBe(input.length);
		expect(
			explainCommand(input).diagnostics.filter(
				(d) => d.code === "explain/canonicalizer/bad-string-escape",
			),
		).toHaveLength(1);
	});

	test("malformed escapes inside comments do not produce bad-string-escape", () => {
		// Root comment is real per comment placement contract (#245); its quotes are inert.
		expect(explainCommand('# "\\q"\n:put 1').verdict).toBe("pass");
		expect(
			explainCommand('# "\\q"\n:put 1').diagnostics.some(
				(d) => d.code === "explain/canonicalizer/bad-string-escape",
			),
		).toBe(false);
		// Low-level collector must also skip comment spans when given them.
		expect(
			collectStringEscapeDefects('# "\\q"\n:put 1', [{ start: 0, end: 5 }]),
		).toEqual([]);
		expect(
			collectStringEscapeDefects('# "\\q"\n:put 1').length,
		).toBeGreaterThan(0);
	});

	test("the two walkers stay in lockstep (#253 anti-drift)", () => {
		// Golden boundaries for scanQuotedString — the CONTRACT of the shared
		// frame grammar. A delimiter or substitution change that moves the
		// wrong `"` must update these deliberately, not pass on `end>start`.
		const boundaryCases: [string, number, { end: number; closed: boolean }][] =
			[
				[':put "hi"', 5, { end: 9, closed: true }],
				[':put "a\\"b"', 5, { end: 11, closed: true }],
				[':put "\\\\"', 5, { end: 9, closed: true }],
				[':put "$[ :put "hi" ]"', 5, { end: 21, closed: true }],
				[':put "$( :put "hi" )"', 5, { end: 21, closed: true }],
				['"a\\\r\nb"', 0, { end: 7, closed: true }],
				['"\\0A"', 0, { end: 5, closed: true }],
				['"$[ $[ $[ x ] ] ]"', 0, { end: 18, closed: true }],
				// {/} is a real frame inside a substitution (not just []/())
				// and a mismatched closer must not pop the wrong frame.
				['"$[{]"', 0, { end: 6, closed: false }],
				['"$[ )"', 0, { end: 6, closed: false }],
				[':put "a"; :put "\\q"', 5, { end: 8, closed: true }],
				[':put "a"; :put "\\q"', 15, { end: 19, closed: true }],
				['# "\\q"\n:put 1', 2, { end: 6, closed: true }],
			];
		for (const [input, at, expected] of boundaryCases) {
			expect(scanQuotedString(input, at)).toEqual(expected);
		}

		// Defect parity — pin both walkers against ground truth, not each
		// other. Comparing viaExplain vs viaCollector is one walker vs itself.
		const defectCases: [string, boolean][] = [
			[':put "\\q"', true],
			[':put "\\0a"', true],
			[':put "\\0"', true],
			[':put "\\?"', false],
			[':put "a\\n b"', false],
			[':put "a\\r\\nb"', false],
			[':put "a\\0A b"', false],
			[':put "outer $[ :put \\"inner \\\\q\\" ] tail"', false],
			[':foreach i in={1;2} do={:put "a\\qb"}', true],
			[':local s "a"; :put "$s"', false],
		];
		for (const [input, expectBad] of defectCases) {
			expect(
				explainCommand(input).diagnostics.some(
					(d) => d.code === "explain/canonicalizer/bad-string-escape",
				),
			).toBe(expectBad);
			expect(collectStringEscapeDefects(input).length > 0).toBe(expectBad);
		}
		// Comment handling is not a walker-vs-walker parity — the collector
		// only skips comments when given the segments, so test it through
		// the explained path and with explicit comment spans.
		expect(
			explainCommand('# "\\q"\n:put 1').diagnostics.some(
				(d) => d.code === "explain/canonicalizer/bad-string-escape",
			),
		).toBe(false);
		expect(
			collectStringEscapeDefects('# "\\q"\n:put 1', [{ start: 0, end: 7 }])
				.length,
		).toBe(0);
		expect(collectStringEscapeDefects('# "\\q"\n:put 1').length).toBe(1);

		// Depth parity — the M3 killer (#253). MAX_STRING_FRAME_DEPTH is a
		// shared constant; a per-walker cap (e.g. collect cap 8 vs scan 256)
		// must fail. The two walkers share the depth guard in `stepFrame`, so
		// at 255 nestings the string still closes, at 256 it fails closed.
		const inside = (n: number, tail: string): string =>
			`"a${"$[".repeat(n)}${tail}${"]".repeat(n)}"`;
		for (const n of [255, 256]) {
			const valid = inside(n, "hi");
			expect(scanQuotedString(valid, 0).closed).toBe(n === 255);
			expect(collectStringEscapeDefects(valid).length).toBe(0);
		}
		// A malformed escape at the deepest frame: reported only while the
		// collector is under the SHARED cap, so a lower cap fails here.
		// `inside(n, '"a\qb"')` puts a string literal inside the nested
		// code; at n=254 depth is 256 (outer " + 254 "[" + inner "), so
		// the escape is seen, while at n=255 depth 257 exceeds the cap.
		for (const n of [254, 255]) {
			const bad = inside(n, '"a\\qb"');
			expect(collectStringEscapeDefects(bad).length).toBe(n === 254 ? 1 : 0);
		}
	});
});

/**
 * The `escaped` token class (#264) — the second split B5's rule admits.
 *
 * These live beside the escape-grammar tests on purpose: the token and the
 * `bad-string-escape` diagnostic are two halves of ONE walk
 * (`walkStringEscapes`), and the point of that design is that they cannot
 * disagree about which bytes are an escape. A test file that checked them
 * apart would not notice if they did.
 */
describe("the `escaped` token fill (#264)", () => {
	/** `class(text)` for every token, so a whole partition reads in one line. */
	function partition(input: string): string {
		const tokens = explainCommand(input, { tokens: true }).tokens ?? [];
		return tokens
			.map((t) => `${t.class}(${input.slice(t.start, t.end)})`)
			.join(" ");
	}

	test("a valid escape splits the `string` run that contains it", () => {
		expect(partition(':put "a\\nb"')).toBe(
			'dir(:) cmd(put) unclassified( ) string("a) escaped(\\n) string(b")',
		);
	});

	test("an uppercase-hex escape claims all three of its bytes", () => {
		expect(partition(':put "\\FF"')).toBe(
			'dir(:) cmd(put) unclassified( ) string(") escaped(\\FF) string(")',
		);
	});

	test("it splits a `value` run too, not only a `string` one", () => {
		// An array literal's members are value occurrences (`kind: "element"`),
		// which is the shape the corpus's `value` -> `escaped` bytes live in —
		// a plain `comment="a\nb"` never reaches here because the value anchor
		// lexer refuses a string carrying an escape, so `string` claims it.
		expect(partition(':local CP {"\\00";"\\C3\\BD"}')).toBe(
			"dir(:) cmd(local) unclassified( ) variable-local(CP) unclassified( ) " +
				'value({") escaped(\\00) value(";") escaped(\\C3) escaped(\\BD) value("})',
		);
	});

	test("the partition stays total and gapless across the new fill", () => {
		for (const input of [
			':put "a\\nb"',
			':local CP {"\\00";"\\C3\\BD"}',
			'/ip route add comment="x\\ty"',
			':put "\\FF"',
		]) {
			const tokens = explainCommand(input, { tokens: true }).tokens ?? [];
			expect(tokens.map((t) => input.slice(t.start, t.end)).join("")).toBe(
				input,
			);
			let cursor = 0;
			for (const t of tokens) {
				expect(t.start, input).toBe(cursor);
				expect(t.end, input).toBeGreaterThan(t.start);
				cursor = t.end;
			}
			expect(cursor).toBe(input.length);
		}
	});

	test("the walk stops claiming at the first INVALID escape", () => {
		// `\q` is not an escape. The escape before it is painted, the two valid
		// escapes after it are not: past a malformed escape the string
		// boundaries are themselves in doubt, so the fill withholds rather than
		// guesses. The diagnostic and the tokens come from the same walk, which
		// is why the cut-off is at the same byte for both.
		const input = ':put "a\\nb" ; :put "c\\qd" ; :put "e\\nf"';
		const result = explainCommand(input, { tokens: true });
		const escaped = (result.tokens ?? []).filter((t) => t.class === "escaped");
		expect(escaped).toHaveLength(1);
		expect(input.slice(escaped[0]?.start, escaped[0]?.end)).toBe("\\n");
		expect(
			result.diagnostics.some((d) => d.code.endsWith("bad-string-escape")),
		).toBe(true);
		// The later valid escapes stayed inside their unsplit `string` runs.
		expect(partition(input)).toContain('string("e\\nf")');
	});

	test("a `\\`-newline continuation in CODE is not an escape", () => {
		// The device DOES class this `escaped`, and centrs deliberately does not:
		// its run swallows the next line's indentation, so matching it means
		// deciding how much whitespace a continuation owns — the question #225
		// owns. Measured on the committed slice this is the whole remaining
		// `escaped` residue: 145 bytes over 24 runs in 4 scripts (48 bytes of
		// `\`+terminator, 97 of trailing indentation). Pinned so that if a later
		// change starts claiming it, that is a decision and not a drift.
		const input = ":if (true) \\\n    do={ :put 1 }";
		const tokens = explainCommand(input, { tokens: true }).tokens ?? [];
		expect(tokens.some((t) => t.class === "escaped")).toBe(false);
		expect(partition(input)).toContain("unclassified( (true) \\\n    )");
	});

	test("an escaped `$` is an escape, not a variable sigil", () => {
		// The two fills have to agree about this byte, and the token stream is
		// where that shows: `\$` must reach `escaped` whole, with no
		// `variable-*` span carving into it. The unescaped spelling is the
		// control — same bytes minus the backslash, and `b` IS a variable there.
		expect(partition(':local b 1; :put "a\\$b"')).toContain(
			'string("a) escaped(\\$) string(b")',
		);
		expect(partition(':local b 1; :put "a$b"')).toContain(
			'string("a$) variable-local(b) string(")',
		);
	});

	test("a truncated escape at end of input claims nothing", () => {
		// `\` with nothing after it is invalid, so the walk stops rather than
		// emit a one-byte `escaped`. Every `escaped` token is at least 2 bytes.
		for (const input of [':put "a\\', ':put "\\', ':put "\\0"']) {
			const tokens = explainCommand(input, { tokens: true }).tokens ?? [];
			expect(
				tokens.some((t) => t.class === "escaped"),
				input,
			).toBe(false);
		}
	});

	test("a backslash inside a comment is not an escape", () => {
		const input = "# a \\n comment\n:put 1";
		const tokens = explainCommand(input, { tokens: true }).tokens ?? [];
		expect(tokens.some((t) => t.class === "escaped")).toBe(false);
	});

	test("the token and the diagnostic cite the SAME evidence entry", () => {
		// `bad-string-escape` used to cite `resolveSymbols`, which never produced
		// it — `symbols.ts` raises the different `bad-escape` code. Now both
		// halves of the one walk cite `walkStringEscapes`.
		const bad = explainCommand(':put "c\\qd"', { tokens: true });
		const diagnostic = bad.diagnostics.find((d) =>
			d.code.endsWith("bad-string-escape"),
		);
		expect(diagnostic).toBeDefined();
		const cited = bad.evidence.find((e) => e.id === diagnostic?.ev);
		expect(cited?.probe).toBe("walkStringEscapes");
		// `heuristic`, not `direct`: #252 found the manual's escape table was a
		// lower bound, so a live probe can overturn this set and once did.
		expect(cited?.basis).toBe("heuristic");

		const good = explainCommand(':put "a\\nb"', { tokens: true });
		const token = (good.tokens ?? []).find((t) => t.class === "escaped");
		expect(token).toBeDefined();
		expect(good.evidence.find((e) => e.id === token?.ev)?.probe).toBe(
			"walkStringEscapes",
		);
	});

	test("escape spans are not retained when tokens were not requested", () => {
		// Validation is identical either way — the gate only decides retention,
		// so a diagnostic cannot depend on the token facet.
		const input = ':put "a\\nb" ; :put "c\\qd"';
		const withTokens = explainCommand(input, { tokens: true });
		const without = explainCommand(input);
		expect(without.diagnostics.map((d) => [d.code, d.ev])).toEqual(
			withTokens.diagnostics.map((d) => [d.code, d.ev]),
		);
		expect(without.tokens).toBeUndefined();
	});

	test("one walk: the escapes and the defect are the same reading", () => {
		for (const input of [
			':put "a\\nb"',
			':put "c\\qd"',
			':put "a\\nb" ; :put "c\\qd"',
			"# a \\n comment\n:put 1",
			':put "\\FF" ; :put "\\Fg"',
		]) {
			const walk = walkStringEscapes(input);
			expect(walk.defects, input).toEqual(collectStringEscapeDefects(input));
			// Every claimed escape is inside the input and at least two bytes —
			// the grammar has no one-byte form.
			for (const e of walk.escapes) {
				expect(e.end - e.start, input).toBeGreaterThanOrEqual(2);
				expect(input[e.start], input).toBe("\\");
			}
		}
	});
});
