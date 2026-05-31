import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	encryptWinBoxCdb,
	type WinBoxCdbField,
	type WinBoxCdbRecord,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";
import {
	addDevice,
	editDevice,
	type LoadedCdb,
	loadCdb,
	removeDevice,
	setDeviceCommentKv,
	showDevice,
} from "../../src/devices.ts";
import { CentrsError } from "../../src/errors.ts";
import { parseCommentKv } from "../../src/resolver/comment-kv.ts";

// cspell:ignore neteng rawtail keepme

function rawTailField(): WinBoxCdbField {
	return {
		tag: 200,
		marker: 0x00,
		tcode: 0x7f,
		value: Uint8Array.from([0xca, 0xfe, 0xba, 0xbe]),
		rawTail: true,
	};
}

function adminRecord(comment = ""): WinBoxCdbRecord {
	return buildWinBoxCdbEntryRecord({
		recordType: winBoxCdbRecordType.ipAdmin,
		target: "192.0.2.5",
		user: "admin",
		password: "old",
		group: "prod-edge",
		comment,
		extraFields: [rawTailField()],
	});
}

async function tempCdb(records: readonly WinBoxCdbRecord[]): Promise<{
	path: string;
	cleanup: () => Promise<void>;
}> {
	const dir = await mkdtemp(join(tmpdir(), "centrs-mutate-"));
	const path = join(dir, "winbox.cdb");
	await writeFile(path, encodeOpenWinBoxCdb(records));
	return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function reload(path: string): Promise<LoadedCdb> {
	return loadCdb({ cdbFile: path, env: {} });
}

async function catchError(fn: () => Promise<unknown>): Promise<CentrsError> {
	try {
		await fn();
	} catch (error) {
		if (error instanceof CentrsError) {
			return error;
		}
		throw error;
	}
	throw new Error("Expected a CentrsError to be thrown.");
}

describe("devices mutation", () => {
	test("adds a new entry and writes a backup", async () => {
		const { path, cleanup } = await tempCdb([adminRecord()]);
		try {
			const cdb = await reload(path);
			const result = await addDevice({
				cdb,
				target: "198.51.100.10",
				user: "writer",
				password: "secret",
				group: "lab",
			});
			expect(result.ok).toBe(true);
			expect(result.data.action).toBe("add");
			expect(result.data.replaced).toBe(false);
			expect(result.data.backupPath).toBeDefined();

			const after = await reload(path);
			const shown = showDevice({ cdb: after, target: "198.51.100.10" });
			expect(shown.data.entry.user).toBe("writer");
			expect(shown.data.entry.group).toBe("lab");
		} finally {
			await cleanup();
		}
	});

	test("refuses to add an existing target without force and does not mutate", async () => {
		const { path, cleanup } = await tempCdb([adminRecord()]);
		try {
			const cdb = await reload(path);
			const before = await readdir(join(path, ".."));
			const error = await catchError(() =>
				addDevice({ cdb, target: "192.0.2.5", user: "x", password: "y" }),
			);
			expect(error.code).toBe("cdb/already-exists");
			const after = await readdir(join(path, ".."));
			expect(after.sort()).toEqual(before.sort());
		} finally {
			await cleanup();
		}
	});

	test("force-add replaces the entry and preserves unknown fields", async () => {
		const { path, cleanup } = await tempCdb([adminRecord()]);
		try {
			const cdb = await reload(path);
			const result = await addDevice({
				cdb,
				target: "192.0.2.5",
				user: "new",
				password: "new",
				force: true,
			});
			expect(result.data.replaced).toBe(true);
			expect(result.data.preservedUnknownTags).toContain(200);
			expect(result.warnings.some((w) => w.code === "cdb/unknown-field")).toBe(
				true,
			);

			const after = await reload(path);
			const raw = after.entries[0]?.record.fields.find((f) => f.rawTail);
			expect(raw?.tag).toBe(200);
		} finally {
			await cleanup();
		}
	});

	test("edits first-class fields while preserving unknown fields", async () => {
		const { path, cleanup } = await tempCdb([adminRecord("keepme")]);
		try {
			const cdb = await reload(path);
			const result = await editDevice({
				cdb,
				target: "192.0.2.5",
				user: "admin2",
				password: "rotated",
			});
			expect(result.data.action).toBe("edit");
			expect(result.data.preservedUnknownTags).toContain(200);

			const after = await reload(path);
			const entry = showDevice({ cdb: after, target: "192.0.2.5" }).data.entry;
			expect(entry.user).toBe("admin2");
			expect(entry.group).toBe("prod-edge");
			expect(entry.comment).toBe("keepme");
		} finally {
			await cleanup();
		}
	});

	test("edit of a missing target errors with cdb/not-found-target", async () => {
		const { path, cleanup } = await tempCdb([adminRecord()]);
		try {
			const cdb = await reload(path);
			const error = await catchError(() =>
				editDevice({ cdb, target: "203.0.113.1", user: "x" }),
			);
			expect(error.code).toBe("cdb/not-found-target");
		} finally {
			await cleanup();
		}
	});

	test("set writes comment-kv that parses back and preserves free-form text", async () => {
		const { path, cleanup } = await tempCdb([adminRecord("owned by neteng")]);
		try {
			const cdb = await reload(path);
			const result = await setDeviceCommentKv({
				cdb,
				target: "192.0.2.5",
				updates: [
					{ key: "via", value: "ssh" },
					{ key: "validate", value: "false" },
				],
			});
			expect(result.ok).toBe(true);

			const after = await reload(path);
			const entry = showDevice({ cdb: after, target: "192.0.2.5" }).data.entry;
			const kv = parseCommentKv(entry.comment);
			expect(kv.values.via).toBe("ssh");
			expect(kv.values.validate).toBe("false");
			expect(entry.comment).toContain("owned by neteng");
			expect(entry.commentMirror).toBe(entry.comment);
		} finally {
			await cleanup();
		}
	});

	test("set replaces an existing kv value rather than duplicating it", async () => {
		const { path, cleanup } = await tempCdb([
			adminRecord("via=rest-api site=x"),
		]);
		try {
			const cdb = await reload(path);
			await setDeviceCommentKv({
				cdb,
				target: "192.0.2.5",
				updates: [{ key: "via", value: "ssh" }],
			});
			const after = await reload(path);
			const entry = showDevice({ cdb: after, target: "192.0.2.5" }).data.entry;
			expect(entry.comment).toBe("via=ssh site=x");
		} finally {
			await cleanup();
		}
	});

	test("set rejects reserved first-class keys", async () => {
		const { path, cleanup } = await tempCdb([adminRecord()]);
		try {
			const cdb = await reload(path);
			const error = await catchError(() =>
				setDeviceCommentKv({
					cdb,
					target: "192.0.2.5",
					updates: [{ key: "user", value: "hacker" }],
				}),
			);
			expect(error.code).toBe("cdb/reserved-key");
		} finally {
			await cleanup();
		}
	});

	test("set warns on unknown keys but still writes them", async () => {
		const { path, cleanup } = await tempCdb([adminRecord()]);
		try {
			const cdb = await reload(path);
			const result = await setDeviceCommentKv({
				cdb,
				target: "192.0.2.5",
				updates: [{ key: "future", value: "maybe" }],
			});
			expect(result.warnings.some((w) => w.code === "cdb/unknown-option")).toBe(
				true,
			);
			const after = await reload(path);
			const entry = showDevice({ cdb: after, target: "192.0.2.5" }).data.entry;
			expect(entry.comment).toContain("future=maybe");
		} finally {
			await cleanup();
		}
	});

	test("set --strict rejects unknown keys without writing", async () => {
		const { path, cleanup } = await tempCdb([adminRecord()]);
		try {
			const cdb = await reload(path);
			const error = await catchError(() =>
				setDeviceCommentKv({
					cdb,
					target: "192.0.2.5",
					updates: [{ key: "future", value: "maybe" }],
					strict: true,
				}),
			);
			expect(error.code).toBe("cdb/unknown-option");
		} finally {
			await cleanup();
		}
	});

	test("removes an entry and writes a backup", async () => {
		const { path, cleanup } = await tempCdb([adminRecord()]);
		try {
			const cdb = await reload(path);
			const result = await removeDevice({ cdb, target: "192.0.2.5" });
			expect(result.data.action).toBe("remove");
			expect(result.data.backupPath).toBeDefined();

			const after = await reload(path);
			const error = await catchError(async () =>
				showDevice({ cdb: after, target: "192.0.2.5" }),
			);
			expect(error.code).toBe("cdb/not-found-target");
		} finally {
			await cleanup();
		}
	});

	test("remove of a missing target errors with cdb/not-found-target", async () => {
		const { path, cleanup } = await tempCdb([adminRecord()]);
		try {
			const cdb = await reload(path);
			const error = await catchError(() =>
				removeDevice({ cdb, target: "203.0.113.99" }),
			);
			expect(error.code).toBe("cdb/not-found-target");
		} finally {
			await cleanup();
		}
	});

	test("blocks every mutation against an encrypted CDB", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-mutate-enc-"));
		const path = join(dir, "winbox.cdb");
		try {
			const open = encodeOpenWinBoxCdb([adminRecord()]);
			await writeFile(path, encryptWinBoxCdb(open, "centrs-test"));
			const cdb = await loadCdb({
				cdbFile: path,
				cdbPassword: "centrs-test",
				env: {},
			});
			expect(cdb.encrypted).toBe(true);

			const addError = await catchError(() =>
				addDevice({ cdb, target: "198.51.100.20", user: "u", password: "p" }),
			);
			expect(addError.code).toBe("cdb/encrypted-write-unverified");

			const editError = await catchError(() =>
				editDevice({ cdb, target: "192.0.2.5", user: "x" }),
			);
			expect(editError.code).toBe("cdb/encrypted-write-unverified");

			const removeError = await catchError(() =>
				removeDevice({ cdb, target: "192.0.2.5" }),
			);
			expect(removeError.code).toBe("cdb/encrypted-write-unverified");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
