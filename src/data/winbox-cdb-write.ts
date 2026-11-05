/**
 * Crash-safe WinBox CDB writer.
 *
 * The CDB at `~/.config/tikoci/winbox.cdb` is the canonical device datastore —
 * there is no SQLite cache, so a partially-written CDB is data loss WinBox
 * would refuse to open. This module is the single seam that turns a record set
 * into bytes on disk, and it does so atomically:
 *
 *   1. Snapshot the current file to a timestamped backup beside it.
 *   2. Prune backups beyond the retention count (newest kept).
 *   3. Write the new bytes to a temp file in the SAME directory, `fsync` it.
 *   4. `rename()` the temp file over the target (atomic on one filesystem).
 *
 * Serialization reuses {@link encodeOpenWinBoxCdb}, so unknown-tcode `rawTail`
 * fields round-trip byte-for-byte. When `encryptWith` is supplied, the open
 * bytes are wrapped via {@link encryptWinBoxCdb} (fresh random salt per write
 * unless the caller pins one for tests) before they hit disk; the backup
 * snapshot copies the existing on-disk bytes verbatim, so an encrypted CDB
 * stays encrypted across backup + write.
 *
 * Concurrency (#581): pass `expectedRevision` (the revision the records were
 * loaded from) and the whole backup → write → rename sequence runs under the
 * cross-process lock in `winbox-cdb-lock.ts`, after re-reading the file and
 * refusing a stale snapshot with `cdb/conflict`. Without `expectedRevision` the
 * write is unsynchronized: a low-level primitive for callers that own the file
 * exclusively. Every centrs mutation passes it.
 */

import { constants as fsConstants } from "node:fs";
import {
	chmod,
	copyFile,
	mkdir,
	open,
	readdir,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	encodeOpenWinBoxCdb,
	encryptWinBoxCdb,
	type WinBoxCdbRecord,
} from "./winbox-cdb.ts";
import {
	assertWinBoxCdbRevision,
	type WinBoxCdbLockOptions,
	type WinBoxCdbRevision,
	withWinBoxCdbLock,
} from "./winbox-cdb-lock.ts";

/**
 * Default number of timestamped backups retained next to the CDB. Two since
 * #581: the write lock, not backups, now guards against concurrent writers;
 * the remaining backups are an undo for a mistaken mutation.
 */
export const WINBOX_CDB_DEFAULT_BACKUP_RETENTION = 2;

const BACKUP_INFIX = ".bak.";
const TEMP_INFIX = ".tmp.";

export interface WriteWinBoxCdbOptions {
	/** Number of `*.bak.*` snapshots to keep; older ones are pruned. */
	backupRetention?: number;
	/** Clock injection for deterministic backup timestamps in tests. */
	now?: Date;
	/** Skip the backup snapshot entirely (used for first-time creation). */
	skipBackup?: boolean;
	/**
	 * When set, the serialized open bytes are wrapped via {@link encryptWinBoxCdb}
	 * before atomic write. `salt` is optional — omit to let the codec roll a
	 * fresh 32-byte salt per write (the normal path); pin it only in tests that
	 * need byte-exact output. The caller is responsible for matching the source
	 * password (centrs reads it from the loaded CDB's settings).
	 */
	encryptWith?: { password: string; salt?: Uint8Array };
	/**
	 * Revision the records were loaded from. When set, the write takes the CDB
	 * lock, re-reads the file, and fails `cdb/conflict` if it changed — so a
	 * stale snapshot can never silently drop another writer's change.
	 */
	expectedRevision?: WinBoxCdbRevision;
	/** Lock wait/identity options; only used with `expectedRevision`. */
	lock?: WinBoxCdbLockOptions;
	/** Platform override for the Windows rename retry (tests). */
	platform?: NodeJS.Platform;
}

export interface WriteWinBoxCdbResult {
	/** Absolute/target path that now holds the new bytes. */
	path: string;
	/** Number of record(s) serialized. */
	recordCount: number;
	/** Number of bytes written to the target. */
	byteLength: number;
	/** Backup path created before the overwrite, when one was written. */
	backupPath?: string;
	/** Backup paths pruned by retention, in deletion order. */
	prunedBackups: readonly string[];
}

/** Filesystem-safe, lexicographically-sortable timestamp for backup names. */
function backupStamp(now: Date): string {
	return now.toISOString().replace(/[:.]/g, "-");
}

function backupPrefix(target: string): string {
	return `${basename(target)}${BACKUP_INFIX}`;
}

/**
 * List backups newest first: timestamp order, then numeric collision suffix.
 */
export async function listWinBoxCdbBackups(
	target: string,
): Promise<readonly string[]> {
	const dir = dirname(target);
	const prefix = backupPrefix(target);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.startsWith(prefix))
		.sort(compareBackupsNewestFirst)
		.map((name) => join(dir, name));
}

/** Order timestamps lexically and their collision suffixes numerically. */
function compareBackupsNewestFirst(a: string, b: string): number {
	const left = /^(.*Z)(?:-(\d+))?$/.exec(a);
	const right = /^(.*Z)(?:-(\d+))?$/.exec(b);
	if (left && right && left[1] === right[1]) {
		const l = BigInt(left[2] ?? "0");
		const r = BigInt(right[2] ?? "0");
		return l < r ? 1 : l > r ? -1 : 0;
	}
	return a < b ? 1 : a > b ? -1 : 0;
}

/** Check whether a target is accessible before attempting its backup. */
async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Write `records` to `target` atomically, snapshotting and pruning backups.
 *
 * The records are serialized with {@link encodeOpenWinBoxCdb}; pass the full
 * record set (including untouched records) so the whole file is rewritten.
 */
export async function writeWinBoxCdb(
	target: string,
	records: readonly WinBoxCdbRecord[],
	options: WriteWinBoxCdbOptions = {},
): Promise<WriteWinBoxCdbResult> {
	const expected = options.expectedRevision;
	if (expected === undefined) {
		return writeUnlocked(target, records, options);
	}
	await mkdir(dirname(target), { recursive: true });
	return withWinBoxCdbLock(
		target,
		async () => {
			await assertWinBoxCdbRevision(target, expected);
			return writeUnlocked(target, records, options);
		},
		options.lock,
	);
}

/** Serialize, back up, and replace a CDB after the caller establishes exclusivity. */
async function writeUnlocked(
	target: string,
	records: readonly WinBoxCdbRecord[],
	options: WriteWinBoxCdbOptions,
): Promise<WriteWinBoxCdbResult> {
	const retention =
		options.backupRetention ?? WINBOX_CDB_DEFAULT_BACKUP_RETENTION;
	const dir = dirname(target);
	await mkdir(dir, { recursive: true });

	const bytes = options.encryptWith
		? encryptWinBoxCdb(
				encodeOpenWinBoxCdb(records),
				options.encryptWith.password,
				options.encryptWith.salt ? { salt: options.encryptWith.salt } : {},
			)
		: encodeOpenWinBoxCdb(records);

	let backupPath: string | undefined;
	const prunedBackups: string[] = [];
	const targetExists = await pathExists(target);
	// The backup and the replacement both carry the CDB's mode (a new CDB gets
	// 0600): the file holds device credentials, and neither a plain open nor
	// `copyFile` is guaranteed to keep it narrower than the umask default,
	// e.g. 0644 (#382 review).
	const mode = targetExists ? (await stat(target)).mode & 0o777 : 0o600;
	if (targetExists && !options.skipBackup) {
		backupPath = await copyToUniqueBackup(
			target,
			join(
				dir,
				`${backupPrefix(target)}${backupStamp(options.now ?? new Date())}`,
			),
		);
		try {
			await chmod(backupPath, mode);
		} catch (error) {
			await unlink(backupPath).catch(() => undefined);
			throw error;
		}

		if (retention >= 0) {
			const backups = await listWinBoxCdbBackups(target);
			for (const stale of backups.slice(retention)) {
				try {
					await unlink(stale);
					prunedBackups.push(stale);
				} catch {
					// A backup that vanished concurrently is already "pruned".
				}
			}
		}
	}

	const tempPath = join(
		dir,
		`${basename(target)}${TEMP_INFIX}${process.pid}.${Date.now().toString(36)}`,
	);
	// Any failure before the rename removes the temp file: it holds the
	// serialized CDB, credentials included.
	try {
		const handle = await open(tempPath, "w", mode);
		try {
			await handle.chmod(mode);
			await handle.write(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await renameReplacing(tempPath, target, options.platform);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}

	await syncDirectory(dir);

	return {
		path: target,
		recordCount: records.length,
		byteLength: bytes.length,
		backupPath,
		prunedBackups,
	};
}

/**
 * Copy `target` to `base`, or `base-1`, `base-2`, … when a backup with that
 * timestamp already exists. Start after the greatest surviving suffix: filling
 * a gap left by retention would make the newest snapshot look like the oldest
 * and immediately prune it. Numeric ordering also keeps -10 newer than -9.
 */
async function copyToUniqueBackup(
	target: string,
	base: string,
): Promise<string> {
	const latest = (await listWinBoxCdbBackups(target)).find(
		(path) =>
			path === base ||
			(path.startsWith(`${base}-`) &&
				/^\d+$/.test(path.slice(base.length + 1))),
	);
	let sequence =
		latest === undefined
			? 0n
			: BigInt(latest.slice(base.length + 1) || "0") + 1n;
	for (let attempt = 0; ; attempt += 1) {
		const candidate = sequence === 0n ? base : `${base}-${sequence}`;
		try {
			await copyFile(target, candidate, fsConstants.COPYFILE_EXCL);
			return candidate;
		} catch (error) {
			if (errorCode(error) !== "EEXIST" || attempt >= 99) {
				throw error;
			}
			sequence += 1n;
		}
	}
}

const WINDOWS_RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WINDOWS_RENAME_RETRY_DELAYS_MS = [20, 50, 100, 200, 400];

/**
 * `rename()` over the CDB. On Windows the replace fails transiently while
 * another process (antivirus, the search indexer, WinBox) has the target open,
 * so retry briefly there before surfacing the error. POSIX renames do not have
 * this failure mode and are not retried.
 */
async function renameReplacing(
	from: string,
	to: string,
	platform: NodeJS.Platform = process.platform,
): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
			const code = errorCode(error);
			if (
				platform !== "win32" ||
				delay === undefined ||
				code === undefined ||
				!WINDOWS_RENAME_RETRY_CODES.has(code)
			) {
				throw error;
			}
			await Bun.sleep(delay);
		}
	}
}

/** Read an operating-system error code for collision and retry decisions. */
function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code: unknown }).code)
		: undefined;
}

/** Best-effort directory fsync so the rename is durable across a crash. */
async function syncDirectory(dir: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(dir, "r");
		await handle.sync();
	} catch {
		// Directory fsync is unsupported on some platforms; the rename itself is
		// still atomic, so this is best-effort durability only.
	} finally {
		await handle?.close();
	}
}
