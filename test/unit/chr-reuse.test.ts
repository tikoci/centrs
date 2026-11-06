import { describe, expect, test } from "bun:test";
import {
	createChrReuse,
	MAX_REPLACEMENTS,
	type ReuseHooks,
	summarizeReuseStats,
} from "../integration/chr-reuse.ts";

interface FakeChr {
	id: number;
	dirty: boolean;
	removed: boolean;
}

interface FakeOptions {
	/** Make the n-th restore (1-based, across instances) throw. */
	failRestores?: number[];
	/** Make restore a silent no-op (the marker survives). */
	silentRestore?: boolean;
	/** Make every dirty-marker write throw. */
	failMarker?: boolean;
	/** Make the n-th boot (1-based) throw. */
	failBoots?: number[];
}

function fakeHooks(options: FakeOptions = {}) {
	const instances: FakeChr[] = [];
	const logs: string[] = [];
	let boots = 0;
	let restores = 0;
	const hooks: ReuseHooks<FakeChr> = {
		async boot() {
			boots += 1;
			if (options.failBoots?.includes(boots)) {
				throw new Error(`boot ${boots} failed`);
			}
			const chr = { id: boots, dirty: false, removed: false };
			instances.push(chr);
			return chr;
		},
		async saveBaseline() {},
		async markDirty(chr) {
			if (options.failMarker) throw new Error("marker write failed");
			chr.dirty = true;
		},
		async restoreBaseline(chr) {
			restores += 1;
			if (options.failRestores?.includes(restores)) {
				throw new Error(`restore ${restores} failed`);
			}
			if (!options.silentRestore) chr.dirty = false;
		},
		async ready() {},
		async assertClean(chr) {
			if (chr.dirty) throw new Error("marker survived");
		},
		async remove(chr) {
			chr.removed = true;
		},
		log(message) {
			logs.push(message);
		},
	};
	return { hooks, instances, logs };
}

describe("createChrReuse", () => {
	test("boots once, then restores for every later acquisition", async () => {
		const { hooks, instances } = fakeHooks();
		const reuse = createChrReuse(hooks);
		for (let i = 0; i < 4; i++) {
			const lease = await reuse.acquire();
			expect(lease?.instance).toBe(instances[0] as FakeChr);
			lease?.release();
		}
		expect(instances).toHaveLength(1);
		expect(reuse.stats.boots).toBe(1);
		expect(reuse.stats.restores).toBe(3);
		expect(reuse.stats.restoreMs).toHaveLength(3);
	});

	test("an acquisition while the lease is held falls back to private", async () => {
		const { hooks } = fakeHooks();
		const reuse = createChrReuse(hooks);
		const first = await reuse.acquire();
		expect(first).toBeDefined();
		expect(await reuse.acquire()).toBeUndefined();
		expect(reuse.stats.privateFallbacks).toBe(1);
		first?.release();
		expect(await reuse.acquire()).toBeDefined();
	});

	test("concurrent first acquisitions never share a lease", async () => {
		const { hooks } = fakeHooks();
		const reuse = createChrReuse(hooks);
		const [a, b] = await Promise.all([reuse.acquire(), reuse.acquire()]);
		expect([a, b].filter((lease) => lease !== undefined)).toHaveLength(1);
		expect(reuse.stats.boots).toBe(1);
	});

	test("release is idempotent and never removes the VM", async () => {
		const { hooks, instances } = fakeHooks();
		const reuse = createChrReuse(hooks);
		const lease = await reuse.acquire();
		lease?.release();
		lease?.release();
		expect(instances[0]?.removed).toBe(false);
		const next = await reuse.acquire();
		expect(next).toBeDefined();
		// A stale release from the first lease must not free the second.
		lease?.release();
		expect(await reuse.acquire()).toBeUndefined();
	});

	test("a failed restore discards the VM and boots one replacement", async () => {
		const { hooks, instances, logs } = fakeHooks({ failRestores: [1] });
		const reuse = createChrReuse(hooks);
		(await reuse.acquire())?.release();
		const lease = await reuse.acquire();
		expect(lease?.instance).toBe(instances[1] as FakeChr);
		expect(instances[0]?.removed).toBe(true);
		expect(reuse.stats.replacements).toBe(1);
		expect(logs.some((line) => line.includes("restore 1 failed"))).toBe(true);
	});

	test("a restore that silently does nothing is caught by the marker", async () => {
		const { hooks, instances } = fakeHooks({ silentRestore: true });
		const reuse = createChrReuse(hooks);
		(await reuse.acquire())?.release();
		const lease = await reuse.acquire();
		// The marker survived, so the first VM was replaced with a fresh one.
		expect(lease?.instance).toBe(instances[1] as FakeChr);
		expect(instances[0]?.removed).toBe(true);
	});

	test("a failed marker write is a failed restore, never an unproven lease", async () => {
		const { hooks, instances, logs } = fakeHooks({ failMarker: true });
		const reuse = createChrReuse(hooks);
		(await reuse.acquire())?.release();
		const lease = await reuse.acquire();
		// Without the marker a silent restore would be invisible, so the first
		// VM is discarded and the lease goes to the replacement.
		expect(lease?.instance).toBe(instances[1] as FakeChr);
		expect(instances[0]?.removed).toBe(true);
		expect(reuse.stats.restores).toBe(0);
		expect(reuse.stats.replacements).toBe(1);
		expect(logs.some((line) => line.includes("marker write failed"))).toBe(
			true,
		);
	});

	test("fails closed once the replacement budget is spent", async () => {
		const { hooks } = fakeHooks({ failRestores: [1, 2] });
		const reuse = createChrReuse(hooks);
		(await reuse.acquire())?.release();
		(await reuse.acquire())?.release(); // restore 1 fails → replacement
		expect(reuse.stats.replacements).toBe(MAX_REPLACEMENTS);
		await expect(reuse.acquire()).rejects.toThrow(/replacement budget/);
		// The failure releases the lease claim; the owner holds no VM now.
		expect(reuse.stats.boots).toBe(2);
	});

	test("a failed replacement boot throws instead of handing out a router", async () => {
		const { hooks } = fakeHooks({ failRestores: [1], failBoots: [2] });
		const reuse = createChrReuse(hooks);
		(await reuse.acquire())?.release();
		await expect(reuse.acquire()).rejects.toThrow(/boot 2 failed/);
	});

	test("a baseline that cannot be saved removes the booted VM", async () => {
		const { hooks, instances } = fakeHooks();
		hooks.saveBaseline = async () => {
			throw new Error("savevm failed");
		};
		const reuse = createChrReuse(hooks);
		await expect(reuse.acquire()).rejects.toThrow(/savevm failed/);
		expect(instances[0]?.removed).toBe(true);
	});

	test("dispose removes the owned VM once and blocks later acquisitions", async () => {
		const { hooks, instances, logs } = fakeHooks();
		const reuse = createChrReuse(hooks);
		(await reuse.acquire())?.release();
		await reuse.dispose();
		await reuse.dispose();
		expect(instances[0]?.removed).toBe(true);
		expect(
			logs.filter((line) => line.startsWith("CHR reuse: 1 boot")),
		).toHaveLength(1);
		await expect(reuse.acquire()).rejects.toThrow(/after dispose/);
	});
});

describe("summarizeReuseStats", () => {
	test("reports median and max restore time", () => {
		expect(
			summarizeReuseStats({
				boots: 1,
				restores: 3,
				replacements: 0,
				privateFallbacks: 0,
				restoreMs: [3000, 1000, 2000],
			}),
		).toBe(
			"CHR reuse: 1 boot(s), 3 restore(s) (restore+ready median 2.00s, max 3.00s), 0 replacement(s), 0 private fallback(s)",
		);
	});

	test("omits timing when nothing was restored", () => {
		expect(
			summarizeReuseStats({
				boots: 1,
				restores: 0,
				replacements: 0,
				privateFallbacks: 0,
				restoreMs: [],
			}),
		).toBe(
			"CHR reuse: 1 boot(s), 0 restore(s), 0 replacement(s), 0 private fallback(s)",
		);
	});
});
