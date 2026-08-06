import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	analyzeCoordinates,
	byteSpanToRange,
	coordinateDefects,
} from "../../src/explain/coordinates.ts";
import {
	type Defect,
	defectAt,
	isPositionalFact,
	mergeDefects,
	rebaseDefects,
} from "../../src/explain/defects.ts";
import {
	resolveDocument,
	resolveStatements,
} from "../../src/explain/pathresolve.ts";
import { segmentStatements } from "../../src/explain/segment.ts";
import { resolveSymbols } from "../../src/explain/symbols.ts";
import { containsWrite } from "../../src/explain/write.ts";
import * as centrs from "../../src/index.ts";

/**
 * Q14 defect-REGION anchor tests.
 *
 * Promoted from the throwaway lab probe `.scratch/explain-lab-q14-recovery.ts`,
 * whose C2 contract was scored in two tiers because the gap between them was
 * the finding:
 *
 *   C2a signalled — a note exists at all
 *   C2b LOCALIZED — a note carries a REGION overlapping the injected defect
 *
 * C2b is what `src/explain/defects.ts` provides, so the mutation suite below is
 * re-run against the PRODUCT modules rather than the lab SUT.
 *
 * The suite asserts in three directions, because "does it fire" is only a third
 * of the contract:
 *
 *   1. classes that must localize AT the injected offset;
 *   2. the unclosed-delimiter classes, whose region is at the OPENER by design
 *      — the mutation operator deletes a CLOSER, but where a delimiter was
 *      supposed to close is exactly what is unknown, so the opener is the only
 *      honest location and "overlaps the injected offset" is the wrong question
 *      for them;
 *   3. the classes `defects.ts` DECLARES it does not detect. Pinning a deferral
 *      is the point: adding `stray-delimiter` detection makes these fire, and
 *      the declaration in that header has to be updated with them.
 */

interface Corner {
	name: string;
	input: string;
	defects: Defect[];
	why: string;
}

const fixture = JSON.parse(
	readFileSync(
		new URL("../fixtures/explain/defects.json", import.meta.url),
		"utf8",
	),
) as { corners: Corner[] };

/** Every located defect the shipped analyzers find, in source order. */
function allDefects(text: string): Defect[] {
	return mergeDefects(
		segmentStatements(text).defects,
		resolveStatements(text).defects,
		resolveDocument(text).defects,
		resolveSymbols(text).defects,
	).sort((a, b) => a.start - b.start || a.end - b.end);
}

describe("Defect helpers", () => {
	test("mergeDefects de-dupes on the WHOLE region, never the code alone", () => {
		// This is the difference from the note channel, which builds a Set over
		// stringified notes and so collapses two events into one.
		const a = defectAt("over-depth", 40);
		const b = defectAt("over-depth", 900);
		expect(mergeDefects([a], [b])).toEqual([a, b]);
		expect(mergeDefects([a], [a])).toEqual([a]);
	});

	test("mergeDefects keeps first-occurrence order", () => {
		const first = defectAt("unbalanced-close", 9, ")");
		const second = defectAt("bad-escape", 2);
		expect(mergeDefects([first], [second], [first])).toEqual([first, second]);
	});

	test("mergeDefects treats a differing detail as a distinct defect", () => {
		expect(
			mergeDefects(
				[defectAt("unclosed", 3, "[")],
				[defectAt("unclosed", 3, "{")],
			),
		).toHaveLength(2);
	});

	test("defectAt spans exactly one byte and never produces an empty region", () => {
		expect(defectAt("bad-sigil", 7)).toEqual({
			code: "bad-sigil",
			start: 7,
			end: 8,
		});
	});

	test("rebaseDefects shifts without mutating its input", () => {
		const original = [defectAt("unclosed", 2, "{")];
		const moved = rebaseDefects(original, 100);
		expect(moved).toEqual([
			{ code: "unclosed", start: 102, end: 103, detail: "{" },
		]);
		expect(original[0]?.start).toBe(2);
	});

	test("rebaseDefects by 0 returns a fresh array", () => {
		// Elements are shared — a Defect is never mutated anywhere — but the array
		// is new, so a caller may push into the result without touching the input.
		const original = [defectAt("bom", 0)];
		expect(rebaseDefects(original, 0)).not.toBe(original);
		expect(rebaseDefects(original, 0)).toEqual(original);
	});

	test("only bom and non-ascii are positional facts", () => {
		expect(isPositionalFact("bom")).toBe(true);
		expect(isPositionalFact("non-ascii")).toBe(true);
		for (const code of [
			"over-depth",
			"bad-escape",
			"bad-sigil",
			"unterminated-string",
			"unclosed",
			"unbalanced-close",
		] as const)
			expect(isPositionalFact(code)).toBe(false);
	});
});

describe("Defect corners (fixture-pinned)", () => {
	for (const corner of fixture.corners)
		test(corner.name, () => {
			expect(allDefects(corner.input)).toEqual(corner.defects);
		});

	test("every fixture region is half-open, non-empty, and in bounds", () => {
		for (const corner of fixture.corners) {
			const bytes = analyzeCoordinates(corner.input).analyzed.length;
			for (const d of allDefects(corner.input)) {
				expect(d.start).toBeGreaterThanOrEqual(0);
				expect(d.end).toBeGreaterThan(d.start);
				expect(d.end).toBeLessThanOrEqual(bytes);
			}
		}
	});
});

// --- the phase-0 mutation suite, re-run against the product ----------------

const PARENTS: { name: string; text: string }[] = [
	{
		name: "single-add",
		text: "/ip route add dst-address=10.9.0.0/16 gateway=10.9.0.1",
	},
	{
		name: "two-statements",
		text: "/ip address\nadd address=1.2.3.4/24 interface=ether1\nprint",
	},
	{
		name: "bracket-find",
		text: "/ip firewall filter remove [find chain=input]",
	},
	{
		name: "block-foreach",
		text: ":foreach i in=[/ip address find] do={ /ip address disable $i }",
	},
	{ name: "quoted-value", text: '/system identity set name="core-router-01"' },
	{
		name: "script-add",
		text: '/system script add name=boot source={ :log info "up" }',
	},
	{
		name: "set-with-comment",
		text: "/ip service set www disabled=yes # harden",
	},
	{
		name: "three-flags",
		text: "/interface bridge add name=br0 protocol-mode=rstp fast-forward=yes",
	},
];

interface Mutant {
	parent: string;
	op: string;
	text: string;
	/** offset of the injected defect in the MUTANT text. */
	at: number;
}

/** Inject exactly one controlled defect, recording where. */
function mutate(name: string, text: string): Mutant[] {
	const out: Mutant[] = [];
	const push = (op: string, mutated: string, at: number) =>
		out.push({ parent: name, op, text: mutated, at });

	const q = text.indexOf('"');
	if (q >= 0) {
		const close = text.indexOf('"', q + 1);
		if (close >= 0)
			push(
				"unclosed-quote",
				text.slice(0, close) + text.slice(close + 1),
				close,
			);
	} else push("unclosed-quote", `${text} name="oops`, text.length + 6);

	const rb = text.lastIndexOf("}");
	if (rb >= 0)
		push("unclosed-brace", text.slice(0, rb) + text.slice(rb + 1), rb);
	const rk = text.lastIndexOf("]");
	if (rk >= 0)
		push("unclosed-bracket", text.slice(0, rk) + text.slice(rk + 1), rk);

	{
		const sp = text.indexOf(" ");
		const at = sp >= 0 ? sp : text.length;
		push("stray-close", `${text.slice(0, at)})${text.slice(at)}`, at);
	}
	{
		const eq = text.indexOf("=");
		if (eq >= 0 && eq + 2 < text.length) {
			const at = eq + 2;
			push("stray-delimiter", `${text.slice(0, at)};${text.slice(at)}`, at);
		}
	}
	{
		const sp = text.indexOf(" ");
		const at = sp >= 0 ? sp + 1 : text.length;
		push("bad-escape", `${text.slice(0, at)}\\q${text.slice(at)}`, at);
	}
	push(
		"truncated-verb",
		text.slice(0, Math.min(6, text.length)),
		Math.min(6, text.length) - 1,
	);
	{
		const eq = text.indexOf("=");
		if (eq >= 0) push("truncated-arg", text.slice(0, eq), eq - 1);
	}
	{
		const eq = text.indexOf("=");
		if (eq >= 0) push("truncated-value", `${text.slice(0, eq)}=`, eq);
	}
	push("bom-prefix", `﻿${text}`, 0);
	{
		const sp = text.indexOf(" ");
		const at = sp >= 0 ? sp : text.length;
		push("non-ascii-stray", `${text.slice(0, at)}§${text.slice(at)}`, at);
	}
	return out;
}

const MUTANTS = PARENTS.flatMap((p) => mutate(p.name, p.text));

/**
 * Does any region cover `at`? Regions are half-open, so the end-of-input cursor
 * (`at === text.length`) is covered by a region that reaches the end — that is
 * where a deleted trailing quote leaves the defect.
 */
function covers(defects: Defect[], at: number, text: string): boolean {
	return defects.some(
		(d) =>
			(d.start <= at && at < d.end) || (at === text.length && d.end === at),
	);
}

const LOCALIZING = new Set([
	"stray-close",
	"bad-escape",
	"bom-prefix",
	"non-ascii-stray",
	"unclosed-quote",
]);
/** Regions land on the OPENER, not on the deleted closer — see the header. */
const OPENER_ANCHORED = new Set(["unclosed-brace", "unclosed-bracket"]);
/** Declared NOT detected; see `defects.ts`'s "classes deliberately not detected". */
const DECLARED_UNDETECTED = new Set([
	"stray-delimiter",
	"truncated-verb",
	"truncated-arg",
	"truncated-value",
]);

describe("Q14 mutation suite — C1 no throw, C2b localized", () => {
	test("the suite actually covers every operator class", () => {
		const ops = new Set(MUTANTS.map((m) => m.op));
		expect(ops).toEqual(
			new Set([...LOCALIZING, ...OPENER_ANCHORED, ...DECLARED_UNDETECTED]),
		);
		// 76, not 8x11: only the parents that actually contain a `}` / `]` can
		// have one deleted.
		expect(MUTANTS.length).toBe(76);
	});

	test("C1 — no mutant throws, in any analyzer", () => {
		for (const m of MUTANTS) expect(() => allDefects(m.text)).not.toThrow();
	});

	test("C2b — detectable classes carry a region covering the defect", () => {
		const misses: string[] = [];
		for (const m of MUTANTS) {
			if (!LOCALIZING.has(m.op)) continue;
			if (!covers(allDefects(m.text), m.at, m.text))
				misses.push(`${m.op}/${m.parent} @${m.at} ${JSON.stringify(m.text)}`);
		}
		expect(misses).toEqual([]);
	});

	test("an unclosed delimiter is reported at its opener", () => {
		for (const m of MUTANTS) {
			if (!OPENER_ANCHORED.has(m.op)) continue;
			const open = m.op === "unclosed-brace" ? "{" : "[";
			const unclosed = allDefects(m.text).filter((d) => d.code === "unclosed");
			expect(unclosed.length).toBeGreaterThan(0);
			for (const d of unclosed) {
				expect(d.detail).toBe(open);
				expect(m.text[d.start]).toBe(open);
			}
		}
	});

	test("declared-undetected classes stay undetected (pins the deferral)", () => {
		for (const m of MUTANTS) {
			if (!DECLARED_UNDETECTED.has(m.op)) continue;
			// Some of these mutants incidentally strand a real delimiter (truncating
			// `script-add` at its first `=` drops the `}` too). That is a genuine
			// defect and is allowed; what must not appear is a region claiming to
			// describe the injected truncation or stray `;` itself.
			expect(covers(allDefects(m.text), m.at, m.text)).toBe(false);
		}
	});
});

// --- the two note-channel losses this issue exists to fix -------------------

describe("Regions recover what the note channel loses", () => {
	/** `n` nested `do={…}` blocks — past MAX_DEPTH the walkers must abstain. */
	const deepChain = (n: number) => {
		const open = ":foreach i in=x do={ ".repeat(n);
		const close = " }".repeat(n);
		return `${open}:put 1${close}`;
	};

	test("two over-depth events survive as two defects, not one note", () => {
		const text = `${deepChain(260)}\n${deepChain(260)}`;
		const analysis = resolveStatements(text);

		// The note channel is a Set over strings: both events collapse to one
		// entry and BOTH offsets are gone.
		expect(analysis.notes).toEqual(["over-depth"]);

		// The region channel keeps them addressable and distinct.
		const overDepth = analysis.defects.filter((d) => d.code === "over-depth");
		expect(overDepth).toHaveLength(2);
		expect(overDepth[0]?.start).toBeLessThan(overDepth[1]?.start as number);
	});

	test("pathresolve's over-depth carries a region at all", () => {
		// It used to emit a bare `over-depth` with no offset, while segment.ts and
		// symbols.ts emitted `over-depth:<byte>` — the same class, two shapes.
		const analysis = resolveStatements(deepChain(260));
		expect(analysis.notes).toEqual(["over-depth"]);
		const [defect] = analysis.defects.filter((d) => d.code === "over-depth");
		expect(defect).toBeDefined();
		expect(defect?.end).toBeGreaterThan(defect?.start as number);
	});

	test("over-depth widens to the statement when offsets cannot be mapped", () => {
		// The `Loc.base = -1` path. A statement's `text` is the ORIGINAL substring,
		// so an index into it is an analyzed-byte offset only while the statement
		// is pure ASCII. The ASCII twin gets a narrow region; the non-ASCII one
		// widens to its statement rather than pointing at a wrong byte.
		const brackets = `${"[find ".repeat(260)}x${"]".repeat(260)}`;
		const ascii = `/ip route remove numbers=${brackets}`;
		const nonAscii = `/ip route remove comment="ä" numbers=${brackets}`;

		const [narrow] = resolveDocument(ascii).defects.filter(
			(d) => d.code === "over-depth",
		);
		expect(narrow?.start).toBeGreaterThan(0);
		expect(narrow?.end).toBeLessThan(ascii.length);

		const [widened] = resolveDocument(nonAscii).defects.filter(
			(d) => d.code === "over-depth",
		);
		const span = resolveStatements(nonAscii).statements[0]?.span;
		expect(span).toBeDefined();
		expect(widened).toEqual({
			code: "over-depth",
			start: span?.start as number,
			end: span?.end as number,
		});
	});

	test("a bounded-out empty body never yields a zero-width region", () => {
		// `Defect` contracts `end > start`. An empty bracket body at the depth
		// limit would otherwise produce `start === end`.
		const text = `/ip route remove ${"[".repeat(300)}${"]".repeat(300)}`;
		for (const d of resolveDocument(text).defects)
			expect(d.end).toBeGreaterThan(d.start);
	});

	test("a bracket walk that bottoms out is located too", () => {
		const text = `/ip route remove ${"[find ".repeat(260)}x${"]".repeat(260)}`;
		const analysis = resolveDocument(text);
		const [defect] = analysis.defects.filter((d) => d.code === "over-depth");
		expect(defect).toBeDefined();
		expect(defect?.start).toBeGreaterThan(0);
	});
});

describe("Statement and bracket spans", () => {
	test("every statement carries its document span", () => {
		const text = "/ip address\nadd address=1.2.3.4/24\nprint";
		const { statements } = resolveStatements(text);
		expect(statements.map((s) => s.span)).toEqual([
			{ start: 0, end: 11 },
			{ start: 12, end: 34 },
			{ start: 35, end: 40 },
		]);
		for (const s of statements)
			expect(text.slice(s.span.start, s.span.end)).toBe(s.text);
	});

	test("a bracket span covers the whole `[…]`", () => {
		const text = "/ip firewall filter remove [find chain=input]";
		const [resolution] = resolveDocument(text).resolutions;
		expect(resolution?.span).toEqual({ start: 27, end: 45 });
		expect(text.slice(27, 45)).toBe("[find chain=input]");
	});

	test("a statement inside a block body is located in DOCUMENT space", () => {
		const text = ":foreach i in=x do={ /ip route add gateway=1.2.3.4 }";
		const inner = resolveStatements(text).statements.find((s) =>
			s.text.startsWith("/ip route"),
		);
		expect(inner).toBeDefined();
		expect(
			text.slice(inner?.span.start as number, inner?.span.end as number),
		).toBe("/ip route add gateway=1.2.3.4");
	});
});

// --- the coordinate-pass classes -------------------------------------------

describe("Coordinate-pass defects", () => {
	test("a BOM is reported once and not also as non-ascii", () => {
		const defects = coordinateDefects(analyzeCoordinates("﻿/ip route print"));
		expect(defects).toEqual([{ code: "bom", start: 0, end: 3 }]);
	});

	test("a mid-document U+FEFF is ordinary non-ascii content", () => {
		const defects = coordinateDefects(analyzeCoordinates("/ip﻿route"));
		expect(defects).toEqual([{ code: "non-ascii", start: 3, end: 6 }]);
	});

	test("non-ascii runs coalesce but are split by ASCII", () => {
		expect(coordinateDefects(analyzeCoordinates("a€€b€c"))).toEqual([
			{ code: "non-ascii", start: 1, end: 7 },
			{ code: "non-ascii", start: 8, end: 11 },
		]);
	});

	test("pure ASCII yields nothing", () => {
		expect(coordinateDefects(analyzeCoordinates("/ip route print"))).toEqual(
			[],
		);
	});

	test("a non-ascii value never abstains the write tristate", () => {
		// examples.md example 22 is a legal command; a UTF-8 comment or value must
		// not flip `containsWrite` to `unknown`. The note channel is what gates
		// that, and these two classes deliberately never enter it.
		const analysis = containsWrite('/system identity set name="router-🚀"');
		expect(analysis.notes).toEqual([]);
		expect(analysis.verdict).not.toBe("unknown");
		expect(analysis.defects.every((d) => isPositionalFact(d.code))).toBe(true);
	});
});

describe("byteSpanToRange", () => {
	const text = "/ip route\nadd gateway=1.2.3.4";
	const a = analyzeCoordinates(text);

	test("maps a span to LSP line/col at both ends", () => {
		expect(byteSpanToRange(a, 10, 13)).toEqual({
			start: { line: 1, col: 0 },
			end: { line: 1, col: 3 },
		});
	});

	test("end-of-input is a legal end", () => {
		const bytes = a.analyzed.length;
		expect(() => byteSpanToRange(a, 0, bytes)).not.toThrow();
	});

	test("an empty span is legal; a reversed one throws", () => {
		expect(byteSpanToRange(a, 4, 4).start).toEqual(
			byteSpanToRange(a, 4, 4).end,
		);
		expect(() => byteSpanToRange(a, 9, 2)).toThrow(/precedes start/);
	});

	test("both endpoints snap to a character boundary", () => {
		const astral = analyzeCoordinates("ab🚀cd");
		// bytes 2..6 are the four bytes of the astral char; an interior cursor
		// snaps back to its start rather than landing mid-character.
		expect(byteSpanToRange(astral, 3, 5)).toEqual({
			start: { line: 0, col: 2 },
			end: { line: 0, col: 2 },
		});
	});
});

describe("library surface", () => {
	test("the defect vocabulary is exported from the root", () => {
		expect(centrs.defectAt).toBe(defectAt);
		expect(centrs.mergeDefects).toBe(mergeDefects);
		expect(centrs.rebaseDefects).toBe(rebaseDefects);
		expect(centrs.isPositionalFact).toBe(isPositionalFact);
		expect(centrs.coordinateDefects).toBe(coordinateDefects);
		expect(centrs.byteSpanToRange).toBe(byteSpanToRange);
	});

	test("every analyzer exposes a defects channel beside its notes", () => {
		const text = "/ip) route add x=1";
		for (const analysis of [
			segmentStatements(text),
			resolveStatements(text),
			resolveDocument(text),
			resolveSymbols(text),
			containsWrite(text),
			centrs.resolveVerbs(text),
		])
			expect(Array.isArray(analysis.defects)).toBe(true);
	});
});
