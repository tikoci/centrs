import { describe, expect, test } from "bun:test";
import { runCli } from "../../src/cli.ts";
import { type CentrsError, retrieve } from "../../src/index.ts";

type FetchHandler = (
	url: string,
	init: RequestInit | undefined,
) => Response | Promise<Response>;

function mockFetchSequence(handlers: readonly FetchHandler[]) {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const queue = [...handlers];
	const originalFetch = globalThis.fetch;

	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		calls.push({ url, init });
		const handler = queue.shift();
		if (!handler) {
			throw new Error(`Unexpected fetch call for ${url}`);
		}
		return handler(url, init);
	}) as typeof fetch;

	return {
		calls,
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
}

function captureConsole() {
	const originalLog = console.log;
	const originalError = console.error;
	const logs: string[] = [];
	const errors: string[] = [];

	console.log = ((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	}) as typeof console.log;
	console.error = ((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	}) as typeof console.error;

	return {
		logs,
		errors,
		restore() {
			console.log = originalLog;
			console.error = originalError;
		},
	};
}

describe("retrieve core", () => {
	test("lists inspect-derived attributes without running the data call", async () => {
		const fetchMock = mockFetchSequence([
			() =>
				new Response(
					JSON.stringify([{ type: "cmd", name: "print", "node-type": "cmd" }]),
				),
			() =>
				new Response(
					JSON.stringify([
						{ type: "arg", name: "disabled", "node-type": "arg" },
						{ type: "arg", name: "name", "node-type": "arg" },
					]),
				),
		]);

		try {
			const envelope = await retrieve({
				targetInput: "router1",
				path: "/interface",
				via: "rest-api",
				listAttributes: true,
				username: "admin",
				password: "",
			});

			expect(envelope.ok).toBe(true);
			expect(envelope.result.kind).toBe("attributes");
			expect(envelope.result.data).toEqual(["disabled", "name"]);
			expect(fetchMock.calls).toHaveLength(2);
			expect(
				fetchMock.calls.every((call) =>
					call.url.endsWith("/rest/console/inspect"),
				),
			).toBe(true);
		} finally {
			fetchMock.restore();
		}
	});

	test("uses REST print with .proplist for projected attributes", async () => {
		const fetchMock = mockFetchSequence([
			() =>
				new Response(
					JSON.stringify([{ type: "cmd", name: "print", "node-type": "cmd" }]),
				),
			() =>
				new Response(
					JSON.stringify([
						{ type: "arg", name: "address", "node-type": "arg" },
						{ type: "arg", name: "interface", "node-type": "arg" },
					]),
				),
			(_, init) => {
				const body = JSON.parse(String(init?.body)) as {
					".proplist"?: string[];
				};
				expect(body[".proplist"]).toEqual(["address", "interface"]);
				return new Response(
					JSON.stringify([{ address: "192.0.2.1/24", interface: "ether1" }]),
				);
			},
		]);

		try {
			const envelope = await retrieve({
				targetInput: "router1",
				path: "/ip/address",
				via: "rest-api",
				attribute: ["address", "interface"],
				username: "admin",
				password: "",
			});

			expect(envelope.result.kind).toBe("data");
			expect(envelope.result.objectCount).toBe(1);
			expect(fetchMock.calls.at(-1)?.url).toBe(
				"http://router1:80/rest/ip/address/print",
			);
		} finally {
			fetchMock.restore();
		}
	});

	test("maps refused connections to a structured transport error", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			const error = new Error("connect ECONNREFUSED 127.0.0.1:80") as Error & {
				code?: string;
			};
			error.code = "ECONNREFUSED";
			throw error;
		}) as unknown as typeof fetch;

		try {
			await expect(
				retrieve({
					targetInput: "127.0.0.1",
					path: "/system/resource",
					via: "rest-api",
					validate: false,
					username: "admin",
					password: "",
				}),
			).rejects.toMatchObject({
				name: "CentrsError",
				code: "transport/connection-refused",
			} satisfies Partial<CentrsError>);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("fails when the rendered output exceeds the requested byte budget", async () => {
		const fetchMock = mockFetchSequence([
			() => new Response(JSON.stringify({ version: "7.22.1", uptime: "1m" })),
		]);

		try {
			await expect(
				retrieve({
					targetInput: "router1",
					path: "/system/resource",
					via: "rest-api",
					validate: false,
					format: "json",
					maxResultsBytes: 32,
					username: "admin",
					password: "",
				}),
			).rejects.toMatchObject({
				name: "CentrsError",
				code: "input/max-results-exceeded",
			} satisfies Partial<CentrsError>);
		} finally {
			fetchMock.restore();
		}
	});
});

describe("retrieve CLI", () => {
	test("renders a JSON envelope for successful retrieve output", async () => {
		const fetchMock = mockFetchSequence([
			() => new Response(JSON.stringify({ version: "7.22.1", uptime: "5m" })),
		]);
		const consoleCapture = captureConsole();

		try {
			const exitCode = await runCli([
				"retrieve",
				"router1",
				"/system/resource",
				"--via",
				"rest-api",
				"--format",
				"json",
				"--no-validate",
				"--username",
				"admin",
				"--password",
				"",
			]);

			expect(exitCode).toBe(0);
			expect(consoleCapture.errors).toHaveLength(0);
			const payload = JSON.parse(consoleCapture.logs[0] ?? "") as {
				ok: boolean;
				result: { data: { version: string } };
			};
			expect(payload.ok).toBe(true);
			expect(payload.result.data.version).toBe("7.22.1");
		} finally {
			consoleCapture.restore();
			fetchMock.restore();
		}
	});

	test("renders an actionable text error when via is missing", async () => {
		const consoleCapture = captureConsole();

		try {
			const exitCode = await runCli([
				"retrieve",
				"router1",
				"/system/resource",
			]);
			expect(exitCode).toBe(1);
			expect(consoleCapture.logs).toHaveLength(0);
			expect(consoleCapture.errors[0]).toContain("settings/missing-via");
			expect(consoleCapture.errors[0]).toContain("--via rest-api");
		} finally {
			consoleCapture.restore();
		}
	});
});
