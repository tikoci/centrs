import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CentrsError } from "../../src/errors.ts";
import { REFUSED_CONFIG_ENV_KEYS } from "../../src/resolver/index.ts";
import {
	settingsGet,
	settingsManagedKeys,
	settingsRefusedKeys,
	settingsSet,
} from "../../src/settings.ts";

const ATTR_NAMES = settingsManagedKeys.map((def) => def.attr);

// Every settingsGet/settingsSet call below must resolve against an isolated
// XDG_CONFIG_HOME, never the real one — these tests exercise validation, not
// file mechanics (see settings-file.test.ts), but every call still touches a
// real centrs.env path internally.
let settingsDir: string;

beforeAll(async () => {
	settingsDir = await mkdtemp(join(tmpdir(), "centrs-settings-registry-"));
});

afterAll(async () => {
	await rm(settingsDir, { recursive: true, force: true });
});

function envWith(
	overrides: Record<string, string> = {},
): Record<string, string> {
	return { XDG_CONFIG_HOME: settingsDir, ...overrides };
}

describe("settingsManagedKeys registry", () => {
	test("covers exactly the 13 keys locked in commands/settings/README.md", () => {
		expect(ATTR_NAMES.sort()).toEqual(
			[
				"cdb-file",
				"format",
				"host",
				"insecure",
				"max-results",
				"mcp-allow-adhoc",
				"port",
				"resolve",
				"ssh-key",
				"timeout",
				"transfer-via",
				"validate",
				"via",
			].sort(),
		);
	});

	test("only format declares a per-command default", () => {
		const withPerCommandDefault = settingsManagedKeys
			.filter((def) => def.hasPerCommandDefault)
			.map((def) => def.attr);
		expect(withPerCommandDefault).toEqual(["format"]);
	});

	test("via, validate, timeout, port, ssh-key, insecure declare their comment-kv counterpart", () => {
		const withCommentKv = settingsManagedKeys
			.filter((def) => def.commentKvKey !== undefined)
			.map((def) => def.attr)
			.sort();
		expect(withCommentKv).toEqual(
			["insecure", "port", "ssh-key", "timeout", "validate", "via"].sort(),
		);
	});
});

describe("settingsRefusedKeys registry", () => {
	test("covers exactly the 5 refused keys", () => {
		expect(settingsRefusedKeys.map((def) => def.attr).sort()).toEqual(
			[
				"cdb-password",
				"password",
				"run-fast-integration",
				"skip-env-file",
				"username",
			].sort(),
		);
	});

	test("only password and cdb-password are secret", () => {
		const secret = settingsRefusedKeys
			.filter((def) => def.secret)
			.map((def) => def.attr)
			.sort();
		expect(secret).toEqual(["cdb-password", "password"].sort());
	});

	test("resolver/config-file.ts's REFUSED_CONFIG_ENV_KEYS stays in sync", () => {
		// Duplicated (not imported) in resolver/config-file.ts to avoid a
		// resolver -> top-level-command import cycle — this guards drift.
		expect([...REFUSED_CONFIG_ENV_KEYS].sort()).toEqual(
			settingsRefusedKeys.map((def) => def.envKey).sort(),
		);
	});
});

describe("settingsSet per-key validation", () => {
	test("format accepts text/json/yaml, rejects anything else", async () => {
		for (const value of ["text", "json", "yaml"]) {
			const result = await settingsSet({
				attr: "format",
				value,
				env: envWith(),
			});
			expect(result.data.value).toBe(value);
		}
		await expect(
			settingsSet({ attr: "format", value: "xml", env: envWith() }),
		).rejects.toMatchObject({ code: "settings/invalid-format" });
	});

	test("max-results and port require a positive integer", async () => {
		for (const attr of ["max-results", "port"]) {
			const ok = await settingsSet({ attr, value: "8080", env: envWith() });
			expect(ok.data.value).toBe(8080);
			// Note: "1.5" is NOT in this list — resolveOptionalIntegerSetting uses
			// Number.parseInt, which truncates rather than rejects ("1.5" -> 1).
			// This is a pre-existing quirk shared by every CENTRS_MAX_RESULTS/
			// CENTRS_PORT consumer, not something settings uniquely introduces or
			// should special-case stricter than the rest of the app.
			for (const bad of ["0", "-1", "abc"]) {
				await expect(
					settingsSet({ attr, value: bad, env: envWith() }),
				).rejects.toMatchObject({ code: "settings/invalid-integer" });
			}
		}
	});

	test("mcp-allow-adhoc, validate, insecure accept every parseBoolean spelling", async () => {
		for (const attr of ["mcp-allow-adhoc", "validate", "insecure"]) {
			for (const spelling of ["true", "yes", "on", "1"]) {
				const result = await settingsSet({
					attr,
					value: spelling,
					env: envWith(),
				});
				expect(result.data.value).toBe(true);
			}
			for (const spelling of ["false", "no", "off", "0"]) {
				const result = await settingsSet({
					attr,
					value: spelling,
					env: envWith(),
				});
				expect(result.data.value).toBe(false);
			}
			await expect(
				settingsSet({ attr, value: "banana", env: envWith() }),
			).rejects.toMatchObject({ code: "settings/invalid-boolean" });
		}
	});

	test("timeout accepts bare ms and suffixed durations, rejects garbage and non-positive", async () => {
		expect(
			(await settingsSet({ attr: "timeout", value: "5000", env: envWith() }))
				.data.value,
		).toBe(5000);
		expect(
			(await settingsSet({ attr: "timeout", value: "5s", env: envWith() })).data
				.value,
		).toBe(5000);
		expect(
			(await settingsSet({ attr: "timeout", value: "500ms", env: envWith() }))
				.data.value,
		).toBe(500);
		expect(
			(await settingsSet({ attr: "timeout", value: "1m", env: envWith() })).data
				.value,
		).toBe(60_000);
		await expect(
			settingsSet({ attr: "timeout", value: "not-a-duration", env: envWith() }),
		).rejects.toMatchObject({ code: "settings/invalid-timeout" });
		await expect(
			settingsSet({ attr: "timeout", value: "0", env: envWith() }),
		).rejects.toMatchObject({ code: "settings/invalid-timeout" });
	});

	test("via accepts every plannedProtocols entry, rejects an unknown identifier", async () => {
		for (const value of ["rest-api", "native-api", "ssh", "mac-telnet"]) {
			const result = await settingsSet({ attr: "via", value, env: envWith() });
			expect(result.data.value).toBe(value);
		}
		await expect(
			settingsSet({ attr: "via", value: "carrier-pigeon", env: envWith() }),
		).rejects.toMatchObject({ code: "settings/invalid-via" });
	});

	test("transfer-via accepts its own value set (distinct from via), warns on ftp", async () => {
		for (const value of ["auto", "rest", "native-api", "sftp"]) {
			const result = await settingsSet({
				attr: "transfer-via",
				value,
				env: envWith(),
			});
			expect(result.data.value).toBe(value);
			expect(result.warnings).toEqual([]);
		}
		const ftp = await settingsSet({
			attr: "transfer-via",
			value: "ftp",
			env: envWith(),
		});
		expect(ftp.data.value).toBe("ftp");
		expect(
			ftp.warnings.some((w) => w.code === "settings/consequential-value"),
		).toBe(true);
		await expect(
			settingsSet({
				attr: "transfer-via",
				value: "carrier-pigeon",
				env: envWith(),
			}),
		).rejects.toMatchObject({ code: "settings/invalid-via" });
	});

	test("resolve accepts none/arp via the shared parseResolvePolicy validator", async () => {
		expect(
			(await settingsSet({ attr: "resolve", value: "none", env: envWith() }))
				.data.value,
		).toBe("none");
		expect(
			(await settingsSet({ attr: "resolve", value: "arp", env: envWith() }))
				.data.value,
		).toBe("arp");
		let caught: CentrsError | undefined;
		try {
			await settingsSet({ attr: "resolve", value: "bogus", env: envWith() });
		} catch (error) {
			caught = error as CentrsError;
		}
		// parseResolvePolicy uses validation/option, not a settings/* code —
		// intentional, see the comment in src/settings.ts's registry entry.
		expect(caught?.code).toBe("validation/option");
	});

	test("cdb-file, ssh-key, host accept any non-blank string", async () => {
		for (const attr of ["cdb-file", "ssh-key", "host"]) {
			const result = await settingsSet({
				attr,
				value: "  /some/path  ",
				env: envWith(),
			});
			expect(result.data.value).toBe("/some/path");
		}
	});

	test("insecure warns only when set to true", async () => {
		const on = await settingsSet({
			attr: "insecure",
			value: "true",
			env: envWith(),
		});
		expect(
			on.warnings.some((w) => w.code === "settings/consequential-value"),
		).toBe(true);
		const off = await settingsSet({
			attr: "insecure",
			value: "false",
			env: envWith(),
		});
		expect(off.warnings).toEqual([]);
	});
});

describe("attr name normalization", () => {
	test("format, FORMAT, centrs_format, CENTRS_FORMAT all resolve to the same key", async () => {
		for (const spelling of [
			"format",
			"FORMAT",
			"centrs_format",
			"CENTRS_FORMAT",
		]) {
			const result = await settingsGet({
				attr: spelling,
				env: envWith({ CENTRS_FORMAT: "json" }),
			});
			expect(result.data.value).toBe("json");
			expect((result.data.source as { key?: string }).key).toBe(
				"CENTRS_FORMAT",
			);
		}
	});

	test("max-results and MAX_RESULTS and CENTRS_MAX_RESULTS all resolve", async () => {
		for (const spelling of [
			"max-results",
			"MAX_RESULTS",
			"CENTRS_MAX_RESULTS",
		]) {
			const result = await settingsGet({
				attr: spelling,
				env: envWith({ CENTRS_MAX_RESULTS: "10" }),
			});
			expect(result.data.value).toBe(10);
		}
	});
});

describe("refused keys", () => {
	test("set/reset refuse every refused key with settings/reserved-key", async () => {
		for (const def of settingsRefusedKeys) {
			await expect(
				settingsSet({ attr: def.attr, value: "x", env: envWith() }),
			).rejects.toMatchObject({ code: "settings/reserved-key" });
		}
	});

	test("get still works read-only on every refused key", async () => {
		for (const def of settingsRefusedKeys) {
			const result = await settingsGet({
				attr: def.attr,
				env: envWith({ [def.envKey]: "some-value" }),
			});
			expect(result.ok).toBe(true);
			if (def.secret) {
				expect(result.data.value).toBe("(redacted)");
			} else {
				expect(result.data.value).toBe("some-value");
			}
		}
	});
});

describe("unknown keys", () => {
	test("get and set both reject a token matching neither registry", async () => {
		await expect(
			settingsGet({ attr: "totally-bogus-key", env: envWith() }),
		).rejects.toMatchObject({ code: "settings/unknown-key" });
		await expect(
			settingsSet({ attr: "totally-bogus-key", value: "x", env: envWith() }),
		).rejects.toMatchObject({ code: "settings/unknown-key" });
	});
});
