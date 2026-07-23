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

test("never throws on adversarial input; malformed inputs self-report notes", () => {
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
	// Expected structural notes, parallel to `nasty`. Malformed delimiter state
	// must surface a diagnostic; well-formed adversarial input reports none.
	const expected: string[][] = [
		[], // empty
		[], // only separators
		["unterminated-string"], // lone quote
		["unclosed:{{{{"], // unbalanced opens
		[
			"unbalanced-close:}",
			"unbalanced-close:}",
			"unbalanced-close:}",
			"unbalanced-close:}",
		], // stray closes
		["unclosed:[("], // mixed unbalanced opens
		[], // comment with no newline
		[], // lone backslash
		[], // /ip address (NBSP) → SUB, no structural note
		[], // balanced string + separator
	];
	nasty.forEach((input, i) => {
		let result: ReturnType<typeof segmentStatements> | undefined;
		expect(() => {
			result = segmentStatements(input);
		}).not.toThrow();
		expect(result?.notes).toEqual(expected[i] as string[]);
	});
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

test("deep H7 containers abstain before recursion can overflow", () => {
	const depth = 10_000;
	const input = `${"{".repeat(depth)}:put ok${"}".repeat(depth)}`;
	const r = segmentStatements(input);

	expect(r.notes).toEqual(["over-depth:256"]);
	expect(r.segments).toHaveLength(1);
	const segment = r.segments[0] as Segment;
	expect(segment.start).toBe(256);
	expect(segment.end).toBe(input.length - 256);
	expect(input.slice(segment.start, segment.end)).toBe(segment.text);
});

test("over-depth notes use analyzed-byte offsets with non-ASCII prefixes", () => {
	const prefix = "/路 ";
	const input = `${prefix}${"{".repeat(257)}x${"}".repeat(257)}`;
	const expectedOffset =
		new TextEncoder().encode(prefix).length + "{".repeat(256).length;

	expect(segmentStatements(input).notes).toEqual([
		`over-depth:${expectedOffset}`,
	]);
});

test("adversarial shape families stay deterministic with ordered, bounded spans", () => {
	const generators = [
		(n: number) => "a".repeat(n),
		(n: number) => "/ip route add;".repeat(Math.ceil(n / 14)),
		(n: number) => "/ip route add\n".repeat(Math.ceil(n / 14)),
		(n: number) => ";".repeat(n),
		(n: number) => "{}".repeat(Math.ceil(n / 2)),
		(n: number) => "# c\n".repeat(Math.ceil(n / 4)),
		(n: number) => '{[($";=\\'.repeat(Math.ceil(n / 8)),
	];

	for (const n of [0, 1, 31, 1_000, 4_000]) {
		for (const generate of generators) {
			const input = generate(n);
			const first = segmentStatements(input);
			expect(segmentStatements(input)).toEqual(first);

			for (const spans of [first.segments, first.comments]) {
				let previousStart = -1;
				for (const span of spans) {
					expect(Number.isInteger(span.start)).toBeTrue();
					expect(Number.isInteger(span.end)).toBeTrue();
					expect(span.start).toBeGreaterThanOrEqual(previousStart);
					expect(span.start).toBeGreaterThanOrEqual(0);
					expect(span.end).toBeGreaterThanOrEqual(span.start);
					expect(span.end).toBeLessThanOrEqual(input.length);
					previousStart = span.start;
				}
			}
		}
	}
});

test("segmenter is re-exported from the library barrel", () => {
	expect(centrs.segmentStatements).toBe(segmentStatements);
});
