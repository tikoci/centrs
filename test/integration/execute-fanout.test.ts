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
const READ_COMMAND = "/system/resource/print";

interface InnerEnvelope {
	ok: boolean;
	error?: { code?: string; summary?: string };
	meta: {
		via?: string | null;
		target: {
			recordIndex?: number;
			identity?: string;
			host?: string;
			input?: string;
		};
		operation?: { kind?: string };
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
		via?: string | null;
		operation?: {
			kind?: string;
			selection?: {
				groups?: string[];
				where?: string[];
				all?: boolean;
				default?: boolean;
				positionals?: string[];
			};
			concurrency?: number;
			summary?: { total: number; ok: number; failed: number };
			request?: { command?: string; write?: boolean };
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
		`execute-fanout-cdb-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(tempDir, { recursive: true });
	const cdbPath = join(tempDir, "winbox.cdb");
	// Record 0 is the live CHR (succeeds, comment fact `role=edge`); record 1 is
	// unreachable (fails, `role=core`). Both share `FANOUT_GROUP`.
	const bytes = encodeOpenWinBoxCdb([
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: chrTarget,
			user: username,
			password,
			group: FANOUT_GROUP,
			comment: "quickchr execute fanout fixture (reachable) role=edge",
			profile: "<own>",
			savedPassword: true,
		}),
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: UNREACHABLE_TARGET,
			user: username,
			password,
			group: FANOUT_GROUP,
			comment: "execute fanout fixture (unreachable) role=core",
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

describeFast("execute fan-out against CHR", () => {
	test("fans the same command across a selection over rest-api", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		const consoleCapture = captureConsole();
		let fixture: { cdbPath: string; cleanup: () => Promise<void> } | undefined;

		try {
			const env = started.env;
			const auth = splitQuickChrAuth(readEnv(env, "QUICKCHR_AUTH") ?? "admin:");
			fixture = await writeFanoutCdb(chr.restUrl, auth.username, auth.password);

			// F1: `--group` read fan-out (one inner ok, one inner failure), exit 2.
			const f1Start = consoleCapture.logs.length;
			const f1Exit = await runCli([
				"execute",
				"--group",
				FANOUT_GROUP,
				"--via",
				"rest-api",
				"--cdb-file",
				fixture.cdbPath,
				"--json",
				"--",
				READ_COMMAND,
			]);
			const f1 = JSON.parse(
				consoleCapture.logs.slice(f1Start)[0] ?? "",
			) as FanoutTestEnvelope;
			expect(f1Exit).toBe(2);
			expect(f1.ok).toBe(true);
			expect(f1.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
			expect(f1.meta.operation?.kind).toBe("fanout");
			expect(f1.meta.operation?.selection?.groups).toEqual([FANOUT_GROUP]);
			expect(f1.data.targets.map((t) => t.meta.target.recordIndex)).toEqual([
				0, 1,
			]);
			expect(f1.data.targets[0]?.ok).toBe(true);
			expect(f1.data.targets[1]?.ok).toBe(false);
			expect(f1.data.targets[1]?.error?.code).toBe(
				"transport/connection-refused",
			);

			// F2: empty / unknown group → ok:true, 0/0/0, exit 0.
			const f2Start = consoleCapture.logs.length;
			const f2Exit = await runCli([
				"execute",
				"--group",
				"no-such-group",
				"--via",
				"rest-api",
				"--cdb-file",
				fixture.cdbPath,
				"--json",
				"--",
				READ_COMMAND,
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
				"execute",
				"--where",
				"role=edge",
				"--via",
				"rest-api",
				"--cdb-file",
				fixture.cdbPath,
				"--json",
				"--",
				READ_COMMAND,
			]);
			const f3 = JSON.parse(
				consoleCapture.logs.slice(f3Start)[0] ?? "",
			) as FanoutTestEnvelope;
			expect(f3Exit).toBe(0);
			expect(f3.data.summary).toEqual({ total: 1, ok: 1, failed: 0 });
			expect(f3.meta.operation?.selection?.where).toEqual(["role=edge"]);

			// F4: `--all` fans across every record, exit 2.
			const f4Start = consoleCapture.logs.length;
			const f4Exit = await runCli([
				"execute",
				"--all",
				"--via",
				"rest-api",
				"--cdb-file",
				fixture.cdbPath,
				"--json",
				"--",
				READ_COMMAND,
			]);
			const f4 = JSON.parse(
				consoleCapture.logs.slice(f4Start)[0] ?? "",
			) as FanoutTestEnvelope;
			expect(f4Exit).toBe(2);
			expect(f4.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
			expect(f4.meta.operation?.selection?.all).toBe(true);

			// F5: a write-shaped fan-out WITHOUT --yes is an outer confirmation error
			// naming the blast radius — nothing is mutated.
			const f5Start = consoleCapture.errors.length;
			const f5Exit = await runCli([
				"execute",
				"--group",
				FANOUT_GROUP,
				"--via",
				"rest-api",
				"--cdb-file",
				fixture.cdbPath,
				"--json",
				"--",
				"/system/identity/set name=fanout-blast",
			]);
			const f5 = JSON.parse(
				consoleCapture.errors.slice(f5Start)[0] ?? "",
			) as FanoutTestEnvelope;
			expect(f5Exit).toBe(1);
			expect(f5.ok).toBe(false);
			expect(f5.error?.code).toBe("usage/confirmation-required");
			expect(f5.error?.summary).toContain("2 router(s)");

			// F6: two positional targets before `--` fan out as ad-hoc literals,
			// labeled by input with no borrowed recordIndex, exit 2.
			const f6Start = consoleCapture.logs.length;
			const f6Exit = await runCli([
				"execute",
				chr.restUrl,
				UNREACHABLE_TARGET,
				"--via",
				"rest-api",
				"--username",
				auth.username,
				"--password",
				auth.password,
				"--json",
				"--",
				READ_COMMAND,
			]);
			const f6 = JSON.parse(
				consoleCapture.logs.slice(f6Start)[0] ?? "",
			) as FanoutTestEnvelope;
			expect(f6Exit).toBe(2);
			expect(f6.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
			expect(f6.data.targets.map((t) => t.meta.target.input)).toEqual([
				chr.restUrl,
				UNREACHABLE_TARGET,
			]);
			expect(
				f6.data.targets.every((t) => t.meta.target.recordIndex === undefined),
			).toBe(true);

			const resourceVersion =
				typeof chr.state.version === "string" ? chr.state.version : undefined;
			await recordIntegrationEvidence({
				suite: "execute fan-out against CHR",
				command: "execute",
				protocol: "rest-api",
				routerosVersion: resourceVersion ?? "unknown",
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(6),
			});
		} finally {
			consoleCapture.restore();
			await fixture?.cleanup();
			await chr.destroy();
		}
	}, 300_000);
});
