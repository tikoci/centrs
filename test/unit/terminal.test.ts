import { describe, expect, test } from "bun:test";
import { parseTerminalCliArgs } from "../../src/cli/terminal.ts";
import { CentrsError } from "../../src/errors.ts";
import {
	buildSshTerminalArgv,
	buildTerminalErrorEnvelope,
	resolveTerminalRequest,
} from "../../src/index.ts";

const MAC = "aa:bb:cc:dd:ee:ff";
const noEnv: Record<string, string | undefined> = {};

describe("terminal rejects a multi-target selection (single-session)", () => {
	for (const flag of [
		"--group",
		"--where",
		"--all",
		"--default",
		"--concurrency",
	]) {
		test(`\`terminal ${flag}\` → usage/fanout-not-supported`, () => {
			try {
				parseTerminalCliArgs(["r1", flag, "x"]);
				throw new Error("expected a throw");
			} catch (error) {
				expect(error).toBeInstanceOf(CentrsError);
				expect((error as CentrsError).code).toBe("usage/fanout-not-supported");
			}
		});
	}
});

/**
 * The transport gate is evaluated before any CDB load, so these assertions are
 * hermetic (no device-registry lookup) and deterministic regardless of any local
 * WinBox CDB. The mac-telnet relay is proven on CHR in
 * `test/integration/terminal-mac-telnet.test.ts` and the ssh relay in
 * `test/integration/terminal-ssh.test.ts`.
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

/**
 * `--resolve` (JG-01): a MAC target over the IP transport (`--via ssh`) needs an
 * IP. The default policy is CDB-first, then an actionable error that leads with
 * the L2 alternative — never a silent ARP. The mac-telnet default ignores the
 * MAC→IP step entirely (it addresses the MAC directly).
 */
describe("resolveTerminalRequest MAC→IP resolution (--resolve)", () => {
	test("MAC + --via ssh with no CDB record errors, no silent ARP", async () => {
		const error = await resolveTerminalRequest(
			{ targetInput: MAC, via: "ssh" },
			noEnv,
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(CentrsError);
		expect((error as CentrsError).code).toBe("target/mac-unresolved");
		// The terminal tip leads with the L2 alternative.
		expect((error as CentrsError).remediation).toContain("--via mac-telnet");
		expect((error as CentrsError).remediation).toContain("--resolve arp");
	});

	test("MAC + --via mac-telnet ignores --resolve (addresses the MAC directly)", async () => {
		// `--resolve arp` on the L2 default is a no-op: mac-telnet never does the
		// MAC→IP step, so resolution succeeds and the MAC is the target.
		const resolved = await resolveTerminalRequest(
			{ targetInput: MAC, via: "mac-telnet", resolve: "arp" },
			noEnv,
		);
		expect(resolved.via).toBe("mac-telnet");
		expect(resolved.target.mac).toBe(MAC);
	});

	test("an unknown --resolve value is rejected", async () => {
		await expect(
			resolveTerminalRequest(
				{ targetInput: MAC, via: "ssh", resolve: "dns" },
				noEnv,
			),
		).rejects.toMatchObject({ code: "validation/option" });
	});
});

type ResolvedTerminal = Parameters<typeof buildSshTerminalArgv>[0];

function resolvedSsh(
	over: { sshKey?: string; insecure?: boolean; username?: string } = {},
): ResolvedTerminal {
	return {
		via: "ssh",
		target: { host: "192.0.2.10", port: 2222 },
		auth: { username: over.username ?? "admin", sshKey: over.sshKey },
		insecure: over.insecure ?? false,
		warnings: [],
	} as unknown as ResolvedTerminal;
}

describe("buildSshTerminalArgv", () => {
	test("secure default: `ssh -p <port> <key/trust> user@host`, no command", () => {
		const argv = buildSshTerminalArgv(resolvedSsh({ sshKey: "/k/id" }));
		expect(argv[0]).toBe("ssh");
		expect(argv).toContain("-p");
		expect(argv).toContain("2222");
		expect(argv).toContain("-i");
		expect(argv).toContain("/k/id");
		expect(argv.join(" ")).toContain("StrictHostKeyChecking=accept-new");
		// Last token is the host (no trailing command — interactive console); no -t.
		expect(argv.at(-1)).toBe("admin@192.0.2.10");
		expect(argv).not.toContain("-t");
		expect(argv).not.toContain("-tt");
		// Interactive: no BatchMode, so ssh can prompt for a passphrase/password.
		expect(argv.join(" ")).not.toContain("BatchMode=yes");
	});

	test("insecure disables host-key checking", () => {
		const argv = buildSshTerminalArgv(resolvedSsh({ insecure: true })).join(
			" ",
		);
		expect(argv).toContain("StrictHostKeyChecking=no");
	});

	test("no key: still `user@host` last, agent/ssh-config used", () => {
		const argv = buildSshTerminalArgv(resolvedSsh());
		expect(argv).not.toContain("-i");
		expect(argv.at(-1)).toBe("admin@192.0.2.10");
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
