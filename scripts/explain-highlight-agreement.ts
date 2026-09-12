#!/usr/bin/env bun
/**
 * Device-agreement report for the token partition (#264 B4, #263).
 *
 * The token census (`explain:token-census`) answers "how many bytes did
 * offline analysis claim". This answers the other half: **of the bytes it
 * claimed, how many did the device agree with**. The oracle is the committed
 * stratified slice of the Q13 `/console/inspect request=highlight` captures
 * (`test/fixtures/explain/highlight-streams.slice.json`), so this needs no
 * router, no corpus, and no network — which is why it can gate in the unit
 * suite (`test/unit/explain-highlight-agreement.test.ts`) rather than in the
 * corpus job.
 *
 * ```
 * bun run explain:highlight-agreement               # markdown
 * bun run explain:highlight-agreement --json        # the committed fixture
 * bun run explain:highlight-agreement --check       # gate: fresh vs fixture
 * bun run explain:highlight-agreement --readme      # rewrite the README block
 * bun run explain:highlight-agreement --readme --check
 * ```
 *
 * ## What is committed and what is derived
 *
 * The fixture holds the **raw per-byte confusion matrix** (centrs class ×
 * device class, split dev/holdout, split pre-/post-parser-stop, per captured
 * version) and nothing else. Every percentage, bucket and table in the README
 * is derived from that matrix plus `HIGHLIGHT_PROJECTION` at render time. So a
 * change to the projection moves the README without moving the fixture, and
 * `--readme --check` in `lint:ci` shows the effect of that change as a diff —
 * which is the point, since the projection is the part under review (#260: a
 * generated summary drifting from what it summarizes is silent).
 *
 * ## Why this is a trend, never a pass gate
 *
 * The slice is a per-(split, class) quota over a corpus that is 96.8% two
 * forum authors (#203), so an agreement percentage computed here describes
 * this slice. It moves with parser changes, which is what makes it useful, and
 * it is not a threshold anything is allowed to fail on. The acceptance
 * criterion in `commands/explain/README.md` says this in the same words.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Applicability,
	applicabilityOf,
	deviceClassKind,
	HIGHLIGHT_PROJECTION,
	projectTokenClass,
} from "../src/explain/highlight-projection.ts";
import { explainCommand } from "../src/explain.ts";
import { sha256TextFile } from "./corpus-fetch.ts";

/** A run-length `[text, class]` pair, exactly as the device emitted it. */
type Pair = [text: string, cls: string];

interface SliceScript {
	split: "dev" | "holdout";
	chars: number;
	streams: Record<string, Pair[] | null>;
}

interface Slice {
	baseVersion: string;
	versions: { version: string; routerosVersion: string }[];
	selection: { selected: number; versionDiffering: number };
	scripts: Record<string, SliceScript>;
}

/**
 * `"<centrs class>|<device class>|<same|differs>"` → byte count.
 *
 * The third component is whether EVERY captured version gave this byte the
 * same device class. It rides the key rather than a parallel structure so the
 * applicability axis (#263 category 4) stays derivable from the committed
 * matrix instead of being baked in at measure time — the same reason the
 * buckets are derived rather than stored.
 */
export type Matrix = Record<string, number>;

/** One decoded matrix key. */
export interface Cell {
	centrsClass: string;
	deviceClass: string;
	versionsAgree: boolean;
}

export interface SplitMeasurement {
	scripts: number;
	bytes: number;
	/** Scripts where the device emitted its one-byte `error` and stopped. */
	scriptsWithParserStop: number;
	/** Bytes at or after that `error` byte. */
	stoppedBytes: number;
	/** Confusion matrix before the parser stop — the measurable region. */
	live: Matrix;
	/** Confusion matrix from the `error` byte on, kept so the tail is visible. */
	stopped: Matrix;
}

export interface VersionMeasurement {
	routerosVersion: string;
	dev: SplitMeasurement;
	holdout: SplitMeasurement;
}

export interface HighlightAgreement {
	/** Provenance line for a reader who opens the fixture first. */
	_note?: string;
	slice: {
		path: string;
		sha256: string;
		baseVersion: string;
		scripts: number;
		versionDiffering: number;
	};
	versions: Record<string, VersionMeasurement>;
	/**
	 * One representative source fragment per live cell of the base version, so
	 * #264 B5 can read a disagreement rather than a count (#263 acceptance).
	 * Raw observation, independent of the projection: the renderer picks which
	 * cells it shows.
	 */
	examples: Record<string, CellExample>;
}

export interface CellExample {
	/** The most frequent contiguous run of this cell, capped at 40 bytes. */
	text: string;
	/** How many times that exact run occurs across the slice. */
	runs: number;
	/** Where to find the first one: slice script path, and its byte offset. */
	path: string;
	offset: number;
}

/**
 * The nine outcomes a byte can have. Exhaustive and disjoint, so they sum to
 * the measured byte count — the same discipline the token partition itself
 * keeps.
 */
export interface Buckets {
	/** Both decided a syntax class and the projection accepts the device's. */
	agree: number;
	/** Both decided a syntax class and the projection does not accept it. */
	disagree: number;
	/** centrs decided, but the class deliberately projects nowhere. */
	unprojected: number;
	/** centrs abstained where the device decided a syntax class. */
	offlineSilent: number;
	/** The device answered with a class the source text alone does not decide. */
	nonSyntax: number;
	/** The device abstained (`none`) where centrs decided. */
	deviceSilent: number;
	/** Both abstained. */
	bothSilent: number;
	/** At or after the device's one-byte `error`, and silent from there on. */
	parserStopped: number;
	/**
	 * Past the `error`, and the device classified again anyway.
	 *
	 * Its own bucket rather than part of the stopped tail because "the device
	 * gives up at its first error" is a claim, and this is the number that
	 * says how far it holds: zero on 7.23.2, non-zero on 7.24rc2. Folding these
	 * bytes into `parserStopped` would let the report assert a rule its own
	 * measurement contradicts.
	 */
	parserRecovered: number;
}

const BUCKET_ORDER: readonly (keyof Buckets)[] = [
	"agree",
	"disagree",
	"unprojected",
	"offlineSilent",
	"nonSyntax",
	"deviceSilent",
	"bothSilent",
	"parserStopped",
	"parserRecovered",
];

export function emptyBuckets(): Buckets {
	return {
		agree: 0,
		disagree: 0,
		unprojected: 0,
		offlineSilent: 0,
		nonSyntax: 0,
		deviceSilent: 0,
		bothSilent: 0,
		parserStopped: 0,
		parserRecovered: 0,
	};
}

export function parseCell(key: string): Cell {
	const parts = key.split("|");
	if (parts.length !== 3) throw new Error(`malformed matrix key ${key}`);
	const [centrsClass, deviceClass, versions] = parts as [
		string,
		string,
		string,
	];
	if (versions !== "same" && versions !== "differs")
		throw new Error(`malformed version component in ${key}`);
	return { centrsClass, deviceClass, versionsAgree: versions === "same" };
}

export function cellKey(
	centrsClass: string,
	deviceClass: string,
	versionsAgree: boolean,
): string {
	return `${centrsClass}|${deviceClass}|${versionsAgree ? "same" : "differs"}`;
}

/** Which bucket one `centrs × device` cell of the LIVE matrix falls into. */
export function bucketOf(
	centrsClass: string,
	deviceClass: string,
): keyof Buckets {
	const kind = deviceClassKind(deviceClass);
	if (kind === "parser-stop") return "parserStopped";
	if (kind === "non-syntax") return "nonSyntax";
	if (kind === "silence")
		return centrsClass === "unclassified" ? "bothSilent" : "deviceSilent";
	// `unknown` is an upstream class this build has never seen. Counting it as
	// a disagreement would blame the parser for the device's new vocabulary, so
	// it lands with the other "no comparable answer" bytes and the report names
	// it in its own line.
	if (kind === "unknown") return "unprojected";
	if (centrsClass === "unclassified") return "offlineSilent";
	// The device side above absorbs upstream drift; this side must NOT. A centrs
	// class the projection does not name means the committed matrix predates the
	// vocabulary, and these functions run over fixture keys — data, not types —
	// so the cast below would otherwise surface as a bare `undefined.accepts`
	// TypeError inside `lint:ci` instead of naming the stale fixture.
	if (!Object.hasOwn(HIGHLIGHT_PROJECTION, centrsClass))
		throw new Error(
			`no declared projection for centrs class \`${centrsClass}\`; the committed ` +
				"matrix predates src/explain/highlight-projection.ts. Repin with " +
				"`bun run explain:highlight-agreement --json > test/fixtures/explain/highlight-agreement.json`",
		);
	const accepts = projectTokenClass(
		centrsClass as keyof typeof HIGHLIGHT_PROJECTION,
	);
	if (accepts === null) return "unprojected";
	return accepts.includes(deviceClass) ? "agree" : "disagree";
}

/**
 * Which bucket one cell of the STOPPED matrix falls into.
 *
 * Everything past the `error` byte used to be counted as `parserStopped`
 * wholesale, which threw away the one measurement that tests the claim: 7.24rc2
 * classifies 96 bytes after its `error`, and folding them into the stopped tail
 * made the report assert "the device does not recover" while its own fixture
 * said otherwise. The `error` byte itself is the stop marker, not a recovery.
 */
export function stoppedBucketOf(deviceClass: string): keyof Buckets {
	const kind = deviceClassKind(deviceClass);
	return kind === "parser-stop" || kind === "silence"
		? "parserStopped"
		: "parserRecovered";
}

export function bucketsOf(measurement: SplitMeasurement): Buckets {
	const out = emptyBuckets();
	for (const [key, count] of Object.entries(measurement.live)) {
		const { centrsClass, deviceClass } = parseCell(key);
		out[bucketOf(centrsClass, deviceClass)] += count;
	}
	for (const [key, count] of Object.entries(measurement.stopped)) {
		const { deviceClass } = parseCell(key);
		out[stoppedBucketOf(deviceClass)] += count;
	}
	return out;
}

export function addBuckets(a: Buckets, b: Buckets): Buckets {
	const out = emptyBuckets();
	for (const key of BUCKET_ORDER) out[key] = a[key] + b[key];
	return out;
}

/**
 * Agreement over the bytes where BOTH sides decided a syntax class. Every
 * other bucket is reported beside it, never folded in: an abstention is not a
 * disagreement, and the device's silence is not an agreement.
 */
export function decidedAgreementPct(buckets: Buckets): number {
	const decided = buckets.agree + buckets.disagree;
	return decided === 0 ? 0 : (buckets.agree / decided) * 100;
}

/**
 * Bytes of one bucket, folded to `"<centrs>|<device>"` so the version
 * component does not split a cell in two in a table about agreement.
 */
export function cellsInBucket(
	measurement: SplitMeasurement,
	bucket: keyof Buckets,
): [string, number][] {
	const folded = new Map<string, number>();
	for (const [key, count] of Object.entries(measurement.live)) {
		const { centrsClass, deviceClass } = parseCell(key);
		if (bucketOf(centrsClass, deviceClass) !== bucket) continue;
		const pair = `${centrsClass}|${deviceClass}`;
		folded.set(pair, (folded.get(pair) ?? 0) + count);
	}
	return [...folded].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Bytes per applicability category, over EVERY measured byte (#263).
 *
 * The post-`error` tail runs through the same rule as the live region rather
 * than being folded into `no-device-answer` wholesale. It has to: where one
 * capture stops parsing and the next does not, the tail is precisely a
 * version disagreement, and counting it as "the device said nothing" would
 * decide that on the strength of whichever build happens to be the base — the
 * same error the precedence fix removed one level down.
 */
export function applicabilityOfSplit(
	measurement: SplitMeasurement,
): Map<Applicability, number> {
	const out = new Map<Applicability, number>();
	for (const region of [measurement.live, measurement.stopped])
		for (const [key, count] of Object.entries(region)) {
			const { centrsClass, deviceClass, versionsAgree } = parseCell(key);
			const category = applicabilityOf(centrsClass, deviceClass, versionsAgree);
			out.set(category, (out.get(category) ?? 0) + count);
		}
	return out;
}

/** The cells behind one applicability category, descending. */
export function cellsInApplicability(
	measurement: SplitMeasurement,
	category: Applicability,
): [string, number][] {
	const folded = new Map<string, number>();
	for (const region of [measurement.live, measurement.stopped])
		for (const [key, count] of Object.entries(region)) {
			const { centrsClass, deviceClass, versionsAgree } = parseCell(key);
			if (applicabilityOf(centrsClass, deviceClass, versionsAgree) !== category)
				continue;
			const pair = `${centrsClass}|${deviceClass}`;
			folded.set(pair, (folded.get(pair) ?? 0) + count);
		}
	return [...folded].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function mergeMatrices(...matrices: Matrix[]): Matrix {
	const out: Matrix = {};
	for (const matrix of matrices)
		for (const [key, count] of Object.entries(matrix))
			out[key] = (out[key] ?? 0) + count;
	return out;
}

export function mergeSplits(...splits: SplitMeasurement[]): SplitMeasurement {
	return {
		scripts: splits.reduce((sum, s) => sum + s.scripts, 0),
		bytes: splits.reduce((sum, s) => sum + s.bytes, 0),
		scriptsWithParserStop: splits.reduce(
			(sum, s) => sum + s.scriptsWithParserStop,
			0,
		),
		stoppedBytes: splits.reduce((sum, s) => sum + s.stoppedBytes, 0),
		live: mergeMatrices(...splits.map((s) => s.live)),
		stopped: mergeMatrices(...splits.map((s) => s.stopped)),
	};
}

/** Where the committed slice lives; exported so a test can read the same bytes. */
export const SLICE_PATH = join(
	import.meta.dir,
	"..",
	"test",
	"fixtures",
	"explain",
	"highlight-streams.slice.json",
);
const FIXTURE_PATH = join(
	import.meta.dir,
	"..",
	"test",
	"fixtures",
	"explain",
	"highlight-agreement.json",
);
const README_PATH = join(
	import.meta.dir,
	"..",
	"commands",
	"explain",
	"README.md",
);

export function readSlice(path = SLICE_PATH): Slice {
	return JSON.parse(readFileSync(path, "utf8")) as Slice;
}

/** Per-byte device classes of one run-length stream. */
function expand(pairs: readonly Pair[]): string[] {
	const out: string[] = [];
	for (const [text, cls] of pairs)
		for (let i = 0; i < text.length; i++) out.push(cls);
	return out;
}

/** Per-byte centrs token classes; `unclassified` where no token exists. */
function offlineClasses(text: string): string[] {
	const data = explainCommand(text, { tokens: true });
	if (data.input.bytes !== text.length)
		throw new Error(
			`analyzed byte count ${data.input.bytes} !== slice char count ${text.length}; ` +
				"the slice is supposed to be pure ASCII (non-ASCII was replaced at capture time)",
		);
	const out: string[] = new Array(text.length).fill("unclassified");
	for (const token of data.tokens ?? [])
		for (let i = token.start; i < token.end; i++) out[i] = token.class;
	return out;
}

/**
 * Measure the slice.
 *
 * Both oracles must see the same bytes (probes: the #269 rule), so the source
 * text is reconstructed from the device's own run-length pairs — never from
 * the corpus row, which still holds the non-ASCII the capture replaced.
 */
export function measure(
	slice: Slice,
	slicePath = SLICE_PATH,
): HighlightAgreement {
	const paths = Object.keys(slice.scripts).sort();
	const examples: Record<string, ExampleTally> = {};
	const splitsByVersion = new Map<
		string,
		Record<"dev" | "holdout", SplitMeasurement>
	>(
		slice.versions.map(({ version }) => [
			version,
			{ dev: blank(), holdout: blank() },
		]),
	);
	for (const path of paths) {
		const entry = slice.scripts[path];
		if (entry === undefined) throw new Error(`missing slice entry ${path}`);
		const base = entry.streams[slice.baseVersion];
		if (!Array.isArray(base))
			throw new Error(`${path}: no base stream at ${slice.baseVersion}`);
		const text = base.map(([fragment]) => fragment).join("");
		if (text.length !== entry.chars)
			throw new Error(
				`${path}: base stream is ${text.length} chars, header says ${entry.chars}`,
			);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to reject non-ASCII; ASCII control characters are inside the allowed range on purpose.
		if (/[^\x00-\x7F]/.test(text))
			throw new Error(
				`${path}: stream is not pure ASCII, so a char index is not a byte offset`,
			);
		// One analysis serves every version, which is only sound because every
		// capture sent the SAME bytes. Checked below rather than assumed: two
		// streams reconstructing to different text would be two answers about two
		// programs, scored as if they were one (the #269 failure, one layer up).
		const offline = offlineClasses(text);
		const perVersionDevice = new Map<string, string[]>();
		for (const { version } of slice.versions) {
			// `null` on a non-base version means "byte-identical to the base",
			// which is how the slice avoids committing a second copy. An ABSENT
			// key means something else entirely — a truncated or malformed slice —
			// and `??` cannot tell the two apart, so it would silently score that
			// version against the base stream and still produce a valid-looking
			// report.
			if (!Object.hasOwn(entry.streams, version))
				throw new Error(
					`${path}: no stream entry for ${version}; the slice must carry the key ` +
						"even when it is `null` for a byte-identical capture",
				);
			const pairs = entry.streams[version] ?? base;
			if (!Array.isArray(pairs))
				throw new Error(`${path}: no stream at ${version}`);
			const versionText = pairs.map(([fragment]) => fragment).join("");
			if (versionText !== text)
				throw new Error(
					`${path} @${version}: the capture's bytes differ from ${slice.baseVersion}'s, ` +
						"so the two streams are not about the same program",
				);
			perVersionDevice.set(version, expand(pairs));
		}
		// #263 category 4, decided per byte rather than per class: did every
		// capture give this byte the same answer?
		const streams = [...perVersionDevice.values()];
		const versionsAgree: boolean[] = new Array(text.length);
		for (let i = 0; i < text.length; i++) {
			const first = streams[0]?.[i];
			versionsAgree[i] = streams.every((stream) => stream[i] === first);
		}
		for (const { version } of slice.versions) {
			const device = perVersionDevice.get(version);
			if (device === undefined)
				throw new Error(`${path}: no stream captured for ${version}`);
			const stopAt = device.indexOf("error");
			const liveEnd = stopAt < 0 ? text.length : stopAt;
			const target = splitsByVersion.get(version)?.[entry.split];
			if (target === undefined)
				throw new Error(`${path}: no measurement slot for ${version}`);
			target.scripts++;
			target.bytes += text.length;
			if (stopAt >= 0) {
				target.scriptsWithParserStop++;
				target.stoppedBytes += text.length - stopAt;
			}
			for (let i = 0; i < text.length; i++) {
				const key = cellKey(
					offline[i] as string,
					device[i] as string,
					versionsAgree[i] as boolean,
				);
				const matrix = i < liveEnd ? target.live : target.stopped;
				matrix[key] = (matrix[key] ?? 0) + 1;
			}
			if (version !== slice.baseVersion) continue;
			collectExamples(
				examples,
				path,
				text,
				offline,
				device,
				versionsAgree,
				liveEnd,
			);
		}
	}
	const versions: Record<string, VersionMeasurement> = {};
	for (const { version, routerosVersion } of slice.versions) {
		const splits = splitsByVersion.get(version);
		if (splits === undefined) throw new Error(`no measurement for ${version}`);
		versions[version] = {
			routerosVersion,
			dev: sortMatrices(splits.dev),
			holdout: sortMatrices(splits.holdout),
		};
	}
	return {
		_note:
			"centrs → RouterOS `highlight` agreement, raw per-byte confusion matrix only — " +
			"see scripts/explain-highlight-agreement.ts (#264 B4 / #263). Re-derive with " +
			"`bun run explain:highlight-agreement --json`. Buckets and percentages are DERIVED " +
			"at render time from this matrix plus src/explain/highlight-projection.ts; nothing " +
			"here is a pass threshold.",
		slice: {
			path: "test/fixtures/explain/highlight-streams.slice.json",
			// Line-ending-independent: the slice is a committed TEXT file, so its
			// raw bytes depend on the checkout while its content does not.
			sha256: sha256TextFile(slicePath),
			baseVersion: slice.baseVersion,
			scripts: slice.selection.selected,
			versionDiffering: slice.selection.versionDiffering,
		},
		versions,
		examples: settleExamples(examples),
	};
}

/** Per-cell fragment tallies, before the winner is picked. */
type ExampleTally = Map<string, { runs: number; path: string; offset: number }>;

const EXAMPLE_MAX_BYTES = 40;

/**
 * Tally one script's contiguous runs per cell.
 *
 * A "run" is a maximal stretch where the centrs class, the device class and the
 * version-agreement flag are all constant — which is the unit a reader wants to
 * see, not a single byte.
 */
function collectExamples(
	into: Record<string, ExampleTally>,
	path: string,
	text: string,
	offline: readonly string[],
	device: readonly string[],
	versionsAgree: readonly boolean[],
	liveEnd: number,
): void {
	let start = 0;
	while (start < liveEnd) {
		let end = start + 1;
		while (
			end < liveEnd &&
			offline[end] === offline[start] &&
			device[end] === device[start] &&
			versionsAgree[end] === versionsAgree[start]
		)
			end++;
		const key = cellKey(
			offline[start] as string,
			device[start] as string,
			versionsAgree[start] as boolean,
		);
		const fragment = text.slice(
			start,
			Math.min(end, start + EXAMPLE_MAX_BYTES),
		);
		let tally = into[key];
		if (tally === undefined) {
			tally = new Map();
			into[key] = tally;
		}
		const seen = tally.get(fragment);
		if (seen === undefined)
			tally.set(fragment, { runs: 1, path, offset: start });
		else seen.runs++;
		start = end;
	}
}

/**
 * Pick one fragment per cell: most frequent, ties broken by text so a re-run
 * commits the same bytes.
 */
function settleExamples(
	tallies: Record<string, ExampleTally>,
): Record<string, CellExample> {
	const out: Record<string, CellExample> = {};
	for (const key of Object.keys(tallies).sort()) {
		const tally = tallies[key];
		if (tally === undefined) continue;
		const best = [...tally].sort(
			(a, b) =>
				b[1].runs - a[1].runs || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
		)[0];
		if (best === undefined) continue;
		out[key] = {
			text: best[0],
			runs: best[1].runs,
			path: best[1].path,
			offset: best[1].offset,
		};
	}
	return out;
}

function blank(): SplitMeasurement {
	return {
		scripts: 0,
		bytes: 0,
		scriptsWithParserStop: 0,
		stoppedBytes: 0,
		live: {},
		stopped: {},
	};
}

/** Sorted keys so the committed fixture diffs line by line, never wholesale. */
function sortMatrices(measurement: SplitMeasurement): SplitMeasurement {
	const sort = (matrix: Matrix): Matrix =>
		Object.fromEntries(
			Object.entries(matrix).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		);
	return {
		...measurement,
		live: sort(measurement.live),
		stopped: sort(measurement.stopped),
	};
}

/* -------------------------------------------------------------------------
 * Rendering. Everything below derives from the committed matrix plus
 * `HIGHLIGHT_PROJECTION`; nothing re-reads the slice.
 * ---------------------------------------------------------------------- */

const BLOCK_BEGIN =
	"<!-- BEGIN GENERATED highlight-agreement — regenerate with `bun run explain:highlight-agreement:readme` -->";
const BLOCK_END = "<!-- END GENERATED highlight-agreement -->";
const WRAP_COLUMNS = 78;

export function splitLines(text: string): string[] {
	return text.split(/\r?\n/);
}

function lineEndingOf(text: string): string {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function wrap(text: string): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.match(/(?:`[^`]*`|\S)+/g) ?? []) {
		if (line !== "" && line.length + 1 + word.length > WRAP_COLUMNS) {
			lines.push(line);
			line = "";
		}
		line += line === "" ? word : ` ${word}`;
	}
	if (line !== "") lines.push(line);
	return lines;
}

const count = (value: number): string => value.toLocaleString("en-US");
const pct = (value: number): string => `${value.toFixed(2)}%`;

export function allSplits(version: VersionMeasurement): SplitMeasurement {
	return mergeSplits(version.dev, version.holdout);
}

/** agree / disagree per centrs class, over the bytes both sides decided. */
export function perClassAgreement(
	measurement: SplitMeasurement,
): Map<string, { agree: number; disagree: number }> {
	const out = new Map<string, { agree: number; disagree: number }>();
	for (const bucket of ["agree", "disagree"] as const)
		for (const [key, n] of cellsInBucket(measurement, bucket)) {
			const [centrsClass] = key.split("|") as [string, string];
			const row = out.get(centrsClass) ?? { agree: 0, disagree: 0 };
			row[bucket] += n;
			out.set(centrsClass, row);
		}
	return out;
}

/** Bytes each centrs class left unprojected, by class. */
export function perClassUnprojected(
	measurement: SplitMeasurement,
): Map<string, number> {
	const out = new Map<string, number>();
	for (const [key, n] of cellsInBucket(measurement, "unprojected")) {
		const [centrsClass] = key.split("|") as [string, string];
		out.set(centrsClass, (out.get(centrsClass) ?? 0) + n);
	}
	return out;
}

/**
 * The same figure with one centrs class held out.
 *
 * Reported for `comment` because the corpus's harness injected a `# Source: …`
 * banner into nearly every script (#203), so comment bytes dominate the
 * decided region and a single blended percentage is mostly a statement about
 * that banner.
 */
export function decidedAgreementExcluding(
	measurement: SplitMeasurement,
	excluded: string,
): { agree: number; disagree: number; pct: number } {
	let agree = 0;
	let disagree = 0;
	for (const bucket of ["agree", "disagree"] as const)
		for (const [key, n] of cellsInBucket(measurement, bucket)) {
			if (key.split("|")[0] === excluded) continue;
			if (bucket === "agree") agree += n;
			else disagree += n;
		}
	const decided = agree + disagree;
	return { agree, disagree, pct: decided === 0 ? 0 : (agree / decided) * 100 };
}

/** Device classes offline analysis left unclaimed, descending. */
export function offlineSilentByDevice(
	measurement: SplitMeasurement,
): [string, number][] {
	return cellsInBucket(measurement, "offlineSilent").map(([key, n]) => [
		key.split("|")[1] as string,
		n,
	]);
}

const BUCKET_LABEL: Readonly<Record<keyof Buckets, string>> = {
	agree: "agree — both decided, projection accepts",
	disagree: "disagree — both decided, projection rejects",
	unprojected: "unprojected — no declared projection covers the pair",
	offlineSilent: "offline-silent — device decided, centrs abstained",
	nonSyntax: "non-syntax — the device answered something syntax cannot decide",
	deviceSilent: "device-silent — centrs decided, device said `none`",
	bothSilent: "both-silent",
	parserStopped:
		"parser-stopped — at/after the device's `error` byte, and silent from there",
	parserRecovered:
		"parser-recovered — past that `error`, and the device classified anyway",
};

export function renderReadmeBlock(report: HighlightAgreement): string[] {
	const versions = Object.keys(report.versions);
	const baseVersion = report.slice.baseVersion;
	const base = report.versions[baseVersion];
	if (base === undefined)
		throw new Error(`the report has no base version ${baseVersion}`);
	const baseAll = allSplits(base);
	const baseBuckets = bucketsOf(baseAll);
	const exComment = decidedAgreementExcluding(baseAll, "comment");
	const devPct = decidedAgreementPct(bucketsOf(base.dev));
	const holdoutPct = decidedAgreementPct(bucketsOf(base.holdout));

	const lines: string[] = [
		...wrap(
			`The agreement report is re-derivable with \`bun run explain:highlight-agreement\` ` +
				`and needs no router and no corpus: it scores the token partition against ` +
				`\`test/fixtures/explain/highlight-streams.slice.json\`, ${count(report.slice.scripts)} ` +
				`stratified scripts of committed \`/console/inspect request=highlight\` output. ` +
				"The figures below are generated from `test/fixtures/explain/highlight-agreement.json` " +
				"by `bun run explain:highlight-agreement:readme`, gated against it by " +
				"`bun run explain:highlight-agreement:readme:check`, and the fixture itself is gated " +
				"against a fresh measurement by `test/unit/explain-highlight-agreement.test.ts`. " +
				`Of ${count(baseAll.bytes)} bytes at ${baseVersion}, ${count(baseBuckets.agree + baseBuckets.disagree)} ` +
				`are bytes **both** sides decided a syntax class for, and ${pct(decidedAgreementPct(baseBuckets))} ` +
				`of those agree (dev ${pct(devPct)}, holdout ${pct(holdoutPct)}). Set \`comment\` aside — ` +
				`it is ${pct(((baseBuckets.agree + baseBuckets.disagree - exComment.agree - exComment.disagree) / (baseBuckets.agree + baseBuckets.disagree)) * 100)} ` +
				"of that decided region and mostly the corpus's harness-injected `# Source:` banner " +
				`(#203) — and the remaining ${count(exComment.agree + exComment.disagree)} bytes agree ${pct(exComment.pct)}. ` +
				`The device stops classifying at its one-byte \`error\`: ${count(baseAll.scriptsWithParserStop)} of ` +
				`${count(baseAll.scripts)} scripts carry one, and the ${count(baseBuckets.parserStopped)} bytes from ` +
				"there on are not a judgment about anything. The oracle itself moves between captures: " +
				versions
					.map(
						(version) =>
							`${count(allSplits(report.versions[version] as VersionMeasurement).scriptsWithParserStop)} stop at ${version}`,
					)
					.join(" and ") +
				`, and ${count(report.slice.versionDiffering)} of the ${count(report.slice.scripts)} streams ` +
				"differ between them. **This is a trend line, not a pass gate** — the " +
				"slice is a per-(split, class) quota over a corpus that is 96.8% two authors, so the " +
				"percentage describes this slice.",
		),
		"",
		"| centrs class | projects to | agree | disagree | unprojected | of decided |",
		"| ------------ | ----------- | ----: | -------: | ----------: | ---------: |",
	];

	const perClass = perClassAgreement(baseAll);
	const unprojected = perClassUnprojected(baseAll);
	for (const [centrsClass, entry] of Object.entries(HIGHLIGHT_PROJECTION)) {
		// `unclassified` is centrs's own abstention: it can neither agree nor be
		// unprojected, and its bytes are the offline-silent line below.
		if (centrsClass === "unclassified") continue;
		const row = perClass.get(centrsClass);
		const decided = (row?.agree ?? 0) + (row?.disagree ?? 0);
		const projects =
			entry.accepts === null
				? "*abstains*"
				: entry.accepts.map((c) => `\`${c}\``).join(", ");
		lines.push(
			`| \`${centrsClass}\` | ${projects} | ${count(row?.agree ?? 0)} | ${count(row?.disagree ?? 0)} | ${count(unprojected.get(centrsClass) ?? 0)} | ${decided === 0 ? "—" : pct(((row?.agree ?? 0) / decided) * 100)} |`,
		);
	}

	lines.push(
		"",
		`| outcome | ${versions.map((v) => `bytes @${v}`).join(" | ")} |`,
		`| ------- | ${versions.map(() => "----:").join(" | ")} |`,
	);
	const bucketsByVersion = new Map(
		versions.map((version) => {
			const measurement = report.versions[version];
			if (measurement === undefined)
				throw new Error(`missing version ${version}`);
			return [version, bucketsOf(allSplits(measurement))];
		}),
	);
	for (const bucket of BUCKET_ORDER) {
		const cells = versions.map((version) =>
			count(bucketsByVersion.get(version)?.[bucket] ?? 0),
		);
		lines.push(`| ${BUCKET_LABEL[bucket]} | ${cells.join(" | ")} |`);
	}

	const silent = offlineSilentByDevice(baseAll);
	const shown = silent.slice(0, 6);
	const rest = silent.slice(6).reduce((sum, [, n]) => sum + n, 0);
	lines.push(
		"",
		...wrap(
			`Where the device decided and offline analysis did not (${count(baseBuckets.offlineSilent)} bytes ` +
				`at ${baseVersion}, the next fill's target list): ` +
				shown.map(([cls, n]) => `\`${cls}\` ${count(n)}`).join(", ") +
				(rest > 0 ? `, ${count(rest)} across the rest` : "") +
				". Most of the `syntax-meta` share is whitespace the device merged into an " +
				"adjacent structure run rather than a token centrs missed.",
		),
		"",
		...wrap(
			"**Applicability** is the second axis (#263): of the bytes the device did " +
				"answer, what kind of fact was it answering? Assigned from the pair — what " +
				"centrs read the byte as and what the device called it — plus whether the " +
				"captures agreed, never by assigning a whole class to one category. " +
				"It covers every measured byte, the post-`error` tail included: where one " +
				"capture stops parsing and the next does not, that tail IS the version " +
				"disagreement, which is why it dominates the category.",
		),
		"",
		`| applicability @${baseVersion} | bytes | leading cells |`,
		"| ---------------------------- | ----: | ------------- |",
	);
	const applicability = applicabilityOfSplit(baseAll);
	for (const category of APPLICABILITY_ORDER) {
		const bytes = applicability.get(category) ?? 0;
		const leading =
			category === "no-device-answer"
				? "`none` where the captures agree, wherever it falls"
				: cellsInApplicability(baseAll, category)
						.slice(0, 3)
						.map(([cell, n]) => `${renderPair(cell)} ${count(n)}`)
						.join(", ") || "—";
		lines.push(`| ${category} | ${count(bytes)} | ${leading} |`);
	}

	lines.push(
		"",
		...wrap(
			"One representative run per cell, so B5 reads a fragment rather than a " +
				"count. `runs` is how often that exact fragment occurs; the location is " +
				"a slice script and a byte offset into the stream the device saw.",
		),
		"",
		"| outcome | cell | fragment | runs | first at |",
		"| ------- | ---- | -------- | ---: | -------- |",
	);
	for (const bucket of ["disagree", "unprojected"] as const)
		for (const [pair] of cellsInBucket(baseAll, bucket).slice(0, 5)) {
			const example = exampleForPair(report, pair);
			if (example === undefined) continue;
			lines.push(
				`| ${bucket} | ${renderPair(pair)} | ${renderFragment(example.text)} | ${count(example.runs)} | \`${example.path}\` @${example.offset} |`,
			);
		}
	return lines;
}

/**
 * One source fragment, for a markdown table cell.
 *
 * `JSON.stringify` rather than a hand-rolled escape chain, because a chain that
 * rewrites `\n` → `\\n` without first rewriting `\` → `\\` renders a fragment
 * containing a literal backslash-n identically to one containing a newline —
 * and these fragments do carry literal backslashes (`\00` inside a string).
 * JSON escaping is total and reversible; only `|` is left, since GFM splits a
 * table cell on it even inside a code span.
 */
export function renderFragment(text: string): string {
	return `\`${JSON.stringify(text).replace(/\|/g, "\\|")}\``;
}

/** `"<centrs>|<device>"` for a markdown table cell — a literal `|` splits it. */
function renderPair(pair: string): string {
	const [centrsClass, deviceClass] = pair.split("|") as [string, string];
	return `\`${centrsClass}\` → \`${deviceClass}\``;
}

const APPLICABILITY_ORDER: readonly Applicability[] = [
	"offline-decidable",
	"schema-dependent",
	"state-dependent",
	"version-dependent",
	"uncategorized",
	"no-device-answer",
];

/**
 * The example for a `"<centrs>|<device>"` pair, folding the version component
 * the examples are keyed by: the most-run fragment wins, as it does per cell.
 */
export function exampleForPair(
	report: HighlightAgreement,
	pair: string,
): CellExample | undefined {
	let best: CellExample | undefined;
	for (const [key, example] of Object.entries(report.examples)) {
		const { centrsClass, deviceClass } = parseCell(key);
		if (`${centrsClass}|${deviceClass}` !== pair) continue;
		if (
			best === undefined ||
			example.runs > best.runs ||
			(example.runs === best.runs && example.text < best.text)
		)
			best = example;
	}
	return best;
}

export function readFixture(path = FIXTURE_PATH): HighlightAgreement {
	return JSON.parse(readFileSync(path, "utf8")) as HighlightAgreement;
}

/** Committed-vs-measured drift, cell by cell so a diff names the cell. */
export function diffAgainstFixture(
	fresh: HighlightAgreement,
	pinned: HighlightAgreement,
): string[] {
	const drift: string[] = [];
	if (fresh.slice.sha256 !== pinned.slice.sha256)
		drift.push(
			`slice.sha256: fixture ${pinned.slice.sha256.slice(0, 12)}, measured ${fresh.slice.sha256.slice(0, 12)}`,
		);
	for (const key of ["baseVersion", "scripts", "versionDiffering"] as const)
		if (fresh.slice[key] !== pinned.slice[key])
			drift.push(
				`slice.${key}: fixture ${pinned.slice[key]}, measured ${fresh.slice[key]}`,
			);
	const exampleKeys = [
		...new Set([
			...Object.keys(fresh.examples ?? {}),
			...Object.keys(pinned.examples ?? {}),
		]),
	].sort();
	for (const key of exampleKeys) {
		const a = JSON.stringify(fresh.examples?.[key]);
		const b = JSON.stringify(pinned.examples?.[key]);
		if (a !== b)
			drift.push(
				`examples[${key}]: fixture ${b ?? "absent"}, measured ${a ?? "absent"}`,
			);
	}
	const versions = [
		...new Set([
			...Object.keys(fresh.versions),
			...Object.keys(pinned.versions),
		]),
	].sort();
	for (const version of versions) {
		const a = fresh.versions[version];
		const b = pinned.versions[version];
		if (a === undefined || b === undefined) {
			drift.push(
				`${version}: ${a === undefined ? "in the fixture, not measured" : "measured, not in the fixture"}`,
			);
			continue;
		}
		if (a.routerosVersion !== b.routerosVersion)
			drift.push(
				`${version}.routerosVersion: fixture ${b.routerosVersion}, measured ${a.routerosVersion}`,
			);
		for (const split of ["dev", "holdout"] as const) {
			for (const key of [
				"scripts",
				"bytes",
				"scriptsWithParserStop",
				"stoppedBytes",
			] as const)
				if (a[split][key] !== b[split][key])
					drift.push(
						`${version}.${split}.${key}: fixture ${b[split][key]}, measured ${a[split][key]}`,
					);
			for (const region of ["live", "stopped"] as const) {
				const keys = [
					...new Set([
						...Object.keys(a[split][region]),
						...Object.keys(b[split][region]),
					]),
				].sort();
				for (const cell of keys)
					if (a[split][region][cell] !== b[split][region][cell])
						drift.push(
							`${version}.${split}.${region}[${cell}]: fixture ${b[split][region][cell] ?? "absent"}, measured ${a[split][region][cell] ?? "absent"}`,
						);
			}
		}
	}
	return drift;
}

export function runReadme(check: boolean): number {
	const rendered = renderReadmeBlock(readFixture());
	const readme = readFileSync(README_PATH, "utf8");
	const lines = splitLines(readme);
	const begin = lines.indexOf(BLOCK_BEGIN);
	const end = lines.indexOf(BLOCK_END);
	if (begin < 0 || end < begin) {
		console.error(
			"::error title=explain highlight agreement::commands/explain/README.md is missing the generated highlight-agreement block markers",
		);
		return 1;
	}
	const current = lines.slice(begin + 1, end);
	if (current.join("\n") === rendered.join("\n")) {
		if (!check)
			console.error("highlight-agreement README block already current");
		return 0;
	}
	if (check) {
		console.error(
			"::error title=explain highlight agreement::commands/explain/README.md no longer matches " +
				"test/fixtures/explain/highlight-agreement.json projected through " +
				"src/explain/highlight-projection.ts. Run `bun run explain:highlight-agreement:readme`.",
		);
		console.error(`--- README\n${current.join("\n")}`);
		console.error(`+++ fixture\n${rendered.join("\n")}`);
		return 1;
	}
	writeFileSync(
		README_PATH,
		[...lines.slice(0, begin + 1), ...rendered, ...lines.slice(end)].join(
			lineEndingOf(readme),
		),
	);
	console.error(
		"rewrote the highlight-agreement block in commands/explain/README.md",
	);
	return 0;
}

/** Human report: the README block plus the exemplars it deliberately omits. */
function renderMarkdown(report: HighlightAgreement): string {
	const out = [...renderReadmeBlock(report), ""];
	for (const [version, measurement] of Object.entries(report.versions)) {
		const all = allSplits(measurement);
		out.push(`### ${version} (RouterOS ${measurement.routerosVersion})`, "");
		for (const bucket of ["disagree", "unprojected", "deviceSilent"] as const) {
			const cells = cellsInBucket(all, bucket).slice(0, 10);
			out.push(
				`- **${bucket}**: ${cells.map(([cell, n]) => `${cell} ${count(n)}`).join(" · ") || "none"}`,
			);
		}
		out.push("");
	}
	return out.join("\n");
}

export async function main(args: readonly string[]): Promise<number> {
	if (args.includes("--readme")) return runReadme(args.includes("--check"));
	const report = measure(readSlice());
	if (args.includes("--check")) {
		const drift = diffAgainstFixture(report, readFixture());
		if (drift.length > 0) {
			console.error(
				"::error title=explain highlight agreement::the measurement no longer matches " +
					"test/fixtures/explain/highlight-agreement.json. Repin with " +
					"`bun run explain:highlight-agreement --json > test/fixtures/explain/highlight-agreement.json`, " +
					"then `bun run explain:highlight-agreement:readme`.",
			);
			for (const line of drift.slice(0, 40)) console.error(`  ${line}`);
			if (drift.length > 40)
				console.error(`  … and ${drift.length - 40} more cells`);
			return 1;
		}
		console.error("highlight agreement matches the committed fixture");
		return 0;
	}
	const out = args.includes("--json")
		? JSON.stringify(report, null, "\t")
		: renderMarkdown(report);
	await Bun.write(Bun.stdout, `${out}\n`);
	return 0;
}

if (import.meta.main) {
	main(Bun.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(
				`::error title=explain highlight agreement::${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		});
}
