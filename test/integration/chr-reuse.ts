/**
 * Process-scoped CHR reuse for integration tests (#612, PR 1).
 *
 * A CHR boot costs ~24.5 s on the CI runners, and several test files boot the
 * default fixture 2–5 times only to get a clean router for each test. This
 * module keeps ONE default CHR per `bun test` process and hands every opted-in
 * acquisition a router rewound to a verified baseline with quickchr's live
 * snapshots (QEMU `savevm`/`loadvm`, guest RAM + disk). It never reboots.
 *
 * Rules (see #612 → "Design rules"):
 * - **Reset per acquisition.** Every lease after the first restores the
 *   baseline, then proves readiness and cleanliness before returning.
 * - **One lease at a time.** An acquisition while the lease is held (a test
 *   that timed out without releasing, or concurrent tests) is answered with
 *   `undefined`; the caller boots a private CHR. Never restore under a lease.
 * - **Release is not removal.** Only `dispose()` removes the owned VM.
 * - **Fail closed.** A restore or readiness failure discards the VM and boots
 *   ONE replacement with a new baseline; a second failure throws. A dirty or
 *   uncertain router is never handed out, and sharing is never silently
 *   switched off.
 *
 * Opt-in is per call site: `startIntegrationChr({}, { reuse: true })`. Those
 * call sites are the allowlist. A call with any boot override stays private.
 * `CENTRS_CHR_REUSE=0` turns reuse off for diagnosis or rollback; every opted-in
 * call then boots privately, exactly as before.
 *
 * Snapshots do not cover host state: host files, CDBs, known-hosts, sockets
 * and subprocesses stay the test's own cleanup. Connections opened before a
 * restore are dead after it; tests connect fresh after each acquisition.
 */

/** The snapshot every lease restores. */
export const BASELINE_SNAPSHOT = "centrs-baseline";

/** At most this many replacement boots per reuse owner (per process). */
export const MAX_REPLACEMENTS = 1;

/**
 * What the reuse owner needs from a booted instance. Kept abstract so the lease
 * and failure logic is unit-testable without QEMU.
 */
export interface ReuseHooks<C> {
	/** Boot a fresh default CHR, ready for use. */
	boot(): Promise<C>;
	/** Save the baseline snapshot and verify it exists. */
	saveBaseline(instance: C): Promise<void>;
	/**
	 * Leave a marker in guest RAM that a successful restore must erase. Best
	 * effort: a broken router may refuse it, and the restore that follows is
	 * what decides whether the instance is usable.
	 */
	markDirty(instance: C): Promise<void>;
	/** Restore the baseline snapshot. */
	restoreBaseline(instance: C): Promise<void>;
	/** Bounded readiness after a boot or restore; throws when not ready. */
	ready(instance: C): Promise<void>;
	/** Throws when the `markDirty` marker survived, i.e. the restore did not happen. */
	assertClean(instance: C): Promise<void>;
	/** Stop and delete the instance. */
	remove(instance: C): Promise<void>;
	/** Diagnostics sink (stderr in the real harness). */
	log(message: string): void;
}

export interface ReuseStats {
	boots: number;
	restores: number;
	replacements: number;
	privateFallbacks: number;
	/** Wall time of each restore (markDirty → assertClean), in ms. */
	restoreMs: number[];
}

export interface ReuseLease<C> {
	instance: C;
	/** Release the lease. Idempotent. Does not remove the VM. */
	release(): void;
}

export interface ChrReuse<C> {
	/**
	 * A clean leased instance, or `undefined` when the lease is held and the
	 * caller must boot a private CHR instead.
	 */
	acquire(): Promise<ReuseLease<C> | undefined>;
	/** Remove the owned VM, if any. Idempotent; later acquisitions throw. */
	dispose(): Promise<void>;
	readonly stats: ReuseStats;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function summarizeReuseStats(stats: ReuseStats): string {
	const sorted = [...stats.restoreMs].sort((a, b) => a - b);
	const median =
		sorted.length === 0
			? undefined
			: sorted.length % 2 === 1
				? sorted[(sorted.length - 1) / 2]
				: ((sorted[sorted.length / 2 - 1] ?? 0) +
						(sorted[sorted.length / 2] ?? 0)) /
					2;
	const max = sorted.at(-1);
	const timing =
		median === undefined || max === undefined
			? ""
			: ` (restore+ready median ${(median / 1000).toFixed(2)}s, max ${(max / 1000).toFixed(2)}s)`;
	return `CHR reuse: ${stats.boots} boot(s), ${stats.restores} restore(s)${timing}, ${stats.replacements} replacement(s), ${stats.privateFallbacks} private fallback(s)`;
}

export function createChrReuse<C>(hooks: ReuseHooks<C>): ChrReuse<C> {
	const stats: ReuseStats = {
		boots: 0,
		restores: 0,
		replacements: 0,
		privateFallbacks: 0,
		restoreMs: [],
	};
	let owned: C | undefined;
	let leased = false;
	let disposed = false;

	async function bootWithBaseline(): Promise<C> {
		const instance = await hooks.boot();
		stats.boots += 1;
		try {
			await hooks.ready(instance);
			await hooks.saveBaseline(instance);
		} catch (error) {
			await removeQuietly(instance);
			throw error;
		}
		return instance;
	}

	async function removeQuietly(instance: C): Promise<void> {
		try {
			await hooks.remove(instance);
		} catch (error) {
			hooks.log(
				`CHR reuse: removing a discarded CHR failed: ${describeError(error)}`,
			);
		}
	}

	async function restore(instance: C): Promise<void> {
		const started = Date.now();
		try {
			await hooks.markDirty(instance);
		} catch (error) {
			hooks.log(
				`CHR reuse: dirty marker not set (${describeError(error)}); restoring anyway`,
			);
		}
		await hooks.restoreBaseline(instance);
		await hooks.ready(instance);
		await hooks.assertClean(instance);
		stats.restores += 1;
		stats.restoreMs.push(Date.now() - started);
	}

	function lease(instance: C): ReuseLease<C> {
		leased = true;
		let released = false;
		return {
			instance,
			release() {
				if (released) return;
				released = true;
				leased = false;
			},
		};
	}

	return {
		stats,
		async acquire() {
			if (disposed) {
				throw new Error("CHR reuse: acquire() after dispose()");
			}
			if (leased) {
				stats.privateFallbacks += 1;
				hooks.log(
					"CHR reuse: the shared CHR is still leased (an earlier test did not release it); booting a private CHR for this acquisition",
				);
				return undefined;
			}
			// Claim the lease before any await so a concurrent acquire falls back.
			leased = true;
			try {
				if (owned === undefined) {
					owned = await bootWithBaseline();
					return lease(owned);
				}
				try {
					await restore(owned);
					return lease(owned);
				} catch (error) {
					const suspect = owned;
					owned = undefined;
					hooks.log(
						`CHR reuse: restoring the baseline failed (${describeError(error)}); discarding the CHR`,
					);
					await removeQuietly(suspect);
					if (stats.replacements >= MAX_REPLACEMENTS) {
						throw new Error(
							`CHR reuse: baseline restore failed and the replacement budget (${MAX_REPLACEMENTS}) is spent; refusing to run against an uncertain router. Rerun with CENTRS_CHR_REUSE=0 to diagnose with private boots. Last error: ${describeError(error)}`,
						);
					}
					stats.replacements += 1;
					hooks.log(
						"CHR reuse: booting one replacement CHR with a new baseline",
					);
					owned = await bootWithBaseline();
					return lease(owned);
				}
			} catch (error) {
				leased = false;
				throw error;
			}
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			const instance = owned;
			owned = undefined;
			if (instance !== undefined) {
				await removeQuietly(instance);
			}
			if (stats.boots > 0 || stats.privateFallbacks > 0) {
				hooks.log(summarizeReuseStats(stats));
			}
		},
	};
}
