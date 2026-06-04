import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { runCli } from "../../src/cli.ts";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	encryptWinBoxCdb,
	type WinBoxCdbField,
	type WinBoxCdbRecord,
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

function rawTailField(): WinBoxCdbField {
	return {
		tag: 200,
		marker: 0x00,
		tcode: 0x7f,
		value: Uint8Array.from([0xca, 0xfe, 0xba, 0xbe]),
		rawTail: true,
	};
}

function buildUnknownFieldFixtureBytes(): Uint8Array {
	return encodeOpenWinBoxCdb([
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: "192.0.2.5",
			user: "admin",
			password: "secret",
			group: "prod-edge",
			comment: "core router",
			extraFields: [rawTailField()],
		}),
	]);
}

function buildFixtureBytes(): Uint8Array {
	const records: WinBoxCdbRecord[] = [
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
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: "198.51.100.50",
			user: "discovered",
			password: "",
			group: "discovered",
			comment: "source=mndp",
			profile: "<own>",
			savedPassword: false,
		}),
	];
	return encodeOpenWinBoxCdb(records);
}

const ENCRYPTED_PASSWORD = "centrs-test";

// Two entries that share the exact `target` string but differ by record type:
// the same host saved once for admin access and once for user access. Exercises
// `devices show` ambiguity detection (example 5) and `--match` disambiguation
// (example 6).
function buildAmbiguousFixtureBytes(): Uint8Array {
	return encodeOpenWinBoxCdb([
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: "2001:db8::5",
			user: "admin-ip",
			password: "secret",
			group: "prod",
			profile: "<own>",
			savedPassword: true,
		}),
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipUser,
			target: "2001:db8::5",
			user: "ops-ip",
			password: "ops-pw",
			group: "lab",
			profile: "<own>",
			savedPassword: true,
		}),
	]);
}

async function writeAmbiguousFixture(name: string): Promise<string> {
	const dir = join(tempDir, `${name}-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	const path = join(dir, "devices.cdb");
	await writeFile(path, buildAmbiguousFixtureBytes());
	return path;
}

// Records resolvable by their comment lookup keys: an IP record whose MAC rides
// the comment, and a MAC record whose IP rides the comment. Exercises examples
// 32-34 (`identity=`/`mac=`/`ip=` resolution + MAC normalization).
function buildLookupFixtureBytes(): Uint8Array {
	return encodeOpenWinBoxCdb([
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: "192.0.2.60",
			user: "admin",
			password: "secret",
			comment: "edge site identity=edge1 mac=AA:BB:CC:DD:EE:11",
			profile: "<own>",
			savedPassword: true,
		}),
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.macTarget,
			target: "AA:BB:CC:DD:EE:22",
			user: "l2",
			comment: "identity=edge2 ip=192.0.2.61",
			profile: "<own>",
			savedPassword: false,
		}),
	]);
}

// Two distinct hosts sharing identity=dup — the deliberately non-unique identity
// case. Exercises example 35 (`identity/ambiguous` + `--match user=`).
function buildDuplicateIdentityFixtureBytes(): Uint8Array {
	return encodeOpenWinBoxCdb([
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: "10.0.0.1",
			user: "admin",
			password: "a",
			comment: "identity=dup",
			profile: "<own>",
			savedPassword: true,
		}),
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipUser,
			target: "10.0.0.2",
			user: "ops",
			password: "b",
			comment: "identity=dup",
			profile: "<own>",
			savedPassword: true,
		}),
	]);
}

async function writeFixture(name: string, bytes: Uint8Array): Promise<string> {
	const dir = join(tempDir, `${name}-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	const path = join(dir, "devices.cdb");
	await writeFile(path, bytes);
	return path;
}

beforeAll(async () => {
	tempDir = join(
		import.meta.dir,
		"..",
		"..",
		".scratch",
		"devices-integration",
	);
	await rm(tempDir, { recursive: true, force: true });
	await mkdir(tempDir, { recursive: true });
	openCdbPath = join(tempDir, "devices.cdb");
	encryptedCdbPath = join(tempDir, "devices.encrypted.cdb");
	const open = buildFixtureBytes();
	await writeFile(openCdbPath, open);
	const encrypted = encryptWinBoxCdb(open, ENCRYPTED_PASSWORD);
	await writeFile(encryptedCdbPath, encrypted);
});

afterAll(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

async function copyCdbFixture(
	name: string,
	options: { encrypted?: boolean; unknownField?: boolean } = {},
): Promise<string> {
	const safeName = name.replace(/[^A-Za-z0-9_-]/g, "-");
	const dir = join(tempDir, `${safeName}-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	const path = join(
		dir,
		options.encrypted ? "devices.encrypted.cdb" : "devices.cdb",
	);
	if (options.unknownField) {
		await writeFile(path, buildUnknownFieldFixtureBytes());
		return path;
	}
	await copyFile(options.encrypted ? encryptedCdbPath : openCdbPath, path);
	return path;
}

async function listBackups(cdbPath: string): Promise<readonly string[]> {
	const prefix = `${basename(cdbPath)}.bak.`;
	return (await readdir(dirname(cdbPath)))
		.filter((name) => name.startsWith(prefix))
		.sort();
}

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
		expect(envelope.data).toHaveLength(5);
		expect(envelope.data.map((entry) => entry.target)).toEqual([
			"192.0.2.5",
			"192.0.2.6",
			"198.51.100.1",
			"AA:BB:CC:DD:EE:01",
			"198.51.100.50",
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

	test("example 27 list --group unknown returns empty + warning", async () => {
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
			join(tempDir, "centrs-does-not-exist.cdb"),
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

	test("example 5 ambiguous target (non-TTY) errors with identity/ambiguous", async () => {
		const cdbPath = await writeAmbiguousFixture("example-5-ambiguous");
		const result = await runWithCapture([
			"devices",
			"show",
			"2001:db8::5",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		const envelope = JSON.parse(result.stderr) as {
			error: {
				code: string;
				context?: {
					matches?: Array<{
						cdbRecordIndex: number;
						target: string;
						recordType: number;
					}>;
				};
			};
		};
		expect(envelope.error.code).toBe("identity/ambiguous");
		const matches = envelope.error.context?.matches ?? [];
		expect(matches).toHaveLength(2);
		expect(matches.every((entry) => entry.target === "2001:db8::5")).toBe(true);
		expect(matches.map((entry) => entry.recordType).sort()).toEqual([
			winBoxCdbRecordType.ipAdmin,
			winBoxCdbRecordType.ipUser,
		]);
	});

	test("example 6 --match disambiguates by record type", async () => {
		const cdbPath = await writeAmbiguousFixture("example-6-match");
		const result = await runWithCapture([
			"devices",
			"show",
			"2001:db8::5",
			"--cdb-file",
			cdbPath,
			"--match",
			"ipUser",
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			ok: boolean;
			data: { entry: { user: string; recordType: number } };
			meta: { target: { resolvedTarget?: string } };
		};
		expect(envelope.ok).toBe(true);
		expect(envelope.data.entry.recordType).toBe(winBoxCdbRecordType.ipUser);
		expect(envelope.data.entry.user).toBe("ops-ip");
		expect(envelope.meta.target.resolvedTarget).toBe("2001:db8::5");
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
			{ group: "discovered", members: 1 },
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
		expect(envelope.data).toHaveLength(5);
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

	test("example 10 add writes an ipAdmin entry and backup", async () => {
		const cdbPath = await copyCdbFixture("example-10-add");
		const result = await runWithCapture([
			"devices",
			"add",
			"198.51.100.10",
			"--user",
			"admin",
			"--password",
			"secret",
			"--group",
			"prod-edge",
			"--comment",
			"site=NYC via=ssh",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: { action: string; backupPath?: string; entry?: { group: string } };
		};
		expect(envelope.data.action).toBe("add");
		expect(envelope.data.backupPath).toBeDefined();
		expect(await listBackups(cdbPath)).toHaveLength(1);

		const show = await runWithCapture([
			"devices",
			"show",
			"198.51.100.10",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(show.exitCode).toBe(0);
		const shown = JSON.parse(show.stdout) as {
			data: { entry: { user: string; group: string; comment: string } };
		};
		expect(shown.data.entry.user).toBe("admin");
		expect(shown.data.entry.group).toBe("prod-edge");
		expect(shown.data.entry.comment).toContain("site=NYC");
	});

	test("example 11 add same (target, user) without force errors without backup", async () => {
		const cdbPath = await copyCdbFixture("example-11-add-existing");
		const before = await readFile(cdbPath);
		const result = await runWithCapture([
			"devices",
			"add",
			"192.0.2.5",
			"--user",
			"admin",
			"--password",
			"other",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		const envelope = JSON.parse(result.stderr) as { error: { code: string } };
		expect(envelope.error.code).toBe("cdb/already-exists");
		expect(await readFile(cdbPath)).toEqual(before);
		expect(await listBackups(cdbPath)).toEqual([]);
	});

	test("example 12 replace same (target, user) with force preserves unknown fields", async () => {
		const cdbPath = await copyCdbFixture("example-12-force", {
			unknownField: true,
		});
		const result = await runWithCapture([
			"devices",
			"add",
			"192.0.2.5",
			"--user",
			"admin",
			"--password",
			"new",
			"--force",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: {
				replaced: boolean;
				backupPath?: string;
				preservedUnknownTags?: number[];
			};
			warnings: Array<{ code: string; context?: { tags?: number[] } }>;
		};
		expect(envelope.data.replaced).toBe(true);
		expect(envelope.data.backupPath).toBeDefined();
		expect(envelope.data.preservedUnknownTags).toContain(200);
		expect(envelope.warnings.some((w) => w.code === "cdb/unknown-field")).toBe(
			true,
		);
		expect(await listBackups(cdbPath)).toHaveLength(1);
	});

	test("example 13 add encrypted CDB without password requires password", async () => {
		const cdbPath = await copyCdbFixture("example-13-encrypted-no-password", {
			encrypted: true,
		});
		const before = await readFile(cdbPath);
		const result = await runWithCapture([
			"devices",
			"add",
			"198.51.100.20",
			"--user",
			"u",
			"--password",
			"p",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		const envelope = JSON.parse(result.stderr) as { error: { code: string } };
		expect(envelope.error.code).toBe("cdb/password-required");
		expect(await readFile(cdbPath)).toEqual(before);
		expect(await listBackups(cdbPath)).toEqual([]);
	});

	test("example 14 add encrypted CDB with password round-trips through decrypt/encrypt", async () => {
		const cdbPath = await copyCdbFixture("example-14-encrypted-password", {
			encrypted: true,
		});
		const result = await runWithCapture([
			"devices",
			"add",
			"198.51.100.20",
			"--user",
			"u",
			"--password",
			"p",
			"--cdb-file",
			cdbPath,
			"--cdb-password",
			ENCRYPTED_PASSWORD,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: { backupPath?: string };
		};
		expect(envelope.data.backupPath).toBeDefined();
		expect(await listBackups(cdbPath)).toHaveLength(1);

		const show = await runWithCapture([
			"devices",
			"show",
			"198.51.100.20",
			"--cdb-file",
			cdbPath,
			"--cdb-password",
			ENCRYPTED_PASSWORD,
			"--json",
		]);
		expect(show.exitCode).toBe(0);
		const shown = JSON.parse(show.stdout) as {
			data: { entry: { user: string } };
		};
		expect(shown.data.entry.user).toBe("u");
	});

	test("example 15 set credentials preserves other fields and writes backup", async () => {
		const cdbPath = await copyCdbFixture("example-15-set");
		const result = await runWithCapture([
			"devices",
			"set",
			"192.0.2.5",
			"--user",
			"admin2",
			"--password",
			"new",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: { backupPath?: string };
		};
		expect(envelope.data.backupPath).toBeDefined();
		expect(await listBackups(cdbPath)).toHaveLength(1);
		const show = await runWithCapture([
			"devices",
			"show",
			"192.0.2.5",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		const shown = JSON.parse(show.stdout) as {
			data: {
				entry: {
					user: string;
					password: string;
					group: string;
					comment: string;
				};
			};
		};
		expect(shown.data.entry.user).toBe("admin2");
		expect(shown.data.entry.password).toBe("new");
		expect(shown.data.entry.group).toBe("prod-edge");
		expect(shown.data.entry.comment).toBe("core router");
	});

	test("example 16 set a missing target errors without backup", async () => {
		const cdbPath = await copyCdbFixture("example-16-set-unknown");
		const before = await readFile(cdbPath);
		const result = await runWithCapture([
			"devices",
			"set",
			"203.0.113.1",
			"--user",
			"x",
			"--password",
			"y",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		const envelope = JSON.parse(result.stderr) as { error: { code: string } };
		expect(envelope.error.code).toBe("cdb/not-found-target");
		expect(await readFile(cdbPath)).toEqual(before);
		expect(await listBackups(cdbPath)).toEqual([]);
	});

	test("example 17 set recognized overrides affect show provenance", async () => {
		const cdbPath = await copyCdbFixture("example-17-set-via");
		const result = await runWithCapture([
			"devices",
			"set",
			"192.0.2.5",
			"via=ssh",
			"validate=false",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: { backupPath?: string };
		};
		expect(envelope.data.backupPath).toBeDefined();
		expect(await listBackups(cdbPath)).toHaveLength(1);
		const show = await runWithCapture([
			"devices",
			"show",
			"192.0.2.5",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		const shown = JSON.parse(show.stdout) as {
			meta: {
				target: {
					via: string;
					validate: boolean;
					sources?: Record<string, { kind: string }>;
				};
			};
		};
		expect(shown.meta.target.via).toBe("ssh");
		expect(shown.meta.target.validate).toBe(false);
		expect(shown.meta.target.sources?.["via"]?.kind).toBe("comment-kv");
	});

	test("example 18 set reserved key errors without backup", async () => {
		const cdbPath = await copyCdbFixture("example-18-reserved");
		const before = await readFile(cdbPath);
		const result = await runWithCapture([
			"devices",
			"set",
			"192.0.2.5",
			"user=hacker",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		const envelope = JSON.parse(result.stderr) as {
			error: { code: string; cause?: { reservedKeys?: string[] } };
		};
		expect(envelope.error.code).toBe("cdb/reserved-key");
		expect(await readFile(cdbPath)).toEqual(before);
		expect(await listBackups(cdbPath)).toEqual([]);
	});

	test("example 19 set unknown key warns and writes", async () => {
		const cdbPath = await copyCdbFixture("example-19-unknown-lenient");
		const result = await runWithCapture([
			"devices",
			"set",
			"192.0.2.5",
			"future=maybe",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			warnings: Array<{ code: string }>;
		};
		expect(envelope.warnings.some((w) => w.code === "cdb/unknown-option")).toBe(
			true,
		);
		expect(await listBackups(cdbPath)).toHaveLength(1);
		const show = await runWithCapture([
			"devices",
			"show",
			"192.0.2.5",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		const shown = JSON.parse(show.stdout) as {
			data: { entry: { comment: string } };
		};
		expect(shown.data.entry.comment).toContain("future=maybe");
	});

	test("example 20 set unknown key strict rejects without backup", async () => {
		const cdbPath = await copyCdbFixture("example-20-unknown-strict");
		const before = await readFile(cdbPath);
		const result = await runWithCapture([
			"devices",
			"set",
			"192.0.2.5",
			"future=maybe",
			"--strict",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		const envelope = JSON.parse(result.stderr) as { error: { code: string } };
		expect(envelope.error.code).toBe("cdb/unknown-option");
		expect(await readFile(cdbPath)).toEqual(before);
		expect(await listBackups(cdbPath)).toEqual([]);
	});

	test("example 21 set quoted value with spaces round-trips as one token", async () => {
		const cdbPath = await copyCdbFixture("example-21-quoted");
		const result = await runWithCapture([
			"devices",
			"set",
			"192.0.2.5",
			'note="rack 7 row B"',
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		expect(await listBackups(cdbPath)).toHaveLength(1);
		const show = await runWithCapture([
			"devices",
			"show",
			"192.0.2.5",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		const shown = JSON.parse(show.stdout) as {
			data: { entry: { comment: string } };
		};
		expect(shown.data.entry.comment).toContain('note="rack 7 row B"');
		expect(shown.data.entry.comment).not.toContain('note="\\"rack');
	});

	test("example 22 remove deletes entry and writes backup", async () => {
		const cdbPath = await copyCdbFixture("example-22-remove");
		const result = await runWithCapture([
			"devices",
			"remove",
			"192.0.2.5",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: { backupPath?: string };
		};
		expect(envelope.data.backupPath).toBeDefined();
		expect(await listBackups(cdbPath)).toHaveLength(1);
		const show = await runWithCapture([
			"devices",
			"show",
			"192.0.2.5",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(show.exitCode).toBe(1);
		const shown = JSON.parse(show.stderr) as { error: { code: string } };
		expect(shown.error.code).toBe("cdb/not-found-target");
	});

	test("example 23 remove unknown target errors without backup", async () => {
		const cdbPath = await copyCdbFixture("example-23-remove-unknown");
		const before = await readFile(cdbPath);
		const result = await runWithCapture([
			"devices",
			"remove",
			"203.0.113.99",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		const envelope = JSON.parse(result.stderr) as { error: { code: string } };
		expect(envelope.error.code).toBe("cdb/not-found-target");
		expect(await readFile(cdbPath)).toEqual(before);
		expect(await listBackups(cdbPath)).toEqual([]);
	});

	test("example 24 CLI via overrides comment-kv provenance", async () => {
		const cdbPath = await copyCdbFixture("example-24-cli-override");
		await runWithCapture([
			"devices",
			"set",
			"192.0.2.5",
			"via=ssh",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		const result = await runWithCapture([
			"devices",
			"show",
			"192.0.2.5",
			"--via",
			"rest-api",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			warnings: Array<{ code: string }>;
			meta: {
				target: { via: string; sources?: Record<string, { kind: string }> };
			};
		};
		expect(envelope.meta.target.via).toBe("rest-api");
		expect(envelope.meta.target.sources?.["via"]?.kind).toBe("cli");
		expect(
			envelope.warnings.some((w) => w.code === "cdb/override-applied"),
		).toBe(true);
	});

	test("example 25 env via loses to CLI via", async () => {
		const cdbPath = await copyCdbFixture("example-25-env-loses");
		await runWithCapture([
			"devices",
			"set",
			"192.0.2.5",
			"via=ssh",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		const previousVia = Bun.env["CENTRS_VIA"];
		Bun.env["CENTRS_VIA"] = "native-api";
		try {
			const result = await runWithCapture([
				"devices",
				"show",
				"192.0.2.5",
				"--via",
				"rest-api",
				"--cdb-file",
				cdbPath,
				"--json",
			]);
			expect(result.exitCode).toBe(0);
			const envelope = JSON.parse(result.stdout) as {
				meta: {
					target: { via: string; sources?: Record<string, { kind: string }> };
				};
			};
			expect(envelope.meta.target.via).toBe("rest-api");
			expect(envelope.meta.target.sources?.["via"]?.kind).toBe("cli");
		} finally {
			if (previousVia === undefined) {
				delete Bun.env["CENTRS_VIA"];
			} else {
				Bun.env["CENTRS_VIA"] = previousVia;
			}
		}
	});

	test("example 26 group expansion preserves CDB record order", async () => {
		const result = await runWithCapture([
			"devices",
			"list",
			"--group",
			"prod-edge",
			"--cdb-file",
			openCdbPath,
			"--format",
			"json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: Array<{ target: string; cdbRecordIndex: number }>;
		};
		expect(envelope.data.map((entry) => entry.target)).toEqual([
			"192.0.2.5",
			"192.0.2.6",
		]);
		expect(envelope.data.map((entry) => entry.cdbRecordIndex)).toEqual([0, 1]);
	});

	test("example 28 positional plus group dedupe rule is record-index based", async () => {
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
			data: { entry: { target: string; cdbRecordIndex: number } };
			meta: { target: { cdbRecordIndex: number; source?: { kind: string } } };
		};
		expect(envelope.data.entry.target).toBe("192.0.2.5");
		expect(envelope.data.entry.cdbRecordIndex).toBe(0);
		expect(envelope.meta.target.cdbRecordIndex).toBe(0);
		expect(envelope.meta.target.source?.kind).toBe("cdb");
	});

	test("example 31 discovered group reports CDB provenance and MNDP metadata", async () => {
		const result = await runWithCapture([
			"devices",
			"list",
			"--cdb-file",
			openCdbPath,
			"--group",
			"discovered",
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			ok: boolean;
			data: Array<{
				group: string;
				source?: string;
				sources?: Record<string, { kind: string }>;
			}>;
		};
		expect(envelope.ok).toBe(true);
		expect(envelope.data).toHaveLength(1);
		expect(envelope.data[0]?.group).toBe("discovered");
		expect(envelope.data[0]?.source).toBe("mndp");
		expect(envelope.data[0]?.sources?.["target"]?.kind).toBe("cdb");
		expect(envelope.data[0]?.sources?.["source"]?.kind).toBe("comment-kv");
	});

	test("example 32 resolves <router> by the identity= lookup key", async () => {
		const cdbPath = await writeFixture(
			"example-32-identity",
			buildLookupFixtureBytes(),
		);
		const result = await runWithCapture([
			"devices",
			"show",
			"edge1",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			ok: boolean;
			data: { entry: { target: string } };
			meta: { target: { identity?: string } };
		};
		expect(envelope.ok).toBe(true);
		expect(envelope.data.entry.target).toBe("192.0.2.60");
		expect(envelope.meta.target.identity).toBe("edge1");
	});

	test("example 33 resolves by mac= lookup key, normalizing separators/case", async () => {
		const cdbPath = await writeFixture(
			"example-33-mac",
			buildLookupFixtureBytes(),
		);
		const result = await runWithCapture([
			"devices",
			"show",
			"aa-bb-cc-dd-ee-11",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: { entry: { target: string } };
		};
		expect(envelope.data.entry.target).toBe("192.0.2.60");
	});

	test("example 34 resolves by the ip= lookup key", async () => {
		const cdbPath = await writeFixture(
			"example-34-ip",
			buildLookupFixtureBytes(),
		);
		const result = await runWithCapture([
			"devices",
			"show",
			"192.0.2.61",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: { entry: { target: string; user: string } };
			meta: { target: { identity?: string } };
		};
		expect(envelope.data.entry.target).toBe("AA:BB:CC:DD:EE:22");
		expect(envelope.data.entry.user).toBe("l2");
		expect(envelope.meta.target.identity).toBe("edge2");
	});

	test("example 35 duplicated identity= is ambiguous; --match user= pins it", async () => {
		const cdbPath = await writeFixture(
			"example-35-dup-identity",
			buildDuplicateIdentityFixtureBytes(),
		);

		const ambiguous = await runWithCapture([
			"devices",
			"show",
			"dup",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(ambiguous.exitCode).toBe(1);
		const ambiguousEnvelope = JSON.parse(ambiguous.stderr) as {
			error: {
				code: string;
				context?: { matches?: Array<{ user: string }> };
			};
		};
		expect(ambiguousEnvelope.error.code).toBe("identity/ambiguous");
		expect(
			(ambiguousEnvelope.error.context?.matches ?? [])
				.map((entry) => entry.user)
				.sort(),
		).toEqual(["admin", "ops"]);

		const pinned = await runWithCapture([
			"devices",
			"show",
			"dup",
			"--match",
			"user=ops",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(pinned.exitCode).toBe(0);
		const pinnedEnvelope = JSON.parse(pinned.stdout) as {
			data: { entry: { target: string; user: string } };
		};
		expect(pinnedEnvelope.data.entry.target).toBe("10.0.0.2");
		expect(pinnedEnvelope.data.entry.user).toBe("ops");
	});

	test("example 36 same address under a different user coexists", async () => {
		const cdbPath = await copyCdbFixture("example-36-coexist");
		const added = await runWithCapture([
			"devices",
			"add",
			"192.0.2.5",
			"--user",
			"ops",
			"--password",
			"ops-pw",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(added.exitCode).toBe(0);
		const addedEnvelope = JSON.parse(added.stdout) as {
			data: { replaced: boolean };
		};
		expect(addedEnvelope.data.replaced).toBe(false);

		// The bare address now matches two records.
		const ambiguous = await runWithCapture([
			"devices",
			"show",
			"192.0.2.5",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(ambiguous.exitCode).toBe(1);
		const ambiguousEnvelope = JSON.parse(ambiguous.stderr) as {
			error: { code: string };
		};
		expect(ambiguousEnvelope.error.code).toBe("identity/ambiguous");

		const pinned = await runWithCapture([
			"devices",
			"show",
			"192.0.2.5",
			"--match",
			"user=ops",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(pinned.exitCode).toBe(0);
		const pinnedEnvelope = JSON.parse(pinned.stdout) as {
			data: { entry: { user: string } };
		};
		expect(pinnedEnvelope.data.entry.user).toBe("ops");
	});

	test("example 37 edit reports usage/not-implemented", async () => {
		const cdbPath = await copyCdbFixture("example-37-edit");
		const before = await readFile(cdbPath);
		const result = await runWithCapture([
			"devices",
			"edit",
			"192.0.2.5",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		const envelope = JSON.parse(result.stderr) as { error: { code: string } };
		expect(envelope.error.code).toBe("usage/not-implemented");
		expect(await readFile(cdbPath)).toEqual(before);
		expect(await listBackups(cdbPath)).toEqual([]);
	});

	test("example 38 set --profile-none writes the <none> sentinel", async () => {
		const cdbPath = await copyCdbFixture("example-38-profile");
		const result = await runWithCapture([
			"devices",
			"set",
			"192.0.2.5",
			"--profile-none",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const show = await runWithCapture([
			"devices",
			"show",
			"192.0.2.5",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		const shown = JSON.parse(show.stdout) as {
			data: { entry: { profile: string } };
		};
		expect(shown.data.entry.profile).toBe("<none>");
	});

	test("example 39 add accepts bare k=v positionals; reserved keys rejected", async () => {
		const cdbPath = await copyCdbFixture("example-39-add-kv");
		const added = await runWithCapture([
			"devices",
			"add",
			"198.51.100.30",
			"--user",
			"admin",
			"--password",
			"p",
			"identity=spare",
			"via=ssh",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(added.exitCode).toBe(0);

		// The device is now resolvable by its identity= lookup key.
		const show = await runWithCapture([
			"devices",
			"show",
			"spare",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(show.exitCode).toBe(0);
		const shown = JSON.parse(show.stdout) as {
			data: { entry: { target: string; comment: string } };
		};
		expect(shown.data.entry.target).toBe("198.51.100.30");
		expect(shown.data.entry.comment).toContain("via=ssh");

		// A first-class field as a positional is refused.
		const reserved = await runWithCapture([
			"devices",
			"add",
			"198.51.100.31",
			"user=x",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(reserved.exitCode).toBe(1);
		const reservedEnvelope = JSON.parse(reserved.stderr) as {
			error: { code: string };
		};
		expect(reservedEnvelope.error.code).toBe("cdb/reserved-key");
	});

	test("example 40 an empty registry emits tip/no-devices", async () => {
		const cdbPath = await writeFixture(
			"example-40-tips",
			encodeOpenWinBoxCdb([]),
		);
		const result = await runWithCapture([
			"devices",
			"list",
			"--cdb-file",
			cdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: unknown[];
			tips: Array<{ code: string; fix?: string }>;
		};
		expect(envelope.data).toEqual([]);
		const noDevices = envelope.tips.find((t) => t.code === "tip/no-devices");
		expect(noDevices).toBeDefined();
		expect(noDevices?.fix).toBeDefined();

		// Text mode renders the tip under a Tips: footer (lossless vs JSON).
		const text = await runWithCapture([
			"devices",
			"list",
			"--cdb-file",
			cdbPath,
		]);
		expect(text.stdout).toContain("Tips:");
		expect(text.stdout).toContain("tip/no-devices");
	});

	test("example 41 print alias resolves to list (canonical operation)", async () => {
		const result = await runWithCapture([
			"devices",
			"print",
			"--cdb-file",
			openCdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			ok: boolean;
			data: unknown[];
			meta: { operation: { command?: string } };
		};
		expect(envelope.ok).toBe(true);
		expect(envelope.data).toHaveLength(5);
		// The alias resolves silently; the operation reports the canonical verb.
		expect(envelope.meta.operation.command).toBe("list");
	});

	test("example 41 get alias resolves to show", async () => {
		const result = await runWithCapture([
			"devices",
			"get",
			"192.0.2.5",
			"--cdb-file",
			openCdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			data: { entry: { target: string } };
			meta: { operation: { command?: string } };
		};
		expect(envelope.data.entry.target).toBe("192.0.2.5");
		expect(envelope.meta.operation.command).toBe("show");
	});

	test("example 41 rm and delete aliases both resolve to remove", async () => {
		for (const alias of ["rm", "delete"] as const) {
			const cdbPath = await copyCdbFixture(`example-41-${alias}`);
			const result = await runWithCapture([
				"devices",
				alias,
				"192.0.2.5",
				"--cdb-file",
				cdbPath,
				"--json",
			]);
			expect(result.exitCode).toBe(0);
			const envelope = JSON.parse(result.stdout) as {
				data: { action: string; backupPath?: string };
				meta: { operation: { command?: string } };
			};
			expect(envelope.data.action).toBe("remove");
			expect(envelope.meta.operation.command).toBe("remove");
			expect(await listBackups(cdbPath)).toHaveLength(1);
			// The entry is gone afterward regardless of which alias was used.
			const show = await runWithCapture([
				"devices",
				"show",
				"192.0.2.5",
				"--cdb-file",
				cdbPath,
				"--json",
			]);
			expect(show.exitCode).toBe(1);
		}
	});

	test("example 41 an unknown verb still errors with input/invalid-command", async () => {
		const result = await runWithCapture([
			"devices",
			"bogus",
			"--cdb-file",
			openCdbPath,
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		const envelope = JSON.parse(result.stderr) as {
			error: { code: string; summary?: string };
		};
		expect(envelope.error.code).toBe("input/invalid-command");
		expect(envelope.error.summary).toContain("print, get, rm, delete");
	});
});
