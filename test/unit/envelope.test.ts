import { describe, expect, test } from "bun:test";
import { normalizeWarnings, type Warning } from "../../src/core/envelope.ts";

describe("normalizeWarnings", () => {
	test("turns undefined into an empty array", () => {
		expect(normalizeWarnings(undefined)).toEqual([]);
	});

	test("returns the same warnings when present", () => {
		const warnings: Warning[] = [
			{ code: "cdb/password-not-needed", message: "ignored" },
		];
		expect(normalizeWarnings(warnings)).toEqual(warnings);
	});
});
