/**
 * #666: a working directory's `.env` never reaches centrs. When Bun loaded
 * one, the entry re-launches under `bun --no-env-file` with the environment
 * it was started with (`planDotenvRelaunch`). Subprocess coverage, including
 * Bun's own startup settings, is in `test/integration/cli-smoke.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	dotenvGuardWarning,
	dotenvKeyNames,
	planDotenvRelaunch,
} from "../../src/resolver/dotenv-guard.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "centrs-dotenv-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("dotenvKeyNames", () => {
	test("reads names only: export, spaces, colon form, CR-only lines", () => {
		const keys = dotenvKeyNames(
			'# CENTRS_COMMENTED=1\nexport CENTRS_A=1\n  CENTRS_B = "x y"\r\nCENTRS_C: colon\rCENTRS_D=cr\rnot a line\n',
		);
		expect([...keys].sort()).toEqual([
			"CENTRS_A",
			"CENTRS_B",
			"CENTRS_C",
			"CENTRS_D",
		]);
	});
});

describe("planDotenvRelaunch with the exec-time environment (Linux)", () => {
	test("any key Bun added or changed is dropped; the child gets the launch env", () => {
		const plan = planDotenvRelaunch({
			env: {
				PATH: "/bin",
				CENTRS_INSECURE: "1",
				XDG_CONFIG_HOME: "/repo/cfg",
				BUN_CONFIG_VERBOSE_FETCH: "curl",
				NODE_ENV: "test",
			},
			execArgv: [],
			initialEnviron: new Map([["PATH", "/bin"]]),
		});
		expect(plan?.env).toEqual({ PATH: "/bin" });
		expect(plan?.dropped).toEqual([
			"BUN_CONFIG_VERBOSE_FETCH",
			"CENTRS_INSECURE",
			"NODE_ENV",
			"XDG_CONFIG_HOME",
		]);
	});

	test("an unchanged environment runs in place", () => {
		expect(
			planDotenvRelaunch({
				env: { CENTRS_INSECURE: "0" },
				execArgv: [],
				initialEnviron: new Map([["CENTRS_INSECURE", "0"]]),
			}),
		).toBeUndefined();
	});

	test("an already --no-env-file process never re-launches", () => {
		expect(
			planDotenvRelaunch({
				env: { CENTRS_INSECURE: "1" },
				execArgv: ["--no-env-file"],
				initialEnviron: new Map(),
			}),
		).toBeUndefined();
	});
});

describe("planDotenvRelaunch without it (macOS, Windows)", () => {
	test("keys any Bun .env file names are dropped, whatever NODE_ENV says now", async () => {
		await writeFile(join(dir, ".env"), "NODE_ENV=test\nPATH=/evil\n");
		await writeFile(
			join(dir, ".env.development"),
			"CENTRS_FORMAT=json\nXDG_CONFIG_HOME=/repo\n",
		);
		await writeFile(
			join(dir, ".env.local"),
			"BUN_CONFIG_VERBOSE_FETCH: curl\r",
		);
		const plan = planDotenvRelaunch({
			env: {
				PATH: "/usr/bin",
				NODE_ENV: "test",
				CENTRS_FORMAT: "json",
				XDG_CONFIG_HOME: "/repo",
				BUN_CONFIG_VERBOSE_FETCH: "curl",
				CENTRS_VIA: "ssh",
			},
			cwd: dir,
			execArgv: [],
			initialEnviron: null,
		});
		expect(plan?.dropped).toEqual([
			"BUN_CONFIG_VERBOSE_FETCH",
			"CENTRS_FORMAT",
			"NODE_ENV",
			"XDG_CONFIG_HOME",
		]);
		// PATH keeps the shell's value, which already beat the file's.
		expect(plan?.env).toEqual({ PATH: "/usr/bin", CENTRS_VIA: "ssh" });
	});

	test("no .env files: run in place", () => {
		expect(
			planDotenvRelaunch({
				env: { CENTRS_INSECURE: "1" },
				cwd: dir,
				execArgv: [],
				initialEnviron: null,
			}),
		).toBeUndefined();
	});
});

describe("dotenvGuardWarning", () => {
	test("names CENTRS_* keys only, never values; silent otherwise", () => {
		const line = dotenvGuardWarning({
			env: {},
			dropped: ["CENTRS_CDB_PASSWORD_FILE", "DATABASE_URL"],
		});
		expect(line).toStartWith("warning [settings/dotenv-ignored]: ");
		expect(line).toContain("CENTRS_CDB_PASSWORD_FILE");
		expect(line).not.toContain("DATABASE_URL");
		expect(
			dotenvGuardWarning({ env: {}, dropped: ["DATABASE_URL"] }),
		).toBeUndefined();
	});
});
