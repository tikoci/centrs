import { describe, expect, test } from "bun:test";
import { parseExecuteCliArgs } from "../../src/cli/execute.ts";

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

	test("after `--`, centrs flags are taken literally, not parsed", () => {
		const parsed = parseExecuteCliArgs(["router", "--", "/ip/x", "--json"]);
		// `--json` lands in the command, not the format selector.
		expect(parsed.command).toBe("/ip/x --json");
		expect(parsed.format).toBeUndefined();
	});

	test("flags before `--` still parse; `--` only stops what follows", () => {
		const parsed = parseExecuteCliArgs([
			"--json",
			"router",
			"--",
			"/ip/x",
			"--verbose",
		]);
		expect(parsed.format).toBe("json");
		expect(parsed.verbose).toBeUndefined();
		expect(parsed.command).toBe("/ip/x --verbose");
	});

	test("the `--` token itself is consumed, not part of the command", () => {
		const parsed = parseExecuteCliArgs(["router", "--", "/ip/x"]);
		expect(parsed.command).toBe("/ip/x");
		expect(parsed.command.includes("--")).toBe(false);
	});
});
