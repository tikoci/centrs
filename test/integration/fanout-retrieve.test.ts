import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
// A port that is not listening, to force a deterministic inner failure
// (transport/connection-refused) for the second target.
const UNREACHABLE_TARGET = "http://127.0.0.1:1";

interface InnerEnvelope {
	ok: boolean;
	error?: { code?: string; summary?: string };
	meta: {
		via?: string | null;
		target: { recordIndex?: number; name?: string; host?: string };
		operation?: { kind?: string };
	};
}

interface FanoutTestEnvelope {
	ok: boolean;
	data: {
		summary: { total: number; ok: number; failed: number };
		targets: InnerEnvelope[];
	};
	warnings: Array<{ code?: string }>;
	meta: {
		via?: string | null;
		operation?: {
			kind?: string;
			group?: string;
			concurrency?: number;
			summary?: { total: number; ok: number; failed: number };
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
): Promise<{ cdbPath: string; cleanup: () => Promise<void> }> {
	const tempDir = join(
		import.meta.dir,
		".generated",
		`fanout-cdb-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(tempDir, { recursive: true });
	const cdbPath = join(tempDir, "winbox.cdb");
	// Record 0 is the live CHR (succeeds); record 1 is unreachable (fails). Both
	// share the same group so `--group` fans out across exactly these two, and
	// the unreachable record finishes first to prove deterministic ordering.
	const bytes = encodeOpenWinBoxCdb([
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: chrTarget,
			user: username,
			password,
			group: FANOUT_GROUP,
			comment: "quickchr fanout fixture (reachable)",
			profile: "<own>",
			savedPassword: true,
		}),
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: UNREACHABLE_TARGET,
			user: username,
			password,
			group: FANOUT_GROUP,
			comment: "fanout fixture (unreachable)",
			profile: "<own>",
			savedPassword: true,
		}),
	]);
	await writeFile(cdbPath, bytes);
	return {
		cdbPath,
		cleanup: async () => {
			await rm(tempDir, { recursive: true, force: true });
		},
	};
}

describeFast("retrieve group fanout against CHR", () => {
	test("fans out a 2-target group: one inner ok, one inner failure", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		const consoleCapture = captureConsole();
		let fixture: { cdbPath: string; cleanup: () => Promise<void> } | undefined;

		try {
			const env = started.env;
			const auth = splitQuickChrAuth(readEnv(env, "QUICKCHR_AUTH") ?? "admin:");
			fixture = await writeFanoutCdb(chr.restUrl, auth.username, auth.password);

			const logsStart = consoleCapture.logs.length;
			const exitCode = await runCli([
				"retrieve",
				"--group",
				FANOUT_GROUP,
				"/system/resource",
				"--cdb-file",
				fixture.cdbPath,
			]);
			const stdout = consoleCapture.logs.slice(logsStart);

			// Outer envelope is a success even though one target failed.
			expect(exitCode).toBe(0);
			expect(stdout).toHaveLength(1);
			const envelope = JSON.parse(stdout[0] ?? "") as FanoutTestEnvelope;

			expect(envelope.ok).toBe(true);
			expect(envelope.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
			expect(envelope.meta.operation?.kind).toBe("fanout");
			expect(envelope.meta.operation?.group).toBe(FANOUT_GROUP);
			expect(envelope.meta.operation?.summary).toEqual({
				total: 2,
				ok: 1,
				failed: 1,
			});

			// Deterministic ordering: targets[] follow CDB record index.
			expect(envelope.data.targets).toHaveLength(2);
			expect(
				envelope.data.targets.map((t) => t.meta.target.recordIndex),
			).toEqual([0, 1]);

			// Record 0 is the live CHR — an inner success.
			const reachable = envelope.data.targets[0];
			expect(reachable?.ok).toBe(true);
			expect(reachable?.meta.via).toBe("rest-api");

			// Record 1 is the unreachable host — an inner ok:false, NOT thrown.
			const unreachable = envelope.data.targets[1];
			expect(unreachable?.ok).toBe(false);
			expect(unreachable?.error?.code).toBe("transport/connection-refused");
			expect(unreachable?.meta.target.recordIndex).toBe(1);

			const resourceVersion =
				typeof chr.state.version === "string" ? chr.state.version : undefined;
			await recordIntegrationEvidence({
				suite: "retrieve group fanout against CHR",
				command: "retrieve",
				protocol: "rest-api",
				routerosVersion: resourceVersion ?? "unknown",
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(2),
			});
		} finally {
			consoleCapture.restore();
			await fixture?.cleanup();
			await chr.destroy();
		}
	}, 300_000);

	test("unknown / empty group is ok:true with a cdb/empty-group warning", async () => {
		const consoleCapture = captureConsole();
		let fixture: { cdbPath: string; cleanup: () => Promise<void> } | undefined;
		try {
			fixture = await writeFanoutCdb("http://127.0.0.1:2", "admin", "");
			const logsStart = consoleCapture.logs.length;
			const exitCode = await runCli([
				"retrieve",
				"--group",
				"no-such-group",
				"/system/resource",
				"--cdb-file",
				fixture.cdbPath,
			]);
			const stdout = consoleCapture.logs.slice(logsStart);
			expect(exitCode).toBe(0);
			const envelope = JSON.parse(stdout[0] ?? "") as FanoutTestEnvelope;
			expect(envelope.ok).toBe(true);
			expect(envelope.data.summary).toEqual({ total: 0, ok: 0, failed: 0 });
			expect(envelope.data.targets).toHaveLength(0);
			expect(envelope.warnings.map((w) => w.code)).toContain("cdb/empty-group");
		} finally {
			consoleCapture.restore();
			await fixture?.cleanup();
		}
	});
});
