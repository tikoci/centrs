import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	analyzeCoordinates,
	byteToPosition,
} from "../../src/explain/coordinates.ts";
import { type Segment, segmentStatements } from "../../src/explain/segment.ts";
import * as centrs from "../../src/index.ts";

/**
 * Q1 statement-segmentation anchor tests (phase 0.5, #185/#186).
 *
 * Promoted from the throwaway lab probes `.scratch/explain-lab-segmenter.ts`
 * (the SUT) and `.scratch/explain-lab-q1-corners.ts` (the constructed corners,
 * several CHR-confirmed against `:parse` IL on 7.23.2). The production
 * segmenter is `src/explain/segment.ts`; it runs on the `analyzed` surface from
 * `src/explain/coordinates.ts`, so segment spans are analyzed-byte offsets that
 * line up with the coordinate contract shipped in #188.
 *
 * The frozen expectations live in `test/fixtures/explain/segments.json`:
 * `expect` (the ratified statement-text sequence) and `notes` are the human/
 * CHR-labeled contract; `golden` pins the exact spans, terminators, comments,
 * and menuOnly flags so a refactor cannot silently drift them.
 */

interface Corner {
	name: string;
	input: string;
	expect: string[];
	notes?: string[];
	verified?: string;
	golden: {
		segments: {
			start: number;
			end: number;
			terminator: Segment["terminator"];
			menuOnly: boolean;
		}[];
		comments: { start: number; end: number }[];
		notes: string[];
	};
}

const corners: Corner[] = JSON.parse(
	readFileSync(
		new URL("../fixtures/explain/segments.json", import.meta.url),
		"utf8",
	),
).corners;

describe("ratified statement boundaries (Q1 corners) — text sequence", () => {
	for (const c of corners) {
		test(c.name, () => {
			const got = segmentStatements(c.input).segments.map((s) => s.text);
			expect(got).toEqual(c.expect);
		});
	}
});

describe("structural notes match the ratified label", () => {
	for (const c of corners) {
		test(c.name, () => {
			const notes = segmentStatements(c.input).notes;
			expect([...notes].sort()).toEqual([...(c.notes ?? [])].sort());
		});
	}
});

describe("span invariant — each segment span slices back to its text", () => {
	for (const c of corners) {
		test(c.name, () => {
			// Every corner input is ASCII, so an analyzed-byte span indexes the
			// original identically; the span must reproduce the segment text.
			for (const s of segmentStatements(c.input).segments) {
				expect(c.input.slice(s.start, s.end)).toBe(s.text);
			}
		});
	}
});

describe("golden — frozen spans, terminators, comments, menuOnly", () => {
	for (const c of corners) {
		test(c.name, () => {
			const r = segmentStatements(c.input);
			expect(
				r.segments.map((s) => ({
					start: s.start,
					end: s.end,
					terminator: s.terminator,
					menuOnly: s.menuOnly,
				})),
			).toEqual(c.golden.segments);
			expect(r.comments).toEqual(c.golden.comments);
			expect(r.notes).toEqual(c.golden.notes);
		});
	}
});

describe("coordinate integration — spans resolve through the #188 mapper", () => {
	for (const c of corners) {
		test(c.name, () => {
			const a = analyzeCoordinates(c.input);
			for (const s of segmentStatements(c.input).segments) {
				// start/end are valid analyzed-byte offsets in the same input
				expect(() => byteToPosition(a, s.start)).not.toThrow();
				expect(() => byteToPosition(a, s.end)).not.toThrow();
				expect(s.start).toBeGreaterThanOrEqual(0);
				expect(s.end).toBeLessThanOrEqual(a.analyzed.length);
				expect(s.start).toBeLessThan(s.end);
			}
		});
	}
});

test("never throws on adversarial input; always self-reports", () => {
	const nasty = [
		"",
		";;;",
		'"',
		"{{{{",
		"}}}}",
		"[(",
		"# comment with no newline",
		"\\",
		"/ip address", // non-ASCII (NBSP) → SUB, must not corrupt the stack
		'/system note set note="路由器"; :put ok',
	];
	for (const input of nasty) {
		expect(() => segmentStatements(input)).not.toThrow();
	}
});

test("non-ASCII statement text is recovered as the original, not SUB", () => {
	const r = segmentStatements('/system note set note="路由器"; :put ok');
	expect(r.segments.map((s) => s.text)).toEqual([
		'/system note set note="路由器"',
		":put ok",
	]);
	// spans are analyzed-byte offsets, so the second segment starts past the
	// 3-bytes-each CJK run, not at its UTF-16 column
	const a = analyzeCoordinates('/system note set note="路由器"; :put ok');
	expect(r.segments[1]?.start).toBe(a.analyzed.length - ":put ok".length);
});

test("segmenter is re-exported from the library barrel", () => {
	expect(centrs.segmentStatements).toBe(segmentStatements);
});
