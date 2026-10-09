import { afterEach, describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import { createProtocolAdapter } from "../../src/protocols/adapter.ts";
import {
	connectNativeApi,
	encodeSentence,
	SentenceReader,
} from "../../src/protocols/native-api.ts";
import {
	type RetrieveRequest,
	resolveRetrieveRequest,
} from "../../src/retrieve.ts";
import { isRetryableWaitError, retrieveWait } from "../../src/retrieve-wait.ts";
import { runCliCaptured } from "./cli-capture.ts";

const ENV = {
	HOME: "/nonexistent-centrs-wait-test",
	CENTRS_SKIP_ENV_FILE: "1",
};
const servers: Array<{ stop(close?: boolean): unknown }> = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function router(
	options: {
		delayMs?: number;
		inspectDelayMs?: number;
		status?: number;
		rows?: () => Record<string, string>[];
	} = {},
) {
	let reads = 0;
	let inspections = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req) => {
			if (options.status)
				return Response.json(
					{ error: options.status, detail: "invalid user name or password" },
					{ status: options.status },
				);
			if (new URL(req.url).pathname.endsWith("/console/inspect")) {
				inspections++;
				if (options.inspectDelayMs) await Bun.sleep(options.inspectDelayMs);
				const body = (await req.json()) as { request: string; path: string };
				const cmd = (name: string) => ({
					type: "child",
					"node-type": "cmd",
					name,
				});
				const arg = (name: string) => ({
					type: "child",
					"node-type": "arg",
					name,
				});
				if (body.request === "completion")
					return Response.json(
						["address", "comment"].map((completion) => ({
							completion,
							show: "true",
						})),
					);
				return Response.json(
					body.path === "ip,address"
						? [cmd("print"), cmd("get")]
						: body.path === "ip,address,get"
							? [arg("number"), arg("value-name")]
							: [],
				);
			}
			reads++;
			if (options.delayMs) await Bun.sleep(options.delayMs);
			let rows = options.rows?.() ?? [
				{ ".id": "*1", address: "192.0.2.1", comment: "ready" },
			];
			if (req.method === "POST") {
				const body = (await req.json()) as {
					".query"?: string[];
					".proplist"?: string[];
				};
				rows = rows.filter((row) =>
					(body[".query"] ?? [])
						.filter((word) => !word.startsWith("#"))
						.every((word) => {
							const cut = word.indexOf("=");
							return row[word.slice(0, cut)] === word.slice(cut + 1);
						}),
				);
				if (body[".proplist"])
					rows = rows.map((row) =>
						Object.fromEntries(
							Object.entries(row).filter(([key]) =>
								body[".proplist"]?.includes(key),
							),
						),
					);
			}
			return Response.json(rows);
		},
	});
	servers.push(server);
	const request: RetrieveRequest = {
		targetInput: "127.0.0.1",
		port: server.port,
		username: "admin",
		password: "",
		path: "/ip/address",
		wait: "300ms",
		sample: "20ms",
		timeout: "2s",
	};
	return {
		request,
		server,
		reads: () => reads,
		inspections: () => inspections,
	};
}

describe("retrieveWait", () => {
	test("already-true predicates succeed initially without fetching projected-away properties", async () => {
		const r = router();
		const envelope = await retrieveWait(
			{
				...r.request,
				until: "comment=ready",
				attributes: "address",
				maxResultsBytes: 4096,
			},
			ENV,
		);
		expect(envelope.ok).toBe(true);
		if (envelope.ok) expect(envelope.data).toEqual([{ address: "192.0.2.1" }]);
		expect(envelope.meta.operation?.wait).toMatchObject({
			stopReason: "condition-met",
			attempts: 1,
			observations: 1,
		});
		expect(r.reads()).toBe(1);
		expect(envelope.meta.operation?.request.sample).toBeUndefined();
	});

	test("selection and until have distinct metadata and are AND-ed on the router", async () => {
		const r = router();
		const result = await retrieveWait(
			{
				...r.request,
				query: "address=192.0.2.9",
				until: "comment=ready",
				wait: "80ms",
			},
			ENV,
		);
		expect(result.ok).toBe(false);
		expect(result.meta.operation?.request.query).toEqual(["address=192.0.2.9"]);
		expect(result.meta.operation?.request.wait?.until).toEqual([
			"comment=ready",
		]);
		expect(result.meta.operation?.wait?.stopReason).toBe("deadline-elapsed");
		if (!result.ok) expect(result.error.code).toBe("wait/deadline-exceeded");
	});

	test("zero rows do not satisfy any-match; until-empty needs a completed observation", async () => {
		const r = router({ rows: () => [] });
		const unmet = await retrieveWait(
			{ ...r.request, until: "comment=ready", wait: "80ms" },
			ENV,
		);
		expect(unmet.ok).toBe(false);
		expect(unmet.meta.operation?.wait?.observations).toBeGreaterThan(0);
		const empty = await retrieveWait({ ...r.request, untilEmpty: true }, ENV);
		expect(empty.ok).toBe(true);
		expect(empty.meta.operation?.wait).toMatchObject({
			attempts: 1,
			observations: 1,
			stopReason: "condition-met",
		});
	});

	test("deadline bounds a slow data read and a slow validation, not just sleeps", async () => {
		for (const options of [{ delayMs: 500 }, { inspectDelayMs: 500 }]) {
			const r = router(options);
			const start = performance.now();
			const result = await retrieveWait(
				{ ...r.request, untilEmpty: true, wait: "80ms" },
				ENV,
			);
			expect(performance.now() - start).toBeLessThan(300);
			expect(result.ok).toBe(false);
			expect(result.meta.operation?.wait).toMatchObject({
				stopReason: "deadline-elapsed",
				observations: 0,
			});
			if (options.inspectDelayMs) expect(r.reads()).toBe(0);
		}
	});

	test("retry expiry preserves the last transport error and its attempt counts", async () => {
		const r = router();
		r.server.stop(true);
		const result = await retrieveWait({ ...r.request, wait: "80ms" }, ENV);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error.code).toBe("transport/connection-refused");
		expect(result.meta.operation?.wait?.attempts).toBeGreaterThan(1);
		expect(result.meta.operation?.wait?.observations).toBe(0);
	});

	test("auth and unknown predicate fields fail immediately", async () => {
		const auth = router({ status: 401 });
		const rejected = await retrieveWait(auth.request, ENV);
		expect(rejected.ok).toBe(false);
		expect(rejected.meta.operation?.wait?.attempts).toBe(1);
		const r = router();
		const typo = await retrieveWait(
			{ ...r.request, until: "unknown-property=yes" },
			ENV,
		);
		expect(typo.ok ? undefined : typo.error.code).toBe(
			"validation/unknown-attribute",
		);
		expect(typo.meta.operation?.wait?.attempts).toBe(1);
		if (!typo.ok) {
			expect(typo.error.summary).toContain("--until");
			expect(typo.error.context?.["flag"]).toBe("--until");
		}
		expect(r.reads()).toBe(0);
	});

	test("mixed selection and termination diagnostics preserve their source flag", async () => {
		const r = router();
		for (const [query, until, flag] of [
			["address=192.0.2.1", "unknown-property=yes", "--until"],
			["unknown-property=yes", "comment=ready", "--query"],
		]) {
			const result = await retrieveWait({ ...r.request, query, until }, ENV);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.summary).toContain(flag ?? "");
				expect(result.error.context?.["flag"]).toBe(flag);
			}
		}
		const unsupported = await retrieveWait(
			{ ...r.request, until: 'comment~"ready"' },
			ENV,
		);
		expect(unsupported.ok ? undefined : unsupported.error.code).toBe(
			"input/unsupported-query",
		);
		if (!unsupported.ok) {
			expect(unsupported.error.summary).toContain("--until");
			expect(unsupported.error.context?.["flag"]).toBe("--until");
		}
		const bare = await retrieveWait(
			{
				...r.request,
				query: "address=192.0.2.1",
				until: "comment",
				validate: false,
			},
			ENV,
		);
		if (!bare.ok) {
			expect(bare.error.summary).toContain("--until");
			expect(bare.error.context?.["flag"]).toBe("--until");
		}
		expect(bare.ok).toBe(false);
		const literal = await retrieveWait(
			{ ...r.request, until: "comment=x=--query" },
			ENV,
		);
		if (!literal.ok) {
			expect(literal.error.summary).toContain("Invalid --until");
			expect(literal.error.summary).toContain('comment="x=--query"');
		}
		expect(literal.ok).toBe(false);
		const projection = await retrieveWait(
			{ ...r.request, until: "comment=ready", attributes: "--query" },
			ENV,
		);
		if (!projection.ok) expect(projection.error.summary).toContain("--query");
		expect(projection.ok).toBe(false);
		expect(r.reads()).toBe(0);
	});

	test("pre-abort and cancellation during an unmet wait are failed outcomes", async () => {
		const r = router({ rows: () => [] });
		const controller = new AbortController();
		controller.abort();
		const before = await retrieveWait(r.request, ENV, {
			signal: controller.signal,
		});
		expect(before.ok ? undefined : before.error.code).toBe("wait/interrupted");
		expect(r.inspections()).toBe(0);
		const active = new AbortController();
		const timer = setTimeout(() => active.abort(), 50);
		try {
			const result = await retrieveWait(
				{ ...r.request, until: "comment=ready" },
				ENV,
				{ signal: active.signal },
			);
			expect(result.ok ? undefined : result.error.code).toBe(
				"wait/interrupted",
			);
			expect(result.meta.operation?.wait?.stopReason).toBe("interrupted");
		} finally {
			clearTimeout(timer);
		}
	});

	test("flag conflicts and unsupported predicates fail offline", async () => {
		const r = router();
		for (const extra of [
			{ wait: undefined, until: "comment=ready" },
			{ wait: undefined, untilEmpty: true },
			{ follow: true },
			{ count: 1 },
			{ duration: "1s" },
			{ until: "comment=ready", untilEmpty: true },
			{ listAttributes: true },
		]) {
			const result = await retrieveWait({ ...r.request, ...extra }, ENV);
			expect(result.ok ? undefined : result.error.code).toBe(
				"usage/conflicting-flags",
			);
		}
		await expect(
			resolveRetrieveRequest({ ...r.request, until: 'comment~"ready"' }, ENV),
		).rejects.toMatchObject({ code: "input/unsupported-query" });
		// With validation off there is no inspect, so the singleton check must use
		// the same known-path fallback as the read; otherwise it polls to the deadline.
		const singleton = await retrieveWait(
			{
				...r.request,
				path: "/system/resource",
				untilEmpty: true,
				validate: false,
			},
			ENV,
		);
		expect(singleton.ok ? undefined : singleton.error.code).toBe(
			"usage/conflicting-flags",
		);
		expect(r.reads()).toBe(0);
		// A bare number would be a millisecond deadline; like --sample, refuse it.
		for (const wait of ["30", 30, "0s"]) {
			const result = await retrieveWait({ ...r.request, wait }, ENV);
			expect(result.ok ? undefined : result.error.code).toBe(
				"settings/invalid-timeout",
			);
		}
		expect(r.inspections()).toBe(0);
	});

	test("CLI returns one final envelope and exit 1 for an unmet condition", async () => {
		const r = router({ rows: () => [] });
		const result = await runCliCaptured([
			"retrieve",
			"127.0.0.1",
			"/ip/address",
			"--port",
			String(r.request.port),
			"--username",
			"admin",
			"--password",
			"",
			"--wait",
			"80ms",
			"--sample",
			"20ms",
			"--until",
			"comment=ready",
			"--json",
		]);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.out).meta.operation.wait.stopReason).toBe(
			"deadline-elapsed",
		);
		expect(result.err).toBe("");
	});
});

test("wait retry taxonomy excludes deterministic faults and generic network failures", () => {
	for (const code of [
		"transport/timeout",
		"transport/connection-closed",
		"transport/connection-refused",
	] as const)
		expect(
			isRetryableWaitError(new CentrsError({ code, summary: "test" })),
		).toBe(true);
	for (const code of [
		"transport/dns",
		"transport/tls-certificate",
		"transport/auth-failed",
		"validation/unknown-path",
		"transport/network",
	] as const)
		expect(
			isRetryableWaitError(new CentrsError({ code, summary: "test" })),
		).toBe(false);
	// FailedToOpenSocket is Bun fetch's answer once macOS has marked a LAN
	// host down after a failed ARP (a router mid-reboot).
	for (const cause of [
		"ECONNRESET",
		"FailedToOpenSocket",
		"EHOSTDOWN",
		"EHOSTUNREACH",
		"ENETUNREACH",
	])
		expect(
			isRetryableWaitError(
				new CentrsError({
					code: "transport/network",
					summary: cause,
					cause: { code: cause },
				}),
			),
		).toBe(true);
	expect(
		isRetryableWaitError(
			new CentrsError({
				code: "transport/network",
				summary: "bad url",
				cause: { code: "ERR_INVALID_URL" },
			}),
		),
	).toBe(false);
});

test.each([false, true])(
	"native connection/login cancellation closes the socket (tls=%s)",
	async (tls) => {
		let closed = false;
		const listener = Bun.listen<undefined>({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data() {},
				close() {
					closed = true;
				},
			},
		});
		servers.push(listener);
		const controller = new AbortController();
		const connecting = connectNativeApi({
			host: "127.0.0.1",
			port: listener.port,
			username: "admin",
			password: "",
			tls,
			timeoutMs: 5_000,
			signal: controller.signal,
		});
		await Bun.sleep(30);
		controller.abort();
		await expect(connecting).rejects.toBeDefined();
		await Bun.sleep(20);
		expect(closed).toBe(true);
	},
);

test("native adapter cancellation during inspect closes the session and sends no read", async () => {
	const commands: string[] = [];
	const reader = new SentenceReader();
	const listener = Bun.listen<undefined>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data(socket, chunk) {
				for (const words of reader.push(new Uint8Array(chunk))) {
					const command = words[0] ?? "";
					commands.push(command);
					if (command === "/login")
						socket.write(
							encodeSentence([
								"!done",
								words.find((word) => word.startsWith(".tag=")) ?? "",
							]),
						);
				}
			},
		},
	});
	servers.push(listener);
	const result = await retrieveWait(
		{
			targetInput: "127.0.0.1",
			port: listener.port,
			via: "native-api",
			username: "admin",
			password: "",
			path: "/ip/address",
			wait: "80ms",
			timeout: "5s",
		},
		ENV,
	);
	expect(result.ok).toBe(false);
	expect(result.meta.operation?.wait).toMatchObject({
		stopReason: "deadline-elapsed",
		observations: 0,
	});
	expect(commands).toEqual(["/login", "/console/inspect"]);
});

test("aborted native adapters dispatch neither login nor inspect", async () => {
	const controller = new AbortController();
	controller.abort();
	const backend = createProtocolAdapter({
		protocol: "native-api",
		host: "127.0.0.1",
		port: 1,
		tls: false,
		baseUrl: "api://127.0.0.1:1",
		username: "admin",
		password: "",
		timeoutMs: 5_000,
		signal: controller.signal,
	});
	await expect(backend.inspect("child", "ip,address")).rejects.toBeDefined();
	await backend.close();
});
