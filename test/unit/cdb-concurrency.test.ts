/**
 * #581: concurrent or stale CDB mutations must never both report success while
 * one change is silently lost. Covers the lock primitive, the revision check in
 * the writer, the deterministic stale-snapshot reproduction (open + encrypted),
 * the CLI/MCP replay helper, and backup naming under rapid serialized writes.
 * Independent-process coverage lives in test/integration/devices.test.ts.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";
import {
	readWinBoxCdbRevision,
	WINBOX_CDB_ABSENT_REVISION,
	winBoxCdbLockPath,
	withWinBoxCdbLock,
} from "../../src/data/winbox-cdb-lock.ts";
import {
	listWinBoxCdbBackups,
	writeWinBoxCdb,
} from "../../src/data/winbox-cdb-write.ts";
import {
	addDevice,
	CDB_CONFLICT_MAX_ATTEMPTS,
	encryptCdb,
	initCdb,
	loadCdb,
	removeDevice,
	retryOnCdbConflict,
	setDevice,
} from "../../src/index.ts";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function sandbox(): Promise<{ dir: string; cdbFile: string }> {
	const dir = await mkdtemp(join(tmpdir(), "centrs-cdb-concurrency-"));
	dirs.push(dir);
	return { dir, cdbFile: join(dir, "winbox.cdb") };
}

function record(target: string) {
	return buildWinBoxCdbEntryRecord({
		recordType: winBoxCdbRecordType.ipAdmin,
		target,
		user: "test",
	});
}

const fastLock = { timeoutMs: 150 };

describe("stale-snapshot reproduction (#581)", () => {
	for (const encrypted of [false, true]) {
		const label = encrypted ? "encrypted" : "open";
		const cdbPassword = encrypted ? "centrs-test" : undefined;

		test(`${label}: the second stale add is refused and the first survives`, async () => {
			const { cdbFile } = await sandbox();
			await initCdb({ cdbFile, cdbPassword, encrypt: encrypted, env: {} });
			const a = await loadCdb({ cdbFile, cdbPassword, env: {} });
			const b = await loadCdb({ cdbFile, cdbPassword, env: {} });
			expect(a.revision).toBe(b.revision);

			await addDevice({ cdb: a, target: "a.example", user: "test" });
			await expect(
				addDevice({ cdb: b, target: "b.example", user: "test" }),
			).rejects.toMatchObject({
				code: "cdb/conflict",
				context: { cdbFile, expectedRevision: b.revision },
			});

			const final = await loadCdb({ cdbFile, cdbPassword, env: {} });
			expect(final.encrypted).toBe(encrypted);
			expect(final.entries.map((entry) => entry.target)).toEqual(["a.example"]);
			expect(await Bun.file(winBoxCdbLockPath(cdbFile)).exists()).toBe(false);
		});

		test(`${label}: retryOnCdbConflict replays the stale add and keeps both`, async () => {
			const { cdbFile } = await sandbox();
			await initCdb({ cdbFile, cdbPassword, encrypt: encrypted, env: {} });
			const reload = () => loadCdb({ cdbFile, cdbPassword, env: {} });
			const a = await reload();
			const b = await reload();

			await addDevice({ cdb: a, target: "a.example", user: "test" });
			const second = await retryOnCdbConflict(b, reload, (cdb) =>
				addDevice({ cdb, target: "b.example", user: "test" }),
			);
			expect(second.data.cdbRecordIndex).toBe(1);

			const final = await reload();
			expect(final.entries.map((entry) => entry.target)).toEqual([
				"a.example",
				"b.example",
			]);
		});
	}

	test("set and remove on a stale snapshot are refused too", async () => {
		const { cdbFile } = await sandbox();
		await initCdb({ cdbFile, env: {} });
		await addDevice({
			cdb: await loadCdb({ cdbFile, env: {} }),
			target: "a.example",
			user: "test",
		});
		const stale = await loadCdb({ cdbFile, env: {} });
		await setDevice({
			cdb: await loadCdb({ cdbFile, env: {} }),
			target: "a.example",
			group: "fresh",
		});

		await expect(
			setDevice({ cdb: stale, target: "a.example", group: "stale" }),
		).rejects.toMatchObject({ code: "cdb/conflict" });
		await expect(
			removeDevice({ cdb: stale, target: "a.example" }),
		).rejects.toMatchObject({ code: "cdb/conflict" });
		const final = await loadCdb({ cdbFile, env: {} });
		expect(final.entries.map((entry) => entry.group)).toEqual(["fresh"]);
	});

	test("replay re-runs validation: a racing duplicate add becomes cdb/already-exists", async () => {
		const { cdbFile } = await sandbox();
		await initCdb({ cdbFile, env: {} });
		const reload = () => loadCdb({ cdbFile, env: {} });
		const a = await reload();
		const b = await reload();
		await addDevice({ cdb: a, target: "same.example", user: "test" });
		await expect(
			retryOnCdbConflict(b, reload, (cdb) =>
				addDevice({ cdb, target: "same.example", user: "test" }),
			),
		).rejects.toMatchObject({ code: "cdb/already-exists" });
	});

	test("concurrent in-process writers all land with replay", async () => {
		const { cdbFile } = await sandbox();
		await initCdb({ cdbFile, env: {} });
		const reload = () => loadCdb({ cdbFile, env: {} });
		const targets = Array.from(
			{ length: CDB_CONFLICT_MAX_ATTEMPTS },
			(_, index) => `host${index}.example`,
		);
		// Every writer starts from the same snapshot, the worst case for replay.
		const shared = await reload();
		await Promise.all(
			targets.map((target) =>
				retryOnCdbConflict(shared, reload, (cdb) =>
					addDevice({ cdb, target, user: "test" }),
				),
			),
		);
		const final = await reload();
		expect(final.entries.map((entry) => entry.target).sort()).toEqual(
			[...targets].sort(),
		);
	});

	test("retryOnCdbConflict gives up after the attempt budget", async () => {
		const { cdbFile } = await sandbox();
		await initCdb({ cdbFile, env: {} });
		let attempts = 0;
		const stale = await loadCdb({ cdbFile, env: {} });
		await addDevice({
			cdb: await loadCdb({ cdbFile, env: {} }),
			target: "x.example",
		});
		await expect(
			retryOnCdbConflict(
				stale,
				async () => stale,
				(cdb) => {
					attempts += 1;
					return addDevice({ cdb, target: "y.example" });
				},
				3,
			),
		).rejects.toMatchObject({ code: "cdb/conflict" });
		expect(attempts).toBe(3);
	});

	test("encryptCdb refuses to convert a snapshot that changed under it", async () => {
		const { cdbFile } = await sandbox();
		await writeFile(cdbFile, encodeOpenWinBoxCdb([record("a.example")]));
		// Hold the lock, change the file, then release: encrypt must see the
		// change because its revision check runs inside the lock.
		let result: Promise<unknown> | undefined;
		await withWinBoxCdbLock(cdbFile, async () => {
			result = encryptCdb({
				cdbFile,
				cdbPassword: "centrs-test",
				env: {},
				skipBackup: true,
			}).catch((error: unknown) => error);
			// encryptCdb loads a two-record file before it asks for the lock;
			// give that load ample time on a slow runner before changing the file.
			await Bun.sleep(150);
			await writeFile(
				cdbFile,
				encodeOpenWinBoxCdb([record("a.example"), record("b.example")]),
			);
		});
		expect(await result).toMatchObject({ code: "cdb/conflict" });
		const final = await loadCdb({ cdbFile, env: {} });
		expect(final.encrypted).toBe(false);
		expect(final.entries).toHaveLength(2);
	});
});

describe("writeWinBoxCdb expectedRevision", () => {
	test("a matching revision writes; a mismatch leaves file and backups untouched", async () => {
		const { cdbFile } = await sandbox();
		await writeFile(cdbFile, encodeOpenWinBoxCdb([record("a.example")]));
		const revision = await readWinBoxCdbRevision(cdbFile);
		await writeWinBoxCdb(cdbFile, [record("b.example")], {
			expectedRevision: revision,
		});
		const after = await readFile(cdbFile);
		const backups = await listWinBoxCdbBackups(cdbFile);

		await expect(
			writeWinBoxCdb(cdbFile, [record("c.example")], {
				expectedRevision: revision,
			}),
		).rejects.toMatchObject({ code: "cdb/conflict" });
		expect(await readFile(cdbFile)).toEqual(after);
		expect(await listWinBoxCdbBackups(cdbFile)).toEqual(backups);
	});

	test("an absent revision refuses to overwrite a file that appeared", async () => {
		const { cdbFile } = await sandbox();
		await writeFile(cdbFile, encodeOpenWinBoxCdb([record("a.example")]));
		await expect(
			writeWinBoxCdb(cdbFile, [], {
				expectedRevision: WINBOX_CDB_ABSENT_REVISION,
			}),
		).rejects.toMatchObject({ code: "cdb/conflict" });
	});

	test("an absent revision creates a missing file", async () => {
		const { cdbFile } = await sandbox();
		await writeWinBoxCdb(cdbFile, [record("a.example")], {
			expectedRevision: WINBOX_CDB_ABSENT_REVISION,
		});
		expect((await loadCdb({ cdbFile, env: {} })).entries).toHaveLength(1);
	});

	test("two writes in the same millisecond keep two distinct backups", async () => {
		const { cdbFile } = await sandbox();
		await writeFile(cdbFile, encodeOpenWinBoxCdb([record("a.example")]));
		const now = new Date(Date.UTC(2026, 10, 5, 12, 0, 0));
		const first = await writeWinBoxCdb(cdbFile, [record("b.example")], {
			now,
		});
		const second = await writeWinBoxCdb(cdbFile, [record("c.example")], {
			now,
		});
		expect(second.backupPath).toBe(`${first.backupPath}-1`);
		const backups = await listWinBoxCdbBackups(cdbFile);
		// Newest first: the suffixed name sorts after the bare timestamp.
		expect(backups).toEqual([
			second.backupPath as string,
			first.backupPath as string,
		]);
	});

	for (const backupRetention of [2, 20]) {
		test(`same-timestamp backups retain the latest contents (retention ${backupRetention})`, async () => {
			const { cdbFile } = await sandbox();
			await writeFile(cdbFile, encodeOpenWinBoxCdb([record("host0.example")]));
			const now = new Date(Date.UTC(2026, 10, 5, 12, 0, 0));
			const paths: string[] = [];
			for (let index = 1; index <= 12; index += 1) {
				const result = await writeWinBoxCdb(
					cdbFile,
					[record(`host${index}.example`)],
					{
						now,
						backupRetention,
					},
				);
				const backup = result.backupPath as string;
				expect(paths).not.toContain(backup);
				paths.push(backup);
				const backups = await listWinBoxCdbBackups(cdbFile);
				expect(backups).toEqual(paths.slice(-backupRetention).reverse());
				expect(await readFile(backups[0] as string)).toEqual(
					Buffer.from(
						encodeOpenWinBoxCdb([record(`host${index - 1}.example`)]),
					),
				);
			}
		});
	}
});

describe("withWinBoxCdbLock", () => {
	for (const code of ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EACCES"]) {
		test(`lock creation handles ${code} without changing the CDB`, async () => {
			const { dir, cdbFile } = await sandbox();
			const original = encodeOpenWinBoxCdb([record("existing.example")]);
			await writeFile(cdbFile, original);
			const cause = Object.assign(new Error("link failed"), { code });
			const createLink = spyOn(fsPromises, "link").mockRejectedValue(cause);
			try {
				const attempt = writeWinBoxCdb(
					cdbFile,
					[record("replacement.example")],
					{
						expectedRevision: await readWinBoxCdbRevision(cdbFile),
					},
				);
				if (code === "EPERM" || code === "EACCES") {
					await expect(attempt).rejects.toBe(cause);
				} else {
					await expect(attempt).rejects.toMatchObject({
						code: "cdb/lock-unsupported",
						context: { lockFile: winBoxCdbLockPath(cdbFile) },
						cause,
						remediation: expect.stringContaining("--cdb-file"),
					});
				}
			} finally {
				createLink.mockRestore();
			}
			expect(await readFile(cdbFile)).toEqual(Buffer.from(original));
			expect(await readdir(dir)).toEqual(["winbox.cdb"]);
		});
	}

	test("serializes critical sections and removes the lock afterwards", async () => {
		const { cdbFile } = await sandbox();
		let inside = 0;
		let maxInside = 0;
		await Promise.all(
			Array.from({ length: 4 }, () =>
				withWinBoxCdbLock(cdbFile, async () => {
					inside += 1;
					maxInside = Math.max(maxInside, inside);
					await Bun.sleep(5);
					inside -= 1;
				}),
			),
		);
		expect(maxInside).toBe(1);
		expect(await Bun.file(winBoxCdbLockPath(cdbFile)).exists()).toBe(false);
	});

	test("releases the lock when the critical section throws", async () => {
		const { cdbFile } = await sandbox();
		await expect(
			withWinBoxCdbLock(cdbFile, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(await Bun.file(winBoxCdbLockPath(cdbFile)).exists()).toBe(false);
	});

	test("a live holder times out as cdb/locked naming the lock and holder", async () => {
		const { cdbFile } = await sandbox();
		const lockFile = winBoxCdbLockPath(cdbFile);
		const holder = {
			pid: 4242,
			hostname: "other-host",
			createdAt: "2026-11-05T00:00:00.000Z",
			token: "foreign",
		};
		await writeFile(lockFile, JSON.stringify(holder));
		await expect(
			withWinBoxCdbLock(cdbFile, async () => undefined, fastLock),
		).rejects.toMatchObject({
			code: "cdb/locked",
			context: {
				cdbFile,
				lockFile,
				holder: {
					pid: 4242,
					hostname: "other-host",
					createdAt: holder.createdAt,
				},
			},
		});
		// Never broken: another host's lock is not ours to judge.
		expect(JSON.parse(await readFile(lockFile, "utf8"))).toEqual(holder);
	});

	test("a dead holder on this host is broken automatically", async () => {
		const { cdbFile } = await sandbox();
		const lockFile = winBoxCdbLockPath(cdbFile);
		await writeFile(
			lockFile,
			JSON.stringify({
				pid: 4242,
				hostname: hostname(),
				createdAt: "2026-11-05T00:00:00.000Z",
				token: "crashed",
			}),
		);
		const ran = await withWinBoxCdbLock(cdbFile, async () => "ran", {
			...fastLock,
			isProcessAlive: (pid) => pid !== 4242,
		});
		expect(ran).toBe("ran");
		expect(await Bun.file(lockFile).exists()).toBe(false);
	});

	test("eight waiters on one dead holder never overlap critical sections", async () => {
		const { cdbFile } = await sandbox();
		const lockFile = winBoxCdbLockPath(cdbFile);
		await writeFile(
			lockFile,
			JSON.stringify({
				pid: 4242,
				hostname: hostname(),
				createdAt: new Date().toISOString(),
				token: "crashed",
			}),
		);
		let inside = 0;
		let maxInside = 0;
		await Promise.all(
			Array.from({ length: 8 }, () =>
				withWinBoxCdbLock(
					cdbFile,
					async () => {
						inside += 1;
						maxInside = Math.max(maxInside, inside);
						await Bun.sleep(10);
						inside -= 1;
					},
					{ timeoutMs: 3000, isProcessAlive: (pid) => pid !== 4242 },
				),
			),
		);
		expect(maxInside).toBe(1);
		expect(await Bun.file(lockFile).exists()).toBe(false);
	});

	test("a busy recovery guard respects the timeout and a later attempt can recover", async () => {
		const { cdbFile } = await sandbox();
		const lockFile = winBoxCdbLockPath(cdbFile);
		const dead = JSON.stringify({
			pid: 4242,
			hostname: hostname(),
			createdAt: new Date().toISOString(),
			token: "crashed",
		});
		await writeFile(lockFile, dead);
		const guard = new Database(`${lockFile}.guard`);
		guard.run("BEGIN IMMEDIATE");
		const options = {
			...fastLock,
			isProcessAlive: (pid: number) => pid !== 4242,
		};
		try {
			await expect(
				withWinBoxCdbLock(cdbFile, async () => undefined, options),
			).rejects.toMatchObject({ code: "cdb/locked" });
			expect(await readFile(lockFile, "utf8")).toBe(dead);
		} finally {
			guard.close();
		}
		expect(
			await withWinBoxCdbLock(cdbFile, async () => "recovered", options),
		).toBe("recovered");
	});

	test("a stale recovery observation leaves a newer live holder untouched", async () => {
		const { cdbFile } = await sandbox();
		const lockFile = winBoxCdbLockPath(cdbFile);
		const dead = {
			pid: 4242,
			hostname: hostname(),
			createdAt: new Date().toISOString(),
			token: "dead",
		};
		const live = { ...dead, pid: 4243, token: "new-live-holder" };
		await writeFile(lockFile, JSON.stringify(dead));
		let replaced = false;
		await expect(
			withWinBoxCdbLock(cdbFile, async () => undefined, {
				...fastLock,
				isProcessAlive: (pid) => {
					if (pid === dead.pid && !replaced) {
						// Another breaker recovered D and a new writer acquired L
						// between our first observation and taking the recovery mutex.
						replaced = true;
						writeFileSync(lockFile, JSON.stringify(live));
					}
					return pid !== dead.pid;
				},
			}),
		).rejects.toMatchObject({ code: "cdb/locked" });
		expect(JSON.parse(await readFile(lockFile, "utf8"))).toEqual(live);
	});

	test("an unreadable lock is never broken", async () => {
		const { cdbFile } = await sandbox();
		const lockFile = winBoxCdbLockPath(cdbFile);
		await writeFile(lockFile, "not json");
		await expect(
			withWinBoxCdbLock(cdbFile, async () => undefined, {
				...fastLock,
				isProcessAlive: () => false,
			}),
		).rejects.toMatchObject({ code: "cdb/locked" });
		expect(await readFile(lockFile, "utf8")).toBe("not json");
	});

	test("release leaves a lock it does not own in place", async () => {
		const { dir, cdbFile } = await sandbox();
		const lockFile = winBoxCdbLockPath(cdbFile);
		await withWinBoxCdbLock(cdbFile, async () => {
			// Simulate a manual delete + another writer's new lock mid-section.
			await rm(lockFile);
			await writeFile(
				lockFile,
				JSON.stringify({
					pid: 1,
					hostname: "other-host",
					createdAt: "2026-11-05T00:00:00.000Z",
					token: "someone-else",
				}),
			);
		});
		expect(JSON.parse(await readFile(lockFile, "utf8")).token as string).toBe(
			"someone-else",
		);
		// No temp or stale files left behind beside the CDB.
		expect(
			(await readdir(dir)).filter((name) => name !== "winbox.cdb.lock"),
		).toEqual([]);
	});
});
