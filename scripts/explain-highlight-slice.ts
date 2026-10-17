/**
 * Cut the committed stratified slice of the per-character highlight streams
 * (#186 workstream 3, gating #263; read from the corpus since #498).
 *
 * ## Why a slice exists at all
 *
 * `/console/inspect request=highlight` is the ONLY per-token oracle RouterOS
 * offers. Since schema 5 the pinned corpus carries it: every channel session's
 * highlight run stores the per-character stream as run-length
 * `[class, count]` pairs (`response_encoding = 'highlight-rle-v1'`), bound to
 * the exact submitted bytes and one device environment. Before #498 the only
 * copy was `.scratch/explain-lab-q13-streams.v<version>.json`, ~7.5 MB per
 * version on one machine. The scorer still reads a committed slice rather
 * than the 36 MB corpus, so the agreement report runs on every PR without a
 * download. So: a slice, chosen by a rule stated in the output.
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
 *   - **outside the split** (37 scripts): the 2 content-hash duplicates the
 *     partition dropped, which would double-weight one document, and the 35
 *     scripts added after the frozen 913-script split was cut, which belong to
 *     neither arm (`test/fixtures/explain/README.md`).
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
 * Run: bun run explain:highlight-slice [--db <path>] [--out <path>]
 *      bun run explain:highlight-slice:check   # gate: fresh cut vs fixture
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
	type ChannelSession,
	channelSessions,
	type HighlightObservation,
	type HighlightPair,
	highlightObservations,
	populationScripts,
} from "./corpus-db.ts";
import {
	describeResolution,
	resolveCorpusDb,
	unreachableMessage,
} from "./corpus-fetch.ts";

/**
 * The channel whose stream every script carries. The others serialize as
 * `null` where they match it, so the base choice is what the fixture costs.
 * Stable is the build users are told to run, and on the #498 sessions the
 * newer channels agree with it on almost every script, so basing anywhere
 * else would pay for the long-term split more than once.
 *
 * The version set itself is the corpus's channel sessions, read at cut time:
 * long-term, stable, testing and development, each one recorded run. Before
 * #342 this was `7.23.2` / `7.24rc2`, neither a current channel, so the
 * token-partition score and the operator axis were never about the same
 * firmware. Before #498 it was a hand-listed trio of `.scratch` files.
 */
const BASE_CHANNEL = "stable";

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

const DEFAULT_OUT = resolve(
	import.meta.dir,
	"../test/fixtures/explain/highlight-streams.slice.json",
);
const PARTITION = resolve(
	import.meta.dir,
	"../test/fixtures/explain/corpus-partition.json",
);

type Pair = HighlightPair;

/** One channel session's highlight run, keyed by population path. */
interface Capture {
	session: ChannelSession;
	streams: Map<string, HighlightObservation>;
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
 * Serialized cost of one script in the output: the base pairs, plus another
 * version's only when it differs. Drives smallest-first selection.
 */
function costOf(versions: readonly string[], byVersion: Map<string, Pair[]>) {
	const base = JSON.stringify(byVersion.get(versions[0] as string) ?? []);
	let total = base.length;
	for (const version of versions.slice(1)) {
		const other = JSON.stringify(byVersion.get(version) ?? []);
		if (other !== base) total += other.length;
	}
	return total;
}

export async function main(args: readonly string[]): Promise<number> {
	// `--check` re-cuts and compares instead of writing: the slice is now cut
	// from the pinned corpus, so CI can hold it to the pin like a census.
	const check = args.includes("--check");
	const outPath = flag(args, "--out") ?? DEFAULT_OUT;

	const corpus = resolveCorpusDb(flag(args, "--db"));
	if (corpus.warning) {
		console.error(`::warning title=explain highlight slice::${corpus.warning}`);
		if (check) {
			console.error(
				"::error title=explain highlight slice::refusing to check against a " +
					"corpus that is not the pinned snapshot — the result would not be " +
					"comparable to CI's.",
			);
			return 1;
		}
	}
	if (corpus.path === undefined) {
		console.error(unreachableMessage("explain highlight slice"));
		return 1;
	}
	console.error(describeResolution(corpus));
	const db = new Database(corpus.path, { readonly: true });
	const captures = new Map<string, Capture>();
	const corpusText = new Map<string, string>();
	let VERSIONS: string[];
	try {
		const sessions = channelSessions(db);
		const base = sessions.find((s) => s.channel === BASE_CHANNEL);
		if (base === undefined)
			throw new Error(`the corpus records no \`${BASE_CHANNEL}\` session`);
		VERSIONS = [base, ...sessions.filter((s) => s !== base)].map(
			(s) => s.version,
		);
		for (const session of sessions)
			captures.set(session.version, {
				session,
				streams: new Map(
					highlightObservations(db, session.highlightRunId).map((o) => [
						o.path,
						o,
					]),
				),
			});
		for (const row of populationScripts(db)) corpusText.set(row.path, row.text);
	} finally {
		db.close();
	}
	const base = captures.get(VERSIONS[0] as string) as Capture;
	const counters = (capture: Capture) => {
		const rows = [...capture.streams.values()];
		return {
			rows: rows.length,
			aligned: rows.filter((r) => r.acquired && r.aligned).length,
			misaligned: rows.filter((r) => r.acquired && !r.aligned).length,
			failed: rows.filter((r) => !r.acquired).length,
			truncated: rows.filter((r) => r.truncated).length,
		};
	};

	// --- the captures must be what they claim, before anything reads them ----
	//
	// Everything downstream makes COMPLETENESS claims — `versionDiffering` is
	// "every script whose versions disagree", `classesInCapture` is "every class
	// the device produced". Neither can be checked against a capture that is
	// short, mislabeled, or partly failed: a script the device never answered for
	// looks exactly like a script with nothing to say. So the claims are only
	// made after the inputs are verified, not repaired around.
	const captureProblems: string[] = [];
	const basePaths = [...base.streams.keys()];
	for (const version of VERSIONS) {
		const capture = captures.get(version) as Capture;
		const c = counters(capture);
		if (c.misaligned > 0 || c.failed > 0) {
			captureProblems.push(
				`v${version} has ${c.misaligned} misaligned and ${c.failed} failed ` +
					"rows — the corpus session is not sliceable",
			);
		}
		// Every version must cover the same scripts, or a version-only class or a
		// version difference is invisible rather than absent.
		const missing = basePaths.filter((p) => !capture.streams.has(p));
		if (capture.streams.size !== basePaths.length || missing.length > 0) {
			captureProblems.push(
				`v${version} covers ${capture.streams.size} scripts, v${VERSIONS[0]} ` +
					`covers ${basePaths.length}${missing.length > 0 ? `, e.g. missing ${missing.slice(0, 3).join(", ")}` : ""}`,
			);
		}
	}
	if (captureProblems.length > 0) {
		console.error(
			"::error title=explain highlight slice::the captures are not complete " +
				"enough to slice:\n" +
				captureProblems.map((problem) => `  - ${problem}`).join("\n") +
				"\nRe-pin a corpus whose sessions are complete. This " +
				"refuses rather than shrinking the universe, because a slice cut from " +
				"a short capture still claims to cover every class and every version " +
				"difference.",
		);
		return 1;
	}

	const partition = (await Bun.file(PARTITION).json()) as Partition;
	const splitOf = new Map<string, "dev" | "holdout">();
	for (const group of partition.groups) {
		for (const script of group.scripts) splitOf.set(script, group.split);
	}

	const allPaths = [...basePaths].sort();
	const pairsFor = (path: string): Map<string, Pair[]> => {
		const out = new Map<string, Pair[]>();
		for (const version of VERSIONS) {
			const stream = captures.get(version)?.streams.get(path);
			if (stream?.pairs) out.set(version, stream.pairs);
		}
		return out;
	};

	// --- universe, and the two exclusions -----------------------------------
	const excludedTruncated: string[] = [];
	const excludedUnsplit: string[] = [];
	const universe: string[] = [];
	for (const path of allPaths) {
		const streamsForPath = VERSIONS.map((v) =>
			captures.get(v)?.streams.get(path),
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
			// Unreachable given the capture check above (a row without pairs is
			// misaligned or failed, and both are refused). Kept as a hard stop
			// rather than a silent exclusion: quietly dropping it here is what let
			// a short capture still claim complete class and version coverage.
			console.error(
				`::error title=explain highlight slice::${path} has no pairs for at ` +
					"least one version, but the capture counters reported none " +
					"missing. The capture is internally inconsistent — recapture it.",
			);
			return 1;
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

	const cost = new Map(universe.map((p) => [p, costOf(VERSIONS, pairsFor(p))]));
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
		const baseJson = JSON.stringify(byVersion.get(VERSIONS[0] as string));
		if (
			VERSIONS.slice(1).some(
				(v) => JSON.stringify(byVersion.get(v)) !== baseJson,
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
		const basePairs = byVersion.get(VERSIONS[0] as string) as Pair[];
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
			[VERSIONS[0] as string]: basePairs,
		};
		for (const version of VERSIONS.slice(1)) {
			const other = byVersion.get(version) as Pair[];
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
			"Stratified slice of the per-character `/console/inspect " +
			"request=highlight` streams in the pinned corpus's channel sessions " +
			"(centrs#185 phase 0, promoted by #186 workstream 3 to unblock #263, " +
			"cut from the corpus since #498). Every pair is device output; no row is " +
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
			const c = counters(capture);
			return {
				version,
				channel: capture.session.channel,
				highlightRun: capture.session.highlightRunId,
				environment: capture.session.environmentSha256,
				corpusRows: c.rows,
				aligned: c.aligned,
				misaligned: c.misaligned,
				failed: c.failed,
				truncated: c.truncated,
			};
		}),
		source: {
			generatedBy: "scripts/explain-highlight-slice.ts",
			partition: "test/fixtures/explain/corpus-partition.json",
			corpus: `sha256:${sha256(new Uint8Array(await Bun.file(corpus.path).arrayBuffer()))}`,
			note:
				"Cut from the pinned corpus (scripts/corpus-pin.json) by session run " +
				"id. Re-cut with `bun run explain:highlight-slice`; the sha256 above " +
				"identifies the exact snapshot this slice was cut from.",
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

	// Format with the repo's own formatter before writing. `JSON.stringify`
	// with a tab indent puts every run-length pair on three lines; biome collapses
	// what fits. Without this the command the fixture README tells contributors to
	// run emits a file that fails `bun run lint` and shows up as a 160 KB
	// formatting-only diff — a regeneration path that cannot be followed is not a
	// regeneration path. Through stdin, named as the fixture, so `--check` and
	// `--out` format exactly as the committed file is formatted.
	const raw = new Response(`${JSON.stringify(output, null, "\t")}\n`);
	const formatted =
		await Bun.$`bunx --bun biome format --stdin-file-path=${DEFAULT_OUT} < ${raw}`
			.nothrow()
			.quiet();
	if (formatted.exitCode !== 0) {
		console.error(
			"::error title=explain highlight slice::biome could not format the slice " +
				`(exit ${formatted.exitCode}), so it is not in the repo's canonical form.\n` +
				formatted.stderr.toString().trim(),
		);
		return 1;
	}
	const fresh = formatted.stdout.toString();
	if (check) {
		const committed = (await Bun.file(DEFAULT_OUT).text()).replaceAll(
			"\r\n",
			"\n",
		);
		if (fresh !== committed) {
			console.error(
				"::error title=explain highlight slice::a fresh cut from the pinned " +
					"corpus no longer matches test/fixtures/explain/highlight-streams.slice.json. " +
					"Re-cut with `bun run explain:highlight-slice`, then " +
					"`bun run explain:highlight-agreement --json` and its README block.",
			);
			return 1;
		}
		console.error("highlight slice matches the committed fixture");
		return 0;
	}
	await Bun.write(outPath, fresh);
	const bytes = Bun.file(outPath).size;
	console.error(
		`wrote ${outPath}: ${selected.size} scripts of ${universe.length} in universe ` +
			`(${allPaths.length} captured), ${versionDiffering.length} version-differing, ` +
			`${(totalCost / 1024).toFixed(0)} KB of pairs, ${(bytes / 1024).toFixed(0)} KB on disk`,
	);
	return 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
