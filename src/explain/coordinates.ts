/**
 * Coordinate contract for `explain` (centrs canonicalizer).
 *
 * Ratified by the phase-0 lab, question Q15 (#185) and contracted in
 * `commands/explain/README.md` (the byte-count-preserving coordinate rule).
 * This is the production promotion of the lab's reference mapper; the six
 * invariants it satisfies are pinned as anchor/property tests in
 * `test/unit/explain-coordinates.test.ts` against
 * `test/fixtures/explain/coordinates.json`.
 *
 * THREE COORDINATE SPACES
 *
 *   original    the caller's JS string. UTF-16 code units. Addressable as
 *               (line, utf16Col) — the LSP position space.
 *   originalU8  the UTF-8 encoding of `original`. Byte offsets. This is what a
 *               byte-oriented device sees on the wire (RouterOS `highlight`
 *               emits one token per INPUT BYTE).
 *   analyzed    originalU8 with every non-ASCII byte replaced by the SUB
 *               placeholder (0x1A), SAME LENGTH as originalU8. Pure ASCII, so a
 *               JS string built from it has index === byte offset. This is the
 *               surface the offline parser runs on and the space in which probe
 *               offsets (`--cursor <byte>`, highlight spans) are contracted.
 *
 * WHY BYTE-COUNT-PRESERVING NORMALIZATION (the load-bearing choice)
 *
 *   A non-ASCII character is replaced by AS MANY SUB bytes as its UTF-8 length,
 *   never collapsed to one. That makes an `analyzed` byte offset === the
 *   `originalU8` byte offset identically, so a device highlight span (byte
 *   offsets over the UTF-8 it received) and an offline span (analyzed byte
 *   offsets) share ONE coordinate system with no fixup. SUB (U+001A) is chosen
 *   because it is ASCII, is not whitespace, and is none of the RouterOS
 *   delimiters (`; \n { } [ ] ( ) " \ # $ = /`), so it stays glued inside its
 *   token and cannot forge a keyword, menu name, or separator.
 *
 * The production parser consumes the `analyzed` STRING (pure ASCII ⇒ its JS
 * index IS the byte offset); this module converts those byte offsets back to
 * the original (line, utf16Col) for LSP consumers. centrs does NOT NFC-fold:
 * a combining mark is its own code point, its own run, and its own column.
 */

import type { Defect } from "./defects.ts";

/** SUB (U+001A) — the byte-count-preserving stand-in for a non-ASCII byte. */
export const SUB = 0x1a;

/** U+FFFD REPLACEMENT CHARACTER — where a lone surrogate normalizes to. */
const REPLACEMENT = 0xfffd;

/** BYTE ORDER MARK (U+FEFF) — a defect only in leading position; see `coordinateDefects`. */
const BOM = 0xfeff;

/** A 0-based (line, column) position in `original`; column is a UTF-16 count. */
export interface Position {
	line: number;
	col: number;
}

/** A half-open (line, col) range in `original` — the LSP range space. */
export interface Range {
	start: Position;
	end: Position;
}

/** One code point of `original`, located in every coordinate space. */
export interface CharRun {
	/** Unicode scalar value; a lone surrogate is recorded as U+FFFD. */
	codePoint: number;
	/** Offset in `original` (UTF-16 code units). */
	utf16Start: number;
	/** 1 (BMP) or 2 (astral surrogate pair) UTF-16 units. */
	utf16Len: number;
	/** Offset in `analyzed`/`originalU8` (bytes). */
	byteStart: number;
	/** UTF-8 byte length: 1..4 (a lone surrogate → 3 via U+FFFD). */
	byteLen: number;
	/** Whether this run is a single ASCII byte (analyzed byte === original byte). */
	ascii: boolean;
	/** 0-based line. */
	line: number;
	/** 0-based UTF-16 column within the line. */
	col: number;
}

/** The full coordinate analysis of one input string. */
export interface CoordinateAnalysis {
	original: string;
	/** Pure-ASCII surface; `analyzed.length === originalU8.length`. */
	analyzed: Uint8Array;
	originalU8: Uint8Array;
	/**
	 * One run per code point.
	 *
	 * On the {@link CoordinateAnalysis.ascii} path this array is built ON FIRST
	 * READ, not by `analyzeCoordinates`: every caller that only needs an offset
	 * or a position can answer from arithmetic there, and materializing one
	 * object per character was the single largest allocation in the analyzer
	 * (#322). Reading it is always sound — the contract is the array, and the
	 * lazy path builds the same one the eager path would have.
	 */
	runs: CharRun[];
	/** Byte offset of each line's first character (index === 0-based line). */
	lineStarts: number[];
	/**
	 * True when every code point of `original` is ASCII, so `analyzed`,
	 * `originalU8` and `original` agree byte for byte and a byte offset IS a
	 * UTF-16 offset.
	 *
	 * This is the property the three coordinate spaces were defined to make
	 * checkable, and it is what lets a caller skip the mapping rather than
	 * re-derive an identity one. It is a FACT about the input, never a mode: the
	 * non-ASCII path below is unchanged and stays the only reading of a
	 * non-ASCII document.
	 */
	ascii: boolean;
}

/** UTF-8 byte length of a Unicode scalar value. */
function utf8Len(cp: number): number {
	if (cp < 0x80) return 1;
	if (cp < 0x800) return 2;
	if (cp < 0x10000) return 3;
	return 4;
}

/** Encode a Unicode scalar value to its UTF-8 bytes. */
function utf8Encode(cp: number): number[] {
	if (cp < 0x80) return [cp];
	if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
	if (cp < 0x10000)
		return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
	return [
		0xf0 | (cp >> 18),
		0x80 | ((cp >> 12) & 0x3f),
		0x80 | ((cp >> 6) & 0x3f),
		0x80 | (cp & 0x3f),
	];
}

/**
 * Any code point outside ASCII.
 *
 * `u`-mode, so the test is over CODE POINTS: an astral character is one match
 * rather than two halves, and a lone surrogate — which is not a scalar value
 * and therefore not ASCII either — matches as itself. That is the same
 * population the walk below normalizes, so the two cannot disagree about what
 * "all ASCII" means.
 */
const NON_ASCII = /[^\p{ASCII}]/u;

/**
 * Build the coordinate analysis of `original`: its UTF-8 encoding, the
 * byte-count-preserving `analyzed` surface, and one {@link CharRun} per code
 * point locating it in all three spaces.
 *
 * An ALL-ASCII input takes the identity path. Nothing about the contract
 * changes there — the three spaces coincide, which is what the
 * byte-count-preserving rule above was chosen to guarantee — so the mapping is
 * arithmetic and the per-character {@link CharRun} array is deferred to its
 * first reader. The analyzer re-derived that map for every nested block body it
 * descended into, and `pathresolve`'s own `locate` discards the coordinate
 * facts of a body anyway (they are properties of the root input): on a 60 KiB
 * document nested 64 deep it decoded 7.9 MiB and allocated a run object per
 * byte of it, a quarter of total analysis time (#322).
 */
export function analyzeCoordinates(original: string): CoordinateAnalysis {
	if (!NON_ASCII.test(original)) return asciiCoordinates(original);
	const runs: CharRun[] = [];
	const u8: number[] = [];
	const analyzed: number[] = [];
	const lineStarts: number[] = [0];
	let line = 0;
	let col = 0;
	let utf16Pos = 0;

	// `for..of` yields code points and handles surrogate pairs; we track the
	// UTF-16 offset/len separately so an astral char advances col by 2 (its
	// UTF-16 width), which is what an LSP position expects.
	for (const ch of original) {
		let cp = ch.codePointAt(0) as number;
		const utf16Len = ch.length; // 1 or 2
		// A lone surrogate survives in a JS string as a single UTF-16 unit whose
		// code point is in [0xD800,0xDFFF]; it is not a valid scalar → U+FFFD.
		if (cp >= 0xd800 && cp <= 0xdfff) cp = REPLACEMENT;
		const ascii = cp < 0x80;
		const byteStart = u8.length;

		for (const b of utf8Encode(cp)) {
			u8.push(b);
			analyzed.push(ascii ? b : SUB);
		}

		runs.push({
			codePoint: cp,
			utf16Start: utf16Pos,
			utf16Len,
			byteStart,
			byteLen: utf8Len(cp),
			ascii,
			line,
			col,
		});

		utf16Pos += utf16Len;
		// `\n` (0x0A) ends a line. A lone `\r` is an ordinary column, so a `\r\n`
		// sequence advances exactly one line (on the `\n`). Tabs are one column,
		// never expanded — column counts UTF-16 units, not visual width.
		if (cp === 0x0a) {
			line++;
			col = 0;
			lineStarts.push(u8.length);
		} else {
			col += utf16Len;
		}
	}

	return {
		original,
		analyzed: Uint8Array.from(analyzed),
		originalU8: Uint8Array.from(u8),
		runs,
		lineStarts,
		ascii: false,
	};
}

/**
 * The identity analysis of an all-ASCII input.
 *
 * One byte per code unit, so `analyzed`, `originalU8` and `original` are the
 * same sequence and every offset is the same number in all three spaces. Only
 * `lineStarts` needs a scan; `runs` is built on demand by {@link asciiRuns}
 * because most callers never ask for it.
 */
function asciiCoordinates(original: string): CoordinateAnalysis {
	const len = original.length;
	const u8 = new Uint8Array(len);
	const lineStarts = [0];
	for (let i = 0; i < len; i++) {
		const code = original.charCodeAt(i);
		u8[i] = code;
		if (code === 0x0a) lineStarts.push(i + 1);
	}
	let runs: CharRun[] | undefined;
	return {
		original,
		// `analyzed` and `originalU8` are equal by definition here, but they stay
		// separate arrays: they are separately typed, separately indexed surfaces
		// and a shared buffer would let a write through one be read through the
		// other.
		analyzed: u8,
		originalU8: u8.slice(),
		get runs(): CharRun[] {
			runs ??= asciiRuns(original, lineStarts);
			return runs;
		},
		lineStarts,
		ascii: true,
	};
}

/** The per-character runs of an all-ASCII input, built on first read. */
function asciiRuns(original: string, lineStarts: readonly number[]): CharRun[] {
	const runs: CharRun[] = new Array(original.length);
	let line = 0;
	for (let i = 0; i < original.length; i++) {
		const codePoint = original.charCodeAt(i);
		runs[i] = {
			codePoint,
			utf16Start: i,
			utf16Len: 1,
			byteStart: i,
			byteLen: 1,
			ascii: true,
			line,
			col: i - (lineStarts[line] as number),
		};
		if (codePoint === 0x0a) line++;
	}
	return runs;
}

/** 0-based line containing `byte` — the last line start at or before it. */
function lineAtByte(lineStarts: readonly number[], byte: number): number {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((lineStarts[mid] as number) <= byte) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * The {@link CharRun} whose byte range contains `byte`. Throws if `byte` is not
 * inside any run (i.e. `byte < 0` or `byte >= analyzed.length`).
 */
export function runAtByte(a: CoordinateAnalysis, byte: number): CharRun {
	const len = a.analyzed.length;
	if (!Number.isInteger(byte) || byte < 0 || byte >= len)
		throw new Error(
			`runAtByte: ${byte} is not a valid interior byte offset; expected an integer in [0, ${len})`,
		);
	// On the identity path the run IS the byte, so answer it rather than build
	// (and then binary-search) an array of one object per character.
	if (a.ascii) {
		const line = lineAtByte(a.lineStarts, byte);
		return {
			codePoint: a.original.charCodeAt(byte),
			utf16Start: byte,
			utf16Len: 1,
			byteStart: byte,
			byteLen: 1,
			ascii: true,
			line,
			col: byte - (a.lineStarts[line] as number),
		};
	}
	let lo = 0;
	let hi = a.runs.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const r = a.runs[mid] as CharRun;
		if (byte < r.byteStart) hi = mid - 1;
		else if (byte >= r.byteStart + r.byteLen) lo = mid + 1;
		else return r;
	}
	// Unreachable: a valid interior byte always lies inside exactly one run.
	throw new Error(`runAtByte: no run contains byte ${byte} in [0, ${len})`);
}

/**
 * Map an `analyzed` byte offset to an original (line, col) position. A byte
 * landing INSIDE a multi-byte char snaps to that char's boundary (V6).
 * `byte === analyzed.length` is the end-of-input cursor and maps to the
 * position just past the last character.
 */
export function byteToPosition(a: CoordinateAnalysis, byte: number): Position {
	const len = a.analyzed.length;
	if (!Number.isInteger(byte) || byte < 0 || byte > len)
		throw new Error(
			`byteToPosition: ${byte} is not a valid cursor offset; expected an integer in [0, ${len}]`,
		);
	if (byte === len) {
		// The identity path reads the same answer off `lineStarts`: a trailing
		// newline has already pushed the line that the cursor sits at column 0 of.
		if (a.ascii) {
			const line = a.lineStarts.length - 1;
			return { line, col: len - (a.lineStarts[line] as number) };
		}
		const last = a.runs.at(-1);
		if (!last) return { line: 0, col: 0 };
		if (last.codePoint === 0x0a) return { line: last.line + 1, col: 0 };
		return { line: last.line, col: last.col + last.utf16Len };
	}
	const run = runAtByte(a, byte);
	return { line: run.line, col: run.col };
}

/**
 * Map a half-open analyzed-byte span to an original (line, col) range — the
 * conversion an LSP consumer needs for every defect region and every token span.
 *
 * Deliberately built on {@link byteToPosition} in both directions rather than on
 * {@link positionToByte}: that one is an O(n) linear scan over `runs`, so using
 * it here would make converting a document's worth of spans quadratic.
 * `byteToPosition` binary-searches. Both endpoints snap to a character boundary
 * (V6), and `end === analyzed.length` is legal, so a span reaching end-of-input
 * converts without a special case.
 */
export function byteSpanToRange(
	a: CoordinateAnalysis,
	start: number,
	end: number,
): Range {
	if (end < start)
		throw new Error(
			`byteSpanToRange: end ${end} precedes start ${start}; spans are half-open and forward`,
		);
	return { start: byteToPosition(a, start), end: byteToPosition(a, end) };
}

/**
 * The defect regions that fall out of the coordinate pass itself: a leading BOM,
 * and every run of bytes the ASCII normalization stood in for.
 *
 * Both classes are {@link isPositionalFact}s, never errors — see that predicate
 * for why. They come from `runs` rather than from a second scan because
 * `analyzeCoordinates` has already decided, per code point, whether it is ASCII
 * (`CharRun.ascii`); re-deriving that would be a chance to disagree with it.
 *
 * Non-ASCII runs are COALESCED: a CJK comment or an emoji-bearing value is one
 * region, not one per code point. Contiguity is measured in bytes, so adjacent
 * non-ASCII characters merge even across a surrogate pair.
 *
 * Only a U+FEFF in LEADING position is a `bom`. The same code point later in the
 * document is a zero-width no-break space — ordinary content — and is reported
 * as part of its `non-ascii` run like any other character.
 */
export function coordinateDefects(a: CoordinateAnalysis): Defect[] {
	// Both classes are non-ASCII code points by definition (U+FEFF included), so
	// an all-ASCII input has neither and the runs never need building.
	if (a.ascii) return [];
	const defects: Defect[] = [];
	const first = a.runs[0];
	const hasBom = first !== undefined && first.codePoint === BOM;
	if (hasBom && first !== undefined)
		defects.push({
			code: "bom",
			start: first.byteStart,
			end: first.byteStart + first.byteLen,
		});

	let runStart = -1;
	let runEnd = -1;
	for (let i = hasBom ? 1 : 0; i < a.runs.length; i++) {
		const run = a.runs[i] as CharRun;
		if (run.ascii) {
			if (runStart >= 0) {
				defects.push({ code: "non-ascii", start: runStart, end: runEnd });
				runStart = -1;
			}
			continue;
		}
		if (runStart < 0) runStart = run.byteStart;
		runEnd = run.byteStart + run.byteLen;
	}
	if (runStart >= 0)
		defects.push({ code: "non-ascii", start: runStart, end: runEnd });

	return defects;
}

/**
 * Map an original (line, col) position to an `analyzed` byte offset. `col` may
 * equal the line's UTF-16 length (the position just past the last character /
 * at the newline). Throws if the position addresses no boundary.
 */
export function positionToByte(
	a: CoordinateAnalysis,
	line: number,
	col: number,
): number {
	if (!Number.isInteger(line) || !Number.isInteger(col) || line < 0 || col < 0)
		throw new Error(
			`positionToByte: (line ${line}, col ${col}) is not a valid position; expected non-negative integers`,
		);
	// On the identity path a position is arithmetic: the column IS the byte
	// offset from the line start. The bound is the line's own end (its next line
	// start, minus the newline) so a column past the end of THAT line still
	// throws, exactly as the scan below does.
	if (a.ascii) {
		if (line >= a.lineStarts.length)
			throw new Error(
				`positionToByte: no character boundary at (line ${line}, col ${col})`,
			);
		const start = a.lineStarts[line] as number;
		const next = a.lineStarts[line + 1];
		const end = next === undefined ? a.original.length : (next as number) - 1;
		if (start + col > end)
			throw new Error(
				`positionToByte: no character boundary at (line ${line}, col ${col})`,
			);
		return start + col;
	}
	// Single pass: return an exact (line, col) hit immediately; otherwise keep
	// the last run seen on the target line to resolve a just-past-the-end column.
	let lastOnLine: CharRun | undefined;
	for (const run of a.runs) {
		if (run.line !== line) continue;
		if (run.col === col) return run.byteStart;
		lastOnLine = run;
	}
	// col past the last char of the line → byte after that line's last char.
	if (lastOnLine && col === lastOnLine.col + lastOnLine.utf16Len)
		return lastOnLine.byteStart + lastOnLine.byteLen;
	// Empty line (only as the final position after a trailing newline) or col 0
	// of a line with no chars → that line's start byte.
	if (col === 0 && line < a.lineStarts.length)
		return a.lineStarts[line] as number;
	throw new Error(
		`positionToByte: no character boundary at (line ${line}, col ${col})`,
	);
}
