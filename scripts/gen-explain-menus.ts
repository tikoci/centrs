#!/usr/bin/env bun
/**
 * Generate `src/explain/menus.ts` — the baked RouterOS **menu path** table that
 * lets offline `explain` tell a directory from a command (issue #207).
 *
 * ## Why a baked table rather than a schema lookup
 *
 * `src/explain/*` is offline by contract: it never talks to a device, to
 * rosetta, or to a network at analysis time. #207 showed that one question
 * genuinely cannot be answered from token shape — is `/tool mac-server`
 * navigation into a menu, or a command named `mac-server`? — because the
 * corpus contains both readings of the same shape:
 *
 * | Statement                                       | Truth   |
 * | ----------------------------------------------- | ------- |
 * | `/interface wireless reset-configuration wlan1` | command |
 * | `/ip dhcp-server network`                       | menu    |
 * | `/tool mac-server mac-winbox`                   | menu    |
 *
 * RouterOS answers it directly: `/console/inspect` types every node `path`,
 * `dir`, `cmd` or `arg`, and restraml publishes those typed trees. Baking the
 * container set is not a schema import — it is one more curated closed list
 * alongside `VERBS`, `ROOT_CMDS` and `WRITE_VERBS` in `write.ts`, just
 * generated instead of hand-written.
 *
 * ## Source selection (pinned, deliberately)
 *
 * Four extra-packages trees, two architectures, spanning 7.10.2 → 7.24rc2.
 * The pin is the point: `--check` must be reproducible, so adopting a newer
 * RouterOS tree is a deliberate edit to `SOURCES` below, reviewed like any
 * other change. It is *not* version tracking — the emitted table is
 * version-less by design and approximately "latest", because `explain` is
 * offline and does not know the target device's version.
 *
 * arm64 is not optional. 22 menus are arm64-only on the published trees —
 * `/system/routerboard` and its button submenus, `/interface/ethernet/switch`,
 * `/ip/cloud/back-to-home-*`, the whole `/zerotier` subtree — and several are
 * exactly the hyphenated shape #207 is about. `/system/routerboard` appears in
 * effectively every real hardware export.
 *
 * ## Absence is safe; presence is load-bearing
 *
 * The table is a floor, not a ceiling. `write.ts` reads it in one place, to
 * confirm navigation, and a path it does not carry is simply not confirmed — so
 * the statement emits an occurrence and the document abstains, exactly as an
 * unrecognized menu did before #207. That is what makes a pinned, incomplete,
 * version-less list acceptable: a menu we have never seen costs precision,
 * never correctness.
 *
 * The dangerous direction is the other one. A **command** wrongly listed as a
 * menu would be dropped as navigation and could clear a document that writes,
 * which is why generation aborts on a cross-tree type conflict rather than
 * picking a winner, and why the sources are pinned rather than tracking latest.
 *
 * `cliref` is deliberately NOT a source **for this table**, for one reason:
 * CLI-Reference paths are the definition-module spelling, not the CLI spelling
 * — `caps-man/acl/access-list` where the real menu is `/caps-man/access-list`.
 * Those doc spellings are unreachable on a device over `/console/inspect`,
 * REST *and* the native API alike (#228), so feeding one in would add a path
 * that does not exist. Recovering the CLI spelling needs a hand-audited alias
 * allowlist, which this generator does not have — and the naive rewrite is
 * unsafe: dropping an interior segment maps `/interface/ethernet/poe/monitor`
 * onto `/interface/ethernet/monitor`, a command with a disjoint field set.
 *
 * What is NOT a reason, and used to be claimed here: that 79 of cliref's 81
 * tree-only dirs are "phantoms never observed on any device". Measured against
 * these four trees (#228), that is wrong. They are overwhelmingly REAL menus
 * gated to hardware no CHR has — switch-chip QoS/ACL/FDB, PoE, LCD, w60g, PTP,
 * MSRP, partitions, SwOS — and 105 of the 112 published paths absent from every
 * tree carry a `package`/`conditions`/`syscap` gate that predicts the absence.
 * The unexplained residue is 7 paths. Across 906 exactly-matching paths the two
 * sources have ZERO kind contradictions. cliref is complementary to these trees
 * on the hardware axis, not noise; whether centrs adopts it as a second
 * provenance is the open question in #228.
 *
 * Usage:
 *   bun run explain:menus          # regenerate src/explain/menus.ts
 *   bun run explain:menus --check  # drift gate: fail if the committed file differs
 *
 * `--check` needs network (it fetches the pinned trees again), so it hangs off
 * the QA workflow rather than the offline `lint:ci` gate.
 */

import { join } from "node:path";

const OUTPUT_PATH = join(import.meta.dir, "..", "src", "explain", "menus.ts");

const RESTRAML_BASE = "https://tikoci.github.io/restraml/";

/** One pinned typed tree. `file` is relative to {@link RESTRAML_BASE}. */
interface Source {
	version: string;
	arch: "x86" | "arm64";
	file: string;
}

/**
 * The pinned trees. Two x86 points early in 7.x for menus that existed then and
 * were later renamed away, the phase-0 pinned pair (7.23.2 / 7.24rc2) for
 * current breadth, and arm64 for the hardware-only menus above.
 *
 * `extra/` is the extra-packages build throughout — a bare CHR under-covers.
 * Before 7.20.8 restraml published no arch-split deep-inspect, so the early
 * points read `extra/inspect.json`, which carries the same `_type` tagging.
 */
const SOURCES: readonly Source[] = [
	{ version: "7.10.2", arch: "x86", file: "7.10.2/extra/inspect.json" },
	{ version: "7.16", arch: "x86", file: "7.16/extra/inspect.json" },
	{
		version: "7.23.2",
		arch: "x86",
		file: "7.23.2/extra/deep-inspect.x86.json",
	},
	{
		version: "7.24rc2",
		arch: "arm64",
		file: "7.24rc2/extra/deep-inspect.arm64.json",
	},
];

/**
 * Node types that name a CONTAINER — something a bare path may navigate into.
 *
 * `dir` is the ordinary menu. `path` is the tagging restraml gives the seven
 * top-level namespaces (`/file`, `/interface`, `/ip`, `/ipv6`, `/system`,
 * `/tool`, `/user`); they are navigable menus like any other and are included
 * for that reason. Omitting them would make `/ip` alone stop reading as
 * navigation — a regression the shape rule never had.
 */
const CONTAINER_TYPES: ReadonlySet<string> = new Set(["dir", "path"]);

interface TreeNode {
	_type?: string;
	[child: string]: unknown;
}

interface WalkResult {
	containers: Set<string>;
	/** Every node's observed type, for the cross-tree conflict assertion. */
	types: Map<string, string>;
	nodes: number;
}

/**
 * Collect every container path in one typed tree.
 *
 * The tree nests children directly under their parent object alongside the
 * `_type` tag, so any key starting with `_` is metadata and any non-object
 * value is a scalar annotation — both are skipped. `arg` and `cmd` nodes are
 * still WALKED (a `cmd` carries its arguments as children) so their types are
 * recorded for the conflict check, but they never enter `containers`.
 */
function walkTree(tree: TreeNode): WalkResult {
	const containers = new Set<string>();
	const types = new Map<string, string>();
	let nodes = 0;

	const visit = (node: TreeNode, prefix: string): void => {
		for (const [name, child] of Object.entries(node)) {
			if (name.startsWith("_")) continue;
			if (typeof child !== "object" || child === null) continue;
			const value = child as TreeNode;
			const type = value._type;
			if (typeof type !== "string") continue;
			const path = `${prefix}/${name.toLowerCase()}`;
			nodes++;
			types.set(path, type);
			if (CONTAINER_TYPES.has(type)) containers.add(path);
			visit(value, path);
		}
	};

	visit(tree, "");
	return { containers, types, nodes };
}

interface Extract extends Source {
	containers: Set<string>;
	types: Map<string, string>;
	nodes: number;
	bytes: number;
}

async function fetchTree(source: Source): Promise<Extract> {
	const url = `${RESTRAML_BASE}${source.file}`;
	const response = await fetch(url);
	if (!response.ok)
		throw new Error(`${url} -> HTTP ${response.status} ${response.statusText}`);
	const body = await response.text();
	const walked = walkTree(JSON.parse(body) as TreeNode);
	return { ...source, ...walked, bytes: body.length };
}

/**
 * Union the extracts, aborting on any path whose type differs between trees.
 *
 * Measured across these four trees the conflict count is ZERO — no `dir`↔`cmd`
 * flip across three versions or across architectures — which is what makes a
 * version-less union sound at all. If RouterOS ever does flip one, that is a
 * fact this table cannot represent, so generation must stop and force a human
 * decision rather than silently letting whichever tree sorted last win.
 */
function unionContainers(extracts: readonly Extract[]): string[] {
	const seen = new Map<string, { type: string; source: string }>();
	const conflicts: string[] = [];
	for (const extract of extracts) {
		const label = `${extract.arch} ${extract.version}`;
		for (const [path, type] of extract.types) {
			const prior = seen.get(path);
			if (prior === undefined) {
				seen.set(path, { type, source: label });
				continue;
			}
			if (prior.type !== type)
				conflicts.push(
					`${path}: ${prior.type} (${prior.source}) vs ${type} (${label})`,
				);
		}
	}
	if (conflicts.length > 0)
		throw new Error(
			`node type conflicts across the pinned trees — the union is not sound:\n  ${conflicts.join("\n  ")}`,
		);
	return [...seen]
		.filter(([, { type }]) => CONTAINER_TYPES.has(type))
		.map(([path]) => path)
		.sort();
}

function render(
	extracts: readonly Extract[],
	paths: readonly string[],
): string {
	const provenance = extracts
		.map(
			(e) =>
				` * | \`${e.file}\` | ${e.arch} | ${e.version} | ${e.nodes.toLocaleString("en-US")} | ${e.containers.size} |`,
		)
		.join("\n");
	const entries = paths.map((p) => `\t"${p}",`).join("\n");
	return `/**
 * RouterOS menu (container) paths — GENERATED, do not hand-edit.
 *
 * Regenerate with \`bun run explain:menus\`; \`bun run explain:menus --check\` is
 * the drift gate. The generator (\`scripts/gen-explain-menus.ts\`) carries the
 * full rationale, the source pin, and why absence here is safe.
 *
 * Union of the \`dir\` and \`path\` nodes in four pinned restraml typed trees
 * (\`https://tikoci.github.io/restraml/\`), all extra-packages builds:
 *
 * | Tree | Arch | RouterOS | Nodes | Containers |
 * | ---- | ---- | -------- | ----- | ---------- |
${provenance}
 *
 * Zero node-type conflicts across those trees — no \`dir\`↔\`cmd\` flip across
 * three versions or across architectures — which is what makes the union
 * version-less rather than version-keyed. Generation aborts if that ever stops
 * holding.
 *
 * **This table is a floor.** A path missing here is not confirmed as
 * navigation, so \`write.ts\` abstains on it — the pre-#207 behaviour for an
 * unrecognized menu, never a wrong answer. A COMMAND wrongly listed here would
 * be a wrong answer, which is what the pin and the conflict check protect.
 */

/** Every container path the pinned trees agree on, lower-cased and sorted. */
export const MENU_PATHS: ReadonlySet<string> = new Set([
${entries}
]);

/**
 * Is this token sequence a known RouterOS menu?
 *
 * Takes the path SEGMENTS rather than raw text so callers pass what they
 * already parsed — \`describeStatement\`'s run, say — instead of re-splitting a
 * statement and having to re-derive which spelling (\`/ip/address\` or
 * \`/ip address\`) it used. Both spellings reduce to the same segments, which is
 * the whole reason this reads segments.
 *
 * Empty input is not a menu: the bare \`/\` and \`..\` forms are decided by their
 * own rule, and answering \`true\` here would let an empty run fall into a menu
 * verdict by accident.
 */
export function isMenuPath(segments: readonly string[]): boolean {
	if (segments.length === 0) return false;
	return MENU_PATHS.has(\`/\${segments.join("/").toLowerCase()}\`);
}
`;
}

const extracts: Extract[] = [];
for (const source of SOURCES) {
	const extract = await fetchTree(source);
	console.log(
		`${source.arch} ${source.version}: ${extract.nodes.toLocaleString("en-US")} nodes, ${extract.containers.size} containers (${(extract.bytes / 1024 / 1024).toFixed(1)} MiB)`,
	);
	extracts.push(extract);
}

const paths = unionContainers(extracts);
const content = render(extracts, paths);
console.log(`union: ${paths.length} container paths`);

if (process.argv.includes("--check")) {
	const existing = await Bun.file(OUTPUT_PATH)
		.text()
		.catch(() => "");
	if (existing !== content) {
		console.error(
			"src/explain/menus.ts is out of date with the pinned restraml trees.\n" +
				"Run `bun run explain:menus` and commit the result. If the change is\n" +
				"unexpected, restraml republished a pinned tree — review the diff before\n" +
				"committing it, since a command turning into a menu is a correctness bug.",
		);
		process.exit(1);
	}
	console.log("src/explain/menus.ts matches the pinned restraml trees.");
} else {
	await Bun.write(OUTPUT_PATH, content);
	console.log(`wrote ${OUTPUT_PATH}`);
}
