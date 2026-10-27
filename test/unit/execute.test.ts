import { describe, expect, test } from "bun:test";
import {
	type EnvelopeValidationStage,
	notReachedReason,
} from "../../src/core/envelope.ts";
import { CentrsError, type CentrsErrorCode } from "../../src/errors.ts";
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
import { closedPort } from "./closed-port.ts";

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

describe("execute honors an explicit URL target's scheme and port (#426)", () => {
	const command = "/system/identity/print";

	test("an http:// URL with no via pinned selects rest-api on its port", async () => {
		const resolved = await resolveExecuteRequest(
			{ targetInput: "http://127.0.0.1:9", command },
			{},
		);
		expect(resolved.via.value).toBe("rest-api");
		expect(resolved.via.source).toEqual({
			kind: "default",
			key: "via:target-url",
		});
		expect(resolved.target.baseUrl).toBe("http://127.0.0.1:9/rest");
	});

	test("an https:// --host selects rest-api over TLS", async () => {
		const resolved = await resolveExecuteRequest(
			{ host: "https://192.0.2.10", command },
			{},
		);
		expect(resolved.via.value).toBe("rest-api");
		expect(resolved.target.baseUrl).toBe("https://192.0.2.10:443/rest");
	});

	test("a URL in CENTRS_HOST selects rest-api", async () => {
		const resolved = await resolveExecuteRequest(
			{ targetInput: "192.0.2.99", command },
			{ CENTRS_HOST: "http://192.0.2.10:8080" },
		);
		expect(resolved.via.value).toBe("rest-api");
		expect(resolved.target.port).toBe(8080);
	});

	test("a bare host:port keeps native-api and dials the typed port", async () => {
		const resolved = await resolveExecuteRequest(
			{ targetInput: "127.0.0.1:9", command },
			{},
		);
		expect(resolved.via.value).toBe("native-api");
		expect(resolved.via.source).toEqual({ kind: "default", key: "via" });
		expect(resolved.target.baseUrl).toBe("api://127.0.0.1:9");
	});

	test("a pinned via wins over the URL and keeps its typed port", async () => {
		const pinned = await resolveExecuteRequest(
			{ targetInput: "http://127.0.0.1:9", command, via: "native-api" },
			{},
		);
		expect(pinned.via.value).toBe("native-api");
		expect(pinned.target.baseUrl).toBe("api://127.0.0.1:9");

		const fromEnv = await resolveExecuteRequest(
			{ targetInput: "http://127.0.0.1:9", command },
			{ CENTRS_VIA: "native-api" },
		);
		expect(fromEnv.via.value).toBe("native-api");
		expect(fromEnv.target.baseUrl).toBe("api://127.0.0.1:9");
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

describe("resolvedExecuteTips — bare menu path steering tip", () => {
	// Same hermetic stub idea, plus the canonical command the tip reads.
	function stub(command: string): ResolvedExecuteRequest {
		return {
			via: { value: "native-api" },
			auth: { username: "admin", password: "", passwordProvided: false },
			canonical: canonicalizeExecuteCommand(command),
		} as unknown as ResolvedExecuteRequest;
	}

	test("fires for a bare menu path and names the read", () => {
		const tips = resolvedExecuteTips(stub("/system/identity"));
		const tip = tips.find((t) => t.code === "tip/execute-bare-menu-path");
		expect(tip).toBeDefined();
		expect(tip?.message).toContain("/system/identity");
		expect(tip?.fix).toContain("/system/identity/print");
		expect(tip?.fix).toContain("centrs retrieve <router> /system/identity");
		expect(tip?.detailsUrl).toContain("/tips/tip/execute-bare-menu-path");
	});

	test("does not fire for a real command or a gated write", () => {
		for (const command of [
			"/system/identity/print",
			"/system/reboot",
			"/ip/address/add address=198.51.100.10/32 interface=ether1",
			"/no/such/menu",
		]) {
			expect(
				resolvedExecuteTips(stub(command)).find(
					(t) => t.code === "tip/execute-bare-menu-path",
				),
			).toBeUndefined();
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

	test("script-shaped input has no `semantic` summary on a gate rejection", async () => {
		// There is no `/console/inspect` half for a script, so `semantic: false`
		// would claim a semantic gate ran and said no. No stage answered it, so
		// the field is absent (#535; `not-applicable` before that).
		const resolved = await resolveFor(":put [");
		expect(resolved.canonical.mode).not.toBe("structured");
		const envelope = buildExecuteErrorEnvelopeFromResolved(
			resolved,
			new CentrsError({ code: "validation/syntax", summary: "nope" }),
			undefined,
			{},
		);
		expect(envelope.meta.validation).not.toHaveProperty("semantic");
		expect(envelope.meta.validation?.syntax).toBe(false);
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
		// No stage answered, so no flat summary claims one did (#535).
		expect(envelope.meta.validation).not.toHaveProperty("syntax");
		expect(envelope.meta.validation).not.toHaveProperty("semantic");
	});

	test("a gate interrupted by a transport error reports not reached, never a verdict (GH#435)", async () => {
		const resolved = await resolveFor("/ip/address/print");
		const refused = new CentrsError({
			code: "transport/unreachable",
			summary: "nope",
		});
		const reason = notReachedReason("transport/unreachable");
		const device: EnvelopeValidationStage = {
			stage: "device",
			source: ":put [:parse] + /console/inspect",
			result: "skipped",
			reason,
		};

		// Stage 1 never returned: both stages not reached.
		const before = buildExecuteErrorEnvelopeFromResolved(
			resolved,
			refused,
			undefined,
			{},
		);
		expect(before.meta.validation).toEqual({
			enabled: true,
			source: ":put [:parse] + /console/inspect",
			stages: [
				{
					stage: "offline",
					source: OFFLINE_GATE_SOURCE,
					result: "skipped",
					reason,
				},
				device,
			],
		});

		// Stage 1 passed, then the device stage was interrupted.
		const during = buildExecuteErrorEnvelopeFromResolved(
			resolved,
			refused,
			undefined,
			{ offlineVerdict: "pass" },
		);
		expect(during.meta.validation?.stages).toEqual([
			{ stage: "offline", source: OFFLINE_GATE_SOURCE, result: "passed" },
			device,
		]);

		// No trace: whether stage 1 ran is unknown, so it is left out.
		const untraced = buildExecuteErrorEnvelopeFromResolved(resolved, refused);
		expect(untraced.meta.validation?.stages).toEqual([device]);

		for (const envelope of [before, during, untraced]) {
			expect(envelope.meta.validation?.result).toBeUndefined();
			expect(envelope.meta.validation?.syntax).toBeUndefined();
			expect(envelope.meta.validation?.semantic).toBeUndefined();
		}
	});

	test("flat summaries name only the check that gave a verdict (GH#435)", async () => {
		const flat = async (
			command: string,
			error: CentrsError,
		): Promise<Record<string, unknown>> => {
			const { syntax, semantic } =
				buildExecuteErrorEnvelopeFromResolved(
					await resolveFor(command),
					error,
					undefined,
					{ offlineVerdict: "pass" },
				).meta.validation ?? {};
			return { syntax, semantic };
		};
		const device = (code: CentrsErrorCode) =>
			new CentrsError({ code, summary: "no" });
		const offline = new CentrsError({
			code: "validation/syntax",
			summary: "no",
			context: { validationStage: "offline" },
		});
		const structured = "/ip/address/print";
		const script = ":put 1";

		// A name-level rejection: the syntax was fine.
		expect(
			await flat(structured, device("validation/unknown-attribute")),
		).toEqual({ syntax: true, semantic: false });
		// `:parse` refused the command; the name-level check was never asked.
		for (const code of [
			"validation/syntax",
			"validation/unknown-path",
			"validation/package-missing",
			"validation/menu-unavailable",
		] as const) {
			expect(await flat(structured, device(code))).toEqual({
				syntax: false,
				semantic: undefined,
			});
		}
		expect(await flat(structured, offline)).toEqual({
			syntax: false,
			semantic: undefined,
		});
		// Script input has no semantic half; `bad parameter` is `:parse` refusing.
		for (const error of [
			device("validation/unknown-attribute"),
			device("validation/syntax"),
			offline,
		]) {
			expect(await flat(script, error)).toEqual({
				syntax: false,
				semantic: undefined,
			});
		}
	});

	test("a refused connection end to end: offline passed, device not reached (GH#435)", async () => {
		const envelope = await executeEnvelope(
			{
				targetInput: `http://127.0.0.1:${closedPort()}`,
				command: "/ip/address/print",
				username: "admin",
				password: "",
			},
			{},
		);
		expect(envelope.ok).toBe(false);
		if (envelope.ok) return;
		expect(envelope.error.code).toBe("transport/connection-refused");
		expect(envelope.meta.validation).toEqual({
			enabled: true,
			source: ":put [:parse] + /console/inspect",
			stages: [
				{ stage: "offline", source: OFFLINE_GATE_SOURCE, result: "passed" },
				{
					stage: "device",
					source: ":put [:parse] + /console/inspect",
					result: "skipped",
					reason: notReachedReason("transport/connection-refused"),
				},
			],
		});
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
