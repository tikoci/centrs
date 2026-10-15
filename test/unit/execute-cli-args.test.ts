import { describe, expect, test } from "bun:test";
import { parseExecuteCliArgs } from "../../src/cli/execute.ts";
import { CentrsError } from "../../src/errors.ts";

/**
 * Arg-parsing anchor tests for `centrs execute` — the `--` end-of-options
 * marker (JG-02). Hermetic: `parseExecuteCliArgs` is pure (no network), so these
 * pin the parse contract without a router. The target is `positional[0]` and the
 * command is the remaining positionals joined by a space.
 */
describe("execute `--` end-of-options marker (JG-02)", () => {
	test("without `--`, a flag-shaped command token is rejected", () => {
		expect(() => parseExecuteCliArgs(["router", "/ip/x", "--bogus"])).toThrow(
			"Unknown execute flag: --bogus",
		);
	});

	test("`--` ends option parsing; later tokens form the literal command", () => {
		const parsed = parseExecuteCliArgs([
			"router",
			"--",
			"/interface",
			"print",
			"where",
			"disabled=yes",
		]);
		expect(parsed.targetInput).toBe("router");
		expect(parsed.command).toBe("/interface print where disabled=yes");
	});

	test("after `--`, a flag-shaped token that is not a centrs flag is literal", () => {
		const parsed = parseExecuteCliArgs(["router", "--", "/ip/x", "--bogus"]);
		expect(parsed.command).toBe("/ip/x --bogus");
		expect(parsed.format).toBeUndefined();
	});

	test("flags before `--` still parse; `--` only stops what follows", () => {
		const parsed = parseExecuteCliArgs([
			"--json",
			"router",
			"--",
			"/ip/x",
			"-v",
		]);
		expect(parsed.format).toBe("json");
		expect(parsed.verbose).toBeUndefined();
		expect(parsed.command).toBe("/ip/x -v");
	});

	test("the `--` token itself is consumed, not part of the command", () => {
		const parsed = parseExecuteCliArgs(["router", "--", "/ip/x"]);
		expect(parsed.command).toBe("/ip/x");
		expect(parsed.command.includes("--")).toBe(false);
	});
});

/**
 * #459: a centrs flag written after `--` would go to RouterOS (the field run's
 * trailing `--json` failed 3/3 clients as `unknown-attribute`). It is refused
 * before anything dials, with the command line rewritten.
 */
describe("execute: a centrs flag after `--` (#459)", () => {
	function refusal(args: readonly string[]): CentrsError {
		try {
			parseExecuteCliArgs(args);
		} catch (error) {
			if (error instanceof CentrsError) return error;
			throw error;
		}
		throw new Error("expected a refusal");
	}

	test("a trailing --json is refused with the fixed command line", () => {
		const error = refusal([
			"ctl",
			"--cmr",
			"--labels",
			"all",
			"--",
			"/system/identity/print",
			"--json",
		]);
		expect(error.code).toBe("usage/flag-after-separator");
		expect(error.context).toEqual({ flags: ["--json"] });
		expect(error.remediation).toContain(
			"`centrs execute ctl --cmr --labels all --json -- /system/identity/print`",
		);
	});

	test("a value flag moves with its value; a quoted command stays quoted", () => {
		const error = refusal([
			"r1",
			"--",
			":delay 15s; :put done",
			"--timeout",
			"30s",
			"--yes",
		]);
		expect(error.context).toEqual({ flags: ["--timeout", "--yes"] });
		expect(error.remediation).toContain(
			"`centrs execute r1 --timeout 30s --yes -- ':delay 15s; :put done'`",
		);
	});

	test("selection flags and the --flag=value spelling count too", () => {
		expect(refusal(["--", "/x", "--group", "lab"]).context).toEqual({
			flags: ["--group"],
		});
		expect(refusal(["r1", "--", "/x", "--validate=no"]).context).toEqual({
			flags: ["--validate"],
		});
	});

	test("password values are never echoed, before or after `--`", () => {
		const error = refusal([
			"r1",
			"--password",
			"hunter2",
			"--cdb-password=vault-key",
			"--",
			"/x",
			"--password",
			"other",
		]);
		expect(error.remediation).not.toContain("hunter2");
		expect(error.remediation).not.toContain("vault-key");
		expect(error.remediation).not.toContain("other");
		expect(error.remediation).toContain("--password '<password>'");
		expect(error.remediation).toContain("'--cdb-password=<password>'");
	});

	test("short aliases and non-flag tokens after `--` stay RouterOS input", () => {
		const parsed = parseExecuteCliArgs([
			"r1",
			"--",
			"/x",
			"-u",
			"-h",
			"--",
			"where",
			"a=--yes",
		]);
		expect(parsed.command).toBe("/x -u -h -- where a=--yes");
	});
});
