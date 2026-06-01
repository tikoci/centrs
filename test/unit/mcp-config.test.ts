import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DEVICE_NAME,
	ENV_ALLOW_ADHOC,
	resolveMcpConfig,
} from "../../src/mcp/config.ts";

describe("resolveMcpConfig", () => {
	test("explicit args win over environment and default", () => {
		const config = resolveMcpConfig({
			cdbFile: "/tmp/explicit.cdb",
			cdbPassword: "arg-secret",
			allowAdhocTargets: true,
			env: {
				CENTRS_CDB_FILE: "/tmp/env.cdb",
				CENTRS_CDB_PASSWORD: "env-secret",
				[ENV_ALLOW_ADHOC]: "1",
			},
		});
		expect(config.cdbFile).toBe("/tmp/explicit.cdb");
		expect(config.cdbFileExplicit).toBe(true);
		expect(config.cdbPassword).toBe("arg-secret");
		expect(config.allowAdhocTargets).toBe(true);
	});

	test("environment fills in when args are omitted", () => {
		const config = resolveMcpConfig({
			env: {
				CENTRS_CDB_FILE: "/tmp/env.cdb",
				CENTRS_CDB_PASSWORD: "env-secret",
				[ENV_ALLOW_ADHOC]: "1",
			},
		});
		expect(config.cdbFile).toBe("/tmp/env.cdb");
		expect(config.cdbFileExplicit).toBe(true);
		expect(config.cdbPassword).toBe("env-secret");
		expect(config.allowAdhocTargets).toBe(true);
	});

	test("defaults are safe: adhoc off, no explicit path, default cdb path", () => {
		const config = resolveMcpConfig({ env: {} });
		expect(config.cdbFileExplicit).toBe(false);
		expect(config.allowAdhocTargets).toBe(false);
		expect(config.cdbPassword).toBeUndefined();
		expect(config.cdbFile.length).toBeGreaterThan(0);
		expect(config.cdbFile.endsWith(".cdb")).toBe(true);
	});

	test("allow-adhoc env toggle only triggers on exactly '1'", () => {
		expect(
			resolveMcpConfig({ env: { [ENV_ALLOW_ADHOC]: "true" } })
				.allowAdhocTargets,
		).toBe(false);
		expect(
			resolveMcpConfig({ env: { [ENV_ALLOW_ADHOC]: "1" } }).allowAdhocTargets,
		).toBe(true);
	});

	test("reserved default-device sentinel name is stable", () => {
		expect(DEFAULT_DEVICE_NAME).toBe("__default__");
	});
});
