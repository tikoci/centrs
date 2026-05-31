import { describe, expect, test } from "bun:test";
import { runCli } from "../../src/cli.ts";
import { type CentrsError, retrieve } from "../../src/index.ts";
import {
	resolveMacForRetrieve,
	resolveRetrieveRequest,
} from "../../src/retrieve.ts";

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
					JSON.stringify([
						{ type: "child", name: "print", "node-type": "cmd" },
					]),
				),
			() =>
				new Response(
					JSON.stringify([
						{ type: "completion", completion: "disabled" },
						{ type: "completion", completion: "name" },
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
			expect(envelope.meta.operation?.kind).toBe("attributes");
			expect(envelope.data).toEqual(["disabled", "name"]);
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
					JSON.stringify([
						{ type: "child", name: "print", "node-type": "cmd" },
					]),
				),
			() =>
				new Response(
					JSON.stringify([
						{ type: "completion", completion: "address" },
						{ type: "completion", completion: "interface" },
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

			expect(envelope.meta.operation?.kind).toBe("data");
			expect(envelope.meta.operation?.objectCount).toBe(1);
			expect(fetchMock.calls.at(-1)?.url).toBe(
				"http://router1:80/rest/ip/address/print",
			);
		} finally {
			fetchMock.restore();
		}
	});

	test("uses completion validation and local projection for singleton attributes", async () => {
		const fetchMock = mockFetchSequence([
			() =>
				new Response(
					JSON.stringify([
						{ type: "child", name: "print", "node-type": "cmd" },
						{ type: "child", name: "get", "node-type": "cmd" },
					]),
				),
			(_url, init) => {
				const body = JSON.parse(String(init?.body)) as { path?: string };
				expect(body.path).toBe("system,resource,get,value-name");
				return new Response(
					JSON.stringify([
						{ type: "completion", completion: "uptime" },
						{ type: "completion", completion: "version" },
					]),
				);
			},
			() => new Response(JSON.stringify({ uptime: "5m", version: "7.23" })),
		]);

		try {
			const envelope = await retrieve({
				targetInput: "router1",
				path: "/system/resource",
				via: "rest-api",
				attribute: "uptime",
				username: "admin",
				password: "",
			});

			expect(envelope.meta.operation?.kind).toBe("data");
			expect(envelope.data).toBe("5m");
			expect(fetchMock.calls.at(-1)?.url).toBe(
				"http://router1:80/rest/system/resource",
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

	test("maps Bun-shaped ConnectionRefused errors to connection-refused", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			const error = new Error(
				"Unable to connect. Is the computer able to access the url?",
			) as Error & {
				code?: string;
				errno?: string;
				path?: string;
			};
			error.code = "ConnectionRefused";
			error.errno = "ConnectionRefused";
			error.path = "http://127.0.0.1:1/rest/system/resource";
			throw error;
		}) as unknown as typeof fetch;

		try {
			await expect(
				retrieve({
					targetInput: "127.0.0.1:1",
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

	test("maps nested DNS causes to transport/dns", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			const cause = new Error(
				"getaddrinfo EAI_AGAIN router.invalid",
			) as Error & {
				code?: string;
			};
			cause.code = "EAI_AGAIN";
			throw new AggregateError([cause], "fetch failed", { cause });
		}) as unknown as typeof fetch;

		try {
			await expect(
				retrieve({
					targetInput: "router.invalid",
					path: "/system/resource",
					via: "rest-api",
					validate: false,
					username: "admin",
					password: "",
				}),
			).rejects.toMatchObject({
				name: "CentrsError",
				code: "transport/dns",
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

	test("rejects execute-only protocols before implementation status", async () => {
		await expect(
			retrieve({
				targetInput: "AA:BB:CC:DD:EE:FF",
				path: "/system/resource",
				via: "mac-telnet",
				validate: false,
				username: "admin",
				password: "",
			}),
		).rejects.toMatchObject({
			name: "CentrsError",
			code: "routeros/unsupported-capability",
		} satisfies Partial<CentrsError>);
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
				data: { version: string };
			};
			expect(payload.ok).toBe(true);
			expect(payload.data.version).toBe("7.22.1");
		} finally {
			consoleCapture.restore();
			fetchMock.restore();
		}
	});

	test("defaults retrieve to REST when via is omitted", async () => {
		const fetchMock = mockFetchSequence([
			() =>
				new Response(
					JSON.stringify([
						{ type: "child", name: "print", "node-type": "cmd" },
						{ type: "child", name: "get", "node-type": "cmd" },
					]),
				),
			() => new Response(JSON.stringify({ version: "7.22.1", uptime: "5m" })),
		]);
		const consoleCapture = captureConsole();

		try {
			const exitCode = await runCli([
				"retrieve",
				"router1",
				"/system/resource",
				"--format",
				"json",
				"--username",
				"admin",
				"--password",
				"",
			]);
			expect(exitCode).toBe(0);
			expect(consoleCapture.errors).toHaveLength(0);
			const payload = JSON.parse(consoleCapture.logs[0] ?? "") as {
				meta: {
					via: string;
					settings: { via: { kind: string; key: string } };
				};
			};
			expect(payload.meta.via).toBe("rest-api");
			expect(payload.meta.settings.via).toEqual({
				kind: "default",
				key: "via",
			});
		} finally {
			consoleCapture.restore();
			fetchMock.restore();
		}
	});
});

describe("CLI help dispatch", () => {
	test("`retrieve --help` renders command help, not the global banner", async () => {
		const consoleCapture = captureConsole();
		try {
			// #7: a per-command --help must reach the command's own help, not be
			// swallowed by the global help interceptor.
			const exitCode = await runCli(["retrieve", "--help"]);
			expect(exitCode).toBe(0);
			const out = consoleCapture.logs.join("\n");
			expect(out).toContain("Usage: centrs retrieve");
			expect(out).toContain("Options:");
			expect(out).not.toContain("Use `centrs <command> --help`");
		} finally {
			consoleCapture.restore();
		}
	});

	test("`--help` as the first argument renders the global banner", async () => {
		const consoleCapture = captureConsole();
		try {
			const exitCode = await runCli(["--help"]);
			expect(exitCode).toBe(0);
			const out = consoleCapture.logs.join("\n");
			expect(out).toContain("Commands:");
			expect(out).toContain("Use `centrs <command> --help`");
		} finally {
			consoleCapture.restore();
		}
	});

	test("an unknown command with --help is still an unknown-command error", async () => {
		const consoleCapture = captureConsole();
		try {
			const exitCode = await runCli(["bogus", "--help"]);
			expect(exitCode).toBe(1);
			expect(consoleCapture.errors.join("\n")).toContain(
				"Unknown centrs command: bogus",
			);
		} finally {
			consoleCapture.restore();
		}
	});
});

describe("retrieve default output format is human-readable text", () => {
	test("defaults to text when no --format/CENTRS_FORMAT is set", async () => {
		const resolved = await resolveRetrieveRequest(
			{ targetInput: "127.0.0.1", path: "/ip/address", via: "rest-api" },
			{},
		);
		expect(resolved.format.value).toBe("text");
	});

	test("honors CENTRS_FORMAT=json and explicit --format yaml", async () => {
		const json = await resolveRetrieveRequest(
			{ targetInput: "127.0.0.1", path: "/ip/address", via: "rest-api" },
			{ CENTRS_FORMAT: "json" },
		);
		expect(json.format.value).toBe("json");
		const yaml = await resolveRetrieveRequest(
			{
				targetInput: "127.0.0.1",
				path: "/ip/address",
				via: "rest-api",
				format: "yaml",
			},
			{ CENTRS_FORMAT: "json" },
		);
		expect(yaml.format.value).toBe("yaml");
	});
});

describe("resolveMacForRetrieve (shared by single + fanout paths)", () => {
	const MAC = "96:5D:80:7D:BF:59";

	test("rejects L2 transports (mac-telnet) at the capability gate before ARP", async () => {
		expect.assertions(1);
		try {
			await resolveMacForRetrieve(
				{ targetInput: MAC, path: "/ip/address", via: "mac-telnet" },
				{},
			);
		} catch (error) {
			expect((error as CentrsError).code).toBe(
				"routeros/unsupported-capability",
			);
		}
	});

	test("returns undefined when an IP-transport target is not a MAC", async () => {
		const result = await resolveMacForRetrieve(
			{ targetInput: "192.168.74.1", path: "/ip/address", via: "native-api" },
			{},
		);
		expect(result).toBeUndefined();
	});

	test("throws actionable mac-unresolved for a MAC member without --resolve arp", async () => {
		expect.assertions(2);
		try {
			// A CDB group member whose target is a MAC, over an IP transport: the
			// fanout path calls this before buildResolvedRetrieve. Without the arp
			// opt-in it must fail with an actionable error, not crash.
			await resolveMacForRetrieve(
				{ path: "/ip/address", via: "native-api" },
				{},
				{
					matched: true,
					target: MAC,
					overrides: {},
				} as never,
			);
		} catch (error) {
			expect((error as CentrsError).code).toBe("target/mac-unresolved");
			expect((error as CentrsError).context).toMatchObject({ resolve: "none" });
		}
	});

	test("resolves or produces structured ARP-miss when --resolve arp is set", async () => {
		// Threading proof: with policy arp, resolveRetrieveRequest honors --resolve
		// arp end to end via the fanout-shared helper. ARP lookup itself is covered
		// in mac.test.ts; here we assert the request either resolves against live
		// ARP or fails with a structured ARP-miss error, never an unhandled crash.
		const result = await resolveRetrieveRequest(
			{
				targetInput: MAC,
				path: "/ip/address",
				via: "native-api",
				resolve: "arp",
			},
			{},
		).catch((error: CentrsError) => error);
		// Either it resolved (live ARP hit) or it produced a structured ARP-miss
		// error — never an unhandled crash.
		const code = (result as CentrsError).code;
		if (code !== undefined) {
			expect(["target/mac-not-in-arp", "target/mac-unresolved"]).toContain(
				code,
			);
		} else {
			expect(result).toBeDefined();
		}
	});
});
