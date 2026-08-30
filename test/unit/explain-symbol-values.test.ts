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

	test("loop merge is unknown", () => {
		const data = explainCommand(
			":local x 1; :while true do={ :set x 2 }; :put $x",
		);
		const ref = data.symbols.occurrences.at(-1);
		expect(ref?.reachingUnknown).toBe(true);
		expect(ref?.reachingValueIds).toEqual(expect.arrayContaining(["v0", "v2"]));
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
