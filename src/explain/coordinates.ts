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

/** SUB (U+001A) — the byte-count-preserving stand-in for a non-ASCII byte. */
export const SUB = 0x1a;

/** U+FFFD REPLACEMENT CHARACTER — where a lone surrogate normalizes to. */
const REPLACEMENT = 0xfffd;

/** A 0-based (line, column) position in `original`; column is a UTF-16 count. */
export interface Position {
	line: number;
	col: number;
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
	runs: CharRun[];
	/** Byte offset of each line's first character (index === 0-based line). */
	lineStarts: number[];
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
 * Build the coordinate analysis of `original`: its UTF-8 encoding, the
 * byte-count-preserving `analyzed` surface, and one {@link CharRun} per code
 * point locating it in all three spaces.
 */
export function analyzeCoordinates(original: string): CoordinateAnalysis {
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
	};
}

/**
 * The {@link CharRun} whose byte range contains `byte`. Throws if `byte` is not
 * inside any run (i.e. `byte < 0` or `byte >= analyzed.length`).
 */
export function runAtByte(a: CoordinateAnalysis, byte: number): CharRun {
	let lo = 0;
	let hi = a.runs.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const r = a.runs[mid] as CharRun;
		if (byte < r.byteStart) hi = mid - 1;
		else if (byte >= r.byteStart + r.byteLen) lo = mid + 1;
		else return r;
	}
	throw new Error(`no run at byte ${byte}`);
}

/**
 * Map an `analyzed` byte offset to an original (line, col) position. A byte
 * landing INSIDE a multi-byte char snaps to that char's boundary (V6).
 * `byte === analyzed.length` is the end-of-input cursor and maps to the
 * position just past the last character.
 */
export function byteToPosition(a: CoordinateAnalysis, byte: number): Position {
	if (byte < 0 || byte > a.analyzed.length)
		throw new Error(`byte ${byte} out of [0,${a.analyzed.length}]`);
	if (byte === a.analyzed.length) {
		const last = a.runs.at(-1);
		if (!last) return { line: 0, col: 0 };
		if (last.codePoint === 0x0a) return { line: last.line + 1, col: 0 };
		return { line: last.line, col: last.col + last.utf16Len };
	}
	const run = runAtByte(a, byte);
	return { line: run.line, col: run.col };
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
	for (const run of a.runs) {
		if (run.line === line && run.col === col) return run.byteStart;
	}
	// col past the last char of the line → byte after that line's last char.
	const onLine = a.runs.filter((r) => r.line === line);
	if (onLine.length > 0) {
		const last = onLine.at(-1) as CharRun;
		if (col === last.col + last.utf16Len) return last.byteStart + last.byteLen;
	}
	// Empty line (only as the final position after a trailing newline) or col 0
	// of a line with no chars → that line's start byte.
	if (col === 0 && line < a.lineStarts.length)
		return a.lineStarts[line] as number;
	throw new Error(`no byte for (line ${line}, col ${col})`);
}
