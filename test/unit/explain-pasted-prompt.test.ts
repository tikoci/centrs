// cspell:ignore héllo
import { describe, expect, test } from "bun:test";
import {
	detectPastedPrompts,
	pastedPromptTips,
} from "../../src/explain/pasted-prompt.ts";
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

	test("a block after the prompt keeps its braces and followers", () => {
		const tips = pastedTips("[admin@x] > :put 1; { :put 2 }; :put 3");
		expect(tips).toHaveLength(1);
		expect(tips[0]?.fix).toContain(":put 1; { :put 2 }; :put 3");
	});

	test("a newline after the prompt is preserved, not ;-joined", () => {
		const tips = pastedTips("[admin@x] > :put 1;\n:put 2");
		expect(tips).toHaveLength(1);
		expect(tips[0]?.fix).toContain(":put 1;\n:put 2");
	});

	test("non-ascii input falls back to the prompt's own segment", () => {
		const tips = pastedTips('[admin@x] > :put "héllo"; :put 2');
		expect(tips).toHaveLength(1);
		expect(tips[0]?.fix).toContain(':put "héllo"');
		expect(tips[0]?.fix).not.toContain(":put 2");
	});

	test("a prompt nested in a block keeps the narrow candidate", () => {
		const tips = pastedTips("{ /interface/lte> monitor lte1 }");
		expect(tips).toHaveLength(1);
		expect(tips[0]?.fix).toContain("monitor lte1");
		expect(tips[0]?.fix).not.toContain("}");
	});

	test("a bracket prompt inside a menu offers the command in that menu", () => {
		// The manual's Console page shape: the menu sits between `]` and `>`.
		const input =
			"[admin@MikroTik] /ip/address> add address=192.0.2.1/24 interface=ether1";
		expect(explainCommand(input).verdict).toBe("fail");
		const tips = pastedTips(input);
		expect(tips).toHaveLength(1);
		expect(tips[0]?.message).toContain("`[user@host] /ip/address>`");
		expect(tips[0]?.fix).toBe(
			"Drop the pasted prompt and try `add address=192.0.2.1/24 interface=ether1` (typed at `/ip/address`) instead — this input was not executed.",
		);
	});

	test("a HotLock prompt's doubled > is part of the prompt", () => {
		for (const input of [
			"[admin@MikroTik] /ip/address>> print",
			"[admin@MikroTik] >> /ip/address print",
		]) {
			const tips = pastedTips(input);
			expect(tips).toHaveLength(1);
			expect(tips[0]?.fix).not.toContain(">");
		}
	});

	test("a backtick in the candidate keeps the tip's code span intact", () => {
		const tips = pastedTips('[admin@x] > :put "a`b"');
		expect(tips[0]?.fix).toBe(
			'Drop the pasted prompt and try ``:put "a`b"`` instead — this input was not executed.',
		);
		const edge = pastedTips("[admin@x] > :put `");
		expect(edge[0]?.fix).toContain("`` :put ` ``");
	});

	test("a near-miss bracket prompt fails in linear time", () => {
		// Overlapping quantifiers made these ~1-2 s at 64k bytes (quadratic).
		for (const input of [
			`[admin@x]${" ".repeat(64_000)}x`,
			`[${"@".repeat(64_000)}`,
		]) {
			const started = performance.now();
			expect(detectPastedPrompts(input)).toEqual([]);
			expect(performance.now() - started).toBeLessThan(250);
		}
	});

	test("a candidate with a million backtick runs still gets a tip", () => {
		// Spreading every run into Math.max overflowed the call stack.
		const tips = pastedPromptTips(
			`[admin@x] > :put "${"`x".repeat(1_000_000)}"`,
		);
		expect(tips).toHaveLength(1);
		expect(tips[0]?.fix).toStartWith("Drop the pasted prompt and try ``:put");
	});
});
