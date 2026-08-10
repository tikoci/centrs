import { describe, expect, test } from "bun:test";
import {
	collectStringEscapeDefects,
	scanQuotedString,
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
	// and the runtime result. See `.scratch/explain-252-escape-sweep.ts`.
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
});
