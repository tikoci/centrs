/**
 * In-memory MNDP neighbor cache with a TTL/expiry policy.
 *
 * MNDP devices announce themselves every `discover-interval` (30s by default
 * since 7.16, 60s before) and reply to a refresh within about 2s (lab-observed), so the natural shape is a short-lived cache keyed by
 * MAC that forgets neighbors which stop announcing. This is a process-local
 * cache only — the CDB remains the single durable datastore (see
 * `docs/CONSTITUTION.md`); nothing here is persisted.
 *
 * TTL decision (folded into `commands/discover/README.md`): an entry expires
 * the sender's advertised TLV 19 TTL (7.24+) after it was last seen, or
 * {@link MNDP_CACHE_DEFAULT_TTL_MS} (180s: three of the older 60s announce
 * cycles, six of the current 30s default) when the sender does not advertise
 * one. A TTL of `0` is a dying gasp and removes
 * the entry at once. The clock is injectable so expiry is deterministic in
 * tests.
 */

import { type MndpNeighbor, mndpNeighborKey } from "./mndp.ts";

/** Neighbor TTL when the sender advertises none: several announce cycles (30s or 60s). */
export const MNDP_CACHE_DEFAULT_TTL_MS = 180_000;

export interface MndpCacheEntry {
	/** Cache key (lower-cased MAC, or a synthetic key for MAC-less packets). */
	key: string;
	/** Most recent decoded announcement for this key. */
	neighbor: MndpNeighbor;
	/** Epoch ms when this key was first observed in the cache's lifetime. */
	firstSeenAt: number;
	/** Epoch ms when this key was last observed; drives expiry. */
	lastSeenAt: number;
	/** Lifetime after `lastSeenAt`: the advertised TTL, else the cache default. */
	ttlMs: number;
}

export interface MndpCacheOptions {
	/** Time-to-live in ms after `lastSeenAt` when the sender advertises no TTL. Default 180000. */
	ttlMs?: number;
	/** Clock injection (epoch ms). Defaults to `Date.now`. */
	now?: () => number;
}

/** A neighbor cache that expires entries TTL ms after they were last seen. */
export class MndpCache {
	private readonly ttlMs: number;
	private readonly clock: () => number;
	private readonly store = new Map<string, MndpCacheEntry>();

	constructor(options: MndpCacheOptions = {}) {
		this.ttlMs = options.ttlMs ?? MNDP_CACHE_DEFAULT_TTL_MS;
		this.clock = options.now ?? Date.now;
	}

	/** TTL this cache applies to neighbors that advertise none, in milliseconds. */
	get timeToLiveMs(): number {
		return this.ttlMs;
	}

	private isExpired(entry: MndpCacheEntry, at: number): boolean {
		return at - entry.lastSeenAt >= entry.ttlMs;
	}

	/**
	 * Record a freshly decoded neighbor. Upserts by {@link mndpNeighborKey},
	 * refreshing `lastSeenAt` and replacing the stored announcement, and returns
	 * the resulting entry. A dying gasp (`ttlSeconds === 0`) instead removes the
	 * key and returns `undefined`: its packet carries only MAC and addresses, so
	 * it must not replace the full announcement.
	 */
	observe(
		neighbor: MndpNeighbor,
		at: number = this.clock(),
	): MndpCacheEntry | undefined {
		const key = mndpNeighborKey(neighbor);
		if (neighbor.ttlSeconds === 0) {
			this.store.delete(key);
			return undefined;
		}
		const existing = this.store.get(key);
		const firstSeenAt =
			existing && !this.isExpired(existing, at) ? existing.firstSeenAt : at;
		const entry: MndpCacheEntry = {
			key,
			neighbor,
			firstSeenAt,
			lastSeenAt: at,
			ttlMs:
				neighbor.ttlSeconds === undefined
					? this.ttlMs
					: neighbor.ttlSeconds * 1000,
		};
		this.store.set(key, entry);
		return entry;
	}

	/** Look up a single neighbor by MAC (case-insensitive); skips expired ones. */
	get(mac: string, at: number = this.clock()): MndpCacheEntry | undefined {
		const entry = this.store.get(mac.toLowerCase());
		if (!entry || this.isExpired(entry, at)) {
			return undefined;
		}
		return entry;
	}

	/** Drop expired entries; returns the number removed. */
	prune(at: number = this.clock()): number {
		let removed = 0;
		for (const [key, entry] of this.store) {
			if (this.isExpired(entry, at)) {
				this.store.delete(key);
				removed += 1;
			}
		}
		return removed;
	}

	/** Number of non-expired entries currently held. */
	size(at: number = this.clock()): number {
		let count = 0;
		for (const entry of this.store.values()) {
			if (!this.isExpired(entry, at)) {
				count += 1;
			}
		}
		return count;
	}

	/** Live entries sorted by cache key (deterministic ordering). */
	entries(at: number = this.clock()): readonly MndpCacheEntry[] {
		const live: MndpCacheEntry[] = [];
		for (const entry of this.store.values()) {
			if (!this.isExpired(entry, at)) {
				live.push(entry);
			}
		}
		return live.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	}

	/** Live neighbors sorted by cache key (deterministic ordering). */
	neighbors(at: number = this.clock()): readonly MndpNeighbor[] {
		return this.entries(at).map((entry) => entry.neighbor);
	}

	/** Remove every entry. */
	clear(): void {
		this.store.clear();
	}
}
