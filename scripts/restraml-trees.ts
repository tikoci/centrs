/**
 * The pinned restraml `/console/inspect` trees — shared by the two generators
 * that read them (`gen-explain-menus.ts`, `gen-explain-catalog.ts`).
 *
 * This is a module, not an entry point. It exists so the PIN lives in exactly
 * one place: `src/explain/menus.ts` and `src/explain/catalog.ts` must be built
 * from the same trees, or the catalog's `provenance` column would be measuring a
 * different source than the menu table it sits beside.
 *
 * ## Source selection (pinned, deliberately)
 *
 * Four extra-packages trees, two architectures, spanning 7.10.2 → 7.24rc2.
 * The pin is the point: `--check` must be reproducible, so adopting a newer
 * RouterOS tree is a deliberate edit to {@link RESTRAML_SOURCES}, reviewed like
 * any other change. It is *not* version tracking — the emitted tables are
 * version-less by design and approximately "latest", because `explain` is
 * offline and does not know the target device's version.
 *
 * arm64 is not optional. 22 menus are arm64-only on the published trees —
 * `/system/routerboard` and its button submenus, `/interface/ethernet/switch`,
 * `/ip/cloud/back-to-home-*`, the whole `/zerotier` subtree — and several are
 * exactly the hyphenated shape #207 is about. `/system/routerboard` appears in
 * effectively every real hardware export.
 */

const RESTRAML_BASE = "https://tikoci.github.io/restraml/";

/** One pinned typed tree. `file` is relative to the restraml Pages base. */
export interface RestramlSource {
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
export const RESTRAML_SOURCES: readonly RestramlSource[] = [
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
export const CONTAINER_TYPES: ReadonlySet<string> = new Set(["dir", "path"]);

export interface TreeNode {
	_type?: string;
	[child: string]: unknown;
}

export interface WalkResult {
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
export function walkTree(tree: TreeNode): WalkResult {
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

export interface RestramlExtract extends RestramlSource, WalkResult {
	bytes: number;
}

export async function fetchTree(
	source: RestramlSource,
): Promise<RestramlExtract> {
	const url = `${RESTRAML_BASE}${source.file}`;
	const response = await fetch(url);
	if (!response.ok)
		throw new Error(`${url} -> HTTP ${response.status} ${response.statusText}`);
	const body = await response.text();
	const walked = walkTree(JSON.parse(body) as TreeNode);
	return { ...source, ...walked, bytes: body.length };
}

/** Fetch every pinned tree, reporting each as it lands. */
export async function fetchPinnedTrees(
	log: (line: string) => void = console.log,
): Promise<RestramlExtract[]> {
	const extracts: RestramlExtract[] = [];
	for (const source of RESTRAML_SOURCES) {
		const extract = await fetchTree(source);
		log(
			`${source.arch} ${source.version}: ${extract.nodes.toLocaleString("en-US")} nodes, ${extract.containers.size} containers (${(extract.bytes / 1024 / 1024).toFixed(1)} MiB)`,
		);
		extracts.push(extract);
	}
	return extracts;
}
