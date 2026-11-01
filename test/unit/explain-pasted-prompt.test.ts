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

	test("a ;-joined pasted line keeps every statement in the repair", () => {
		const tips = pastedTips("[admin@MikroTik] > :put 1; :put 2");
		expect(tips).toHaveLength(1);
		expect(tips[0]?.fix).toContain(":put 1; :put 2");
		const menuTips = pastedTips("/interface/lte> monitor lte1; monitor lte2");
		expect(menuTips).toHaveLength(1);
		expect(menuTips[0]?.fix).toContain("monitor lte1; monitor lte2");
	});

	test("a second pasted prompt starts its own repair", () => {
		const tips = pastedTips("[admin@x] > :put 1\n[admin@x] > :put 2");
		expect(tips).toHaveLength(2);
		expect(tips[0]?.fix).toContain(":put 1");
		expect(tips[0]?.fix).not.toContain(":put 2");
		expect(tips[1]?.fix).toContain(":put 2");
	});
});
