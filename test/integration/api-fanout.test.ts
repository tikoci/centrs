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

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

const FANOUT_GROUP = "api-fanout-chr";
// A port that is not listening, to force a deterministic inner failure
// (transport/connection-refused) for the second target.
const UNREACHABLE_TARGET = "http://127.0.0.1:1";

interface InnerEnvelope {
	ok: boolean;
	data?: unknown;
	error?: { code?: string; summary?: string };
	meta: { via?: string | null; target: { recordIndex?: number } };
}

interface ApiFanoutEnvelope {
	ok: boolean;
	error?: { code?: string; summary?: string };
	data: {
		summary: { total: number; ok: number; failed: number };
		targets: InnerEnvelope[];
	};
	warnings: Array<{ code?: string }>;
	meta: { operation?: { kind?: string; concurrency?: number } };
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

async function writeApiFanoutCdb(
	chrTarget: string,
	username: string,
	password: string,
): Promise<{ cdbPath: string; cleanup: () => Promise<void> }> {
	const tempDir = join(
		import.meta.dir,
		".generated",
		`api-fanout-cdb-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(tempDir, { recursive: true });
	const cdbPath = join(tempDir, "winbox.cdb");
	// Record 0 is the live CHR (board=chr); record 1 is unreachable (board=dead).
	// Both share the group so `--group` fans across exactly these two; `board=`
	// gives `--where` a device-class fact to select the live one.
	const bytes = encodeOpenWinBoxCdb([
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: chrTarget,
			user: username,
			password,
			group: FANOUT_GROUP,
			comment: "board=chr quickchr api-fanout fixture (reachable)",
			profile: "<own>",
			savedPassword: true,
		}),
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: UNREACHABLE_TARGET,
			user: username,
			password,
			group: FANOUT_GROUP,
			comment: "board=dead api-fanout fixture (unreachable)",
			profile: "<own>",
			savedPassword: true,
		}),
		// Record 2: the reserved credential-fallback record. `--all`/`--group` must
		// exclude it; `--default` selects it and it fails the connectable guard.
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: "__default__",
			user: username,
			password,
			group: "",
			comment: "",
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

describeFast("api fanout against CHR", () => {
	test("F1-F9: group/where/empty/write/all/union/concurrency/default across CHR", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		const consoleCapture = captureConsole();
		let fixture: { cdbPath: string; cleanup: () => Promise<void> } | undefined;
		try {
			const env = started.env;
			const auth = splitQuickChrAuth(readEnv(env, "QUICKCHR_AUTH") ?? "admin:");
			fixture = await writeApiFanoutCdb(
				chr.restUrl,
				auth.username,
				auth.password,
			);
			const cdb = fixture.cdbPath;

			const run = async (
				args: string[],
			): Promise<{ exit: number; out: string[]; err: string[] }> => {
				const logStart = consoleCapture.logs.length;
				const errStart = consoleCapture.errors.length;
				const exit = await runCli(args);
				return {
					exit,
					out: consoleCapture.logs.slice(logStart),
					err: consoleCapture.errors.slice(errStart),
				};
			};

			// F1. `--group` GET fanout: one live success, one unreachable inner failure.
			const f1 = await run([
				"api",
				"--group",
				FANOUT_GROUP,
				"ip/address",
				"--cdb-file",
				cdb,
				"--json",
			]);
			expect(f1.exit).toBe(2);
			const f1env = JSON.parse(f1.out[0] ?? "") as ApiFanoutEnvelope;
			expect(f1env.ok).toBe(true);
			expect(f1env.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
			expect(f1env.meta.operation?.kind).toBe("fanout");
			expect(f1env.data.targets.map((t) => t.meta.target.recordIndex)).toEqual([
				0, 1,
			]);
			expect(f1env.data.targets[0]?.ok).toBe(true);
			expect(f1env.data.targets[0]?.meta.via).toBe("rest-api");
			expect(f1env.data.targets[1]?.ok).toBe(false);
			expect(f1env.data.targets[1]?.error?.code).toBe(
				"transport/connection-refused",
			);

			// F2. `--where board=chr` selects only the live device.
			const f2 = await run([
				"api",
				"--where",
				"board=chr",
				"ip/address",
				"--cdb-file",
				cdb,
				"--json",
			]);
			expect(f2.exit).toBe(0);
			const f2env = JSON.parse(f2.out[0] ?? "") as ApiFanoutEnvelope;
			expect(f2env.data.summary).toEqual({ total: 1, ok: 1, failed: 0 });
			expect(f2env.data.targets[0]?.ok).toBe(true);

			// F3. An empty selection is ok:true with summary 0/0/0 + a warning.
			const f3 = await run([
				"api",
				"--group",
				"no-such-group",
				"ip/address",
				"--cdb-file",
				cdb,
				"--json",
			]);
			expect(f3.exit).toBe(0);
			const f3env = JSON.parse(f3.out[0] ?? "") as ApiFanoutEnvelope;
			expect(f3env.ok).toBe(true);
			expect(f3env.data.summary).toEqual({ total: 0, ok: 0, failed: 0 });
			expect(f3env.data.targets).toHaveLength(0);
			expect(f3env.warnings.map((w) => w.code)).toContain("cdb/empty-group");

			// F4. A mutating fan-out without `--yes` is rejected, naming the blast radius.
			const f4 = await run([
				"api",
				"-X",
				"PUT",
				"ip/address",
				"-f",
				"address=10.99.0.1/32",
				"-f",
				"interface=ether1",
				"--group",
				FANOUT_GROUP,
				"--cdb-file",
				cdb,
				"--json",
			]);
			expect(f4.exit).toBe(1);
			const f4env = JSON.parse(f4.err[0] ?? "") as ApiFanoutEnvelope;
			expect(f4env.ok).toBe(false);
			expect(f4env.error?.code).toBe("usage/confirmation-required");
			expect(f4env.error?.summary).toContain("2 router(s)");

			// F5. A mutating fan-out with `--yes` writes across the selected device.
			const f5 = await run([
				"api",
				"-X",
				"PUT",
				"ip/address",
				"-f",
				"address=10.99.0.7/32",
				"-f",
				"interface=ether1",
				"--where",
				"board=chr",
				"--yes",
				"--cdb-file",
				cdb,
				"--json",
			]);
			expect(f5.exit).toBe(0);
			const f5env = JSON.parse(f5.out[0] ?? "") as ApiFanoutEnvelope;
			expect(f5env.data.summary).toEqual({ total: 1, ok: 1, failed: 0 });
			expect(f5env.data.targets[0]?.ok).toBe(true);
			const created = f5env.data.targets[0]?.data as
				| Record<string, unknown>
				| undefined;
			expect(created?.[".id"]).toBeDefined();

			// F6. `--all` fans across every record EXCEPT `__default__`.
			const f6 = await run([
				"api",
				"--all",
				"ip/address",
				"--cdb-file",
				cdb,
				"--json",
			]);
			expect(f6.exit).toBe(2);
			const f6env = JSON.parse(f6.out[0] ?? "") as ApiFanoutEnvelope;
			expect(f6env.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
			expect(f6env.data.targets.map((t) => t.meta.target.recordIndex)).toEqual([
				0, 1,
			]);

			// F7. A positional + `--group` union de-dupes by record index (not 3).
			const f7 = await run([
				"api",
				chr.restUrl,
				"--group",
				FANOUT_GROUP,
				"ip/address",
				"--cdb-file",
				cdb,
				"--json",
			]);
			expect(f7.exit).toBe(2);
			const f7env = JSON.parse(f7.out[0] ?? "") as ApiFanoutEnvelope;
			expect(f7env.data.summary.total).toBe(2);
			expect(f7env.data.targets.map((t) => t.meta.target.recordIndex)).toEqual([
				0, 1,
			]);

			// F8. `--concurrency 1` bounds the pool (still completes; meta records it).
			const f8 = await run([
				"api",
				"--group",
				FANOUT_GROUP,
				"--concurrency",
				"1",
				"ip/address",
				"--cdb-file",
				cdb,
				"--json",
			]);
			expect(f8.exit).toBe(2);
			const f8env = JSON.parse(f8.out[0] ?? "") as ApiFanoutEnvelope;
			expect(f8env.meta.operation?.concurrency).toBe(1);
			expect(f8env.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });

			// F9. `--default` selects `__default__`, which fails the connectable guard.
			const f9 = await run([
				"api",
				"--default",
				"ip/address",
				"--cdb-file",
				cdb,
				"--json",
			]);
			expect(f9.exit).toBe(1);
			const f9env = JSON.parse(f9.out[0] ?? "") as ApiFanoutEnvelope;
			expect(f9env.data.summary).toEqual({ total: 1, ok: 0, failed: 1 });
			expect(f9env.data.targets[0]?.ok).toBe(false);
			expect(f9env.data.targets[0]?.error?.code).toBe("target/unresolved");

			const resourceVersion =
				typeof chr.state.version === "string" ? chr.state.version : undefined;
			await recordIntegrationEvidence({
				suite: "api fanout against CHR",
				command: "api",
				protocol: "rest-api",
				routerosVersion: resourceVersion ?? "unknown",
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(9),
			});
		} finally {
			consoleCapture.restore();
			await fixture?.cleanup();
			await chr.destroy();
		}
	}, 300_000);
});
