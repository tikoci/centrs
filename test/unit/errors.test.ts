import { describe, expect, test } from "bun:test";
import {
	asCentrsError,
	CentrsError,
	extractErrorCode,
	formatCentrsErrorText,
	serializeCentrsError,
} from "../../src/errors.ts";

describe("CentrsError", () => {
	test("derives detailsUrl from the code", () => {
		const error = new CentrsError({
			code: "routeros/unknown-path",
			summary: "nope",
		});
		expect(error.detailsUrl).toBe(
			"https://tikoci.github.io/centrs/errors/routeros/unknown-path",
		);
		expect(error.name).toBe("CentrsError");
		expect(error.message).toBe("nope");
	});

	test("toJSON round-trips and exposes both detailsUrl and details_url", () => {
		const error = new CentrsError({
			code: "cdb/parse-failed",
			summary: "bad bytes",
			remediation: "restore from backup",
			context: { offset: 4 },
		});
		const json = error.toJSON();
		expect(json.name).toBe("CentrsError");
		expect(json.code).toBe("cdb/parse-failed");
		expect(json.summary).toBe("bad bytes");
		expect(json.remediation).toBe("restore from backup");
		expect(json.context).toEqual({ offset: 4 });
		expect(json.detailsUrl).toBe(json.details_url);
		expect(json.details_url).toBe(
			"https://tikoci.github.io/centrs/errors/cdb/parse-failed",
		);
	});

	test("serializeCentrsError passes a serialized value through unchanged", () => {
		const error = new CentrsError({ code: "auth/failed", summary: "x" });
		const once = serializeCentrsError(error);
		const twice = serializeCentrsError(once);
		expect(twice).toEqual(once);
	});

	test("causeData wins over the raw cause in serialization", () => {
		const error = new CentrsError({
			code: "transport/timeout",
			summary: "slow",
			cause: new Error("socket hang up"),
			causeData: { reason: "timeout" },
		});
		expect(serializeCentrsError(error).cause).toEqual({ reason: "timeout" });
	});
});

describe("asCentrsError", () => {
	test("returns an existing CentrsError unchanged", () => {
		const original = new CentrsError({ code: "auth/failed", summary: "x" });
		expect(
			asCentrsError(original, { code: "internal/unhandled", summary: "y" }),
		).toBe(original);
	});

	test("wraps an unknown error with the fallback and captures the cause", () => {
		const wrapped = asCentrsError(new Error("boom"), {
			code: "internal/unhandled",
			summary: "fallback summary",
		});
		expect(wrapped).toBeInstanceOf(CentrsError);
		expect(wrapped.code).toBe("internal/unhandled");
		const serialized = wrapped.toJSON();
		expect((serialized.cause as { message?: string })?.message).toBe("boom");
	});
});

describe("formatCentrsErrorText", () => {
	test("renders code, fix, and details lines", () => {
		const text = formatCentrsErrorText(
			new CentrsError({
				code: "usage/missing-group",
				summary: "need a group",
				remediation: "pass --group",
			}),
		);
		expect(text).toContain("[usage/missing-group] need a group");
		expect(text).toContain("Fix: pass --group");
		expect(text).toContain(
			"Details: https://tikoci.github.io/centrs/errors/usage/missing-group",
		);
	});

	test("includes context only in verbose mode", () => {
		const error = new CentrsError({
			code: "cdb/parse-failed",
			summary: "bad",
			context: { offset: 4 },
		});
		expect(formatCentrsErrorText(error)).not.toContain("offset");
		expect(formatCentrsErrorText(error, { verbose: true })).toContain("offset");
	});

	// GH#362: position and the device's own words print without --verbose.
	test("prints position and the device's words in order, without verbose", () => {
		const text = formatCentrsErrorText(
			new CentrsError({
				code: "validation/syntax",
				summary: "RouterOS rejected the command syntax while parsing it.",
				remediation: "Fix the syntax.",
				position: { line: 1, column: 2 },
				context: { detail: "bad command name zerotier\r\n(line 1 column 2)" },
			}),
		);
		expect(text.split("\n")).toEqual([
			"[validation/syntax] RouterOS rejected the command syntax while parsing it.",
			"At: line 1, column 2 (RouterOS byte offset)",
			"Device said: bad command name zerotier (line 1 column 2)",
			"Fix: Fix the syntax.",
			"Details: https://tikoci.github.io/centrs/errors/validation/syntax",
		]);
	});

	test("omits the device's words when the summary already quotes them", () => {
		const text = formatCentrsErrorText(
			new CentrsError({
				code: "routeros/api-trap",
				summary: "RouterOS reported an error: no such item",
				context: { detail: "no such item" },
			}),
		);
		expect(text).not.toContain("Device said:");
	});

	test("compares a multi-line summary to the detail on one line", () => {
		const text = formatCentrsErrorText(
			new CentrsError({
				code: "routeros/api-trap",
				summary: "RouterOS reported an error: failure:\n  no such item",
				context: { detail: "failure:\n  no such item" },
			}),
		);
		expect(text).not.toContain("Device said:");
	});

	test("replaces terminal control characters in router-supplied text", () => {
		const text = formatCentrsErrorText(
			new CentrsError({
				code: "routeros/api-trap",
				summary: "bad \u001b[31m red\r",
				remediation: "fix \u009b2J",
				context: { detail: "said \u001b]0;title\u0007" },
			}),
		);
		for (const control of ["\u001b", "\u0007", "\u009b", "\r"])
			expect(text).not.toContain(control);
		expect(text).toContain("[routeros/api-trap] bad  [31m red ");
	});

	test("ignores a non-string detail and caps a long one", () => {
		expect(
			formatCentrsErrorText(
				new CentrsError({
					code: "routeros/api-trap",
					summary: "x",
					context: { detail: ["a"] },
				}),
			),
		).not.toContain("Device said:");
		const long = formatCentrsErrorText(
			new CentrsError({
				code: "routeros/api-trap",
				summary: "x",
				context: { detail: "y".repeat(500) },
			}),
		);
		expect(long).toContain(`Device said: ${"y".repeat(240)}…`);
	});

	test("prints the offline gate's byte span with the bytes it covers", () => {
		const text = formatCentrsErrorText(
			new CentrsError({
				code: "validation/syntax",
				summary: "RouterOS syntax rejected by offline analysis: x",
				context: { command: ':put "é" stats', span: { start: 10, end: 15 } },
			}),
		);
		expect(text).toContain('At: bytes [10, 15) (offline analysis): "stats"');
	});

	test("a RouterOS position wins over an offline span", () => {
		const text = formatCentrsErrorText(
			new CentrsError({
				code: "validation/syntax",
				summary: "x",
				position: { line: 1, column: 3 },
				context: { command: "abc", span: { start: 0, end: 1 } },
			}),
		);
		expect(text).toContain("At: line 1, column 3");
		expect(text).not.toContain("offline analysis");
	});
});

describe("extractErrorCode", () => {
	test("reads a top-level string code", () => {
		expect(extractErrorCode({ code: "EADDRINUSE" })).toBe("EADDRINUSE");
	});

	test("falls back to a nested cause code", () => {
		expect(extractErrorCode({ cause: { code: "ECONNREFUSED" } })).toBe(
			"ECONNREFUSED",
		);
	});

	test("returns undefined when there is no code", () => {
		expect(extractErrorCode({})).toBeUndefined();
		expect(extractErrorCode("nope")).toBeUndefined();
		expect(extractErrorCode(undefined)).toBeUndefined();
	});
});

describe("error.position (JG-16)", () => {
	test("serializes a present position and omits it when absent", () => {
		const withPos = serializeCentrsError(
			new CentrsError({
				code: "validation/syntax",
				summary: "bad",
				position: { line: 1, column: 35 },
			}),
		);
		expect(withPos.position).toEqual({ line: 1, column: 35 });

		const withoutPos = serializeCentrsError(
			new CentrsError({ code: "validation/syntax", summary: "bad" }),
		);
		expect("position" in withoutPos).toBe(false);
	});

	test("text rendering shows the byte offset when present", () => {
		const text = formatCentrsErrorText(
			new CentrsError({
				code: "validation/syntax",
				summary: "RouterOS rejected the command syntax.",
				position: { line: 1, column: 35 },
			}),
		);
		expect(text).toContain("line 1, column 35");
		expect(text).toContain("byte offset");
	});
});
