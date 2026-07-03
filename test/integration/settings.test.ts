import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../src/cli.ts";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";

interface CapturedOutput {
	logs: string[];
	errors: string[];
	restore(): void;
}

function captureConsole(): CapturedOutput {
	const originalLog = console.log;
	const originalError = console.error;
	const logs: string[] = [];
	const errors: string[] = [];
	console.log = ((...args: unknown[]) => {
		logs.push(args.map((arg) => String(arg)).join(" "));
	}) as typeof console.log;
	console.error = ((...args: unknown[]) => {
		errors.push(args.map((arg) => String(arg)).join(" "));
	}) as typeof console.error;
	return {
		logs,
		errors,
		restore() {
			console.log = originalLog;
			console.error = originalError;
		},
	};
}

async function runWithCapture(args: readonly string[]): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
}> {
	const capture = captureConsole();
	try {
		const exitCode = await runCli(args);
		return {
			exitCode,
			stdout: capture.logs.join("\n"),
			stderr: capture.errors.join("\n"),
		};
	} finally {
		capture.restore();
	}
}

/**
 * Run `centrs settings ...` with `XDG_CONFIG_HOME` (and any extra env vars)
 * injected for the duration of the call, restoring the previous process env
 * afterward — mirrors `devices.test.ts`'s direct `Bun.env` mutation pattern
 * for `CENTRS_VIA` (example 25 there).
 */
async function runSettings(
	args: readonly string[],
	xdgConfigHome: string,
	extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const keys: Record<string, string> = {
		XDG_CONFIG_HOME: xdgConfigHome,
		...extraEnv,
	};
	const previous: Record<string, string | undefined> = {};
	for (const key of Object.keys(keys)) {
		previous[key] = process.env[key];
		process.env[key] = keys[key] as string;
	}
	try {
		return await runWithCapture(["settings", ...args, "--json"]);
	} finally {
		for (const key of Object.keys(keys)) {
			if (previous[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = previous[key];
			}
		}
	}
}

let tempDir: string;

beforeAll(async () => {
	tempDir = join(
		import.meta.dir,
		"..",
		"..",
		".scratch",
		"settings-integration",
	);
	await rm(tempDir, { recursive: true, force: true });
	await mkdir(tempDir, { recursive: true });
});

afterAll(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

/** A fresh, empty XDG_CONFIG_HOME directory, isolated per test. */
async function freshDir(name: string): Promise<string> {
	const dir = join(tempDir, `${name}-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

async function writeCentrsEnv(
	xdgConfigHome: string,
	content: string,
): Promise<string> {
	const dir = join(xdgConfigHome, "tikoci");
	await mkdir(dir, { recursive: true });
	const path = join(dir, "centrs.env");
	await writeFile(path, content);
	return path;
}

function centrsEnvPath(xdgConfigHome: string): string {
	return join(xdgConfigHome, "tikoci", "centrs.env");
}

async function buildDefaultDeviceCdb(dir: string): Promise<string> {
	const path = join(dir, "default.cdb");
	const bytes = encodeOpenWinBoxCdb([
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: "__default__",
			user: "admin",
			password: "fallback-secret",
		}),
	]);
	await writeFile(path, bytes);
	return path;
}

describe("centrs settings print", () => {
	test("example 1: print with no file present", async () => {
		const dir = await freshDir("print-empty");
		const result = await runSettings(["print"], dir);
		expect(result.exitCode).toBe(0);
		const body = JSON.parse(result.stdout);
		expect(body.ok).toBe(true);
		expect(body.data.format).toEqual({
			value: null,
			source: { kind: "default", key: "format" },
			perCommandDefault: {
				retrieve: "text",
				execute: "text",
				transfer: "text",
				api: "json",
			},
		});
		expect(body.data["max-results"]).toEqual({
			value: null,
			source: { kind: "default", key: "max-results" },
		});
	});

	test("example 2: print after a value is set", async () => {
		const dir = await freshDir("print-after-set");
		await runSettings(["set", "format", "json"], dir);
		const result = await runSettings(["print"], dir);
		const body = JSON.parse(result.stdout);
		expect(body.data.format).toEqual({
			value: "json",
			source: { kind: "config", key: "CENTRS_FORMAT" },
		});
		expect(body.data.format.perCommandDefault).toBeUndefined();
	});

	test("example 3: print --all surfaces unrecognized lines", async () => {
		const dir = await freshDir("print-all");
		await writeCentrsEnv(dir, "# my note\nCENTRS_QUUX=5s\n");

		const withAll = await runSettings(["print", "--all"], dir);
		const allBody = JSON.parse(withAll.stdout);
		expect(allBody.data.unrecognized).toEqual([
			{ key: "CENTRS_QUUX", value: "5s" },
		]);

		const bare = await runSettings(["print"], dir);
		const bareBody = JSON.parse(bare.stdout);
		expect(bareBody.data.unrecognized).toBeUndefined();
	});

	test("print --all also surfaces a hand-added refused/credential line, redacted", async () => {
		const dir = await freshDir("print-all-refused");
		await writeCentrsEnv(
			dir,
			"CENTRS_PASSWORD=hunter2\nCENTRS_USERNAME=admin\n",
		);

		const result = await runSettings(["print", "--all"], dir);
		const body = JSON.parse(result.stdout);
		expect(body.data.unrecognized).toEqual(
			expect.arrayContaining([
				{ key: "CENTRS_PASSWORD", value: "(redacted)" },
				{ key: "CENTRS_USERNAME", value: "admin" },
			]),
		);
	});

	test("example 4: print a single attribute", async () => {
		const dir = await freshDir("print-single");
		const result = await runSettings(["print", "max-results"], dir);
		const body = JSON.parse(result.stdout);
		expect(Object.keys(body.data)).toEqual(["max-results"]);
	});

	test("example 5: real env overrides the file", async () => {
		const dir = await freshDir("print-env-override");
		await runSettings(["set", "format", "json"], dir);
		const result = await runSettings(["print", "format"], dir, {
			CENTRS_FORMAT: "yaml",
		});
		const body = JSON.parse(result.stdout);
		expect(body.data.format).toEqual({
			value: "yaml",
			source: { kind: "env", key: "CENTRS_FORMAT" },
		});
	});

	test("example 6: print under --skip-env-file still shows the file", async () => {
		const dir = await freshDir("print-skip-env-file");
		await runSettings(["set", "format", "json"], dir);
		const result = await runSettings(["print", "--skip-env-file"], dir);
		const body = JSON.parse(result.stdout);
		expect(body.ok).toBe(true);
		expect(body.data.format).toEqual({
			value: "json",
			source: { kind: "config", key: "CENTRS_FORMAT" },
		});
		expect(
			body.warnings.some(
				(w: { code: string }) => w.code === "settings/skip-env-file-active",
			),
		).toBe(true);
	});
});

describe("centrs settings get", () => {
	test("example 7: get a key with no override and a per-command default", async () => {
		const dir = await freshDir("get-default");
		const result = await runSettings(["get", "format"], dir);
		const body = JSON.parse(result.stdout);
		expect(body.data.value).toBeNull();
		expect(body.data.source).toEqual({ kind: "default", key: "format" });
		expect(body.data.perCommandDefault).toEqual({
			retrieve: "text",
			execute: "text",
			transfer: "text",
			api: "json",
		});
	});

	test("example 8: get after set returns the resolved value", async () => {
		const dir = await freshDir("get-after-set");
		await runSettings(["set", "max-results", "250"], dir);
		const result = await runSettings(["get", "max-results"], dir);
		const body = JSON.parse(result.stdout);
		expect(body.data).toEqual({
			value: 250,
			source: { kind: "config", key: "CENTRS_MAX_RESULTS" },
		});
	});

	test("example 9: get an unknown key", async () => {
		const dir = await freshDir("get-unknown");
		const result = await runSettings(["get", "totally-bogus-key"], dir);
		expect(result.exitCode).toBe(1);
		const body = JSON.parse(result.stderr);
		expect(body.error.code).toBe("settings/unknown-key");
		expect(body.error.details_url).toBeTruthy();
	});

	test("example 10: get a credential-shaped key redacts the value", async () => {
		const dir = await freshDir("get-secret");
		const result = await runSettings(["get", "cdb-password"], dir, {
			CENTRS_CDB_PASSWORD: "hunter2",
		});
		expect(result.exitCode).toBe(0);
		const body = JSON.parse(result.stdout);
		expect(body.data).toEqual({
			value: "(redacted)",
			isSet: true,
			source: { kind: "env", key: "CENTRS_CDB_PASSWORD" },
		});
		expect(result.stdout).not.toContain("hunter2");
		expect(result.stderr).not.toContain("hunter2");
	});

	test("example 11: get a key that also has a per-device comment-kv form", async () => {
		const dir = await freshDir("get-via-tip");
		await runSettings(["set", "via", "ssh"], dir);
		const result = await runSettings(["get", "via"], dir);
		expect(result.exitCode).toBe(0);
		const body = JSON.parse(result.stdout);
		expect(body.data).toEqual({
			value: "ssh",
			source: { kind: "config", key: "CENTRS_VIA" },
		});
		expect(
			body.tips.some(
				(t: { code: string }) => t.code === "tip/comment-kv-may-override",
			),
		).toBe(true);
	});
});

describe("centrs settings set", () => {
	test("example 12: set a known key (happy path)", async () => {
		const dir = await freshDir("set-happy-path");
		const result = await runSettings(["set", "format", "json"], dir);
		expect(result.exitCode).toBe(0);
		const body = JSON.parse(result.stdout);
		expect(body.data).toEqual({ key: "format", previous: null, value: "json" });
		const contents = await readFile(centrsEnvPath(dir), "utf8");
		expect(contents).toBe("CENTRS_FORMAT=json\n");
	});

	test("example 13: prefix and case are normalized on input, canonical on write", async () => {
		const dir = await freshDir("set-normalize");
		await runSettings(["set", "CENTRS_MAX_RESULTS", "250"], dir);
		const second = await runSettings(["set", "max-results", "250"], dir);
		const body = JSON.parse(second.stdout);
		expect(body.data.previous).toBe(250);
		expect(body.data.value).toBe(250);
		const contents = await readFile(centrsEnvPath(dir), "utf8");
		expect(contents).toBe("CENTRS_MAX_RESULTS=250\n");
	});

	test("example 14: set an invalid value for a typed key", async () => {
		const dir = await freshDir("set-invalid-format");
		const result = await runSettings(["set", "format", "xml"], dir);
		expect(result.exitCode).toBe(1);
		const body = JSON.parse(result.stderr);
		expect(body.error.code).toBe("settings/invalid-format");
		expect(await Bun.file(centrsEnvPath(dir)).exists()).toBe(false);
	});

	test("example 15: first write creates the directory and file", async () => {
		const dir = await freshDir("set-autocreate");
		const nested = join(dir, "does-not-exist-yet");
		const result = await runSettings(["set", "format", "text"], nested);
		expect(result.exitCode).toBe(0);
		const contents = await readFile(centrsEnvPath(nested), "utf8");
		expect(contents).toBe("CENTRS_FORMAT=text\n");
	});

	test("example 16: set preserves unrelated file content", async () => {
		const dir = await freshDir("set-preserves");
		await writeCentrsEnv(
			dir,
			"# personal note, keep me\nCENTRS_VIA=ssh\nCENTRS_FORMAT=text\n",
		);
		await runSettings(["set", "format", "json"], dir);
		const contents = await readFile(centrsEnvPath(dir), "utf8");
		expect(contents).toBe(
			"# personal note, keep me\nCENTRS_VIA=ssh\nCENTRS_FORMAT=json\n",
		);
	});

	test("example 17: set a refused credential key", async () => {
		const dir = await freshDir("set-refused");
		const result = await runSettings(["set", "cdb-password", "hunter2"], dir);
		expect(result.exitCode).toBe(1);
		const body = JSON.parse(result.stderr);
		expect(body.error.code).toBe("settings/reserved-key");
		expect(body.error.remediation).toMatch(
			/--cdb-password|CENTRS_CDB_PASSWORD|Bun\.secret/,
		);
		expect(await Bun.file(centrsEnvPath(dir)).exists()).toBe(false);
		expect(result.stdout).not.toContain("hunter2");
		expect(result.stderr).not.toContain("hunter2");
	});

	test("example 18: set a comment-kv-shadowed key is a normal validated write", async () => {
		const dir = await freshDir("set-validate");
		const result = await runSettings(["set", "validate", "false"], dir);
		expect(result.exitCode).toBe(0);
		const body = JSON.parse(result.stdout);
		expect(body.data).toEqual({
			key: "validate",
			previous: null,
			value: false,
		});
		expect(body.warnings).toEqual([]);
	});

	test("example 19: set an unrecognized key name", async () => {
		const dir = await freshDir("set-unknown");
		const result = await runSettings(
			["set", "totally-bogus-key", "value"],
			dir,
		);
		expect(result.exitCode).toBe(1);
		const body = JSON.parse(result.stderr);
		expect(body.error.code).toBe("settings/unknown-key");
		expect(await Bun.file(centrsEnvPath(dir)).exists()).toBe(false);
	});

	test("example 20: set a typed integer key out of range", async () => {
		const dir = await freshDir("set-integer-range");
		for (const value of ["0", "-1", "abc"]) {
			const result = await runSettings(["set", "max-results", value], dir);
			expect(result.exitCode).toBe(1);
			const body = JSON.parse(result.stderr);
			expect(body.error.code).toBe("settings/invalid-integer");
		}
	});

	test("example 21: set an invalid protocol identifier", async () => {
		const dir = await freshDir("set-invalid-via");
		const result = await runSettings(["set", "via", "carrier-pigeon"], dir);
		expect(result.exitCode).toBe(1);
		const body = JSON.parse(result.stderr);
		expect(body.error.code).toBe("settings/invalid-via");
		expect(await Bun.file(centrsEnvPath(dir)).exists()).toBe(false);
	});

	test("example 22: set an invalid duration", async () => {
		const dir = await freshDir("set-invalid-timeout");
		const result = await runSettings(["set", "timeout", "not-a-duration"], dir);
		expect(result.exitCode).toBe(1);
		const body = JSON.parse(result.stderr);
		expect(body.error.code).toBe("settings/invalid-timeout");
		expect(await Bun.file(centrsEnvPath(dir)).exists()).toBe(false);
	});

	test("example 23: boolean values are written in canonical 1/0 form", async () => {
		const dir = await freshDir("set-boolean-canonical");
		const result = await runSettings(["set", "mcp-allow-adhoc", "true"], dir);
		expect(result.exitCode).toBe(0);
		const contents = await readFile(centrsEnvPath(dir), "utf8");
		expect(contents).toBe("CENTRS_MCP_ALLOW_ADHOC=1\n");
		const got = await runSettings(["get", "mcp-allow-adhoc"], dir);
		const gotBody = JSON.parse(got.stdout);
		expect(gotBody.data.value).toBe(true);
		expect(gotBody.data.source.kind).toBe("config");
	});

	test("example 24: a value that will fail later still gets a warning now", async () => {
		const dir = await freshDir("set-consequential");
		const result = await runSettings(["set", "transfer-via", "ftp"], dir);
		expect(result.exitCode).toBe(0);
		const body = JSON.parse(result.stdout);
		expect(body.ok).toBe(true);
		expect(
			body.warnings.some(
				(w: { code: string }) => w.code === "settings/consequential-value",
			),
		).toBe(true);
		const contents = await readFile(centrsEnvPath(dir), "utf8");
		expect(contents).toBe("CENTRS_TRANSFER_VIA=ftp\n");
	});

	test("example 25: re-setting the same value is idempotent", async () => {
		const dir = await freshDir("set-idempotent");
		await runSettings(["set", "format", "json"], dir);
		const second = await runSettings(["set", "format", "json"], dir);
		const body = JSON.parse(second.stdout);
		expect(body.data.previous).toBe(body.data.value);
		const contents = await readFile(centrsEnvPath(dir), "utf8");
		expect(contents).toBe("CENTRS_FORMAT=json\n");
	});
});

describe("centrs settings reset", () => {
	test("example 26: reset removes the line, not just its value", async () => {
		const dir = await freshDir("reset-line");
		await runSettings(["set", "format", "json"], dir);
		const result = await runSettings(["reset", "format"], dir);
		expect(result.exitCode).toBe(0);
		const contents = await readFile(centrsEnvPath(dir), "utf8");
		expect(contents).toBe("");
		const got = await runSettings(["get", "format"], dir);
		const gotBody = JSON.parse(got.stdout);
		expect(gotBody.data.source).toEqual({ kind: "default", key: "format" });
	});

	test("example 27: reset on a key that was never set is a no-op success", async () => {
		const dir = await freshDir("reset-noop");
		const result = await runSettings(["reset", "max-results"], dir);
		expect(result.exitCode).toBe(0);
		const body = JSON.parse(result.stdout);
		expect(body.data.wasSet).toBe(false);
	});

	test("example 28: reset with no attribute clears every managed key, leaves the rest", async () => {
		const dir = await freshDir("reset-all");
		await writeCentrsEnv(
			dir,
			"# keep me\nSOME_OTHER_VAR=untouched\nCENTRS_FORMAT=json\nCENTRS_MAX_RESULTS=250\nCENTRS_VIA=ssh\n",
		);
		const result = await runSettings(["reset"], dir);
		expect(result.exitCode).toBe(0);
		const body = JSON.parse(result.stdout);
		expect(body.data.cleared).toEqual(["format", "max-results", "via"]);
		const contents = await readFile(centrsEnvPath(dir), "utf8");
		expect(contents).toBe("# keep me\nSOME_OTHER_VAR=untouched\n");
	});

	test("example 29: reset also refuses credential keys", async () => {
		const dir = await freshDir("reset-refused");
		const result = await runSettings(["reset", "cdb-password"], dir);
		expect(result.exitCode).toBe(1);
		const body = JSON.parse(result.stderr);
		expect(body.error.code).toBe("settings/reserved-key");
	});
});

describe("centrs settings interactive / non-TTY", () => {
	test("example 30: bare settings under non-TTY behaves like print", async () => {
		const dir = await freshDir("bare-non-tty");
		const result = await runSettings([], dir);
		expect(result.exitCode).toBe(0);
		const body = JSON.parse(result.stdout);
		expect(body.ok).toBe(true);
		expect(body.meta.operation.command).toBe("print");
	});
});

describe("centrs settings __default__ boundary", () => {
	test("example 31: print reports __default__ presence without leaking secrets", async () => {
		const dir = await freshDir("default-device-present");
		const cdbPath = await buildDefaultDeviceCdb(dir);
		const result = await runSettings(["print", "--cdb-file", cdbPath], dir);
		expect(result.exitCode).toBe(0);
		const body = JSON.parse(result.stdout);
		expect(body.data.defaultDevice).toEqual({
			configured: true,
			user: "admin",
			passwordSet: true,
		});
		expect(result.stdout).not.toContain("fallback-secret");
	});

	test("example 32: print with no __default__ record", async () => {
		const dir = await freshDir("default-device-absent");
		// Sandboxed under `dir` (not a raw "/tmp/..." literal): CodeQL's
		// js/insecure-temporary-file source model treats any string matching
		// `/tmp/%` as an os-temp-dir source, which taints every unguarded
		// fs-write sink reachable from CLI argv. Nothing here needs a real
		// temp dir — the file is never created.
		const cdbFile = join(dir, "does-not-exist.cdb");
		const result = await runSettings(["print", "--cdb-file", cdbFile], dir);
		expect(result.exitCode).toBe(0);
		const body = JSON.parse(result.stdout);
		expect(body.data.defaultDevice).toEqual({ configured: false });
	});
});
