import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	buildTerminalErrorEnvelope,
	resolveTerminalRequest,
} from "../../src/index.ts";

const MAC = "aa:bb:cc:dd:ee:ff";
const noEnv: Record<string, string | undefined> = {};

/**
 * The transport gate is evaluated before any CDB load, so these assertions are
 * hermetic (no device-registry lookup) and deterministic regardless of any local
 * WinBox CDB. The mac-telnet relay itself is proven on CHR in
 * `test/integration/terminal-mac-telnet.test.ts` (T1–T3).
 */
describe("resolveTerminalRequest transport gate", () => {
	test("rest-api has no terminal capability", async () => {
		await expect(
			resolveTerminalRequest({ targetInput: MAC, via: "rest-api" }, noEnv),
		).rejects.toMatchObject({ code: "transport/capability-unsupported" });
	});

	test("native-api has no terminal capability", async () => {
		await expect(
			resolveTerminalRequest({ targetInput: MAC, via: "native-api" }, noEnv),
		).rejects.toMatchObject({ code: "transport/capability-unsupported" });
	});

	test("ssh terminal is not wired yet", async () => {
		await expect(
			resolveTerminalRequest({ targetInput: MAC, via: "ssh" }, noEnv),
		).rejects.toMatchObject({ code: "usage/not-implemented" });
	});

	test("an unknown transport is rejected", async () => {
		await expect(
			resolveTerminalRequest({ targetInput: MAC, via: "winbox" }, noEnv),
		).rejects.toMatchObject({ code: "settings/invalid-via" });
	});

	test("CENTRS_VIA=rest-api is gated the same way", async () => {
		await expect(
			resolveTerminalRequest({ targetInput: MAC }, { CENTRS_VIA: "rest-api" }),
		).rejects.toMatchObject({ code: "transport/capability-unsupported" });
	});
});

describe("buildTerminalErrorEnvelope", () => {
	test("wraps a CentrsError as an ok:false envelope carrying the code", () => {
		const envelope = buildTerminalErrorEnvelope(
			new CentrsError({
				code: "transport/capability-unsupported",
				summary: "native-api has no terminal capability.",
				remediation: "Use mac-telnet.",
			}),
		);
		expect(envelope.ok).toBe(false);
		expect(envelope.error.code).toBe("transport/capability-unsupported");
		expect(envelope.warnings).toEqual([]);
		expect(envelope.tips).toEqual([]);
	});

	test("wraps a non-CentrsError as internal/unhandled", () => {
		const envelope = buildTerminalErrorEnvelope(new Error("boom"));
		expect(envelope.ok).toBe(false);
		expect(envelope.error.code).toBe("internal/unhandled");
	});
});
