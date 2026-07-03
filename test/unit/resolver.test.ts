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
	resolveAuth,
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

	test("coerces ssh-key (path) and insecure (boolean) overrides", () => {
		const warnings: ResolverWarning[] = [];
		const overrides = coerceCommentKv(
			"ssh-key=/keys/edge.pem insecure=yes",
			4,
			warnings,
		);
		expect(warnings).toEqual([]);
		expect(overrides.sshKey?.value).toBe("/keys/edge.pem");
		expect(overrides.sshKey?.source).toEqual({
			kind: "comment-kv",
			key: "record:4:ssh-key",
		});
		expect(overrides.insecure?.value).toBe(true);
		expect(overrides.insecure?.source.kind).toBe("comment-kv");
	});

	test("emits cdb/invalid-option for a malformed insecure value", () => {
		const warnings: ResolverWarning[] = [];
		const overrides = coerceCommentKv("insecure=perhaps", 2, warnings);
		expect(overrides.insecure).toBeUndefined();
		expect(warnings[0]?.code).toBe("cdb/invalid-option");
		expect(warnings[0]?.context).toMatchObject({ key: "insecure" });
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

describe("resolver ssh-key resolution", () => {
	const cdb = {
		username: "",
		password: "",
		recordIndex: 0,
		overrides: {
			sshKey: {
				value: "/cdb/key",
				source: { kind: "comment-kv" as const, key: "record:0:ssh-key" },
			},
		},
	} as unknown as Parameters<typeof resolveAuth>[2];

	test("explicit > env > comment-kv, with provenance", () => {
		const cli = resolveAuth(
			{ sshKey: "/cli/key" },
			{ CENTRS_SSH_KEY: "/env/key" },
			cdb,
		);
		expect(cli.sshKey).toBe("/cli/key");
		expect(cli.sshKeySource?.kind).toBe("explicit");

		const env = resolveAuth({}, { CENTRS_SSH_KEY: "/env/key" }, cdb);
		expect(env.sshKey).toBe("/env/key");
		expect(env.sshKeySource).toEqual({ kind: "env", key: "CENTRS_SSH_KEY" });

		const comment = resolveAuth({}, {}, cdb);
		expect(comment.sshKey).toBe("/cdb/key");
		expect(comment.sshKeySource?.kind).toBe("comment-kv");
	});

	test("unset ssh-key leaves the field undefined", () => {
		const auth = resolveAuth({}, {}, undefined);
		expect(auth.sshKey).toBeUndefined();
		expect(auth.sshKeySource).toBeUndefined();
	});
});

describe("resolver settings precedence", () => {
	// Constitution order, lowest → highest: default < config < comment-kv < env
	// < cli. The `config` tier is the loaded `centrs.env` map
	// (`src/resolver/config-file.ts`); every resolver helper takes it as the
	// last argument, checked between comment-kv and the built-in default.
	const commentKv = {
		value: "comment-host",
		source: { kind: "comment-kv" as const, key: "record:0:host" },
	};

	test("cli beats env beats comment-kv beats config beats default", () => {
		const cli = resolveStringSetting(
			"cli-host",
			{ CENTRS_HOST: "env-host" },
			"CENTRS_HOST",
			"default-host",
			"host",
			undefined,
			commentKv,
			{ CENTRS_HOST: "config-host" },
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
			{ CENTRS_HOST: "config-host" },
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
			{ CENTRS_HOST: "config-host" },
		);
		expect(comment?.value).toBe("comment-host");
		expect(comment?.source.kind).toBe("comment-kv");

		const config = resolveStringSetting(
			undefined,
			EMPTY_ENV,
			"CENTRS_HOST",
			"default-host",
			"host",
			undefined,
			undefined,
			{ CENTRS_HOST: "config-host" },
		);
		expect(config?.value).toBe("config-host");
		expect(config?.source).toEqual({ kind: "config", key: "CENTRS_HOST" });

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

	test("boolean precedence places comment-kv above config above the built-in default", () => {
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
			{ CENTRS_VALIDATE: "0" },
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
			{ CENTRS_VALIDATE: "0" },
		);
		expect(fromEnv.value).toBe(true);
		expect(fromEnv.source.kind).toBe("env");

		const fromConfig = resolveBooleanSetting(
			undefined,
			EMPTY_ENV,
			"CENTRS_VALIDATE",
			true,
			"validate",
			undefined,
			{ CENTRS_VALIDATE: "0" },
		);
		expect(fromConfig.value).toBe(false);
		expect(fromConfig.source).toEqual({
			kind: "config",
			key: "CENTRS_VALIDATE",
		});
	});

	test("optional integer precedence honors the comment-kv and config layers", () => {
		const fromComment = resolveOptionalIntegerSetting(
			undefined,
			EMPTY_ENV,
			"CENTRS_PORT",
			"port",
			{ value: 8080, source: { kind: "comment-kv", key: "record:0:port" } },
			{ CENTRS_PORT: "9090" },
		);
		expect(fromComment?.value).toBe(8080);
		expect(fromComment?.source.kind).toBe("comment-kv");

		const fromConfig = resolveOptionalIntegerSetting(
			undefined,
			EMPTY_ENV,
			"CENTRS_PORT",
			"port",
			undefined,
			{ CENTRS_PORT: "9090" },
		);
		expect(fromConfig?.value).toBe(9090);
		expect(fromConfig?.source).toEqual({ kind: "config", key: "CENTRS_PORT" });

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
			identity: "edge-router",
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
		expect(target.identity).toBe("edge-router");
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

describe("resolver mac-telnet target", () => {
	test("uses the CDB record's mac= when the target is an IP/identity", () => {
		const cdb: CdbResolution = {
			target: "192.0.2.10",
			identity: "edge1",
			mac: "aa:bb:cc:dd:ee:ff",
			username: "admin",
			password: "",
			recordIndex: 3,
			overrides: {},
			warnings: [],
		};
		const target = resolveTarget(
			{ targetInput: "edge1" },
			EMPTY_ENV,
			"mac-telnet",
			cdb,
		);
		expect(target.mac).toBe("aa:bb:cc:dd:ee:ff");
		expect(target.baseUrl).toBe("mac-telnet://aa:bb:cc:dd:ee:ff");
		// host/port are the delivery endpoint (default L2 broadcast / 20561).
		expect(target.host).toBe("255.255.255.255");
		expect(target.port).toBe(20561);
	});

	test("an explicit MAC positional wins over the CDB record's mac=", () => {
		const cdb: CdbResolution = {
			target: "192.0.2.10",
			identity: "edge1",
			mac: "aa:bb:cc:dd:ee:ff",
			username: "admin",
			password: "",
			recordIndex: 3,
			overrides: {},
			warnings: [],
		};
		const target = resolveTarget(
			{ targetInput: "11:22:33:44:55:66" },
			EMPTY_ENV,
			"mac-telnet",
			cdb,
		);
		expect(target.mac).toBe("11:22:33:44:55:66");
	});

	test("a bare MAC positional resolves without a CDB record", () => {
		const target = resolveTarget(
			{ targetInput: "AA-BB-CC-DD-EE-FF" },
			EMPTY_ENV,
			"mac-telnet",
		);
		expect(target.mac).toBe("aa:bb:cc:dd:ee:ff");
	});

	test("--host/--port override the delivery endpoint, not the MAC", () => {
		const target = resolveTarget(
			{ targetInput: "aa:bb:cc:dd:ee:ff", host: "127.0.0.1", port: 40000 },
			EMPTY_ENV,
			"mac-telnet",
		);
		expect(target.mac).toBe("aa:bb:cc:dd:ee:ff");
		expect(target.host).toBe("127.0.0.1");
		expect(target.port).toBe(40000);
	});

	test("no resolvable MAC errors target/mac-required", () => {
		let code: string | undefined;
		try {
			resolveTarget({ targetInput: "edge1" }, EMPTY_ENV, "mac-telnet");
		} catch (error) {
			code = (error as { code?: string }).code;
		}
		expect(code).toBe("target/mac-required");
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

describe("resolver __default__ fallback", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = join(process.cwd(), "test", `.tmp-default-${crypto.randomUUID()}`);
		await mkdir(tmpDir, { recursive: true });
	});

	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	interface RecordSpec {
		target: string;
		user?: string;
		password?: string;
	}

	async function writeCdbRecords(
		specs: readonly RecordSpec[],
	): Promise<string> {
		const cdbPath = join(tmpDir, `${crypto.randomUUID()}.cdb`);
		const bytes = encodeOpenWinBoxCdb(
			specs.map((spec) =>
				buildWinBoxCdbEntryRecord({
					recordType: winBoxCdbRecordType.ipAdmin,
					target: spec.target,
					user: spec.user ?? "",
					password: spec.password ?? "",
				}),
			),
		);
		await writeFile(cdbPath, bytes);
		return cdbPath;
	}

	test("fills creds for a device record that left them unset", async () => {
		const cdbPath = await writeCdbRecords([
			{ target: "__default__", user: "fallback", password: "fallback-pw" },
			{ target: "10.9.9.1", user: "", password: "" },
		]);
		const resolution = await resolveCdb(
			{ targetInput: "10.9.9.1", cdbFile: cdbPath },
			EMPTY_ENV,
		);
		expect(resolution?.defaults?.username).toBe("fallback");

		const auth = resolveAuth({}, EMPTY_ENV, resolution);
		expect(auth.username).toBe("fallback");
		expect(auth.password).toBe("fallback-pw");
		// Provenance points at the __default__ record (index 0), not the device.
		expect(auth.usernameSource).toEqual({ kind: "cdb", key: "record:0:user" });
	});

	test("the device record wins per-field over __default__", async () => {
		const cdbPath = await writeCdbRecords([
			{ target: "__default__", user: "fallback", password: "fallback-pw" },
			{ target: "10.9.9.2", user: "owner", password: "" },
		]);
		const resolution = await resolveCdb(
			{ targetInput: "10.9.9.2", cdbFile: cdbPath },
			EMPTY_ENV,
		);
		const auth = resolveAuth({}, EMPTY_ENV, resolution);
		// user comes from the device; the empty password falls back to __default__.
		expect(auth.username).toBe("owner");
		expect(auth.password).toBe("fallback-pw");
		expect(auth.usernameSource).toEqual({ kind: "cdb", key: "record:1:user" });
		expect(auth.passwordSource).toEqual({
			kind: "cdb",
			key: "record:0:password",
		});
	});

	test("per-call args win over __default__", async () => {
		const cdbPath = await writeCdbRecords([
			{ target: "__default__", user: "fallback", password: "fallback-pw" },
			{ target: "10.9.9.3", user: "", password: "" },
		]);
		const resolution = await resolveCdb(
			{ targetInput: "10.9.9.3", cdbFile: cdbPath },
			EMPTY_ENV,
		);
		const auth = resolveAuth(
			{ username: "cli-user", password: "cli-pw" },
			EMPTY_ENV,
			resolution,
		);
		expect(auth.username).toBe("cli-user");
		expect(auth.password).toBe("cli-pw");
		expect(auth.usernameSource?.kind).toBe("explicit");
	});

	test("__default__ fills creds for a target with no record (CLI/API)", async () => {
		const cdbPath = await writeCdbRecords([
			{ target: "__default__", user: "fallback", password: "fallback-pw" },
			{ target: "10.9.9.4", user: "owner", password: "owner-pw" },
		]);
		const resolution = await resolveCdb(
			{ targetInput: "203.0.113.200", cdbFile: cdbPath },
			EMPTY_ENV,
		);
		// A synthetic resolution carries the ad-hoc target plus __default__ creds.
		expect(resolution?.target).toBe("203.0.113.200");
		const auth = resolveAuth({}, EMPTY_ENV, resolution);
		expect(auth.username).toBe("fallback");
		expect(auth.password).toBe("fallback-pw");
	});

	test("no __default__ keeps the explicit-CDB not-found-target contract", async () => {
		const cdbPath = await writeCdbRecords([
			{ target: "10.9.9.5", user: "owner", password: "owner-pw" },
		]);
		// With an explicit --cdb-file and no __default__, an unknown target stays a
		// hard error (typo protection) rather than synthesizing a resolution.
		let caught: unknown;
		try {
			await resolveCdb(
				{ targetInput: "203.0.113.201", cdbFile: cdbPath },
				EMPTY_ENV,
			);
		} catch (error) {
			caught = error;
		}
		expect((caught as { code?: string })?.code).toBe("cdb/not-found-target");
	});
});
