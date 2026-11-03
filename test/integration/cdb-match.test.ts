/**
 * #583 on real RouterOS (commands/retrieve/examples.md MA1–MA3): `--match`
 * picks one of two CDB records saved for the same address. One record carries
 * a deliberately wrong password, so the selected record is visible on the
 * wire: `--match user=reader` reads, the other record fails
 * `transport/auth-failed`, and no `--match` is `identity/ambiguous`.
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
	let started: Awaited<ReturnType<typeof startIntegrationChr>> | undefined;
	let dir = "";
	let restUrl = "";
	let adminUser = "";
	let base: string[] = [];

	beforeAll(async () => {
		started = await startIntegrationChr();
		const chr = started.chr;
		restUrl = chr.restUrl;
		dir = await mkdtemp(join(tmpdir(), "centrs-match-chr-"));
		const auth = splitQuickChrAuth(
			readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
		);
		adminUser = auth.username;
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
		base = ["--cdb-file", cdbFile, "--via", "rest-api"];
	}, 300_000);

	afterAll(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
		await started?.chr.destroy();
	});

	test("MA1. two records for one target are ambiguous", async () => {
		const ambiguous = await run([
			"retrieve",
			restUrl,
			"/system/identity",
			...base,
		]);
		expect(ambiguous.error?.code).toBe("identity/ambiguous");
	});

	test("MA2. --match user= picks the record and its credentials", async () => {
		for (const args of [
			["retrieve", restUrl, "/system/identity"],
			["execute", restUrl, "/system/identity/print"],
			["api", restUrl, "system/identity"],
		]) {
			const reader = await run([...args, ...base, "--match", "user=reader"]);
			expect({ args, ok: reader.ok, code: reader.error?.code }).toEqual({
				args,
				ok: true,
				code: undefined,
			});
			expect(reader.meta?.target?.recordIndex).toBe(1);

			// The decoy's wrong password goes on the wire: the selection is real.
			const wrong = await run([
				...args,
				...base,
				"--match",
				`user=${adminUser}`,
			]);
			expect({ args, code: wrong.error?.code }).toEqual({
				args,
				code: "transport/auth-failed",
			});
		}
	});

	test("MA3. a selector that matches nothing", async () => {
		const none = await run([
			"retrieve",
			restUrl,
			"/system/identity",
			...base,
			"--match",
			"user=nobody",
		]);
		expect(none.error?.code).toBe("identity/no-match");
	});
});
