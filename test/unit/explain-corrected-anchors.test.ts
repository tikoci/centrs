import { describe, expect, test } from "bun:test";
import { explainCommand } from "../../src/explain.ts";

/**
 * Corrected core-syntax anchors (#374) at the public entry.
 *
 * The original five-row comparison mixed real checker disagreements, a
 * misspelled parameter, a placeholder, and missing menu context — it must not
 * become acceptance tests directly. Each case below is a minimized exact input
 * with a named structural assertion; table-level coverage (the operator table,
 * the fixture sweeps) stays in its own files and is not duplicated here.
 *
 * What these tests do NOT claim: passing `:parse` or offline acceptance never
 * proves runtime acceptance, and offline reads values, not argument names (no
 * offline attribute-schema expansion). Device evidence for each minimized
 * input is #374's remaining work; these anchors pin the offline structure so
 * that evidence has something to confirm or overturn.
 *
 * Mutation note: the array-structure assertions below are guarded by
 * implementation mutation — widening the array-close `missing-operand` guard
 * in `src/explain/group-faults.ts` from a trailing comma (`last === "comma"`)
 * to any element-final close (`last === "element"`) fails exactly the three
 * array cases (nested array, corrected comma value, typo boundary) with a
 * spurious `missing-operand`, while the operator and `[find]` cases stay
 * green. Observed red before revert; the suite is green on the shipped code.
 */
describe("explain public entry — corrected core-syntax anchors (#374)", () => {
	test("`<%%>` applies in an expression without a grouping fault", () => {
		// The surviving operator candidate: exact #374 input. Table coverage
		// (arities, associativity, lowering) lives in
		// `test/unit/explain-operators.test.ts`; this pins the public entry.
		const data = explainCommand(":put ($a <%% $b)");
		expect(data.verdict).toBe("pass");
		expect(data.structure.statements[0]?.resolution).toBe("resolved");
		expect(data.diagnostics).toEqual([]);
	});

	test("a nested named array is structure, not a missing operand", () => {
		// The surviving nested-array candidate: exact #374 input. A naive
		// brace walk reads the `=` after `reset` as a fault; the shipped
		// array frame reads it as a named element.
		const data = explainCommand(":local m {reset={0;0}; bold={1}}");
		expect(data.verdict).toBe("pass");
		expect(data.diagnostics).toEqual([]);
	});

	test("a comma value passes offline for the corrected argument name", () => {
		// The corrected comma-value control (`delimiter=`, not the
		// `decimator=` typo, which is not a valid positive control).
		const data = explainCommand(
			":local x [:serialize to=dsv delimiter=, {1;2}]",
		);
		expect(data.verdict).toBe("pass");
		expect(data.diagnostics).toEqual([]);
	});

	test("offline reads values, not argument names — the typo passes too", () => {
		// Boundary pin, not a device claim: without an offline
		// attribute-schema expansion, `decimator=` is as unknown as
		// `delimiter=`, so both pass. If a future change validates argument
		// names offline, this test must be revisited deliberately — the
		// device-side comma acceptance for `delimiter=,` remains #374's open
		// device evidence.
		const data = explainCommand(
			":local x [:serialize to=dsv decimator=, {1;2}]",
		);
		expect(data.verdict).toBe("pass");
		expect(data.diagnostics).toEqual([]);
	});

	test("a trailing `[find]` resolves in the statement's menu", () => {
		// The surviving trailing-selector candidate with function/menu
		// context retained: the `[find name="x"]` after `ca=[$f]` resolves
		// at `/certificate`, while the `[$f]` substitution itself abstains
		// instead of fabricating a path.
		const data = explainCommand('/certificate sign ca=[$f] [find name="x"]');
		expect(data.verdict).toBe("pass");
		const inner = data.structure.subcommands;
		expect(inner).toHaveLength(2);
		expect(inner[0]?.resolution).toBe("unknown");
		expect(inner[0]?.command).toBeUndefined();
		expect(inner[1]?.resolution).toBe("resolved");
		expect(inner[1]?.command).toEqual({ path: "/certificate", verb: "find" });
		expect(inner[1]?.span).toEqual({ start: 26, end: 41 });
	});

	test("a contextual `[find]` inherits the menu; a standalone one does not", () => {
		// #374's corrected inheritance case: the enclosing menu is the
		// evidence, and the assertion names the resolved path, verb, and
		// spans — not merely `verdict=pass`.
		const contextual = explainCommand(
			"/ip/address; :local varID [find where name=$varName]",
		);
		const sub = contextual.structure.subcommands;
		expect(sub).toHaveLength(1);
		expect(sub[0]?.resolution).toBe("resolved");
		expect(sub[0]?.command).toEqual({ path: "/ip/address", verb: "find" });
		expect(sub[0]?.span).toEqual({ start: 26, end: 52 });

		// Standalone, there is no table-menu context to inherit: the bracket
		// resolves at the root, it does not invent a menu.
		const standalone = explainCommand(
			":local varID [find where name=$varName]",
		);
		const sub2 = standalone.structure.subcommands;
		expect(sub2).toHaveLength(1);
		expect(sub2[0]?.resolution).toBe("resolved");
		expect(sub2[0]?.command).toEqual({ path: "/", verb: "find" });
		expect(sub2[0]?.span).toEqual({ start: 13, end: 39 });
	});
});
