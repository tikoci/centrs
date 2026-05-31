import { describe, expect, test } from "bun:test";
import {
	canonicalizeExecuteCommand,
	isWriteShaped,
} from "../../src/execute.ts";

/**
 * Legacy-contract fixture table for the `execute` script-vs-structured gate.
 *
 * centrs OWNS this gate; it is the load-bearing discriminator that decides
 * whether a command is sent as a structured (path + verb + attributes) call —
 * which is validated, write-shape-detected, and confirmation-gated — or passed
 * through verbatim as a raw RouterOS script. Widening what counts as
 * `structured` is a product regression (it can change validation, the write
 * confirmation prompt, and what is actually executed).
 *
 * This table pins the exact current behavior so any future refactor — notably a
 * possible convergence on the shared `rosetta`/`lsp-routeros-ts` canonicalizer
 * (see `docs/CONSTITUTION.md` → "Sibling projects" and the canonicalization
 * note) — cannot silently change it. The shared parser is intentionally
 * prose-tolerant and multi-command; this contract is the guardrail that keeps
 * centrs's gate conservative regardless of what foundation it is built on.
 *
 * Note the bracket cases: a `[...]` subshell selector must stay `script` so
 * RouterOS evaluates the subshell itself, instead of being mangled into corrupt
 * key=value attributes on a write-shaped call.
 */

interface GateCase {
	input: string;
	mode: "structured" | "script";
	write: boolean;
	path?: string;
	verb?: string;
}

const cases: GateCase[] = [
	// --- must stay script (must NOT be structured-executed) ---
	{ input: "ip address print", mode: "script", write: false },
	{ input: "/ip/address print", mode: "script", write: false },
	{
		input: "/ip/address/print where interface=ether1",
		mode: "script",
		write: false,
	},
	{
		input: "/ip/address/add address=1.2.3.4/32; /ip/address/print",
		mode: "script",
		write: false,
	},
	{
		input: "/ip/address { print; add address=1.2.3.4/32 interface=ether1 }",
		mode: "script",
		write: false,
	},
	{
		input: "/ip/address/set [find interface=ether1] disabled=yes",
		mode: "script",
		write: false,
	},
	{
		input: "/ip/address/set numbers=[find interface=ether1] disabled=yes",
		mode: "script",
		write: false,
	},
	{ input: ':put "hello"', mode: "script", write: false },
	{ input: ":put [/system/identity/get name]", mode: "script", write: false },

	// --- must stay structured ---
	{
		input: "/ip/address/print",
		mode: "structured",
		write: false,
		path: "/ip/address",
		verb: "print",
	},
	{
		input: "/ip/address/print ?proplist=.id,address",
		mode: "structured",
		write: false,
		path: "/ip/address",
		verb: "print",
	},
	{
		input:
			'/ip/address/add address=198.51.100.10/32 interface=ether1 comment="x y"',
		mode: "structured",
		write: true,
		path: "/ip/address",
		verb: "add",
	},
	{
		input: "/ip/address/set .id=*1 disabled=yes",
		mode: "structured",
		write: true,
		path: "/ip/address",
		verb: "set",
	},
	{
		input: "/system/identity/set name=centrs-test",
		mode: "structured",
		write: true,
		path: "/system/identity",
		verb: "set",
	},
	{
		input: "/ip/address/remove numbers=*1",
		mode: "structured",
		write: true,
		path: "/ip/address",
		verb: "remove",
	},
];

describe("execute gate legacy contract", () => {
	for (const item of cases) {
		test(`${item.mode}: ${item.input}`, () => {
			const command = canonicalizeExecuteCommand(item.input);
			expect(command.mode).toBe(item.mode);
			expect(isWriteShaped(command)).toBe(item.write);
			if (item.path !== undefined) {
				expect(command.path).toBe(item.path);
			}
			if (item.verb !== undefined) {
				expect(command.verb).toBe(item.verb);
			}
		});
	}

	test("a subshell selector is never write-shaped structured", () => {
		// Regression guard for the dangerous parse: this previously became a
		// structured write with attributes `{ numbers: "[find", interface: ... }`.
		const command = canonicalizeExecuteCommand(
			"/ip/address/set numbers=[find default=yes] disabled=yes",
		);
		expect(command.mode).toBe("script");
		expect(isWriteShaped(command)).toBe(false);
		expect(command.attributes).toEqual({});
	});
});
