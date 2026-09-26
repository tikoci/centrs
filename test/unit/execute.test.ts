import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	buildExecuteErrorEnvelopeFromResolved,
	canonicalizeExecuteCommand,
	execute,
	executeEnvelope,
	isWriteShaped,
	type ResolvedExecuteRequest,
	resolvedExecuteTips,
	resolveExecuteRequest,
	validateRouterOsScript,
} from "../../src/execute.ts";
import {
	assertOfflineSyntax,
	OFFLINE_GATE_SOURCE,
} from "../../src/offline-gate.ts";
import type { ProtocolAdapter } from "../../src/protocols/adapter.ts";

describe("execute canonicalization", () => {
	test("extracts path, verb, attributes, and quoted values", () => {
		const command = canonicalizeExecuteCommand(
			'/ip/address/add address=198.51.100.10/32 interface=ether1 comment="centrs execute fixture"',
		);
		expect(command).toMatchObject({
			mode: "structured",
			path: "/ip/address",
			verb: "add",
			attributes: {
				address: "198.51.100.10/32",
				interface: "ether1",
				comment: "centrs execute fixture",
			},
		});
		expect(isWriteShaped(command)).toBe(true);
	});

	test("falls back to script mode for non path-shaped commands", () => {
		const command = canonicalizeExecuteCommand(':put "hello"');
		expect(command.mode).toBe("script");
		expect(isWriteShaped(command)).toBe(false);
	});
});

describe("execute confirmation gate", () => {
	test("rejects write-shaped non-TTY commands without --yes before connecting", async () => {
		expect.assertions(3);
		try {
			await execute(
				{
					targetInput: "127.0.0.1",
					command: "/system/identity/set name=centrs-test",
					via: "rest-api",
					stdinIsTty: false,
				},
				{},
			);
		} catch (error) {
			expect(error).toBeInstanceOf(CentrsError);
			expect((error as CentrsError).code).toBe("usage/confirmation-required");
			expect((error as CentrsError).context).toMatchObject({
				path: "/system/identity",
				verb: "set",
			});
		}
	});

	for (const command of [
		"/ip/address/remove [find comment=centrs]",
		"/ip/address/remove *1",
		"/ip/address/disable numbers=*1",
		"/import file-name=router.rsc",
		':execute script="/ip/address/remove *1"',
		"/ip firewall filter\nremove [find comment=centrs]",
		"/ip firewall filter\nnew-mutator [find comment=centrs]",
		"ip address new-mutator",
	]) {
		test(`rejects unconfirmed write shape: ${command}`, async () => {
			const envelope = await executeEnvelope(
				{
					targetInput: "127.0.0.1",
					command,
					via: "rest-api",
					stdinIsTty: false,
				},
				{},
			);
			expect(envelope.ok).toBe(false);
			if (!envelope.ok) {
				expect(envelope.error.code).toBe("usage/confirmation-required");
			}
			expect(envelope.meta.operation?.request.write).toBe(true);
		});
	}
});

describe("execute preflight does not mask transport failures", () => {
	test("an unreachable target surfaces transport/*, not validation/syntax", async () => {
		// The `:put [:parse ...]` syntax gate runs over the live backend, where
		// login/connection happen lazily. A connection failure there must keep
		// its real `transport/*` code rather than being relabeled as a syntax
		// error (the reported `execute` bug). Port 1 is reliably closed.
		const envelope = await executeEnvelope(
			{
				targetInput: "127.0.0.1",
				command: "/ip/address/print",
				via: "native-api",
				port: 1,
				username: "x",
				password: "y",
			},
			{},
		);
		expect(envelope.ok).toBe(false);
		if (!envelope.ok) {
			expect(envelope.error.code.startsWith("transport/")).toBe(true);
			expect(envelope.error.code).not.toBe("validation/syntax");
		}
	});
});

describe("execute default output format is human-readable text", () => {
	test("defaults to text when no --format/CENTRS_FORMAT is set", async () => {
		const resolved = await resolveExecuteRequest(
			{
				targetInput: "127.0.0.1",
				command: "/ip/address/print",
				via: "native-api",
			},
			{},
		);
		expect(resolved.format.value).toBe("text");
	});

	test("honors CENTRS_FORMAT=json", async () => {
		const resolved = await resolveExecuteRequest(
			{
				targetInput: "127.0.0.1",
				command: "/ip/address/print",
				via: "native-api",
			},
			{ CENTRS_FORMAT: "json" },
		);
		expect(resolved.format.value).toBe("json");
	});

	test("explicit --format yaml wins", async () => {
		const resolved = await resolveExecuteRequest(
			{
				targetInput: "127.0.0.1",
				command: "/ip/address/print",
				via: "native-api",
				format: "yaml",
			},
			{ CENTRS_FORMAT: "json" },
		);
		expect(resolved.format.value).toBe("yaml");
	});

	test("rejects an invalid CENTRS_FORMAT value", async () => {
		await expect(
			resolveExecuteRequest(
				{
					targetInput: "127.0.0.1",
					command: "/ip/address/print",
					via: "native-api",
				},
				{ CENTRS_FORMAT: "xml" },
			),
		).rejects.toMatchObject({ code: "settings/invalid-format" });
	});

	test("rejects an invalid explicit --format value", async () => {
		await expect(
			resolveExecuteRequest(
				{
					targetInput: "127.0.0.1",
					command: "/ip/address/print",
					via: "native-api",
					format: "invalid",
				},
				{},
			),
		).rejects.toMatchObject({ code: "settings/invalid-format" });
	});
});

describe("execute bare-MAC transport default honors host precedence", () => {
	const MAC = "96:5D:80:7D:BF:59";
	const IP = "192.168.74.1";

	test("bare MAC with no host/via defaults to mac-telnet, addressing the MAC", async () => {
		const resolved = await resolveExecuteRequest(
			{ targetInput: MAC, command: "/system/identity/print" },
			{},
		);
		expect(resolved.via.value).toBe("mac-telnet");
		// The MAC is the device identity; delivery defaults to L2 broadcast.
		expect(resolved.target.mac).toBe("96:5d:80:7d:bf:59");
		expect(resolved.target.host).toBe("255.255.255.255");
		expect(resolved.target.port).toBe(20561);
	});

	test("MAC positional with --host IP defaults to native-api, targets the IP", async () => {
		const resolved = await resolveExecuteRequest(
			{ targetInput: MAC, host: IP, command: "/system/identity/print" },
			{},
		);
		expect(resolved.via.value).toBe("native-api");
		expect(resolved.target.host).toBe(IP);
	});

	test("MAC positional with CENTRS_HOST IP defaults to native-api", async () => {
		const resolved = await resolveExecuteRequest(
			{ targetInput: MAC, command: "/system/identity/print" },
			{ CENTRS_HOST: IP },
		);
		expect(resolved.via.value).toBe("native-api");
		expect(resolved.target.host).toBe(IP);
	});
});

describe("resolvedExecuteTips — mac-telnet no-credentials tip (JG-24)", () => {
	// `resolvedExecuteTips` reads only `via.value` and `auth`, so a minimal stub
	// pins the fire/no-fire logic hermetically (no CDB/network). The two envelope
	// builders wire it as `tips: resolvedExecuteTips(resolved)`.
	function stub(over: {
		via: string;
		username?: string;
		passwordProvided: boolean;
	}): ResolvedExecuteRequest {
		return {
			via: { value: over.via },
			auth: {
				username: over.username,
				password: "",
				passwordProvided: over.passwordProvided,
			},
		} as unknown as ResolvedExecuteRequest;
	}

	test("fires for mac-telnet with no username and no password", () => {
		const tips = resolvedExecuteTips(
			stub({ via: "mac-telnet", passwordProvided: false }),
		);
		// Select by code, not index, so the assertion survives added/reordered tips.
		const tip = tips.find((t) => t.code === "tip/mac-telnet-no-credentials");
		expect(tip).toBeDefined();
		expect(tip?.detailsUrl).toContain("/tips/tip/mac-telnet-no-credentials");
		expect(tip?.fix).toContain("MTWEI");
	});

	test("does not fire once a password is resolved", () => {
		expect(
			resolvedExecuteTips(stub({ via: "mac-telnet", passwordProvided: true })),
		).toEqual([]);
	});

	test("does not fire when a username is resolved (not 'no auth options')", () => {
		expect(
			resolvedExecuteTips(
				stub({ via: "mac-telnet", username: "admin", passwordProvided: false }),
			),
		).toEqual([]);
	});

	test("is mac-telnet-specific: no tip for an IP transport", () => {
		for (const via of ["rest-api", "native-api", "ssh"]) {
			expect(
				resolvedExecuteTips(stub({ via, passwordProvided: false })),
			).toEqual([]);
		}
	});
});

describe("validation metadata survives the error boundary (#354, PR #356 review)", () => {
	async function resolveFor(
		command: string,
		overrides: Partial<Parameters<typeof resolveExecuteRequest>[0]> = {},
	): Promise<ResolvedExecuteRequest> {
		return resolveExecuteRequest(
			{
				targetInput: "127.0.0.1",
				command,
				via: "rest-api",
				...overrides,
			},
			{},
		);
	}

	test("a post-validation RouterOS fault does not claim the gate failed", async () => {
		// The gate finished — both stages green — and the command then failed on the
		// device. Rebuilding `meta.validation` here used to report
		// `result: "failed"` with no stages, erasing a completed validation.
		const resolved = await resolveFor("/ip/address/print");
		const passed = {
			enabled: true,
			source: ":put [:parse] + /console/inspect",
			result: "passed" as const,
			syntax: true,
			semantic: true,
			stages: [
				{
					stage: "offline" as const,
					source: OFFLINE_GATE_SOURCE,
					result: "passed" as const,
				},
				{
					stage: "device" as const,
					source: ":put [:parse] + /console/inspect",
					result: "passed" as const,
				},
			],
		};
		const envelope = buildExecuteErrorEnvelopeFromResolved(
			resolved,
			new CentrsError({
				code: "routeros/request-failed",
				summary: "RouterOS reported an error",
			}),
			undefined,
			{ validation: passed, offlineVerdict: "pass" },
		);
		expect(envelope.meta.validation).toEqual(passed);
	});

	test("an offline abstention is not flattened to `passed` by a device rejection", async () => {
		// `warn` means the analyzer declined to judge part of the input. An error
		// envelope that reports a bare `passed` tells the consumer it read bytes it
		// explicitly did not.
		const resolved = await resolveFor("/ip/address/prnt");
		const envelope = buildExecuteErrorEnvelopeFromResolved(
			resolved,
			new CentrsError({
				code: "validation/unknown-attribute",
				summary: "Unknown RouterOS attribute",
			}),
			undefined,
			{ offlineVerdict: "warn" },
		);
		const stages = envelope.meta.validation?.stages ?? [];
		expect(stages[0]).toEqual({
			stage: "offline",
			source: OFFLINE_GATE_SOURCE,
			result: "passed",
			reason: "analyzer abstained on part of the input",
		});
		expect(stages[1]?.result).toBe("failed");
	});

	test("a stage-1 rejection reports the device stage as skipped, not failed", async () => {
		const resolved = await resolveFor(":put [");
		let gateError: unknown;
		try {
			assertOfflineSyntax(resolved.command, { surface: "execute" });
		} catch (error) {
			gateError = error;
		}
		const envelope = buildExecuteErrorEnvelopeFromResolved(
			resolved,
			gateError,
			undefined,
			{},
		);
		expect(envelope.meta.validation?.stages).toEqual([
			{ stage: "offline", source: OFFLINE_GATE_SOURCE, result: "failed" },
			{
				stage: "device",
				source: ":put [:parse] + /console/inspect",
				result: "skipped",
				reason: "offline analysis rejected the command; no connection opened",
			},
		]);
	});

	test("script-shaped input keeps `semantic: not-applicable` on a gate rejection", async () => {
		// There is no `/console/inspect` half for a script, so `semantic: false`
		// would claim a semantic gate ran and said no — a different statement from
		// "there was none". The pre-#354 builder returned `not-applicable` here.
		const resolved = await resolveFor(":put [");
		expect(resolved.canonical.mode).not.toBe("structured");
		const envelope = buildExecuteErrorEnvelopeFromResolved(
			resolved,
			new CentrsError({ code: "validation/syntax", summary: "nope" }),
			undefined,
			{},
		);
		expect(envelope.meta.validation?.semantic).toBe("not-applicable");
	});

	test("`--validate=false` lists both stages as skipped", async () => {
		// The constitution's rule is that a gated surface always reports each
		// stage, so a consumer reading `stages` never special-cases the disabled
		// shape. `enabled: false` already carries the why, so no `reason`.
		const resolved = await resolveFor("/ip/address/print", { validate: false });
		const envelope = buildExecuteErrorEnvelopeFromResolved(
			resolved,
			new CentrsError({ code: "transport/unreachable", summary: "nope" }),
			undefined,
			{},
		);
		expect(envelope.meta.validation?.enabled).toBe(false);
		expect(envelope.meta.validation?.stages).toEqual([
			{ stage: "offline", source: OFFLINE_GATE_SOURCE, result: "skipped" },
			{ stage: "device", source: "device preflight", result: "skipped" },
		]);
	});

	test("a non-validation error omits stages rather than inventing a verdict", async () => {
		// No trace and a transport drop: this builder cannot know which stage, if
		// any, ran. Saying nothing beats asserting `device: failed`.
		const resolved = await resolveFor("/ip/address/print");
		const envelope = buildExecuteErrorEnvelopeFromResolved(
			resolved,
			new CentrsError({ code: "transport/unreachable", summary: "nope" }),
			undefined,
			{},
		);
		expect(envelope.meta.validation?.stages).toBeUndefined();
	});
});

describe("device `:parse` stage rejects recorded `missing …` responses (GH#375)", () => {
	/** A backend whose `:put [:parse …]` returns one recorded device reply. */
	function parseReplying(ret: string): ProtocolAdapter {
		return {
			execute: async () => ({ records: [], ret }),
		} as unknown as ProtocolAdapter;
	}

	// Corpus row 507 (7.24.2): its failing line is `/certificate builtin find
	// where=`, which offline analysis passes, so the device stage is the gate.
	test("`missing value for where` is a device syntax rejection, not a pass", async () => {
		const rejection = validateRouterOsScript(
			"/certificate builtin find where=",
			parseReplying("missing value for where (line 1 column 33)"),
			"rest-api",
		);
		await expect(rejection).rejects.toMatchObject({
			code: "validation/syntax",
			position: { line: 1, column: 33 },
		});
	});

	// CHR 7.24.4: `{` + newline + `:put 1` + newline, unclosed.
	test("`missing closing brace` is a device syntax rejection", async () => {
		await expect(
			validateRouterOsScript(
				"{\n:put 1\n",
				parseReplying("missing closing brace (line 3 column 1)"),
				"native-api",
			),
		).rejects.toMatchObject({
			code: "validation/syntax",
			position: { line: 3, column: 1 },
		});
	});

	test("an accepted return that echoes diagnostic-looking text still passes", async () => {
		await expect(
			validateRouterOsScript(
				':put "missing closing brace (line 1 column 1)"',
				parseReplying(
					"(evl /putmessage=missing closing brace (line 1 column 1))",
				),
				"rest-api",
			),
		).resolves.toBeUndefined();
	});
});
