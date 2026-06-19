import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	canonicalizeExecuteCommand,
	execute,
	executeEnvelope,
	isWriteShaped,
	type ResolvedExecuteRequest,
	resolvedExecuteTips,
	resolveExecuteRequest,
} from "../../src/execute.ts";

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
			const expectedTransportCodes = [
				"transport/connection-refused",
				"transport/network-unreachable",
			];
			expect(envelope.error.code.startsWith("transport/")).toBe(true);
			expect(envelope.error.code).not.toBe("validation/syntax");
			expect(expectedTransportCodes).toContain(envelope.error.code);
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

	test("rejects invalid CENTRS_FORMAT value", async () => {
		await expect(
			resolveExecuteRequest(
				{
					targetInput: "127.0.0.1",
					command: "/ip/address/print",
					via: "native-api",
				},
				{ CENTRS_FORMAT: "xml" },
			),
		).rejects.toBeInstanceOf(CentrsError);
	});

	test("rejects invalid explicit --format value", async () => {
		await expect(
			resolveExecuteRequest(
				{
					targetInput: "127.0.0.1",
					command: "/ip/address/print",
					via: "native-api",
					format: "invalid" as ResolvedExecuteRequest["format"]["value"],
				},
				{},
			),
		).rejects.toBeInstanceOf(CentrsError);
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
		expect(tip?.fix).toBe(
			"Set credentials for mac-telnet. MTWEI is not accepted as an authentication option.",
		);
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
