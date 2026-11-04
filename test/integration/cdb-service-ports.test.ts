/**
 * #618 on real RouterOS: CDB per-service port keys. The guest's `api` and `ssh`
 * services are moved off their defaults (18728, 2222) and reached through new
 * host forwards; `www` stays on 80 behind its existing forward. One CDB record
 * stores `www-port=`/`api-port=`/`ssh-port=` for those host ports plus a
 * legacy `port=1` that is wrong for every transport, so each command connecting
 * at all proves it read its own service key. Removing a key with `devices set`
 * falls back to the legacy `port=` (and fails), which proves the fallback too.
 * `www-ssl`/`api-ssl` need a device certificate the harness does not provision;
 * their variant selection is covered by `test/unit/cdb-service-ports.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.ts";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";
import {
	isChrIntegrationEnabled,
	readEnv,
	splitQuickChrAuth,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

interface Envelope {
	ok: boolean;
	error?: { code?: string; summary?: string };
	data?: unknown;
	meta?: {
		via?: string;
		settings?: { port?: { kind?: string; key?: string } };
		target?: { port?: number };
	};
}

async function run(args: string[]): Promise<Envelope> {
	const out: string[] = [];
	const originalLog = console.log;
	const originalError = console.error;
	console.log = (...parts: unknown[]) => {
		out.push(parts.map(String).join(" "));
	};
	console.error = console.log;
	try {
		await runCli([...args, "--json"]);
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}
	return JSON.parse(out.join("\n")) as Envelope;
}

async function keygen(path: string): Promise<void> {
	const proc = Bun.spawn(
		["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "centrs-618", "-f", path],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if ((await proc.exited) !== 0) {
		throw new Error(
			`ssh-keygen failed: ${await new Response(proc.stderr).text()}`,
		);
	}
}

describeFast("CDB per-service port keys on CHR (#618)", () => {
	let started: Awaited<ReturnType<typeof startIntegrationChr>> | undefined;
	let dir = "";
	let cdbFile = "";
	let sshKey = "";
	const ports = { www: 0, api: 0, ssh: 0 };
	const cli = (...args: string[]) => run([...args, "--cdb-file", cdbFile]);

	beforeAll(async () => {
		started = await startIntegrationChr({
			extraPorts: [
				{ name: "api618", host: 0, guest: 18728, proto: "tcp" },
				{ name: "ssh618", host: 0, guest: 2222, proto: "tcp" },
			],
		});
		const chr = started.chr;
		expect(await chr.waitForBoot(180_000)).toBe(true);
		const auth = splitQuickChrAuth(
			readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
		);
		dir = await mkdtemp(join(tmpdir(), "centrs-618-"));
		sshKey = join(dir, "id");
		await keygen(sshKey);

		// SSH key login (the ssh client runs BatchMode), installed over REST.
		const upload = await run([
			"transfer",
			chr.restUrl,
			"--username",
			auth.username,
			"--password",
			auth.password,
			"upload",
			`${sshKey}.pub`,
			"centrs_618.pub",
		]);
		expect(upload.ok, JSON.stringify(upload.error)).toBe(true);
		await chr.exec(
			`/user ssh-keys import public-key-file=centrs_618.pub user=${auth.username}`,
		);
		await chr.exec("/ip/service/set api port=18728");
		await chr.exec("/ip/service/set ssh port=2222");

		ports.www = Number(new URL(chr.restUrl).port);
		ports.api = chr.ports["api618"] ?? 0;
		ports.ssh = chr.ports["ssh618"] ?? 0;
		cdbFile = join(dir, "service-ports.cdb");
		await writeFile(
			cdbFile,
			encodeOpenWinBoxCdb([
				buildWinBoxCdbEntryRecord({
					recordType: winBoxCdbRecordType.ipAdmin,
					target: "127.0.0.1",
					user: auth.username,
					password: auth.password,
					comment: `chr-618 www-port=${ports.www} api-port=${ports.api} ssh-port=${ports.ssh} port=1`,
					savedPassword: true,
				}),
			]),
		);
	}, 300_000);

	afterAll(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
		await started?.chr.destroy();
	});

	const expectPort = (env: Envelope, port: number, key: string) => {
		expect(env.ok, JSON.stringify(env.error)).toBe(true);
		expect(env.meta?.target?.port).toBe(port);
		expect(env.meta?.settings?.port?.key).toBe(`record:0:${key}`);
	};

	test("REST and native API each read their own key", async () => {
		for (const command of [
			["retrieve", "127.0.0.1", "/system/identity"],
			["execute", "127.0.0.1", "/system/identity/print"],
			["api", "127.0.0.1", "system/identity"],
		]) {
			expectPort(
				await cli(...command, "--via", "rest-api"),
				ports.www,
				"www-port",
			);
			expectPort(
				await cli(...command, "--via", "native-api"),
				ports.api,
				"api-port",
			);
		}
	});

	test("SSH execute reads ssh-port", async () => {
		expectPort(
			await cli(
				"execute",
				"127.0.0.1",
				"/system/identity/print",
				"--via",
				"ssh",
				"--ssh-key",
				sshKey,
				"--insecure",
			),
			ports.ssh,
			"ssh-port",
		);
	});

	test("transfer over REST, native and SFTP reads the matching key", async () => {
		const local = join(dir, "up.txt");
		await writeFile(local, "centrs #618\n");
		for (const [via, port, key] of [
			["rest", ports.www, "www-port"],
			["native", ports.api, "api-port"],
			["sftp", ports.ssh, "ssh-port"],
		] as const) {
			expectPort(
				await cli(
					"transfer",
					"127.0.0.1",
					"--via",
					via,
					"--ssh-key",
					sshKey,
					"--insecure",
					"upload",
					local,
					`centrs-618-${via}.txt`,
				),
				port,
				key,
			);
		}
	});

	test("removing a key falls back to legacy port=", async () => {
		const removed = await cli("devices", "set", "127.0.0.1", "api-port=");
		expect(removed.ok, JSON.stringify(removed.error)).toBe(true);
		const fallback = await cli(
			"retrieve",
			"127.0.0.1",
			"/system/identity",
			"--via",
			"native-api",
			"--timeout",
			"5s",
		);
		expect(fallback.ok).toBe(false);
		expect(fallback.meta?.settings?.port?.key).toBe("record:0:port");
		// REST still uses its own key after the api-port removal.
		expectPort(
			await cli(
				"retrieve",
				"127.0.0.1",
				"/system/identity",
				"--via",
				"rest-api",
			),
			ports.www,
			"www-port",
		);
	});
});
