// CDB per-service port keys (#618): `www-port`, `www-ssl-port`, `api-port`,
// `api-ssl-port`, `ssh-port`. Each applies only to the transport that connects
// to that service, beats legacy `port=` within the CDB tier, and leaves the
// rest of target resolution (CLI/env precedence, native 8728/8729, MAC-Telnet
// delivery) as it was.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";
import { loadCdb, setDevice } from "../../src/devices.ts";
import type { RouterOsProtocol } from "../../src/protocols/index.ts";
import {
	type CdbResolution,
	coerceCommentKv,
	type ResolverWarning,
	resolveCdb,
	resolveTarget,
} from "../../src/resolver/index.ts";

const NO_ENV: Record<string, string | undefined> = {};
const RECORD = 3;

function cdbWith(comment: string, target = "10.0.0.5"): CdbResolution {
	const warnings: ResolverWarning[] = [];
	return {
		target,
		identity: "edge",
		username: "admin",
		password: "",
		recordIndex: RECORD,
		overrides: coerceCommentKv(comment, RECORD, warnings),
		warnings,
	};
}

function resolve(
	comment: string,
	via: RouterOsProtocol,
	opts: {
		target?: string;
		host?: string;
		port?: number;
		env?: Record<string, string | undefined>;
		config?: Record<string, string | undefined>;
	} = {},
) {
	return resolveTarget(
		{ targetInput: "edge", host: opts.host, port: opts.port },
		opts.env ?? NO_ENV,
		via,
		cdbWith(comment, opts.target),
		opts.config,
	);
}

const ALL =
	"www-port=7080 www-ssl-port=7443 api-port=18728 api-ssl-port=18729 ssh-port=2222 port=9000";

describe("CDB service port keys: transport selection", () => {
	test("each transport reads only its own service key", () => {
		const rest = resolve(ALL, "rest-api");
		expect([rest.port, rest.scheme, rest.tls]).toEqual([7443, "https", true]);
		expect(rest.baseUrl).toBe("https://10.0.0.5:7443/rest");

		const native = resolve(ALL, "native-api");
		expect([native.port, native.tls]).toEqual([18729, true]);
		expect(native.baseUrl).toBe("api-ssl://10.0.0.5:18729");

		const ssh = resolve(ALL, "ssh");
		expect([ssh.port, ssh.baseUrl]).toEqual([2222, "ssh://10.0.0.5:2222"]);
	});

	test("keys for another transport have no effect (legacy port= still applies)", () => {
		const rest = resolve("api-port=18728 ssh-port=2222 port=9000", "rest-api");
		expect([rest.port, rest.scheme]).toEqual([9000, "http"]);
		expect(rest.portSource).toEqual({
			kind: "comment-kv",
			key: `record:${RECORD}:port`,
		});
		expect(resolve("www-port=7080", "native-api").port).toBe(8728);
		expect(resolve("www-port=7080", "ssh").port).toBe(22);
	});

	test("with no service key, behavior is unchanged", () => {
		expect(resolve("", "rest-api").port).toBe(80);
		expect(resolve("port=9000", "rest-api").port).toBe(9000);
		expect(resolve("port=8729", "native-api").tls).toBe(true);
		expect(resolve("port=2200", "ssh").port).toBe(2200);
	});

	test("provenance names the winning key and only the winning key", () => {
		for (const [via, key] of [
			["rest-api", "www-ssl-port"],
			["native-api", "api-ssl-port"],
			["ssh", "ssh-port"],
		] as const) {
			const target = resolve(ALL, via);
			const expected = {
				kind: "comment-kv" as const,
				key: `record:${RECORD}:${key}`,
			};
			expect(target.portSource).toEqual(expected);
			expect(target.sources["port"]).toEqual(expected);
		}
	});
});

describe("CDB service port keys: plain vs TLS", () => {
	test("only the plain key stored → plain on that port", () => {
		const rest = resolve("www-port=7080", "rest-api");
		expect([rest.port, rest.scheme, rest.tls]).toEqual([7080, "http", false]);
		const native = resolve("api-port=18728", "native-api");
		expect([native.port, native.tls]).toEqual([18728, false]);
	});

	test("only the secure key stored → TLS on that port", () => {
		const rest = resolve("www-ssl-port=7443", "rest-api");
		expect([rest.port, rest.scheme]).toEqual([7443, "https"]);
		const native = resolve("api-ssl-port=18729", "native-api");
		expect([native.port, native.tls]).toEqual([18729, true]);
	});

	test("both stored, no scheme → secure preferred", () => {
		const rest = resolve("www-port=7080 www-ssl-port=7443", "rest-api");
		expect([rest.port, rest.scheme]).toEqual([7443, "https"]);
	});

	test("a saved key decides TLS by name, not by the well-known number", () => {
		const plain = resolve("api-port=8729", "native-api");
		expect([plain.port, plain.tls]).toEqual([8729, false]);
		const secure = resolve("api-ssl-port=8728", "native-api");
		expect([secure.port, secure.tls]).toEqual([8728, true]);
	});

	test("explicit http:// picks the plain key and is never upgraded", () => {
		const both = resolve("www-port=7080 www-ssl-port=7443", "rest-api", {
			target: "http://10.0.0.5",
		});
		expect([both.port, both.scheme]).toEqual([7080, "http"]);

		// Only the secure variant stored: falls back to today's behavior (legacy
		// port=, else the scheme default), still plain.
		const onlySecure = resolve("www-ssl-port=7443 port=9000", "rest-api", {
			target: "http://10.0.0.5",
		});
		expect([onlySecure.port, onlySecure.scheme]).toEqual([9000, "http"]);
		const noLegacy = resolve("www-ssl-port=7443", "rest-api", {
			target: "http://10.0.0.5",
		});
		expect([noLegacy.port, noLegacy.scheme]).toEqual([80, "http"]);
	});

	test("explicit https:// picks the secure key; plain-only falls back", () => {
		const both = resolve("www-port=7080 www-ssl-port=7443", "rest-api", {
			target: "https://10.0.0.5",
		});
		expect([both.port, both.scheme]).toEqual([7443, "https"]);
		const onlyPlain = resolve("www-port=7080", "rest-api", {
			target: "https://10.0.0.5",
		});
		expect([onlyPlain.port, onlyPlain.scheme]).toEqual([443, "https"]);

		const native = resolve("api-port=18728 api-ssl-port=18729", "native-api", {
			target: "http://10.0.0.5",
		});
		expect([native.port, native.tls]).toEqual([18728, false]);
	});

	test("an explicit scheme counts from --host and CENTRS_HOST too", () => {
		const comment = "www-port=7080 www-ssl-port=7443";
		const viaHost = resolve(comment, "rest-api", { host: "http://10.0.0.6" });
		expect([viaHost.port, viaHost.scheme]).toEqual([7080, "http"]);
		const viaEnv = resolve(comment, "rest-api", {
			env: { CENTRS_HOST: "http://10.0.0.6" },
		});
		expect([viaEnv.port, viaEnv.scheme]).toEqual([7080, "http"]);
	});

	test("a bare host is not an explicit http choice", () => {
		const target = resolve("www-port=7080 www-ssl-port=7443", "rest-api", {
			host: "10.0.0.6",
		});
		expect([target.port, target.scheme]).toEqual([7443, "https"]);
	});
});

describe("CDB service port keys: precedence is unchanged", () => {
	test("--port and CENTRS_PORT beat service keys and keep the saved TLS", () => {
		const cli = resolve("www-ssl-port=7443", "rest-api", { port: 9443 });
		expect([cli.port, cli.scheme]).toEqual([9443, "https"]);
		expect(cli.portSource.kind).toBe("explicit");

		const env = resolve("www-ssl-port=7443", "rest-api", {
			env: { CENTRS_PORT: "9443" },
		});
		expect([env.port, env.scheme]).toEqual([9443, "https"]);
		expect(env.portSource).toEqual({ kind: "env", key: "CENTRS_PORT" });

		const native = resolve("api-ssl-port=18729", "native-api", { port: 9999 });
		expect([native.port, native.tls]).toEqual([9999, true]);
	});

	test("a higher-tier 8728/8729 keeps native's existing well-known rule", () => {
		const plain = resolve("api-ssl-port=18729", "native-api", { port: 8728 });
		expect([plain.port, plain.tls]).toEqual([8728, false]);
		const tls = resolve("api-port=18728", "native-api", { port: 8729 });
		expect([tls.port, tls.tls]).toEqual([8729, true]);
	});

	test("service keys outrank config CENTRS_PORT", () => {
		const target = resolve("www-port=7080", "rest-api", {
			config: { CENTRS_PORT: "9000" },
		});
		expect(target.port).toBe(7080);
		const fallback = resolve("", "rest-api", {
			config: { CENTRS_PORT: "9000" },
		});
		expect(fallback.port).toBe(9000);
	});
});

describe("CDB service port keys: invalid values and MAC-Telnet", () => {
	test("an invalid key counts as absent and the warning names it", () => {
		const cdb = cdbWith("www-ssl-port=bogus www-port=7080 port=9000");
		expect(cdb.warnings).toEqual([
			expect.objectContaining({
				code: "cdb/invalid-option",
				context: { key: "www-ssl-port", value: "bogus", recordIndex: RECORD },
			}),
		]);
		const target = resolveTarget(
			{ targetInput: "edge" },
			NO_ENV,
			"rest-api",
			cdb,
		);
		expect([target.port, target.scheme]).toEqual([7080, "http"]);

		const outOfRange = cdbWith("ssh-port=70000");
		expect(outOfRange.overrides.servicePorts).toBeUndefined();
		expect(outOfRange.warnings[0]?.context?.["key"]).toBe("ssh-port");
	});

	test("MAC-Telnet delivery ignores every service key", () => {
		const target = resolveTarget(
			{ targetInput: "aa:bb:cc:dd:ee:ff" },
			NO_ENV,
			"mac-telnet",
			cdbWith(ALL.replace(" port=9000", ""), "aa:bb:cc:dd:ee:ff"),
		);
		expect(target.port).toBe(20561);
		expect(target.host).toBe("255.255.255.255");

		const legacy = resolveTarget(
			{ targetInput: "aa:bb:cc:dd:ee:ff" },
			NO_ENV,
			"mac-telnet",
			cdbWith(`${ALL}`, "aa:bb:cc:dd:ee:ff"),
		);
		expect(legacy.port).toBe(9000);
	});
});

describe("CDB service port keys: devices set round trip", () => {
	test("set --strict, resolve, delete, resolve", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-service-ports-"));
		const path = join(dir, "winbox.cdb");
		try {
			await writeFile(
				path,
				encodeOpenWinBoxCdb([
					buildWinBoxCdbEntryRecord({
						recordType: winBoxCdbRecordType.ipAdmin,
						target: "192.0.2.5",
						user: "admin",
						comment: "port=9000",
					}),
				]),
			);
			const restTarget = async () => {
				const cdb = await resolveCdb(
					{ targetInput: "192.0.2.5", cdbFile: path },
					NO_ENV,
				);
				return resolveTarget(
					{ targetInput: "192.0.2.5" },
					NO_ENV,
					"rest-api",
					cdb,
				);
			};

			await setDevice({
				cdb: await loadCdb({ cdbFile: path, env: {} }),
				target: "192.0.2.5",
				updates: [{ key: "www-port", value: "7080" }],
				strict: true,
			});
			const set = await restTarget();
			expect(set.port).toBe(7080);
			expect(set.portSource.key).toEndWith(":www-port");

			await setDevice({
				cdb: await loadCdb({ cdbFile: path, env: {} }),
				target: "192.0.2.5",
				updates: [{ key: "www-port", value: null }],
				strict: true,
			});
			const removed = await restTarget();
			expect(removed.port).toBe(9000);
			expect(removed.portSource.key).toEndWith(":port");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
