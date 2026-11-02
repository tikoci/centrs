/**
 * #591 on real RouterOS: one CDB record with `via=ssh` drives both execute
 * (ssh) and transfer (sftp, the mapped method) with no `--via`, and an
 * explicit `--via sftp` lands on the same record. Exact-byte readback.
 *
 * The record carries `port=` (the CHR's forwarded SSH port), `ssh-key=` and
 * `insecure=true` as comment-kv overrides; RouterOS refuses password login
 * once a user has a key, and the sftp client runs BatchMode=yes.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
		settings?: { via?: { kind?: string; key?: string } };
		target?: { recordIndex?: number };
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
		["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "centrs-591", "-f", path],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(await proc.exited).toBe(0);
}

describeFast("transfer honors a CDB record's via=ssh as sftp (#591)", () => {
	test("execute and transfer share one via=ssh record", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		const dir = await mkdtemp(join(tmpdir(), "centrs-591-"));
		try {
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			const keyPath = join(dir, "id_centrs");
			await keygen(keyPath);
			const seed = await run([
				"transfer",
				chr.restUrl,
				"--username",
				auth.username,
				"--password",
				auth.password,
				"upload",
				`${keyPath}.pub`,
				"centrs_591.pub",
			]);
			expect(seed.ok).toBe(true);
			await chr.exec(
				`/user ssh-keys import public-key-file=centrs_591.pub user=${auth.username}`,
			);

			const cdbFile = join(dir, "via-ssh.cdb");
			await writeFile(
				cdbFile,
				encodeOpenWinBoxCdb([
					buildWinBoxCdbEntryRecord({
						recordType: winBoxCdbRecordType.ipAdmin,
						target: "127.0.0.1",
						user: auth.username,
						password: "",
						group: "chr",
						comment: `via=ssh port=${chr.sshPort} ssh-key=${keyPath} insecure=true`,
						profile: "<own>",
						savedPassword: false,
					}),
				]),
			);
			const record = ["127.0.0.1", "--cdb-file", cdbFile];

			const executed = await run([
				"execute",
				...record,
				"/system/identity/print",
			]);
			expect({ ok: executed.ok, via: executed.meta?.via }).toEqual({
				ok: true,
				via: "ssh",
			});

			const payload = "centrs #591 via=ssh -> sftp\n";
			const source = join(dir, "payload.txt");
			await writeFile(source, payload);

			const uploaded = await run([
				"transfer",
				...record,
				"upload",
				source,
				"centrs-591.txt",
			]);
			expect(uploaded.error).toBeUndefined();
			expect(uploaded.meta?.via).toBe("ssh");
			expect(uploaded.meta?.settings?.via).toMatchObject({
				kind: "comment-kv",
				key: "record:0:via",
			});

			for (const via of [[], ["--via", "sftp"]]) {
				const out = join(dir, `down-${via.length}.txt`);
				const downloaded = await run([
					"transfer",
					...record,
					...via,
					"download",
					"centrs-591.txt",
					out,
				]);
				expect({ via, error: downloaded.error }).toEqual({
					via,
					error: undefined,
				});
				expect(downloaded.meta?.via).toBe("ssh");
				expect(await readFile(out, "utf8")).toBe(payload);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
			await chr.destroy();
		}
	}, 300_000);
});
