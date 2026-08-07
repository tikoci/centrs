#!/usr/bin/env bun
/**
 * Generate `src/explain/catalog.ts` — the RouterOS path catalog (#228).
 *
 * This file is the network half: fetch MikroTik's published CLI Reference and
 * the pinned restraml inspect trees, hand both to
 * `explain-catalog-data.ts`, write or check the result.
 * Everything else — why the table exists, what it may and may not claim, the
 * alias allowlist and its assertions — lives in that module.
 *
 * The fetch is vendored, not delegated: it talks to manual.mikrotik.com
 * directly, with no build or runtime dependency on tikoci/rosetta.
 *
 * Usage:
 *   bun run explain:catalog                # regenerate src/explain/catalog.ts
 *   bun run explain:catalog --check        # drift gate: fail if it differs
 *   bun run explain:catalog --cache=DIR    # reuse/populate a local page cache
 *
 * `--check` needs network (CLI Reference plus the pinned trees), so it hangs off
 * the QA workflow rather than the offline `lint:ci` gate. A full run is ~230
 * small page fetches plus 15 MB of trees, about 15 seconds.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	build,
	CLI_PREFIX,
	cliRefSlugs,
	countTypeMarkers,
	MANUAL_BASE,
	parsePage,
	render,
	SITEMAP_URL,
} from "./explain-catalog-data.ts";
import { fetchTextWithRetry } from "./fetch-retry.ts";
import { fetchPinnedTrees, mergeTreeTypes } from "./restraml-trees.ts";

const OUTPUT_PATH = join(import.meta.dir, "..", "src", "explain", "catalog.ts");
const CONCURRENCY = 4;

const cacheDir = ((): string | null => {
	const raw = process.argv
		.find((arg) => arg.startsWith("--cache="))
		?.slice("--cache=".length);
	if (raw === undefined) return null;
	const dir = resolve(isAbsolute(raw) ? raw : join(process.cwd(), raw));
	mkdirSync(dir, { recursive: true });
	return dir;
})();

/** Cache file for a slug, refusing any name that escapes the cache directory. */
function cachePath(slug: string): string {
	if (cacheDir === null) throw new Error("no cache directory");
	const target = resolve(cacheDir, `${slug.replace(/\//g, "__")}.md`);
	const rel = relative(cacheDir, target);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
		throw new Error(`slug ${JSON.stringify(slug)} escapes the cache directory`);
	return target;
}

async function fetchPage(slug: string): Promise<string> {
	if (cacheDir !== null) {
		try {
			return readFileSync(cachePath(slug), "utf8");
		} catch {
			// not cached yet
		}
	}
	const text = await fetchTextWithRetry(
		`${MANUAL_BASE}${CLI_PREFIX}${slug}.md`,
	);
	// codeql[js/http-to-file-access] `--cache` is an opt-in maintainer flag that
	// stores fetched Markdown for local iteration; the response body is parsed by
	// `parsePage`, never executed, and `cachePath` constrains the file name to a
	// sitemap-validated slug inside the chosen directory.
	if (cacheDir !== null) writeFileSync(cachePath(slug), text);
	return text;
}

async function mapConcurrent<T, U>(
	items: readonly T[],
	limit: number,
	map: (item: T) => Promise<U>,
): Promise<U[]> {
	const results = new Array<U>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			const item = items[index];
			if (item === undefined) throw new Error(`missing item at index ${index}`);
			results[index] = await map(item);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => worker()),
	);
	return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const sitemapXml = await fetchTextWithRetry(SITEMAP_URL);
const slugs = cliRefSlugs(sitemapXml);
console.log(`cli-reference: ${slugs.length} pages`);

let fetched = 0;
const parsed = await mapConcurrent(slugs, CONCURRENCY, async (slug) => {
	const markdown = await fetchPage(slug);
	const entries = parsePage(slug, markdown);
	const markers = countTypeMarkers(markdown);
	if (markers !== entries.length)
		throw new Error(
			`${slug}: ${markers} Type markers but ${entries.length} parsed entries — the source format moved`,
		);
	fetched++;
	if (fetched % 50 === 0 || fetched === slugs.length)
		console.log(`cli-reference: parsed ${fetched}/${slugs.length}`);
	return entries;
});
const publishedEntries = parsed.flat();
console.log(`cli-reference: ${publishedEntries.length} entries`);

const extracts = await fetchPinnedTrees();
// Aborts on a cross-tree `dir`↔`cmd` flip, exactly as the menu generator does.
// Last-write-wins here would let a published kind be validated against whichever
// tree happened to sort last.
const treeTypes = mergeTreeTypes(extracts);
const treeContainers = new Set<string>();
for (const extract of extracts)
	for (const path of extract.containers) treeContainers.add(path);

const rows = build(publishedEntries, treeTypes, treeContainers);
const content = render(rows, {
	pages: slugs.length,
	publishedEntries: publishedEntries.length,
	trees: extracts.map((extract) => ({
		arch: extract.arch,
		file: extract.file,
		nodes: extract.nodes,
		version: extract.version,
	})),
});
console.log(
	`catalog: ${rows.length} paths (${rows.filter((r) => r.provenance === "both").length} both, ` +
		`${rows.filter((r) => r.provenance === "inspect").length} inspect, ` +
		`${rows.filter((r) => r.provenance === "published").length} published)`,
);

if (process.argv.includes("--check")) {
	const existing = await Bun.file(OUTPUT_PATH)
		.text()
		.catch(() => "");
	if (existing !== content) {
		console.error(
			"src/explain/catalog.ts is out of date with its two sources.\n" +
				"Run `bun run explain:catalog` and commit the result. If the change is\n" +
				"unexpected, review the diff before committing it: a path changing kind,\n" +
				"or losing device provenance, changes what callers may conclude from it.",
		);
		process.exit(1);
	}
	console.log("src/explain/catalog.ts matches its two sources.");
} else {
	await Bun.write(OUTPUT_PATH, content);
	console.log(`wrote ${OUTPUT_PATH}`);
}
