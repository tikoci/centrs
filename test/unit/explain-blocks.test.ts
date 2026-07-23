import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	blockTree,
	isScopeBrace,
	SCOPE_ARG_NAMES,
	scopeBodies,
	scopeNameAt,
	topology,
} from "../../src/explain/blocks.ts";
import * as centrs from "../../src/index.ts";

/**
 * Q2 block / scope-brace anchor tests (phase 0.5, #185/#186).
 *
 * Promoted from the throwaway lab probes `.scratch/explain-lab-blocktree.ts`
 * (the SUT) and `.scratch/explain-lab-q2-corners.ts` (the constructed corners,
 * two CHR-confirmed against `:parse` IL on 7.23.2). The production module is
 * `src/explain/blocks.ts`; it sits on the Q1 segmenter shipped in #189.
 *
 * `expect` is the ratified canonical topology string (`do[]`, `do[do[]]`,
 * `command[]on-error[]`, …) — the human/CHR-labeled contract that pins whether
 * a `name={…}` brace is a SCOPE (descended) or a LITERAL value (opaque).
 */

interface Corner {
	name: string;
	input: string;
	expect: string;
	why: string;
	verified?: string;
}

const corners: Corner[] = JSON.parse(
	readFileSync(
		new URL("../fixtures/explain/blocks.json", import.meta.url),
		"utf8",
	),
).corners;

describe("ratified block topology (Q2 corners)", () => {
	for (const c of corners) {
		test(c.name, () => {
			expect(topology(blockTree(c.input))).toBe(c.expect);
		});
	}
});

describe("block tree carries each statement's text", () => {
	for (const c of corners) {
		test(c.name, () => {
			// The tree is one node per top-level statement; every node keeps its
			// (segmenter-produced) text so consumers can map blocks back to source.
			for (const node of blockTree(c.input))
				expect(typeof node.text).toBe("string");
		});
	}
});

test("the source-visible scope set is the ratified closed set", () => {
	expect([...SCOPE_ARG_NAMES].sort()).toEqual([
		"command",
		"do",
		"else",
		"on-error",
	]);
});

test("scopeNameAt names a scope brace and rejects a literal", () => {
	// `do={` is a scope; `source={` and `script={` are literal values.
	const scope = ":if (true) do={ :put 1 }";
	expect(scopeNameAt(scope, scope.indexOf("{"))).toBe("do");
	const literal = "/system/script add name=x source={ :put 1 }";
	expect(scopeNameAt(literal, literal.indexOf("{"))).toBeNull();
	expect(isScopeBrace(scope, scope.indexOf("{"))).toBeTrue();
	expect(isScopeBrace(literal, literal.indexOf("{"))).toBeFalse();
});

test("in={…} is head-dependent: scope after :onerror, literal after :foreach", () => {
	const onerror = ":onerror e in={ /file/remove [find] } do={ :put 1 }";
	expect(scopeNameAt(onerror, onerror.indexOf("in={") + 3)).toBe("in");
	const foreach = ':foreach t in={ "p12"; "pem" } do={ :put $t }';
	expect(scopeNameAt(foreach, foreach.indexOf("in={") + 3)).toBeNull();
});

test("non-ASCII whitespace is opaque, not RouterOS syntax", () => {
	for (const whitespace of ["\u00a0", "\u2003", "\u2028"]) {
		const named = `:if (true) do=${whitespace}{ :put 1 }`;
		expect(scopeNameAt(named, named.indexOf("{"))).toBeNull();
		const directive = `:do${whitespace}{ :put 1 }`;
		expect(scopeNameAt(directive, directive.indexOf("{"))).toBeNull();
	}
});

test("scopeBodies returns only scope bodies, never literal ones", () => {
	// One scope (`do={…}`) and one literal (`source={…}`) in the same statement.
	const bodies = scopeBodies(
		"/system/script add name=x source={ :put 1 } do={ :put 2 }",
	);
	expect(bodies).toHaveLength(1);
	expect(bodies[0]).toContain(":put 2");
});

test("never throws on adversarial input", () => {
	for (const input of ["", "{", "}}}", 'do={"', ":onerror {", "do {"]) {
		expect(() => topology(blockTree(input))).not.toThrow();
	}
});

test("block API is re-exported from the library barrel", () => {
	expect(centrs.blockTree).toBe(blockTree);
	expect(centrs.topology).toBe(topology);
	expect(centrs.scopeNameAt).toBe(scopeNameAt);
});
