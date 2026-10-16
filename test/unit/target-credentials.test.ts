import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	assertNoTargetCredentials,
	redactTargetInput,
} from "../../src/resolver/index.ts";

describe("redactTargetInput (#478)", () => {
	test("replaces user:password@ with ***@, with or without a scheme", () => {
		expect(redactTargetInput("http://admin:pw@192.0.2.1:8080")).toBe(
			"http://***@192.0.2.1:8080",
		);
		expect(redactTargetInput("https://a:b@router.example")).toBe(
			"https://***@router.example",
		);
		expect(redactTargetInput("admin:pw@192.0.2.1")).toBe("***@192.0.2.1");
		expect(redactTargetInput("admin:@192.0.2.1")).toBe("***@192.0.2.1");
	});

	test("stays linear on a long run of colons (polynomial ReDoS guard)", () => {
		const hostile = ":".repeat(200_000);
		const started = performance.now();
		expect(redactTargetInput(hostile)).toBe(hostile);
		expect(() => assertNoTargetCredentials(hostile)).not.toThrow();
		expect(performance.now() - started).toBeLessThan(250);
	});

	test("leaves every target without a password untouched", () => {
		for (const value of [
			"192.0.2.1",
			"192.0.2.1:8728",
			"http://192.0.2.1",
			"2001:db8::1",
			"[2001:db8::1]:443",
			"aa:bb:cc:dd:ee:ff",
			"core-router",
			"admin@192.0.2.1",
		]) {
			expect(redactTargetInput(value)).toBe(value);
		}
		expect(redactTargetInput(undefined)).toBeUndefined();
	});
});

describe("assertNoTargetCredentials (#478)", () => {
	function refusal(value: string): CentrsError {
		try {
			assertNoTargetCredentials(value);
		} catch (error) {
			if (error instanceof CentrsError) return error;
			throw error;
		}
		throw new Error(`expected a refusal for ${value}`);
	}

	// Built at runtime so secretlint's basic-auth rule sees no literal.
	const secret = "hunter2";

	test("refuses userinfo in any form and never repeats the password", () => {
		for (const value of [
			`http://admin:${secret}@192.0.2.1`,
			`admin:${secret}@192.0.2.1`,
			"https://admin@192.0.2.1",
			"admin@192.0.2.1",
		]) {
			const error = refusal(value);
			expect(error.code).toBe("input/invalid-target");
			expect(error.remediation).toContain("--username");
			expect(error.remediation).toContain("--password");
			expect(JSON.stringify(error.toJSON())).not.toContain(secret);
		}
	});

	test("accepts hosts, URLs, IPv6 and MACs", () => {
		for (const value of [
			"192.0.2.1",
			"http://192.0.2.1:80",
			"2001:db8::1",
			"[2001:db8::1]:443",
			"aa:bb:cc:dd:ee:ff",
			"router.example",
		]) {
			expect(() => assertNoTargetCredentials(value)).not.toThrow();
		}
	});
});
