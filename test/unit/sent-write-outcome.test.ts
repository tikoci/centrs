import { afterAll, describe, expect, test } from "bun:test";
import { apiEnvelope } from "../../src/api.ts";
import { executeEnvelope } from "../../src/execute.ts";
import { closedPort } from "./closed-port.ts";

/**
 * #448: the production `execute` and `api` paths mark a request as sent the
 * moment it goes out, so a transport failure after that carries
 * `transport/write-outcome-unknown` on a write, and one before it does not.
 * A loopback REST "router" answers every request with a 5xx.
 */

const ENV = { CENTRS_SKIP_ENV_FILE: "1", HOME: "/nonexistent-centrs-448" };
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response("upstream reset", { status: 502 }),
});
afterAll(() => server.stop(true));

const common = {
	targetInput: "127.0.0.1",
	username: "admin",
	password: "",
	via: "rest-api",
	validate: false,
	yes: true,
	stdinIsTty: false,
	timeout: "2s",
} as const;
const warned = (envelope: { warnings: readonly { code: string }[] }) =>
	envelope.warnings.some((w) => w.code === "transport/write-outcome-unknown");

describe("a write that failed after it was sent says its outcome is unknown (#448)", () => {
	test("execute: a sent write warns; a sent read does not", async () => {
		const write = await executeEnvelope(
			{
				...common,
				port: server.port,
				command: '/system/note/set note="x"',
			},
			ENV,
		);
		expect(write.ok).toBe(false);
		expect(!write.ok && write.error.code).toBe("transport/connection-closed");
		expect(warned(write)).toBe(true);

		const read = await executeEnvelope(
			{ ...common, port: server.port, command: "/system/note/print" },
			ENV,
		);
		expect(read.ok).toBe(false);
		expect(warned(read)).toBe(false);
	});

	test("execute: a write that never reached the router does not warn", async () => {
		const refused = await executeEnvelope(
			{ ...common, port: closedPort(), command: '/system/note/set note="x"' },
			ENV,
		);
		expect(refused.ok).toBe(false);
		expect(warned(refused)).toBe(false);
	});

	test("api: a sent PUT warns; a sent GET does not", async () => {
		const patch = await apiEnvelope(
			{
				...common,
				port: server.port,
				method: "PUT",
				endpoint: "ip/address",
				fields: { address: "192.0.2.9/32", interface: "ether1" },
			},
			ENV,
		);
		expect(patch.ok).toBe(false);
		expect(warned(patch)).toBe(true);

		const get = await apiEnvelope(
			{ ...common, port: server.port, endpoint: "ip/address" },
			ENV,
		);
		expect(get.ok).toBe(false);
		expect(warned(get)).toBe(false);
	});
});
