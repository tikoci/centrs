import { describe, expect, test } from "bun:test";
import { asArch, parsePackages } from "../integration/chr.ts";

describe("asArch (CENTRS_CHR_ARCH)", () => {
	test("accepts the known arches, trimming whitespace", () => {
		expect(asArch("arm64")).toBe("arm64");
		expect(asArch("x86")).toBe("x86");
		expect(asArch("  arm64 ")).toBe("arm64");
	});

	test("undefined for unset or unknown values (let quickchr pick the host arch)", () => {
		expect(asArch(undefined)).toBeUndefined();
		expect(asArch("")).toBeUndefined();
		expect(asArch("amd64")).toBeUndefined();
		expect(asArch("ARM64")).toBeUndefined(); // case-sensitive: quickchr's literal
	});
});

describe("parsePackages (CENTRS_CHR_PACKAGES)", () => {
	test("splits on commas and whitespace, dropping blanks", () => {
		expect(parsePackages("container")).toEqual(["container"]);
		expect(parsePackages("container, rose")).toEqual(["container", "rose"]);
		expect(parsePackages("container rose")).toEqual(["container", "rose"]);
		expect(parsePackages(" container ,, rose , ")).toEqual([
			"container",
			"rose",
		]);
	});

	test("empty list for unset or whitespace-only input", () => {
		expect(parsePackages(undefined)).toEqual([]);
		expect(parsePackages("")).toEqual([]);
		expect(parsePackages("   ")).toEqual([]);
	});
});
