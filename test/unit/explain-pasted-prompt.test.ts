import { describe, expect, test } from "bun:test";
import { explainCommand, explainEnvelope } from "../../src/explain.ts";

const pastedTips = (input: string) =>
	explainEnvelope(input).tips.filter(
		(t) => t.code === "tip/explain-pasted-prompt",
	);

describe("explain pasted-prompt repair (#370)", () => {
	test("a bracket prompt still fails, and offers the stripped candidate", () => {
		const input = "[admin@MikroTik] > /ip/address print";
		expect(explainCommand(input).verdict).toBe("fail");
		expect(
			explainCommand(input).diagnostics.some(
				(d) => d.code === "explain/canonicalizer/invalid-at-sign",
			),
		).toBe(true);
		const tips = pastedTips(input);
		expect(tips).toHaveLength(1);
		expect(tips[0]?.fix).toContain("/ip/address print");
	});

	test("a /menu> prompt stays an abstention, and offers what was typed", () => {
		const input = "/interface/lte> monitor lte1";
		expect(explainCommand(input).verdict).toBe("warn");
		const tips = pastedTips(input);
		expect(tips).toHaveLength(1);
		expect(tips[0]?.fix).toContain("monitor lte1");
		expect(tips[0]?.message).toContain("/interface/lte");
	});

	test("prompt-looking text in comments and strings stays legal", () => {
		for (const input of [
			"# [admin@x] > /ip address print",
			':put "[admin@x] > hi"',
			':put "a\n[admin@x] > /ip address print\nb"',
			":if ($a > 1) do={:put $a}",
			"/ip address print",
			"Flags: something",
		])
			expect(pastedTips(input)).toEqual([]);
	});

	test("a bare prompt with no command offers nothing", () => {
		expect(pastedTips("[admin@MikroTik] >")).toEqual([]);
	});
});
