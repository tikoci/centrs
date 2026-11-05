/**
 * Cross-process mutual exclusion and revision checks for WinBox CDB writes
 * (#581).
 *
 * Atomic rename keeps a CDB from being half-written, but it does not protect
 * the read–modify–write transaction: two callers can load the same file, both
 * mutate their snapshot, and the second rename silently drops the first
 * caller's change. A centrs mutation therefore carries the {@link
 * WinBoxCdbRevision} it was loaded from, and the writer re-reads the file and
 * compares revisions *while holding the lock* — so check and replacement are
 * one critical section.
 *
 * The lock is a sibling file `<cdb>.lock`. It appears atomically with its full
 * contents: the holder record is written to a private temp file, then
 * hard-linked into place, and `link()` refuses to replace an existing path. That
 * is the same no-clobber primitive `devices init` already relies on, and it maps
 * to `CreateHardLinkW` on Windows. No handle is held open while the lock is
 * held, so release (`unlink`) is not blocked by an open handle on Windows.
 * Dead-holder recovery is serialized by a SQLite write transaction on the
 * persistent sibling `<cdb>.lock.guard`. SQLite releases that OS lock when a
 * breaker exits, including on a crash. Never unlink the guard: replacing its
 * inode would let two breakers lock different files.
 *
 * A lock is broken only when its holder recorded this host and that pid is no
 * longer running — never by age, since re-encrypting a large CDB can be slow.
 * Windows recycles pids quickly; a recycled pid reads as alive, which keeps the
 * lock (the safe direction) and leaves `cdb/locked` remediation to name the
 * file. Writers that do not participate (WinBox itself, a script) are outside
 * this lock; the revision check still catches their writes made before the
 * check, but not one landing between the check and the rename.
 */

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { CentrsError } from "../errors.ts";

/** Revision of a CDB on disk: a content hash, or `absent` when there is no file. */
export type WinBoxCdbRevision = `sha256:${string}` | "absent";

/** Revision recorded for a CDB path that does not exist. */
export const WINBOX_CDB_ABSENT_REVISION = "absent" satisfies WinBoxCdbRevision;

/** Default time to wait for another writer to release the lock. */
export const WINBOX_CDB_DEFAULT_LOCK_TIMEOUT_MS = 10_000;

const LOCK_SUFFIX = ".lock";

/** Holder record serialized into the lock file. */
export interface WinBoxCdbLockHolder {
	pid: number;
	hostname: string;
	createdAt: string;
	/** Random per-acquisition token; release only removes a lock it owns. */
	token: string;
}

export interface WinBoxCdbLockOptions {
	/** Total time to wait for the lock before `cdb/locked`. */
	timeoutMs?: number;
	/** Test seams: identity of this process and the liveness probe. */
	pid?: number;
	hostname?: string;
	isProcessAlive?: (pid: number) => boolean;
}

/** Path of the lock file guarding `target`. */
export function winBoxCdbLockPath(target: string): string {
	return `${target}${LOCK_SUFFIX}`;
}

/** Revision of raw CDB bytes as loaded (open or encrypted ciphertext). */
export function winBoxCdbRevisionOf(bytes: Uint8Array): WinBoxCdbRevision {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Read the current on-disk revision of `target`. */
export async function readWinBoxCdbRevision(
	target: string,
): Promise<WinBoxCdbRevision> {
	try {
		return winBoxCdbRevisionOf(new Uint8Array(await readFile(target)));
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return WINBOX_CDB_ABSENT_REVISION;
		}
		throw error;
	}
}

/**
 * Refuse a write whose source snapshot is no longer what is on disk. Call only
 * while holding the lock from {@link withWinBoxCdbLock}.
 */
export async function assertWinBoxCdbRevision(
	target: string,
	expected: WinBoxCdbRevision,
): Promise<void> {
	const current = await readWinBoxCdbRevision(target);
	if (current === expected) {
		return;
	}
	throw new CentrsError({
		code: "cdb/conflict",
		summary: `The CDB at ${target} changed after it was loaded; this write was refused so the other change is not lost.`,
		remediation:
			"Reload the CDB and re-apply the change. CLI and MCP add/set/remove and discover --save retry automatically; devices encrypt and direct library mutations do not. If WinBox has this file open, close it first.",
		context: { cdbFile: target, expectedRevision: expected, current },
	});
}

/** Default liveness probe: signal 0 checks existence without signalling. */
export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return errorCode(error) !== "ESRCH";
	}
}

/**
 * Run `fn` while holding the exclusive lock for `target`. Waits with bounded
 * backoff, then fails `cdb/locked`. The lock is released even if `fn` throws.
 */
export async function withWinBoxCdbLock<T>(
	target: string,
	fn: () => Promise<T>,
	options: WinBoxCdbLockOptions = {},
): Promise<T> {
	const holder = await acquireLock(target, options);
	try {
		return await fn();
	} finally {
		await releaseLock(target, holder);
	}
}

/** Acquire a no-clobber lock, recovering dead holders within the wait budget. */
async function acquireLock(
	target: string,
	options: WinBoxCdbLockOptions,
): Promise<WinBoxCdbLockHolder> {
	const lockPath = winBoxCdbLockPath(target);
	const timeoutMs = options.timeoutMs ?? WINBOX_CDB_DEFAULT_LOCK_TIMEOUT_MS;
	const isAlive = options.isProcessAlive ?? processIsAlive;
	const self: WinBoxCdbLockHolder = {
		pid: options.pid ?? process.pid,
		hostname: options.hostname ?? osHostname(),
		createdAt: new Date().toISOString(),
		token: randomUUID(),
	};
	const deadline = performance.now() + timeoutMs;
	let delayMs = 10;
	let lastHolder: WinBoxCdbLockHolder | undefined;
	for (;;) {
		if (await tryCreateLock(lockPath, self)) {
			return self;
		}
		const current = await readLockHolder(lockPath);
		lastHolder = current === "gone" ? undefined : current;
		if (
			current !== "gone" &&
			current !== undefined &&
			current.hostname === self.hostname &&
			current.pid !== self.pid &&
			!isAlive(current.pid)
		) {
			await breakDeadLock(lockPath, current, self, isAlive);
		}
		if (performance.now() >= deadline) {
			throw lockedError(target, lockPath, lastHolder, timeoutMs);
		}
		const jitter = Math.random() * delayMs;
		await Bun.sleep(
			Math.max(0, Math.min(delayMs + jitter, deadline - performance.now())),
		);
		delayMs = Math.min(delayMs * 2, 250);
	}
}

/** Atomically create the lock with its contents; `false` when one exists. */
async function tryCreateLock(
	lockPath: string,
	holder: WinBoxCdbLockHolder,
): Promise<boolean> {
	const tempPath = `${lockPath}.${holder.token}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(holder)}\n`, { mode: 0o600 });
	try {
		await link(tempPath, lockPath);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") {
			return false;
		}
		if (["ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(errorCode(error) ?? "")) {
			throw new CentrsError({
				code: "cdb/lock-unsupported",
				summary: `The filesystem cannot create the hard-link lock at ${lockPath}; the CDB was not changed.`,
				remediation:
					"Move the CDB to a filesystem that supports hard links (such as NTFS on Windows or a local filesystem on Linux/macOS), then select it with --cdb-file or CENTRS_CDB_FILE. Do not bypass the lock.",
				context: { lockFile: lockPath },
				cause: error,
			});
		}
		throw error;
	} finally {
		await unlink(tempPath).catch(() => undefined);
	}
}

/** Parsed holder, `undefined` when unreadable, `"gone"` when released meanwhile. */
async function readLockHolder(
	lockPath: string,
): Promise<WinBoxCdbLockHolder | undefined | "gone"> {
	let text: string;
	try {
		text = await readFile(lockPath, "utf8");
	} catch (error) {
		return errorCode(error) === "ENOENT" ? "gone" : undefined;
	}
	try {
		const value = JSON.parse(text) as Partial<WinBoxCdbLockHolder>;
		if (
			typeof value.pid === "number" &&
			Number.isSafeInteger(value.pid) &&
			value.pid > 0 &&
			typeof value.hostname === "string" &&
			typeof value.createdAt === "string" &&
			typeof value.token === "string" &&
			value.token.length > 0
		) {
			return value as WinBoxCdbLockHolder;
		}
	} catch {
		// Fall through: an unparseable lock is never broken automatically.
	}
	return undefined;
}

/**
 * Re-read and remove a dead holder only while holding the recovery mutex.
 * A second lock file with PID-based recovery would just repeat the original
 * race. SQLite's non-blocking BEGIN IMMEDIATE instead supplies a cross-process
 * mutex whose crash recovery is owned by the OS. No database contents or
 * journal are needed; the persistent empty guard file only supplies an inode.
 */
async function breakDeadLock(
	lockPath: string,
	dead: WinBoxCdbLockHolder,
	self: WinBoxCdbLockHolder,
	isAlive: (pid: number) => boolean,
): Promise<void> {
	const guardPath = `${lockPath}.guard`;
	// Only SQLite may open this inode: closing an unrelated fd for it can drop
	// this process's POSIX advisory locks while another connection is using it.
	const guard = new Database(guardPath);
	try {
		guard.run("PRAGMA busy_timeout = 0");
		try {
			guard.run("BEGIN IMMEDIATE");
		} catch (error) {
			if (errorCode(error) === "SQLITE_BUSY") return;
			throw error;
		}
		const current = await readLockHolder(lockPath);
		if (
			current !== "gone" &&
			current !== undefined &&
			current.token === dead.token &&
			current.hostname === self.hostname &&
			current.pid !== self.pid &&
			!isAlive(current.pid)
		) {
			await unlink(lockPath);
		}
	} finally {
		guard.close();
	}
}

/** Release only this acquisition's token, preserving an unrelated holder. */
async function releaseLock(
	target: string,
	holder: WinBoxCdbLockHolder,
): Promise<void> {
	const lockPath = winBoxCdbLockPath(target);
	const current = await readLockHolder(lockPath);
	if (current !== "gone" && current?.token === holder.token) {
		await unlink(lockPath).catch(() => undefined);
	}
}

/** Describe a lock timeout without exposing the holder's private token. */
function lockedError(
	target: string,
	lockPath: string,
	holder: WinBoxCdbLockHolder | undefined,
	timeoutMs: number,
): CentrsError {
	const who = holder
		? `pid ${holder.pid} on ${holder.hostname} since ${holder.createdAt}`
		: "an unreadable holder";
	return new CentrsError({
		code: "cdb/locked",
		summary: `Another writer holds the CDB lock for ${target} (${who}); gave up after ${timeoutMs} ms.`,
		remediation: `Retry once the other centrs command finishes. If no centrs process is running, the lock is left over from a crash: delete ${lockPath} and retry.`,
		context: {
			cdbFile: target,
			lockFile: lockPath,
			timeoutMs,
			...(holder
				? {
						holder: {
							pid: holder.pid,
							hostname: holder.hostname,
							createdAt: holder.createdAt,
						},
					}
				: {}),
		},
	});
}

/** Read a filesystem or SQLite error code without assuming an Error subtype. */
function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code: unknown }).code)
		: undefined;
}
