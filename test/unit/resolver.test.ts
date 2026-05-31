import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	retrieve,
	winBoxCdbRecordType,
} from "../../src/index.ts";
import {
	type CdbResolution,
	coerceCommentKv,
	type ResolverWarning,
	resolveBooleanSetting,
	resolveCdb,
	resolveOptionalIntegerSetting,
	resolveStringSetting,
	resolveTarget,
} from "../../src/resolver/index.ts";

const EMPTY_ENV: Record<string, string | undefined> = {};

describe("resolver comment-kv coercion", () => {
	test("coerces allowlisted overrides to typed settings with provenance", () => {
		const warnings: ResolverWarning[] = [];
		const overrides = coerceCommentKv(
			'via=native-api port=8729 timeout=5s validate=false source=arp "free text"',
			3,
			warnings,
		);

		expect(warnings).toEqual([]);
		expect(overrides.via?.value).toBe("native-api");
		expect(overrides.via?.source).toEqual({
			kind: "comment-kv",
			key: "record:3:via",
		});
		expect(overrides.port?.value).toBe(8729);
		expect(overrides.timeoutMs?.value).toBe(5000);
		expect(overrides.validate?.value).toBe(false);
		expect(overrides.source?.value).toBe("arp");
		expect(overrides.port?.source.kind).toBe("comment-kv");
	});

	test("emits cdb/invalid-option for a malformed port and drops it", () => {
		const warnings: ResolverWarning[] = [];
		const overrides = coerceCommentKv("port=99999", 1, warnings);

		expect(overrides.port).toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.code).toBe("cdb/invalid-option");
		expect(warnings[0]?.context).toMatchObject({
			key: "port",
			value: "99999",
			recordIndex: 1,
		});
	});

	test("emits cdb/invalid-option for malformed via/timeout/validate", () => {
		const warnings: ResolverWarning[] = [];
		const overrides = coerceCommentKv(
			"via=carrier-pigeon timeout=soon validate=maybe",
			0,
			warnings,
		);

		expect(overrides.via).toBeUndefined();
		expect(overrides.timeoutMs).toBeUndefined();
		expect(overrides.validate).toBeUndefined();
		expect(warnings.map((warning) => warning.code)).toEqual([
			"cdb/invalid-option",
			"cdb/invalid-option",
			"cdb/invalid-option",
		]);
		expect(warnings.map((warning) => warning.context?.["key"])).toEqual([
			"via",
			"timeout",
			"validate",
		]);
	});

	test("surfaces parser reserved/unknown-key warnings", () => {
		const warnings: ResolverWarning[] = [];
		coerceCommentKv("user=admin mystery=42", 7, warnings);

		expect(warnings.map((warning) => warning.code).sort()).toEqual([
			"cdb/reserved-option",
			"cdb/unknown-option",
		]);
	});
});

describe("resolver settings precedence", () => {
	// Constitution order, lowest → highest: default < config < comment-kv < env
	// < cli. (No config-file layer is implemented yet; it is a documented seam.)
	const commentKv = {
		value: "comment-host",
		source: { kind: "comment-kv" as const, key: "record:0:host" },
	};

	test("cli beats env beats comment-kv beats default", () => {
		const cli = resolveStringSetting(
			"cli-host",
			{ CENTRS_HOST: "env-host" },
			"CENTRS_HOST",
			"default-host",
			"host",
			undefined,
			commentKv,
		);
		expect(cli?.value).toBe("cli-host");

		const env = resolveStringSetting(
			undefined,
			{ CENTRS_HOST: "env-host" },
			"CENTRS_HOST",
			"default-host",
			"host",
			undefined,
			commentKv,
		);
		expect(env?.value).toBe("env-host");
		expect(env?.source.kind).toBe("env");

		const comment = resolveStringSetting(
			undefined,
			EMPTY_ENV,
			"CENTRS_HOST",
			"default-host",
			"host",
			undefined,
			commentKv,
		);
		expect(comment?.value).toBe("comment-host");
		expect(comment?.source.kind).toBe("comment-kv");

		const fallback = resolveStringSetting(
			undefined,
			EMPTY_ENV,
			"CENTRS_HOST",
			"default-host",
			"via",
		);
		expect(fallback?.value).toBe("default-host");
		expect(fallback?.source.kind).toBe("default");
	});

	test("boolean precedence places comment-kv above the built-in default", () => {
		const fromComment = resolveBooleanSetting(
			undefined,
			EMPTY_ENV,
			"CENTRS_VALIDATE",
			true,
			"validate",
			{
				value: false,
				source: { kind: "comment-kv", key: "record:0:validate" },
			},
		);
		expect(fromComment.value).toBe(false);
		expect(fromComment.source.kind).toBe("comment-kv");

		const fromEnv = resolveBooleanSetting(
			undefined,
			{ CENTRS_VALIDATE: "true" },
			"CENTRS_VALIDATE",
			true,
			"validate",
			{
				value: false,
				source: { kind: "comment-kv", key: "record:0:validate" },
			},
		);
		expect(fromEnv.value).toBe(true);
		expect(fromEnv.source.kind).toBe("env");
	});

	test("optional integer precedence honors the comment-kv layer", () => {
		const fromComment = resolveOptionalIntegerSetting(
			undefined,
			EMPTY_ENV,
			"CENTRS_PORT",
			"port",
			{ value: 8080, source: { kind: "comment-kv", key: "record:0:port" } },
		);
		expect(fromComment?.value).toBe(8080);
		expect(fromComment?.source.kind).toBe("comment-kv");

		const fromCli = resolveOptionalIntegerSetting(
			443,
			EMPTY_ENV,
			"CENTRS_PORT",
			"port",
			{ value: 8080, source: { kind: "comment-kv", key: "record:0:port" } },
		);
		expect(fromCli?.value).toBe(443);
		expect(fromCli?.source.kind).toBe("explicit");
	});
});

describe("resolver target provenance", () => {
	function cdbFixture(overrides: CdbResolution["overrides"]): CdbResolution {
		return {
			target: "10.0.0.5",
			name: "edge-router",
			username: "admin",
			password: "secret",
			recordIndex: 4,
			overrides,
			warnings: [],
		};
	}

	test("populates a per-field sources map for a bare positional target", () => {
		const target = resolveTarget(
			{ targetInput: "192.0.2.10" },
			EMPTY_ENV,
			"rest-api",
		);

		expect(target.host).toBe("192.0.2.10");
		expect(target.port).toBe(80);
		expect(target.sources["host"]?.kind).toBe("target-input");
		// A bare positional on its scheme-default REST port is a built-in default.
		expect(target.sources["port"]).toEqual({
			kind: "default",
			key: "http default",
		});
	});

	test("attributes CDB identity and comment-kv port override per field", () => {
		const target = resolveTarget(
			{ targetInput: "edge-router" },
			EMPTY_ENV,
			"rest-api",
			cdbFixture({
				port: {
					value: 8080,
					source: { kind: "comment-kv", key: "record:4:port" },
				},
			}),
		);

		expect(target.host).toBe("10.0.0.5");
		expect(target.name).toBe("edge-router");
		expect(target.recordIndex).toBe(4);
		expect(target.source).toEqual({ kind: "cdb", key: "record:4" });
		expect(target.sources["host"]).toEqual({ kind: "cdb", key: "record:4" });
		expect(target.port).toBe(8080);
		expect(target.sources["port"]).toEqual({
			kind: "comment-kv",
			key: "record:4:port",
		});
	});

	test("a --port flag wins over a comment-kv port override", () => {
		const target = resolveTarget(
			{ targetInput: "edge-router", port: 8443 },
			EMPTY_ENV,
			"rest-api",
			cdbFixture({
				port: {
					value: 8080,
					source: { kind: "comment-kv", key: "record:4:port" },
				},
			}),
		);

		expect(target.port).toBe(8443);
		expect(target.sources["port"]?.kind).toBe("explicit");
	});
});

describe("resolver native-api TLS/port disambiguation", () => {
	test("https implies api-ssl on the default TLS port", () => {
		const target = resolveTarget(
			{ targetInput: "https://10.0.0.5" },
			EMPTY_ENV,
			"native-api",
		);
		expect(target.tls).toBe(true);
		expect(target.port).toBe(8729);
		expect(target.baseUrl).toBe("api-ssl://10.0.0.5:8729");
	});

	test("an explicit plaintext port (8728) stays plaintext even with https", () => {
		// #8: https://host --via native-api --port 8728 must not run a TLS
		// handshake against the plaintext API port.
		const target = resolveTarget(
			{ targetInput: "https://10.0.0.5", port: 8728 },
			EMPTY_ENV,
			"native-api",
		);
		expect(target.tls).toBe(false);
		expect(target.port).toBe(8728);
		expect(target.baseUrl).toBe("api://10.0.0.5:8728");
	});

	test("an explicit TLS port (8729) implies api-ssl even over http", () => {
		const target = resolveTarget(
			{ targetInput: "http://10.0.0.5", port: 8729 },
			EMPTY_ENV,
			"native-api",
		);
		expect(target.tls).toBe(true);
		expect(target.baseUrl).toBe("api-ssl://10.0.0.5:8729");
	});

	test("a custom port follows the scheme for TLS selection", () => {
		const tlsTarget = resolveTarget(
			{ targetInput: "https://10.0.0.5", port: 1234 },
			EMPTY_ENV,
			"native-api",
		);
		expect(tlsTarget.tls).toBe(true);
		expect(tlsTarget.baseUrl).toBe("api-ssl://10.0.0.5:1234");

		const plainTarget = resolveTarget(
			{ targetInput: "http://10.0.0.5", port: 1234 },
			EMPTY_ENV,
			"native-api",
		);
		expect(plainTarget.tls).toBe(false);
		expect(plainTarget.baseUrl).toBe("api://10.0.0.5:1234");
	});
});

describe("resolver CDB end-to-end through retrieve", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = join(
			process.cwd(),
			"test",
			`.tmp-resolver-${crypto.randomUUID()}`,
		);
		await mkdir(tmpDir, { recursive: true });
	});

	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	async function writeCdb(target: string, comment: string): Promise<string> {
		const cdbPath = join(tmpDir, `${crypto.randomUUID()}.cdb`);
		const bytes = encodeOpenWinBoxCdb([
			buildWinBoxCdbEntryRecord({
				recordType: winBoxCdbRecordType.ipAdmin,
				target,
				user: "admin",
				password: "secret",
				group: "lab",
				comment,
				savedPassword: true,
			}),
		]);
		await writeFile(cdbPath, bytes);
		return cdbPath;
	}

	test("resolveCdb exposes coerced overrides and CDB credentials", async () => {
		const cdbPath = await writeCdb("198.51.100.7", "port=8080 validate=false");
		const resolution = await resolveCdb(
			{ targetInput: "198.51.100.7", cdbFile: cdbPath },
			EMPTY_ENV,
		);

		expect(resolution).toBeDefined();
		expect(resolution?.username).toBe("admin");
		expect(resolution?.password).toBe("secret");
		expect(resolution?.overrides.port?.value).toBe(8080);
		expect(resolution?.overrides.validate?.value).toBe(false);
		expect(resolution?.overrides.port?.source.kind).toBe("comment-kv");
	});

	test("retrieve reflects comment-kv overrides in meta provenance", async () => {
		const cdbPath = await writeCdb("198.51.100.8", "port=8080");
		const originalFetch = globalThis.fetch;
		const seen: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			seen.push(url);
			return new Response(JSON.stringify({ version: "7.22.1" }));
		}) as typeof fetch;

		try {
			const envelope = await retrieve(
				{
					targetInput: "198.51.100.8",
					path: "/system/resource",
					via: "rest-api",
					validate: false,
					cdbFile: cdbPath,
				},
				EMPTY_ENV,
			);

			expect(envelope.ok).toBe(true);
			expect(envelope.meta.target.host).toBe("198.51.100.8");
			expect(envelope.meta.target.port).toBe(8080);
			expect(envelope.meta.target.source?.kind).toBe("cdb");
			expect(envelope.meta.target.sources?.["host"]?.kind).toBe("cdb");
			expect(envelope.meta.target.sources?.["port"]).toEqual({
				kind: "comment-kv",
				key: "record:0:port",
			});
			expect(envelope.meta.settings.port?.kind).toBe("comment-kv");
			expect(seen.at(-1)).toBe("http://198.51.100.8:8080/rest/system/resource");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
