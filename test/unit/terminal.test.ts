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
 * `--quickchr <name>` (#610): one machine is a single-target session, not a
 * fan-out. A repeat is fan-out (rejected); a <router> positional is a second
 * target source (usage conflict). The provider path itself is in
 * `resolveTerminalRequest --quickchr` below and on CHR in
 * `test/integration/quickchr-target.test.ts` (TQ1–TQ2).
 */
describe("terminal --quickchr parsing (#610)", () => {
	test("one --quickchr is a single target, not usage/fanout-not-supported", () => {
		const parsed = parseTerminalCliArgs(["--quickchr", "lab", "--json"]);
		expect(parsed.request.quickchr).toBe("lab");
		expect(parsed.request.targetInput).toBeUndefined();
	});

	test("repeated --quickchr → usage/fanout-not-supported naming the machines", () => {
		const error = (() => {
			try {
				parseTerminalCliArgs(["--quickchr", "lab", "--quickchr", "edge"]);
			} catch (caught) {
				return caught;
			}
			return undefined;
		})();
		expect(error).toBeInstanceOf(CentrsError);
		expect((error as CentrsError).code).toBe("usage/fanout-not-supported");
		expect((error as CentrsError).context).toMatchObject({
			flag: "--quickchr",
			machines: ["lab", "edge"],
		});
	});

	test("--quickchr + a <router> positional → usage/conflicting-flags", () => {
		expect(() => parseTerminalCliArgs(["r1", "--quickchr", "lab"])).toThrow(
			expect.objectContaining({ code: "usage/conflicting-flags" }),
		);
	});

	test("--quickchr needs a value", () => {
		expect(() => parseTerminalCliArgs(["--quickchr"])).toThrow(
			"Missing value for --quickchr",
		);
	});
});

function quickchrResolution(
	ssh: Record<string, unknown> | undefined = {
		available: true,
		host: "127.0.0.1",
		port: 9122,
		transport: "tcp",
		tls: false,
		auth: {
			username: "quickchr",
			privateKeyPath: "/q/lab/id_ed25519",
			modes: ["private-key", "agent-or-config", "password"],
			batchModes: ["private-key"],
			passwordAvailable: true,
		},
	},
) {
	return async (name: string) =>
		({
			name,
			services: {
				"rest-api": {
					available: true,
					host: "127.0.0.1",
					port: 9100,
					transport: "tcp",
					tls: false,
					auth: { username: "quickchr", password: "secret" },
				},
				...(ssh ? { ssh } : {}),
			},
			descriptorVersion: 1,
			routerOsVersion: "7.25.1",
			arch: "x86_64",
		}) as never;
}

describe("resolveTerminalRequest --quickchr (#610)", () => {
	test("defaults to ssh; host/port/user/key come from the descriptor with provider provenance", async () => {
		const resolved = await resolveTerminalRequest({ quickchr: "lab" }, noEnv, {
			resolveQuickchr: quickchrResolution(),
		});
		expect(resolved.via).toBe("ssh");
		expect(resolved.target.host).toBe("127.0.0.1");
		expect(resolved.target.port).toBe(9122);
		expect(resolved.target.source.kind).toBe("provider");
		expect(resolved.auth.username).toBe("quickchr");
		expect(resolved.auth.sshKey).toBe("/q/lab/id_ed25519");
		// Ephemeral VM host key: trusted by provenance, surfaced as a warning.
		expect(resolved.insecure).toBe(true);
		expect(resolved.warnings.map((w) => w.code)).toEqual([
			"transport/provider-trust",
		]);
		const argv = buildSshTerminalArgv(resolved).join(" ");
		expect(argv).toContain("-p 9122");
		expect(argv).toContain("-i /q/lab/id_ed25519 -o IdentitiesOnly=yes");
		expect(argv).toContain("StrictHostKeyChecking=no");
		expect(argv.endsWith("quickchr@127.0.0.1")).toBe(true);
		expect(argv).not.toContain("BatchMode=yes");
	});

	test("ambient env/config connection facts are bypassed", async () => {
		const resolved = await resolveTerminalRequest(
			{ quickchr: "lab" },
			{
				CENTRS_SKIP_ENV_FILE: "1",
				CENTRS_HOST: "192.0.2.99",
				CENTRS_USERNAME: "ambient",
				CENTRS_SSH_KEY: "/ambient/key",
			},
			{ resolveQuickchr: quickchrResolution() },
		);
		expect(resolved.target.host).toBe("127.0.0.1");
		expect(resolved.auth.username).toBe("quickchr");
		expect(resolved.auth.sshKey).toBe("/q/lab/id_ed25519");
	});

	test("--via mac-telnet is quickchr/unsupported-via, never swapped to ssh", async () => {
		await expect(
			resolveTerminalRequest({ quickchr: "lab", via: "mac-telnet" }, noEnv, {
				resolveQuickchr: quickchrResolution(),
			}),
		).rejects.toMatchObject({ code: "quickchr/unsupported-via" });
	});

	test("--via rest-api is gated before any machine lookup", async () => {
		let looked = false;
		await expect(
			resolveTerminalRequest({ quickchr: "lab", via: "rest-api" }, noEnv, {
				resolveQuickchr: async (name) => {
					looked = true;
					return quickchrResolution()(name);
				},
			}),
		).rejects.toMatchObject({ code: "transport/capability-unsupported" });
		expect(looked).toBe(false);
	});

	test("an SSH endpoint without a verified key is quickchr/ssh-auth-unavailable (no ambient agent login)", async () => {
		await expect(
			resolveTerminalRequest({ quickchr: "lab" }, noEnv, {
				resolveQuickchr: quickchrResolution({
					available: true,
					host: "127.0.0.1",
					port: 9122,
					transport: "tcp",
					tls: false,
					auth: {
						username: "quickchr",
						modes: ["agent-or-config", "password"],
						batchModes: [],
					},
				}),
			}),
		).rejects.toMatchObject({ code: "quickchr/ssh-auth-unavailable" });
	});

	test("the no-key remediation names terminal routes, not rest-api/native-api", async () => {
		const error = await resolveTerminalRequest({ quickchr: "lab" }, noEnv, {
			resolveQuickchr: quickchrResolution({
				available: true,
				host: "127.0.0.1",
				port: 9122,
				transport: "tcp",
				tls: false,
				auth: {
					username: "admin",
					modes: ["agent-or-config", "password"],
					batchModes: [],
				},
			}),
		}).then(
			() => {
				throw new Error("expected a throw");
			},
			(caught: unknown) => caught as CentrsError,
		);
		expect(error).toBeInstanceOf(CentrsError);
		expect(error.code).toBe("quickchr/ssh-auth-unavailable");
		expect(error.remediation).toContain("--secure-login");
		expect(error.remediation).toContain(
			`centrs execute --quickchr lab '/user/ssh-keys/add user=admin key="<public key>"' --yes`,
		);
		expect(error.remediation).toContain(
			"centrs terminal --host 127.0.0.1 --port 9122 --username admin --ssh-key <private key> --insecure",
		);
		// No terminal-incapable alternative, and no password-prompt route.
		expect(error.remediation).not.toContain("rest-api");
		expect(error.remediation).not.toContain("prompt");
		expect(error.context).toMatchObject({
			command: "terminal",
			via: "ssh",
			port: 9122,
			username: "admin",
		});
	});

	test("the --via mac-telnet remediation points back at ssh", async () => {
		const error = await resolveTerminalRequest(
			{ quickchr: "lab", via: "mac-telnet" },
			noEnv,
			{ resolveQuickchr: quickchrResolution() },
		).then(
			() => {
				throw new Error("expected a throw");
			},
			(caught: unknown) => caught as CentrsError,
		);
		expect(error.remediation).toContain("drop `--via mac-telnet`");
		expect(error.remediation).not.toContain("rest-api");
	});

	test("an unavailable SSH service is quickchr/unsupported-via", async () => {
		await expect(
			resolveTerminalRequest({ quickchr: "lab" }, noEnv, {
				resolveQuickchr: quickchrResolution({
					available: false,
					unavailableReason: "no forwarded port for ssh",
				}),
			}),
		).rejects.toMatchObject({ code: "quickchr/unsupported-via" });
	});

	for (const [field, value, flag] of [
		["host", "192.0.2.1", "--host"],
		["port", 22, "--port"],
		["username", "admin", "--username"],
		["password", "x", "--password"],
		["sshKey", "/k", "--ssh-key"],
		["match", "user=admin", "--match"],
	] as const) {
		test(`${flag} conflicts before any machine lookup`, async () => {
			let looked = false;
			const error = await resolveTerminalRequest(
				{ quickchr: "lab", [field]: value },
				noEnv,
				{
					resolveQuickchr: async (name) => {
						looked = true;
						return quickchrResolution()(name);
					},
				},
			).catch((caught: unknown) => caught);
			expect(error).toMatchObject({
				code: "usage/conflicting-flags",
				context: { conflicts: [flag] },
			});
			expect(looked).toBe(false);
		});
	}

	test("an unregistered machine is quickchr/machine-not-found (real provider)", async () => {
		await expect(
			resolveTerminalRequest(
				{ quickchr: "centrs-unit-no-such-machine-610" },
				{ CENTRS_SKIP_ENV_FILE: "1" },
			),
		).rejects.toMatchObject({ code: "quickchr/machine-not-found" });
	});
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
		expect(argv.join(" ")).toContain("-o IdentitiesOnly=yes");
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
		expect(argv.join(" ")).not.toContain("IdentitiesOnly");
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
