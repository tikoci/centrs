import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	parseBoolean,
	parseDuration,
	resolveBooleanSetting,
	resolveOptionalIntegerSetting,
	resolveStringSetting,
	toCoreSource,
} from "../../src/resolver/settings.ts";

function codeOf(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		if (error instanceof CentrsError) {
			return error.code;
		}
		throw error;
	}
	throw new Error("Expected a CentrsError to be thrown.");
}

describe("parseBoolean", () => {
	test("accepts the documented truthy/falsy forms", () => {
		for (const v of ["true", "1", "yes", "ON"]) {
			expect(parseBoolean(v, "x")).toBe(true);
		}
		for (const v of ["false", "0", "no", "Off"]) {
			expect(parseBoolean(v, "x")).toBe(false);
		}
	});

	test("rejects anything else with settings/invalid-boolean", () => {
		expect(codeOf(() => parseBoolean("maybe", "x"))).toBe(
			"settings/invalid-boolean",
		);
	});
});

describe("parseDuration", () => {
	test("parses bare milliseconds and unit suffixes", () => {
		expect(parseDuration("500")).toBe(500);
		expect(parseDuration("500ms")).toBe(500);
		expect(parseDuration("5s")).toBe(5000);
		expect(parseDuration("1m")).toBe(60_000);
	});

	test("rejects malformed durations with settings/invalid-timeout", () => {
		expect(codeOf(() => parseDuration("soon"))).toBe(
			"settings/invalid-timeout",
		);
		expect(codeOf(() => parseDuration("5h"))).toBe("settings/invalid-timeout");
	});
});

describe("precedence: explicit > env > comment-kv > default", () => {
	test("resolveStringSetting picks the highest layer", () => {
		const env = { MY: "from-env" };
		expect(
			resolveStringSetting("from-cli", env, "MY", "from-default", "k")?.value,
		).toBe("from-cli");
		expect(
			resolveStringSetting(undefined, env, "MY", "from-default", "k")?.value,
		).toBe("from-env");
		expect(
			resolveStringSetting(undefined, {}, "MY", "from-default", "k")?.value,
		).toBe("from-default");
		expect(
			resolveStringSetting(undefined, {}, "MY", undefined, "k", undefined, {
				value: "from-kv",
				source: { kind: "cdb", key: "k" },
			})?.value,
		).toBe("from-kv");
	});

	test("resolveBooleanSetting labels the winning source", () => {
		expect(resolveBooleanSetting(true, {}, "B", false, "k").source.kind).toBe(
			"explicit",
		);
		expect(
			resolveBooleanSetting(undefined, { B: "yes" }, "B", false, "k").value,
		).toBe(true);
		expect(
			resolveBooleanSetting(undefined, {}, "B", false, "k").source.kind,
		).toBe("default");
	});

	test("resolveBooleanSetting surfaces a bad env value as invalid-boolean", () => {
		expect(
			codeOf(() =>
				resolveBooleanSetting(undefined, { B: "nope" }, "B", false, "k"),
			),
		).toBe("settings/invalid-boolean");
	});
});

describe("resolveOptionalIntegerSetting", () => {
	test("returns undefined when no layer supplies a value", () => {
		expect(
			resolveOptionalIntegerSetting(undefined, {}, "N", "k"),
		).toBeUndefined();
	});

	test("rejects non-positive or non-integer values", () => {
		expect(codeOf(() => resolveOptionalIntegerSetting(0, {}, "N", "k"))).toBe(
			"settings/invalid-integer",
		);
		expect(
			codeOf(() =>
				resolveOptionalIntegerSetting(undefined, { N: "x" }, "N", "k"),
			),
		).toBe("settings/invalid-integer");
	});

	test("accepts a positive integer from env", () => {
		const resolved = resolveOptionalIntegerSetting(
			undefined,
			{ N: "7" },
			"N",
			"k",
		);
		expect(resolved?.value).toBe(7);
		expect(resolved?.source.kind).toBe("env");
	});
});

describe("toCoreSource", () => {
	test("collapses explicit and target-input to the core cli kind", () => {
		expect(toCoreSource({ kind: "explicit", key: "host" })).toEqual({
			kind: "cli",
			key: "host",
		});
		expect(toCoreSource({ kind: "target-input", key: "host" })).toEqual({
			kind: "cli",
			key: "host",
		});
	});

	test("passes core kinds through unchanged", () => {
		expect(toCoreSource({ kind: "env", key: "X" })).toEqual({
			kind: "env",
			key: "X",
		});
	});
});
