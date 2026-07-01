import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.ts";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";
import {
	exampleIds,
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
} from "./chr.ts";

const runFastIntegration = isChrIntegrationEnabled();
const describeFast = runFastIntegration ? describe : describe.skip;

const FANOUT_GROUP = "fanout-chr";
const UNREACHABLE_TARGET = "http://127.0.0.1:1";
const REMOTE_NAME = "fanout-test.txt";
const PAYLOAD = "centrs transfer fan-out fixture payload\n";

interface InnerEnvelope {
	ok: boolean;
	error?: { code?: string };
	data?: { local?: string | null };
	meta: {
		target: { recordIndex?: number; identity?: string; input?: string };
	};
}

interface FanoutTestEnvelope {
	ok: boolean;
	error?: { code?: string; summary?: string };
	data: {
		summary: { total: number; ok: number; failed: number };
		targets: InnerEnvelope[];
	};
	warnings: Array<{ code?: string }>;
	meta: {
		operation?: {
			kind?: string;
			selection?: { groups?: string[]; where?: string[]; all?: boolean };
			request?: { verb?: string };
		};
	};
}

function captureConsole() {
	const originalLog = console.log;
	const originalError = console.error;
	const logs: string[] = [];
	const errors: string[] = [];
	console.log = ((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	}) as typeof console.log;
	console.error = ((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	}) as typeof console.error;
	return {
		logs,
		errors,
		restore() {
			console.log = originalLog;
			console.error = originalError;
		},
	};
}

async function writeFanoutCdb(
	chrTarget: string,
	username: string,
	password: string,
	dir: string,
): Promise<string> {
	const cdbPath = join(dir, "winbox.cdb");
	const bytes = encodeOpenWinBoxCdb([
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: chrTarget,
			user: username,
			password,
			group: FANOUT_GROUP,
			comment: "quickchr transfer fanout fixture (reachable) role=edge",
			profile: "<own>",
			savedPassword: true,
		}),
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: UNREACHABLE_TARGET,
			user: username,
			password,
			group: FANOUT_GROUP,
			comment: "transfer fanout fixture (unreachable) role=core",
			profile: "<own>",
			savedPassword: true,
		}),
	]);
	await writeFile(cdbPath, bytes);
	return cdbPath;
}

describeFast("transfer fan-out against CHR", () => {
	test("fans transfer verbs across a selection over rest", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		const consoleCapture = captureConsole();
		const tmp = await mkdtemp(join(tmpdir(), "centrs-transfer-fanout-"));

		try {
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			const cdbPath = await writeFanoutCdb(
				chr.restUrl,
				auth.username,
				auth.password,
				tmp,
			);
			const srcPath = join(tmp, "src.txt");
			await writeFile(srcPath, PAYLOAD);

			// Seed: single-target upload so the reachable CHR has a file to download.
			const seedExit = await runCli([
				"transfer",
				chr.restUrl,
				"upload",
				srcPath,
				REMOTE_NAME,
				"--via",
				"rest",
				"--username",
				auth.username,
				"--password",
				auth.password,
				"--force",
				"--json",
			]);
			expect(seedExit).toBe(0);

			// F1: `--group` list fan-out (one ok, one refused), exit 2.
			const f1Start = consoleCapture.logs.length;
			const f1Exit = await runCli([
				"transfer",
				"--group",
				FANOUT_GROUP,
				"list",
				"--via",
				"rest",
				"--cdb-file",
				cdbPath,
				"--json",
			]);
			const f1 = JSON.parse(
				consoleCapture.logs.slice(f1Start)[0] ?? "",
			) as FanoutTestEnvelope;
			expect(f1Exit).toBe(2);
			expect(f1.ok).toBe(true);
			expect(f1.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
			expect(f1.meta.operation?.kind).toBe("fanout");
			expect(f1.meta.operation?.request?.verb).toBe("list");
			expect(f1.data.targets.map((t) => t.meta.target.recordIndex)).toEqual([
				0, 1,
			]);

			// F2: empty / unknown group → ok:true, 0/0/0, exit 0.
			const f2Start = consoleCapture.logs.length;
			const f2Exit = await runCli([
				"transfer",
				"--group",
				"no-such-group",
				"list",
				"--via",
				"rest",
				"--cdb-file",
				cdbPath,
				"--json",
			]);
			const f2 = JSON.parse(
				consoleCapture.logs.slice(f2Start)[0] ?? "",
			) as FanoutTestEnvelope;
			expect(f2Exit).toBe(0);
			expect(f2.data.summary).toEqual({ total: 0, ok: 0, failed: 0 });
			expect(f2.warnings.map((w) => w.code)).toContain("cdb/empty-group");

			// F3: `--where role=edge` selects only the reachable record, exit 0.
			const f3Start = consoleCapture.logs.length;
			const f3Exit = await runCli([
				"transfer",
				"--where",
				"role=edge",
				"list",
				"--via",
				"rest",
				"--cdb-file",
				cdbPath,
				"--json",
			]);
			const f3 = JSON.parse(
				consoleCapture.logs.slice(f3Start)[0] ?? "",
			) as FanoutTestEnvelope;
			expect(f3Exit).toBe(0);
			expect(f3.data.summary).toEqual({ total: 1, ok: 1, failed: 0 });
			expect(f3.meta.operation?.selection?.where).toEqual(["role=edge"]);

			// F4: `download` fan-out into `--out-dir` writes one file per ok target.
			const outDir = join(tmp, "downloads");
			await mkdir(outDir, { recursive: true });
			const f4Start = consoleCapture.logs.length;
			const f4Exit = await runCli([
				"transfer",
				"--group",
				FANOUT_GROUP,
				"download",
				REMOTE_NAME,
				"--out-dir",
				outDir,
				"--via",
				"rest",
				"--cdb-file",
				cdbPath,
				"--json",
			]);
			const f4 = JSON.parse(
				consoleCapture.logs.slice(f4Start)[0] ?? "",
			) as FanoutTestEnvelope;
			expect(f4Exit).toBe(2);
			expect(f4.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
			// Exactly one file landed (the reachable target); its bytes match the seed.
			const downloaded = await readdir(outDir);
			expect(downloaded).toHaveLength(1);
			const localPath = join(outDir, downloaded[0] ?? "");
			expect(await readFile(localPath, "utf8")).toBe(PAYLOAD);
			const okTarget = f4.data.targets.find((t) => t.ok);
			expect(okTarget?.data?.local).toBe(localPath);

			// F5: a mutating fan-out (`remove`) WITHOUT --yes is refused, naming the
			// blast radius — nothing is removed.
			const f5Start = consoleCapture.errors.length;
			const f5Exit = await runCli([
				"transfer",
				"--group",
				FANOUT_GROUP,
				"remove",
				REMOTE_NAME,
				"--via",
				"rest",
				"--cdb-file",
				cdbPath,
				"--json",
			]);
			const f5 = JSON.parse(
				consoleCapture.errors.slice(f5Start)[0] ?? "",
			) as FanoutTestEnvelope;
			expect(f5Exit).toBe(1);
			expect(f5.ok).toBe(false);
			expect(f5.error?.code).toBe("usage/confirmation-required");
			expect(f5.error?.summary).toContain("2 router(s)");

			// F6: `download` fan-out WITHOUT --out-dir is an outer usage error.
			const f6Start = consoleCapture.errors.length;
			const f6Exit = await runCli([
				"transfer",
				"--group",
				FANOUT_GROUP,
				"download",
				REMOTE_NAME,
				"--via",
				"rest",
				"--cdb-file",
				cdbPath,
				"--json",
			]);
			const f6 = JSON.parse(
				consoleCapture.errors.slice(f6Start)[0] ?? "",
			) as FanoutTestEnvelope;
			expect(f6Exit).toBe(1);
			expect(f6.ok).toBe(false);
			expect(f6.error?.code).toBe("usage/conflicting-flags");

			const resourceVersion =
				typeof chr.state.version === "string" ? chr.state.version : undefined;
			await recordIntegrationEvidence({
				suite: "transfer fan-out against CHR",
				command: "transfer",
				protocol: "rest-api",
				routerosVersion: resourceVersion ?? "unknown",
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(6),
			});
		} finally {
			consoleCapture.restore();
			await rm(tmp, { recursive: true, force: true });
			await chr.destroy();
		}
	}, 300_000);
});
