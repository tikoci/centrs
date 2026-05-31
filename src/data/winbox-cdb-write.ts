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
 * fields round-trip byte-for-byte. Encryption decisions (block / re-encrypt)
 * live with the caller (`src/devices.ts`); this module only writes open bytes.
 */

import {
	copyFile,
	mkdir,
	open,
	readdir,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { encodeOpenWinBoxCdb, type WinBoxCdbRecord } from "./winbox-cdb.ts";

/** Default number of timestamped backups retained next to the CDB. */
export const WINBOX_CDB_DEFAULT_BACKUP_RETENTION = 5;

const BACKUP_INFIX = ".bak.";
const TEMP_INFIX = ".tmp.";

export interface WriteWinBoxCdbOptions {
	/** Number of `*.bak.*` snapshots to keep; older ones are pruned. */
	backupRetention?: number;
	/** Clock injection for deterministic backup timestamps in tests. */
	now?: Date;
	/** Skip the backup snapshot entirely (used for first-time creation). */
	skipBackup?: boolean;
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
 * List existing backups for `target`, newest first (names embed a sortable
 * sortable ISO 8601 timestamp variant, so lexicographic order is chronological).
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
		.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
		.map((name) => join(dir, name));
}

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
	const retention =
		options.backupRetention ?? WINBOX_CDB_DEFAULT_BACKUP_RETENTION;
	const dir = dirname(target);
	await mkdir(dir, { recursive: true });

	const bytes = encodeOpenWinBoxCdb(records);

	let backupPath: string | undefined;
	const prunedBackups: string[] = [];
	const targetExists = await pathExists(target);
	if (targetExists && !options.skipBackup) {
		const stamp = backupStamp(options.now ?? new Date());
		backupPath = join(dir, `${backupPrefix(target)}${stamp}`);
		await copyFile(target, backupPath);

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
	const handle = await open(tempPath, "w");
	try {
		await handle.write(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}

	try {
		await rename(tempPath, target);
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
