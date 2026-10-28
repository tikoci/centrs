import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultCdbPath } from "../../src/devices.ts";
import { defaultSettingsPath } from "../../src/resolver/config-file.ts";
import { isChrIntegrationEnabled } from "../integration/chr.ts";
import { HERMETIC_ENV } from "./hermetic-env.ts";

// The preload below only sandboxes ambient paths when CHR integration is
// off; integration runs keep the real HOME, so there is nothing to assert.
const describeHermetic = isChrIntegrationEnabled() ? describe.skip : describe;

describeHermetic("unit-tier hermetic home (#550)", () => {
	test("the preload sandboxes ambient HOME and XDG_CONFIG_HOME", () => {
		expect(Bun.env["HOME"]?.includes("centrs-unit-home-")).toBe(true);
		expect(Bun.env["XDG_CONFIG_HOME"]).toBe(
			join(Bun.env["HOME"] ?? "", ".config"),
		);
		// Bun resolves os.homedir() at startup, so it still names the real
		// home: the sandbox only covers paths derived from the env maps.
		expect(Bun.env["HOME"]).not.toBe(homedir());
	});

	test("ambient-path resolution lands in the sandbox", () => {
		// Exact paths, built with `join` exactly as production builds them:
		// a `/`-joined expectation breaks on Windows, where `join` emits `\`.
		expect(defaultCdbPath(Bun.env)).toBe(
			join(Bun.env["HOME"] ?? "", ".config/tikoci/winbox.cdb"),
		);
		expect(defaultSettingsPath(Bun.env)).toBe(
			join(Bun.env["XDG_CONFIG_HOME"] ?? "", "tikoci", "centrs.env"),
		);
	});

	test("the shared fixture env resolves nowhere real", () => {
		expect(HERMETIC_ENV).toEqual({
			CENTRS_SKIP_ENV_FILE: "1",
			HOME: "/nonexistent-centrs-550",
		});
		expect(defaultCdbPath(HERMETIC_ENV)).toBe(
			join("/nonexistent-centrs-550", ".config/tikoci/winbox.cdb"),
		);
		expect(defaultSettingsPath(HERMETIC_ENV)).toBe(
			join(join("/nonexistent-centrs-550", ".config"), "tikoci", "centrs.env"),
		);
	});
});
