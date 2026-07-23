import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	analyzeCoordinates,
	byteToPosition,
	type CoordinateAnalysis,
	positionToByte,
	runAtByte,
	SUB,
} from "../../src/explain/coordinates.ts";

/**
 * Q15 coordinate-contract anchor + property tests (phase 0.5, #185/#186).
 *
 * Promoted from the throwaway lab probe `.scratch/explain-lab-q15-coords.ts`:
 * the frozen fixture inputs and golden expectations live in
 * `test/fixtures/explain/coordinates.json`, and the production coordinate
 * mapper under test is `src/explain/coordinates.ts`. The six invariants
 * (V1–V6) are the ratified contract from `commands/explain/README.md`; every
 * one must hold at 100% across every fixture, no exceptions.
 */

interface Fixture {
	name: string;
	tag: string;
	text: string;
	expect: {
		u8Length: number;
		runCount: number;
		lineCount: number;
		firstNonAscii: {
			codePoint: number;
			utf16Start: number;
			utf16Len: number;
			byteStart: number;
			byteLen: number;
			line: number;
			col: number;
		} | null;
	};
}

const fixtures: Fixture[] = JSON.parse(
	readFileSync(
		new URL("../fixtures/explain/coordinates.json", import.meta.url),
		"utf8",
	),
).fixtures;

test("fixture set covers every required coordinate category", () => {
	const tags = new Set(fixtures.map((f) => f.tag));
	for (const required of [
		"ASCII",
		"BMP non-ASCII",
		"astral/surrogate",
		"combining marks",
		"tabs",
		"LF/CRLF",
		"normalization replacement",
		"cursor positions",
		"exclusive end",
	]) {
		expect(tags).toContain(required);
	}
});

describe("V1 LENGTH — analyzed.length === originalU8.length", () => {
	for (const f of fixtures) {
		test(f.name, () => {
			const a = analyzeCoordinates(f.text);
			expect(a.analyzed.length).toBe(a.originalU8.length);
		});
	}
});

describe("V2 IN-BOUNDS — runs cover [0,len) contiguously, no gaps/overlap", () => {
	for (const f of fixtures) {
		test(f.name, () => {
			const a = analyzeCoordinates(f.text);
			let expectByte = 0;
			let expectUtf16 = 0;
			for (const r of a.runs) {
				expect(r.byteStart).toBe(expectByte);
				expect(r.utf16Start).toBe(expectUtf16);
				expect(r.byteStart + r.byteLen).toBeLessThanOrEqual(a.analyzed.length);
				expectByte = r.byteStart + r.byteLen;
				expectUtf16 = r.utf16Start + r.utf16Len;
			}
			if (a.runs.length > 0) expect(expectByte).toBe(a.analyzed.length);
			expect(expectUtf16).toBe(f.text.length);
		});
	}
});

describe("V3 ROUNDTRIP — byte → (line,col) → byte at every boundary + end-of-input", () => {
	for (const f of fixtures) {
		test(f.name, () => {
			const a = analyzeCoordinates(f.text);
			for (const r of a.runs) {
				const pos = byteToPosition(a, r.byteStart);
				expect(positionToByte(a, pos.line, pos.col)).toBe(r.byteStart);
			}
			const len = a.analyzed.length;
			const endPos = byteToPosition(a, len);
			expect(positionToByte(a, endPos.line, endPos.col)).toBe(len);
		});
	}
});

describe("V4 SLICE — UTF-16 range yields the char; ASCII bytes intact, non-ASCII → SUB", () => {
	for (const f of fixtures) {
		test(f.name, () => {
			const a = analyzeCoordinates(f.text);
			for (const r of a.runs) {
				const slice = f.text.slice(r.utf16Start, r.utf16Start + r.utf16Len);
				const cp = slice.codePointAt(0) ?? 0;
				const isSurrogate = cp >= 0xd800 && cp <= 0xdfff;
				expect(isSurrogate ? 0xfffd : cp).toBe(r.codePoint);
				for (let k = 0; k < r.byteLen; k++) {
					const analyzedByte = a.analyzed[r.byteStart + k] as number;
					if (r.ascii)
						expect(analyzedByte).toBe(a.originalU8[r.byteStart + k] as number);
					else expect(analyzedByte).toBe(SUB);
				}
			}
		});
	}
});

describe("V5 EXCLUSIVE-END — whole-input span is half-open, end===len is legal", () => {
	for (const f of fixtures) {
		test(f.name, () => {
			const a = analyzeCoordinates(f.text);
			const span = { start: 0, end: a.analyzed.length };
			expect(a.analyzed.slice(span.start, span.end).length).toBe(
				span.end - span.start,
			);
			expect(() => byteToPosition(a, a.analyzed.length)).not.toThrow();
		});
	}
});

describe("V6 CURSOR-SNAP — every byte in [0,len] resolves; interior snaps to boundary", () => {
	for (const f of fixtures) {
		test(f.name, () => {
			const a = analyzeCoordinates(f.text);
			for (let b = 0; b <= a.analyzed.length; b++) {
				const pos = byteToPosition(a, b);
				if (b < a.analyzed.length) {
					const run = runAtByte(a, b);
					expect(positionToByte(a, pos.line, pos.col)).toBe(run.byteStart);
				}
			}
		});
	}
});

describe("golden — frozen expected outcomes per fixture", () => {
	for (const f of fixtures) {
		test(f.name, () => {
			const a = analyzeCoordinates(f.text);
			expect(a.originalU8.length).toBe(f.expect.u8Length);
			expect(a.runs.length).toBe(f.expect.runCount);
			expect(a.lineStarts.length).toBe(f.expect.lineCount);
			const spot = a.runs.find((r) => !r.ascii) ?? null;
			if (f.expect.firstNonAscii === null) {
				expect(spot).toBeNull();
			} else {
				expect(spot).not.toBeNull();
				const s = spot as NonNullable<typeof spot>;
				expect({
					codePoint: s.codePoint,
					utf16Start: s.utf16Start,
					utf16Len: s.utf16Len,
					byteStart: s.byteStart,
					byteLen: s.byteLen,
					line: s.line,
					col: s.col,
				}).toEqual(f.expect.firstNonAscii);
			}
		});
	}
});

describe("worked examples — concrete coordinates from the spec", () => {
	test("astral emoji advances UTF-16 col by 2 and occupies 4 analyzed bytes", () => {
		const a: CoordinateAnalysis = analyzeCoordinates(
			'/system identity set name="router-🚀"',
		);
		const rocket = a.runs.find((r) => r.codePoint === 0x1f680);
		expect(rocket).toBeDefined();
		const r = rocket as NonNullable<typeof rocket>;
		expect(r.utf16Len).toBe(2);
		expect(r.byteLen).toBe(4);
		// its four analyzed bytes are all SUB
		for (let k = 0; k < 4; k++) expect(a.analyzed[r.byteStart + k]).toBe(SUB);
		expect(a.analyzed.length).toBe(a.originalU8.length);
	});

	test("a cursor byte inside the astral char snaps to its start", () => {
		const a = analyzeCoordinates("🚀add");
		// bytes 0..3 are the 4-byte 🚀; any of them must resolve to col 0
		for (let b = 0; b < 4; b++) {
			const pos = byteToPosition(a, b);
			expect(pos).toEqual({ line: 0, col: 0 });
		}
		// byte 4 is 'a' at UTF-16 col 2 (astral advanced col by 2)
		expect(byteToPosition(a, 4)).toEqual({ line: 0, col: 2 });
	});

	test("lone surrogate normalizes to U+FFFD (3 bytes)", () => {
		const a = analyzeCoordinates('x="\uD800"y');
		const repl = a.runs.find((r) => r.codePoint === 0xfffd);
		expect(repl).toBeDefined();
		expect((repl as NonNullable<typeof repl>).byteLen).toBe(3);
	});
});
