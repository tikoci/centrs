import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	analyzeCoordinates,
	byteToPosition,
} from "../../src/explain/coordinates.ts";
import {
	maskComments,
	type Segment,
	scanQuotedString,
	segmentStatements,
} from "../../src/explain/segment.ts";
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

test("a structural defect prevents container children from being promoted", () => {
	const cases = ["/ip { add x=1; ) ; add y=2 }", "/ip ) { add x=1 }"];

	for (const input of cases) {
		const result = segmentStatements(input);
		expect(result.segments.map((segment) => segment.text)).toEqual([input]);
		expect(result.notes).toContain("unbalanced-close:)");
	}
});

test("repeated H7 prefix checks stay within a linear-scale budget", () => {
	const input = `/ip ${"{}".repeat(250_000)}`;
	const started = performance.now();
	const result = segmentStatements(input);
	const elapsedMs = performance.now() - started;

	expect(result.segments.map((segment) => segment.text)).toEqual([input]);
	// The incremental scan is normally well below 200 ms. This generous budget
	// catches the former repeated whole-prefix scan (about 5 seconds locally)
	// without turning ordinary CI scheduling noise into a failure.
	expect(elapsedMs).toBeLessThan(1_500);
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
	expect(centrs.maskComments).toBe(maskComments);
	expect(centrs.scanQuotedString).toBe(scanQuotedString);
});

/**
 * `scanQuotedString` — the one shared string skip (#199). Before it, every
 * structural scan stopped at the next `"`, so a `$[…]` substitution carrying a
 * nested string flipped the quote phase and every later `#` line read as string
 * content. Measured on the frozen 913-script corpus against the CHR 7.23.2
 * per-byte highlight streams: 7 files / 2,184 device-`comment` bytes left
 * unmasked before, 0 after.
 */
describe("scanQuotedString — substitution frames inside a string", () => {
	const at = (text: string): ReturnType<typeof scanQuotedString> =>
		scanQuotedString(text, text.indexOf('"'));

	test("a plain string ends at its closing quote", () => {
		const t = ':put "abc" ;';
		expect(at(t)).toEqual({ end: t.indexOf('"') + 5, closed: true });
	});

	test("an escaped quote does not close the string", () => {
		const t = ':put "a\\"b"';
		expect(at(t).closed).toBeTrue();
		expect(t.slice(t.indexOf('"'), at(t).end)).toBe('"a\\"b"');
	});

	test("a nested string inside `$[…]` does not close the outer string", () => {
		// CHR 7.23.2 highlight: `"$[` and the inner quotes are `syntax-meta`,
		// `:pick` is `dir`+`cmd`, and `)]"` closes the ONE outer string.
		const t = ':local h "$[:pick "0123456789ABCDEF" $x ($x+1)]" ;';
		expect(t.slice(t.indexOf('"'), at(t).end)).toBe(
			'"$[:pick "0123456789ABCDEF" $x ($x+1)]"',
		);
	});

	test("`$(…)` opens a substitution frame the same way", () => {
		const t = ':put "$(:pick "ab" 0 1)" ;';
		expect(t.slice(t.indexOf('"'), at(t).end)).toBe('"$(:pick "ab" 0 1)"');
	});

	test("`$` before anything else is ordinary string content", () => {
		const t = ':put "cost $x" ;';
		expect(t.slice(t.indexOf('"'), at(t).end)).toBe('"cost $x"');
	});

	test("nesting is iterative — deep input cannot overflow the stack", () => {
		const t = `"${'$[":x '.repeat(20_000)}`;
		expect(() => scanQuotedString(t, 0)).not.toThrow();
		expect(scanQuotedString(t, 0)).toEqual({ end: t.length, closed: false });
	});

	test("frame depth is capped, and the cap fails closed", () => {
		// MAX_STRING_FRAME_DEPTH is 256 frames (the string plus 255 substitutions);
		// the corpus peaks at 8. Past the cap the scan stops and reports the string
		// UNCLOSED even though the brackets balance, so the caller degrades the
		// statement instead of trusting a scan it did not finish.
		const nested = (n: number): string => `"${"$[".repeat(n)}${"]".repeat(n)}"`;
		expect(scanQuotedString(nested(255), 0).closed).toBeTrue();
		expect(scanQuotedString(nested(256), 0)).toEqual({
			end: nested(256).length,
			closed: false,
		});
		// The cap bounds work, not just memory: an unclosed run exits early.
		const hostile = `"${"$[".repeat(500_000)}`;
		const started = performance.now();
		expect(scanQuotedString(hostile, 0).closed).toBeFalse();
		expect(performance.now() - started).toBeLessThan(250);
	});

	test("an unterminated string reports the end of input", () => {
		expect(scanQuotedString('"abc', 0)).toEqual({ end: 4, closed: false });
	});

	test("maskComments keeps a comment after a substitution string", () => {
		// The #199 repro. The device classes the whole `# :put $a` line `comment`.
		const t = ':local a "$[[:parse "(\\"x\\")"]]"\n# :put $a\n:put $a';
		const masked = maskComments(t);
		expect(masked).toHaveLength(t.length);
		expect(masked.slice(33, 42)).toBe(" ".repeat(9));
		expect(masked.slice(0, 32)).toBe(t.slice(0, 32));
		expect(maskComments(masked)).toBe(masked);
	});

	// #215 — every expectation below is a `/console/inspect request=highlight`
	// reading from CHR 7.23.3 (`.scratch/explain-215-verify-probe{,2}.ts`). The
	// device's comment class covers the line's newline as well; a `comments` span
	// here stops before it, which is this module's own long-standing convention
	// (an ordinary `# x\n` comment is recorded the same way).
	test("a `#` at the immediate start of a continued line is a comment", () => {
		// device: `\<nl>` escaped, `# x\n` comment, `:put b` obj-inactive — i.e.
		// still ARGUMENT bytes of the continued `:put a`, not a new command.
		const input = ":put a\\\n# x\n:put b";
		expect(maskComments(input).slice(8, 11)).toBe(" ".repeat(3));
		expect(segmentStatements(input)).toEqual({
			segments: [
				{
					start: 0,
					end: 18,
					text: ":put a\\\n# x\n:put b",
					terminator: "eof",
					menuOnly: false,
				},
			],
			comments: [{ start: 8, end: 11 }],
			notes: [],
		});
		// CRLF is the same shape one byte later.
		expect(maskComments(":put a\\\r\n# x\r\n:put b").slice(9, 12)).toBe(
			" ".repeat(3),
		);
		// Consecutive immediate comment lines all qualify.
		expect(
			segmentStatements(":local \\\n# one\n# two\nfoo 1").comments,
		).toEqual([
			{ start: 9, end: 14 },
			{ start: 15, end: 20 },
		]);
		// Blank and whitespace-only lines are part of the `\` run, so a `#` after
		// them is still immediate (device: `\<nl><nl>` is one `escaped` run).
		expect(segmentStatements(":put a\\\n\n# x\n:put b").comments).toEqual([
			{ start: 9, end: 12 },
		]);
		expect(segmentStatements(":put a\\\n   \n# x\n:put b").comments).toEqual([
			{ start: 12, end: 15 },
		]);
	});

	test("indentation before that `#` is decided by statement-lead, not the continuation", () => {
		// device: `:put a\<nl>  #` classes the `#` an `error` — mid-statement, so
		// not a comment. The segmenter has no error class; it keeps the bytes.
		const indented = ":put a\\\n  # x\n:put b";
		expect(maskComments(indented)).toBe(indented);
		expect(segmentStatements(indented).comments).toEqual([]);
		expect(maskComments(":put a\\\n\t# x\n:put b")).toBe(
			":put a\\\n\t# x\n:put b",
		);
		// but with the statement still EMPTY the same indented `#` IS a comment
		// (device: `do={\<nl>  ` escaped, then `# c\n` comment) — H4 as it stands.
		const atLead = ":if (true) do={\\\n  # c\n:put 1\n}";
		expect(maskComments(atLead).slice(19, 22)).toBe(" ".repeat(3));
		expect(segmentStatements(atLead).comments).toEqual([
			{ start: 19, end: 22 },
		]);
	});

	test("a continuation comment line does not end the statement, but spends the run", () => {
		// device: `foo` is `variable-local` — the `:local` head crossed the comment
		// line — and the statement then ends at the newline after `foo 1`.
		const input = ":local \\\n# $ghost\nfoo 1\n:put $foo";
		expect(maskComments(input).slice(9, 17)).toBe(" ".repeat(8));
		expect(segmentStatements(input).segments.map((s) => s.text)).toEqual([
			":local \\\n# $ghost\nfoo 1",
			":put $foo",
		]);
		// A blank line AFTER a continuation comment terminates, where the same
		// blank line directly after the `\` would not (device: `foo` there is
		// `obj-inactive` and the later `$foo` an unresolved `variable-parameter`).
		expect(
			segmentStatements(":local \\\n# one\n# two\n   \nfoo 1").segments.map(
				(s) => s.text,
			),
		).toEqual([":local \\\n# one\n# two", "foo 1"]);
		expect(
			segmentStatements(":put a\\\n# x\n\n:put b").segments.map((s) => s.text),
		).toEqual([":put a\\\n# x", ":put b"]);
		// …while ordinary content on the next line simply continues it.
		expect(
			segmentStatements(":put a\\\n# x\nb\n:put c").segments.map((s) => s.text),
		).toEqual([":put a\\\n# x\nb", ":put c"]);
	});

	test("masking a continuation comment stays idempotent", () => {
		// Masking removes the `#`s, so the second pass reads the blanked lines as
		// part of the `\` run instead of as a comment run. That must not change the
		// output — the invariant the #199 fuzz asserts on every case.
		for (const t of [
			":put a\\\n# x\n:put b",
			":local \\\n# one\n# two\nfoo 1",
			":local \\\n# one\n   # two\n",
			":put a\\\n# x\n\n# y\n:put b",
			":if (true) do={\\\n  # c\n:put 1\n}",
		]) {
			const masked = maskComments(t);
			expect(masked).toHaveLength(t.length);
			expect(maskComments(masked)).toBe(masked);
		}
	});
});
