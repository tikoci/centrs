import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsReset, settingsSet } from "../../src/settings.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "centrs-settings-file-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function centrsEnvPath(dir: string): string {
	return join(dir, "tikoci", "centrs.env");
}

describe("settingsSet file mechanics", () => {
	test("first write creates the XDG directory and the file", async () => {
		await withTempDir(async (dir) => {
			const nested = join(dir, "does-not-exist-yet");
			await settingsSet({
				attr: "format",
				value: "json",
				env: { XDG_CONFIG_HOME: nested },
			});
			const info = await stat(centrsEnvPath(nested));
			expect(info.isFile()).toBe(true);
		});
	});

	test("a second write to an existing file creates a .bak copy of the prior content", async () => {
		await withTempDir(async (dir) => {
			const env = { XDG_CONFIG_HOME: dir };
			await settingsSet({ attr: "format", value: "text", env });
			await settingsSet({ attr: "format", value: "json", env });
			const backup = await readFile(`${centrsEnvPath(dir)}.bak`, "utf8");
			expect(backup).toBe("CENTRS_FORMAT=text\n");
			const current = await readFile(centrsEnvPath(dir), "utf8");
			expect(current).toBe("CENTRS_FORMAT=json\n");
		});
	});

	test("first write does not create a .bak (nothing existed to back up)", async () => {
		await withTempDir(async (dir) => {
			await settingsSet({
				attr: "format",
				value: "json",
				env: { XDG_CONFIG_HOME: dir },
			});
			expect(await Bun.file(`${centrsEnvPath(dir)}.bak`).exists()).toBe(false);
		});
	});

	test("preserves comments, blank lines, and unrelated keys byte-for-byte", async () => {
		await withTempDir(async (dir) => {
			const path = centrsEnvPath(dir);
			await mkdir(join(dir, "tikoci"), { recursive: true });
			await Bun.write(
				path,
				"# a comment\n\nSOME_OTHER_VAR=untouched\nCENTRS_VIA=ssh\nCENTRS_FORMAT=text\n",
			);
			await settingsSet({
				attr: "format",
				value: "json",
				env: { XDG_CONFIG_HOME: dir },
			});
			const contents = await readFile(path, "utf8");
			expect(contents).toBe(
				"# a comment\n\nSOME_OTHER_VAR=untouched\nCENTRS_VIA=ssh\nCENTRS_FORMAT=json\n",
			);
		});
	});

	test("appends a new managed line without disturbing existing content", async () => {
		await withTempDir(async (dir) => {
			const path = centrsEnvPath(dir);
			await mkdir(join(dir, "tikoci"), { recursive: true });
			await Bun.write(path, "CENTRS_VIA=ssh\n");
			await settingsSet({
				attr: "format",
				value: "json",
				env: { XDG_CONFIG_HOME: dir },
			});
			const contents = await readFile(path, "utf8");
			expect(contents).toBe("CENTRS_VIA=ssh\nCENTRS_FORMAT=json\n");
		});
	});

	test("a file with no trailing newline still round-trips without accumulating blank lines", async () => {
		await withTempDir(async (dir) => {
			const path = centrsEnvPath(dir);
			await mkdir(join(dir, "tikoci"), { recursive: true });
			await Bun.write(path, "CENTRS_VIA=ssh");
			const env = { XDG_CONFIG_HOME: dir };
			await settingsSet({ attr: "format", value: "json", env });
			await settingsSet({ attr: "format", value: "yaml", env });
			const contents = await readFile(path, "utf8");
			expect(contents).toBe("CENTRS_VIA=ssh\nCENTRS_FORMAT=yaml\n");
		});
	});
});

describe("settingsReset file mechanics", () => {
	test("reset deletes the line entirely, never leaves an empty-valued line", async () => {
		await withTempDir(async (dir) => {
			const env = { XDG_CONFIG_HOME: dir };
			await settingsSet({ attr: "format", value: "json", env });
			await settingsReset({ attr: "format", env });
			const contents = await readFile(centrsEnvPath(dir), "utf8");
			expect(contents).toBe("");
			expect(contents).not.toContain("CENTRS_FORMAT=");
		});
	});

	test("reset of one key preserves every other line, including other managed keys", async () => {
		await withTempDir(async (dir) => {
			const path = centrsEnvPath(dir);
			await mkdir(join(dir, "tikoci"), { recursive: true });
			await Bun.write(path, "# keep\nCENTRS_FORMAT=json\nCENTRS_VIA=ssh\n");
			await settingsReset({ attr: "format", env: { XDG_CONFIG_HOME: dir } });
			const contents = await readFile(path, "utf8");
			expect(contents).toBe("# keep\nCENTRS_VIA=ssh\n");
		});
	});

	test("reset-all clears only managed-key lines, leaving comments and foreign vars", async () => {
		await withTempDir(async (dir) => {
			const path = centrsEnvPath(dir);
			await mkdir(join(dir, "tikoci"), { recursive: true });
			await Bun.write(
				path,
				"# keep me\nSOME_OTHER_VAR=untouched\nCENTRS_FORMAT=json\nCENTRS_MAX_RESULTS=250\nCENTRS_VIA=ssh\n",
			);
			const result = await settingsReset({ env: { XDG_CONFIG_HOME: dir } });
			expect(result.data.cleared).toEqual(["format", "max-results", "via"]);
			const contents = await readFile(path, "utf8");
			expect(contents).toBe("# keep me\nSOME_OTHER_VAR=untouched\n");
		});
	});

	test("reset-all is a no-op (no write, no .bak) when nothing managed is set", async () => {
		await withTempDir(async (dir) => {
			const path = centrsEnvPath(dir);
			await mkdir(join(dir, "tikoci"), { recursive: true });
			await Bun.write(path, "SOME_OTHER_VAR=untouched\n");
			const result = await settingsReset({ env: { XDG_CONFIG_HOME: dir } });
			expect(result.data.cleared).toEqual([]);
			expect(await Bun.file(`${path}.bak`).exists()).toBe(false);
			const contents = await readFile(path, "utf8");
			expect(contents).toBe("SOME_OTHER_VAR=untouched\n");
		});
	});

	test("reset on a never-created file is a no-op success, not an error", async () => {
		await withTempDir(async (dir) => {
			const result = await settingsReset({
				attr: "max-results",
				env: { XDG_CONFIG_HOME: dir },
			});
			expect(result.ok).toBe(true);
			expect(result.data.wasSet).toBe(false);
			expect(await Bun.file(centrsEnvPath(dir)).exists()).toBe(false);
		});
	});

	test("refuses a reserved key without touching the file", async () => {
		await withTempDir(async (dir) => {
			const env = { XDG_CONFIG_HOME: dir };
			await settingsSet({ attr: "format", value: "json", env });
			await expect(
				settingsReset({ attr: "cdb-password", env }),
			).rejects.toMatchObject({ code: "settings/reserved-key" });
			const contents = await readFile(centrsEnvPath(dir), "utf8");
			expect(contents).toBe("CENTRS_FORMAT=json\n");
		});
	});
});
