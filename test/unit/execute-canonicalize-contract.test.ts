import { describe, expect, test } from "bun:test";
import {
	canonicalizeExecuteCommand,
	isWriteShaped,
} from "../../src/execute.ts";

/**
 * Legacy-contract fixture table for the `execute` script-vs-structured gate.
 *
 * centrs OWNS this gate; it is the load-bearing discriminator that decides
 * whether a command is sent as a structured (path + verb + attributes) call or
 * passed through verbatim as a raw RouterOS script. Widening what counts as
 * `structured` is a product regression because it can change validation and
 * what is actually executed. Write detection is deliberately independent of
 * that transport choice: script-mode writes must still be confirmation-gated.
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
		write: true,
	},
	{
		input: "/ip/address { print; add address=1.2.3.4/32 interface=ether1 }",
		mode: "script",
		write: true,
	},
	{
		input: "/ip/address/set [find interface=ether1] disabled=yes",
		mode: "script",
		write: true,
	},
	{
		input: "/ip/address/set numbers=[find interface=ether1] disabled=yes",
		mode: "script",
		write: true,
	},
	{
		input: "/ip/address/remove *1",
		mode: "script",
		write: true,
	},
	{
		input: "/ip/address/disable numbers=*1",
		mode: "structured",
		write: true,
	},
	{
		input: "/ip/address/enable [find comment=x]",
		mode: "script",
		write: true,
	},
	{
		input: "/ip/address/move numbers=*1 destination=0",
		mode: "structured",
		write: true,
	},
	{
		input: "/ip/address/unset numbers=*1 value-name=comment",
		mode: "structured",
		write: true,
	},
	{
		input: "/system/reset-configuration no-defaults=yes",
		mode: "structured",
		write: true,
	},
	{ input: "/import file-name=router.rsc", mode: "script", write: true },
	// `file=` redirects command output into a device file, so a read verb still
	// writes: `/ip/address/export file=address` creates `address.rsc` and
	// `/file/print file=test` creates `test.txt` (RouterOS manual, "Configuration
	// Export" / "Scripting Tips and Tricks"). Root `/export` has a one-segment
	// path, so it lands here in script mode.
	{ input: "/export", mode: "script", write: false },
	{ input: "/export file=backup", mode: "script", write: true },
	{
		input: "/ip/address/print; /export file=backup",
		mode: "script",
		write: true,
	},
	{
		input: ':execute script="/ip/address/remove *1"',
		mode: "script",
		write: true,
	},
	{
		input: "/ip firewall filter\nremove [find comment=x]",
		mode: "script",
		write: true,
	},
	{
		input: "/ip firewall filter\nnew-mutator [find comment=x]",
		mode: "script",
		write: true,
	},
	{ input: "ip address new-mutator", mode: "script", write: true },
	{ input: ':error "fixture"', mode: "script", write: false },
	{ input: ":local a true; :put $a", mode: "script", write: false },
	{ input: ':put "hello"', mode: "script", write: false },
	{ input: ':put "/ip/address/remove"', mode: "script", write: false },
	{ input: ":put [/system/identity/get name]", mode: "script", write: false },
	// The verb is the first word past the known menu prefix, so an unlearned
	// command cannot borrow a later argument: `/user/expire-password` is a real
	// command and `print` here is its username.
	{ input: "/user expire-password print", mode: "script", write: true },
	{ input: "user expire-password print", mode: "script", write: true },
	{ input: ":put [user expire-password admin]", mode: "script", write: true },
	// Every command in a statement is checked, not only the first path.
	{
		input: ":foreach i in=[/ip address find] do={/user expire-password $i}",
		mode: "script",
		write: true,
	},
	{
		input: ":foreach i in=[/ip/address/find] do={/user/expire-password $i}",
		mode: "script",
		write: true,
	},
	{
		input: ':foreach i in=$ids do={:execute "/ip/address/print"}',
		mode: "script",
		write: true,
	},
	{ input: ":if (true) do={:global x 1}", mode: "script", write: true },
	{
		input: ":foreach i in=[/ip address find] do={:put $i}",
		mode: "script",
		write: false,
	},
	{
		input: ':if ([/system identity get name] = "x") do={:put 1}',
		mode: "script",
		write: false,
	},
	{ input: "{\n/ip address print\n}", mode: "script", write: false },
	// A `$[…]`/`$(…)` inside a double-quoted string is code and is classified;
	// the rest of the string, and an escaped `\$`, is literal text. CHR 7.23.7:
	// `:put "v=$[/system identity get name]"` prints `v=CHR`, and
	// `:put "\$[…]"` prints the brackets verbatim.
	{
		input: ':put "$[/system identity set name=x]"',
		mode: "script",
		write: true,
	},
	{
		input: ':put "$[/user expire-password admin]"',
		mode: "script",
		write: true,
	},
	{
		input: ':put "a $("b".[/user expire-password admin]) c"',
		mode: "script",
		write: true,
	},
	{
		input: ':put "name: $[/system identity get name]"',
		mode: "script",
		write: false,
	},
	{
		input: ':put "done; $[/ip address print count-only]"',
		mode: "script",
		write: false,
	},
	{
		input: ':put "[/user expire-password admin]"',
		mode: "script",
		write: false,
	},
	{
		input: ':put "\\$[/user expire-password admin]"',
		mode: "script",
		write: false,
	},
	// Every `[`/`{` starts a command wherever it sits: after a sigil, inside a
	// concatenation, or as a token of its own. A bare `$[…]` outside a string is
	// a device `syntax error` (CHR 7.23.7), so it never runs; gating it is
	// merely conservative.
	{ input: ":put $[/system/identity/set name=x]", mode: "script", write: true },
	{ input: ":put $[/user/expire-password admin]", mode: "script", write: true },
	{
		input: ':put ("x".[/user expire-password admin])',
		mode: "script",
		write: true,
	},
	{
		input: ":if (true) do={ /user expire-password print }",
		mode: "script",
		write: true,
	},
	{
		input: ":if (true) do={ /ip address print }",
		mode: "script",
		write: false,
	},
	// The space-separated menu spelling: the verb is the first known word in the
	// bare run after the path token, not necessarily the word right after it.
	{ input: "/system identity print", mode: "script", write: false },
	{ input: "/system resource print", mode: "script", write: false },
	{ input: "/ip address print detail", mode: "script", write: false },
	{
		input: "/ip firewall filter print where chain=input",
		mode: "script",
		write: false,
	},
	{ input: "/ip/firewall filter print", mode: "script", write: false },
	{ input: ":put [/system identity get name]", mode: "script", write: false },
	{ input: "/interface 6to4 print", mode: "script", write: false },
	{ input: "/ip firewall/filter print", mode: "script", write: false },
	{ input: ":put [/ip address find]", mode: "script", write: false },
	{ input: ":put [:len [/ip address find]]", mode: "script", write: false },
	{ input: "{/ip address print}", mode: "script", write: false },
	// A read verb inside a nested command is not this statement's verb.
	{ input: "/ip address new-mutator [find]", mode: "script", write: true },
	{ input: "/interface 6to4 new-mutator", mode: "script", write: true },
	{ input: "/ip firewall filter", mode: "script", write: true },
	{ input: "/ip address new-mutator", mode: "script", write: true },
	{ input: "/ip/firewall filter new-mutator", mode: "script", write: true },
	{
		input: "/ip firewall filter set [find comment=x] disabled=yes",
		mode: "script",
		write: true,
	},

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
	{
		input: "/ip/address/export",
		mode: "structured",
		write: false,
		path: "/ip/address",
		verb: "export",
	},
	{
		input: "/ip/address/export file=address",
		mode: "structured",
		write: true,
		path: "/ip/address",
		verb: "export",
	},
	{
		input: "/file/print file=test",
		mode: "structured",
		write: true,
		path: "/file",
		verb: "print",
	},
	{
		// A `?`-prefixed word is a query filter, never an attribute, so the gate
		// must not read it as the `file=` output redirect.
		input: "/file/print ?file=test",
		mode: "structured",
		write: false,
		path: "/file",
		verb: "print",
	},
	// A truly bare known-menu path is console navigation — a no-op read, not a
	// command (orca triage 2026-10-26: `/system/identity` needed `--yes`
	// while `/system/identity/print` did not). Structured mode proves the input is a
	// single path token, so unlike the script branch (where `/ip firewall
	// filter` stays write-shaped per #387: a later line may carry a relative
	// verb) there is no follow-up hazard here.
	{
		input: "/system/identity",
		mode: "structured",
		write: false,
		path: "/system",
		verb: "identity",
	},
	{
		input: "/ip/address",
		mode: "structured",
		write: false,
		path: "/ip",
		verb: "address",
	},
	{
		input: "/ip/firewall/filter",
		mode: "structured",
		write: false,
		path: "/ip/firewall",
		verb: "filter",
	},
	// …but a bare no-argument WRITE command is not navigation and stays gated,
	// as does anything the menu table does not carry (fail closed).
	{
		input: "/system/reboot",
		mode: "structured",
		write: true,
		path: "/system",
		verb: "reboot",
	},
	{
		input: "/system/reset-configuration",
		mode: "structured",
		write: true,
		path: "/system",
		verb: "reset-configuration",
	},
	{
		input: "/no/such/menu",
		mode: "structured",
		write: true,
		path: "/no/such",
		verb: "menu",
	},
	// The carve-out is bare-only: attributes or queries keep the gate closed.
	{
		input: "/system/identity name=x",
		mode: "structured",
		write: true,
		path: "/system",
		verb: "identity",
	},
	{
		input: "/system/identity ?name",
		mode: "structured",
		write: true,
		path: "/system",
		verb: "identity",
	},
	// `;` is not a tokenizer delimiter, so a second statement smuggled into the
	// path token must not read as a menu.
	{
		input: "/system/identity;/system/reboot",
		mode: "structured",
		write: true,
		path: "/system/identity;/system",
		verb: "reboot",
	},
	{
		input: "/system/identity;",
		mode: "structured",
		write: true,
		path: "/system",
		verb: "identity;",
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

	test("a subshell selector stays script-mode but remains write-shaped", () => {
		// Regression guard for the dangerous parse: this previously became a
		// structured write with attributes `{ numbers: "[find", interface: ... }`.
		const command = canonicalizeExecuteCommand(
			"/ip/address/set numbers=[find default=yes] disabled=yes",
		);
		expect(command.mode).toBe("script");
		expect(isWriteShaped(command)).toBe(true);
		expect(command.attributes).toEqual({});
	});
});
