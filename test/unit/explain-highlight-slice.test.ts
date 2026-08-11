import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Integrity anchors for the committed Q13 highlight slice (#186 workstream 3,
 * the fixture #263 measures against).
 *
 * These do NOT check the device's answers — every pair in the fixture is
 * verbatim `/console/inspect request=highlight` output and there is no second
 * oracle to check it against offline. What they check is that the file's own
 * HEADER still describes its own DATA: counts, coverage, the version-difference
 * encoding, and the stratification claim that makes a 70-script slice worth
 * measuring at all. That is the #260 lesson applied one file over — a generated
 * summary drifting from what it summarizes is silent, and here it would silently
 * turn a trend line into a number about a different set of scripts.
 *
 * Re-cut the fixture with `bun run explain:highlight-slice`, which needs the
 * ~7.5 MB per-version captures (`bun run explain:probe:highlight-recapture`).
 * This test needs only the committed fixture, which is why it can gate.
 */

type Pair = [text: string, cls: string];

interface Slice {
	baseVersion: string;
	versions: { version: string; routerosVersion: string }[];
	selection: {
		carriersPerCell: number;
		capturedScripts: number;
		universe: number;
		selected: number;
		versionDiffering: number;
		nonAsciiReplaced: number;
		cellsWithNoCarrier: string[];
		excluded: {
			truncatedOrMisaligned: string[];
			outsideFrozenSplit: string[];
		};
		classesInCapture: string[];
	};
	coverage: Record<string, number>;
	scripts: Record<
		string,
		{
			split: "dev" | "holdout";
			chars: number;
			streams: Record<string, Pair[] | null>;
		}
	>;
}

const slice = JSON.parse(
	readFileSync(
		new URL(
			"../fixtures/explain/highlight-streams.slice.json",
			import.meta.url,
		),
		"utf8",
	),
) as Slice;

const paths = Object.keys(slice.scripts);
const { baseVersion, selection } = slice;
const otherVersions = slice.versions
	.map((v) => v.version)
	.filter((v) => v !== baseVersion);

describe("explain highlight slice — the header describes the data", () => {
	test("selected count matches the script table", () => {
		expect(paths.length).toBe(selection.selected);
		expect(paths.length).toBeGreaterThan(0);
	});

	test("script keys are sorted and unique", () => {
		expect(paths).toEqual([...new Set(paths)].sort());
	});

	test("every script carries a base stream whose length matches `chars`", () => {
		for (const path of paths) {
			const entry = slice.scripts[path];
			if (!entry) throw new Error(`missing entry ${path}`);
			const base = entry.streams[baseVersion];
			expect(base, path).toBeArray();
			expect((base as Pair[]).length, path).toBeGreaterThan(0);
			const text = (base as Pair[]).map(([fragment]) => fragment).join("");
			expect(text.length, path).toBe(entry.chars);
		}
	});

	test("a run-length stream never repeats a class across adjacent runs", () => {
		// The capture collapses per-character classes into runs. Two adjacent runs
		// of the same class mean the collapse broke, and a consumer diffing run
		// boundaries would see phantom disagreements.
		for (const path of paths) {
			const entry = slice.scripts[path];
			if (!entry) throw new Error(`missing entry ${path}`);
			for (const version of [baseVersion, ...otherVersions]) {
				const pairs = entry.streams[version];
				if (!pairs) continue;
				for (let i = 1; i < pairs.length; i++) {
					expect(pairs[i]?.[1], `${path} @${version} run ${i}`).not.toBe(
						pairs[i - 1]?.[1],
					);
				}
			}
		}
	});

	test("`null` is the only encoding for a version that agrees with the base", () => {
		let differing = 0;
		for (const path of paths) {
			const entry = slice.scripts[path];
			if (!entry) throw new Error(`missing entry ${path}`);
			const base = JSON.stringify(entry.streams[baseVersion]);
			let differs = false;
			for (const version of otherVersions) {
				const other = entry.streams[version];
				expect(Object.hasOwn(entry.streams, version), path).toBe(true);
				if (other === null) continue;
				// A non-null stream that equals the base wastes bytes AND hides the
				// version-difference count behind a redundant copy.
				expect(JSON.stringify(other), `${path} @${version}`).not.toBe(base);
				differs = true;
			}
			if (differs) differing++;
		}
		expect(differing).toBe(selection.versionDiffering);
	});

	test("recomputed coverage equals the stored coverage", () => {
		const recomputed: Record<string, number> = {};
		for (const path of paths) {
			const entry = slice.scripts[path];
			if (!entry) throw new Error(`missing entry ${path}`);
			const classes = new Set<string>();
			for (const version of [baseVersion, ...otherVersions]) {
				for (const [, cls] of entry.streams[version] ?? []) classes.add(cls);
			}
			for (const cls of classes) {
				const cell = `${entry.split}|${cls}`;
				recomputed[cell] = (recomputed[cell] ?? 0) + 1;
			}
		}
		expect(recomputed).toEqual(slice.coverage);
	});

	test("coverage plus no-carrier cells is the whole (split × class) grid", () => {
		const grid = (["dev", "holdout"] as const)
			.flatMap((split) =>
				selection.classesInCapture.map((cls) => `${split}|${cls}`),
			)
			.sort();
		const accounted = [
			...Object.keys(slice.coverage),
			...selection.cellsWithNoCarrier,
		].sort();
		expect(accounted).toEqual(grid);
	});
});

describe("explain highlight slice — the stratification claim", () => {
	test("every class the capture saw has a carrier in the slice", () => {
		const present = new Set<string>();
		for (const path of paths) {
			for (const version of [baseVersion, ...otherVersions]) {
				for (const [, cls] of slice.scripts[path]?.streams[version] ?? []) {
					present.add(cls);
				}
			}
		}
		expect([...present].sort()).toEqual([...selection.classesInCapture].sort());
	});

	test("the rare classes the quota exists for are actually carried", () => {
		// These are the classes a naive "take N scripts" slice loses: each appears
		// in at most 20 of the 913 captured scripts, and `obj-disabled` in exactly
		// one. Losing them is the failure mode the per-cell quota prevents, so pin
		// them by name rather than trusting the rule that selected them.
		const rare = [
			"arg-dot",
			"arg-scope",
			"obj-disabled",
			"obj-dynamic",
			"syntax-obsolete",
			"variable-undefined",
		];
		for (const cls of rare) {
			expect(selection.classesInCapture, cls).toContain(cls);
			const carriers = paths.filter((path) =>
				[baseVersion, ...otherVersions].some((version) =>
					(slice.scripts[path]?.streams[version] ?? []).some(
						([, actual]) => actual === cls,
					),
				),
			);
			expect(carriers.length, `${cls} carriers`).toBeGreaterThan(0);
		}
	});

	test("both sides of the frozen split are represented", () => {
		const splits = new Set(paths.map((path) => slice.scripts[path]?.split));
		expect([...splits].sort()).toEqual(["dev", "holdout"]);
	});

	test("no selected script is one the rule excluded", () => {
		const excluded = new Set([
			...selection.excluded.truncatedOrMisaligned,
			...selection.excluded.outsideFrozenSplit,
		]);
		for (const path of paths) expect(excluded.has(path), path).toBe(false);
	});

	test("the universe accounts for every captured script", () => {
		expect(
			selection.universe +
				selection.excluded.truncatedOrMisaligned.length +
				selection.excluded.outsideFrozenSplit.length,
		).toBe(selection.capturedScripts);
		expect(selection.selected).toBeLessThanOrEqual(selection.universe);
	});
});
