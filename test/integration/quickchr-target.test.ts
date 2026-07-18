/**
 * `--quickchr <name>` acceptance against a real quickchr-managed CHR (#134
 * Phase 5). Boots ONE CHR through quickchr's own registry, then targets it by
 * machine name only — no `$R`/`$U`/`$P`, no CDB, no CENTRS_HOST-style env: the
 * live descriptor (`QuickCHR.get(name).descriptor()`) is the only
 * connection-fact source. Covers the Q-series examples in
 * `commands/{retrieve,execute,api,transfer}/examples.md`.
 */

import { describe, expect, test } from "bun:test";
import { runCli } from "../../src/cli.ts";
import {
	exampleIds,
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

interface Envelope {
	ok: boolean;
	data?: unknown;
	error?: { code?: string; summary?: string };
	warnings?: Array<{ code?: string }>;
	meta: {
		via?: string | null;
		target: {
			identity?: string;
			recordIndex?: number;
			source?: { kind?: string; key?: string };
			host?: string;
		};
	};
}

interface FanoutEnvelope {
	ok: boolean;
	data: {
		summary: { total: number; ok: number; failed: number };
		targets: Envelope[];
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

describeFast("--quickchr targets against CHR (#134)", () => {
	test("Q1–Q3 per command: retrieve/execute/api/transfer resolve the machine by name", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		const consoleCapture = captureConsole();
		try {
			const name = chr.name;

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
			const parse = <T = Envelope>(streams: string[]): T =>
				JSON.parse(streams.join("\n")) as T;

			// retrieve Q1: REST endpoint from the descriptor; provider provenance;
			// no CDB record index may appear (the CDB was never consulted).
			const rq1 = await run([
				"retrieve",
				"--quickchr",
				name,
				"/system/resource",
				"--json",
			]);
			expect(rq1.exit).toBe(0);
			const rq1Env = parse(rq1.out);
			expect(rq1Env.ok).toBe(true);
			expect(rq1Env.meta.via).toBe("rest-api");
			expect(rq1Env.meta.target.identity).toBe(name);
			expect(rq1Env.meta.target.source?.kind).toBe("provider");
			expect(rq1Env.meta.target.recordIndex).toBeUndefined();

			// execute Q1: native-api default; identity round-trips from RouterOS.
			const eq1 = await run([
				"execute",
				"--quickchr",
				name,
				":put [/system/identity/get name]",
				"--json",
			]);
			expect(eq1.exit).toBe(0);
			const eq1Env = parse(eq1.out);
			expect(eq1Env.ok).toBe(true);
			expect(eq1Env.meta.via).toBe("native-api");
			expect(eq1Env.meta.target.source?.kind).toBe("provider");

			// execute Q2: a --via the descriptor does not forward is a typed error,
			// never a fallback.
			const eq2 = await run([
				"execute",
				"--quickchr",
				name,
				":put 1",
				"--via",
				"mac-telnet",
				"--json",
			]);
			expect(eq2.exit).toBe(1);
			const eq2Env = parse(eq2.err);
			expect(eq2Env.ok).toBe(false);
			expect(eq2Env.error?.code).toBe("quickchr/unsupported-via");

			// execute Q3: repeated --quickchr fans out; the unknown machine is an
			// inner quickchr/machine-not-found, exit 2 (partial).
			const eq3 = await run([
				"execute",
				"--quickchr",
				name,
				"--quickchr",
				"centrs-no-such-machine",
				"--json",
				"--",
				":put 1",
			]);
			expect(eq3.exit).toBe(2);
			const eq3Env = parse<FanoutEnvelope>(eq3.out);
			expect(eq3Env.ok).toBe(true);
			expect(eq3Env.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
			const eq3Failed = eq3Env.data.targets.find((t) => !t.ok);
			expect(eq3Failed?.error?.code).toBe("quickchr/machine-not-found");
			expect(eq3Failed?.meta.target.identity).toBe("centrs-no-such-machine");

			// api Q1: GET over the descriptor's REST service.
			const aq1 = await run([
				"api",
				"--quickchr",
				name,
				"system/resource",
				"--json",
			]);
			expect(aq1.exit).toBe(0);
			const aq1Env = parse(aq1.out);
			expect(aq1Env.ok).toBe(true);
			expect(aq1Env.meta.target.source?.kind).toBe("provider");

			// transfer Q1: list over the REST service.
			const tq1 = await run(["transfer", "--quickchr", name, "list", "--json"]);
			expect(tq1.exit).toBe(0);
			const tq1Env = parse(tq1.out);
			expect(tq1Env.ok).toBe(true);
			expect(tq1Env.meta.target.source?.kind).toBe("provider");

			// transfer Q2: the sftp gate. Either the descriptor advertises a
			// batch-capable SSH auth mode and the list succeeds over sftp, or the
			// gate fails typed (quickchr/unsupported-via) — never a prompt, never a
			// silent fallback to REST.
			const tq2 = await run([
				"transfer",
				"--quickchr",
				name,
				"list",
				"--via",
				"sftp",
				"--json",
			]);
			if (tq2.exit === 0) {
				const tq2Env = parse(tq2.out);
				expect(tq2Env.ok).toBe(true);
				expect(tq2Env.meta.target.source?.kind).toBe("provider");
			} else {
				const tq2Env = parse(tq2.err);
				expect(tq2Env.ok).toBe(false);
				expect(tq2Env.error?.code).toBe("quickchr/unsupported-via");
			}

			const version =
				typeof chr.state.version === "string" ? chr.state.version : "unknown";
			await recordIntegrationEvidence({
				suite: "--quickchr targets against CHR",
				command: "retrieve+execute+api+transfer",
				protocol: "rest-api+native-api",
				routerosVersion: version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(7),
			});
		} finally {
			consoleCapture.restore();
			await chr.destroy();
		}
	}, 600_000);
});
