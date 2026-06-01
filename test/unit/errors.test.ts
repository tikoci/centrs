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
