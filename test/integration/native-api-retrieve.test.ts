import { describe, expect, test } from "bun:test";
import { runCli } from "../../src/cli.ts";
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

interface SuccessEnvelope {
	ok: true;
	data?: unknown;
	meta: {
		via: string;
		validation?: { source?: string };
	};
}

interface FailureEnvelope {
	ok: false;
	error: { code?: string };
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

describeFast("native API retrieve against CHR", () => {
	test("runs retrieve examples over --via native-api", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		const auth = splitQuickChrAuth(
			readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
		);
		const capture = captureConsole();
		const apiPort = String(chr.ports.api);
		const baseArgs = [
			"--via",
			"native-api",
			"--port",
			apiPort,
			"--username",
			auth.username,
			"--password",
			auth.password,
		];

		async function ok(args: readonly string[]): Promise<SuccessEnvelope> {
			const logStart = capture.logs.length;
			const errStart = capture.errors.length;
			const exitCode = await runCli(args);
			const stdout = capture.logs.slice(logStart);
			const stderr = capture.errors.slice(errStart);
			expect(stderr).toHaveLength(0);
			expect(exitCode).toBe(0);
			expect(stdout).toHaveLength(1);
			const envelope = JSON.parse(stdout[0] ?? "") as SuccessEnvelope;
			expect(envelope.ok).toBe(true);
			expect(envelope.meta.via).toBe("native-api");
			expect(envelope.meta.validation?.source).toContain("/console/inspect");
			return envelope;
		}

		async function fail(
			args: readonly string[],
			code: string,
		): Promise<FailureEnvelope> {
			const logStart = capture.logs.length;
			const errStart = capture.errors.length;
			const exitCode = await runCli(args);
			const stdout = capture.logs.slice(logStart);
			const stderr = capture.errors.slice(errStart);
			expect(exitCode).toBe(1);
			expect(stdout).toHaveLength(0);
			expect(stderr).toHaveLength(1);
			const envelope = JSON.parse(stderr[0] ?? "") as FailureEnvelope;
			expect(envelope.ok).toBe(false);
			expect(envelope.error.code).toBe(code);
			return envelope;
		}

		try {
			// 1. Singleton record.
			const resource = await ok([
				"retrieve",
				"127.0.0.1",
				"/system/resource",
				...baseArgs,
			]);
			const resourceData = resource.data as Record<string, string> | undefined;
			expect(resourceData).toHaveProperty("version");
			expect(resourceData).toHaveProperty("uptime");
			const version = resourceData?.["version"];
			const boardName = resourceData?.["board-name"];

			// 2. Second singleton.
			const identity = await ok([
				"retrieve",
				"127.0.0.1",
				"/system/identity",
				...baseArgs,
			]);
			expect(identity.data as Record<string, unknown>).toHaveProperty("name");

			// 3. List menu → array.
			const interfaces = await ok([
				"retrieve",
				"127.0.0.1",
				"/interface",
				...baseArgs,
			]);
			expect(Array.isArray(interfaces.data)).toBe(true);
			expect((interfaces.data as unknown[]).length).toBeGreaterThan(0);

			// 4. List, possibly empty.
			const addresses = await ok([
				"retrieve",
				"127.0.0.1",
				"/ip/address",
				...baseArgs,
			]);
			expect(Array.isArray(addresses.data)).toBe(true);

			// 5. Singleton single-attribute → bare value (string over native API).
			const uptime = await ok([
				"retrieve",
				"127.0.0.1",
				"/system/resource",
				"--attribute",
				"uptime",
				...baseArgs,
			]);
			expect(typeof uptime.data).toBe("string");

			// 6. List attribute projection → array of {name,type} only.
			const projected = await ok([
				"retrieve",
				"127.0.0.1",
				"/interface",
				"--attributes",
				"name,type",
				...baseArgs,
			]);
			const rows = projected.data as Array<Record<string, unknown>>;
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				expect(
					Object.keys(row).every((k) => ["name", "type"].includes(k)),
				).toBe(true);
				expect(typeof row["name"]).toBe("string");
			}

			// 7. --all-attributes (native print detail).
			const all = await ok([
				"retrieve",
				"127.0.0.1",
				"/system/resource",
				"--all-attributes",
				...baseArgs,
			]);
			expect(all.data as Record<string, unknown>).toHaveProperty("version");

			// 8. --list-attributes (inspect-only, no data call).
			const attrList = await ok([
				"retrieve",
				"127.0.0.1",
				"/system/resource",
				"--list-attributes",
				...baseArgs,
			]);
			const attrs = attrList.data as unknown[];
			expect(Array.isArray(attrs)).toBe(true);
			expect(attrs).toContain("version");
			expect(attrs).toContain("uptime");

			// 9. Unknown path → validation/unknown-path.
			await fail(
				["retrieve", "127.0.0.1", "/not/a/real/path", ...baseArgs],
				"validation/unknown-path",
			);

			// 10. Unknown attribute → validation/unknown-attribute.
			await fail(
				[
					"retrieve",
					"127.0.0.1",
					"/system/resource",
					"--attribute",
					"bogus-attr",
					...baseArgs,
				],
				"validation/unknown-attribute",
			);

			// 11. Bad credentials → transport/auth-failed.
			await fail(
				[
					"retrieve",
					"127.0.0.1",
					"/system/resource",
					"--via",
					"native-api",
					"--port",
					apiPort,
					"--username",
					"definitely-wrong",
					"--password",
					"definitely-wrong",
				],
				"transport/auth-failed",
			);

			await recordIntegrationEvidence({
				suite: "native API retrieve against CHR",
				command: "retrieve",
				protocol: "native-api",
				routerosVersion:
					typeof version === "string" ? version : chr.state.version,
				boardName: typeof boardName === "string" ? boardName : undefined,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(11),
			});
		} finally {
			capture.restore();
			await chr.destroy();
		}
	}, 300_000);
});
