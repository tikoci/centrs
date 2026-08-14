/**
 * Everything `src/explain/catalog.ts` is made of, minus the network: parsing
 * MikroTik's published CLI Reference, unioning it with the pinned inspect trees,
 * asserting the alias allowlist, and rendering the module.
 *
 * This is a module, not an entry point — `gen-explain-catalog.ts` fetches the
 * two sources and calls it. The split is what makes the safety-critical parts
 * (the loud-fail parser, the R1/R2 alias assertions, the kind-contradiction
 * abort) testable without a network.
 *
 * The catalog itself is the RouterOS **path catalog**: what each path IS
 * (menu / command / settings menu), which source said so, and the published
 * applicability gate that explains its absence from a CHR (#228).
 *
 * ## Two first-order sources, different axes
 *
 * `src/explain/menus.ts` (#207) bakes the container set from four pinned
 * `/console/inspect` trees. That answers "is this navigation?" and nothing else:
 * it has no command axis at all, and no tree can carry a menu gated to hardware
 * no CHR has.
 *
 * MikroTik's CLI Reference (`manual.mikrotik.com/docs/cli-reference`) is the
 * other first-order source. It is generated from the definition structs — the
 * `typ=` strings are a dumped internal type grammar with `:0` ordinals, and
 * `Package` / `Conditions` / `Syscap` are build-time gates no documentation
 * author writes by hand.
 *
 * It USED to publish the DEFINITION-MODULE spelling rather than the CLI
 * spelling, which is why `caps-man/acl/access-list` was documented and yet
 * unreachable on a device over `/console/inspect`, REST and the native API
 * alike (#228, five independent oracles). MikroTik has since reshaped the
 * publication from module pages into per-command leaf pages whose slug IS the
 * CLI path, and those spellings are gone (#285). {@link ALIASES} is empty as a
 * result — still asserted, still able to refuse the next one.
 *
 * So neither source is a superset and neither is "more accurate" outright.
 * inspect is first-order about the **CLI surface**; CLI Reference is first-order
 * about the **definition structs and their gates**. This table unions them and
 * records, per entry, which one carried it.
 *
 * Measured across 968 exactly-matching paths, three RouterOS versions and two
 * architectures, the two sources have **zero kind contradictions** — they have
 * never disagreed about whether something is a menu or a command. That is the
 * assertion this generator aborts on, and the one worth watching.
 *
 * The publication does disagree with ITSELF on a narrower axis: seven paths are
 * published twice on one page under different hardware gates, and two of those
 * pairs split `Directory` against `Settings Directory` (`/system/health`,
 * `/interface/ethernet/switch`). Both halves say the path is navigation, so the
 * row records that and drops the refinement, exactly as a disagreed gate is
 * dropped rather than picked. Only a navigation-vs-command split aborts.
 *
 * ## What is NOT here
 *
 * Arguments, flags, types, enums and descriptions. For a Directory the
 * publication never says WHICH verb accepts a given field, and that join cannot
 * be invented; read-only rows are outputs, never inputs; parameter names drift
 * fastest; and their `typ=` strings are a third provenance axis #225 has not
 * settled. Argument names ARE parsed here, but only to assert the alias
 * allowlist below — they are never emitted.
 *
 * This is a structure table, not a schema. It says what a path is. It never
 * says what a command accepts.
 *
 * ## Absence still never rejects
 *
 * A path in neither source is not in the table, and a caller that does not find
 * a path must abstain, exactly as with `menus.ts`. Absence costs precision,
 * never correctness. A `gate` never decides anything offline either: it is
 * provenance for the EXPLANATION ("published for PoE hardware; this router was
 * not consulted"), not a claim about any target.
 *
 * ## Provenance and vendoring
 *
 * The ETL is vendored, not imported: the generator fetches manual.mikrotik.com
 * directly and has no build or runtime dependency on tikoci/rosetta. The
 * Markdown parser is adapted from tikoci/rosetta `src/extract-cliref.ts` at
 * commit 34f1d32a9823d6dabcacc070d3884b45956d3f43 (MIT, copyright tikoci, 2026).
 *
 * Published documentation is not device truth. Only a live router can establish
 * its version, platform, installed packages, hardware capabilities, undocumented
 * behaviour, or runtime acceptance.
 *
 * Deliberately NOT baked into the output: a page-content or inventory hash.
 * `--check` must fail on STRUCTURE drift, and a content hash would fire it on
 * any upstream prose edit. Watching content drift is the audit's job (#228
 * step 3), not the gate's.
 */

import { CONTAINER_TYPES } from "./restraml-trees.ts";

export const MANUAL_BASE = "https://manual.mikrotik.com";
export const SITEMAP_URL = `${MANUAL_BASE}/sitemap.xml`;
export const LLMS_TXT_URL = `${MANUAL_BASE}/llms.txt`;
export const CLI_PREFIX = "/docs/cli-reference/";
const CLI_SLUG = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
/**
 * The section landing page: the argument-type glossary prose. It is listed in
 * `llms.txt` like any other `.md`, but publishes no `**Type:**` entry, so it is
 * not a CLI path and the loud-fail parser would (correctly) reject it.
 */
const SECTION_INDEX_SLUG = "index";

/**
 * Published doc spelling -> real CLI spelling. HAND-AUDITED; the generator
 * never rewrites a path on its own.
 *
 * **Empty, and correct as empty (#285).** MikroTik reshaped the CLI Reference
 * from module pages — one page carrying many command headings, in the
 * DEFINITION-MODULE spelling — into per-command leaf pages whose slug IS the
 * CLI path. All twenty entries this list used to carry (fifteen `caps-man`
 * definition modules plus `easymesh`, `serial-interface`, `ddns`, `ifaces`,
 * `queues`) are gone from the source, and each one's target is now published
 * directly under its real path. Re-audited against the corrected 1,070-page
 * inventory: zero of the twenty sources survive, twenty of twenty targets are
 * published outright.
 *
 * The machinery stays, and stays asserted, because an allowlist that expects
 * zero hits is exactly what should refuse the next one loudly. Generation
 * ABORTS on any of these, and every abort wants a hand decision, not an entry:
 *
 *   R0 stale source — an alias whose `from` is no longer published. That is what
 *      caught this reshape (`/caps-man/acl/access-list` vanished) rather than
 *      the table quietly keeping a dead rewrite.
 *   R1 prefix scoping — never drop segment `S` when the prefix ENDING at `S` is
 *      itself a published entry. The naive rule ("drop an interior segment until
 *      something matches a tree") maps `/interface/ethernet/poe/monitor` onto
 *      `/interface/ethernet/monitor`, a different command with a disjoint field
 *      set; `poe`, `qos`, `acl`, `controller` and `route` are real CLI menu
 *      segments. An unscoped allowlist of segment names is the defect filed as
 *      tikoci/rosetta#136 and fixed in tikoci/rosetta#138.
 *   R2 field overlap — where both sides publish argument names, they must
 *      overlap. This is the offline proof that two spellings are the same
 *      command rather than a coincidental name collision.
 *
 * A new hit is a signal to read the source, not to normalize it away.
 */
export const ALIASES: ReadonlyMap<string, string> = new Map<string, string>();

// ---------------------------------------------------------------------------
// CLI-Reference ETL (vendored; see the header)
// ---------------------------------------------------------------------------

export type EntryKind = "Command" | "Directory" | "Settings Directory";
const KNOWN_ENTRY_TYPES = new Set<EntryKind>([
	"Directory",
	"Settings Directory",
	"Command",
]);

export interface PublishedEntry {
	/** Heading text verbatim, normalized to a leading slash and lower case. */
	path: string;
	kind: EntryKind;
	package: string | null;
	conditions: string | null;
	syscap: string | null;
	/** Argument names, for the R2 assertion only. Never emitted. */
	fields: Set<string>;
	/** Rows consumed, flags included, so every source marker can be reconciled. */
	rows: number;
	slug: string;
	line: number;
}

function decodeXml(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/**
 * The CLI-Reference path a link names, or `null` when it names something else.
 *
 * `base` is the document the link was read FROM, so a relative link resolves
 * the way a browser would. Both inventories publish absolute URLs today, but a
 * relative one must not vanish: `new URL(link)` alone throws on `/docs/…` and
 * on `./app/app.md`, and this returning `null` is indistinguishable from "not a
 * CLI page". Resolving against the base is what keeps the two cases apart.
 */
function cliRefPath(location: string, base: string): string | null {
	let path: string;
	try {
		path = new URL(location, base).pathname;
	} catch {
		return null;
	}
	return path.startsWith(CLI_PREFIX) ? path : null;
}

/** The slug a CLI-Reference page path names, or `null` when it is not a page. */
function pageSlug(path: string): string | null {
	if (path.endsWith("/")) return null;
	const slug = path.slice(CLI_PREFIX.length).replace(/\.md$/, "");
	if (slug === "" || slug === SECTION_INDEX_SLUG || !CLI_SLUG.test(slug))
		return null;
	return slug;
}

/** Every directly-addressable CLI-Reference page the sitemap lists. */
export function sitemapSlugs(sitemapXml: string): string[] {
	const slugs = new Set<string>();
	for (const match of sitemapXml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/g)) {
		const path = cliRefPath(decodeXml(match[1] ?? ""), SITEMAP_URL);
		const slug = path === null ? null : pageSlug(path);
		if (slug !== null) slugs.add(slug);
	}
	return [...slugs].sort();
}

/**
 * Every BRANCHING menu the sitemap serves as a trailing-slash category URL, as
 * the slug of the page that carries its own entry: `app/` -> `app/app`.
 *
 * The section root itself (`/docs/cli-reference/`) is not a menu and is skipped.
 */
export function categoryLeafSlugs(sitemapXml: string): string[] {
	const slugs = new Set<string>();
	for (const match of sitemapXml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/g)) {
		const path = cliRefPath(decodeXml(match[1] ?? ""), SITEMAP_URL);
		if (path === null || !path.endsWith("/")) continue;
		const dir = path.slice(CLI_PREFIX.length).replace(/\/$/, "");
		if (dir === "" || !CLI_SLUG.test(dir)) continue;
		slugs.add(`${dir}/${dir.split("/").pop()}`);
	}
	return [...slugs].sort();
}

/** Every CLI-Reference page `llms.txt` lists. */
export function llmsSlugs(llmsTxt: string): string[] {
	const slugs = new Set<string>();
	for (const match of llmsTxt.matchAll(/^-\s*\[[^\]]*\]\(([^)\s]+)\)/gm)) {
		const path = cliRefPath(match[1] ?? "", LLMS_TXT_URL);
		const slug = path === null ? null : pageSlug(path);
		if (slug !== null) slugs.add(slug);
	}
	return [...slugs].sort();
}

/**
 * The page inventory: the union of the two published inventories, or abort.
 *
 * The sitemap alone is NOT the inventory, and its shortfall is silent. A menu
 * that BRANCHES is served as a trailing-slash category URL with no `.md` of its
 * own — but the menu's own `Directory` entry is published, at
 * `<dir>/<basename(dir)>.md` (`app/` -> `app/app.md`), and listed only in
 * `llms.txt`. Sitemap-only discovery therefore dropped 256 of 1,070 pages, and
 * the field-heavy quarter of them: `app/app` carries 35 argument rows,
 * `caps-man/interface/interface` 79 (tikoci/rosetta#137, centrs #285).
 *
 * `<dir>.md`, `<dir>/index.md` and `<dir>/.md` all 404, which is what made this
 * read as a navigation stub for months. A 404 on a probe is evidence about the
 * probe, not about the page.
 *
 * The two inventories reconcile exactly, and this asserts it rather than
 * trusting either one:
 *
 *   sitemap pages 814 ∪ derived <dir>/<basename> 256  = 1,070 = llms.txt pages
 *
 * The category-leaf reconciliation is the ABORT, because a category dir whose
 * leaf no inventory carries is a menu entry being dropped — the #285 defect
 * itself, and invisible in the output. A page only one inventory lists is
 * reported instead of refused: the union already carries it, so nothing is
 * dropped, and `--check` fails on the new row anyway.
 *
 * BOTH one-sided directions are reported, but they are not symmetric, and the
 * asymmetry is the shape itself. Every sitemap page is also in `llms.txt`, so a
 * sitemap-only page is bare drift. `llms.txt` has 256 pages the sitemap lacks —
 * that is not drift, it IS the category leaves, so reporting them all would be
 * noise that buries the signal. What is reported is the residue: an `llms.txt`
 * page that is neither in the sitemap nor a category leaf, i.e. one that
 * appears from nowhere.
 */
export function discoverSlugs(
	sitemapXml: string,
	llmsTxt: string,
	report: (message: string) => void = console.warn,
): string[] {
	const sitemap = new Set(sitemapSlugs(sitemapXml));
	const llms = new Set(llmsSlugs(llmsTxt));
	const leaves = new Set(categoryLeafSlugs(sitemapXml));
	const inventory = new Set([...sitemap, ...llms]);

	const orphans = [...leaves].filter((slug) => !inventory.has(slug));
	if (orphans.length > 0)
		throw new Error(
			`${orphans.length} sitemap category dir(s) contribute no <dir>/<basename> leaf to the\n` +
				"discovered inventory (sitemap ∪ llms.txt), so those menus' own entries would be\n" +
				"dropped silently — the #285 defect. Re-verify the inventory by hand:\n  " +
				orphans.join("\n  "),
		);

	const sitemapOnly = [...sitemap].filter((slug) => !llms.has(slug));
	if (sitemapOnly.length > 0)
		report(
			`${sitemapOnly.length} page(s) are in the sitemap but not in llms.txt — the two ` +
				`published inventories no longer agree in shape: ${sitemapOnly.join(", ")}`,
		);

	const unaccounted = [...llms].filter(
		(slug) => !sitemap.has(slug) && !leaves.has(slug),
	);
	if (unaccounted.length > 0)
		report(
			`${unaccounted.length} page(s) are in llms.txt but are neither in the sitemap nor a ` +
				`category leaf, so the sitemap no longer accounts for them: ${unaccounted.join(", ")}`,
		);

	return [...inventory].sort();
}

/**
 * Drop the Docusaurus preamble: the H1 title and the `import {…}` lines. The
 * page body starts after the last import, which is what makes every remaining
 * heading an entry heading.
 *
 * Splits on `\r?\n` and rejoins with `\n`, so the body every caller re-splits is
 * already normalized (#282). A Windows checkout converts these fixtures to CRLF,
 * which left a trailing `\r` on every line: `parsePage` matches marker VALUES
 * exactly, so `**Type:** Menu` arrived as `"Menu\r"` and no entry ever found its
 * Type — six frozen-page tests failed on `windows-latest` and passed on macOS.
 * This normalizes line endings ONLY; every fail-loud check downstream is
 * unchanged, because a page whose format really moved must still throw.
 */
function pageBody(markdown: string): { body: string; startLine: number } {
	const lines = markdown.split(/\r?\n/);
	let lastImport = -1;
	for (let index = 0; index < lines.length; index++)
		if (/^import\s*\{/.test(lines[index] ?? "")) lastImport = index;
	let start = lastImport + 1;
	while (
		start < lines.length &&
		((lines[start] ?? "").trim() === "" ||
			/^-{3,}$/.test((lines[start] ?? "").trim()))
	)
		start++;
	return { body: lines.slice(start).join("\n"), startLine: start + 1 };
}

/**
 * Parse one CLI-Reference page into its entries.
 *
 * Fails loud rather than skipping: an unknown `Type`, a duplicated marker or a
 * heading with no `Type` at all means the source format moved, and silently
 * dropping the entry would silently shrink the table.
 */
export function parsePage(slug: string, markdown: string): PublishedEntry[] {
	const { body, startLine } = pageBody(markdown);
	const lines = body.split("\n");
	const entries: PublishedEntry[] = [];
	const seenMarkers = new Map<PublishedEntry, Set<string>>();
	let current: PublishedEntry | null = null;
	let inFence = false;
	/** `c1` of the open `<ArgTable>`: `Flag`, `Argument` or `Read-only Argument`. */
	let table: string | null = null;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const sourceLine = startLine + index;
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
		if (heading) {
			current = {
				conditions: null,
				fields: new Set(),
				rows: 0,
				kind: "Directory",
				line: sourceLine,
				package: null,
				path: `/${(heading[1] ?? "").trim().replace(/^\/+/, "").toLowerCase()}`,
				slug,
				syscap: null,
			};
			entries.push(current);
			seenMarkers.set(current, new Set());
			continue;
		}
		if (current === null) continue;

		const marker = line.match(
			/^\*\*(Type|Package|Conditions|Syscap):\*\*\s*(.*)$/,
		);
		if (marker) {
			const name = marker[1] ?? "";
			const markers = seenMarkers.get(current);
			if (markers?.has(name))
				throw new Error(
					`${slug}: duplicate ${name} marker at line ${sourceLine}`,
				);
			markers?.add(name);
			const value = (marker[2] ?? "").trim() || null;
			if (name === "Type") {
				if (value === null || !KNOWN_ENTRY_TYPES.has(value as EntryKind))
					throw new Error(
						`${slug}: unknown entry Type ${JSON.stringify(value)} at line ${sourceLine}`,
					);
				current.kind = value as EntryKind;
			} else if (name === "Package") current.package = value;
			else if (name === "Conditions") current.conditions = value;
			else current.syscap = value;
			continue;
		}

		// Argument rows, for the R2 alias assertion only. A `c1="Flag"` table names
		// print flags rather than arguments, so its rows are skipped.
		//
		// EVERY `<ArgTable` opening is recognized, not only one carrying a known
		// `c1` on the same line. If the source ever splits the tag across lines or
		// drops the header, the alternative is worse than a crash: `table` would
		// keep its previous value and the new table's rows would be attributed to
		// the wrong kind — flags read as arguments, silently.
		if (line.startsWith("<ArgTable ") || line.startsWith("<ArgTable>")) {
			table = line.match(/\bc1="([^"]*)"/)?.[1] ?? null;
			if (
				table !== "Flag" &&
				table !== "Argument" &&
				table !== "Read-only Argument"
			)
				throw new Error(
					`${slug}: unknown ArgTable c1 header ${JSON.stringify(table)} at line ${sourceLine}`,
				);
			continue;
		}
		if (line.startsWith("</ArgTable>")) {
			table = null;
			continue;
		}
		// EVERY row marker must be accounted for, not only the ones the anchored
		// pattern happens to read. A row this parser cannot parse yields an empty
		// field set, and an empty field set makes the R2 alias guard skip — so a
		// single changed quote upstream would silently disarm the check while
		// `--check` stayed green, because fields are never emitted.
		const markers = line.match(/<ArgTableRow\b/g)?.length ?? 0;
		if (markers === 0) continue;
		if (markers > 1)
			throw new Error(
				`${slug}: ${markers} ArgTableRow markers on line ${sourceLine} — one row per line is assumed`,
			);
		if (table === null)
			throw new Error(
				`${slug}: ArgTableRow outside any ArgTable at line ${sourceLine}`,
			);
		const row = line.match(/^<ArgTableRow\b[^>]*\barg="([^"]*)"/);
		if (row === null)
			throw new Error(
				`${slug}: unreadable ArgTableRow at line ${sourceLine}: ${JSON.stringify(line.slice(0, 80))}`,
			);
		current.rows++;
		if (table !== "Flag")
			current.fields.add(decodeXml(row[1] ?? "").toLowerCase());
	}

	for (const entry of entries)
		if (!seenMarkers.get(entry)?.has("Type"))
			throw new Error(
				`${slug}: entry ${JSON.stringify(entry.path)} at line ${entry.line} has no Type marker`,
			);
	return entries;
}

/** Count `**Type:**` markers outside fences, to reconcile against the parse. */
export function countTypeMarkers(markdown: string): number {
	let count = 0;
	let inFence = false;
	for (const line of pageBody(markdown).body.split("\n")) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (!inFence && /^\*\*Type:\*\*/.test(line)) count++;
	}
	return count;
}

/**
 * Count `<ArgTableRow` markers outside fences, to reconcile against the parse.
 *
 * The entry count alone is not enough. Rows are the only input to the R2 alias
 * guard and are never emitted, so a row the parser silently dropped would leave
 * both the generated file and `--check` unchanged while the guard quietly
 * stopped guarding.
 */
export function countRowMarkers(markdown: string): number {
	let count = 0;
	let inFence = false;
	for (const line of pageBody(markdown).body.split("\n")) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) count += line.match(/<ArgTableRow\b/g)?.length ?? 0;
	}
	return count;
}

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export type PathKind = "menu" | "command" | "settings";
export type PathProvenance = "inspect" | "published" | "both";

export interface CatalogRow {
	path: string;
	kind: PathKind;
	provenance: PathProvenance;
	package?: string;
	conditions?: string;
	syscap?: string;
}

const PUBLISHED_KINDS: Readonly<Record<EntryKind, PathKind>> = {
	Command: "command",
	Directory: "menu",
	"Settings Directory": "settings",
};

/** Tree node types that AGREE with a published kind. */
function agrees(kind: PathKind, treeType: string): boolean {
	return kind === "command"
		? treeType === "cmd"
		: CONTAINER_TYPES.has(treeType);
}

/**
 * The indices of the segments an alias drops.
 *
 * Every allowed alias removes whole interior segments and keeps the rest in
 * order, so the target must be a SUBSEQUENCE of the source. Anything else is
 * not a drop-alias, R1 would not be defined on it, and generation stops.
 */
export function droppedSegments(from: string, to: string): number[] {
	const fromSegments = from.split("/").filter(Boolean);
	const toSegments = to.split("/").filter(Boolean);
	const dropped: number[] = [];
	let cursor = 0;
	for (let index = 0; index < fromSegments.length; index++) {
		if (fromSegments[index] === toSegments[cursor]) cursor++;
		else dropped.push(index);
	}
	if (cursor !== toSegments.length)
		throw new Error(
			`alias ${from} -> ${to} is not a segment drop — the target must be a subsequence of the source`,
		);
	return dropped;
}

/**
 * Fold the published entries onto their CLI paths, applying the alias allowlist
 * and asserting it.
 *
 * Seven paths are published twice, each on one page, under different hardware
 * gates — `/interface/ethernet/switch` and its four children as `musicswitch`
 * and `rbswitch`, `/system/health` as `!i386` and `health`. One entry per page
 * is therefore NOT an invariant, and a key on path would reject real source. A
 * gate is kept only where every occurrence states it, because one ungated
 * occurrence means the path is not uniformly gated and claiming the gate would
 * over-state the publication.
 */
function foldPublished(
	entries: readonly PublishedEntry[],
	treeTypes: ReadonlyMap<string, string>,
	aliases: ReadonlyMap<string, string>,
): Map<string, PublishedEntry[]> {
	const byPath = new Map<string, PublishedEntry[]>();
	const publishedPaths = new Set(entries.map((entry) => entry.path));

	for (const [from, to] of aliases) {
		const source = entries.find((entry) => entry.path === from);
		if (source === undefined)
			throw new Error(
				`alias source ${from} is no longer a published entry — re-audit the allowlist`,
			);
		for (const index of droppedSegments(from, to)) {
			// R1: the prefix ending at each dropped segment must not be published.
			const segments = from.split("/").filter(Boolean);
			const prefix = `/${segments.slice(0, index + 1).join("/")}`;
			if (publishedPaths.has(prefix))
				throw new Error(
					`alias ${from} -> ${to} drops ${JSON.stringify(segments[index])}, but ${prefix} is itself a published entry — a real menu segment, not a documentation module`,
				);
		}
		const targetType = treeTypes.get(to);
		if (targetType === undefined)
			throw new Error(
				`alias target ${to} is in no pinned tree — re-audit the allowlist`,
			);
		const kind = PUBLISHED_KINDS[source.kind];
		if (!agrees(kind, targetType))
			throw new Error(
				`alias ${from} -> ${to}: published ${kind} vs tree ${targetType}`,
			);
	}

	for (const entry of entries) {
		const path = aliases.get(entry.path) ?? entry.path;
		const bucket = byPath.get(path);
		if (bucket) bucket.push(entry);
		else byPath.set(path, [entry]);
	}
	return byPath;
}

/** R2: an aliased command must share argument names with its tree target. */
function assertFieldOverlap(
	byPath: ReadonlyMap<string, PublishedEntry[]>,
	treeTypes: ReadonlyMap<string, string>,
	aliases: ReadonlyMap<string, string>,
): void {
	for (const [from, to] of aliases) {
		const published = byPath.get(to)?.find((entry) => entry.path === from);
		if (published === undefined || published.fields.size === 0) continue;
		const treeArgs = new Set<string>();
		for (const [path, type] of treeTypes) {
			if (type !== "arg" || !path.startsWith(`${to}/`)) continue;
			const leaf = path.slice(to.length + 1);
			if (!leaf.includes("/")) treeArgs.add(leaf);
		}
		if (treeArgs.size === 0) continue;
		const overlap = [...published.fields].filter((name) => treeArgs.has(name));
		if (overlap.length === 0)
			throw new Error(
				`alias ${from} -> ${to}: ${published.fields.size} published arguments and ${treeArgs.size} tree arguments with NO overlap — these are different commands`,
			);
	}
}

/**
 * R3: a `command` row is a LEAF — no catalog path descends from it.
 *
 * `commandVerbIndex` in the emitted module walks a path run root-first and
 * returns the FIRST prefix that is a command, calling that segment the verb.
 * That is only unambiguous while no command has a descendant: with one, a run
 * could carry two command prefixes and the reading would depend on the walk
 * direction rather than on the evidence. Today the property holds outright
 * (0 violations over 439 commands), which is why the consumer can be a lookup
 * instead of a policy.
 *
 * Asserted here rather than assumed in `catalog.ts`, for the reason the
 * `mergeTreeTypes` round taught: a consumer's precondition belongs with the
 * generator that can still refuse to emit.
 */
function assertCommandLeaves(rows: readonly CatalogRow[]): void {
	const paths = new Set(rows.map((row) => row.path));
	const descended: string[] = [];
	for (const row of rows) {
		if (row.kind !== "command") continue;
		for (const path of paths)
			if (path.startsWith(`${row.path}/`))
				descended.push(`${row.path} < ${path}`);
	}
	if (descended.length > 0)
		throw new Error(
			"a command row has a descendant, so a path run could carry two command\n" +
				"prefixes and `commandVerbIndex` would have to choose between them.\n" +
				"Decide by hand which of the two is the command:\n  " +
				descended.join("\n  "),
		);
}

/**
 * Union the two sources into the catalog rows, or abort.
 *
 * `aliases` is a parameter only so tests can exercise one rule at a time; the
 * generator always uses {@link ALIASES}, and a subset would silently leave doc
 * spellings in the table.
 */
export function build(
	published: readonly PublishedEntry[],
	treeTypes: ReadonlyMap<string, string>,
	treeContainers: ReadonlySet<string>,
	aliases: ReadonlyMap<string, string> = ALIASES,
): CatalogRow[] {
	const byPath = foldPublished(published, treeTypes, aliases);
	assertFieldOverlap(byPath, treeTypes, aliases);

	const rows = new Map<string, CatalogRow>();
	const contradictions: string[] = [];

	for (const [path, occurrences] of byPath) {
		const kinds = new Set(
			occurrences.map((entry) => PUBLISHED_KINDS[entry.kind]),
		);
		// Occurrences that disagree about navigation-vs-executable are a real
		// contradiction. Occurrences that disagree only about `menu` vs `settings`
		// are not: both say the path is navigation, and they differ on whether THIS
		// hardware's menu holds a single record — `/system/health` is a settings
		// menu on `!i386` and a directory under the `health` syscap, on one page.
		// Record what they agree on, exactly as a disagreed gate is dropped rather
		// than picked. Nothing downstream distinguishes the two kinds anyway
		// (`isKnownMenu` accepts either), so the weaker claim costs nothing.
		if (kinds.size > 1 && kinds.has("command")) {
			contradictions.push(
				`${path}: published as ${[...kinds].sort().join(" and ")} on ${occurrences.map((e) => e.slug).join(", ")}`,
			);
			continue;
		}
		const kind: PathKind = kinds.size > 1 ? "menu" : ([...kinds][0] ?? "menu");
		const treeType = treeTypes.get(path);
		if (treeType !== undefined && !agrees(kind, treeType)) {
			contradictions.push(
				`${path}: published ${kind}, tree ${treeType} (${occurrences.map((e) => e.slug).join(", ")})`,
			);
			continue;
		}
		// A gate survives only if every occurrence of the path states it.
		const gateOf = (pick: (entry: PublishedEntry) => string | null) => {
			const values = new Set(occurrences.map(pick));
			const only = [...values][0];
			return values.size === 1 && only !== null ? only : undefined;
		};
		rows.set(path, {
			conditions: gateOf((entry) => entry.conditions),
			kind,
			package: gateOf((entry) => entry.package),
			path,
			provenance: treeType === undefined ? "published" : "both",
			syscap: gateOf((entry) => entry.syscap),
		});
	}

	if (contradictions.length > 0)
		throw new Error(
			"CLI Reference and the pinned inspect trees disagree about what these paths ARE.\n" +
				"That has never happened before (0 across 906 exact matches, three versions,\n" +
				"two architectures), so it is a real event, not noise: decide it by hand\n" +
				"rather than letting either source win silently.\n  " +
				contradictions.join("\n  "),
		);

	// Containers the trees know and the publication does not. Tree COMMANDS are
	// deliberately not enumerated: they are overwhelmingly the generic CRUD
	// leaves `VERBS` already owns, and adding ~10k of them would bury the 440
	// non-generic published commands that are the point of this table.
	for (const path of treeContainers)
		if (!rows.has(path))
			rows.set(path, { kind: "menu", path, provenance: "inspect" });

	const sorted = [...rows.values()].sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	);
	assertCommandLeaves(sorted);
	return sorted;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * One `|`-separated row: path, kind, provenance, package, conditions, syscap,
 * with trailing empty columns trimmed.
 *
 * The table is emitted as text inside a template literal rather than as ~1,100
 * object literals for two reasons: one line per path keeps the review diff
 * readable and greppable, and the formatter leaves template-literal contents
 * alone, so the generator and Biome cannot fight over how a row is wrapped.
 *
 * `|` is safe as a separator only as long as no emitted value contains one,
 * which is asserted rather than assumed — along with backticks, `${`,
 * backslashes and newlines, any of which would corrupt the literal.
 */
function renderRow(row: CatalogRow): string {
	const columns = [
		row.path,
		row.kind,
		row.provenance,
		row.package ?? "",
		row.conditions ?? "",
		row.syscap ?? "",
	];
	for (const column of columns) {
		if (/[|`\\\r\n\t]/.test(column) || column.includes("${"))
			throw new Error(
				`value ${JSON.stringify(column)} on ${row.path} cannot be emitted as a template-literal row`,
			);
	}
	while (columns.at(-1) === "") columns.pop();
	return columns.join("|");
}

export interface Counts {
	pages: number;
	publishedEntries: number;
	trees: { arch: string; version: string; file: string; nodes: number }[];
}

export function render(rows: readonly CatalogRow[], counts: Counts): string {
	const tally = (predicate: (row: CatalogRow) => boolean): string =>
		rows.filter(predicate).length.toLocaleString("en-US");
	const byKind = (kind: PathKind): string =>
		`${[
			` * | \`${kind}\``,
			tally((row) => row.kind === kind),
			tally((row) => row.kind === kind && row.provenance === "both"),
			tally((row) => row.kind === kind && row.provenance === "inspect"),
			tally((row) => row.kind === kind && row.provenance === "published"),
		].join(" | ")} |`;

	// Measured here rather than quoted from the issue, so the emitted prose can
	// never claim a figure this generation did not produce.
	const gated = (row: CatalogRow | undefined): boolean =>
		row !== undefined &&
		(row.package !== undefined ||
			row.conditions !== undefined ||
			row.syscap !== undefined);
	const byPath = new Map(rows.map((row) => [row.path, row]));
	const ungated = rows.filter(
		(row) => row.provenance === "published" && !gated(row),
	);
	const residue = ungated.filter((row) => {
		const segments = row.path.split("/").filter(Boolean);
		for (let depth = 1; depth < segments.length; depth++)
			if (gated(byPath.get(`/${segments.slice(0, depth).join("/")}`)))
				return false;
		return true;
	});
	const ungatedRows = ungated.length.toLocaleString("en-US");
	const residueRows = residue.length.toLocaleString("en-US");

	const trees = counts.trees
		.map(
			(tree) =>
				` * | \`${tree.file}\` | ${tree.arch} | ${tree.version} | ${tree.nodes.toLocaleString("en-US")} |`,
		)
		.join("\n");

	return `/**
 * RouterOS path catalog — GENERATED, do not hand-edit.
 *
 * Regenerate with \`bun run explain:catalog\`; \`bun run explain:catalog --check\`
 * is the drift gate. The generator (\`scripts/gen-explain-catalog.ts\`) carries
 * the full rationale, the vendored-ETL provenance, and the alias allowlist with
 * its two safety assertions.
 *
 * Union of two first-order sources (#228):
 *
 * 1. MikroTik's published CLI Reference (\`${MANUAL_BASE}${CLI_PREFIX}\`),
 *    ${counts.pages.toLocaleString("en-US")} pages, ${counts.publishedEntries.toLocaleString("en-US")} entries — first-order about the definition
 *    structs and their build-time gates. Since #285 every page is a leaf whose
 *    slug is the CLI path, so no spelling has to be rewritten to be looked up.
 * 2. Four pinned restraml \`/console/inspect\` trees
 *    (\`https://tikoci.github.io/restraml/\`) — first-order about the CLI surface:
 *
 * | Tree | Arch | RouterOS | Nodes |
 * | ---- | ---- | -------- | ----- |
${trees}
 *
 * | Kind | Total | \`both\` | \`inspect\` | \`published\` |
 * | ---- | ----- | ------ | --------- | ----------- |
${byKind("menu")}
${byKind("command")}
${byKind("settings")}
 *
 * Zero navigation-vs-command contradictions between the two sources. Generation
 * aborts if that ever stops holding, rather than picking a winner. Where a path
 * is published twice as a container under different hardware gates — the seven
 * \`/interface/ethernet/switch\` and \`/system/health\` variants — the row records
 * what the occurrences agree on.
 *
 * **This table is not a schema.** It says what a path IS — navigation, an
 * executable command, or a settings menu — and never what a command accepts.
 * Arguments, types, enums and \`.proplist\` stay live-only evidence.
 *
 * **Absence never rejects.** A path in neither source is simply absent, and a
 * caller that does not find one must abstain. A gate never decides anything
 * offline either: it explains why a published path may be missing from a given
 * router ("PoE hardware only"), and no router was consulted to build this.
 *
 * **Gates conjoin down a path, so read them with {@link effectiveGates}, not
 * row by row.** A row states only what the publication stated at that entry.
 * Read row-wise, ${ungatedRows} published-only paths look ungated; read with
 * ancestry, the residue carrying no published explanation for its absence at
 * all is ${residueRows}.
 *
 * Tree COMMANDS are not enumerated — those are the generic CRUD leaves
 * \`verbs.ts\` already owns. The command rows here are the published,
 * overwhelmingly non-generic ones.
 */

/** What a path IS. \`settings\` is a menu whose contents are a single record. */
export type PathKind = "menu" | "command" | "settings";

/**
 * Which source carried an entry.
 *
 * \`inspect\` and \`both\` are device-confirmed: the path was observed on at least
 * one real \`/console/inspect\` tree. \`published\` is documentation evidence only
 * — usually a path gated to hardware no CHR has.
 */
export type PathProvenance = "inspect" | "published" | "both";

/**
 * One catalog row. The gate fields are MikroTik's published build-time
 * applicability markers, verbatim; they are provenance for an explanation, never
 * a claim about any particular router.
 */
export interface CatalogEntry {
	kind: PathKind;
	provenance: PathProvenance;
	/** Required RouterOS package, e.g. \`wireless-qca\`. */
	package?: string;
	/** Build conditions, e.g. \`!i386, !smips\`. */
	conditions?: string;
	/** Required system capability, e.g. \`poe\`, \`lcd\`, \`multiswitch\`. */
	syscap?: string;
}

/**
 * The catalog as text: one line per path, columns separated by \`|\` —
 * \`path|kind|provenance|package|conditions|syscap\` — with trailing empty
 * columns trimmed. Lower-cased, slash-led and sorted by path.
 *
 * Text rather than ~${rows.length.toLocaleString("en-US")} object literals so that one path is one line in a
 * review diff, and so the formatter has nothing to re-wrap.
 */
const ROWS = \`
${rows.map(renderRow).join("\n")}
\`;

const KINDS = new Set<string>(["menu", "command", "settings"]);
const PROVENANCES = new Set<string>(["inspect", "published", "both"]);

/**
 * Decode {@link ROWS} once, at module load.
 *
 * Throws rather than skipping a malformed row: this file is generated, so a row
 * that does not decode means the generator and this loader disagree, and a
 * silently shorter catalog would look exactly like a correct one.
 */
function decodeRows(text: string): Map<string, CatalogEntry> {
	const catalog = new Map<string, CatalogEntry>();
	for (const line of text.split("\\n")) {
		if (line === "") continue;
		const [path, kind, provenance, ...gates] = line.split("|");
		if (
			path === undefined ||
			kind === undefined ||
			provenance === undefined ||
			!KINDS.has(kind) ||
			!PROVENANCES.has(provenance)
		)
			throw new Error(\`catalog row is malformed: \${JSON.stringify(line)}\`);
		const [packageName, conditions, syscap] = gates;
		const entry: CatalogEntry = {
			kind: kind as PathKind,
			provenance: provenance as PathProvenance,
		};
		if (packageName) entry.package = packageName;
		if (conditions) entry.conditions = conditions;
		if (syscap) entry.syscap = syscap;
		catalog.set(path, entry);
	}
	return catalog;
}

/** Every catalog path, lower-cased and slash-led. */
export const PATH_CATALOG: ReadonlyMap<string, CatalogEntry> = decodeRows(ROWS);

/**
 * Look a path up by its SEGMENTS, so callers pass what they already parsed
 * rather than re-splitting a statement and re-deriving which spelling
 * (\`/ip/address\` or \`/ip address\`) it used. Both reduce to the same segments.
 *
 * Empty input is never a catalog entry: the bare \`/\` and \`..\` forms are decided
 * by their own rule.
 */
export function lookupPath(
	segments: readonly string[],
): CatalogEntry | undefined {
	if (segments.length === 0) return undefined;
	return PATH_CATALOG.get(\`/\${segments.join("/").toLowerCase()}\`);
}

/**
 * Where a published COMMAND ends inside a path run: the index of the run
 * segment that is the VERB, or \`null\` when no prefix of \`segments\` is one.
 *
 * This is the command half of V4. \`menus.ts\` answers "is this bare path a
 * menu?"; nothing answered "is it a command?", so \`/system/reboot\` and
 * \`/system/gps/monitor once\` were read by punctuation — which puts the verb on
 * \`once\`, not on \`monitor\`. A published command names its own boundary, so the
 * segments before it are the menu and everything after it is an argument.
 *
 * At most ONE prefix can match: no command row has a descendant (R3, asserted at
 * generation), so the walk direction cannot change the answer.
 *
 * Presence is load-bearing in one direction only, exactly as in \`menus.ts\`.
 * A hit is decisive — both catalog sources are first-order, and the 439 command
 * rows are \`both\` or \`published\`, never inspect-only. A MISS says nothing:
 * generic CRUD leaves are deliberately not enumerated here, so absence must
 * fall through to the schema-free rule rather than deny that a command exists.
 *
 * A gate is not consulted. Whether this router HAS the hardware is a live
 * question; what the segment IS is not.
 */
export function commandVerbIndex(segments: readonly string[]): number | null {
	for (let depth = 1; depth <= segments.length; depth++)
		if (
			PATH_CATALOG.get(\`/\${segments.slice(0, depth).join("/").toLowerCase()}\`)
				?.kind === "command"
		)
			return depth - 1;
	return null;
}

/** One published gate, and the path that published it. */
export interface CatalogGate {
	path: string;
	package?: string;
	conditions?: string;
	syscap?: string;
}

/**
 * Every gate that applies to a path, root-first — its own and its ancestors'.
 *
 * A row carries only what the publication stated AT that entry, which is the
 * honest thing for a row to carry but the wrong thing to read alone. Reaching
 * \`/interface/ethernet/poe/monitor\` requires \`/interface/ethernet/poe\`, so the
 * parent's \`syscap\` applies even though the child entry states none: the gates
 * up a path CONJOIN, they do not override.
 *
 * Read row-wise, ${ungatedRows} published-only paths look ungated; read with
 * ancestry the residue is ${residueRows}. The gap between the two is the
 * conjunction, and it is what a caller has to reproduce: a child's silence about
 * a gate is not the absence of one. #228's finding — that a published-only path
 * almost always explains its own absence — is about the ancestry-aware number.
 *
 * Still not a claim about any router. This says what MikroTik published about
 * applicability; only a live device knows what it has.
 */
export function effectiveGates(segments: readonly string[]): CatalogGate[] {
	const gates: CatalogGate[] = [];
	for (let depth = 1; depth <= segments.length; depth++) {
		const path = \`/\${segments.slice(0, depth).join("/").toLowerCase()}\`;
		const entry = PATH_CATALOG.get(path);
		if (entry === undefined) continue;
		const gate: CatalogGate = { path };
		if (entry.package !== undefined) gate.package = entry.package;
		if (entry.conditions !== undefined) gate.conditions = entry.conditions;
		if (entry.syscap !== undefined) gate.syscap = entry.syscap;
		if (Object.keys(gate).length > 1) gates.push(gate);
	}
	return gates;
}
`;
}
