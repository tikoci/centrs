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
	type CatalogRow,
	CLI_PREFIX,
	cliRefSlugs,
	countRowMarkers,
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
	// Rows are never emitted, so only this reconciliation can notice that the
	// parser stopped reading them — and an unread row disarms the R2 alias guard
	// without changing the generated file.
	const rowMarkers = countRowMarkers(markdown);
	const parsedRows = entries.reduce((sum, entry) => sum + entry.rows, 0);
	if (rowMarkers !== parsedRows)
		throw new Error(
			`${slug}: ${rowMarkers} ArgTableRow markers but ${parsedRows} parsed rows — the source format moved`,
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

function parseCommittedCatalog(text: string): Map<string, CatalogRow> | null {
	const match = text.match(/const ROWS = `\n([\s\S]*?)\n`;\n/);
	if (match === null) return null;
	const body = match[1] ?? "";
	const out = new Map<string, CatalogRow>();
	for (const line of body.split("\n")) {
		if (line === "") continue;
		const parts = line.split("|");
		const path = parts[0];
		const kind = parts[1];
		const provenance = parts[2];
		if (
			path === undefined ||
			kind === undefined ||
			provenance === undefined ||
			!["menu", "command", "settings"].includes(kind) ||
			!["inspect", "published", "both"].includes(provenance)
		)
			continue;
		const row: CatalogRow = {
			kind: kind as CatalogRow["kind"],
			path,
			provenance: provenance as CatalogRow["provenance"],
		};
		const pkg = parts[3];
		const cond = parts[4];
		const syscap = parts[5];
		if (pkg) row.package = pkg;
		if (cond) row.conditions = cond;
		if (syscap) row.syscap = syscap;
		out.set(path, row);
	}
	return out;
}

function formatGate(row: CatalogRow): string {
	const parts: string[] = [];
	if (row.package) parts.push(`package=${JSON.stringify(row.package)}`);
	if (row.conditions)
		parts.push(`conditions=${JSON.stringify(row.conditions)}`);
	if (row.syscap) parts.push(`syscap=${JSON.stringify(row.syscap)}`);
	return parts.length > 0 ? parts.join(" ") : "(none)";
}

function buildDriftReport(
	committed: Map<string, CatalogRow> | null,
	freshRows: readonly CatalogRow[],
): string {
	const fresh = new Map(freshRows.map((row) => [row.path, row]));
	const lines: string[] = [];

	lines.push("### `src/explain/catalog.ts` is out of date");
	lines.push("");
	lines.push("MikroTik's CLI Reference is current-only, so this fires on any");
	lines.push("structural change upstream. It is a REPORT, not a gate: nothing");
	lines.push("is blocked, including releases.");
	lines.push("");
	lines.push("To adopt the change: `bun run explain:catalog` and commit.");
	lines.push("Read the diff first — a path changing kind, or losing device");
	lines.push("provenance, changes what a caller may conclude from it.");
	lines.push("");

	if (committed === null) {
		lines.push(
			`Fresh catalog has ${fresh.size} paths; committed file could not be parsed (binary diff).`,
		);
		lines.push("");
		lines.push(
			"Run `bun run explain:catalog` and review `git diff src/explain/catalog.ts`.",
		);
		return lines.join("\n");
	}

	const countBy = (
		map: ReadonlyMap<string, CatalogRow>,
		predicate: (row: CatalogRow) => boolean,
	): number => {
		let n = 0;
		for (const row of map.values()) if (predicate(row)) n++;
		return n;
	};

	lines.push(
		`Row counts — committed ${committed.size.toLocaleString("en-US")} → fresh ${fresh.size.toLocaleString("en-US")} (Δ ${(fresh.size - committed.size).toLocaleString("en-US")})`,
	);
	lines.push("");
	lines.push("| Provenance | Committed | Fresh |");
	lines.push("| --- | --- | --- |");
	for (const prov of ["both", "inspect", "published"] as const) {
		lines.push(
			`| \`${prov}\` | ${countBy(committed, (r) => r.provenance === prov).toLocaleString("en-US")} | ${countBy(fresh, (r) => r.provenance === prov).toLocaleString("en-US")} |`,
		);
	}
	lines.push("| Kind | Committed | Fresh |");
	lines.push("| --- | --- | --- |");
	for (const kind of ["menu", "command", "settings"] as const) {
		lines.push(
			`| \`${kind}\` | ${countBy(committed, (r) => r.kind === kind).toLocaleString("en-US")} | ${countBy(fresh, (r) => r.kind === kind).toLocaleString("en-US")} |`,
		);
	}
	lines.push("");

	const added: CatalogRow[] = [];
	const removed: CatalogRow[] = [];
	for (const [path, row] of fresh) if (!committed.has(path)) added.push(row);
	for (const [path, row] of committed) if (!fresh.has(path)) removed.push(row);
	added.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	removed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	const isPublishedRelated = (row: CatalogRow): boolean =>
		row.provenance !== "inspect";
	const addedPublished = added.filter(isPublishedRelated);
	const removedPublished = removed.filter(isPublishedRelated);

	const cap = 40;
	const formatRows = (rows: readonly CatalogRow[]): string[] =>
		rows
			.slice(0, cap)
			.map(
				(r) =>
					`- \`${r.path}\` — \`${r.kind}\` \`${r.provenance}\`${r.package || r.conditions || r.syscap ? ` — ${formatGate(r)}` : ""}`,
			);

	lines.push(
		`#### Published paths added (${addedPublished.length}) / removed (${removedPublished.length})`,
	);
	if (addedPublished.length === 0 && removedPublished.length === 0) {
		lines.push("No published-related paths added or removed.");
	} else {
		if (addedPublished.length > 0) {
			lines.push(`Added (${addedPublished.length}):`);
			lines.push(...formatRows(addedPublished));
			if (addedPublished.length > cap)
				lines.push(`- … and ${addedPublished.length - cap} more`);
		}
		if (removedPublished.length > 0) {
			lines.push(`Removed (${removedPublished.length}):`);
			lines.push(...formatRows(removedPublished));
			if (removedPublished.length > cap)
				lines.push(`- … and ${removedPublished.length - cap} more`);
		}
		if (
			added.length !== addedPublished.length ||
			removed.length !== removedPublished.length
		) {
			lines.push("");
			lines.push(
				`(Also ${added.length - addedPublished.length} inspect-only added, ${removed.length - removedPublished.length} inspect-only removed — omitted above.)`,
			);
		}
	}
	lines.push("");

	const provenanceFlips: string[] = [];
	const gateChanges: string[] = [];
	const kindChanges: string[] = [];
	for (const [path, freshRow] of fresh) {
		const old = committed.get(path);
		if (old === undefined) continue;
		if (old.provenance !== freshRow.provenance)
			provenanceFlips.push(
				`- \`${path}\` — \`${old.provenance}\` → \`${freshRow.provenance}\` (\`${freshRow.kind}\`)`,
			);
		if (old.kind !== freshRow.kind)
			kindChanges.push(
				`- \`${path}\` — \`${old.kind}\` → \`${freshRow.kind}\``,
			);
		const gateKeys: (keyof CatalogRow)[] = ["package", "conditions", "syscap"];
		const gateDiff = gateKeys.some(
			(key) => (old[key] ?? "") !== (freshRow[key] ?? ""),
		);
		if (gateDiff)
			gateChanges.push(
				`- \`${path}\` — ${formatGate(old)} → ${formatGate(freshRow)}`,
			);
	}
	provenanceFlips.sort();
	kindChanges.sort();
	gateChanges.sort();

	lines.push(`#### Provenance changes (${provenanceFlips.length})`);
	if (provenanceFlips.length === 0) lines.push("No provenance flips.");
	else {
		const bothToPublished = provenanceFlips.filter((line) =>
			line.includes("`both` → `published`"),
		);
		if (bothToPublished.length > 0) {
			lines.push(
				`Both → published (losing device confirmation, ${bothToPublished.length}):`,
			);
			lines.push(...bothToPublished.slice(0, cap));
			if (bothToPublished.length > cap)
				lines.push(`- … and ${bothToPublished.length - cap} more`);
		}
		const rest = provenanceFlips.filter(
			(line) => !line.includes("`both` → `published`"),
		);
		if (rest.length > 0) {
			if (bothToPublished.length > 0) lines.push("Other provenance flips:");
			lines.push(...rest.slice(0, cap));
			if (rest.length > cap) lines.push(`- … and ${rest.length - cap} more`);
		}
	}
	lines.push("");

	if (kindChanges.length > 0) {
		lines.push(
			`#### Kind changes (${kindChanges.length}) — generation would normally abort on contradictions`,
		);
		lines.push(...kindChanges.slice(0, cap));
		if (kindChanges.length > cap)
			lines.push(`- … and ${kindChanges.length - cap} more`);
		lines.push("");
	}

	lines.push(`#### Gate-string changes (${gateChanges.length})`);
	if (gateChanges.length === 0) lines.push("No gate changes.");
	else {
		lines.push(...gateChanges.slice(0, cap));
		if (gateChanges.length > cap)
			lines.push(`- … and ${gateChanges.length - cap} more`);
	}
	lines.push("");

	return lines.join("\n");
}

if (process.argv.includes("--check")) {
	const existing = await Bun.file(OUTPUT_PATH)
		.text()
		.catch(() => "");
	if (existing !== content) {
		const committed = parseCommittedCatalog(existing);
		const report = buildDriftReport(committed, rows);
		console.error(report);
		const driftFile = join(
			import.meta.dir,
			"..",
			".scratch",
			"explain-catalog-drift.md",
		);
		try {
			mkdirSync(join(import.meta.dir, "..", ".scratch"), { recursive: true });
			await Bun.write(driftFile, report);
		} catch {
			// best-effort
		}
		const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
		if (summaryPath) {
			try {
				await Bun.write(summaryPath, `${report}\n`);
			} catch {
				// summary is best-effort; the stderr report is the source of truth
			}
		}
		process.exit(1);
	}
	console.log("src/explain/catalog.ts matches its two sources.");
} else {
	await Bun.write(OUTPUT_PATH, content);
	console.log(`wrote ${OUTPUT_PATH}`);
}
