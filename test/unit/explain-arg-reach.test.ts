/**
 * `scripts/explain-arg-reach-sweep.ts` — the A-vs-B measurement behind #316.
 *
 * The sweep's numbers are the whole argument for skip-and-continue over
 * stop-at-first-refusal, and they are quoted in `commands/explain/README.md`
 * and in the PR that made the choice. The corpus is not in this repo, so what is
 * gated here is the COUNTING and the MISMATCH GATE, on inline scripts whose
 * expected answer can be read off the source. A change that silently altered
 * either would otherwise reshape the reach table with nothing to notice it.
 *
 * The same reason `test/unit/explain-token-census.test.ts` gates `census()`:
 * a measurement script that produces a published number is not exempt from
 * having its arithmetic pinned.
 */

import { describe, expect, test } from "bun:test";
import { sweep } from "../../scripts/explain-arg-reach-sweep.ts";

describe("the reach sweep counts what it says it counts", () => {
	test("a fully literal statement is read by all three designs", () => {
		const r = sweep(["/ip/route/add dst-address=0.0.0.0/0 gateway=1.1.1.1"]);
		expect(r.candidates).toBe(1);
		expect(r.strictRead).toBe(1);
		expect(r.strictRefused).toBe(0);
		// Nothing is undecodable, so the three token counts coincide.
		expect(r.tokensStrict).toBe(2);
		expect(r.tokensDesignA).toBe(2);
		expect(r.tokensDesignB).toBe(2);
		expect(r.undecidedTokens).toBe(0);
		expect(r.boundaryMismatches).toEqual([]);
	});

	test("a refusal AFTER a literal is the row design A recovers", () => {
		const r = sweep(["/ip/route/add dst-address=0.0.0.0/0 gateway=$g"]);
		expect(r.strictRefused).toBe(1);
		expect(r.refusedWithPrefix).toBe(1);
		expect(r.onlyReachedByB).toBe(0);
		expect(r.tokensStrict).toBe(0); // the strict reading discards its prefix
		expect(r.tokensDesignA).toBe(1); // …which design A publishes
		expect(r.tokensDesignB).toBe(2); // …and design B carries on past
		expect(r.undecidedTokens).toBe(1);
		expect(r.refusalReasons).toEqual({ "a variable value": 1 });
		expect(r.boundaryMismatches).toEqual([]);
	});

	test("a refusal FIRST is the row only design B reaches", () => {
		const r = sweep(["/ip/route/add gateway=$g dst-address=0.0.0.0/0"]);
		expect(r.refusedWithPrefix).toBe(0);
		expect(r.onlyReachedByB).toBe(1);
		expect(r.tokensDesignA).toBe(0);
		expect(r.tokensDesignB).toBe(2);
	});

	test("the separator columns separate strict, A and B", () => {
		// The undecodable token sits BEFORE the second run, so only design B's
		// token list still holds the run. This is the fork, in one row.
		const r = sweep([
			"/ip/address add interface=$x /ip/route add gateway=1.1.1.1",
		]);
		expect(r.separatorRunsStrict).toBe(0);
		expect(r.separatorRunsDesignA).toBe(0);
		expect(r.separatorRunsDesignB).toBe(1);
	});

	test("the shapes that would stop both walks never reach the walk", () => {
		// This is WHY the corpus reports 0 incomplete, and it is a property of the
		// pipeline rather than luck: an unterminated string and an unbalanced
		// delimiter are document defects the segmenter/resolver answers first, so
		// no addressable statement with an argument list is produced at all, and a
		// `;` is split into two statements before any argument is lexed. The stop
		// behaviour itself is pinned directly on `lexArgumentTokens` in
		// `test/unit/explain-args.test.ts`.
		for (const text of [
			'/ip/route/add comment="oops gateway=1.1.1.1',
			"/ip/route/add gateway=[find name=x",
		]) {
			const r = sweep([text]);
			expect(r.candidates).toBe(0);
			expect(r.incomplete).toBe(0);
		}
		const split = sweep(["/ip/route/add gateway=1.1.1.1;comment=x"]);
		expect(split.incomplete).toBe(0);
		expect(split.strictRefused).toBe(0);
	});

	test("a statement that is not addressable is excluded, and said so", () => {
		// `explain.ts` refuses these too (`its text was normalized`), so lexing
		// them here would measure a reading the product does not offer. Counting
		// them is what keeps the reach denominator honest.
		const r = sweep(['/system/identity/set name="router-🚀"']);
		expect(r.candidates).toBe(0);
		expect(r.notAddressable).toBe(1);
		expect(r.strictRead).toBe(0);
		expect(r.strictRefused).toBe(0);
	});

	test("an empty corpus counts nothing and asserts nothing", () => {
		const r = sweep([]);
		expect(r.scripts).toBe(0);
		expect(r.candidates).toBe(0);
		expect(r.boundaryMismatches).toEqual([]);
	});

	test("the mismatch gate is what makes the A column trustworthy", () => {
		// Across a mixed batch the sweep must find zero disagreements — that the
		// strict tokens ARE the tolerant prefix, and that design A's prefix is
		// exactly what the strict lexer returns for those bytes. The gate is only
		// meaningful if it ran, so assert it had refused statements to check.
		const r = sweep([
			"/ip/route/add gateway=1.1.1.1",
			"/ip/route/add gateway=$g comment=x",
			'/system/script/add name=s source={ :put 1 } comment="c"',
			"/ip/firewall/filter/add chain=forward action=accept place-before=[find]",
		]);
		expect(r.strictRefused).toBeGreaterThan(0);
		expect(r.refusedWithPrefix).toBeGreaterThan(0);
		expect(r.boundaryMismatches).toEqual([]);
	});
});

/**
 * The envelope gap (#264 B5) — the published number behind the `=` split.
 *
 * Same rule as the reach columns above: this figure is quoted in
 * `commands/explain/README.md` and was the evidence for giving the `=` its own
 * class, so its arithmetic is pinned here rather than trusted. These counters
 * are measured through `explainCommand`, not the lexer, so they can drift for
 * reasons the reach columns cannot see — a change to the fill's withdrawal
 * rules moves them while every assertion above still passes.
 */
describe("the sweep counts what the envelope cannot account for", () => {
	test("a statement the strict reading READ publishes every separator", () => {
		const r = sweep(["/ip/route/add dst-address=0.0.0.0/0 gateway=1.1.1.1"]);
		expect(r.envelopeSeparators).toBe(2);
		expect(r.envelopeSeparatorsUnpublished).toBe(0);
		expect(r.envelopeScriptsAffected).toBe(0);
		expect(r.envelopeTopUnpublished).toEqual([]);
	});

	test("one refusal leaves the WHOLE statement's separators unpublished", () => {
		// The load-bearing case, and the reason the gap is as large as it is:
		// `arguments` is all-or-nothing, so `dst-address=` goes unpublished too
		// even though it decodes perfectly. A consumer has no `valueSpan` for
		// either one. Contrast the reach columns above, where this same input
		// gives design A a one-token prefix.
		const r = sweep(["/ip/route/add dst-address=0.0.0.0/0 gateway=$g"]);
		expect(r.strictRefused).toBe(1);
		expect(r.envelopeSeparators).toBe(2);
		expect(r.envelopeSeparatorsUnpublished).toBe(2);
		expect(r.envelopeScriptsAffected).toBe(1);
		expect(r.envelopeTopUnpublished).toEqual([
			["dst-address=", 1],
			["gateway=", 1],
		]);
	});

	test("a block binder is named, which is what dominates the corpus figure", () => {
		const r = sweep([':if ($x = 1) do={ :put "hi" }']);
		expect(r.envelopeSeparators).toBe(1);
		expect(r.envelopeSeparatorsUnpublished).toBe(1);
		expect(r.envelopeTopUnpublished).toEqual([["do=", 1]]);
	});

	test("a withdrawn reading paints nothing, so it counts nothing", () => {
		// #311's second command-shaped run withdraws the argument reading, and the
		// fill paints no `arg-sep` at all. Counting tolerant tokens here instead
		// would over-report the gap — which is why this is measured through
		// `explainCommand` rather than `lexArgumentTokens`.
		const r = sweep([
			"/ip/address add interface=ether1 /ip/route add gateway=$g",
		]);
		expect(r.envelopeSeparators).toBe(0);
		expect(r.envelopeSeparatorsUnpublished).toBe(0);
		expect(r.envelopeScriptsAffected).toBe(0);
	});

	test("the unpublished tally ranks by frequency and counts scripts once", () => {
		const r = sweep([
			":if ($a) do={ :put 1 }",
			":foreach x in={1;2} do={ :put $x }",
			"/ip/route/add gateway=1.1.1.1",
		]);
		// Four separators painted, three of them unpublished: the literal
		// `gateway=` in the third script is the one the envelope does publish,
		// so the gap is a real subset rather than "everything the fill painted".
		expect(r.envelopeSeparators).toBe(4);
		expect(r.envelopeSeparatorsUnpublished).toBe(3);
		// Two scripts contribute; the third publishes everything it paints.
		expect(r.envelopeScriptsAffected).toBe(2);
		// Ranked by frequency, and `do=` occurs in both — so the tally is over
		// runs, not over scripts.
		expect(r.envelopeTopUnpublished).toEqual([
			["do=", 2],
			["in=", 1],
		]);
	});

	test("an empty corpus reports an empty gap, not a missing one", () => {
		const r = sweep([]);
		expect(r.envelopeSeparators).toBe(0);
		expect(r.envelopeSeparatorsUnpublished).toBe(0);
		expect(r.envelopeScriptsAffected).toBe(0);
		expect(r.envelopeTopUnpublished).toEqual([]);
	});
});
