/**
 * Cut the committed stratified slice of the Q13 per-character highlight streams
 * (#186 workstream 3, gating #263).
 *
 * ## Why a slice exists at all
 *
 * `/console/inspect request=highlight` is the ONLY per-token oracle RouterOS
 * offers. The corpus DB cannot stand in for it: `highlight_results` stores
 * summary statistics — `token_count`, `elapsed_ms`, and a
 * `token_types_json` that is the *distinct set* of classes in a script. No
 * offsets, no per-token classes. The per-token capture is
 * `.scratch/explain-lab-q13-streams.v<version>.json`, ~7.5 MB per RouterOS
 * version, produced by `bun run explain:probe:highlight-recapture`. Committing
 * 15 MB of it to measure a trend line is not a trade worth making; committing
 * nothing leaves the measurement runnable on one machine. So: a slice, chosen
 * by a rule stated in the output.
 *
 * ## The rule
 *
 * Universe = every captured script that is BOTH in the frozen dev/holdout split
 * and not truncated. Two exclusions, both deliberate:
 *
 *   - **truncated** (3 scripts, > 32767 chars): the device saw a prefix, so the
 *     stream does not concatenate to the document. A consumer scoring an
 *     offline lexer over a partial document would read the cut as a mismatch.
 *     The truncation FACT is metadata and is recorded in `selection.excluded`.
 *   - **outside the split** (2 scripts): the content-hash duplicates the
 *     partition dropped. Keeping them double-weights one document.
 *
 * Neither exclusion costs a class: every class present in the full capture is
 * still present in the universe, which the script asserts rather than assumes.
 *
 * Selection is then a per-`(split, class)` quota: take up to `CARRIERS_PER_CELL`
 * scripts carrying each class on each side of the split, SMALLEST FIRST so the
 * fixture stays reviewable, ties broken by path. Four carriers rather than one
 * so a disagreement is never judged on a single document. Finally, add every
 * script whose two versions disagree — that disagreement is the only
 * version-dependent datum in the capture and there are few enough to take all.
 *
 * ## What the slice is NOT
 *
 * Not a random sample. Smallest-first selection biases toward short scripts,
 * and the corpus underneath is already 96.8% two forum authors (#203). An
 * agreement percentage computed over this slice describes THIS SLICE. It is a
 * trend line — does a lexer change move it up or down — never a coverage claim.
 * The `_source` block says so in the fixture itself, because the number will
 * outlive this comment.
 *
 * Run: bun run explain:highlight-slice [--streams <dir>] [--out <path>]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
	describeResolution,
	resolveCorpusDb,
	unreachableMessage,
} from "./corpus-fetch.ts";

/** RouterOS versions captured, base first. The base carries the pairs. */
const VERSIONS = ["7.23.2", "7.24rc2"] as const;
type Version = (typeof VERSIONS)[number];

/** Carriers to take per (split, class) cell. */
const CARRIERS_PER_CELL = 4;

/** `ROUTEROS_API_MAX_BYTES` — the capture sent at most this many characters. */
const MAX_BYTES = 32767;

/**
 * Exact copy of lsp-routeros-ts `server/src/routeros.ts` replaceNonAscii, the
 * transform the capture applied before sending a script to the device. It is
 * reproduced (not imported) because it belongs to the other repo and the slice
 * must be able to CHECK the claim without depending on that checkout.
 */
function replaceNonAscii(text: string, replacement: string): string {
	let result = "";
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		result += code >= 0 && code <= 127 ? text.charAt(i) : replacement;
	}
	return result;
}

const DEFAULT_STREAM_DIR = ".scratch";
const DEFAULT_OUT = resolve(
	import.meta.dir,
	"../test/fixtures/explain/highlight-streams.slice.json",
);
const PARTITION = resolve(
	import.meta.dir,
	"../test/fixtures/explain/corpus-partition.json",
);

type Pair = [text: string, cls: string];

interface CapturedStream {
	bytes: number;
	truncated: boolean;
	tokenCount: number;
	aligned: boolean;
	pairs?: Pair[];
}

interface Capture {
	routerosVersion: string;
	chrBuildTime: string;
	capturedAt: string;
	corpusRows: number;
	aligned: number;
	misaligned: number;
	/** Absent on captures cut before REST failures were split out of `misaligned`. */
	failed?: number;
	truncated: number;
	streams: Record<string, CapturedStream>;
}

interface PartitionGroup {
	key: string;
	split: "dev" | "holdout";
	scripts: string[];
}

interface Partition {
	counts: Record<string, number>;
	groups: PartitionGroup[];
}

function flag(args: readonly string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function classesOf(streams: readonly (Pair[] | undefined)[]): Set<string> {
	const out = new Set<string>();
	for (const pairs of streams) for (const [, cls] of pairs ?? []) out.add(cls);
	return out;
}

/**
 * Serialized cost of one script in the output: the base pairs, plus the other
 * version's only when it differs. Drives smallest-first selection.
 */
function costOf(pairsByVersion: Map<Version, Pair[]>): number {
	const base = JSON.stringify(pairsByVersion.get(VERSIONS[0]) ?? []);
	let total = base.length;
	for (const version of VERSIONS.slice(1)) {
		const other = JSON.stringify(pairsByVersion.get(version as Version) ?? []);
		if (other !== base) total += other.length;
	}
	return total;
}

export async function main(args: readonly string[]): Promise<number> {
	const streamDir = flag(args, "--streams") ?? DEFAULT_STREAM_DIR;
	const outPath = flag(args, "--out") ?? DEFAULT_OUT;

	const captures = new Map<Version, Capture>();
	const sourceHashes: Record<string, string> = {};
	for (const version of VERSIONS) {
		const path = `${streamDir}/explain-lab-q13-streams.v${version}.json`;
		const file = Bun.file(path);
		if (!(await file.exists())) {
			console.error(
				`::error title=explain highlight slice::${path} is not present\n` +
					"The full per-character captures are ~7.5 MB per version and are not " +
					"committed. Recapture them with `bun run explain:probe:highlight-recapture` " +
					"against a CHR of each version, or pass --streams <dir>.",
			);
			return 1;
		}
		sourceHashes[path] = sha256(new Uint8Array(await file.arrayBuffer()));
		captures.set(version, (await file.json()) as Capture);
	}

	const base = captures.get(VERSIONS[0]) as Capture;
	const partition = (await Bun.file(PARTITION).json()) as Partition;
	const splitOf = new Map<string, "dev" | "holdout">();
	for (const group of partition.groups) {
		for (const script of group.scripts) splitOf.set(script, group.split);
	}

	const allPaths = Object.keys(base.streams).sort();
	const pairsFor = (path: string): Map<Version, Pair[]> => {
		const out = new Map<Version, Pair[]>();
		for (const version of VERSIONS) {
			const stream = captures.get(version)?.streams[path];
			if (stream?.pairs) out.set(version, stream.pairs);
		}
		return out;
	};

	// --- universe, and the two exclusions -----------------------------------
	const excludedTruncated: string[] = [];
	const excludedUnsplit: string[] = [];
	const universe: string[] = [];
	for (const path of allPaths) {
		const streamsForPath = [...VERSIONS].map(
			(v) => captures.get(v)?.streams[path],
		);
		if (streamsForPath.some((s) => s?.truncated)) {
			excludedTruncated.push(path);
			continue;
		}
		if (!splitOf.has(path)) {
			excludedUnsplit.push(path);
			continue;
		}
		if (streamsForPath.some((s) => !s?.pairs)) {
			// A misaligned capture carries no pairs by design (no fabrication past a
			// desync). Nothing to slice.
			excludedTruncated.push(path);
			continue;
		}
		universe.push(path);
	}

	// The exclusions must not silently drop a class. Assert, do not assume.
	const allClasses = classesOf(
		allPaths.flatMap((p) => [...pairsFor(p).values()]),
	);
	const universeClasses = classesOf(
		universe.flatMap((p) => [...pairsFor(p).values()]),
	);
	const lost = [...allClasses].filter((c) => !universeClasses.has(c)).sort();
	if (lost.length > 0) {
		console.error(
			`::error title=explain highlight slice::excluding truncated and ` +
				`unsplit scripts loses these classes entirely: ${lost.join(", ")}. ` +
				"Widen the universe or record them another way; do not ship a slice " +
				"whose vocabulary is smaller than the capture's.",
		);
		return 1;
	}

	// --- selection ----------------------------------------------------------
	const cells = new Map<string, string[]>();
	for (const path of universe) {
		const split = splitOf.get(path) as "dev" | "holdout";
		for (const cls of classesOf([...pairsFor(path).values()])) {
			const key = `${split}|${cls}`;
			const bucket = cells.get(key);
			if (bucket) bucket.push(path);
			else cells.set(key, [path]);
		}
	}

	const cost = new Map(universe.map((p) => [p, costOf(pairsFor(p))]));
	const selected = new Set<string>();
	for (const [, candidates] of [...cells].sort((a, b) =>
		a[0] < b[0] ? -1 : 1,
	)) {
		candidates.sort(
			(x, y) => (cost.get(x) ?? 0) - (cost.get(y) ?? 0) || (x < y ? -1 : 1),
		);
		let taken = candidates.filter((p) => selected.has(p)).length;
		for (const path of candidates) {
			if (taken >= CARRIERS_PER_CELL) break;
			if (!selected.has(path)) {
				selected.add(path);
				taken++;
			}
		}
	}

	const versionDiffering: string[] = [];
	for (const path of universe) {
		const byVersion = pairsFor(path);
		const baseJson = JSON.stringify(byVersion.get(VERSIONS[0]));
		if (
			VERSIONS.slice(1).some(
				(v) => JSON.stringify(byVersion.get(v as Version)) !== baseJson,
			)
		) {
			versionDiffering.push(path);
			selected.add(path);
		}
	}

	// --- check the captured bytes against the corpus ------------------------
	// The `_readAs` claim below — that the pairs concatenate to
	// `replaceNonAscii(corpus text)` and NOT to the corpus text — is the whole
	// reason a consumer can score a lexer against this file. Verify it here
	// rather than asserting it in prose, and get the true replacement count on
	// the way (an earlier draft counted `?` in the output, which over-counts
	// every genuine question mark in a script).
	const corpus = resolveCorpusDb();
	if (corpus.path === undefined) {
		console.error(unreachableMessage("explain highlight slice"));
		return 1;
	}
	console.error(describeResolution(corpus));
	const db = new Database(corpus.path, { readonly: true });
	const corpusText = new Map<string, string>();
	try {
		for (const row of db
			.query("SELECT path, text FROM source_scripts")
			.all() as { path: string; text: string }[]) {
			corpusText.set(row.path, row.text);
		}
	} finally {
		db.close();
	}

	// How many of the WHOLE capture the transform altered, not just the selected
	// scripts — the `_readAs` sentence is about the capture, and a figure that
	// silently means something narrower is the drift this file exists to avoid.
	let nonAsciiInCapture = 0;
	for (const path of allPaths) {
		const source = corpusText.get(path);
		if (source !== undefined && replaceNonAscii(source, "?") !== source) {
			nonAsciiInCapture++;
		}
	}

	// --- emit ---------------------------------------------------------------
	const scripts: Record<string, unknown> = {};
	const coverage: Record<string, number> = {};
	let nonAscii = 0;
	const unverified: string[] = [];
	for (const path of [...selected].sort()) {
		const byVersion = pairsFor(path);
		const basePairs = byVersion.get(VERSIONS[0]) as Pair[];
		const baseJson = JSON.stringify(basePairs);
		const split = splitOf.get(path) as "dev" | "holdout";
		const text = basePairs.map(([fragment]) => fragment).join("");
		const source = corpusText.get(path);
		if (source === undefined) unverified.push(path);
		else {
			const sent = replaceNonAscii(source.substring(0, MAX_BYTES), "?");
			if (sent !== text) unverified.push(path);
			else if (sent !== source) nonAscii++;
		}
		const streams: Record<string, Pair[] | null> = {
			[VERSIONS[0]]: basePairs,
		};
		for (const version of VERSIONS.slice(1)) {
			const other = byVersion.get(version as Version) as Pair[];
			streams[version] = JSON.stringify(other) === baseJson ? null : other;
		}
		scripts[path] = { split, chars: text.length, streams };
		for (const cls of classesOf([...byVersion.values()])) {
			coverage[`${split}|${cls}`] = (coverage[`${split}|${cls}`] ?? 0) + 1;
		}
	}

	if (unverified.length > 0) {
		console.error(
			`::error title=explain highlight slice::${unverified.length} selected ` +
				"scripts do not concatenate to `replaceNonAscii(corpus text, '?')` " +
				`against the pinned corpus: ${unverified.slice(0, 5).join(", ")}. ` +
				"The capture and the corpus snapshot have drifted apart — re-pin one " +
				"or recapture the other; do not ship a slice whose bytes cannot be " +
				"traced to a corpus row.",
		);
		return 1;
	}

	const totalCost = [...selected].reduce((a, p) => a + (cost.get(p) ?? 0), 0);
	const output = {
		_source:
			"Stratified slice of the Q13 per-character `/console/inspect " +
			"request=highlight` captures (centrs#185 phase 0, promoted by #186 " +
			"workstream 3 to unblock #263). Every pair is device output; no row is " +
			"hand-written. NOT A RANDOM SAMPLE: selection is a per-(split, class) " +
			"quota taken smallest-first, over a corpus that is already 96.8% two " +
			"forum authors (#203). An agreement percentage computed over this file " +
			"describes this file — it is a trend line, never a coverage claim.",
		_readAs:
			"`streams[<version>]` is a run-length [text, class] list. `null` for a " +
			"non-base version means byte-identical to the base version's stream. " +
			"Concatenating the base pairs yields THE BYTES THE DEVICE SAW, which is " +
			"`replaceNonAscii(source_scripts.text.substring(0, 32767), '?')` — NOT " +
			`the raw corpus text: ${nonAsciiInCapture} of the ${allPaths.length} ` +
			"captured scripts contain non-ASCII that the capture replaced before " +
			"sending. Score an offline lexer against the concatenated pairs, never " +
			"against the corpus row, or the two halves are reading different bytes " +
			"(the #269 failure, one layer up).",
		baseVersion: VERSIONS[0],
		versions: VERSIONS.map((version) => {
			const capture = captures.get(version) as Capture;
			return {
				version,
				routerosVersion: capture.routerosVersion,
				chrBuildTime: capture.chrBuildTime,
				capturedAt: capture.capturedAt,
				corpusRows: capture.corpusRows,
				aligned: capture.aligned,
				misaligned: capture.misaligned,
				/**
				 * A capture cut before the probe separated the two counters reports
				 * `null` here, and its `misaligned` may include REST failures — a
				 * transport error is not a token/byte desync, and folding them
				 * together publishes a wrong alignment figure. Recapture to get a
				 * number.
				 */
				failed: capture.failed ?? null,
				truncated: capture.truncated,
			};
		}),
		source: {
			generatedBy: "scripts/explain-highlight-slice.ts",
			partition: "test/fixtures/explain/corpus-partition.json",
			corpus: `${corpus.source}${corpus.sha256 ? ` sha256:${corpus.sha256}` : ""}`,
			captures: sourceHashes,
			note:
				"The full captures are ~7.5 MB per version and are gitignored. " +
				"Recapture with `bun run explain:probe:highlight-recapture`; the " +
				"sha256 above identifies the exact bytes this slice was cut from.",
		},
		selection: {
			rule:
				`up to ${CARRIERS_PER_CELL} carrier scripts per (split, class) cell, ` +
				"smallest-serialized-cost first with ties broken by path, plus every " +
				"script whose captured versions disagree",
			carriersPerCell: CARRIERS_PER_CELL,
			capturedScripts: allPaths.length,
			universe: universe.length,
			selected: selected.size,
			versionDiffering: versionDiffering.length,
			/**
			 * Selected scripts the capture altered before sending, verified by
			 * re-running the transform over the pinned corpus row — not by counting
			 * `?` in the output, which every genuine question mark inflates.
			 */
			nonAsciiReplaced: nonAscii,
			/**
			 * (split, class) cells with no carrier anywhere in the universe, so the
			 * quota could not be filled. A cell here is a fact about the corpus, not
			 * a hole in the slice — but it is the reason `coverage` is shorter than
			 * splits × classes, and a reader should not have to diff two lists.
			 */
			cellsWithNoCarrier: (["dev", "holdout"] as const)
				.flatMap((split) =>
					[...allClasses].sort().map((cls) => `${split}|${cls}`),
				)
				.filter((cell) => !cells.has(cell)),
			excluded: {
				truncatedOrMisaligned: excludedTruncated,
				outsideFrozenSplit: excludedUnsplit,
			},
			classesInCapture: [...allClasses].sort(),
		},
		coverage: Object.fromEntries(
			Object.entries(coverage).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
		),
		scripts,
	};

	await Bun.write(outPath, `${JSON.stringify(output, null, "\t")}\n`);
	const bytes = Bun.file(outPath).size;
	console.error(
		`wrote ${outPath}: ${selected.size} scripts of ${universe.length} in universe ` +
			`(${allPaths.length} captured), ${versionDiffering.length} version-differing, ` +
			`${(totalCost / 1024).toFixed(0)} KB of pairs, ${(bytes / 1024).toFixed(0)} KB on disk`,
	);
	return 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
