import { describe, expect, test } from "bun:test";
import { explainCommand } from "../../src/explain.ts";

describe("239 S2 — flow-sensitive symbol → value", () => {
	test("declaration links to literal valueId and reference reaches it", () => {
		const data = explainCommand(":local x 1.3; :put $x");
		const [decl, ref] = data.symbols.occurrences;
		expect(decl?.valueId).toBe("v0");
		expect(ref?.reachingValueIds).toEqual(["v0"]);
		expect(ref?.reachingUnknown).toBeUndefined();
		const shape = data.values.occurrences.find((v) => v.id === decl?.valueId);
		expect(shape?.facts.shapeHints?.values).toEqual(["ip"]);
	});

	test("assignment updates reaching to last literal", () => {
		const data = explainCommand(":local x 1; :set x 2; :put $x");
		const [decl, assign, ref] = data.symbols.occurrences;
		expect(decl?.valueId).toBe("v0");
		expect(assign?.valueId).toBe("v1");
		expect(ref?.reachingValueIds).toEqual(["v1"]);
	});

	test("non-literal RHS yields unknown reaching", () => {
		const data = explainCommand(":local a 1; :set a $b; :put $a");
		const [, assign, , ref] = data.symbols.occurrences;
		expect(assign?.valueId).toBeUndefined();
		expect(ref?.reachingUnknown).toBe(true);
		expect(ref?.reachingValueIds).toEqual([]);
	});

	test("a non-literal branch definition cannot borrow a sibling literal", () => {
		const data = explainCommand(
			":local x 1; :if true do={ :set x $y } else={ :set x 3 }; :put $x",
		);
		const assignments = data.symbols.occurrences.filter(
			(occ) => occ.role === "assignment",
		);
		expect(assignments[0]?.valueId).toBeUndefined();
		expect(assignments[1]?.valueId).toBe("v2");
		const ref = data.symbols.occurrences.at(-1);
		expect(ref?.reachingValueIds).toEqual(["v0", "v2"]);
		expect(ref?.reachingUnknown).toBe(true);
	});

	test("a function definition cannot claim a literal from its body", () => {
		const data = explainCommand(":local f do={:put 1}; :put $f");
		const [declaration, reference] = data.symbols.occurrences;
		expect(declaration?.valueId).toBeUndefined();
		expect(reference?.reachingValueIds).toEqual([]);
		expect(reference?.reachingUnknown).toBe(true);
	});

	test("statement ownership replaces arbitrary source-distance limits", () => {
		const input = `:local x${" ".repeat(80)}1; :put $x`;
		const data = explainCommand(input);
		const [declaration, reference] = data.symbols.occurrences;
		expect(declaration?.valueId).toBe("v0");
		expect(reference?.reachingValueIds).toEqual(["v0"]);
	});

	test("branch merge is a set (no unknown when both literals)", () => {
		const data = explainCommand(
			":local x 1; :if (true) do={ :set x 2 }; :put $x",
		);
		const ref = data.symbols.occurrences.at(-1);
		expect(ref?.reachingValueIds?.sort()).toEqual(["v0", "v1"].sort());
		expect(ref?.reachingUnknown).toBeUndefined();
	});

	test("branch with else merges both branches", () => {
		const data = explainCommand(
			":local x 1; :if (true) do={ :set x 2 } else={ :set x 3 }; :put $x",
		);
		const ref = data.symbols.occurrences.at(-1);
		expect(ref?.reachingValueIds?.sort()).toEqual(["v0", "v1", "v2"].sort());
	});

	test("plural reaching ids retain value-occurrence order past v9", () => {
		const branches = Array.from(
			{ length: 7 },
			(_, index) => `:if true do={ :set x ${index + 1} }`,
		).join("; ");
		const data = explainCommand(`:local x 0; ${branches}; :put $x`);
		const ref = data.symbols.occurrences.at(-1);
		const definitionOrder = data.symbols.occurrences
			.filter(
				(occurrence) =>
					occurrence.role === "declaration" || occurrence.role === "assignment",
			)
			.flatMap((occurrence) =>
				occurrence.valueId === undefined ? [] : [occurrence.valueId],
			);
		expect(definitionOrder.some((id) => Number(id.slice(1)) >= 10)).toBe(true);
		expect(ref?.reachingValueIds).toEqual(definitionOrder);
	});

	test("loop merge is unknown", () => {
		const data = explainCommand(
			":local x 1; :while true do={ :set x 2 }; :put $x",
		);
		const ref = data.symbols.occurrences.at(-1);
		expect(ref?.reachingUnknown).toBe(true);
		expect(ref?.reachingValueIds).toEqual(expect.arrayContaining(["v0", "v2"]));
	});

	test("the owning verb, not loop words in a condition, decides block flow", () => {
		const branch = explainCommand(
			':local x 1; :if ("while"="while") do={ :set x 2 }; :put $x',
		);
		const branchRef = branch.symbols.occurrences.at(-1);
		const branchValues = branch.symbols.occurrences
			.filter(
				(occurrence) =>
					occurrence.role === "declaration" || occurrence.role === "assignment",
			)
			.flatMap((occurrence) =>
				occurrence.valueId === undefined ? [] : [occurrence.valueId],
			);
		expect(branchRef?.reachingUnknown).toBeUndefined();
		expect(branchRef?.reachingValueIds).toEqual(branchValues);

		const nestedLoop = explainCommand(
			":local x 1; :if true do={ :while true do={ :set x 2 } }; :put $x",
		);
		const loopRef = nestedLoop.symbols.occurrences.at(-1);
		expect(loopRef?.reachingUnknown).toBe(true);
	});

	test("shadowing keeps distinct bindingIds and reaching", () => {
		const data = explainCommand(":local x 1; { :local x 2; :put $x }; :put $x");
		const occ = data.symbols.occurrences;
		// outer decl b0 v0, inner decl b1 v1, inner ref b1 -> v1, outer ref b0 -> v0
		expect(occ[0]?.bindingIds).toEqual(["b0"]);
		expect(occ[0]?.valueId).toBe("v0");
		expect(occ[1]?.bindingIds).toEqual(["b1"]);
		expect(occ[1]?.valueId).toBe("v1");
		expect(occ[2]?.reachingValueIds).toEqual(["v1"]);
		expect(occ[3]?.reachingValueIds).toEqual(["v0"]);
	});

	test("loop variable has no valueId and reference is unknown", () => {
		const data = explainCommand(":foreach i in={1;2} do={ :put $i }");
		const [binding, ref] = data.symbols.occurrences;
		expect(binding?.role).toBe("binding");
		expect(binding?.valueId).toBeUndefined();
		expect(ref?.reachingUnknown).toBe(true);
	});

	test("array literal declaration links to container", () => {
		const data = explainCommand(":local z {1;2;3}; :put $z");
		const [decl, ref] = data.symbols.occurrences;
		expect(decl?.valueId).toBe("v0");
		const container = data.values.occurrences.find(
			(v) => v.id === decl?.valueId,
		);
		expect(container?.facts.shapeHints?.values).toEqual(["array"]);
		expect(ref?.reachingValueIds).toEqual(["v0"]);
	});

	test("quoted hyphenated name links correctly", () => {
		const data = explainCommand(':global "set-dns" 1; :put $"set-dns"');
		const [decl, ref] = data.symbols.occurrences;
		expect(decl?.valueId).toBeDefined();
		expect(ref?.reachingValueIds).toEqual([decl?.valueId as string]);
	});
});
