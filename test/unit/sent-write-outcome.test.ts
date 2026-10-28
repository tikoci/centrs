import { afterAll, describe, expect, test } from "bun:test";
import { type ApiStreamLine, apiEnvelope, apiStream } from "../../src/api.ts";
import { apiFanout } from "../../src/api-fanout.ts";
import { sentWriteWarnings } from "../../src/core/fanout.ts";
import { CentrsError } from "../../src/errors.ts";
import { executeEnvelope } from "../../src/execute.ts";
import {
	encodeSentence,
	SentenceReader,
} from "../../src/protocols/native-api.ts";
import type { SelectionMember } from "../../src/resolver/selection.ts";
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

/**
 * A loopback native-API router that accepts the login, then drops the
 * connection when the next sentence arrives (or, with `atLogin`, at login).
 */
function droppingRouter(atLogin = false) {
	const reader = new SentenceReader();
	const listener = Bun.listen<undefined>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data(socket, chunk) {
				for (const words of reader.push(new Uint8Array(chunk))) {
					if (words[0] === "/login" && !atLogin) {
						const tag = words.find((w) => w.startsWith(".tag="));
						socket.write(encodeSentence(tag ? ["!done", tag] : ["!done"]));
					} else {
						socket.end();
					}
				}
			},
		},
	});
	return listener;
}

async function lastStreamEnvelope(
	port: number,
	method: string,
): Promise<ApiStreamLine | undefined> {
	let last: ApiStreamLine | undefined;
	for await (const envelope of apiStream(
		{
			...common,
			via: "native-api",
			port,
			method,
			endpoint: "ip/address",
			...(method === "PUT"
				? { fields: { address: "192.0.2.9/32", interface: "ether1" } }
				: {}),
		},
		ENV,
	)) {
		last = envelope;
	}
	return last;
}

describe("api --stream marks a write sent once its sentence is on the wire (#448)", () => {
	test("a streamed PUT dropped after sending warns; a streamed GET does not", async () => {
		const router = droppingRouter();
		try {
			const put = await lastStreamEnvelope(router.port, "PUT");
			expect(put?.ok).toBe(false);
			expect(put && warned(put)).toBe(true);
			const get = await lastStreamEnvelope(router.port, "GET");
			expect(get?.ok).toBe(false);
			expect(get && warned(get)).toBe(false);
		} finally {
			router.stop(true);
		}
	});

	test("a streamed PUT whose session dropped at login does not warn", async () => {
		const router = droppingRouter(true);
		try {
			const put = await lastStreamEnvelope(router.port, "PUT");
			expect(put?.ok).toBe(false);
			expect(put && warned(put)).toBe(false);
		} finally {
			router.stop(true);
		}
	});
});

/**
 * A native session logs in lazily inside the call that sends the command, so
 * a drop during `/login` must not count as sent: only `/login` reached the
 * router (#452 review).
 */
describe("a native write whose session dropped at login was not sent (#448)", () => {
	const native = { ...common, via: "native-api" } as const;
	const write = '/system/note/set note="x"';

	test("execute: a login drop does not warn; a drop after login does", async () => {
		const atLogin = droppingRouter(true);
		const afterLogin = droppingRouter();
		try {
			const dropped = await executeEnvelope(
				{ ...native, port: atLogin.port, command: write },
				ENV,
			);
			expect(!dropped.ok && dropped.error.code).toBe(
				"transport/connection-closed",
			);
			expect(warned(dropped)).toBe(false);

			const sent = await executeEnvelope(
				{ ...native, port: afterLogin.port, command: write },
				ENV,
			);
			expect(!sent.ok && sent.error.code).toBe("transport/connection-closed");
			expect(warned(sent)).toBe(true);
		} finally {
			atLogin.stop(true);
			afterLogin.stop(true);
		}
	});

	test("api: a PUT dropped at login does not warn", async () => {
		const router = droppingRouter(true);
		try {
			const put = await apiEnvelope(
				{
					...native,
					port: router.port,
					method: "PUT",
					endpoint: "ip/address",
					fields: { address: "192.0.2.9/32", interface: "ether1" },
				},
				ENV,
			);
			expect(!put.ok && put.error.code).toBe("transport/connection-closed");
			expect(warned(put)).toBe(false);
		} finally {
			router.stop(true);
		}
	});

	test("api fan-out: a PUT dropped at login is retried and does not warn", async () => {
		const router = droppingRouter(true);
		let retries = 0;
		const member: SelectionMember = {
			kind: "cdb",
			recordIndex: 0,
			resolution: {
				target: "127.0.0.1",
				identity: "login-drop",
				username: "admin",
				password: "",
				recordIndex: 0,
				overrides: {},
				warnings: [],
			},
		};
		try {
			const envelope = await apiFanout(
				{
					...native,
					port: router.port,
					method: "PUT",
					endpoint: "ip/address",
					fields: { address: "192.0.2.9/32", interface: "ether1" },
				},
				{
					positionals: [],
					groups: ["lab"],
					all: false,
					default: false,
					where: [],
				},
				ENV,
				{
					expand: async () => ({
						targets: [member],
						warnings: [],
						empty: false,
					}),
					sleep: async () => {
						retries += 1;
					},
				},
			);
			const target = envelope.data.targets[0];
			expect(target?.ok).toBe(false);
			expect(JSON.stringify(target)).toContain("transport/connection-closed");
			expect(retries).toBe(2);
			expect(
				target?.warnings.some(
					(w) => w.code === "transport/write-outcome-unknown",
				),
			).toBe(false);
		} finally {
			router.stop(true);
		}
	});
});

test("a missing local client (e.g. no ssh binary) never counts as sent", () => {
	const error = new CentrsError({
		code: "transport/local-tool-missing",
		summary: "ssh not found",
	});
	expect(sentWriteWarnings(true, error, { dispatched: true })).toEqual([]);
});

/**
 * #549: a dispatched multi-statement write refused with
 * `routeros/permission-denied` can be partly applied — statements before the
 * refused one already ran — so it warns like any sent write of unknown
 * outcome. A single refused statement did not run (#541) and stays silent.
 * The loopback REST "router" answers every request with the CHR 500 shape.
 */
const permServer = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () =>
		Response.json(
			{
				detail: "not enough permissions (9)",
				error: 500,
				message: "Internal Server Error",
			},
			{ status: 500 },
		),
});
afterAll(() => permServer.stop(true));

const refused = (envelope: { ok: boolean; error?: { code: string } }) => {
	expect(envelope.ok).toBe(false);
	expect(envelope.error?.code).toBe("routeros/permission-denied");
};

describe("a refused multi-statement write warns that it may be partly applied (#549)", () => {
	test("execute: a refused multi-statement write warns; a refused single statement does not", async () => {
		const multi = await executeEnvelope(
			{
				...common,
				port: permServer.port,
				command: '/system/note/set note="a"\n/system/note/set note="b"',
			},
			ENV,
		);
		refused(multi);
		expect(warned(multi)).toBe(true);

		const single = await executeEnvelope(
			{
				...common,
				port: permServer.port,
				command: '/system/note/set note="x"',
			},
			ENV,
		);
		refused(single);
		expect(warned(single)).toBe(false);
	});

	test("execute: nested control scopes count; stored bodies do not (#549)", async () => {
		// `:if (true) do={ …; … }` applies the first statement before a refused
		// second on CHR 7.25, so it warns like a top-level pair. A single
		// nested statement, exclusive single branches, and stored bodies
		// (`source=`, `:global f do=`) stay silent.
		for (const command of [
			":if (true) do={ /system/note/set note=a; /user/add name=u }",
			":foreach i in={1;2} do={ /system/note/set note=$i; /user/add name=u }",
		]) {
			const nested = await executeEnvelope(
				{ ...common, port: permServer.port, command },
				ENV,
			);
			refused(nested);
			expect({ command, warned: warned(nested) }).toEqual({
				command,
				warned: true,
			});
		}
		for (const command of [
			":if (true) do={ /user/add name=u }",
			":if (true) do={ /system/note/set note=a } else={ /system/note/set note=b }",
			"/system/note/set note=x",
		]) {
			const single = await executeEnvelope(
				{ ...common, port: permServer.port, command },
				ENV,
			);
			refused(single);
			expect({ command, warned: warned(single) }).toEqual({
				command,
				warned: false,
			});
		}
	});

	test("execute: a structured REST write is one operation even with a `;` in a value", async () => {
		// `note=a;note=b` canonicalizes to structured mode, so REST dispatches a
		// single path-POST: the refusal means nothing ran, though the raw input
		// segments as two console statements.
		const smuggled = await executeEnvelope(
			{
				...common,
				port: permServer.port,
				command: "/system/note/set note=a;note=b",
			},
			ENV,
		);
		refused(smuggled);
		expect(warned(smuggled)).toBe(false);
	});

	test("api: a refused multi-statement /execute script warns; single-statement and structured do not", async () => {
		const multi = await apiEnvelope(
			{
				...common,
				port: permServer.port,
				method: "POST",
				endpoint: "execute",
				fields: { script: ':put "a"\n/system/note/set note="b"' },
			},
			ENV,
		);
		refused(multi);
		expect(warned(multi)).toBe(true);

		const nested = await apiEnvelope(
			{
				...common,
				port: permServer.port,
				method: "POST",
				endpoint: "execute",
				fields: {
					script: ":if (true) do={ /system/note/set note=a; /user/add name=u }",
				},
			},
			ENV,
		);
		refused(nested);
		expect(warned(nested)).toBe(true);

		const single = await apiEnvelope(
			{
				...common,
				port: permServer.port,
				method: "POST",
				endpoint: "execute",
				fields: { script: '/system/note/set note="x"' },
			},
			ENV,
		);
		refused(single);
		expect(warned(single)).toBe(false);

		const structured = await apiEnvelope(
			{
				...common,
				port: permServer.port,
				method: "PUT",
				endpoint: "ip/address",
				fields: { address: "192.0.2.9/32", interface: "ether1" },
			},
			ENV,
		);
		refused(structured);
		expect(warned(structured)).toBe(false);
	});
});
