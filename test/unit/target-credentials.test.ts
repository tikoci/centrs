import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import { resolveMcpConfig } from "../../src/mcp/config.ts";
import { handleRetrieve, handleValidate } from "../../src/mcp/tools.ts";
import { identityFromComment, resolveCdb } from "../../src/resolver/cdb.ts";
import {
	assertNoTargetCredentials,
	assertNoTargetPassword,
	parseHostCandidate,
	redactTargetInput,
} from "../../src/resolver/index.ts";
import { makeMcpTestCdb } from "./mcp-cdb-fixture.ts";

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

	test("explicit URL userinfo is redacted even with a percent-encoded colon", () => {
		const secret = "userinfo-canary";
		for (const target of [
			`http://admin%3A${secret}@192.0.2.1`,
			`https://admin@192.0.2.1`,
		]) {
			expect(redactTargetInput(target)).toEndWith("***@192.0.2.1");
			expect(() => assertNoTargetPassword(target)).toThrow(CentrsError);
		}
		// These are CDB identity candidates, not explicit URLs.
		expect(redactTargetInput("rtr@site")).toBe("rtr@site");
		expect(redactTargetInput("rtr%3Awest@site")).toBe("rtr%3Awest@site");
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
			`http://admin%3A${secret}@192.0.2.1`,
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

// Copilot review on PR #479: every entry point refuses before its own lookup,
// and a CDB record's target is never shown with its password.
describe("credentials never reach an echo path (#478)", () => {
	const secret = "hunter2";
	const withCreds = `admin:${secret}@192.0.2.1`;

	test("resolveCdb refuses before any CDB lookup, even with leading whitespace", async () => {
		for (const target of [
			withCreds,
			`  ${withCreds}`,
			`http://admin%3A${secret}@192.0.2.1`,
		]) {
			const error = await resolveCdb(
				{ targetInput: target, cdbFile: "/nonexistent/centrs-478.cdb" },
				{},
			).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CentrsError);
			expect((error as CentrsError).code).toBe("input/invalid-target");
			expect(JSON.stringify((error as CentrsError).toJSON())).not.toContain(
				secret,
			);
		}
	});

	test("a CDB record's target is its handle without the password", () => {
		expect(identityFromComment("", `http://${withCreds}`)).toBe(
			"http://***@192.0.2.1",
		);
		expect(identityFromComment("identity=core", withCreds)).toBe("core");
	});

	test("redaction keeps leading whitespace and still removes the password", () => {
		expect(redactTargetInput(`\t${withCreds}`)).toBe("\t***@192.0.2.1");
	});

	test("the MCP allowlist refuses before its lookup, and the envelope has no password", async () => {
		const { path, cleanup } = await makeMcpTestCdb([{ target: "known" }]);
		try {
			const config = resolveMcpConfig({ cdbFile: path, env: {} });
			for (const env of [
				await handleValidate(
					{ target: withCreds, command: "/interface/print" },
					config,
				),
				await handleRetrieve(
					{ target: withCreds, path: "/system/resource" },
					config,
				),
			]) {
				expect(env.ok).toBe(false);
				if (env.ok) continue;
				expect(env.error.code).toBe("input/invalid-target");
				expect(JSON.stringify(env)).not.toContain(secret);
			}
		} finally {
			await cleanup();
		}
	});
});

// CodeRabbit on PR #479: a password holding `/`, `?` or `#` ends a URL
// authority early, so a userinfo pattern alone misses it.
describe("passwords that end a URL authority early (#478)", () => {
	const secret = "hunter2";
	const odd = [
		`http://admin:x/${secret}@192.0.2.1`,
		`http://admin:x?${secret}@192.0.2.1`,
		`http://admin:x#${secret}@192.0.2.1`,
		`admin:x/${secret}@192.0.2.1`,
		`admin:${secret}@@192.0.2.1`,
	];

	test("are refused before any lookup, and the error never repeats them", () => {
		for (const value of odd) {
			for (const check of [assertNoTargetPassword, assertNoTargetCredentials]) {
				let caught: unknown;
				try {
					check(value);
				} catch (error) {
					caught = error;
				}
				expect(caught).toBeInstanceOf(CentrsError);
				expect(JSON.stringify((caught as CentrsError).toJSON())).not.toContain(
					secret,
				);
			}
		}
	});

	test("are redacted up to the last @", () => {
		expect(redactTargetInput(odd[0] as string)).toBe("http://***@192.0.2.1");
		expect(redactTargetInput(odd[3] as string)).toBe("***@192.0.2.1");
		expect(redactTargetInput(odd[4] as string)).toBe("***@192.0.2.1");
	});

	test("a parse error from parseHostCandidate does not echo them", () => {
		let caught: unknown;
		try {
			parseHostCandidate(`http://admin:x/${secret}@router.example`);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CentrsError);
		expect(JSON.stringify((caught as CentrsError).toJSON())).not.toContain(
			secret,
		);
	});
});

describe("a CDB identity with @ still resolves (#478)", () => {
	test("`user@host` holds no password, so the lookup runs first", async () => {
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "192.0.2.9", comment: "identity=rtr@site" },
			{ target: "192.0.2.10", comment: "identity=rtr%3Awest@site" },
		]);
		try {
			const resolved = await resolveCdb(
				{ targetInput: "rtr@site", cdbFile: path },
				{},
			);
			expect(resolved?.target).toBe("192.0.2.9");
			expect(resolved?.identity).toBe("rtr@site");
			expect(redactTargetInput("rtr@site")).toBe("rtr@site");
			const encoded = await resolveCdb(
				{ targetInput: "rtr%3Awest@site", cdbFile: path },
				{},
			);
			expect(encoded?.target).toBe("192.0.2.10");
			expect(encoded?.identity).toBe("rtr%3Awest@site");
		} finally {
			await cleanup();
		}
	});

	test("an unmatched `user@host` is still refused before it is dialed", () => {
		expect(() => assertNoTargetCredentials("admin@192.0.2.1")).toThrow(
			CentrsError,
		);
		expect(() => assertNoTargetPassword("admin@192.0.2.1")).not.toThrow();
	});
});
