import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.ts";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	encryptWinBoxCdb,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";

interface CapturedOutput {
	logs: string[];
	errors: string[];
	restore(): void;
}

function captureConsole(): CapturedOutput {
	const originalLog = console.log;
	const originalError = console.error;
	const logs: string[] = [];
	const errors: string[] = [];
	console.log = ((...args: unknown[]) => {
		logs.push(args.map((arg) => String(arg)).join(" "));
	}) as typeof console.log;
	console.error = ((...args: unknown[]) => {
		errors.push(args.map((arg) => String(arg)).join(" "));
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

async function runWithCapture(args: readonly string[]): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
}> {
	const capture = captureConsole();
	try {
		const exitCode = await runCli(args);
		return {
			exitCode,
			stdout: capture.logs.join("\n"),
			stderr: capture.errors.join("\n"),
		};
	} finally {
		capture.restore();
	}
}

let tempDir: string;
let openCdbPath: string;
let encryptedCdbPath: string;

function buildFixtureBytes(): Uint8Array {
	const records = [
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: "192.0.2.5",
			user: "admin",
			password: "secret",
			group: "prod-edge",
			comment: "core router",
			profile: "<own>",
			savedPassword: true,
		}),
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: "192.0.2.6",
			user: "admin",
			password: "secret",
			group: "prod-edge",
			comment: "edge router",
			profile: "<own>",
			savedPassword: true,
		}),
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipUser,
			target: "198.51.100.1",
			user: "ops",
			password: "ops-pw",
			group: "lab",
			comment: "lab device",
			profile: "<own>",
			savedPassword: true,
		}),
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.macTarget,
			target: "AA:BB:CC:DD:EE:01",
			user: "mac-only",
			comment: "mac-reached",
			profile: "<own>",
			savedPassword: false,
		}),
	];
	return encodeOpenWinBoxCdb(records);
}

const ENCRYPTED_PASSWORD = "centrs-test";

beforeAll(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "centrs-devices-"));
	openCdbPath = join(tempDir, "devices.cdb");
	encryptedCdbPath = join(tempDir, "devices.encrypted.cdb");
	const open = buildFixtureBytes();
	await writeFile(openCdbPath, open);
	const encrypted = encryptWinBoxCdb(open, ENCRYPTED_PASSWORD);
	await writeFile(encryptedCdbPath, encrypted);
});

describe("centrs devices (read-only)", () => {
	test("list returns all entries with no warnings", async () => {
		const result = await runWithCapture([
			"devices",
			"list",
			"--cdb-file",
			openCdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			ok: boolean;
			data: Array<{ target: string; group: string; user: string }>;
			warnings: unknown[];
			meta: { operation: { cdbFile: string } };
		};
		expect(envelope.ok).toBe(true);
		expect(envelope.data).toHaveLength(4);
		expect(envelope.data.map((entry) => entry.target)).toEqual([
			"192.0.2.5",
			"192.0.2.6",
			"198.51.100.1",
			"AA:BB:CC:DD:EE:01",
		]);
		expect(envelope.warnings).toEqual([]);
		expect(envelope.meta.operation.cdbFile).toBe(openCdbPath);
	});

	test("list --group filters to that group", async () => {
		const result = await runWithCapture([
			"devices",
			"list",
			"--cdb-file",
			openCdbPath,
			"--group",
			"prod-edge",
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: Array<{ target: string; group: string }>;
		};
		expect(envelope.data.map((entry) => entry.target)).toEqual([
			"192.0.2.5",
			"192.0.2.6",
		]);
	});

	test("list --group unknown returns empty + warning", async () => {
		const result = await runWithCapture([
			"devices",
			"list",
			"--cdb-file",
			openCdbPath,
			"--group",
			"does-not-exist",
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			ok: boolean;
			data: unknown[];
			warnings: Array<{ code: string }>;
		};
		expect(envelope.ok).toBe(true);
		expect(envelope.data).toEqual([]);
		expect(envelope.warnings.some((w) => w.code === "cdb/empty-group")).toBe(
			true,
		);
	});

	test("list against missing CDB errors with cdb/not-found", async () => {
		const result = await runWithCapture([
			"devices",
			"list",
			"--cdb-file",
			"/tmp/centrs-does-not-exist.cdb",
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		const envelope = JSON.parse(result.stderr) as {
			ok: boolean;
			error: { code: string; detailsUrl: string };
		};
		expect(envelope.ok).toBe(false);
		expect(envelope.error.code).toBe("cdb/not-found");
		expect(envelope.error.detailsUrl).toBe(
			"https://tikoci.github.io/centrs/errors/cdb/not-found",
		);
	});

	test("show by exact target returns single entry", async () => {
		const result = await runWithCapture([
			"devices",
			"show",
			"192.0.2.5",
			"--cdb-file",
			openCdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			ok: boolean;
			data: {
				entry: { target: string; user: string; cdbRecordIndex: number };
			};
		};
		expect(envelope.ok).toBe(true);
		expect(envelope.data.entry.target).toBe("192.0.2.5");
		expect(envelope.data.entry.user).toBe("admin");
		expect(envelope.data.entry.cdbRecordIndex).toBe(0);
	});

	test("show --explain includes the raw record", async () => {
		const result = await runWithCapture([
			"devices",
			"show",
			"192.0.2.5",
			"--cdb-file",
			openCdbPath,
			"--explain",
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: {
				record?: { fields: Array<{ tag: number; tcode: number }> };
			};
		};
		expect(envelope.data.record).toBeDefined();
		expect(envelope.data.record?.fields.some((field) => field.tag === 1)).toBe(
			true,
		);
	});

	test("show unknown target errors with cdb/not-found-target", async () => {
		const result = await runWithCapture([
			"devices",
			"show",
			"203.0.113.99",
			"--cdb-file",
			openCdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		const envelope = JSON.parse(result.stderr) as {
			error: { code: string };
		};
		expect(envelope.error.code).toBe("cdb/not-found-target");
	});

	test("groups lists distinct non-empty groups", async () => {
		const result = await runWithCapture([
			"devices",
			"groups",
			"--cdb-file",
			openCdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: Array<{ group: string; members: number }>;
		};
		expect(envelope.data).toEqual([
			{ group: "lab", members: 1 },
			{ group: "prod-edge", members: 2 },
		]);
	});

	test("groups --members expands membership", async () => {
		const result = await runWithCapture([
			"devices",
			"groups",
			"--cdb-file",
			openCdbPath,
			"--members",
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: Array<{
				group: string;
				memberEntries: Array<{ target: string }>;
			}>;
		};
		const prod = envelope.data.find((entry) => entry.group === "prod-edge");
		expect(prod?.memberEntries?.map((m) => m.target)).toEqual([
			"192.0.2.5",
			"192.0.2.6",
		]);
	});

	test("encrypted CDB without password errors with cdb/password-required", async () => {
		const result = await runWithCapture([
			"devices",
			"list",
			"--cdb-file",
			encryptedCdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		const envelope = JSON.parse(result.stderr) as {
			error: { code: string };
		};
		expect(envelope.error.code).toBe("cdb/password-required");
	});

	test("encrypted CDB with correct password reads through", async () => {
		const result = await runWithCapture([
			"devices",
			"list",
			"--cdb-file",
			encryptedCdbPath,
			"--cdb-password",
			ENCRYPTED_PASSWORD,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: Array<{ target: string }>;
		};
		expect(envelope.data).toHaveLength(4);
	});

	test("encrypted CDB with wrong password errors with cdb/decrypt-failed", async () => {
		const result = await runWithCapture([
			"devices",
			"list",
			"--cdb-file",
			encryptedCdbPath,
			"--cdb-password",
			"wrong",
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		const envelope = JSON.parse(result.stderr) as {
			error: { code: string };
		};
		expect(envelope.error.code).toBe("cdb/decrypt-failed");
	});

	test("open CDB with cdb-password emits the password-not-needed warning", async () => {
		const result = await runWithCapture([
			"devices",
			"list",
			"--cdb-file",
			openCdbPath,
			"--cdb-password",
			"unused",
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			warnings: Array<{ code: string }>;
		};
		expect(
			envelope.warnings.some((w) => w.code === "cdb/password-not-needed"),
		).toBe(true);
	});
});
