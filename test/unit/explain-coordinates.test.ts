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
import * as centrs from "../../src/index.ts";

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

describe("input validation — invalid coordinates are rejected, not silently returned", () => {
	const a = analyzeCoordinates("/ip route add\nprint");
	const len = a.analyzed.length;

	test("byteToPosition rejects negative, fractional, NaN, and past-end offsets", () => {
		expect(() => byteToPosition(a, -1)).toThrow();
		expect(() => byteToPosition(a, 1.5)).toThrow();
		expect(() => byteToPosition(a, Number.NaN)).toThrow();
		expect(() => byteToPosition(a, len + 1)).toThrow();
		// end-of-input IS valid and must not throw
		expect(() => byteToPosition(a, len)).not.toThrow();
	});

	test("runAtByte rejects the exclusive end and non-integers, citing the valid range", () => {
		expect(() => runAtByte(a, len)).toThrow(`[0, ${len})`);
		expect(() => runAtByte(a, -1)).toThrow(`[0, ${len})`);
		expect(() => runAtByte(a, 2.5)).toThrow();
		expect(() => runAtByte(a, Number.NaN)).toThrow();
	});

	test("positionToByte rejects negative/fractional line or col instead of returning undefined", () => {
		// regression: positionToByte(a, -1, 0) used to return undefined
		expect(() => positionToByte(a, -1, 0)).toThrow();
		expect(() => positionToByte(a, 0, -1)).toThrow();
		expect(() => positionToByte(a, 0.5, 0)).toThrow();
		expect(() => positionToByte(a, 0, Number.NaN)).toThrow();
	});
});

test("coordinate API is re-exported from the library barrel", () => {
	expect(centrs.analyzeCoordinates).toBe(analyzeCoordinates);
	expect(centrs.byteToPosition).toBe(byteToPosition);
	expect(centrs.positionToByte).toBe(positionToByte);
	expect(centrs.runAtByte).toBe(runAtByte);
	expect(centrs.SUB).toBe(SUB);
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

/**
 * The all-ASCII identity path (#322).
 *
 * `analyzeCoordinates` answers an all-ASCII input by arithmetic — the three
 * coordinate spaces coincide there, which is exactly what the byte-count-
 * preserving rule was chosen to guarantee — and defers the per-character
 * {@link CharRun} array to its first reader. That is a claim about COST, never
 * about the answer, so it is tested as a DIFFERENTIAL rather than with its own
 * expectations: appending one non-ASCII character forces the same input down
 * the general per-code-point walk, and every shared offset must read the same.
 *
 * The one offset that legitimately differs is end-of-input: `s.length` is the
 * cursor past the last character of `s`, but it addresses the appended
 * character in the twin. Those two positions are the same position — which is
 * why the end-of-input rule is asserted against the twin's reading of it
 * rather than skipped.
 */
describe("identity path — ASCII answers what the general walk answers (#322)", () => {
	const cases: [string, string][] = [
		["empty", ""],
		["one line", "/ip address print"],
		["multi-line", "/ip address\nadd address=1.1.1.1/32\nprint\n"],
		["trailing newline", ":put 1\n"],
		["blank lines and tabs", ":local x 1;\n\n\t:put $x\r\n:put 2"],
		["a nested block", ':if ($a) do={ :local d 1; :put "x" } else={ :put 2 }'],
		["comment and continuation", "# c\n:local \\\n  x 1\n:put $x"],
	];

	for (const [name, text] of cases) {
		test(`${name}: every shared offset agrees with the non-ASCII twin`, () => {
			const ascii = analyzeCoordinates(text);
			// The twin is the same text with one non-ASCII character appended, so
			// the general walk runs over an identical prefix.
			const twin = analyzeCoordinates(`${text}é`);

			expect(ascii.ascii).toBe(true);
			expect(twin.ascii).toBe(false);
			expect(ascii.analyzed.length).toBe(text.length);
			expect(ascii.lineStarts).toEqual(twin.lineStarts);

			for (let byte = 0; byte < text.length; byte++) {
				expect(runAtByte(ascii, byte)).toEqual(runAtByte(twin, byte));
				expect(byteToPosition(ascii, byte)).toEqual(byteToPosition(twin, byte));
				expect(ascii.analyzed[byte]).toBe(twin.analyzed[byte] as number);
				expect(ascii.originalU8[byte]).toBe(twin.originalU8[byte] as number);
			}

			// The lazily built array is the one the eager walk would have built.
			expect(ascii.runs.length).toBe(text.length);
			expect(ascii.runs).toEqual(twin.runs.slice(0, text.length));

			// End of input: the cursor past the last character of `text` is the
			// position the twin gives its appended character.
			expect(byteToPosition(ascii, text.length)).toEqual(
				byteToPosition(twin, text.length),
			);

			// And every position round-trips back to the byte it came from.
			for (let byte = 0; byte <= text.length; byte++) {
				const pos = byteToPosition(ascii, byte);
				expect(positionToByte(ascii, pos.line, pos.col)).toBe(byte);
			}
		});
	}

	test("a position past the end of its line has no boundary", () => {
		const a = analyzeCoordinates("ab\ncd");
		expect(a.ascii).toBe(true);
		// col 2 is the cursor at the newline; col 3 addresses nothing.
		expect(positionToByte(a, 0, 2)).toBe(2);
		expect(() => positionToByte(a, 0, 3)).toThrow("no character boundary");
		expect(() => positionToByte(a, 2, 0)).toThrow("no character boundary");
	});

	test("an all-ASCII input raises no coordinate defect and normalizes nothing", () => {
		const data = centrs.explainCommand("/ip address print");
		expect(data.input.normalized).toBe(false);
		expect(data.input.positionMap).toEqual([
			{
				analyzed: { start: 0, end: 17 },
				originalUtf16: { start: 0, end: 17 },
			},
		]);
		expect(centrs.explainCommand("").input.positionMap).toEqual([]);
	});
});
