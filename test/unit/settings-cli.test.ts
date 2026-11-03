import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSettingsCli } from "../../src/cli/settings.ts";

let dir: string;
let previousXdg: string | undefined;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "centrs-settings-cli-"));
	previousXdg = process.env["XDG_CONFIG_HOME"];
	process.env["XDG_CONFIG_HOME"] = dir;
});

afterAll(async () => {
	if (previousXdg === undefined) {
		delete process.env["XDG_CONFIG_HOME"];
	} else {
		process.env["XDG_CONFIG_HOME"] = previousXdg;
	}
	await rm(dir, { recursive: true, force: true });
});

/**
 * Run the settings CLI with stdout's first write throwing. That stands in for
 * any fault after the arguments parsed, such as #587's renderer crash.
 */
async function runWithFailingStdout(
	args: readonly string[],
): Promise<{ exitCode: number; stderr: string }> {
	const originalLog = console.log;
	const originalError = console.error;
	const errors: string[] = [];
	console.log = (() => {
		throw new TypeError("renderer exploded");
	}) as typeof console.log;
	console.error = ((...parts: unknown[]) => {
		errors.push(parts.map(String).join(" "));
	}) as typeof console.error;
	try {
		const exitCode = await runSettingsCli(args);
		return { exitCode, stderr: errors.join("\n") };
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}
}

describe("settings CLI error classification (#587)", () => {
	test("a fault after parsing is internal/settings-failed, not the caller's input", async () => {
		const result = await runWithFailingStdout(["get", "max-results"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("[internal/settings-failed]");
		expect(result.stderr).toContain("renderer exploded");
		expect(result.stderr).not.toContain("input/invalid-command");
		expect(result.stderr).not.toContain("--help");
	});

	test("a parse failure still reports input/invalid-command", async () => {
		const result = await runWithFailingStdout(["get"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("[input/invalid-command]");
		expect(result.stderr).toContain("centrs settings --help");
	});
});
