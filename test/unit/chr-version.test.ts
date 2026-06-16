import { describe, expect, test } from "bun:test";
import { routerOsAtLeast } from "../integration/chr.ts";

describe("routerOsAtLeast", () => {
	test("compares major.minor.patch", () => {
		expect(routerOsAtLeast("7.23", "7.21")).toBe(true);
		expect(routerOsAtLeast("7.21.4", "7.23")).toBe(false);
		expect(routerOsAtLeast("7.23.1", "7.23")).toBe(true);
		expect(routerOsAtLeast("7.23", "7.23")).toBe(true);
		expect(routerOsAtLeast("8.0", "7.99")).toBe(true);
	});

	test("orders prerelease stages beta < rc < release", () => {
		expect(routerOsAtLeast("7.23beta1", "7.23beta2")).toBe(false);
		expect(routerOsAtLeast("7.23beta2", "7.23beta2")).toBe(true);
		expect(routerOsAtLeast("7.23beta2", "7.23beta1")).toBe(true);
		expect(routerOsAtLeast("7.23rc1", "7.23beta2")).toBe(true);
		expect(routerOsAtLeast("7.23", "7.23rc2")).toBe(true);
		expect(routerOsAtLeast("7.23beta2", "7.23")).toBe(false);
	});

	test("gates /file/copy (first seen 7.23beta2) correctly", () => {
		// Versions that have /file/copy.
		expect(routerOsAtLeast("7.23.1 (stable)", "7.23beta2")).toBe(true);
		expect(routerOsAtLeast("7.23beta2", "7.23beta2")).toBe(true);
		expect(routerOsAtLeast("7.24beta1", "7.23beta2")).toBe(true);
		// Versions that do not — the JG-14 long-term floor and the 7.23beta1 trap.
		expect(routerOsAtLeast("7.21.4 (long-term) 2026-04-21", "7.23beta2")).toBe(
			false,
		);
		expect(routerOsAtLeast("7.23beta1", "7.23beta2")).toBe(false);
	});

	test("tolerates trailing channel/date noise in the version string", () => {
		expect(
			routerOsAtLeast("7.21.4 (long-term) 2026-04-21 06:49:05", "7.21"),
		).toBe(true);
		expect(routerOsAtLeast("garbage", "7.0")).toBe(false);
	});
});
