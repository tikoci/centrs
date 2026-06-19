import { describe, expect, test } from "bun:test";
import { runCli } from "../../src/cli.ts";
import { executeEnvelope } from "../../src/execute.ts";
import {
	exampleIds,
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

interface SuccessEnvelope {
	ok: true;
	data?: unknown;
	meta: { via: string; validation?: { source?: string } };
}

function captureConsole() {
	const originalLog = console.log;
	const originalError = console.error;
	const logs: string[] = [];
	const errors: string[] = [];
	console.log = ((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
		originalLog.apply(console, args);
	}) as typeof console.log;
	console.error = ((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
		originalError.apply(console, args);
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

/**
 * Single-boot CHR smoke — the push/PR gate tier (`ci.yaml`). Boots ONE CHR and
 * proves the common round-trip paths generally work: REST retrieve, native-api
 * retrieve, and a read-only `execute` (validate → run). Deeper per-command and
 * per-channel coverage lives in the QA matrix (`qa.yaml`); this stays one boot so
 * the gate exercises ~one VM, not sixteen. The execute step is a read-only `:put`
 * so the gate never mutates the router (idempotent, safe to re-run).
 */
describeFast("CHR smoke (single boot, core paths)", () => {
	test("REST + native-api retrieve and a read-only execute round-trip", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		const auth = splitQuickChrAuth(
			readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
		);
		const capture = captureConsole();

		async function ok(args: readonly string[]): Promise<SuccessEnvelope> {
			const logStart = capture.logs.length;
			const errStart = capture.errors.length;
			const exitCode = await runCli([...args, "--json"]);
			const stdout = capture.logs.slice(logStart);
			const stderr = capture.errors.slice(errStart);
			expect(stderr).toHaveLength(0);
			expect(exitCode).toBe(0);
			expect(stdout).toHaveLength(1);
			const firstLine = stdout[0];
			if (firstLine === undefined) {
				throw new Error("Expected one JSON line in stdout, but none was captured.");
			}
			let envelope: SuccessEnvelope;
			try {
				envelope = JSON.parse(firstLine) as SuccessEnvelope;
			} catch (error) {
				throw new Error(
					`Failed to parse CLI JSON output. stdout[0]=${firstLine}`,
					{ cause: error },
				);
			}
			expect(envelope.ok).toBe(true);
			return envelope;
		}

		try {
			const restBase = [
				"--username",
				auth.username,
				"--password",
				auth.password,
			];

			// 1. REST retrieve — singleton with version/uptime.
			const resource = await ok([
				"retrieve",
				chr.restUrl,
				"/system/resource",
				...restBase,
			]);
			expect(resource.meta.via).toBe("rest-api");
			const resourceData = resource.data as Record<string, unknown> | undefined;
			expect(resourceData).toHaveProperty("version");
			expect(resourceData).toHaveProperty("uptime");
			const version = resourceData?.["version"];
			const boardName = resourceData?.["board-name"];

			// 2. REST retrieve — identity (used below to prove execute actually ran).
			const identity = await ok([
				"retrieve",
				chr.restUrl,
				"/system/identity",
				...restBase,
			]);
			const identityName = (identity.data as { name?: string }).name ?? "";
			expect(identityName.length).toBeGreaterThan(0);

			// 3. native-api retrieve — the second transport, same singleton.
			const apiResource = await ok([
				"retrieve",
				"127.0.0.1",
				"/system/resource",
				"--via",
				"native-api",
				"--port",
				String(chr.ports.api),
				...restBase,
			]);
			expect(apiResource.meta.via).toBe("native-api");
			expect(apiResource.data as Record<string, unknown>).toHaveProperty(
				"version",
			);

			// 4. execute — a read-only `:put` script proves the validate → run path
			//    end-to-end (the returned value is the live identity, not a constant).
			//    Uses the programmatic executeEnvelope (as execute.test.ts does) so the
			//    non-TTY CI runner's stdin state never enters the picture.
			const scriptEnvelope = await executeEnvelope({
				targetInput: chr.restUrl,
				via: "rest-api",
				username: auth.username,
				password: auth.password,
				command: ":put [/system/identity/get name]",
			});
			expect(scriptEnvelope.ok).toBe(true);
			const script = scriptEnvelope as SuccessEnvelope;
			expect(script.meta.via).toBe("rest-api");
			expect(JSON.stringify(script.data)).toContain(identityName);

			await recordIntegrationEvidence({
				suite: "CHR smoke (single boot, core paths)",
				command: "retrieve+execute",
				protocol: "rest-api+native-api",
				routerosVersion:
					typeof version === "string" ? version : chr.state.version,
				boardName: typeof boardName === "string" ? boardName : undefined,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(4),
			});
		} finally {
			capture.restore();
			await chr.destroy();
		}
	}, 300_000);
});
