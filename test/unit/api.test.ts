import { describe, expect, test } from "bun:test";
import {
	type ApiOutputFormat,
	apiEnvelope,
	buildApiBody,
	buildApiErrorEnvelope,
	buildApiErrorEnvelopeFromResolved,
	buildApiQuery,
	buildProtocolApiRequest,
	isApiMutating,
	mapMethodToVerb,
	normalizeApiEndpoint,
	type ResolvedApiRequest,
	renderApiEnvelope,
	resolveApiRequest,
} from "../../src/api.ts";
import { CentrsError } from "../../src/errors.ts";

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

	test("script mode carries the script", () => {
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

	test("script mode requires a non-empty script", () => {
		expect(() =>
			buildProtocolApiRequest(
				resolved({ verb: "run", path: "/execute", scriptMode: true, body: {} }),
			),
		).toThrow("non-empty `script`");
	});

	test("script mode rejects extra body fields", () => {
		expect(() =>
			buildProtocolApiRequest(
				resolved({
					verb: "run",
					path: "/execute",
					scriptMode: true,
					body: { script: ":put 1", extra: "x" },
				}),
			),
		).toThrow("only the `script`");
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

	test("/execute rejects extra fields before live validation", async () => {
		const envelope = await apiEnvelope(
			{
				endpoint: "execute",
				targetInput: "127.0.0.1",
				port: 1,
				via: "native-api",
				username: "x",
				password: "y",
				method: "POST",
				fields: { script: ":put 1", extra: "x" },
				yes: true,
			},
			{},
		);
		expect(envelope.ok).toBe(false);
		if (!envelope.ok) {
			expect(envelope.error.code).toBe("usage/conflicting-flags");
			expect(envelope.error.context).toMatchObject({ extraFields: ["extra"] });
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

	test("PATCH/DELETE without a row id is input/invalid-path (no request issued)", async () => {
		for (const method of ["PATCH", "DELETE"]) {
			const envelope = await apiEnvelope(
				{ endpoint: "ip/address", targetInput: "192.0.2.1", method },
				{},
			);
			expect(envelope.ok).toBe(false);
			if (!envelope.ok) {
				expect(envelope.error.code).toBe("input/invalid-path");
			}
		}
	});

	test("an invalid -X is reported verbatim on the error envelope, not rewritten to GET", () => {
		const envelope = buildApiErrorEnvelope(
			{ endpoint: "ip/address", method: "HEAD" },
			new Error("boom"),
			{},
		);
		expect(envelope.meta.operation?.request.method).toBe("HEAD");
		expect(envelope.meta.operation?.request.verb).toBeNull();
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

describe("`--raw` is a precedence layer for --validate, not an override (#154)", () => {
	// `--raw` strips the envelope and was always MEANT to default validation off,
	// but `--raw --validate=true` is the intended way to debug `api` when centrs
	// itself is suspect — the gate runs and the failure renders through the
	// `--raw` error contract. The old code short-circuited the whole resolution
	// ladder, silently discarding an explicit `--validate=true` along with env,
	// CDB comment-kv and config.
	const base = {
		endpoint: "/ip/address",
		host: "192.0.2.1",
		username: "u",
		password: "p",
	} as const;

	test("an explicit --validate outranks --raw in both directions", async () => {
		const on = await resolveApiRequest(
			{ ...base, raw: true, validate: true },
			{},
		);
		expect(on.validate.value).toBe(true);
		expect(on.validate.source.kind).toBe("explicit");

		const off = await resolveApiRequest(
			{ ...base, raw: true, validate: false },
			{},
		);
		expect(off.validate.value).toBe(false);
		expect(off.validate.source.kind).toBe("explicit");
	});

	test("--raw alone still defaults validation off, and says so", async () => {
		const resolved = await resolveApiRequest({ ...base, raw: true }, {});
		expect(resolved.validate.value).toBe(false);
		// The provenance is kept: "off because --raw", not an anonymous default.
		expect(resolved.validate.source).toEqual({ kind: "cli", key: "--raw" });
	});

	test("--raw outranks the ambient sources, so it behaves the same everywhere", async () => {
		const resolved = await resolveApiRequest(
			{ ...base, raw: true },
			{
				CENTRS_VALIDATE: "true",
			},
		);
		expect(resolved.validate.value).toBe(false);
		expect(resolved.validate.source).toEqual({ kind: "cli", key: "--raw" });
	});

	test("a rejection under --raw --validate=true is the raw error contract", async () => {
		// #154's actual deliverable: it is not enough that the gate RUNS — the
		// rejection has to come back in the `--raw` shape, or the flag pair is
		// useless for the debugging it exists for. No new rendering code was
		// added for this; the assertion is that the existing contract covers a
		// validation rejection exactly as it covers any other preflight failure.
		const resolved = await resolveApiRequest(
			{ ...base, raw: true, validate: true },
			{},
		);
		expect(resolved.validate.value).toBe(true);

		const envelope = buildApiErrorEnvelopeFromResolved(
			resolved,
			new CentrsError({
				code: "validation/unknown-attribute",
				summary: "Unknown RouterOS attribute nope for /ip/address/print.",
				remediation: "Check the attribute name against `/console/inspect`.",
			}),
		);
		// The summary must agree with the request that was actually made.
		expect(envelope.meta.operation?.request.validate).toBe(true);
		expect(envelope.meta.operation?.request.raw).toBe(true);

		const rendered = JSON.parse(
			renderApiEnvelope(envelope, "json", { raw: true }),
		);
		expect(rendered).toMatchObject({
			code: "validation/unknown-attribute",
			message: "Unknown RouterOS attribute nope for /ip/address/print.",
		});
		// No envelope, and above all no `data` key — the CLI keys its exit code
		// and its stdout/stderr split off `ok`, which the raw payload drops.
		expect(rendered).not.toHaveProperty("data");
		expect(rendered).not.toHaveProperty("ok");
	});

	test("a pre-resolution summary reports the same precedence", () => {
		// `buildApiErrorEnvelope` and `apiRequestSummaryFromRequest` run where the
		// CDB and config tiers are not loaded, so they used to spell the coupling a
		// second time as `raw ? false : …` — and contradicted the resolved request
		// for `--raw --validate=true`.
		const envelope = buildApiErrorEnvelope(
			{ ...base, raw: true, validate: true },
			new CentrsError({ code: "usage/invalid-flag", summary: "nope." }),
			{},
		);
		expect(envelope.meta.operation?.request.validate).toBe(true);

		const off = buildApiErrorEnvelope(
			{ ...base, raw: true },
			new CentrsError({ code: "usage/invalid-flag", summary: "nope." }),
			{},
		);
		expect(off.meta.operation?.request.validate).toBe(false);
	});

	test("a malformed ambient value cannot break a call --raw already settled", async () => {
		// The `--raw` arm has to SHORT-CIRCUIT rather than win a comparison:
		// resolving the ambient layer first parsed `CENTRS_VALIDATE` even when
		// `--raw` decided the value, so a junk env var threw out of a call that
		// never needed it — reintroducing the machine-dependence this layer removes.
		const resolved = await resolveApiRequest(
			{ ...base, raw: true },
			{
				CENTRS_VALIDATE: "maybe",
			},
		);
		expect(resolved.validate.value).toBe(false);
		// An explicit `--validate` short-circuits the ladder for the same reason,
		// so it does not read the junk value either — that is how every setting
		// resolves, not something special to `--raw`.
		const explicit = await resolveApiRequest(
			{ ...base, raw: true, validate: true },
			{ CENTRS_VALIDATE: "maybe" },
		);
		expect(explicit.validate.value).toBe(true);

		// The junk value is still reported where it is actually consulted: no
		// `--raw`, no explicit flag, so the ambient layer is the deciding one.
		expect(
			resolveApiRequest({ ...base }, { CENTRS_VALIDATE: "maybe" }),
		).rejects.toThrow(/boolean/i);
	});

	test("without --raw the ladder is untouched", async () => {
		expect((await resolveApiRequest({ ...base }, {})).validate.value).toBe(
			true,
		);
		const env = await resolveApiRequest(
			{ ...base },
			{
				CENTRS_VALIDATE: "false",
			},
		);
		expect(env.validate.value).toBe(false);
		expect(env.validate.source.kind).toBe("env");
	});
});

describe("api validation metadata survives the error boundary (#354, PR #356 review)", () => {
	const base = {
		endpoint: "/ip/address",
		host: "192.0.2.1",
		username: "u",
		password: "p",
	} as const;

	test("a post-validation transport fault does not claim /console/inspect failed", async () => {
		// The gate settled before `backend.apiRequest` ran. Rebuilding the meta
		// here reported `/console/inspect` as the failing validator and dropped
		// `stages`, which is exactly the accepted-vs-skipped distinction the
		// validation contract requires readers to be able to make.
		const resolved = await resolveApiRequest({ ...base }, {});
		const settled = {
			enabled: true,
			source: "/console/inspect request=child",
			result: "passed" as const,
			syntax: false,
			semantic: true,
		};
		const envelope = buildApiErrorEnvelopeFromResolved(
			resolved,
			new CentrsError({
				code: "transport/unreachable",
				summary: "connection refused",
			}),
			{ validation: settled },
		);
		expect(envelope.meta.validation).toEqual(settled);
	});

	test("a structured request's offline stage is skipped, with the reason named", async () => {
		// `api` only offline-gates script mode; a path plus a body is not a CLI
		// string. Saying `passed` here would claim an analysis that never ran.
		const resolved = await resolveApiRequest({ ...base }, {});
		const envelope = buildApiErrorEnvelopeFromResolved(
			resolved,
			new CentrsError({
				code: "validation/unknown-attribute",
				summary: "Unknown RouterOS attribute",
			}),
		);
		const stages = envelope.meta.validation?.stages ?? [];
		expect(stages[0]).toMatchObject({
			stage: "offline",
			result: "skipped",
		});
		expect(stages[0]?.reason).toContain("structured path request");
		expect(stages[1]?.result).toBe("failed");
	});

	test("an api /execute parse rejection names the live device stage", async () => {
		const resolved = await resolveApiRequest(
			{
				...base,
				endpoint: "/execute",
				method: "POST",
				fields: { script: "/ip/address/add no-such-arg=x" },
			},
			{},
		);
		const envelope = buildApiErrorEnvelopeFromResolved(
			resolved,
			new CentrsError({
				code: "validation/unknown-attribute",
				summary: "bad parameter no-such-arg",
			}),
			{ offlineVerdict: "pass" },
		);
		expect(envelope.meta.validation).toMatchObject({
			source: ":put [:parse]",
			result: "failed",
			semantic: "not-applicable",
			stages: [
				{ stage: "offline", result: "passed" },
				{ stage: "device", source: ":put [:parse]", result: "failed" },
			],
		});
	});

	test("--raw (validation disabled) lists both stages as skipped", async () => {
		const resolved = await resolveApiRequest({ ...base, raw: true }, {});
		const envelope = buildApiErrorEnvelopeFromResolved(
			resolved,
			new CentrsError({ code: "transport/unreachable", summary: "nope" }),
		);
		expect(envelope.meta.validation?.enabled).toBe(false);
		expect(
			(envelope.meta.validation?.stages ?? []).map((stage) => [
				stage.stage,
				stage.result,
			]),
		).toEqual([
			["offline", "skipped"],
			["device", "skipped"],
		]);
	});
});
