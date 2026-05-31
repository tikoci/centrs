import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	canonicalizeExecuteCommand,
	execute,
	executeEnvelope,
	isWriteShaped,
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
});

describe("execute bare-MAC transport default honors host precedence", () => {
	const MAC = "96:5D:80:7D:BF:59";
	const IP = "192.168.74.1";

	test("bare MAC with no host/via defaults to mac-telnet (not yet wired)", async () => {
		expect.assertions(2);
		try {
			await resolveExecuteRequest(
				{ targetInput: MAC, command: "/system/identity/print" },
				{},
			);
		} catch (error) {
			expect(error).toBeInstanceOf(CentrsError);
			expect((error as CentrsError).code).toBe(
				"routeros/protocol-not-implemented",
			);
		}
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
