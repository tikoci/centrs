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
 * The pin lives in `scripts/restraml-trees.ts`, shared with
 * `gen-explain-catalog.ts` so both tables are built from the same four trees.
 * That file carries the rationale for the pin and for arm64.
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
 * MikroTik's published CLI Reference is deliberately NOT a source **for this
 * table**, and stays that way after #228 adopted it elsewhere. This table is a
 * DEVICE-CONFIRMED floor: every entry was observed as a container on at least
 * one real `/console/inspect` tree, which is what its header is allowed to
 * claim. 65 published container paths are confirmed by no tree at all — the
 * `published`-provenance `menu` (54) and `settings` (11) rows of
 * `src/explain/catalog.ts` — necessarily so, since this table *is* the union of
 * those trees. Merging them in would quietly retire that guarantee for a
 * per-table provenance that cannot be stated per entry.
 *
 * `src/explain/catalog.ts` (`gen-explain-catalog.ts`) is where the published
 * source landed instead: the same four trees unioned with CLI Reference, but
 * with `provenance` carried per entry. It is additive and does not reinterpret
 * anything here. Read that generator for the alias allowlist, the published
 * applicability gates, and the kind-contradiction assertion.
 *
 * What is NOT a reason, and used to be claimed here: that 79 of cliref's 81
 * tree-only dirs are "phantoms never observed on any device". Measured against
 * these four trees (#228), that is wrong. They are overwhelmingly REAL menus
 * gated to hardware no CHR has — switch-chip QoS/ACL/FDB, PoE, LCD, w60g, PTP,
 * MSRP, partitions, SwOS — and 105 of the 112 published paths absent from every
 * tree carry a `package`/`conditions`/`syscap` gate that predicts the absence.
 * The unexplained residue is 7 paths. Across 906 exactly-matching paths the two
 * sources have ZERO kind contradictions.
 *
 * Usage:
 *   bun run explain:menus          # regenerate src/explain/menus.ts
 *   bun run explain:menus --check  # drift gate: fail if the committed file differs
 *
 * `--check` needs network (it fetches the pinned trees again), so it hangs off
 * the QA workflow rather than the offline `lint:ci` gate.
 */

import { join } from "node:path";
import {
	CONTAINER_TYPES,
	fetchPinnedTrees,
	mergeTreeTypes,
	type RestramlExtract,
} from "./restraml-trees.ts";

const OUTPUT_PATH = join(import.meta.dir, "..", "src", "explain", "menus.ts");

type Extract = RestramlExtract;

/**
 * Every container path the pinned trees agree on.
 *
 * `mergeTreeTypes` is what aborts on a cross-tree `dir`↔`cmd` flip, and it is
 * shared with `gen-explain-catalog.ts` so both tables refuse the same union.
 */
function unionContainers(extracts: readonly Extract[]): string[] {
	return [...mergeTreeTypes(extracts)]
		.filter(([, type]) => CONTAINER_TYPES.has(type))
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

const extracts = await fetchPinnedTrees();

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
