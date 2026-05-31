import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	canonicalizeExecuteCommand,
	execute,
	isWriteShaped,
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
