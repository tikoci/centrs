/**
 * Anchor tests for the RouterOS path catalog (#228) — the generated table and
 * the generator logic that is allowed to put something in it.
 *
 * `src/explain/catalog.ts` is GENERATED, so the arithmetic is not what is
 * tested here (`bun run explain:catalog --check` is the drift gate for that, and
 * it needs network, so it hangs off QA). Two things are:
 *
 *   1. **The contract the table must satisfy** before any analyzer may trust it:
 *      it never contradicts `menus.ts`, `inspect`/`both` really is
 *      device-confirmed, a gate never appears without published evidence, and an
 *      unknown path is simply absent.
 *   2. **The generator's refusals**, against frozen CLI-Reference pages. Those
 *      are the safety-critical part of #228 and the part a corpus cannot reach:
 *      the alias allowlist is the only place a wrong path can enter the table,
 *      and the naive rewrite it replaces maps `/interface/ethernet/poe/monitor`
 *      onto a different command.
 *
 * Step 2 connected the COMMAND axis to the analyzers, through
 * {@link commandVerbIndex}. What that consumer needs beyond the contract above
 * is R3 — a command row has no descendant — so it is asserted here, on both
 * sides: the generator refuses to emit a violation, and the shipped table is
 * checked against it.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	ALIASES,
	build,
	type CatalogRow,
	categoryLeafSlugs,
	countRowMarkers,
	countTypeMarkers,
	discoverSlugs,
	droppedSegments,
	llmsSlugs,
	type PublishedEntry,
	parsePage,
	sitemapSlugs,
} from "../../scripts/explain-catalog-data.ts";
import {
	type CatalogEntry,
	commandVerbIndex,
	effectiveGates,
	lookupPath,
	PATH_CATALOG,
} from "../../src/explain/catalog.ts";
import { MENU_PATHS } from "../../src/explain/menus.ts";
import { VERBS } from "../../src/explain/verbs.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "explain", "cliref");

const readFixture = async (name: string): Promise<string> =>
	await Bun.file(join(FIXTURES, name)).text();

// ---------------------------------------------------------------------------
// The committed table
// ---------------------------------------------------------------------------

describe("explain/catalog — the generated table", () => {
	/**
	 * The cross-table guarantee. `menus.ts` is the device-confirmed floor
	 * `write.ts` already trusts to mean "navigation"; if the catalog called one of
	 * those paths a command, the two tables would allow opposite readings of the
	 * same statement. Generation aborts on exactly this, so it should never fire —
	 * which is why it is worth pinning.
	 */
	test("never calls a known menu a command", () => {
		const wrong = [...MENU_PATHS].filter(
			(path) => PATH_CATALOG.get(path)?.kind === "command",
		);
		expect(wrong).toEqual([]);
	});

	test("carries every menu the pinned trees proved", () => {
		const missing = [...MENU_PATHS].filter((path) => !PATH_CATALOG.has(path));
		expect(missing).toEqual([]);
	});

	/**
	 * The command axis `menus.ts` does not have at all. `/system/reboot` carries
	 * no hyphen, so the pre-#207 shape rule read it as navigation; the menu table
	 * closed that by omission (abstain), and the catalog closes it by evidence.
	 * `/ip/dhcp-client/release` is the sharper one — a command inside a menu the
	 * menu table DOES carry, so the discrimination has to be per path.
	 */
	test("names the bare commands the menu table can only abstain on", () => {
		for (const path of [
			"/system/reboot",
			"/system/reset-configuration",
			"/ip/dhcp-client/release",
			"/interface/wireless/reset-configuration",
		]) {
			expect(PATH_CATALOG.get(path)?.kind).toBe("command");
			expect(MENU_PATHS.has(path)).toBe(false);
		}
	});

	/**
	 * And the limit of that, stated so it is not mistaken for a bug. `/disk
	 * format-drive` is in the #207 corpus but is not published and is not in any
	 * pinned tree (7.23.2 spells it `/disk format`), so it is simply absent —
	 * which costs precision, never correctness.
	 */
	test("a command neither source carries is absent, not guessed", () => {
		expect(PATH_CATALOG.has("/disk/format-drive")).toBe(false);
	});

	/**
	 * `inspect` provenance can only come from the container walk, so an
	 * `inspect`-only row is always a menu. A command row claiming device
	 * provenance without the publication would mean the union leaked.
	 */
	test("inspect-only rows are menus", () => {
		const wrong = [...PATH_CATALOG].filter(
			([, entry]) => entry.provenance === "inspect" && entry.kind !== "menu",
		);
		expect(wrong).toEqual([]);
	});

	/** A gate is published evidence; a row with no publication cannot have one. */
	test("only published rows carry gates", () => {
		const wrong = [...PATH_CATALOG].filter(
			([, entry]) =>
				entry.provenance === "inspect" &&
				(entry.package !== undefined ||
					entry.conditions !== undefined ||
					entry.syscap !== undefined),
		);
		expect(wrong).toEqual([]);
	});

	/**
	 * The hardware axis is the unique content: `/interface/ethernet/poe` and the
	 * switch-chip menus appear in real CRS/CCR exports and in no CHR-derived tree,
	 * and the publication says why.
	 */
	test("carries hardware-gated paths no pinned tree can confirm", () => {
		const poe = PATH_CATALOG.get("/interface/ethernet/poe");
		expect(poe?.provenance).toBe("published");
		expect(poe?.syscap).toBeDefined();
		expect(MENU_PATHS.has("/interface/ethernet/poe")).toBe(false);

		const partitions = PATH_CATALOG.get("/partitions");
		expect(partitions?.syscap).toBe("partitions");
		expect(partitions?.conditions).toBe("!i386, !smips, !mmips");
	});

	/**
	 * The definition-module spellings, read from the product side: the doc
	 * spelling must NOT be in the table and the CLI spelling must be, with device
	 * provenance.
	 *
	 * This used to be the alias layer's job. Since #285 the source publishes the
	 * CLI spelling directly and the doc spellings are gone, so the same two
	 * assertions now hold for a different reason — which is exactly why they stay:
	 * a regression in either direction is visible here whichever mechanism is
	 * responsible.
	 */
	test("resolves the caps-man definition-module spellings", () => {
		expect(PATH_CATALOG.has("/caps-man/acl/access-list")).toBe(false);
		expect(PATH_CATALOG.get("/caps-man/access-list")?.provenance).toBe("both");
		expect(PATH_CATALOG.has("/caps-man/sta/registration-table")).toBe(false);
		expect(PATH_CATALOG.get("/caps-man/registration-table")?.kind).toBe("menu");
	});

	/**
	 * The R1 rejections, from the product side. These are the paths the naive
	 * rewrite would have folded onto a DIFFERENT command; keeping the published
	 * spelling is what makes them safe, and the target keeps its own meaning.
	 */
	test("keeps a published path whose interior segment is a real menu", () => {
		expect(PATH_CATALOG.get("/interface/ethernet/poe/monitor")?.kind).toBe(
			"command",
		);
		expect(PATH_CATALOG.get("/interface/ethernet/monitor")?.kind).toBe(
			"command",
		);
		expect(PATH_CATALOG.get("/interface/ethernet/switch/qos/port")?.kind).toBe(
			"menu",
		);
		expect(PATH_CATALOG.get("/interface/ethernet/switch/port")?.kind).toBe(
			"menu",
		);
	});

	/**
	 * The shipped-table half of the #285 discovery fix. `interface/ethernet/
	 * switch/qos/` is a trailing-slash category URL — the sitemap carries its
	 * CHILDREN but never the menu itself, whose entry is published only at
	 * `qos/qos.md` and listed only in `llms.txt`. It is published-only, so
	 * sitemap-only discovery does not merely lose its gate: the row disappears,
	 * and with it the explanation for why no CHR tree has it.
	 *
	 * This is also the R1 path from tikoci/rosetta#136 — `qos` being a real,
	 * published menu segment is what makes dropping it unsafe, and it can only be
	 * seen to be one once the leaf is recovered.
	 */
	test("carries a branching menu the sitemap alone never lists", () => {
		const qos = PATH_CATALOG.get("/interface/ethernet/switch/qos");
		expect(qos?.kind).toBe("menu");
		expect(qos?.provenance).toBe("published");
		expect(qos?.syscap).toBe("rbswitch and crs_prestera");
	});

	test("entries are lower-case, slash-led and sorted", () => {
		const paths = [...PATH_CATALOG.keys()];
		expect(paths.filter((path) => path !== path.toLowerCase())).toEqual([]);
		expect(paths.filter((path) => !path.startsWith("/"))).toEqual([]);
		expect(paths).toEqual([...paths].sort());
	});
});

describe("explain/catalog — lookupPath", () => {
	test("both path spellings and any casing reduce to the same entry", () => {
		const expected = PATH_CATALOG.get("/ip/address");
		expect(lookupPath(["ip", "address"])).toEqual(expected as CatalogEntry);
		expect(lookupPath(["IP", "Address"])).toEqual(expected as CatalogEntry);
	});

	/** Absence never rejects: an unknown path is undefined, never a verdict. */
	test("a path in neither source is absent", () => {
		expect(lookupPath(["interface", "future-radio"])).toBeUndefined();
	});

	/** The bare `/` and `..` forms are decided by their own rule. */
	test("an empty segment list is not an entry", () => {
		expect(lookupPath([])).toBeUndefined();
	});
});

describe("explain/catalog — commandVerbIndex", () => {
	test("returns the index of the verb segment, for a bare path or with arguments", () => {
		expect(commandVerbIndex(["system", "reboot"])).toBe(1);
		expect(commandVerbIndex(["system", "gps", "monitor", "once"])).toBe(2);
		expect(commandVerbIndex(["quit"])).toBe(0);
	});

	/** A menu is not a command, and absence is not evidence of either. */
	test("a menu and an unknown path both return null", () => {
		expect(commandVerbIndex(["ip", "address"])).toBeNull();
		expect(commandVerbIndex(["disk", "format-drive"])).toBeNull();
		expect(commandVerbIndex([])).toBeNull();
	});

	/**
	 * R3, checked against the SHIPPED table rather than only at generation. The
	 * consumers walk a run root-first and take the first command prefix; with a
	 * command that had a descendant, a run could carry two and the answer would
	 * depend on the walk direction instead of on the evidence.
	 */
	test("no command row has a descendant, so at most one prefix can match", () => {
		const paths = [...PATH_CATALOG.keys()];
		const descended = paths.filter(
			(path) =>
				PATH_CATALOG.get(path)?.kind === "command" &&
				paths.some((other) => other.startsWith(`${path}/`)),
		);
		expect(descended).toEqual([]);
	});

	/**
	 * The precedence question the analyzers do NOT have to answer. `resolveVerb`
	 * consults the catalog before the frozen vocabulary, which would matter if the
	 * two ever named different tokens — they cannot today, because every catalog
	 * command carrying a `VERBS` segment carries it as the LEAF. Pinned so a
	 * regeneration that changes it surfaces here, where the precedence is
	 * documented, rather than as a silent reading change.
	 */
	test("the catalog and the frozen vocabulary never name different tokens", () => {
		for (const [path, entry] of PATH_CATALOG) {
			if (entry.kind !== "command") continue;
			const segments = path.split("/").filter(Boolean);
			const vocab = segments.findIndex((segment) => VERBS.has(segment));
			if (vocab < 0) continue;
			expect({ path, vocab }).toEqual({ path, vocab: segments.length - 1 });
		}
	});
});

describe("explain/catalog — effectiveGates", () => {
	/**
	 * A row states only what the publication stated AT that entry, so a gate must
	 * be read down the whole path. `/disk/smb-share` publishes no gate of its own,
	 * but reaching it requires `/disk`, which is built `!smips`.
	 */
	test("inherits an ancestor's gate", () => {
		const own = lookupPath(["disk", "smb-share"]);
		expect(own?.conditions).toBeUndefined();
		expect(own?.package).toBeUndefined();
		expect(own?.syscap).toBeUndefined();

		const gates = effectiveGates(["disk", "smb-share"]);
		expect(gates.map((gate) => gate.path)).toEqual(["/disk"]);
		expect(gates[0]?.conditions).toBe("!smips");
	});

	test("carries a path's own gate, root-first", () => {
		const gates = effectiveGates(["partitions", "activate"]);
		expect(gates[0]?.path).toBe("/partitions");
		expect(gates[0]?.syscap).toBe("partitions");
		expect(gates.at(-1)?.path).toBe("/partitions/activate");
	});

	test("an ungated path anywhere in its ancestry yields nothing", () => {
		expect(effectiveGates(["ip", "address"])).toEqual([]);
		expect(effectiveGates([])).toEqual([]);
		expect(effectiveGates(["interface", "future-radio"])).toEqual([]);
	});

	/**
	 * The #228 headline, re-derived from the shipped table rather than quoted:
	 * a published-only path almost always explains its own absence from a
	 * CHR-derived tree, and the unexplained residue is a small fixed set.
	 *
	 * The corrected inventory (#285) sharpened this rather than moving it. The
	 * seven paths #228 named were an artifact of the module-page corpus:
	 * `serial-interface` and `dashboard` are now published as their own gated
	 * menus, and the recovered `<dir>/<basename>` leaves carry the gates their
	 * children inherit. Row-wise the residue is 2; ancestry-aware it is
	 * `/interface/xfrm` alone — the one published path that explains its absence
	 * from a CHR tree in no way at all. A growing set would be a real event.
	 */
	test("the unexplained residue is one path", () => {
		const residue = [...PATH_CATALOG]
			.filter(([path, entry]) => {
				if (entry.provenance !== "published") return false;
				return effectiveGates(path.split("/").filter(Boolean)).length === 0;
			})
			.map(([path]) => path);
		expect(residue).toEqual(["/interface/xfrm"]);
	});
});

// ---------------------------------------------------------------------------
// The parser, against frozen pages
// ---------------------------------------------------------------------------

describe("explain/catalog — parsing published pages", () => {
	test("reads every entry, gate and kind on a real page", async () => {
		const markdown = await readFixture("partitions.md");
		const entries = parsePage("partitions", markdown);
		expect(entries.map((entry) => `${entry.path} ${entry.kind}`)).toEqual([
			"/partitions Directory",
			"/partitions/activate Command",
			"/partitions/copy-to Command",
			"/partitions/repartition Command",
			"/partitions/restore-config-from Command",
			"/partitions/save-config-to Command",
		]);
		expect(entries[0]?.syscap).toBe("partitions");
		expect(entries[0]?.conditions).toBe("!i386, !smips, !mmips");
		expect(entries[0]?.package).toBeNull();
	});

	/**
	 * The page repeats its `# partitions` title as a body heading. The preamble
	 * rule (body starts after the last `import {…}`) is what keeps that from
	 * becoming a duplicate entry, and the marker count is what would catch it.
	 */
	test("the Type-marker count reconciles with the parse", async () => {
		for (const name of ["partitions.md", "tool__mac-server.md"]) {
			const markdown = await readFixture(name);
			expect(countTypeMarkers(markdown)).toBe(parsePage(name, markdown).length);
		}
	});

	test("distinguishes a Settings Directory from a Directory", async () => {
		const markdown = await readFixture("tool__mac-server.md");
		const entries = parsePage("tool/mac-server", markdown);
		expect(entries.map((entry) => `${entry.path} ${entry.kind}`)).toEqual([
			"/tool/mac-server Settings Directory",
			"/tool/mac-server/mac-winbox Settings Directory",
			"/tool/mac-server/ping Settings Directory",
			"/tool/mac-server/sessions Directory",
		]);
	});

	/**
	 * A `<dir>/<basename>` leaf, the shape sitemap-only discovery dropped (#285),
	 * publishing ONE path as two entries under different hardware gates. Read
	 * end-to-end, because each half was decided from this page: the parser keeps
	 * both occurrences, the fold records the kind they agree on, and the gate
	 * survives only where both state it — `!i386` does, `syscap: health` does not.
	 */
	test("reads a path published twice under different gates", async () => {
		const entries = parsePage(
			"system/health/health",
			await readFixture("system__health__health.md"),
		);
		expect(
			entries.map((entry) => `${entry.path} ${entry.kind} ${entry.syscap}`),
		).toEqual([
			"/system/health Settings Directory null",
			"/system/health Directory health",
		]);

		const rows = buildWith(entries, { "/system/health": "dir" });
		expect(rows).toEqual([
			{
				conditions: "!i386",
				kind: "menu",
				package: undefined,
				path: "/system/health",
				provenance: "both",
				syscap: undefined,
			},
		]);
	});

	/** Flag rows name print flags, not arguments; only R2 consumes this set. */
	test("collects argument names but not print flags", async () => {
		const entries = parsePage("partitions", await readFixture("partitions.md"));
		expect([...(entries[0]?.fields ?? [])].sort()).toEqual([
			"fallback-to",
			"name",
			"size",
			"version",
		]);
	});

	test("refuses an unknown entry Type rather than defaulting", () => {
		expect(() =>
			parsePage("x", "import {A} from 'b';\n\n## x/y\n\n**Type:** Menu\n"),
		).toThrow(/unknown entry Type/);
	});

	test("refuses a duplicated marker", () => {
		expect(() =>
			parsePage(
				"x",
				"import {A} from 'b';\n\n## x/y\n\n**Type:** Command\n**Type:** Directory\n",
			),
		).toThrow(/duplicate Type marker/);
	});

	test("refuses a heading that declares no Type", () => {
		expect(() =>
			parsePage("x", "import {A} from 'b';\n\n## x/y\n\nprose\n"),
		).toThrow(/has no Type marker/);
	});

	test("refuses an unknown ArgTable header", () => {
		expect(() =>
			parsePage(
				"x",
				'import {A} from \'b\';\n\n## x/y\n\n**Type:** Command\n<ArgTable c1="Mystery" c2="Type">\n</ArgTable>\n',
			),
		).toThrow(/unknown ArgTable c1 header/);
	});

	/**
	 * The dangerous shape, and why the open-tag match is deliberately loose. If an
	 * `<ArgTable>` with no recognized `c1` were skipped instead of refused, the
	 * previous table's kind would stay in force and its rows would be read as
	 * arguments — a Flag table's `X`/`R` landing in the R2 field set, silently.
	 */
	test("refuses an ArgTable that declares no header at all", () => {
		expect(() =>
			parsePage(
				"x",
				'import {A} from \'b\';\n\n## x/y\n\n**Type:** Command\n<ArgTable c1="Flag" c2="Name">\n<ArgTableRow arg="X" typ="disabled"></ArgTableRow>\n</ArgTable>\n<ArgTable>\n<ArgTableRow arg="leaked" typ="bool"></ArgTableRow>\n</ArgTable>\n',
			),
		).toThrow(/unknown ArgTable c1 header/);
	});

	test("refuses a row outside any table", () => {
		expect(() =>
			parsePage(
				"x",
				'import {A} from \'b\';\n\n## x/y\n\n**Type:** Command\n<ArgTableRow arg="orphan" typ="bool"></ArgTableRow>\n',
			),
		).toThrow(/ArgTableRow outside any ArgTable/);
	});

	/**
	 * The R2 bypass. Rows are the ONLY input to the alias field-overlap guard and
	 * are never emitted, so a row this parser cannot read yields an empty field
	 * set, `assertFieldOverlap` skips the alias, and an alias against a disjoint
	 * tree is accepted — with `--check` still green, because the generated file
	 * does not change. One quote character upstream would have been enough.
	 */
	test("refuses a row it cannot read rather than dropping it", () => {
		expect(() =>
			parsePage(
				"x",
				'import {A} from \'b\';\n\n## x/y\n\n**Type:** Command\n<ArgTable c1="Argument" c2="Type">\n<ArgTableRow arg=\'single-quoted\' typ="bool"></ArgTableRow>\n</ArgTable>\n',
			),
		).toThrow(/unreadable ArgTableRow/);
	});

	test("refuses two rows sharing one line", () => {
		expect(() =>
			parsePage(
				"x",
				'import {A} from \'b\';\n\n## x/y\n\n**Type:** Command\n<ArgTable c1="Argument" c2="Type">\n<ArgTableRow arg="a" typ="bool"></ArgTableRow><ArgTableRow arg="b" typ="bool"></ArgTableRow>\n</ArgTable>\n',
			),
		).toThrow(/ArgTableRow markers on line/);
	});

	/** Every marker in the source is accounted for, flags included. */
	test("row markers reconcile with the parse on the frozen pages", async () => {
		for (const name of ["partitions.md", "tool__mac-server.md"]) {
			const markdown = await readFixture(name);
			const parsed = parsePage(name, markdown).reduce(
				(sum, entry) => sum + entry.rows,
				0,
			);
			expect(countRowMarkers(markdown)).toBe(parsed);
			expect(parsed).toBeGreaterThan(0);
		}
	});

	/** A fenced example must not be mistaken for structure. */
	test("ignores headings and markers inside a code fence", () => {
		const entries = parsePage(
			"x",
			"import {A} from 'b';\n\n## x/y\n\n**Type:** Command\n\n```\n## not/an/entry\n**Type:** Directory\n```\n",
		);
		expect(entries.map((entry) => entry.path)).toEqual(["/x/y"]);
		expect(entries[0]?.kind).toBe("Command");
	});
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * The sitemap is not the inventory (#285). A branching menu is served as a
 * trailing-slash category URL with no `.md`, while the menu's own entry is
 * published at `<dir>/<basename(dir)>.md` and listed only in `llms.txt`. These
 * hold the shape of that pair, because getting it wrong shrinks the catalog by
 * a quarter without a single error.
 */
describe("explain/catalog — discovery", () => {
	const loc = (path: string): string =>
		`<url><loc>https://manual.mikrotik.com${path}</loc></url>`;
	const sitemap = [
		loc("/docs/cli-reference/"),
		loc("/docs/cli-reference/app/"),
		loc("/docs/cli-reference/app/cleanup"),
		loc("/docs/cli-reference/beep"),
		loc("/docs/other/thing"),
	].join("\n");
	const llms = [
		"- [App](https://manual.mikrotik.com/docs/cli-reference/app/app.md)",
		"- [Cleanup](https://manual.mikrotik.com/docs/cli-reference/app/cleanup.md)",
		"- [Beep](https://manual.mikrotik.com/docs/cli-reference/beep.md)",
		"- [Index](https://manual.mikrotik.com/docs/cli-reference/index.md)",
		"- [Other](https://manual.mikrotik.com/docs/other/thing.md)",
	].join("\n");

	test("the sitemap lists only the directly-addressable pages", () => {
		expect(sitemapSlugs(sitemap)).toEqual(["app/cleanup", "beep"]);
	});

	test("a category URL names the leaf that carries the menu's own entry", () => {
		expect(categoryLeafSlugs(sitemap)).toEqual(["app/app"]);
	});

	/** `index` is the argument-type glossary prose, not a CLI path. */
	test("llms.txt lists every page except the section landing page", () => {
		expect(llmsSlugs(llms)).toEqual(["app/app", "app/cleanup", "beep"]);
	});

	/**
	 * Both inventories publish absolute URLs today, so a relative link must be
	 * resolved rather than dropped: `new URL(link)` alone throws on it, and
	 * returning nothing is indistinguishable from "not a CLI page" — which is how
	 * an inventory silently shrinks. Root-relative and document-relative both
	 * resolve against `llms.txt`'s own URL, the way a browser reads them.
	 */
	test("a relative llms.txt link resolves against the document, not away", () => {
		expect(
			llmsSlugs(
				[
					"- [Root-relative](/docs/cli-reference/beep.md)",
					"- [Document-relative](./docs/cli-reference/app/app.md)",
					"- [Elsewhere](/docs/other/thing.md)",
				].join("\n"),
			),
		).toEqual(["app/app", "beep"]);
	});

	test("the inventory is the union, and the category leaf survives it", () => {
		expect(discoverSlugs(sitemap, llms)).toEqual([
			"app/app",
			"app/cleanup",
			"beep",
		]);
	});

	/**
	 * The #285 defect itself, refused. A category dir whose leaf no inventory
	 * carries means that menu's entry is being dropped — invisibly, since the
	 * generated table would simply be shorter.
	 */
	test("aborts when a category dir contributes no leaf", () => {
		expect(() =>
			discoverSlugs(sitemap, llms.split("\n").slice(1).join("\n")),
		).toThrow(/contribute no <dir>\/<basename> leaf/);
	});

	/**
	 * A page only the sitemap lists is reported, not refused: the union already
	 * carries it, so nothing is dropped, and `--check` fails on the new row.
	 */
	test("reports a sitemap page llms.txt does not list", () => {
		const reported: string[] = [];
		const slugs = discoverSlugs(
			`${sitemap}\n${loc("/docs/cli-reference/new-page")}`,
			llms,
			(message) => reported.push(message),
		);
		expect(slugs).toContain("new-page");
		expect(reported.join("\n")).toMatch(/not in llms\.txt.*new-page/s);
	});

	/**
	 * And the inverse, which is NOT symmetric. `llms.txt` legitimately carries
	 * every category leaf the sitemap lacks — 256 of them — so reporting all
	 * llms-only pages would bury the signal in the shape. The residue is what
	 * matters: a page in neither the sitemap nor the category leaves has appeared
	 * from nowhere and the sitemap no longer accounts for it.
	 */
	test("reports an llms.txt page the sitemap cannot account for", () => {
		const reported: string[] = [];
		const slugs = discoverSlugs(
			sitemap,
			`${llms}\n- [Nowhere](https://manual.mikrotik.com/docs/cli-reference/nowhere.md)`,
			(message) => reported.push(message),
		);
		expect(slugs).toContain("nowhere");
		expect(reported.join("\n")).toMatch(/neither in the sitemap.*nowhere/s);
	});

	/** ...and the category leaves themselves are never reported as that. */
	test("stays silent when llms.txt differs only by its category leaves", () => {
		const reported: string[] = [];
		discoverSlugs(sitemap, llms, (message) => reported.push(message));
		expect(reported).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The generator's refusals
// ---------------------------------------------------------------------------

const entry = (
	path: string,
	kind: PublishedEntry["kind"],
	fields: string[] = [],
): PublishedEntry => ({
	conditions: null,
	fields: new Set(fields),
	kind,
	line: 1,
	package: null,
	path,
	rows: fields.length,
	slug: "test",
	syscap: null,
});

/**
 * Build against a hand-made tree and a scoped alias map, so the assertion under
 * test is the only variable. The generator always uses the whole allowlist; here
 * a subset keeps one refusal from masking another.
 */
const buildWith = (
	published: PublishedEntry[],
	tree: Record<string, string>,
	aliases: Record<string, string> = {},
): CatalogRow[] =>
	build(
		published,
		new Map(Object.entries(tree)),
		new Set(
			Object.entries(tree)
				.filter(([, type]) => type === "dir" || type === "path")
				.map(([path]) => path),
		),
		new Map(Object.entries(aliases)),
	);

describe("explain/catalog — what the generator refuses", () => {
	/**
	 * The headline assertion. Zero contradictions have ever been measured across
	 * 906 exact matches, three RouterOS versions and two architectures, so the
	 * first one is a real event — and letting either source win silently is how a
	 * command becomes navigation.
	 */
	test("aborts when the two sources disagree about what a path IS", () => {
		expect(() =>
			buildWith([entry("/ip/address", "Command")], { "/ip/address": "dir" }),
		).toThrow(/disagree about what these paths ARE/);
	});

	test("aborts when one page publishes a path as two different kinds", () => {
		expect(() =>
			buildWith(
				[entry("/ip/thing", "Command"), entry("/ip/thing", "Directory")],
				{},
			),
		).toThrow(/disagree about what these paths ARE/);
	});

	/**
	 * ...but a `Directory` / `Settings Directory` pair is NOT that disagreement.
	 * Both say the path is navigation and differ only on whether this hardware's
	 * menu holds a single record — `/system/health` is published both ways on one
	 * page, `!i386` and `health`. Record what they agree on, as a disagreed gate
	 * is dropped rather than picked.
	 */
	test("records the agreed kind when two occurrences differ only in container kind", () => {
		const rows = buildWith(
			[entry("/x/y", "Settings Directory"), entry("/x/y", "Directory")],
			{},
		);
		expect(rows.map((row) => `${row.path} ${row.kind}`)).toEqual(["/x/y menu"]);
	});

	/**
	 * R1, stated directly. `poe` is a real CLI menu segment, so dropping it is
	 * never allowed — this is the rule tikoci/rosetta#136 was missing.
	 *
	 * Exercised against a synthetic allowlist because the shipped one is empty
	 * (#285): the rule guards the next entry someone adds, so it must be provable
	 * without one.
	 */
	test("R1: refuses to drop a segment that is itself a published entry", () => {
		const from = "/caps-man/acl/access-list";
		const to = "/caps-man/access-list";
		expect(() =>
			buildWith(
				[
					entry(from, "Directory"),
					entry("/caps-man/acl", "Directory"), // the segment turns out to be real
				],
				{ "/caps-man/access-list": "dir" },
				{ [from]: to },
			),
		).toThrow(/is itself a published entry/);
	});

	/**
	 * R2. The offline proof that two spellings are the same command: pass 2 used
	 * exactly this to show `/interface/ethernet/poe/monitor` and
	 * `/interface/ethernet/monitor` are different commands.
	 */
	test("R2: refuses an alias whose arguments do not overlap its target", () => {
		expect(() =>
			buildWith(
				[entry("/tool/ddns/dns-update", "Command", ["nowhere-near-it"])],
				{
					"/tool/dns-update": "cmd",
					"/tool/dns-update/dns-server": "arg",
					"/tool/dns-update/zone": "arg",
				},
				{ "/tool/ddns/dns-update": "/tool/dns-update" },
			),
		).toThrow(/NO overlap/);
	});

	/**
	 * R3. The precondition `commandVerbIndex` rests on, refused at the only place
	 * that can still decline to emit — the lesson the `mergeTreeTypes` round
	 * taught: extract a consumer's assertions with the data they guard, not just
	 * the fetch.
	 */
	test("R3: refuses a command row that has a descendant", () => {
		expect(() =>
			buildWith(
				[entry("/ip/thing", "Command"), entry("/ip/thing/deeper", "Directory")],
				{},
			),
		).toThrow(/command row has a descendant/);
	});

	test("accepts an alias whose arguments do overlap", () => {
		const rows = buildWith(
			[entry("/tool/ddns/dns-update", "Command", ["zone", "ddns-only"])],
			{ "/tool/dns-update": "cmd", "/tool/dns-update/zone": "arg" },
			{ "/tool/ddns/dns-update": "/tool/dns-update" },
		);
		expect(rows.map((row) => row.path)).toEqual(["/tool/dns-update"]);
		expect(rows[0]?.provenance).toBe("both");
	});

	/**
	 * The allowlist is hand-audited, so it can only go stale silently. Both halves
	 * of a stale entry are caught: the doc spelling disappearing upstream, and the
	 * CLI spelling disappearing from the trees.
	 */
	test("aborts when an alias source is no longer published", () => {
		expect(() =>
			buildWith([], {}, { "/tool/ddns/dns-update": "/tool/dns-update" }),
		).toThrow(/no longer a published entry/);
	});

	test("aborts when an alias target is in no pinned tree", () => {
		expect(() =>
			buildWith(
				[entry("/tool/ddns/dns-update", "Command")],
				{},
				{ "/tool/ddns/dns-update": "/tool/dns-update" },
			),
		).toThrow(/is in no pinned tree/);
	});

	/**
	 * The allowlist is empty and that is the correct state (#285): MikroTik now
	 * publishes every path in its CLI spelling, so nothing needs rewriting. Pinned
	 * because an entry appearing again is a source change to read, not a routine
	 * regeneration — and because R0/R1/R2 above only ever fire on an entry.
	 */
	test("the allowlist is empty, and any entry would be a segment drop", () => {
		expect([...ALIASES]).toEqual([]);
		for (const [from, to] of ALIASES)
			expect(droppedSegments(from, to).length).toBeGreaterThan(0);
		expect(() => droppedSegments("/a/b/c", "/a/x")).toThrow(
			/must be a subsequence/,
		);
	});

	/**
	 * The union's other half: tree containers the publication does not carry are
	 * kept, tree COMMANDS are not. Enumerating the latter would bury the ~440
	 * non-generic published commands under the generic CRUD leaves `verbs.ts`
	 * already owns.
	 */
	test("keeps tree-only containers and drops tree-only commands", () => {
		const rows = buildWith([], {
			"/ip": "path",
			"/ip/address": "dir",
			"/ip/address/print": "cmd",
		});
		expect(
			rows.map((row) => `${row.path} ${row.kind} ${row.provenance}`),
		).toEqual(["/ip menu inspect", "/ip/address menu inspect"]);
	});

	/**
	 * A gate survives only where every occurrence of the path states it. Four
	 * paths are published twice, and one of the pair is ungated — claiming the
	 * gate would over-state what the publication says.
	 */
	test("drops a gate the duplicate occurrences disagree on", () => {
		const gated = entry("/x/y", "Directory");
		gated.syscap = "oldswitch";
		const rows = buildWith([gated, entry("/x/y", "Directory")], {});
		expect(rows[0]?.syscap).toBeUndefined();
	});
});
