import { describe, expect, test } from "bun:test";
import {
	type ApiOutputFormat,
	apiEnvelope,
	buildApiBody,
	buildApiQuery,
	buildProtocolApiRequest,
	isApiMutating,
	mapMethodToVerb,
	normalizeApiEndpoint,
	type ResolvedApiRequest,
	renderApiEnvelope,
} from "../../src/api.ts";

describe("normalizeApiEndpoint", () => {
	test("lenient variants canonicalize to one slash path", () => {
		for (const endpoint of [
			"ip/address",
			"/ip/address",
			"rest/ip/address",
			"/rest/ip/address",
			"ip address",
			"  ip   address  ",
		]) {
			expect(normalizeApiEndpoint(endpoint)).toEqual({
				path: "/ip/address",
				id: undefined,
				listen: false,
			});
		}
	});

	test("splits a trailing object id", () => {
		expect(normalizeApiEndpoint("ip/address/*1")).toEqual({
			path: "/ip/address",
			id: "*1",
			listen: false,
		});
		expect(normalizeApiEndpoint("/rest/ip/address/*A3")).toEqual({
			path: "/ip/address",
			id: "*A3",
			listen: false,
		});
	});

	test("infers listen from a trailing /listen segment", () => {
		expect(normalizeApiEndpoint("ip/address/listen")).toEqual({
			path: "/ip/address",
			id: undefined,
			listen: true,
		});
	});

	test("keeps a command verb in the path (print/monitor-traffic)", () => {
		expect(normalizeApiEndpoint("interface/monitor-traffic").path).toBe(
			"/interface/monitor-traffic",
		);
		expect(normalizeApiEndpoint("ip/address/print").path).toBe(
			"/ip/address/print",
		);
		expect(normalizeApiEndpoint("execute").path).toBe("/execute");
	});
});

describe("mapMethodToVerb", () => {
	test("the gh-api -X map", () => {
		expect(mapMethodToVerb("GET")).toBe("print");
		expect(mapMethodToVerb("PUT")).toBe("add");
		expect(mapMethodToVerb("PATCH")).toBe("set");
		expect(mapMethodToVerb("DELETE")).toBe("remove");
		expect(mapMethodToVerb("POST")).toBe("run");
	});
});

describe("isApiMutating", () => {
	test("GET and print/get/listen terminal verbs are read-only", () => {
		expect(isApiMutating("GET", "/ip/address")).toBe(false);
		// A POST .../print paged read keys on the verb, not the wire method.
		expect(isApiMutating("POST", "/ip/address/print")).toBe(false);
		expect(isApiMutating("POST", "/ip/address/get")).toBe(false);
		expect(isApiMutating("GET", "/ip/address/listen")).toBe(false);
	});

	test("PUT/PATCH/DELETE and command POSTs are writes", () => {
		expect(isApiMutating("PUT", "/ip/address")).toBe(true);
		expect(isApiMutating("PATCH", "/ip/address")).toBe(true);
		expect(isApiMutating("DELETE", "/ip/address")).toBe(true);
		// Streaming does not imply read-only: a renew that streams still confirms.
		expect(isApiMutating("POST", "/system/license/renew")).toBe(true);
	});
});

describe("buildApiBody", () => {
	test("merges -f fields verbatim", () => {
		expect(
			buildApiBody({ endpoint: "ip/address", fields: { a: "1", b: "x" } }),
		).toEqual({ a: "1", b: "x" });
	});

	test("parses a -d JSON object", () => {
		expect(
			buildApiBody({
				endpoint: "ip/address",
				data: '{"address":"1.2.3.4/32"}',
			}),
		).toEqual({ address: "1.2.3.4/32" });
	});

	test("parses an --input JSON object", () => {
		expect(
			buildApiBody({ endpoint: "ip/address", inputBody: '{"x":"y"}' }),
		).toEqual({ x: "y" });
	});

	test("stringifies non-string JSON values", () => {
		expect(buildApiBody({ endpoint: "x", data: '{"n":5,"b":true}' })).toEqual({
			n: "5",
			b: "true",
		});
	});

	test("rejects combining body sources", () => {
		expect(() =>
			buildApiBody({ endpoint: "x", fields: { a: "1" }, data: "{}" }),
		).toThrow("only one body source");
	});

	test("rejects a non-object JSON body", () => {
		expect(() => buildApiBody({ endpoint: "x", data: "[1,2]" })).toThrow(
			"must be a JSON object",
		);
		expect(() => buildApiBody({ endpoint: "x", data: "not json" })).toThrow(
			"not valid JSON",
		);
	});
});

describe("buildApiQuery", () => {
	test("structured operators map to REST query words", () => {
		expect(buildApiQuery({ endpoint: "x", query: ["type=ether"] })).toEqual([
			"type=ether",
		]);
		expect(buildApiQuery({ endpoint: "x", query: ["type!=ether"] })).toEqual([
			"type=ether",
			"#!",
		]);
		expect(
			buildApiQuery({ endpoint: "x", query: ["actual-mtu>1000"] }),
		).toEqual([">actual-mtu=1000"]);
		expect(buildApiQuery({ endpoint: "x", query: ["mtu<2000"] })).toEqual([
			"<mtu=2000",
		]);
		expect(buildApiQuery({ endpoint: "x", query: ["running"] })).toEqual([
			"running",
		]);
	});

	test("structured words come first, then verbatim raw words", () => {
		expect(
			buildApiQuery({
				endpoint: "x",
				query: ["type=ether"],
				rawQuery: ["type=loopback", "#|"],
			}),
		).toEqual(["type=ether", "type=loopback", "#|"]);
	});
});

describe("buildProtocolApiRequest", () => {
	function resolved(extra: Partial<ResolvedApiRequest>): ResolvedApiRequest {
		return {
			verb: "print",
			path: "/ip/address",
			scriptMode: false,
			body: {},
			query: [],
			proplist: [],
			...extra,
		} as ResolvedApiRequest;
	}

	test("print carries query + proplist + id, not a body", () => {
		expect(
			buildProtocolApiRequest(
				resolved({ verb: "print", query: ["type=ether"], proplist: ["name"] }),
			),
		).toEqual({
			verb: "print",
			path: "/ip/address",
			query: ["type=ether"],
			proplist: ["name"],
		});
		expect(
			buildProtocolApiRequest(resolved({ verb: "print", id: "*1" })),
		).toEqual({ verb: "print", path: "/ip/address", id: "*1" });
	});

	test("add/set/run carry the body as attributes", () => {
		expect(
			buildProtocolApiRequest(
				resolved({ verb: "add", body: { address: "1.2.3.4/32" } }),
			),
		).toEqual({
			verb: "add",
			path: "/ip/address",
			attributes: { address: "1.2.3.4/32" },
		});
	});

	test("script mode carries the script, ignoring the rest", () => {
		expect(
			buildProtocolApiRequest(
				resolved({
					verb: "run",
					path: "/execute",
					scriptMode: true,
					body: { script: ":put 1" },
				}),
			),
		).toEqual({ verb: "run", path: "/execute", script: ":put 1" });
	});
});

describe("apiEnvelope usage errors (no I/O)", () => {
	test("an unsupported -X method is usage/invalid-method", async () => {
		const envelope = await apiEnvelope(
			{ endpoint: "ip/address", targetInput: "192.0.2.1", method: "HEAD" },
			{},
		);
		expect(envelope.ok).toBe(false);
		if (!envelope.ok) {
			expect(envelope.error.code).toBe("usage/invalid-method");
		}
	});

	test("combining -f and -d is usage/conflicting-flags", async () => {
		const envelope = await apiEnvelope(
			{
				endpoint: "ip/address",
				targetInput: "192.0.2.1",
				method: "PUT",
				fields: { a: "1" },
				data: "{}",
			},
			{},
		);
		expect(envelope.ok).toBe(false);
		if (!envelope.ok) {
			expect(envelope.error.code).toBe("usage/conflicting-flags");
		}
	});

	test("an empty endpoint is input/invalid-command", async () => {
		const envelope = await apiEnvelope(
			{ endpoint: "", targetInput: "192.0.2.1" },
			{},
		);
		expect(envelope.ok).toBe(false);
		if (!envelope.ok) {
			expect(envelope.error.code).toBe("input/invalid-command");
		}
	});
});

describe("renderApiEnvelope --raw", () => {
	const okEnvelope = {
		ok: true as const,
		data: [{ ".id": "*1", address: "1.2.3.4/32" }],
		warnings: [],
		tips: [],
		meta: {
			target: {},
			via: "rest-api" as const,
			settings: {},
			operation: {
				kind: "api" as const,
				objectCount: 1,
				request: {
					endpoint: "ip/address",
					path: "/ip/address",
					method: "GET" as const,
					verb: "print" as const,
					write: false,
					listen: false,
					yes: false,
					validate: false,
					raw: true,
					format: "json" as ApiOutputFormat,
				},
				auth: { passwordProvided: false },
			},
		},
	};

	test("success prints the bare RouterOS body, no envelope", () => {
		const rendered = renderApiEnvelope(okEnvelope, "json", { raw: true });
		expect(JSON.parse(rendered)).toEqual([
			{ ".id": "*1", address: "1.2.3.4/32" },
		]);
		expect(rendered).not.toContain('"meta"');
		expect(rendered).not.toContain('"ok"');
	});

	test("an error renders a compact code/message payload", () => {
		const errorEnvelope = {
			ok: false as const,
			error: {
				name: "CentrsError" as const,
				code: "routeros/invalid-value" as const,
				summary: "bad value",
				message: "bad value",
				detailsUrl: "x",
				details_url: "x",
			},
			warnings: [],
			tips: [],
			meta: okEnvelope.meta,
		};
		const rendered = renderApiEnvelope(errorEnvelope, "json", { raw: true });
		const parsed = JSON.parse(rendered) as { code: string; message: string };
		expect(parsed.code).toBe("routeros/invalid-value");
		expect(parsed.message).toBe("bad value");
	});
});
