import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildWinBoxCdbEntryRecord,
	decryptWinBoxCdb,
	encodeOpenWinBoxCdb,
	encryptWinBoxCdb,
	parseWinBoxCdb,
	type WinBoxCdbField,
	type WinBoxCdbRecord,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";
import {
	listWinBoxCdbBackups,
	WINBOX_CDB_DEFAULT_BACKUP_RETENTION,
	writeWinBoxCdb,
} from "../../src/data/winbox-cdb-write.ts";

// cspell:ignore rawtail cdbwrite

/** A field with an unknown tcode (0x7f) that the decoder must keep verbatim. */
function rawTailField(): WinBoxCdbField {
	return {
		tag: 200,
		marker: 0x00,
		tcode: 0x7f,
		value: Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]),
		rawTail: true,
	};
}

function recordWithRawTail(): WinBoxCdbRecord {
	return buildWinBoxCdbEntryRecord({
		recordType: winBoxCdbRecordType.ipAdmin,
		target: "192.0.2.50",
		user: "admin",
		password: "secret",
		comment: "site=NYC",
		extraFields: [rawTailField()],
	});
}

async function makeTempCdb(records: readonly WinBoxCdbRecord[]): Promise<{
	dir: string;
	path: string;
	cleanup: () => Promise<void>;
}> {
	const dir = await mkdtemp(join(tmpdir(), "centrs-cdbwrite-"));
	const path = join(dir, "winbox.cdb");
	await writeFile(path, encodeOpenWinBoxCdb(records));
	return {
		dir,
		path,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

describe("WinBox CDB atomic write", () => {
	test("round-trips rawTail fields byte-for-byte through parse and encode", () => {
		const original = encodeOpenWinBoxCdb([recordWithRawTail()]);
		const parsed = parseWinBoxCdb(original);
		if (parsed.mode !== "open") {
			throw new Error("Expected open CDB.");
		}
		const rawField = parsed.records[0]?.fields.find((f) => f.rawTail);
		expect(rawField).toBeDefined();
		expect(encodeOpenWinBoxCdb(parsed.records)).toEqual(original);
	});

	test("writes bytes atomically and leaves no temp file behind", async () => {
		const fixture = recordWithRawTail();
		const { dir, path, cleanup } = await makeTempCdb([fixture]);
		try {
			const expected = encodeOpenWinBoxCdb([fixture]);
			const result = await writeWinBoxCdb(path, [fixture]);
			expect(result.path).toBe(path);
			expect(result.byteLength).toBe(expected.length);

			const onDisk = Array.from(await readFile(path));
			expect(onDisk).toEqual(Array.from(expected));

			const names = await readdir(dir);
			expect(names.some((name) => name.includes(".tmp."))).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("snapshots a backup before overwriting and keeps it readable", async () => {
		const fixture = recordWithRawTail();
		const { path, cleanup } = await makeTempCdb([fixture]);
		try {
			const before = Array.from(await readFile(path));
			const mutated = buildWinBoxCdbEntryRecord({
				recordType: winBoxCdbRecordType.ipAdmin,
				target: "192.0.2.50",
				user: "changed",
				password: "secret",
			});
			const result = await writeWinBoxCdb(path, [mutated]);
			expect(result.backupPath).toBeDefined();
			const backup = Array.from(await readFile(result.backupPath as string));
			expect(backup).toEqual(before);
		} finally {
			await cleanup();
		}
	});

	test("skips backup creation when skipBackup is true and target exists", async () => {
		const fixture = recordWithRawTail();
		const { path, cleanup } = await makeTempCdb([fixture]);
		try {
			const beforeBackups = await listWinBoxCdbBackups(path);
			const mutated = buildWinBoxCdbEntryRecord({
				recordType: winBoxCdbRecordType.ipAdmin,
				target: "192.0.2.50",
				user: "changed",
				password: "secret",
			});
			const result = await writeWinBoxCdb(path, [mutated], {
				skipBackup: true,
			});
			expect(result.backupPath).toBeUndefined();
			const afterBackups = await listWinBoxCdbBackups(path);
			expect(afterBackups).toEqual(beforeBackups);
		} finally {
			await cleanup();
		}
	});

	test("retains only the newest backups and prunes older ones", async () => {
		const fixture = recordWithRawTail();
		const { path, cleanup } = await makeTempCdb([fixture]);
		try {
			const retention = WINBOX_CDB_DEFAULT_BACKUP_RETENTION;
			const total = retention + 3;
			for (let i = 0; i < total; i += 1) {
				const now = new Date(Date.UTC(2024, 0, 1, 0, 0, i));
				await writeWinBoxCdb(path, [fixture], { now });
			}
			const backups = await listWinBoxCdbBackups(path);
			expect(backups).toHaveLength(retention);
			// Newest-first ordering: the latest second should survive.
			expect(backups[0]).toContain("2024-01-01T00-00-07");
			expect(backups[backups.length - 1]).toContain("2024-01-01T00-00-03");
		} finally {
			await cleanup();
		}
	});

	test("does not write a backup when the target does not yet exist", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-cdbwrite-"));
		const path = join(dir, "winbox.cdb");
		try {
			const result = await writeWinBoxCdb(path, [recordWithRawTail()]);
			expect(result.backupPath).toBeUndefined();
			const backups = await listWinBoxCdbBackups(path);
			expect(backups).toHaveLength(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("encryptWith wraps the new bytes and round-trips through decrypt", async () => {
		const password = "centrs-test";
		const seed = recordWithRawTail();
		const dir = await mkdtemp(join(tmpdir(), "centrs-cdbwrite-enc-"));
		const path = join(dir, "winbox.cdb");
		try {
			await writeFile(
				path,
				encryptWinBoxCdb(encodeOpenWinBoxCdb([seed]), password),
			);
			const before = await readFile(path);

			const mutated = buildWinBoxCdbEntryRecord({
				recordType: winBoxCdbRecordType.ipAdmin,
				target: "192.0.2.50",
				user: "rotated",
				password: "secret",
				comment: "site=NYC",
			});
			const result = await writeWinBoxCdb(path, [mutated], {
				encryptWith: { password },
			});

			const onDisk = await readFile(path);
			// File is encrypted (different magic byte vs open) and not equal to plaintext.
			expect(onDisk).not.toEqual(encodeOpenWinBoxCdb([mutated]));
			expect(result.byteLength).toBe(onDisk.length);

			const decrypted = decryptWinBoxCdb(onDisk, password);
			const parsed = parseWinBoxCdb(decrypted);
			if (parsed.mode !== "open") {
				throw new Error("Decrypted payload must be open-mode.");
			}
			expect(parsed.records).toHaveLength(1);

			// Backup must be the verbatim prior encrypted bytes.
			expect(result.backupPath).toBeDefined();
			const backup = await readFile(result.backupPath as string);
			expect(backup).toEqual(before);
			// Decrypting the backup yields the original seed records.
			const backupOpen = decryptWinBoxCdb(backup, password);
			expect(backupOpen).toEqual(encodeOpenWinBoxCdb([seed]));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("encryptWith rolls a fresh salt per write but keeps plaintext stable", async () => {
		const password = "centrs-test";
		const record = recordWithRawTail();
		const dir = await mkdtemp(join(tmpdir(), "centrs-cdbwrite-salt-"));
		const path = join(dir, "winbox.cdb");
		try {
			await writeFile(
				path,
				encryptWinBoxCdb(encodeOpenWinBoxCdb([record]), password),
			);
			await writeWinBoxCdb(path, [record], { encryptWith: { password } });
			const firstCipher = await readFile(path);
			await writeWinBoxCdb(path, [record], { encryptWith: { password } });
			const secondCipher = await readFile(path);

			expect(secondCipher).not.toEqual(firstCipher);
			expect(decryptWinBoxCdb(secondCipher, password)).toEqual(
				decryptWinBoxCdb(firstCipher, password),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
