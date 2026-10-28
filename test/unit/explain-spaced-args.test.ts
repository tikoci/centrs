import { describe, expect, test } from "bun:test";
import { maskComments, segmentStatements } from "../../src/explain/segment.ts";
import { explainCommand } from "../../src/explain.ts";
import { assertOfflineSyntax } from "../../src/offline-gate.ts";

const CODE = "explain/canonicalizer/possible-spaced-argument";

function warnings(input: string) {
	return explainCommand(input, {}).diagnostics.filter((d) => d.code === CODE);
}

function onlyCommand(input: string) {
	const statements = explainCommand(input, {}).structure.statements;
	expect(statements).toHaveLength(1);
	return statements[0];
}

/**
 * Every device claim below was taken on CHR 7.22.1 and 7.24.5 with `:parse` and
 * `/console/inspect request=highlight` (#350); the integration twin is
 * `test/integration/explain-spaced-args.test.ts`. Two device facts drive it:
 * the spaced form lowers to the IL of the `=` form, and `highlight` marks the
 * gap `syntax-obsolete` exactly where the words paired, never between two flags.
 */
describe("explain/spaced-args — the space-for-`=` spelling (#350)", () => {
	describe("abstains: adjacent operands may be an argument and its value", () => {
		test("the #350 reproduction no longer reads as an empty argument list", () => {
			const statement = onlyCommand(
				'/ip/firewall/layer7-protocol add comment "something" regexp 1.1',
			);
			expect(statement?.resolution).toBe("resolved");
			// `args` is present exactly when the list read, so this is both claims.
			expect(statement?.command).toEqual({
				path: "/ip/firewall/layer7-protocol",
				verb: "add",
			});
			expect(statement?.arguments?.read).toBe(false);
			if (statement?.arguments?.read !== false) throw new Error("unreachable");
			expect(statement.arguments.why).toContain('`comment "something"`');
			// The fail-closed transport is kept, not traded for a reading.
			expect(statement?.transport?.classification).toBe("unknown");
			expect(statement?.transport?.basis).toBe(statement.arguments.why);
		});

		test("two bare words abstain too, because flags look the same", () => {
			// `name x` pairs on device (`setname=x;numbers=ether1`), but
			// `detail without-paging` is two flags (`printdetail=true;
			// without-paging=true`). Offline cannot tell them apart.
			for (const input of [
				"/interface set ether1 name x",
				"/interface set ether1 disabled yes",
				"/interface print detail without-paging",
				"/system/script add zzznotanarg beep",
			]) {
				expect({
					input,
					read: onlyCommand(input)?.arguments?.read,
				}).toEqual({ input, read: false });
			}
		});
	});

	test("the name shape is the lexer's own, dotted and underscored too", () => {
		// `ARGUMENT_NAME` reads `.proplist=` and `my_x=` as names, so their spaced
		// spellings abstain as well. Neither is accepted on CHR 7.24.5
		// (`bad parameter .proplist`, and `my_thing` lands in `numbers=`), but
		// `read: true` with `args: {}` is false for them all the same.
		for (const input of [
			"/interface print .proplist name",
			"/interface set my_thing x",
		]) {
			expect({ input, read: onlyCommand(input)?.arguments?.read }).toEqual({
				input,
				read: false,
			});
		}
	});

	describe("warns: the second operand cannot be a flag", () => {
		test("one warning per value-shaped pair, spanning name through value", () => {
			const input =
				'/ip/firewall/layer7-protocol add comment "something" regexp 1.1';
			const found = warnings(input);
			expect(found.map((d) => input.slice(d.span.start, d.span.end))).toEqual([
				'comment "something"',
				"regexp 1.1",
			]);
			expect(found.every((d) => d.severity === "warning")).toBeTrue();
			expect(found[0]?.message).toContain("possible obsolete spelling");
			expect(found[0]?.message).toContain('write `comment="something"`');
			// A warning, not an error: RouterOS accepts the form.
			expect(explainCommand(input, {}).verdict).toBe("warn");
		});

		test("pairs overlap, so an unnamed operand before the name does not hide it", () => {
			// `ether1 comment` only abstains; `comment "x"` warns.
			const input = '/interface set ether1 comment "x"';
			expect(
				warnings(input).map((d) => input.slice(d.span.start, d.span.end)),
			).toEqual(['comment "x"']);
			const policy = '/user group set full policy "read,write"';
			expect(
				warnings(policy).map((d) => policy.slice(d.span.start, d.span.end)),
			).toEqual(['policy "read,write"']);
		});

		test("a bare-word value does not warn, even where the device would", () => {
			for (const input of [
				"/interface set ether1 name x",
				"/interface set ether1 disabled yes",
				"/interface print detail without-paging",
				"/interface print without-paging detail",
			]) {
				expect({ input, warnings: warnings(input) }).toEqual({
					input,
					warnings: [],
				});
			}
		});

		test("a substitution elsewhere still warns, though the list was never read", () => {
			const input = '/ip/address set [find] comment "x"';
			const [statement] = explainCommand(input, {}).structure.statements;
			expect(statement?.arguments).toEqual({
				read: false,
				why: "a substitution or expression value",
			});
			// The lexer's own refusal keeps the `execute` line it already had.
			expect(statement?.transport?.classification).toBe("execute");
			expect(warnings(input)).toHaveLength(1);
		});
	});

	describe("leaves alone", () => {
		test("the `=` spellings keep their readings", () => {
			expect(
				onlyCommand(
					'/ip/firewall/layer7-protocol add comment="something" regexp=1.1',
				)?.command,
			).toEqual({
				path: "/ip/firewall/layer7-protocol",
				verb: "add",
				args: { comment: "something", regexp: "1.1" },
			});
			expect(
				onlyCommand("/interface set ether1 disabled=yes")?.command,
			).toEqual({
				path: "/interface",
				verb: "set",
				args: { disabled: "yes" },
			});
		});

		test("a single operand, and an operand before an attribute", () => {
			for (const input of [
				"/ip/address remove 0",
				"/ip/address print as-value",
				"/interface ethernet print stats",
				"/interface set ether1 disabled=yes",
				"/ip/firewall/filter move 5 0",
			]) {
				expect({ input, read: onlyCommand(input)?.arguments?.read }).toEqual({
					input,
					read: true,
				});
			}
		});

		test("`where` ends the scan and is never a value", () => {
			// `print count-only where …` lowers to `count-only=true;where=…`.
			for (const input of [
				"/ip/address print where interface=ether1",
				"/ip/route print count-only where dst-address=0.0.0.0/0",
				"/ip/address print where disabled",
			]) {
				expect({ input, read: onlyCommand(input)?.arguments?.read }).toEqual({
					input,
					read: true,
				});
			}
		});

		test("root directives, whose operands are positional by grammar", () => {
			// `:pick abc 0 1` lowers to `pickbegin=0;counter=abc;end=1`, and
			// `:local t 200ms` to `localname=t;value=200ms`.
			for (const input of [
				":pick abc 0 1",
				":local t 200ms",
				':set quiet "yes"',
				// Spaced on device (`count` is `syntax-obsolete`), but telling a root
				// command's positional grammar from a spaced argument is schema.
				"/ping 1.1.1.1 count 3",
			]) {
				expect({
					input,
					read: onlyCommand(input)?.arguments?.read,
					warnings: warnings(input),
				}).toEqual({ input, read: true, warnings: [] });
			}
		});
	});
});

describe("explain — a script body may drop its `=` before the brace (#350)", () => {
	const braceErrors = (input: string) =>
		explainCommand(input, {}).diagnostics.filter((d) =>
			d.code.endsWith("/invalid-command-brace"),
		);

	test("the bare body is the `source=` body, not an invalid brace", () => {
		// Each lowers to the IL of its `=` spelling on CHR 7.22.1 and 7.24.5.
		for (const input of [
			"/system/script add name=beep source { :beep }",
			"/system/scheduler add name=x on-event { :beep }",
			"/tool/netwatch add host=1.1.1.1 down-script { :beep }",
		]) {
			const result = explainCommand(input, {});
			expect({ input, braces: braceErrors(input) }).toEqual({
				input,
				braces: [],
			});
			// The gap is `syntax-obsolete` on device, as for any spaced pair.
			expect({ input, verdict: result.verdict }).toEqual({
				input,
				verdict: "warn",
			});
		}
	});

	test("every `…-script` argument takes a body, with or without the `=`", () => {
		// `up-script` and `lease-script` were outside the old `source|script|on-*`
		// shape and hard-failed. 7.22.1 rejects `lease-script={…}` while 7.24.5
		// accepts it, which is why this is only an exemption from the error.
		for (const input of [
			"/tool/netwatch add host=1.1.1.1 up-script={ :beep }",
			"/ip/dhcp-server set 0 lease-script={ :beep }",
		]) {
			expect({ input, verdict: explainCommand(input, {}).verdict }).toEqual({
				input,
				verdict: "pass",
			});
		}
	});

	test("an argument the command lacks is read as a body: the fail-open direction", () => {
		// `zzz-script={ :beep }` and `on-zzz={ :beep }` are a device `syntax error`
		// on CHR 7.24.5 (the integration twin pins it). Offline cannot name a
		// command's arguments, so it misses the rejection rather than risk a false
		// one on a real `up-script`. `on-zzz` already passed before #350.
		for (const input of [
			"/tool/netwatch add host=1.1.1.1 zzz-script={ :beep }",
			"/tool/netwatch add host=1.1.1.1 on-zzz={ :beep }",
		]) {
			expect({ input, braces: braceErrors(input) }).toEqual({
				input,
				braces: [],
			});
		}
	});

	test("a brace after any other argument is still an error", () => {
		// `comment { :beep }` is a `syntax error` on CHR 7.22.1 and 7.24.5: the
		// spaced pairing is unproven and the slot is not a script body.
		const input = "/system/scheduler add name=x comment { :beep }";
		expect({ input, braces: braceErrors(input).length }).toEqual({
			input,
			braces: 1,
		});
	});

	test("a script-like `name={` the slot cannot prove is a warning, not an error (#525)", () => {
		// `comment={ :beep }` is a `syntax error` on CHR 7.22.1 and 7.24.5, and
		// `down={ :beep }` lowers to `down-script=` there — the integration twin
		// pins both. Offline cannot tell them apart without the command's
		// argument list (schema), so since #525 it warns and lets the device
		// decide, instead of hard-rejecting the accepted spelling. Array-content
		// braces (`comment={1;2}`) keep their error; see `explain-values.test.ts`.
		// A body also opens with a bare command word (`down={ beep }`) or
		// after a comment line, both accepted on CHR 7.25 — and the `#` is a
		// comment there, not `invalid-hash`, because the brace reads as a body
		// for every reader. A bare word followed by `;`-separated members is
		// array members, not commands (`.proplist={name;comment}` is
		// device-rejected), so it keeps the error below.
		for (const input of [
			"/tool/netwatch add host=1.1.1.1 comment={ :beep }",
			"/tool/netwatch add host=1.1.1.1 down={ :beep }",
			"/tool/netwatch add host=1.1.1.1 down={ beep }",
			"/tool/netwatch add host=1.1.1.1 down={ # comment\n :beep }",
		]) {
			const result = explainCommand(input, {});
			const at = input.indexOf("{");
			expect({
				input,
				braces: braceErrors(input),
				hashes: result.diagnostics.filter((d) =>
					d.code.endsWith("/invalid-hash"),
				),
				warnings: result.diagnostics.filter((d) =>
					d.code.endsWith("/possible-script-body-abbreviation"),
				),
				verdict: result.verdict,
			}).toMatchObject({
				input,
				braces: [],
				hashes: [],
				warnings: [
					{
						severity: "warning",
						span: { start: at, end: at + 1 },
					},
				],
				verdict: "warn",
			});
			// A warning passes the offline gate; the device rejects `comment=`
			// and accepts `down=` at stage 2.
			expect(assertOfflineSyntax(input, { surface: "execute" }).verdict).toBe(
				"warn",
			);
		}
	});

	test("control scopes are proven bodies, not abbreviation guesses (#525)", () => {
		// `do={` on a monitor command and `command=` under `:retry` are in
		// the scope table (`scope-brace.ts`), so they stay silent — the
		// ambiguity warning is only for slots no table proves.
		for (const input of [
			"/log print follow do={ :put $message }",
			":retry delay=1s max=3 command={ :put 1 } on-error={ :put 2 }",
		]) {
			const result = explainCommand(input, {});
			expect({
				input,
				braces: braceErrors(input),
				ambiguous: result.diagnostics.filter((d) =>
					d.code.endsWith("/possible-script-body-abbreviation"),
				),
			}).toEqual({ input, braces: [], ambiguous: [] });
		}
	});

	test("a declared variable named like a script slot keeps its array", () => {
		// `highlight` classes the `#` in `:local source {#test}` `error` on CHR
		// 7.22.1 and 7.24.5, exactly as in #245's `:local z {#test}`: the brace is
		// an array, so the `#` is not a comment.
		const input = ":local source {#test}";
		expect(maskComments(input)).toBe(input);
		expect(segmentStatements(input).comments).toEqual([]);
		for (const array of [":local myscript {1;2}", ":local source {1;2}"]) {
			const occurrences = explainCommand(array, {}).values.occurrences;
			expect({
				array,
				members: occurrences.filter((o) => o.kind === "element").length,
			}).toEqual({ array, members: 2 });
		}
	});
});

describe("explain — a brace after a command is its operand, not a menu block (#496)", () => {
	const braceErrors = (input: string) =>
		explainCommand(input, {}).diagnostics.filter((d) =>
			d.code.endsWith("/invalid-command-brace"),
		).length;

	test("the all-bare body spelling is one statement, with no root `:beep`", () => {
		// Each lowers to the IL of its `=` spelling on CHR 7.22.1 and 7.24.5: one
		// `evl` whose `source=` carries the body. The lexical `/menu {` rule used
		// to open a container here and publish `:beep` as a sibling.
		for (const input of [
			"/system/script add name beep source { :beep }",
			"/system script add name beep source { :beep }",
			"/system/scheduler add name beep on-event { :beep }",
		]) {
			expect({
				input,
				segments: segmentStatements(input).segments.length,
				spans: explainCommand(input, {}).structure.statements.map(
					(s) => s.span,
				),
				braces: braceErrors(input),
				verdict: explainCommand(input, {}).verdict,
			}).toEqual({
				input,
				segments: 1,
				spans: [{ start: 0, end: input.length }],
				braces: 0,
				verdict: "warn",
			});
		}
	});

	test("an abbreviated script slot keeps its body, in either spelling", () => {
		// CHR 7.24.5 and 7.23.8 lower each to the full name's IL: `sour` and `s`
		// to `source=`, `down-scr`/`down-s` to `down-script=`, `on`/`o` to
		// `on-event=`. Before #496 the all-bare rows passed only because the brace
		// opened a menu block; the `=` rows were false rejects.
		for (const input of [
			"/system/script add name beep sour { :beep }",
			"/system/script add name=beep sour={ :beep }",
			"/system/script add name beep s { :beep }",
			"/tool/netwatch add host 1.1.1.1 down-scr { :beep }",
			"/tool/netwatch add host=1.1.1.1 down-s={ :beep }",
			"/system/scheduler add name x on { :beep }",
			"/system/scheduler add name=x o={ :beep }",
		]) {
			expect({
				input,
				statements: explainCommand(input, {}).structure.statements.length,
				braces: braceErrors(input),
				failed: explainCommand(input, {}).verdict === "fail",
			}).toEqual({ input, statements: 1, braces: 0, failed: false });
		}
	});

	test("a name that cannot abbreviate a script slot is still an error", () => {
		// `co` and `com` are rejected on CHR 7.24.5 (`expected end of command`,
		// `syntax error`), as is `comment`. The spaced pairing is unproven, so
		// the brace stays an error; the `=` spelling warns instead (#525).
		for (const input of [
			"/system/script add name beep co { :beep }",
			"/system/script add name beep com { :beep }",
		]) {
			expect({ input, braces: braceErrors(input) }).toEqual({
				input,
				braces: 1,
			});
		}
		// The shape must not widen to a declaration or to #245's `myScript`.
		expect(
			explainCommand(":local s {1;2}", {}).values.occurrences.filter(
				(o) => o.kind === "element",
			).length,
		).toBe(2);
		expect(explainCommand(":put myScript={#test}", {}).verdict).toBe("fail");
	});

	test("an accepted first-segment abbreviation reaches the device (#525)", () => {
		// `down={ :beep }` lowers to `down-script=` on CHR 7.24.5 and 7.23.8 —
		// the integration twin pins the IL — and the offline gate used to refuse
		// it with `invalid-command-brace` at [37,38). Every word is a prefix of
		// `<word>-script`, so the slot cannot be proven without schema; since
		// #525 the gate warns and lets the device decide.
		const input = "/tool/netwatch add host=1.1.1.1 down={ :beep }";
		const result = explainCommand(input, {});
		expect({
			statements: result.structure.statements.map((s) => s.span),
			braces: braceErrors(input),
			warnings: result.diagnostics.map((d) => ({
				code: d.code,
				span: d.span,
			})),
			verdict: result.verdict,
			runtimeAcceptance: result.runtimeAcceptance,
		}).toEqual({
			statements: [{ start: 0, end: input.length }],
			braces: 0,
			warnings: [
				{
					code: "explain/canonicalizer/possible-script-body-abbreviation",
					span: { start: 37, end: 38 },
				},
			],
			verdict: "warn",
			runtimeAcceptance: "not-proven",
		});
		expect(result.diagnostics[0]?.message).toContain("`down=`");
		expect(result.diagnostics[0]?.message).toContain(
			"device validation decides",
		);
		// The gate passes a warning through to the device stage; it threw before.
		expect(assertOfflineSyntax(input, { surface: "execute" }).verdict).toBe(
			"warn",
		);
	});

	test("a positional brace after a command is an error", () => {
		// `expected end of command` or `syntax error` on CHR 7.24.5 for every row.
		// The verb comes from the frozen vocabulary or, for `reboot` and `fetch`,
		// from the catalog's command axis.
		for (const input of [
			"/system/script add { :beep }",
			"/ip/route/print {1;2}",
			"/ip/route print { :beep }",
			"/system/reboot { :beep }",
			"/tool fetch { :beep }",
			"/system/script add name beep comment { :beep }",
		]) {
			expect({
				input,
				braces: braceErrors(input),
				verdict: explainCommand(input, {}).verdict,
			}).toEqual({ input, braces: 1, verdict: "fail" });
		}
	});

	test("a run that names no command still opens a menu block", () => {
		// `(evl (evl /system/script/print))` and its kin on CHR 7.24.5.
		for (const input of [
			"/system script { print }",
			"/ip firewall filter { print }",
			"/system { script { print } }",
			"/system { script add name beep source { :beep } }",
		]) {
			const result = explainCommand(input, {});
			expect({
				input,
				braces: braceErrors(input),
				failed: result.verdict === "fail",
			}).toEqual({ input, braces: 0, failed: false });
		}
		expect(
			explainCommand("/system script { print }", {}).structure.statements.map(
				(s) => s.command,
			),
		).toEqual([
			{ path: "/system/script" },
			{ path: "/system/script", verb: "print", args: {} },
		]);
	});
});
