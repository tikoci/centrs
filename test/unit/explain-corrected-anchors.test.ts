import { describe, expect, test } from "bun:test";
import { explainCommand } from "../../src/explain.ts";
import { classifyParseResult } from "../../src/protocols/mac-telnet-console.ts";
import fixture from "../fixtures/explain/corrected-anchors.json" with {
	type: "json",
};

/**
 * Corrected core-syntax anchors (#374) at the public entry.
 *
 * The original five-row comparison mixed real checker disagreements, a
 * misspelled parameter, a placeholder, and missing menu context — it must not
 * become acceptance tests directly. Each case below is a minimized exact input
 * with a named structural assertion; table-level coverage (the operator table,
 * the fixture sweeps) stays in its own files and is not duplicated here.
 *
 * Device evidence: `test/fixtures/explain/corrected-anchors.json`, the raw
 * `:parse` return for every input on stable and long-term CHR, recorded by
 * `bun run explain:probe:corrected-anchors`. The last block below joins each
 * row to the offline verdict. Two inputs the device rejects pass offline on
 * purpose: the `decimator=` typo and the standalone root `[find … name=…]` are
 * argument-name faults, and offline reads values, not argument names (no
 * offline attribute-schema expansion). Passing `:parse` never proves runtime
 * acceptance.
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
		// Boundary pin: the device rejects `decimator=` (fixture row
		// `comma-value-typo`), but without an offline attribute-schema
		// expansion it is as unknown as `delimiter=`, so both pass. If a
		// future change validates argument names offline, revisit this
		// deliberately.
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
		// resolves at the root `find`, as the device does (`/find` in the
		// fixture's IL), rather than inventing a menu. The device then rejects
		// `name=` as an argument of root `find` — an argument-name fault,
		// outside offline scope (fixture row `standalone-find`).
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

type Row = (typeof fixture.rows)[number];

function deviceAccepts(row: Row, version: string): boolean {
	const output = (row.parse as Record<string, string>)[version];
	if (output === undefined) throw new Error(`${row.id}: no ${version} row`);
	try {
		classifyParseResult(output, row.input, "rest-api");
		return true;
	} catch {
		return false;
	}
}

// Offline verdict per row. Anchors must pass; boundaries pass because the
// fault is an argument name; controls split into syntax faults offline
// catches and name/arity faults it does not.
const OFFLINE_VERDICT: Record<string, "pass" | "fail"> = {
	"apply-operator": "pass",
	"apply-operator-declared": "pass",
	"nested-array": "pass",
	"comma-value": "pass",
	"comma-value-typo": "pass",
	"trailing-selector": "pass",
	"trailing-selector-declared": "pass",
	"contextual-find": "pass",
	"standalone-find": "pass",
	"standalone-find-declared": "pass",
	"control-apply-no-rhs": "fail",
	"control-unclosed-array": "fail",
	"control-selector-extra": "pass",
	"control-unknown-command": "pass",
};

describe("corrected anchors against recorded device :parse (#374)", () => {
	const versions = Object.keys(fixture.versions);

	test("the fixture covers stable and long-term for every row", () => {
		expect(versions).toEqual(["7.25", "7.23.8"]);
		expect(fixture.rows.map((r) => r.id).sort()).toEqual(
			Object.keys(OFFLINE_VERDICT).sort(),
		);
	});

	for (const row of fixture.rows) {
		test(`${row.role} ${row.id}`, () => {
			for (const version of versions)
				expect([version, deviceAccepts(row, version)]).toEqual([
					version,
					row.role === "anchor",
				]);
			const offline = OFFLINE_VERDICT[row.id];
			if (offline === undefined) throw new Error(`${row.id}: no verdict`);
			expect(explainCommand(row.input).verdict).toBe(offline);
		});
	}
});
