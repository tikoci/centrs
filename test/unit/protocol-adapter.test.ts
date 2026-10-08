import { describe, expect, test } from "bun:test";
import { mapRouterOsError } from "../../src/core/routeros-errors.ts";
import {
	CentrsError,
	createProtocolAdapter,
	type ProtocolAdapterConfig,
} from "../../src/index.ts";

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

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function restConfig(
	overrides: Partial<ProtocolAdapterConfig> = {},
): ProtocolAdapterConfig {
	return {
		protocol: "rest-api",
		host: "192.0.2.10",
		port: 80,
		tls: false,
		baseUrl: "http://192.0.2.10:80/rest",
		username: "admin",
		password: "secret",
		timeoutMs: 10_000,
		...overrides,
	};
}

describe("createProtocolAdapter", () => {
	test("builds a REST adapter that advertises its protocol and capabilities", () => {
		const adapter = createProtocolAdapter(restConfig());
		expect(adapter.protocol).toBe("rest-api");
		expect(adapter.capabilities).toEqual({
			retrieve: true,
			execute: true,
			inspect: true,
		});
	});

	test("builds a native-api adapter for the native-api protocol", () => {
		const adapter = createProtocolAdapter(
			restConfig({ protocol: "native-api", port: 8728 }),
		);
		expect(adapter.protocol).toBe("native-api");
		expect(adapter.capabilities.retrieve).toBe(true);
		expect(adapter.capabilities.execute).toBe(true);
	});

	test("builds an ssh execute adapter for the ssh protocol", () => {
		const adapter = createProtocolAdapter(restConfig({ protocol: "ssh" }));
		expect(adapter.protocol).toBe("ssh");
		expect(adapter.capabilities.execute).toBe(true);
		expect(adapter.capabilities.retrieve).toBe(false);
		expect(adapter.capabilities.inspect).toBe(false);
	});

	test("defaults unwired protocols to the REST adapter", () => {
		const adapter = createProtocolAdapter(restConfig({ protocol: "romon" }));
		expect(adapter.protocol).toBe("romon");
		expect(adapter.capabilities.retrieve).toBe(true);
	});
});

describe("RestAdapter retrieve operations", () => {
	test("inspect issues a /console/inspect POST and returns the records", async () => {
		const mock = mockFetchSequence([
			(_url, init) => {
				expect(init?.method).toBe("POST");
				return jsonResponse([{ name: "print", type: "cmd" }]);
			},
		]);
		try {
			const adapter = createProtocolAdapter(restConfig());
			const records = await adapter.inspect("child", "system,resource,print");
			expect(records).toEqual([{ name: "print", type: "cmd" }]);
			expect(mock.calls[0]?.url).toBe(
				"http://192.0.2.10:80/rest/console/inspect",
			);
		} finally {
			mock.restore();
		}
	});

	test("list without projection uses a GET", async () => {
		const mock = mockFetchSequence([
			(_url, init) => {
				expect(init?.method).toBe("GET");
				return jsonResponse([{ ".id": "*1" }]);
			},
		]);
		try {
			const adapter = createProtocolAdapter(restConfig());
			const rows = await adapter.list("/ip/address", {});
			expect(rows).toEqual([{ ".id": "*1" }]);
			expect(mock.calls[0]?.url).toBe("http://192.0.2.10:80/rest/ip/address");
		} finally {
			mock.restore();
		}
	});

	test("list with a proplist uses a /print POST carrying .proplist", async () => {
		const mock = mockFetchSequence([
			(_url, init) => {
				const body = JSON.parse(String(init?.body)) as {
					".proplist"?: unknown;
				};
				expect(body[".proplist"]).toEqual(["name", "type"]);
				return jsonResponse([{ name: "ether1", type: "ether" }]);
			},
		]);
		try {
			const adapter = createProtocolAdapter(restConfig());
			const rows = await adapter.list("/interface", {
				proplist: ["name", "type"],
			});
			expect(rows).toEqual([{ name: "ether1", type: "ether" }]);
			expect(mock.calls[0]?.url).toBe(
				"http://192.0.2.10:80/rest/interface/print",
			);
		} finally {
			mock.restore();
		}
	});

	test("maps a 401 to a structured transport/auth-failed error", async () => {
		const mock = mockFetchSequence([
			() => jsonResponse({ detail: "not authorized" }, 401),
		]);
		try {
			const adapter = createProtocolAdapter(restConfig());
			const error = await adapter
				.getSingleton("/system/identity")
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CentrsError);
			expect((error as CentrsError).code).toBe("transport/auth-failed");
		} finally {
			mock.restore();
		}
	});

	test("maps a 5xx to retryable transport/connection-closed", async () => {
		const mock = mockFetchSequence([
			() => jsonResponse({ detail: "internal error" }, 500),
		]);
		try {
			const adapter = createProtocolAdapter(restConfig());
			const error = await adapter
				.getSingleton("/system/resource")
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CentrsError);
			expect((error as CentrsError).code).toBe("transport/connection-closed");
		} finally {
			mock.restore();
		}
	});

	test("maps REST detail through the shared RouterOS error mapper", async () => {
		const detail = "unknown parameter foo";
		const mock = mockFetchSequence([() => jsonResponse({ detail }, 400)]);
		try {
			const adapter = createProtocolAdapter(restConfig());
			const error = await adapter
				.getSingleton("/ip/address")
				.catch((caught: unknown) => caught);
			const native = mapRouterOsError(detail, { transport: "native-api" });
			expect(error).toBeInstanceOf(CentrsError);
			expect((error as CentrsError).code).toBe(native.code);
			expect((error as CentrsError).causeData).toBe(detail);
			expect((error as CentrsError).context).toMatchObject({
				detail,
				httpStatus: 400,
				status: 400,
				via: "rest-api",
			});
		} finally {
			mock.restore();
		}
	});

	test("maps REST session-closed detail with the shared RouterOS code", async () => {
		const detail = "Session closed";
		const mock = mockFetchSequence([() => jsonResponse({ detail }, 400)]);
		try {
			const adapter = createProtocolAdapter(restConfig());
			const error = await adapter
				.getSingleton("/interface")
				.catch((caught: unknown) => caught);
			const native = mapRouterOsError(detail, { transport: "native-api" });
			expect(error).toBeInstanceOf(CentrsError);
			expect((error as CentrsError).code).toBe(native.code);
			expect((error as CentrsError).code).toBe("routeros/session-closed");
		} finally {
			mock.restore();
		}
	});

	test("maps REST 404 detail through the shared RouterOS error mapper", async () => {
		const detail = "/ip/nope not found";
		const mock = mockFetchSequence([() => jsonResponse({ detail }, 404)]);
		try {
			const adapter = createProtocolAdapter(restConfig());
			const error = await adapter
				.getSingleton("/ip/nope")
				.catch((caught: unknown) => caught);
			const native = mapRouterOsError(detail, { transport: "native-api" });
			expect(error).toBeInstanceOf(CentrsError);
			expect((error as CentrsError).code).toBe(native.code);
			expect((error as CentrsError).code).toBe("routeros/unknown-path");
		} finally {
			mock.restore();
		}
	});
});

describe("RestAdapter execute seam", () => {
	test("structured path-POST posts attributes to /<path>/<command>", async () => {
		const mock = mockFetchSequence([
			(_url, init) => {
				expect(init?.method).toBe("POST");
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				expect(body).toEqual({ address: "192.0.2.1/24", interface: "ether1" });
				return jsonResponse({ ".id": "*5" });
			},
		]);
		try {
			const adapter = createProtocolAdapter(restConfig());
			const result = await adapter.execute({
				path: "/ip/address",
				command: "add",
				attributes: { address: "192.0.2.1/24", interface: "ether1" },
			});
			expect(result.records).toEqual([{ ".id": "*5" }]);
			expect(mock.calls[0]?.url).toBe(
				"http://192.0.2.10:80/rest/ip/address/add",
			);
		} finally {
			mock.restore();
		}
	});

	test("script fallback posts to /rest/execute and surfaces ret", async () => {
		const mock = mockFetchSequence([
			(_url, init) => {
				const body = JSON.parse(String(init?.body)) as { script?: string };
				expect(body.script).toBe(":put 1");
				return jsonResponse({ ret: "1" });
			},
		]);
		try {
			const adapter = createProtocolAdapter(restConfig());
			const result = await adapter.execute({
				path: "",
				command: "",
				script: ":put 1",
			});
			expect(result).toEqual({ records: [], ret: "1" });
			expect(mock.calls[0]?.url).toBe("http://192.0.2.10:80/rest/execute");
		} finally {
			mock.restore();
		}
	});
});

// #404, CHR-grounded on 7.23.7 + 7.24.5: RouterOS carries `/file` contents as
// raw bytes in the JSON string (0x80–0xff unescaped, <0x20 as `\u00XX`) and
// stores the UTF-8 encoding of every JSON code point it receives.
describe("RestAdapter binary execute (#404)", () => {
	const bytes = Buffer.from([0xff, 0x80, 0x00, 0x41]);
	const byteString = bytes.toString("latin1");
	/** The device's reply: raw high bytes inside a JSON string, so not UTF-8. */
	const rawReply = () =>
		new Response(
			Buffer.concat([
				Buffer.from('{"ret":"'),
				Buffer.from([0xff, 0x80]),
				Buffer.from('\\u0000A"}'),
			]),
			{ headers: { "Content-Type": "application/json" } },
		);

	test("sends contents as raw body bytes, not UTF-8", async () => {
		const mock = mockFetchSequence([() => jsonResponse({})]);
		try {
			const adapter = createProtocolAdapter(restConfig());
			await adapter.execute({
				path: "/file",
				command: "set",
				attributes: { ".id": "*1", contents: byteString },
				binary: true,
			});
			const body = Buffer.from(mock.calls[0]?.init?.body as Uint8Array);
			expect(
				body.equals(
					Buffer.from('{".id":"*1","contents":"\xff\x80\\u0000A"}', "latin1"),
				),
			).toBe(true);
		} finally {
			mock.restore();
		}
	});

	test("reads a reply's raw bytes back exactly", async () => {
		const mock = mockFetchSequence([rawReply]);
		try {
			const adapter = createProtocolAdapter(restConfig());
			const result = await adapter.execute({
				path: "/file",
				command: "get",
				attributes: { ".id": "*1", "value-name": "contents" },
				binary: true,
			});
			expect(Buffer.from(result.ret ?? "", "latin1").equals(bytes)).toBe(true);
		} finally {
			mock.restore();
		}
	});

	test("control: the text path replaces the same reply's high bytes", async () => {
		const mock = mockFetchSequence([rawReply]);
		try {
			const adapter = createProtocolAdapter(restConfig());
			const result = await adapter.execute({
				path: "/file",
				command: "get",
				attributes: { ".id": "*1", "value-name": "contents" },
			});
			expect(result.ret).toBe("\ufffd\ufffd\u0000A");
		} finally {
			mock.restore();
		}
	});

	test("refuses a character that is not a byte instead of truncating it", async () => {
		const mock = mockFetchSequence([]);
		try {
			const adapter = createProtocolAdapter(restConfig());
			await expect(
				adapter.execute({
					path: "/file",
					command: "set",
					attributes: { ".id": "*1", contents: "\u20ac" },
					binary: true,
				}),
			).rejects.toMatchObject({ code: "internal/byte-string" });
			expect(mock.calls).toHaveLength(0);
		} finally {
			mock.restore();
		}
	});
});

describe("REST structured POST query/projection", () => {
	test("forwards command attributes together with query and projection", async () => {
		const mock = mockFetchSequence([
			(_url, init) => {
				expect(JSON.parse(String(init?.body))).toEqual({
					interval: "1",
					".query": ["interface=ether1"],
					".proplist": ["address"],
				});
				return jsonResponse([]);
			},
		]);
		try {
			await createProtocolAdapter(restConfig()).apiRequest({
				verb: "run",
				path: "/ip/address/print",
				attributes: { interval: "1" },
				query: ["interface=ether1"],
				proplist: ["address"],
			});
		} finally {
			mock.restore();
		}
	});
});

describe("native pre-aborted incremental request", () => {
	test("returns before dialing the adapter endpoint", async () => {
		const adapter = createProtocolAdapter(
			restConfig({ protocol: "native-api", host: "127.0.0.1", port: 1 }),
		);
		const controller = new AbortController();
		controller.abort();
		const rows = [];
		for await (const row of adapter.stream(
			{ verb: "add", path: "/ip/address" },
			{ signal: controller.signal },
		))
			rows.push(row);
		expect(rows).toEqual([]);
		await adapter.close();
	});
});
