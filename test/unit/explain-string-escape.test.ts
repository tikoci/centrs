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
		]) {
			expect(explainCommand(`:put "${esc}"`).verdict).toBe("pass");
		}
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
});
