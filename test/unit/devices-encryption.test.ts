import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildWinBoxCdbEntryRecord,
	decryptWinBoxCdb,
	encodeOpenWinBoxCdb,
	parseWinBoxCdb,
} from "../../src/data/winbox-cdb.ts";
import { encryptCdb, initCdb, loadCdb } from "../../src/index.ts";

const posixModes = process.platform !== "win32";
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});
async function sandbox() {
	const dir = await mkdtemp(join(tmpdir(), "centrs-encryption-"));
	dirs.push(dir);
	return join(dir, "devices.cdb");
}
async function bytes(path: string) {
	return new Uint8Array(await Bun.file(path).arrayBuffer());
}

test("encrypted init requires explicit intent, non-empty password, and 0600; existing files are never converted", async () => {
	const cdbFile = await sandbox();
	for (const cdbPassword of [undefined, ""]) {
		await expect(
			initCdb({ cdbFile, encrypt: true, cdbPassword }),
		).rejects.toMatchObject({ code: "cdb/password-required" });
		expect(await Bun.file(cdbFile).exists()).toBe(false);
	}
	expect(
		(await initCdb({ cdbFile, cdbPassword: "ignored" })).data.encrypted,
	).toBe(false);
	const original = await bytes(cdbFile);
	expect(parseWinBoxCdb(original).mode).toBe("open");
	await expect(
		initCdb({ cdbFile, encrypt: true, cdbPassword: "secret" }),
	).rejects.toMatchObject({ code: "input/invalid-command" });
	expect(await bytes(cdbFile)).toEqual(original);
	await rm(cdbFile);
	const result = await initCdb({
		cdbFile,
		encrypt: true,
		env: { CENTRS_CDB_PASSWORD: "secret" },
	});
	expect(result.data).toMatchObject({ created: true, encrypted: true });
	expect(result.warnings).toEqual([]);
	if (posixModes) {
		expect((await stat(cdbFile)).mode & 0o777).toBe(0o600);
	}
	expect(parseWinBoxCdb(await bytes(cdbFile)).mode).toBe("encrypted");
	await expect(loadCdb({ cdbFile })).rejects.toMatchObject({
		code: "cdb/password-required",
	});
	await expect(
		initCdb({ cdbFile, encrypt: true, cdbPassword: "wrong" }),
	).rejects.toMatchObject({ code: "cdb/decrypt-failed" });
	expect(
		(await initCdb({ cdbFile, encrypt: true, cdbPassword: "secret" })).data,
	).toMatchObject({ created: false, encrypted: true });
	expect(
		(await initCdb({ cdbFile, cdbPassword: "secret" })).data.encrypted,
	).toBe(true);
});

test("concurrent encrypted initialization publishes one complete CDB and cleans temp files", async () => {
	const cdbFile = await sandbox();
	const results = await Promise.all(
		Array.from({ length: 4 }, () =>
			initCdb({ cdbFile, encrypt: true, cdbPassword: "secret" }),
		),
	);
	expect(results.filter((result) => result.data.created)).toHaveLength(1);
	expect((await loadCdb({ cdbFile, cdbPassword: "secret" })).entries).toEqual(
		[],
	);
	expect(await readdir(join(cdbFile, ".."))).toEqual(["devices.cdb"]);
});

test("conversion preserves records and opaque fields, retains plaintext backups, and verifies idempotency", async () => {
	const cdbFile = await sandbox();
	const record = buildWinBoxCdbEntryRecord({
		recordType: 1,
		target: "192.0.2.1",
		user: "reader",
		password: "fixture",
	});
	const original = encodeOpenWinBoxCdb([
		{
			...record,
			fields: [
				...record.fields,
				{
					tag: 100,
					marker: 0,
					tcode: 0x7f,
					value: new Uint8Array([1, 2, 3]),
					rawTail: true,
				},
			],
		},
	]);
	await writeFile(cdbFile, original, { mode: 0o600 });
	for (let i = 0; i < 6; i++)
		await writeFile(`${cdbFile}.bak.old-${i}`, original, { mode: 0o600 });
	const result = await encryptCdb({
		cdbFile,
		env: { CENTRS_CDB_PASSWORD: "secret" },
	});
	expect(result.data).toMatchObject({
		encrypted: true,
		changed: true,
		recordCount: 1,
	});
	expect(result.warnings.map((warning) => warning.code)).toContain(
		"cdb/plaintext-backups",
	);
	expect(result.warnings.map((warning) => warning.code)).not.toContain(
		"cdb/password-not-needed",
	);
	expect(await bytes(result.data.backupPath as string)).toEqual(
		new Uint8Array(original),
	);
	expect(
		(await readdir(join(cdbFile, ".."))).filter((name) =>
			name.includes(".bak."),
		),
	).toHaveLength(7);
	const encrypted = await bytes(cdbFile);
	expect(decryptWinBoxCdb(encrypted, "secret")).toEqual(original);
	if (posixModes) {
		expect((await stat(cdbFile)).mode & 0o777).toBe(0o600);
	}
	await expect(loadCdb({ cdbFile })).rejects.toMatchObject({
		code: "cdb/password-required",
	});
	await expect(
		encryptCdb({ cdbFile, cdbPassword: "wrong" }),
	).rejects.toMatchObject({ code: "cdb/decrypt-failed" });
	expect(
		(await encryptCdb({ cdbFile, cdbPassword: "secret" })).data.changed,
	).toBe(false);
	expect(await bytes(cdbFile)).toEqual(encrypted);
	expect(
		(await loadCdb({ cdbFile, cdbPassword: "secret" })).entries[0]?.password,
	).toBe("fixture");
	expect(JSON.stringify(result)).not.toContain("secret");
});

test("conversion refuses missing and malformed files without creating or replacing them", async () => {
	const cdbFile = await sandbox();
	await expect(
		encryptCdb({ cdbFile, cdbPassword: "secret" }),
	).rejects.toMatchObject({ code: "cdb/not-found" });
	await expect(
		encryptCdb({
			env: { HOME: join(cdbFile, ".."), CENTRS_CDB_PASSWORD: "secret" },
		}),
	).rejects.toMatchObject({ code: "cdb/not-found" });
	await writeFile(cdbFile, "invalid", { mode: 0o600 });
	await expect(
		encryptCdb({ cdbFile, cdbPassword: "secret" }),
	).rejects.toMatchObject({ code: "cdb/parse-failed" });
	expect(await Bun.file(cdbFile).text()).toBe("invalid");
	expect(await readdir(join(cdbFile, ".."))).toEqual(["devices.cdb"]);
});

test("competing encrypted initializers with different passwords fail closed for the loser", async () => {
	const cdbFile = await sandbox();
	const passwords = ["first-secret", "second-secret"];
	const results = await Promise.allSettled(
		passwords.map((cdbPassword) =>
			initCdb({ cdbFile, encrypt: true, cdbPassword }),
		),
	);
	const winner = results.findIndex((result) => result.status === "fulfilled");
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	for (const result of results) {
		if (result.status === "rejected")
			expect(result.reason).toMatchObject({ code: "cdb/decrypt-failed" });
	}
	const loaded = await loadCdb({ cdbFile, cdbPassword: passwords[winner] });
	expect(loaded.encrypted).toBe(true);
	expect(loaded.entries).toEqual([]);
	expect(await readdir(join(cdbFile, ".."))).toEqual(["devices.cdb"]);
});
