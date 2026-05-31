import { describe, expect, test } from "bun:test";
import type { MndpNeighbor } from "../../src/data/mndp.ts";
import {
	MNDP_CACHE_DEFAULT_TTL_MS,
	MndpCache,
} from "../../src/data/mndp-cache.ts";

function neighbor(mac: string, identity?: string): MndpNeighbor {
	return {
		sequence: 0,
		macAddress: mac,
		identity,
		unknownTlvs: [],
	};
}

describe("MndpCache", () => {
	test("defaults to a 180s TTL", () => {
		expect(MNDP_CACHE_DEFAULT_TTL_MS).toBe(180_000);
		expect(new MndpCache().timeToLiveMs).toBe(180_000);
	});

	test("expires an entry once TTL elapses since last seen", () => {
		let clock = 1_000;
		const cache = new MndpCache({ ttlMs: 1_000, now: () => clock });
		cache.observe(neighbor("aa:aa:aa:aa:aa:aa"));

		clock = 1_500;
		expect(cache.size()).toBe(1);
		expect(cache.get("aa:aa:aa:aa:aa:aa")).toBeDefined();

		clock = 2_000; // exactly TTL after lastSeenAt -> expired
		expect(cache.get("aa:aa:aa:aa:aa:aa")).toBeUndefined();
		expect(cache.size()).toBe(0);
		expect(cache.neighbors()).toHaveLength(0);
	});

	test("re-observing refreshes lastSeenAt and keeps firstSeenAt", () => {
		let clock = 0;
		const cache = new MndpCache({ ttlMs: 1_000, now: () => clock });
		cache.observe(neighbor("bb:bb:bb:bb:bb:bb", "first"));

		clock = 800;
		cache.observe(neighbor("bb:bb:bb:bb:bb:bb", "second"));

		clock = 1_500; // 700ms after the refresh -> still alive
		const entry = cache.get("bb:bb:bb:bb:bb:bb");
		expect(entry).toBeDefined();
		expect(entry?.firstSeenAt).toBe(0);
		expect(entry?.lastSeenAt).toBe(800);
		expect(entry?.neighbor.identity).toBe("second");
	});

	test("prune removes only expired entries", () => {
		let clock = 0;
		const cache = new MndpCache({ ttlMs: 1_000, now: () => clock });
		cache.observe(neighbor("11:11:11:11:11:11"));
		clock = 600;
		cache.observe(neighbor("22:22:22:22:22:22"));

		clock = 1_200; // first expired, second alive (observed at 600)
		expect(cache.prune()).toBe(1);
		expect(cache.size()).toBe(1);
		expect(cache.get("22:22:22:22:22:22")).toBeDefined();
	});

	test("entries are sorted deterministically by key", () => {
		const cache = new MndpCache({ ttlMs: 10_000, now: () => 0 });
		cache.observe(neighbor("ff:00:00:00:00:00"));
		cache.observe(neighbor("00:00:00:00:00:01"));
		cache.observe(neighbor("aa:00:00:00:00:00"));
		expect(cache.entries().map((entry) => entry.key)).toEqual([
			"00:00:00:00:00:01",
			"aa:00:00:00:00:00",
			"ff:00:00:00:00:00",
		]);
	});
});
