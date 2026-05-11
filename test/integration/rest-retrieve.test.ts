import { describe, expect, test } from "bun:test";
import { runCli } from "../../src/cli.ts";

function readEnv(
	record: Record<string, string | undefined>,
	key: string,
): string | undefined {
	return record[key];
}

const runFastIntegration =
	readEnv(Bun.env, "CENTRS_RUN_FAST_INTEGRATION") === "1";
const describeFast = runFastIntegration ? describe : describe.skip;

interface QuickChrInstance {
	restUrl: string;
	subprocessEnv(): Promise<Record<string, string>>;
	destroy(): Promise<void>;
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

function splitQuickChrAuth(raw: string): {
	username: string;
	password: string;
} {
	const separator = raw.indexOf(":");
	if (separator === -1) {
		return {
			username: raw,
			password: "",
		};
	}

	return {
		username: raw.slice(0, separator),
		password: raw.slice(separator + 1),
	};
}

async function startQuickChr(
	channel: "stable" | "long-term" | "testing" | "development",
): Promise<QuickChrInstance> {
	const moduleName = "@tikoci/quickchr";
	const quickChrModule = (await import(moduleName)) as unknown as {
		QuickCHR: {
			start(options: {
				channel: "stable" | "long-term" | "testing" | "development";
			}): Promise<QuickChrInstance>;
		};
	};
	return quickChrModule.QuickCHR.start({ channel });
}

describeFast("REST retrieve against CHR", () => {
	test("retrieves /system/resource as JSON", async () => {
		const chr = await startQuickChr(
			(readEnv(Bun.env, "CENTRS_CHR_CHANNEL") as
				| "stable"
				| "long-term"
				| "testing"
				| "development") ?? "stable",
		);
		const consoleCapture = captureConsole();

		try {
			const env = await chr.subprocessEnv();
			const auth = splitQuickChrAuth(readEnv(env, "QUICKCHR_AUTH") ?? "admin:");

			const exitCode = await runCli([
				"retrieve",
				chr.restUrl,
				"/system/resource",
				"--via",
				"rest-api",
				"--format",
				"json",
				"--no-validate",
				"--username",
				auth.username,
				"--password",
				auth.password,
			]);

			expect(exitCode).toBe(0);
			expect(consoleCapture.errors).toHaveLength(0);
			const payload = JSON.parse(consoleCapture.logs[0] ?? "") as {
				ok: boolean;
				result: { data: Record<string, unknown> };
			};
			expect(payload.ok).toBe(true);
			expect(payload.result.data).toHaveProperty("version");
			expect(payload.result.data).toHaveProperty("uptime");
		} finally {
			consoleCapture.restore();
			await chr.destroy();
		}
	}, 180_000);

	test("reports actionable error when host is unreachable", async () => {
		const consoleCapture = captureConsole();

		try {
			const exitCode = await runCli([
				"retrieve",
				"http://127.0.0.1:1",
				"/system/resource",
				"--via",
				"rest-api",
				"--format",
				"json",
				"--no-validate",
				"--username",
				"admin",
				"--password",
				"",
			]);

			expect(exitCode).toBe(1);
			expect(consoleCapture.logs).toHaveLength(0);
			const payload = JSON.parse(consoleCapture.errors[0] ?? "") as {
				error: { code: string; remediation?: string };
			};
			expect(payload.error.code).toBe("transport/connection-refused");
			expect(payload.error.remediation).toContain("REST service");
		} finally {
			consoleCapture.restore();
		}
	});
});
