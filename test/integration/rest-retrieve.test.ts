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

interface RetrieveSuccessTestEnvelope {
	ok: true;
	data?: unknown;
	meta: {
		via: string;
		target: {
			source?: { kind?: string };
		};
		settings: {
			username?: { kind?: string };
			password?: { kind?: string };
		};
		validation?: { source?: string };
		operation?: {
			auth?: { passwordProvided?: boolean };
		};
	};
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

function withJsonEnvelope(args: readonly string[]): readonly string[] {
	if (args.includes("--json") || args.includes("--format")) {
		return args;
	}
	return [...args, "--json"];
}

async function expectRetrieveSuccess(
	consoleCapture: ConsoleCapture,
	args: readonly string[],
): Promise<RetrieveSuccessTestEnvelope> {
	const result = await runCliCaptured(consoleCapture, withJsonEnvelope(args));
	expect(result.exitCode).toBe(0);
	expect(result.stderr).toHaveLength(0);
	expect(result.stdout).toHaveLength(1);
	const envelope = JSON.parse(
		result.stdout[0] ?? "",
	) as RetrieveSuccessTestEnvelope;
	expect(envelope.ok).toBe(true);
	expect(envelope.meta.via).toBe("rest-api");
	const validation = envelope.meta.validation as
		| { source?: string }
		| undefined;
	expect(validation?.source).toContain("/console/inspect");
	return envelope;
}

async function expectRetrieveFailure(
	consoleCapture: ConsoleCapture,
	args: readonly string[],
	expectedCode: string,
): Promise<RetrieveFailureTestEnvelope> {
	const result = await runCliCaptured(consoleCapture, withJsonEnvelope(args));
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

describeFast("REST retrieve against CHR", () => {
	test("runs active retrieve REST examples against CHR", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		const consoleCapture = captureConsole();

		try {
			const env = started.env;
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
			const resourceData = resourceEnvelope.data as
				| ({ version?: unknown; "board-name"?: unknown } & Record<
						string,
						unknown
				  >)
				| undefined;
			const routerOsVersion = resourceData?.version;
			const boardName = resourceData?.["board-name"];
			expect(resourceData).toHaveProperty("version");
			expect(resourceData).toHaveProperty("uptime");
			await recordIntegrationEvidence({
				suite: "REST retrieve against CHR",
				command: "retrieve",
				protocol: "rest-api",
				routerosVersion:
					typeof routerOsVersion === "string"
						? routerOsVersion
						: chr.state.version,
				boardName: typeof boardName === "string" ? boardName : undefined,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(19),
			});

			const identityEnvelope = await expectRetrieveSuccess(consoleCapture, [
				"retrieve",
				chr.restUrl,
				"/system/identity",
				...baseArgs,
			]);
			expect(
				identityEnvelope.data as Record<string, unknown> | undefined,
			).toHaveProperty("name");

			const addressesEnvelope = await expectRetrieveSuccess(consoleCapture, [
				"retrieve",
				chr.restUrl,
				"/ip/address",
				...baseArgs,
			]);
			expect(Array.isArray(addressesEnvelope.data)).toBe(true);

			const interfacesEnvelope = await expectRetrieveSuccess(consoleCapture, [
				"retrieve",
				chr.restUrl,
				"/interface",
				...baseArgs,
			]);
			const interfaces = interfacesEnvelope.data;
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
			expect(typeof uptimeEnvelope.data).toBe("string");

			const attributeEnvelope = await expectRetrieveSuccess(consoleCapture, [
				"retrieve",
				chr.restUrl,
				"/interface",
				"--attributes",
				"name,type",
				...baseArgs,
			]);
			const projectedInterfaces = attributeEnvelope.data as Array<
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
			const attributes = attributesEnvelope.data as unknown[];
			expect(Array.isArray(attributes)).toBe(true);
			expect(attributes.length).toBeGreaterThan(0);
			expect(
				attributes.every((attribute) => typeof attribute === "string"),
			).toBe(true);
			expect(new Set(attributes).size).toBe(attributes.length);
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
			expect(cdbEnvelope.meta.target.source?.kind).toBe("cdb");
			expect(cdbEnvelope.meta.settings.username?.kind).toBe("cdb");
			expect(cdbEnvelope.meta.settings.password?.kind).toBe("cdb");
			expect(cdbEnvelope.meta.operation?.auth?.passwordProvided).toBe(true);

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
			expect(yamlEnvelope.meta.via).toBe(jsonEnvelope.meta.via);
			expect((yamlEnvelope.data as VersionedData).version).toEqual(
				(jsonEnvelope.data as VersionedData).version,
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
	}, 300_000);

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
				"--json",
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
