/**
 * #583 on real RouterOS: `--match` picks one of two CDB records saved for the
 * same address. One record carries a deliberately wrong password, so the
 * selected record is visible on the wire: `--match user=reader` reads, the
 * other record fails `auth/failed`, and no `--match` is `identity/ambiguous`.
 */
import { describe, expect, test } from "bun:test";
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
	error?: { code?: string };
	data?: unknown;
	meta?: { target?: { recordIndex?: number } };
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

describeFast("--match selects a CDB record on CHR (#583)", () => {
	test("retrieve/execute/api honor --match user= against two records", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		const dir = await mkdtemp(join(tmpdir(), "centrs-match-chr-"));
		try {
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			const readerPassword = "reader-583-pass";
			await chr.exec(
				`/user/add name=reader group=read password=${readerPassword}`,
			);
			const record = (user: string, password: string) =>
				buildWinBoxCdbEntryRecord({
					recordType: winBoxCdbRecordType.ipAdmin,
					target: chr.restUrl,
					user,
					password,
					group: "chr",
					comment: "",
					profile: "<own>",
					savedPassword: true,
				});
			const cdbFile = join(dir, "two-users.cdb");
			await writeFile(
				cdbFile,
				encodeOpenWinBoxCdb([
					record(auth.username, `${auth.password}-wrong`),
					record("reader", readerPassword),
				]),
			);
			const base = ["--cdb-file", cdbFile, "--via", "rest-api"];

			const ambiguous = await run([
				"retrieve",
				chr.restUrl,
				"/system/identity",
				...base,
			]);
			expect(ambiguous.error?.code).toBe("identity/ambiguous");

			for (const args of [
				["retrieve", chr.restUrl, "/system/identity"],
				["execute", chr.restUrl, "/system/identity/print"],
				["api", chr.restUrl, "system/identity"],
			]) {
				const reader = await run([...args, ...base, "--match", "user=reader"]);
				expect({ args, ok: reader.ok, code: reader.error?.code }).toEqual({
					args,
					ok: true,
					code: undefined,
				});
				expect(reader.meta?.target?.recordIndex).toBe(1);

				const wrong = await run([
					...args,
					...base,
					"--match",
					`user=${auth.username}`,
				]);
				expect({ args, code: wrong.error?.code }).toEqual({
					args,
					code: "transport/auth-failed",
				});
			}

			const none = await run([
				"retrieve",
				chr.restUrl,
				"/system/identity",
				...base,
				"--match",
				"user=nobody",
			]);
			expect(none.error?.code).toBe("identity/no-match");
		} finally {
			await rm(dir, { recursive: true, force: true });
			await chr.destroy();
		}
	}, 300_000);
});
