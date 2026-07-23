import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	isScopeBrace,
	SCOPE_ARG_NAMES,
	scopeBlocks,
	scopeBodies,
	scopeNameAt,
} from "../../src/explain/blocks.ts";
import { segmentStatements } from "../../src/explain/segment.ts";
import * as centrs from "../../src/index.ts";

/**
 * Q2 block / scope-brace anchor tests (phase 0.5, #185/#186).
 *
 * Promoted from the throwaway lab probes `.scratch/explain-lab-blocktree.ts`
 * (the SUT) and `.scratch/explain-lab-q2-corners.ts` (the constructed corners,
 * two CHR-confirmed against `:parse` IL on 7.23.2). The production module is
 * `src/explain/blocks.ts`; it ships only the non-recursive scope-classification
 * primitives (the recursive block-tree/topology surface stays in the lab until
 * it can be promoted with a bounded traversal of its own).
 *
 * `expect` is the ratified canonical topology string (`do[]`, `do[do[]]`,
 * `command[]on-error[]`, …) — the human/CHR-labeled contract that pins whether
 * a `name={…}` brace is a SCOPE (descended) or a LITERAL value (opaque). The
 * `topology` renderer below is a test-local walk over the shipped primitives,
 * so the anchors still exercise scopeBlocks/scopeNameAt/segmentStatements.
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

/** Test-local canonical fingerprint, rebuilt from the exported primitives. */
function topology(text: string): string {
	return segmentStatements(text)
		.segments.map((s) => s.text)
		.map((t) =>
			scopeBlocks(t)
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
				.map((b) => `${b.name}[${topology(b.body)}]`)
				.join(""),
		)
		.join(",");
}

describe("ratified block topology (Q2 corners)", () => {
	for (const c of corners) {
		test(c.name, () => {
			expect(topology(c.input)).toBe(c.expect);
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

test("scopeBodies returns only scope bodies, never literal ones", () => {
	// One scope (`do={…}`) and one literal (`source={…}`) in the same statement.
	const bodies = scopeBodies(
		"/system/script add name=x source={ :put 1 } do={ :put 2 }",
	);
	expect(bodies).toHaveLength(1);
	expect(bodies[0]).toContain(":put 2");
});

test("scopeBlocks is a single non-recursive pass (no stack growth)", () => {
	// Deeply nested scopes must not recurse here; scopeBlocks only reports the
	// depth-0 block, leaving its body raw for a bounded caller to descend.
	const deep = `${"do={".repeat(5000)}:put 1${"}".repeat(5000)}`;
	expect(() => scopeBlocks(deep)).not.toThrow();
	const blocks = scopeBlocks(deep);
	expect(blocks).toHaveLength(1);
	expect(blocks[0]?.name).toBe("do");
});

test("never throws on adversarial input", () => {
	for (const input of ["", "{", "}}}", 'do={"', ":onerror {", "do {"]) {
		expect(() => scopeBlocks(input)).not.toThrow();
	}
});

test("scope-classification API is re-exported from the library barrel", () => {
	expect(centrs.scopeBlocks).toBe(scopeBlocks);
	expect(centrs.scopeNameAt).toBe(scopeNameAt);
	expect(centrs.scopeBodies).toBe(scopeBodies);
});
