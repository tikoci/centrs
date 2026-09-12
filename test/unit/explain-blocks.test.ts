import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	isScopeBrace,
	matchBrace,
	SCOPE_ARG_NAMES,
	scopeBlocks,
	scopeBlocksIn,
	scopeBodies,
	scopeNameAt,
} from "../../src/explain/blocks.ts";
import {
	maskComments,
	scanQuotedString,
	segmentStatements,
} from "../../src/explain/segment.ts";
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

test("a `#`-comment `}` does not truncate a scope body", () => {
	// The `}` inside the comment must be ignored; the body runs to the real `}`.
	const bodies = scopeBodies(":do {\n# }\n:put 1\n}");
	expect(bodies).toHaveLength(1);
	expect(bodies[0]).toBe("\n# }\n:put 1\n");
});

test("a `}` inside a substitution's nested string does not truncate a body", () => {
	// #199 — the `}` sits in the string that `$[…]` opens INSIDE the outer
	// string, so it is not a brace at all. The pre-fix scanner stopped at the
	// first nested `"`, read `}` as code, and cut the body there.
	const text = ':if (true) do={ :put "$[:pick "}" 0 1]"; :put 2 }';
	expect(scopeBodies(text)).toEqual([' :put "$[:pick "}" 0 1]"; :put 2 ']);
	expect(matchBrace(text, text.indexOf("do={") + 3)).toBe(text.length - 1);
});

test("a non-identifier second token is not an :onerror error variable", () => {
	// `:onerror [find] {` is not the `:onerror V { … }` bare-body form, so the
	// brace is a value, not a scope — offline must not descend it.
	const bad = ":onerror [find] { /ip route add }";
	expect(scopeNameAt(bad, bad.indexOf("{"))).toBeNull();
	expect(scopeBodies(bad)).toEqual([]);
	// the ratified `:onerror Err {` form still resolves.
	const good = ":onerror Err { :put 1 }";
	expect(scopeNameAt(good, good.indexOf("{"))).toBe("in");
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

/**
 * The claim the document-wide comment mask rests on (#322).
 *
 * Every reader below the statement walk used to mask the text it was handed;
 * since a statement's text carries its whole nested `do={…}` subtree, each
 * enclosing level re-derived a mask over bytes an inner level had already read.
 * They now read a RANGE of the document's one mask instead
 * (`segment.ts` → `MaskedRange`), which is sound only if a nested region's mask
 * really is the document's mask restricted to it.
 *
 * That is a property of WHERE the regions come from, not of slicing: a comment
 * is decided by the statement context its `#` sits in, and both a statement
 * boundary and a scope body begin one — statement-leading, no continuation
 * pending, an enclosing context that admits statements. So the two readings
 * agree for exactly the regions the walkers descend into, and the cases below
 * are the ones where a context could plausibly leak across the boundary:
 * continuations spanning it, comment bodies carrying delimiters, array literals
 * (which do NOT admit statement-leading comments), strings holding braces and
 * hashes, and unbalanced input where the region has no clean end.
 */
describe("a nested region's mask is the document's mask restricted to it (#322)", () => {
	const CASES: [string, string][] = [
		["continuation into a body", "do={\\\n# c\n:put 1}"],
		["continuation before a body", ":put a\\\n# x\n:if ($a) do={ :put b }"],
		["blank lines inside a continuation run", "do={ \\\n\\\n\\\n:put 1 }"],
		["two arms", ":retry command={:put 1} on-error={# c\n:put 2}"],
		[
			"comment body carrying delimiters",
			":if ($a) do={ # } ; = [ ( $\n:put 1 }",
		],
		["comment before the statement", "# ; { [ (\n:if ($a) do={ :put 1 }"],
		[
			"array literal beside a scope",
			':foreach t in={ "a"; "b" } do={ :put $t }',
		],
		[
			"string holding a brace and a hash",
			':if ($a) do={ :put "} # { ;" ; :put 2 }',
		],
		[
			"interpolated substitution",
			':put "$[/ip/address/find]"; :if ($a) do={ :put "#" }',
		],
		["unterminated string in a body", ':if ($a) do={ :put "abc }'],
		["unclosed body", ":if ($a) do={ :put 1 "],
		["stray closers in a body", ":if ($a) do={ ) ] } :put 1 }"],
		["hash after a closing brace", ":if ($a) do={ :put 1 }\n# c\n:put 2"],
		[
			"comment at the tail of a nested body",
			":if ($a) do={ :if ($b) do={ :put 1 } # c\n }",
		],
		["empty body", ":if ($a) do={}"],
		["head-scoped `in`", ":onerror e in={ :put 1 }"],
		["bare directive body (no colon)", "do { :put 1 }"],
		["CRLF", ":if ($a) do={\r\n# c\r\n:put 1\r\n}"],
		[
			"a comment at every level",
			":if ($a) do={ # L1\n:if ($b) do={ # L2\n:put 1 } }",
		],
	];

	for (const [label, input] of CASES) {
		test(label, () => {
			const documentMask = maskComments(input);
			let regions = 0;
			// Mirrors `pathresolve`'s descent: segment the region, then take each
			// statement's depth-0 scope bodies and recurse into those.
			const descend = (base: number, region: string, depth: number): void => {
				if (depth > 8) return;
				for (const segment of segmentStatements(region).segments) {
					// Only ASCII regions are anchored, and these fixtures are ASCII,
					// so an analyzed-byte offset is a JS string index throughout.
					const start = base + segment.start;
					for (const block of scopeBlocks(segment.text)) {
						const at = start + block.start;
						regions++;
						expect(input.slice(at, at + block.body.length)).toBe(block.body);
						expect(documentMask.slice(at, at + block.body.length)).toBe(
							maskComments(block.body),
						);
						descend(at, block.body, depth + 1);
					}
				}
			};
			descend(0, input, 0);
			// A case that descends into nothing would pass vacuously.
			expect(regions).toBeGreaterThan(0);
		});
	}
});

/**
 * `scanQuotedString`'s `limit`, which is what keeps a ranged reader from
 * borrowing a later region's closing quote (#322).
 */
describe("a bounded string scan stops at the region's end (#322)", () => {
	test("an unterminated string inside the range is not closed by later text", () => {
		const text = ':put "abc ; :put "def"';
		// Unbounded, the quote opened at 5 is closed by the one at 17.
		expect(scanQuotedString(text, 5)).toEqual({ end: 18, closed: true });
		// Bounded at the region end, it is unterminated — the same answer the
		// region taken as a string of its own gives.
		expect(scanQuotedString(text, 5, 10)).toEqual({ end: 10, closed: false });
		expect(scanQuotedString(text.slice(0, 10), 5)).toEqual({
			end: 10,
			closed: false,
		});
	});

	test("a lookahead past the limit cannot change the reported end", () => {
		// `$[` and `\<x>` are the two advances that read ahead; both are clamped.
		for (const text of [':put "a$[b]"', ':put "a\\nb"']) {
			for (let limit = 6; limit <= text.length; limit++) {
				expect(scanQuotedString(text, 5, limit)).toEqual(
					scanQuotedString(text.slice(0, limit), 5),
				);
			}
		}
	});
});

/**
 * The ranged scan answers what the region-as-its-own-document scan answers.
 *
 * `scopeBlocksIn` reads the document's mask at absolute offsets, so the
 * statement lookback behind `scopeNameFromMasked` can see bytes that precede
 * the region; `floor` is what stops it. These cases put a scope name, an `=`, a
 * directive head or a comment immediately OUTSIDE each region, which is what
 * such a lookback would reach.
 *
 * None of them is known to need the clamp — it fires on corpus input but has
 * not been seen to change an answer (`scope-brace.ts` → `scopeNameFromMasked`).
 * What this pins is the equality itself, which is the property the ranged
 * readers depend on, not the mechanism that happens to deliver it today.
 */
test("a ranged scope scan matches the region read on its own (#322)", () => {
	const CASES = [
		":if ($a) do={ {1;2} }",
		":if ($a) do={ do={ :put 1 } }",
		":if ($a) do={ x={1} }",
		":onerror e in={ :onerror f in={ :put 1 } }",
		':foreach t in={ "a" } do={ :foreach u in={ "b" } do={ :put 1 } }',
		":if ($a) do={ /ip/address { :put 1 } }",
		":retry command={ :retry command={ :put 1 } }",
		":if ($a) do={ source={ :put 1 } }",
		":if ($a) do={ # c\n{ :put 1 } }",
	];
	for (const input of CASES) {
		for (const block of scopeBlocks(input)) {
			const at = block.start;
			// The region read as a document of its own — what every level used to
			// do — against the same region read in place.
			expect(
				scopeBlocksIn({
					text: input,
					masked: maskComments(input),
					start: at,
					end: at + block.body.length,
				}),
			).toEqual(scopeBlocks(block.body));
		}
	}
});
