import { describe, expect, test } from "bun:test";
import {
	compareSymbolClass,
	normalizeVariableClass,
} from "../../scripts/probes/explain-symbol-comparison.ts";

describe("explain symbol probe comparisons", () => {
	test("a deliberate offline abstention is distinct from a disagreement", () => {
		expect(compareSymbolClass(null, "none")).toBe("abstain");
		expect(compareSymbolClass(null, "variable-undefined")).toBe("abstain");
		expect(compareSymbolClass(null, "variable-local")).toBe("abstain");
		expect(compareSymbolClass("variable-local", "variable-local")).toBe(
			"agree",
		);
		expect(compareSymbolClass("variable-local", "variable-global")).toBe(
			"disagree",
		);
	});

	test("K3 capture classes normalize in both historical spellings", () => {
		expect(normalizeVariableClass("local")).toBe("local");
		expect(normalizeVariableClass("variable-local")).toBe("local");
		expect(normalizeVariableClass("variable-parameter")).toBe("parameter");
	});
});
