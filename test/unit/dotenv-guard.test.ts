/**
 * #666: `CENTRS_*` keys that Bun auto-loads from the working directory's
 * `.env` files are stripped before centrs resolves any setting.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bunDotenvFileNames,
	dotenvGuardWarning,
	dotenvKeyNames,
	stripBunDotenvKeys,
} from "../../src/resolver/dotenv-guard.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "centrs-dotenv-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("bunDotenvFileNames (Bun 1.4.4, measured)", () => {
	test("development is the default mode and loads .env.local", () => {
		expect(bunDotenvFileNames(undefined)).toEqual([
			".env",
			".env.development",
			".env.development.local",
			".env.local",
		]);
		expect(bunDotenvFileNames("staging")).toEqual(
			bunDotenvFileNames(undefined),
		);
	});

	test("production and test modes; test skips .env.local", () => {
		expect(bunDotenvFileNames("production")).toContain(".env.production");
		expect(bunDotenvFileNames("production")).toContain(".env.local");
		expect(bunDotenvFileNames("test")).toEqual([
			".env",
			".env.test",
			".env.test.local",
		]);
	});
});

describe("dotenvKeyNames", () => {
	test("reads names only: export prefix, spaces, comments", () => {
		const keys = dotenvKeyNames(
			'# CENTRS_COMMENTED=1\nexport CENTRS_A=1\n  CENTRS_B = "x y"\r\nnot a line\nCENTRS_C=$HOME\n',
		);
		expect([...keys].sort()).toEqual(["CENTRS_A", "CENTRS_B", "CENTRS_C"]);
	});
});

describe("stripBunDotenvKeys", () => {
	test("a .env CENTRS_INSECURE and CENTRS_PASSWORD_FILE have no effect", async () => {
		await writeFile(
			join(dir, ".env"),
			"CENTRS_INSECURE=1\nCENTRS_PASSWORD_FILE=/home/u/.ssh/id_ed25519\nOTHER=1\n",
		);
		const env: Record<string, string | undefined> = {
			CENTRS_INSECURE: "1",
			CENTRS_PASSWORD_FILE: "/home/u/.ssh/id_ed25519",
			OTHER: "1",
		};
		const result = stripBunDotenvKeys({
			env,
			cwd: dir,
			initialEnviron: new Map(),
		});
		expect(result).toEqual({
			ignored: ["CENTRS_INSECURE", "CENTRS_PASSWORD_FILE"],
			files: [".env"],
		});
		expect(env).toEqual({ OTHER: "1" });
	});

	test("a key the process started with is kept (exec-time environ known)", async () => {
		await writeFile(join(dir, ".env"), "CENTRS_INSECURE=1\n");
		await writeFile(join(dir, ".env.local"), "CENTRS_VIA=ssh\n");
		const env: Record<string, string | undefined> = {
			CENTRS_INSECURE: "0",
			CENTRS_VIA: "ssh",
		};
		const result = stripBunDotenvKeys({
			env,
			cwd: dir,
			initialEnviron: new Map([["CENTRS_INSECURE", "0"]]),
		});
		expect(result.ignored).toEqual(["CENTRS_VIA"]);
		expect(result.files).toEqual([".env.local"]);
		expect(env).toEqual({ CENTRS_INSECURE: "0" });
	});

	test("without the exec-time environ, any named key is dropped (fail safe)", async () => {
		await writeFile(join(dir, ".env"), "CENTRS_INSECURE=1\n");
		const env: Record<string, string | undefined> = { CENTRS_INSECURE: "0" };
		const result = stripBunDotenvKeys({
			env,
			cwd: dir,
			initialEnviron: null,
		});
		expect(result.ignored).toEqual(["CENTRS_INSECURE"]);
		expect(env["CENTRS_INSECURE"]).toBeUndefined();
	});

	test("NODE_ENV=test does not consult .env.local", async () => {
		await writeFile(join(dir, ".env.local"), "CENTRS_VIA=ssh\n");
		const env: Record<string, string | undefined> = {
			NODE_ENV: "test",
			CENTRS_VIA: "ssh",
		};
		const result = stripBunDotenvKeys({
			env,
			cwd: dir,
			initialEnviron: new Map(),
		});
		expect(result.ignored).toEqual([]);
		expect(env["CENTRS_VIA"]).toBe("ssh");
	});

	test("no .env files: nothing changes", () => {
		const env: Record<string, string | undefined> = { CENTRS_INSECURE: "1" };
		expect(
			stripBunDotenvKeys({ env, cwd: dir, initialEnviron: new Map() }),
		).toEqual({ ignored: [], files: [] });
		expect(env["CENTRS_INSECURE"]).toBe("1");
	});

	test("the warning names keys and files, never values", () => {
		const line = dotenvGuardWarning({
			ignored: ["CENTRS_CDB_PASSWORD"],
			files: [".env"],
		});
		expect(line).toStartWith("warning [settings/dotenv-ignored]: ");
		expect(line).toContain("CENTRS_CDB_PASSWORD");
		expect(line).toContain(".env");
	});
});
