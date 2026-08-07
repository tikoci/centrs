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
 * The table is not read by `write.ts` yet — that is #228 step 2, where the
 * abstention rate moves and the regression risk lives.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	ALIASES,
	build,
	type CatalogRow,
	countRowMarkers,
	countTypeMarkers,
	droppedSegments,
	type PublishedEntry,
	parsePage,
} from "../../scripts/explain-catalog-data.ts";
import {
	type CatalogEntry,
	effectiveGates,
	lookupPath,
	PATH_CATALOG,
} from "../../src/explain/catalog.ts";
import { MENU_PATHS } from "../../src/explain/menus.ts";

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
	 * The alias layer, read from the product side: the doc spelling must NOT be in
	 * the table, and the CLI spelling must be — with device provenance, since
	 * every alias target was proven against a tree at generation time.
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

describe("explain/catalog — effectiveGates", () => {
	/**
	 * A row states only what the publication stated AT that entry, so a gate must
	 * be read down the whole path. `/interface/ethernet/poe/monitor` publishes no
	 * gate of its own, but reaching it requires `/interface/ethernet/poe`.
	 */
	test("inherits an ancestor's gate", () => {
		const own = lookupPath(["interface", "ethernet", "poe", "monitor"]);
		expect(own?.syscap).toBeUndefined();

		const gates = effectiveGates(["interface", "ethernet", "poe", "monitor"]);
		expect(gates.map((gate) => gate.path)).toContain("/interface/ethernet/poe");
		expect(
			gates.find((gate) => gate.path === "/interface/ethernet/poe")?.syscap,
		).toBe("(poe or poe-in)");
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
	 * CHR-derived tree, and the unexplained residue is a small fixed set. Read
	 * row-wise the residue looks like 46; ancestry-aware it is the seven #228
	 * named. Those seven are the ONLY evidence that the publication can carry a
	 * path with no explanation at all, so a growing set would be a real event.
	 */
	test("the unexplained residue is the seven paths #228 named", () => {
		const residue = [...PATH_CATALOG]
			.filter(([path, entry]) => {
				if (entry.provenance !== "published") return false;
				return effectiveGates(path.split("/").filter(Boolean)).length === 0;
			})
			.map(([path]) => path);
		expect(residue).toEqual([
			"/ip/cloud/app/update",
			"/system/dashboard/settings",
			"/system/dashboard/show",
			"/system/serial-interface/read",
			"/system/serial-interface/start",
			"/system/serial-interface/stop",
			"/system/serial-interface/write",
		]);
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
	 * R1, stated directly. `poe` is a real CLI menu segment, so dropping it is
	 * never allowed — this is the rule tikoci/rosetta#136 is missing, and the
	 * reason nine of the naive candidates are not in {@link ALIASES}.
	 */
	test("R1: refuses to drop a segment that is itself a published entry", () => {
		const from = "/caps-man/acl/access-list";
		const to = "/caps-man/access-list";
		expect(ALIASES.get(from)).toBe(to);
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

	/** Every alias must be a pure segment drop, or R1 is not defined on it. */
	test("every allowlist entry is a segment drop", () => {
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
