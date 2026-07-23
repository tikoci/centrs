import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	resolveDocument,
	resolveStatements,
} from "../../src/explain/pathresolve.ts";
import * as centrs from "../../src/index.ts";

/**
 * Q3/Q4 path-resolution anchor tests (phase 0.5, #185/#186).
 *
 * Promoted from the throwaway lab probe `.scratch/explain-lab-pathresolve.ts`
 * (the SUT) and the constructed corners `.scratch/explain-lab-q3-corners.ts` /
 * `-q4-corners.ts` (several CHR-confirmed against `:parse` IL on 7.23.2 and
 * 7.24rc2). The production module is `src/explain/pathresolve.ts`; only the
 * ratified `stateful` context model is promoted (the A/B arms stayed in the
 * lab). It sits on the Q1 segmenter (#189) and the Q2 scope classifier.
 *
 * `document` corners assert `resolveDocument(input).map(r => r.path)` — the
 * re-constituted `[…]` substitution paths (Q3). `statements` corners assert
 * `resolveStatements(input).map(s => s.path)` — the per-statement canonical
 * paths in source order (Q4). Corners flagged `viaCandidates` are scored
 * against the candidate set, because offline provably cannot pick one reading
 * without a schema (Q6) and asserting a single answer would assert a coin flip.
 * The two KNOWN-LIMIT corners deliberately pin offline's CHR-confirmed
 * divergence from the device (the bare-path cascade and bare-word nav).
 */

interface DocCorner {
	name: string;
	input: string;
	expect: (string | null)[];
	viaCandidates?: true;
	rule: string;
	verified?: string;
}

interface StmtCorner {
	name: string;
	input: string;
	expect: (string | null)[];
	rule: string;
	verified?: string;
}

const fixtures: { document: DocCorner[]; statements: StmtCorner[] } =
	JSON.parse(
		readFileSync(
			new URL("../fixtures/explain/pathresolve.json", import.meta.url),
			"utf8",
		),
	);

describe("Q3 bracket re-constitution (resolveDocument)", () => {
	for (const c of fixtures.document) {
		test(c.name, () => {
			const res = resolveDocument(c.input);
			const got = c.viaCandidates
				? res.map((r, i) =>
						r.candidates.includes(c.expect[i] as string) ? c.expect[i] : r.path,
					)
				: res.map((r) => r.path);
			expect(got).toEqual(c.expect);
		});
	}
});

describe("Q4 per-statement canonical paths (resolveStatements)", () => {
	for (const c of fixtures.statements) {
		test(c.name, () => {
			const got = resolveStatements(c.input).map((s) => s.path);
			expect(got).toEqual(c.expect);
		});
	}
});

describe("candidate invariant — a resolved path is always among its candidates", () => {
	for (const c of fixtures.document) {
		test(c.name, () => {
			for (const r of resolveDocument(c.input)) {
				if (r.path === null) continue;
				expect(r.candidates).toContain(r.path);
			}
		});
	}
});

test("R7 — a variable path segment abstains rather than guessing", () => {
	const [r] = resolveDocument("/ip route remove [$myFinder]");
	expect(r?.path).toBeNull();
	expect(r?.unresolved).toBeDefined();
});

test("a pasted CLI prompt is not manufactured into a command", () => {
	const [r] = resolveDocument("[admin@Router] > /ip address print");
	expect(r?.path).toBeNull();
	expect(r?.klass).toBe("cli-prompt-artifact");
});

test("resolveStatements marks navigation statements as nav", () => {
	const res = resolveStatements("/ip route\nadd gateway=1.1.1.1");
	expect(res.map((s) => s.isNav)).toEqual([true, false]);
	expect(res.map((s) => s.path)).toEqual(["/ip/route", "/ip/route/add"]);
});

test("non-ASCII whitespace is opaque, not a path separator", () => {
	for (const whitespace of ["\u00a0", "\u2003", "\u2028"]) {
		const res = resolveStatements(`/ip${whitespace}route\nadd`);
		expect(res.map((s) => s.isNav)).toEqual([false, false]);
		expect(res.map((s) => s.path)).toEqual([null, "/add"]);
		expect(res[0]?.unresolved).toBeDefined();
	}
});

test("never throws on adversarial input", () => {
	const nasty = [
		"",
		"[",
		"[[[",
		"remove [",
		"/ip route remove [find",
		"$[",
		'/x "$[',
		":foreach x in=[find] do={",
	];
	for (const input of nasty) {
		expect(() => resolveDocument(input)).not.toThrow();
		expect(() => resolveStatements(input)).not.toThrow();
	}
});

test("path-resolution API is re-exported from the library barrel", () => {
	expect(centrs.resolveDocument).toBe(resolveDocument);
	expect(centrs.resolveStatements).toBe(resolveStatements);
});
