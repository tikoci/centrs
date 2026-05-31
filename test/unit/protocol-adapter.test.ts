import { describe, expect, test } from "bun:test";
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

	test("defaults unknown protocols to the REST adapter", () => {
		const adapter = createProtocolAdapter(restConfig({ protocol: "ssh" }));
		expect(adapter.protocol).toBe("ssh");
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
