import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.ts";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";

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

interface RetrieveSuccessTestEnvelope {
	ok: true;
	via: string;
	target: {
		source?: { kind?: string };
	};
	auth: {
		usernameSource?: { kind?: string };
		passwordSource?: { kind?: string };
		passwordProvided?: boolean;
	};
	validation: { source?: string };
	result: { data?: unknown };
	warnings: Array<{ code?: string }>;
}

interface RetrieveFailureTestEnvelope {
	ok: false;
	error: {
		code?: string;
		context?: {
			availableAttributes?: unknown;
			availableChildren?: unknown;
		};
		details_url?: string;
		remediation?: string;
	};
}

interface VersionedData {
	version?: unknown;
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

type ConsoleCapture = ReturnType<typeof captureConsole>;

async function runCliCaptured(
	consoleCapture: ConsoleCapture,
	args: readonly string[],
): Promise<{ exitCode: number; stdout: string[]; stderr: string[] }> {
	const logsStart = consoleCapture.logs.length;
	const errorsStart = consoleCapture.errors.length;
	const exitCode = await runCli(args);
	return {
		exitCode,
		stdout: consoleCapture.logs.slice(logsStart),
		stderr: consoleCapture.errors.slice(errorsStart),
	};
}

async function expectRetrieveSuccess(
	consoleCapture: ConsoleCapture,
	args: readonly string[],
): Promise<RetrieveSuccessTestEnvelope> {
	const result = await runCliCaptured(consoleCapture, args);
	expect(result.exitCode).toBe(0);
	expect(result.stderr).toHaveLength(0);
	expect(result.stdout).toHaveLength(1);
	const envelope = JSON.parse(
		result.stdout[0] ?? "",
	) as RetrieveSuccessTestEnvelope;
	expect(envelope.ok).toBe(true);
	expect(envelope.via).toBe("rest-api");
	const validation = envelope.validation as { source?: string } | undefined;
	expect(validation?.source).toContain("/console/inspect");
	return envelope;
}

async function expectRetrieveFailure(
	consoleCapture: ConsoleCapture,
	args: readonly string[],
	expectedCode: string,
): Promise<RetrieveFailureTestEnvelope> {
	const result = await runCliCaptured(consoleCapture, args);
	expect(result.exitCode).toBe(1);
	expect(result.stdout).toHaveLength(0);
	expect(result.stderr).toHaveLength(1);
	const envelope = JSON.parse(
		result.stderr[0] ?? "",
	) as RetrieveFailureTestEnvelope;
	expect(envelope.ok).toBe(false);
	expect(envelope.error.code).toBe(expectedCode);
	return envelope;
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

async function writeRetrieveCdb(
	target: string,
	username: string,
	password: string,
): Promise<string> {
	const tempDir = await mkdtemp(join(tmpdir(), "centrs-retrieve-cdb-"));
	const cdbPath = join(tempDir, "winbox.cdb");
	const bytes = encodeOpenWinBoxCdb([
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target,
			user: username,
			password,
			group: "chr",
			comment: "quickchr retrieve fixture",
			profile: "<own>",
			savedPassword: true,
		}),
	]);
	await writeFile(cdbPath, bytes);
	return cdbPath;
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
	test("runs active retrieve REST examples against CHR", async () => {
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
			const baseArgs = [
				"--username",
				auth.username,
				"--password",
				auth.password,
			];

			const resourceEnvelope = await expectRetrieveSuccess(consoleCapture, [
				"retrieve",
				chr.restUrl,
				"/system/resource",
				...baseArgs,
			]);
			expect(
				resourceEnvelope.result.data as Record<string, unknown> | undefined,
			).toHaveProperty("version");
			expect(
				resourceEnvelope.result.data as Record<string, unknown> | undefined,
			).toHaveProperty("uptime");

			const identityEnvelope = await expectRetrieveSuccess(consoleCapture, [
				"retrieve",
				chr.restUrl,
				"/system/identity",
				...baseArgs,
			]);
			expect(
				identityEnvelope.result.data as Record<string, unknown> | undefined,
			).toHaveProperty("name");

			const addressesEnvelope = await expectRetrieveSuccess(consoleCapture, [
				"retrieve",
				chr.restUrl,
				"/ip/address",
				...baseArgs,
			]);
			expect(Array.isArray(addressesEnvelope.result.data)).toBe(true);

			const interfacesEnvelope = await expectRetrieveSuccess(consoleCapture, [
				"retrieve",
				chr.restUrl,
				"/interface",
				...baseArgs,
			]);
			const interfaces = interfacesEnvelope.result.data;
			expect(Array.isArray(interfaces)).toBe(true);
			expect((interfaces as unknown[]).length).toBeGreaterThan(0);

			const uptimeEnvelope = await expectRetrieveSuccess(consoleCapture, [
				"retrieve",
				chr.restUrl,
				"/system/resource",
				"--attribute",
				"uptime",
				...baseArgs,
			]);
			expect(typeof uptimeEnvelope.result.data).toBe("string");

			const attributeEnvelope = await expectRetrieveSuccess(consoleCapture, [
				"retrieve",
				chr.restUrl,
				"/interface",
				"--attributes",
				"name,type",
				...baseArgs,
			]);
			const projectedInterfaces = attributeEnvelope.result.data as Array<
				Record<string, unknown>
			>;
			expect(projectedInterfaces.length).toBeGreaterThan(0);
			for (const row of projectedInterfaces) {
				expect(row).toEqual(
					expect.objectContaining({
						name: expect.any(String),
						type: expect.any(String),
					}),
				);
				expect(
					Object.keys(row).every((key) => ["name", "type"].includes(key)),
				).toBe(true);
			}

			await expectRetrieveSuccess(consoleCapture, [
				"retrieve",
				chr.restUrl,
				"/system/resource",
				"--all-attributes",
				...baseArgs,
			]);

			await expectRetrieveFailure(
				consoleCapture,
				[
					"retrieve",
					chr.restUrl,
					"/system/resource",
					"--attribute",
					"uptime",
					"--all-attributes",
					...baseArgs,
				],
				"usage/conflicting-flags",
			);

			const attributesEnvelope = await expectRetrieveSuccess(consoleCapture, [
				"retrieve",
				chr.restUrl,
				"/system/resource",
				"--list-attributes",
				...baseArgs,
			]);
			const attributes = attributesEnvelope.result.data as unknown[];
			expect(Array.isArray(attributes)).toBe(true);
			expect(attributes).toContain("uptime");
			expect(attributes).toContain("version");

			const unknownPathEnvelope = await expectRetrieveFailure(
				consoleCapture,
				["retrieve", chr.restUrl, "/not/a/real/path", ...baseArgs],
				"validation/unknown-path",
			);
			const unknownPathContext = unknownPathEnvelope.error.context;
			expect(unknownPathContext?.availableChildren).toBeDefined();

			const unknownAttributeEnvelope = await expectRetrieveFailure(
				consoleCapture,
				[
					"retrieve",
					chr.restUrl,
					"/system/resource",
					"--attribute",
					"bogus",
					...baseArgs,
				],
				"validation/unknown-attribute",
			);
			const unknownAttributeContext = unknownAttributeEnvelope.error.context;
			expect(unknownAttributeContext?.availableAttributes).toContain("uptime");

			const authFailureEnvelope = await expectRetrieveFailure(
				consoleCapture,
				[
					"retrieve",
					chr.restUrl,
					"/system/resource",
					"--username",
					"wrong",
					"--password",
					"wrong",
				],
				"transport/auth-failed",
			);
			expect(authFailureEnvelope.error.details_url).toContain(
				"/transport/auth-failed",
			);

			const cdbPath = await writeRetrieveCdb(
				chr.restUrl,
				auth.username,
				auth.password,
			);
			const cdbEnvelope = await expectRetrieveSuccess(consoleCapture, [
				"retrieve",
				chr.restUrl,
				"/system/resource",
				"--cdb-file",
				cdbPath,
			]);
			expect(cdbEnvelope.target.source?.kind).toBe("cdb");
			expect(cdbEnvelope.auth.usernameSource?.kind).toBe("cdb");
			expect(cdbEnvelope.auth.passwordSource?.kind).toBe("cdb");
			expect(cdbEnvelope.auth.passwordProvided).toBe(true);

			const unusedPasswordEnvelope = await expectRetrieveSuccess(
				consoleCapture,
				[
					"retrieve",
					chr.restUrl,
					"/system/resource",
					"--cdb-file",
					cdbPath,
					"--cdb-password",
					"ignored",
				],
			);
			expect(
				unusedPasswordEnvelope.warnings.map((warning) => warning.code),
			).toContain("cdb/password-not-needed");

			await expectRetrieveFailure(
				consoleCapture,
				[
					"retrieve",
					chr.restUrl,
					"/system/resource",
					"--via",
					"rest-api",
					"--timeout",
					"70000",
					...baseArgs,
				],
				"usage/timeout-out-of-range",
			);

			const jsonEnvelope = await expectRetrieveSuccess(consoleCapture, [
				"retrieve",
				chr.restUrl,
				"/system/resource",
				...baseArgs,
			]);
			const yamlResult = await runCliCaptured(consoleCapture, [
				"retrieve",
				chr.restUrl,
				"/system/resource",
				"--format",
				"yaml",
				...baseArgs,
			]);
			expect(yamlResult.exitCode).toBe(0);
			expect(yamlResult.stderr).toHaveLength(0);
			const yamlEnvelope = Bun.YAML.parse(
				yamlResult.stdout[0] ?? "",
			) as RetrieveSuccessTestEnvelope;
			expect(yamlEnvelope.ok).toBe(jsonEnvelope.ok);
			expect(yamlEnvelope.via).toBe(jsonEnvelope.via);
			expect((yamlEnvelope.result.data as VersionedData).version).toEqual(
				(jsonEnvelope.result.data as VersionedData).version,
			);

			await expectRetrieveFailure(
				consoleCapture,
				[
					"retrieve",
					chr.restUrl,
					"/ip/address",
					"--query",
					'address~"192"',
					...baseArgs,
				],
				"validation/not-implemented",
			);
			await expectRetrieveFailure(
				consoleCapture,
				[
					"retrieve",
					chr.restUrl,
					"/ip/address",
					"--filter",
					"disabled=no",
					...baseArgs,
				],
				"validation/not-implemented",
			);
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
