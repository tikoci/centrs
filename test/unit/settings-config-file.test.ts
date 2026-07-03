import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultSettingsPath,
	loadEnvFileDefaults,
	parseEnvFileDefaults,
	readSettingsFileRaw,
} from "../../src/resolver/config-file.ts";

describe("defaultSettingsPath", () => {
	test("honors XDG_CONFIG_HOME when set", () => {
		const path = defaultSettingsPath({ XDG_CONFIG_HOME: "/xdg/config" });
		expect(path).toBe("/xdg/config/tikoci/centrs.env");
	});

	test("falls back to $HOME/.config when XDG_CONFIG_HOME is unset", () => {
		const path = defaultSettingsPath({ HOME: "/home/alice" });
		expect(path).toBe("/home/alice/.config/tikoci/centrs.env");
	});

	test("falls back to os.homedir() when neither is set", () => {
		const path = defaultSettingsPath({});
		expect(path.endsWith("/.config/tikoci/centrs.env")).toBe(true);
	});
});

describe("parseEnvFileDefaults", () => {
	test("parses CENTRS_*=value lines, ignoring blanks and comments", () => {
		const result = parseEnvFileDefaults([
			"# a comment",
			"",
			"CENTRS_FORMAT=json",
			"CENTRS_MAX_RESULTS=250",
		]);
		expect(result).toEqual({
			CENTRS_FORMAT: "json",
			CENTRS_MAX_RESULTS: "250",
		});
	});

	test("skips malformed lines instead of throwing", () => {
		const result = parseEnvFileDefaults([
			"not a valid line",
			"=missing-key",
			"1INVALID=starts-with-digit",
			"CENTRS_VIA=ssh",
		]);
		expect(result).toEqual({ CENTRS_VIA: "ssh" });
	});

	test("last duplicate key wins", () => {
		const result = parseEnvFileDefaults([
			"CENTRS_FORMAT=text",
			"CENTRS_FORMAT=yaml",
		]);
		expect(result).toEqual({ CENTRS_FORMAT: "yaml" });
	});

	test("preserves foreign (non-CENTRS_) keys", () => {
		const result = parseEnvFileDefaults(["SOME_OTHER_VAR=untouched"]);
		expect(result).toEqual({ SOME_OTHER_VAR: "untouched" });
	});
});

describe("readSettingsFileRaw", () => {
	test("reports absent for a missing file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-settings-"));
		try {
			const result = await readSettingsFileRaw(join(dir, "centrs.env"));
			expect(result).toEqual({ exists: false, lines: [] });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("reads an existing file's lines verbatim", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-settings-"));
		try {
			const path = join(dir, "centrs.env");
			await Bun.write(path, "CENTRS_FORMAT=json\nCENTRS_VIA=ssh\n");
			const result = await readSettingsFileRaw(path);
			expect(result.exists).toBe(true);
			expect(result.lines).toEqual([
				"CENTRS_FORMAT=json",
				"CENTRS_VIA=ssh",
				"",
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("loadEnvFileDefaults", () => {
	test("returns {} when no file exists at the resolved path", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-settings-"));
		try {
			const result = await loadEnvFileDefaults({ XDG_CONFIG_HOME: dir });
			expect(result).toEqual({});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("loads and parses a real centrs.env at the XDG path", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-settings-"));
		try {
			await mkdir(join(dir, "tikoci"), { recursive: true });
			await Bun.write(
				join(dir, "tikoci", "centrs.env"),
				"CENTRS_FORMAT=json\nCENTRS_MAX_RESULTS=250\n",
			);
			const result = await loadEnvFileDefaults({ XDG_CONFIG_HOME: dir });
			expect(result).toEqual({
				CENTRS_FORMAT: "json",
				CENTRS_MAX_RESULTS: "250",
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("CENTRS_SKIP_ENV_FILE suppresses the config tier entirely", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-settings-"));
		try {
			await mkdir(join(dir, "tikoci"), { recursive: true });
			await Bun.write(
				join(dir, "tikoci", "centrs.env"),
				"CENTRS_FORMAT=json\n",
			);
			const result = await loadEnvFileDefaults({
				XDG_CONFIG_HOME: dir,
				CENTRS_SKIP_ENV_FILE: "1",
			});
			expect(result).toEqual({});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("CENTRS_SKIP_ENV_FILE accepts any parseBoolean-recognized spelling", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-settings-"));
		try {
			await mkdir(join(dir, "tikoci"), { recursive: true });
			await Bun.write(
				join(dir, "tikoci", "centrs.env"),
				"CENTRS_FORMAT=json\n",
			);
			const result = await loadEnvFileDefaults({
				XDG_CONFIG_HOME: dir,
				CENTRS_SKIP_ENV_FILE: "true",
			});
			expect(result).toEqual({});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("does not throw and treats the file as inert if CENTRS_SKIP_ENV_FILE is not boolean-like", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-settings-"));
		try {
			await mkdir(join(dir, "tikoci"), { recursive: true });
			await Bun.write(
				join(dir, "tikoci", "centrs.env"),
				"CENTRS_FORMAT=json\n",
			);
			const result = await loadEnvFileDefaults({
				XDG_CONFIG_HOME: dir,
				CENTRS_SKIP_ENV_FILE: "banana",
			});
			expect(result).toEqual({ CENTRS_FORMAT: "json" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("strips credential/self-referential keys even if hand-added to the file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-settings-"));
		try {
			await mkdir(join(dir, "tikoci"), { recursive: true });
			await Bun.write(
				join(dir, "tikoci", "centrs.env"),
				[
					"CENTRS_FORMAT=json",
					"CENTRS_PASSWORD=hunter2",
					"CENTRS_USERNAME=admin",
					"CENTRS_CDB_PASSWORD=hunter2",
					"CENTRS_SKIP_ENV_FILE=0",
					"CENTRS_RUN_FAST_INTEGRATION=1",
				].join("\n"),
			);
			const result = await loadEnvFileDefaults({ XDG_CONFIG_HOME: dir });
			expect(result).toEqual({ CENTRS_FORMAT: "json" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
