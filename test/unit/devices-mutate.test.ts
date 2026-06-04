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
	winBoxCdbFieldTag,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";
import {
	addDevice,
	type LoadedCdb,
	listDevices,
	loadCdb,
	removeDevice,
	setDevice,
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

// A record that stores a password but does NOT set the saved-password flag, and
// carries a romon-agent (a first-class known field). Exercises the edit path's
// flag/romon-agent preservation.
function unsavedPasswordRecord(): WinBoxCdbRecord {
	return buildWinBoxCdbEntryRecord({
		recordType: winBoxCdbRecordType.ipAdmin,
		target: "192.0.2.9",
		user: "admin",
		password: "stored-secret",
		romonAgent: "ether1",
		comment: "note",
		savedPassword: false,
	});
}

// A non-ipAdmin record with a deliberately minimal/non-canonical field layout,
// to prove edits preserve the on-disk field order instead of reshaping it to the
// ipAdmin canonical order.
function romonRecordWithLayout(): WinBoxCdbRecord {
	return buildWinBoxCdbEntryRecord({
		recordType: winBoxCdbRecordType.romonTarget,
		target: "AA:BB:CC:DD:EE:FF",
		user: "svc",
		comment: "romon-note",
		fieldOrder: [
			winBoxCdbFieldTag.recordType,
			winBoxCdbFieldTag.comment,
			winBoxCdbFieldTag.user,
		],
	});
}

// A record whose on-disk layout has NO comment/commentMirror field — common for
// WinBox-authored entries with no Note. Exercises the set path appending the
// comment tag it writes so the kv-soup is not silently dropped.
function noCommentRecord(): WinBoxCdbRecord {
	return buildWinBoxCdbEntryRecord({
		recordType: winBoxCdbRecordType.ipAdmin,
		target: "192.0.2.7",
		user: "admin",
		password: "old",
		fieldOrder: [
			winBoxCdbFieldTag.recordType,
			winBoxCdbFieldTag.user,
			winBoxCdbFieldTag.password,
		],
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

	test("refuses to add the same (target, user) without force and does not mutate", async () => {
		const { path, cleanup } = await tempCdb([adminRecord()]);
		try {
			const cdb = await reload(path);
			const before = await readdir(join(path, ".."));
			const error = await catchError(() =>
				addDevice({ cdb, target: "192.0.2.5", user: "admin", password: "y" }),
			);
			expect(error.code).toBe("cdb/already-exists");
			const after = await readdir(join(path, ".."));
			expect(after.sort()).toEqual(before.sort());
		} finally {
			await cleanup();
		}
	});

	test("the same target under a different user is a new record, not a collision", async () => {
		const { path, cleanup } = await tempCdb([adminRecord()]);
		try {
			const cdb = await reload(path);
			const result = await addDevice({
				cdb,
				target: "192.0.2.5",
				user: "ops",
				password: "ops-pw",
			});
			expect(result.ok).toBe(true);
			expect(result.data.replaced).toBe(false);

			const after = await reload(path);
			// Both records now share the target; the bare address is ambiguous and
			// --match user= pins each.
			expect(
				after.entries.filter((entry) => entry.target === "192.0.2.5"),
			).toHaveLength(2);
			const ambiguous = await catchError(async () =>
				showDevice({ cdb: after, target: "192.0.2.5" }),
			);
			expect(ambiguous.code).toBe("identity/ambiguous");
			const ops = showDevice({
				cdb: after,
				target: "192.0.2.5",
				match: "user=ops",
			});
			expect(ops.data.entry.user).toBe("ops");
		} finally {
			await cleanup();
		}
	});

	test("force-add replaces the same (target, user) and preserves unknown fields", async () => {
		const { path, cleanup } = await tempCdb([adminRecord()]);
		try {
			const cdb = await reload(path);
			const result = await addDevice({
				cdb,
				target: "192.0.2.5",
				user: "admin",
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
			const result = await setDevice({
				cdb,
				target: "192.0.2.5",
				user: "admin2",
				password: "rotated",
			});
			expect(result.data.action).toBe("set");
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
				setDevice({ cdb, target: "203.0.113.1", user: "x" }),
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
			const result = await setDevice({
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
			await setDevice({
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

	test("set on a record with no comment field round-trips the comment", async () => {
		const { path, cleanup } = await tempCdb([noCommentRecord()]);
		try {
			const cdb = await reload(path);
			const result = await setDevice({
				cdb,
				target: "192.0.2.7",
				updates: [{ key: "env", value: "prod" }],
			});
			expect(result.ok).toBe(true);

			const after = await reload(path);
			const entry = showDevice({ cdb: after, target: "192.0.2.7" }).data.entry;
			expect(entry.comment).toContain("env=prod");
			expect(entry.commentMirror).toBe(entry.comment);
		} finally {
			await cleanup();
		}
	});

	test("set rejects reserved first-class keys", async () => {
		const { path, cleanup } = await tempCdb([adminRecord()]);
		try {
			const cdb = await reload(path);
			const error = await catchError(() =>
				setDevice({
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
			const result = await setDevice({
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
				setDevice({
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

	test("set comment-kv preserves the saved-password flag, password, and romon-agent", async () => {
		const { path, cleanup } = await tempCdb([unsavedPasswordRecord()]);
		try {
			const cdb = await reload(path);
			const before = showDevice({ cdb, target: "192.0.2.9" }).data.entry;
			expect(before.savedPassword).toBe(false);
			expect(before.romonAgent).toBe("ether1");

			await setDevice({
				cdb,
				target: "192.0.2.9",
				updates: [{ key: "via", value: "ssh" }],
			});
			const after = await reload(path);
			const entry = showDevice({ cdb: after, target: "192.0.2.9" }).data.entry;
			// A comment-kv-only set must not flip the saved-password flag or drop a
			// stored password / known field (romon-agent).
			expect(entry.savedPassword).toBe(false);
			expect(entry.password).toBe("stored-secret");
			expect(entry.romonAgent).toBe("ether1");
			expect(entry.comment).toContain("via=ssh");
		} finally {
			await cleanup();
		}
	});

	test("editing the password re-derives the saved-password flag", async () => {
		const { path, cleanup } = await tempCdb([unsavedPasswordRecord()]);
		try {
			const cdb = await reload(path);
			await setDevice({ cdb, target: "192.0.2.9", password: "fresh-secret" });
			const after = await reload(path);
			const entry = showDevice({ cdb: after, target: "192.0.2.9" }).data.entry;
			expect(entry.savedPassword).toBe(true);
			expect(entry.password).toBe("fresh-secret");
		} finally {
			await cleanup();
		}
	});

	test("a field set on a non-ipAdmin record preserves its field layout", async () => {
		const { path, cleanup } = await tempCdb([romonRecordWithLayout()]);
		try {
			const cdb = await reload(path);
			const priorTags = (cdb.entries[0]?.record.fields ?? [])
				.filter((field) => field.rawTail !== true)
				.map((field) => field.tag);
			await setDevice({
				cdb,
				target: "AA:BB:CC:DD:EE:FF",
				user: "svc2",
			});
			const after = await reload(path);
			const afterTags = (after.entries[0]?.record.fields ?? [])
				.filter((field) => field.rawTail !== true)
				.map((field) => field.tag);
			// #11: the set must not reshape a non-ipAdmin record to the ipAdmin
			// canonical layout.
			expect(afterTags).toEqual(priorTags);
			const entry = showDevice({
				cdb: after,
				target: "AA:BB:CC:DD:EE:FF",
			}).data.entry;
			expect(entry.user).toBe("svc2");
			expect(entry.comment).toBe("romon-note");
		} finally {
			await cleanup();
		}
	});

	test("round-trips add/edit/remove through an encrypted CDB", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-mutate-enc-"));
		const path = join(dir, "winbox.cdb");
		try {
			const open = encodeOpenWinBoxCdb([adminRecord()]);
			await writeFile(path, encryptWinBoxCdb(open, "centrs-test"));
			let cdb = await loadCdb({
				cdbFile: path,
				cdbPassword: "centrs-test",
				env: {},
			});
			expect(cdb.encrypted).toBe(true);

			const addResult = await addDevice({
				cdb,
				target: "198.51.100.20",
				user: "u",
				password: "p",
			});
			expect(addResult.ok).toBe(true);

			cdb = await loadCdb({
				cdbFile: path,
				cdbPassword: "centrs-test",
				env: {},
			});
			expect(cdb.encrypted).toBe(true);
			expect(
				cdb.entries.some((entry) => entry.target === "198.51.100.20"),
			).toBe(true);

			const editResult = await setDevice({
				cdb,
				target: "192.0.2.5",
				user: "rotated",
			});
			expect(editResult.ok).toBe(true);

			cdb = await loadCdb({
				cdbFile: path,
				cdbPassword: "centrs-test",
				env: {},
			});
			expect(showDevice({ cdb, target: "192.0.2.5" }).data.entry.user).toBe(
				"rotated",
			);

			const removeResult = await removeDevice({
				cdb,
				target: "192.0.2.5",
			});
			expect(removeResult.ok).toBe(true);

			cdb = await loadCdb({
				cdbFile: path,
				cdbPassword: "centrs-test",
				env: {},
			});
			expect(cdb.entries.some((entry) => entry.target === "192.0.2.5")).toBe(
				false,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

function dupTargetRecords(): readonly WinBoxCdbRecord[] {
	return [
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: "2001:db8::5",
			user: "admin-ip",
			password: "secret",
			group: "prod",
		}),
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipUser,
			target: "2001:db8::5",
			user: "ops-ip",
			password: "ops-pw",
			group: "lab",
		}),
	];
}

describe("showDevice --match disambiguation", () => {
	test("duplicate targets without --match are identity/ambiguous", async () => {
		const { path, cleanup } = await tempCdb(dupTargetRecords());
		try {
			const cdb = await reload(path);
			const error = await catchError(async () =>
				showDevice({ cdb, target: "2001:db8::5" }),
			);
			expect(error.code).toBe("identity/ambiguous");
			const matches = (error.context?.["matches"] ?? []) as Array<{
				cdbRecordIndex: number;
				target: string;
				recordType: number;
			}>;
			expect(matches).toHaveLength(2);
			expect(matches.map((entry) => entry.recordType).sort()).toEqual([
				winBoxCdbRecordType.ipAdmin,
				winBoxCdbRecordType.ipUser,
			]);
		} finally {
			await cleanup();
		}
	});

	test("--match selects the entry with the named record type", async () => {
		const { path, cleanup } = await tempCdb(dupTargetRecords());
		try {
			const cdb = await reload(path);
			const result = showDevice({
				cdb,
				target: "2001:db8::5",
				match: "ipUser",
			});
			expect(result.ok).toBe(true);
			expect(result.data.entry.recordType).toBe(winBoxCdbRecordType.ipUser);
			expect(result.data.entry.user).toBe("ops-ip");
			expect(result.meta.target.resolvedTarget).toBe("2001:db8::5");

			const admin = showDevice({
				cdb,
				target: "2001:db8::5",
				match: "ipAdmin",
			});
			expect(admin.data.entry.recordType).toBe(winBoxCdbRecordType.ipAdmin);
			expect(admin.data.entry.user).toBe("admin-ip");
		} finally {
			await cleanup();
		}
	});

	test("--match with an unknown record type errors with input/invalid-match", async () => {
		const { path, cleanup } = await tempCdb(dupTargetRecords());
		try {
			const cdb = await reload(path);
			const error = await catchError(async () =>
				showDevice({ cdb, target: "2001:db8::5", match: "bogus" }),
			);
			expect(error.code).toBe("input/invalid-match");
		} finally {
			await cleanup();
		}
	});

	test("--match for an absent record type errors with identity/no-match", async () => {
		const { path, cleanup } = await tempCdb(dupTargetRecords());
		try {
			const cdb = await reload(path);
			const error = await catchError(async () =>
				showDevice({ cdb, target: "2001:db8::5", match: "macTarget" }),
			);
			expect(error.code).toBe("identity/no-match");
		} finally {
			await cleanup();
		}
	});
});

// Two records resolvable by their comment lookup keys: A carries identity=/mac=
// where the MAC is not its target; B carries identity=/ip= and a MAC target.
function lookupKeyRecords(): WinBoxCdbRecord[] {
	return [
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: "192.0.2.50",
			user: "admin",
			password: "secret",
			comment: "edge site identity=edge1 mac=AA:BB:CC:DD:EE:11",
		}),
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.macTarget,
			target: "AA:BB:CC:DD:EE:22",
			user: "l2",
			comment: "identity=edge2 ip=192.0.2.51",
		}),
	];
}

describe("showDevice lookup-key resolution", () => {
	test("resolves <router> by the identity= lookup key", async () => {
		const { path, cleanup } = await tempCdb(lookupKeyRecords());
		try {
			const cdb = await reload(path);
			const result = showDevice({ cdb, target: "edge1" });
			expect(result.ok).toBe(true);
			expect(result.data.entry.target).toBe("192.0.2.50");
			expect(result.meta.target.identity).toBe("edge1");
		} finally {
			await cleanup();
		}
	});

	test("resolves by mac= lookup key, normalizing separators and case", async () => {
		const { path, cleanup } = await tempCdb(lookupKeyRecords());
		try {
			const cdb = await reload(path);
			const result = showDevice({ cdb, target: "aa-bb-cc-dd-ee-11" });
			expect(result.data.entry.target).toBe("192.0.2.50");
		} finally {
			await cleanup();
		}
	});

	test("resolves by ip= lookup key", async () => {
		const { path, cleanup } = await tempCdb(lookupKeyRecords());
		try {
			const cdb = await reload(path);
			const result = showDevice({ cdb, target: "192.0.2.51" });
			expect(result.data.entry.target).toBe("AA:BB:CC:DD:EE:22");
			expect(result.meta.target.identity).toBe("edge2");
		} finally {
			await cleanup();
		}
	});

	test("matches a MAC target regardless of separator/case", async () => {
		const { path, cleanup } = await tempCdb(lookupKeyRecords());
		try {
			const cdb = await reload(path);
			const result = showDevice({ cdb, target: "aa:bb:cc:dd:ee:22" });
			expect(result.data.entry.user).toBe("l2");
		} finally {
			await cleanup();
		}
	});
});

// Two distinct hosts sharing the same identity= handle — the deliberately
// non-unique identity case from the constitution. Resolving the bare handle is
// ambiguous; --match user=/target= pins the choice.
function duplicateIdentityRecords(): WinBoxCdbRecord[] {
	return [
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: "10.0.0.1",
			user: "admin",
			password: "a",
			comment: "identity=dup",
		}),
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipUser,
			target: "10.0.0.2",
			user: "ops",
			password: "b",
			comment: "identity=dup",
		}),
	];
}

describe("showDevice duplicate identity= disambiguation", () => {
	test("a duplicated identity= is identity/ambiguous with user in the match list", async () => {
		const { path, cleanup } = await tempCdb(duplicateIdentityRecords());
		try {
			const cdb = await reload(path);
			const error = await catchError(async () =>
				showDevice({ cdb, target: "dup" }),
			);
			expect(error.code).toBe("identity/ambiguous");
			const matches = (error.context?.["matches"] ?? []) as Array<{
				user: string;
			}>;
			expect(matches.map((entry) => entry.user).sort()).toEqual([
				"admin",
				"ops",
			]);
		} finally {
			await cleanup();
		}
	});

	test("--match user= selects among a duplicated identity=", async () => {
		const { path, cleanup } = await tempCdb(duplicateIdentityRecords());
		try {
			const cdb = await reload(path);
			const result = showDevice({ cdb, target: "dup", match: "user=ops" });
			expect(result.data.entry.target).toBe("10.0.0.2");
			expect(result.data.entry.user).toBe("ops");
		} finally {
			await cleanup();
		}
	});

	test("--match target= selects among a duplicated identity=", async () => {
		const { path, cleanup } = await tempCdb(duplicateIdentityRecords());
		try {
			const cdb = await reload(path);
			const result = showDevice({
				cdb,
				target: "dup",
				match: "target=10.0.0.1",
			});
			expect(result.data.entry.user).toBe("admin");
		} finally {
			await cleanup();
		}
	});

	test("an unsupported --match key errors with input/invalid-match", async () => {
		const { path, cleanup } = await tempCdb(duplicateIdentityRecords());
		try {
			const cdb = await reload(path);
			const error = await catchError(async () =>
				showDevice({ cdb, target: "dup", match: "group=x" }),
			);
			expect(error.code).toBe("input/invalid-match");
		} finally {
			await cleanup();
		}
	});
});

describe("devices tips", () => {
	test("list on an empty registry emits tip/no-devices", async () => {
		const { path, cleanup } = await tempCdb([]);
		try {
			const cdb = await reload(path);
			const result = listDevices({ cdb });
			expect(result.tips.map((t) => t.code)).toContain("tip/no-devices");
			expect(result.tips[0]?.fix).toBeDefined();
		} finally {
			await cleanup();
		}
	});

	test("list on a populated registry emits no tips", async () => {
		const { path, cleanup } = await tempCdb([adminRecord()]);
		try {
			const cdb = await reload(path);
			expect(listDevices({ cdb }).tips).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("show emits tip/credentials-missing for a passwordless record", async () => {
		const { path, cleanup } = await tempCdb([
			buildWinBoxCdbEntryRecord({
				recordType: winBoxCdbRecordType.macTarget,
				target: "AA:BB:CC:DD:EE:01",
				user: "mac-only",
				savedPassword: false,
			}),
		]);
		try {
			const cdb = await reload(path);
			const result = showDevice({ cdb, target: "AA:BB:CC:DD:EE:01" });
			expect(result.tips.map((t) => t.code)).toContain(
				"tip/credentials-missing",
			);
		} finally {
			await cleanup();
		}
	});

	test("a __default__ record suppresses the credentials-missing tip", async () => {
		const { path, cleanup } = await tempCdb([
			buildWinBoxCdbEntryRecord({
				recordType: winBoxCdbRecordType.ipAdmin,
				target: "__default__",
				user: "fallback",
				password: "fallback-pw",
			}),
			buildWinBoxCdbEntryRecord({
				recordType: winBoxCdbRecordType.macTarget,
				target: "AA:BB:CC:DD:EE:02",
				user: "mac-only",
				savedPassword: false,
			}),
		]);
		try {
			const cdb = await reload(path);
			const result = showDevice({ cdb, target: "AA:BB:CC:DD:EE:02" });
			expect(result.tips).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("show emits no tip when the record stores a password", async () => {
		const { path, cleanup } = await tempCdb([adminRecord()]);
		try {
			const cdb = await reload(path);
			expect(showDevice({ cdb, target: "192.0.2.5" }).tips).toEqual([]);
		} finally {
			await cleanup();
		}
	});
});
