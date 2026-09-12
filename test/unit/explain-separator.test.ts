import { describe, expect, test } from "bun:test";
import { explainCommand } from "../../src/explain.ts";

const CODE = "explain/canonicalizer/missing-statement-separator";

function flags(input: string) {
	return explainCommand(input, {}).diagnostics.filter((d) => d.code === CODE);
}

/**
 * Every input below carries a CHR 7.24.2 verdict in its label, taken with
 * `:parse` and `/console/inspect request=highlight` (see #311). Three device
 * outcomes matter and they are not the same thing:
 *
 * - **clean** — `:parse` returns IL with no complaint. The rule must never fire.
 * - **bad parameter** — `:parse` returns IL carrying `bad parameter <token>`;
 *   the device rejected that operand and dropped it.
 * - **hard** — `:parse` returns `expected end of command (line…)` and nothing
 *   else, and `highlight` marks an `error` byte.
 *
 * `bad parameter` and `hard` both mean the input is wrong; which one the device
 * picks depends on whether the following words abbreviate an argument name of
 * the HEAD menu, which is schema and not knowable offline. So the rule is
 * grounded on "the device never accepts this shape", never on which wording it
 * answers with.
 */
describe("explain/separator — the second command-shaped run (#311)", () => {
	describe("fires: a known menu path then a console verb", () => {
		test("the #311 reproduction — hard reject, error at the `=` of gateway", () => {
			const input =
				"/ip/address add interface=ether1 /ip/route add gateway=192.168.88.1";
			const result = explainCommand(input, {});
			expect(result.verdict).toBe("fail");
			const [flag, ...rest] = result.diagnostics.filter((d) => d.code === CODE);
			expect(rest).toEqual([]);
			expect(flag?.severity).toBe("error");
			// The whole second run: `/ip/route add`.
			expect(flag?.span).toEqual({ start: 33, end: 46 });
			expect(input.slice(33, 46)).toBe("/ip/route add");
			expect(flag?.message).toContain("insert `;` or a newline");
			expect(flag?.message).toContain("/ip/route");
		});

		test("the space-spelled second path — hard reject, same error byte", () => {
			// `/ip route add` is the same menu path written with a space (Q3 R4).
			const input =
				"/ip/address add interface=ether1 /ip route add gateway=1.2.3.4";
			const [flag] = flags(input);
			expect(flag?.span).toEqual({ start: 33, end: 46 });
			expect(input.slice(33, 46)).toBe("/ip route add");
		});

		test("no attribute after the run — hard reject", () => {
			// The device rejects this too, so the rule must not require a trailing
			// attribute. #311's report named one because its example had one.
			expect(
				flags("/ip/address add interface=ether1 /ip/route add"),
			).toHaveLength(1);
		});

		test("a menu segment that starts with a digit is reachable", () => {
			// `/interface/6to4` is the shipped table's only such name; a leading-letter
			// shape filter made both its spellings miss the rule entirely.
			expect(
				flags("/ip/address add interface=ether1 /interface/6to4 add name=t1"),
			).toHaveLength(1);
			expect(
				flags("/ip/address add interface=ether1 /interface 6to4 add name=t1"),
			).toHaveLength(1);
		});

		test("a read verb closes the run as well as a write verb — bad parameter", () => {
			expect(
				flags("/ip/address add interface=ether1 /ip/route print"),
			).toHaveLength(1);
			expect(
				flags("/system/note set note=hello /ip/route remove numbers=0"),
			).toHaveLength(1);
		});

		test("a head whose arguments abbreviate nothing — bad parameter, not hard", () => {
			// `/ip/address add` hard-rejects only because `add` abbreviates its own
			// `address=`. With a head that has no such argument the device answers
			// `bad parameter /ip/route` instead, and the rule must still fire.
			const [flag] = flags(
				"/system/note set note=hello /ip/route add gateway=1.2.3.4",
			);
			expect(flag?.span).toEqual({ start: 28, end: 41 });
			expect(
				flags("/ip/route add gateway=1.1.1.1 /ip/dns set servers=8.8.8.8"),
			).toHaveLength(1);
		});

		test("three commands run together report both seams", () => {
			expect(
				flags(
					"/system/note set note=a /ip/route add gateway=1.2.3.4 /ip/dns set servers=8.8.8.8",
				),
			).toHaveLength(2);
		});
	});

	describe("fires on a head whose value slot absorbs the path", () => {
		// The device still refuses, but it names the VERB, because the path lands
		// in the directive's own value slot: `:put /ip/route print` lowers to
		// `/putmessage=/ip/route` plus `bad parameter print` (CHR 7.24.2). The rule
		// fires — the shape is never accepted — and the message is worded to claim
		// only that, never which byte the device will pick.
		test.each([
			[":put /ip/route print", "bad parameter print"],
			[":local a /ip/route add", "bad parameter add"],
			[":log info /ip/route print", "bad parameter print"],
			["/import file-name=x.rsc /ip/route add", "bad parameter /ip/route"],
		])("%s fires (device: %s)", (input) => {
			expect(flags(input)).toHaveLength(1);
		});

		test("the message claims a reading, not a device byte", () => {
			const [flag] = flags(":put /ip/route print");
			expect(flag?.message).toContain("reads as a second command");
			expect(flag?.message).not.toContain("bad parameter print");
		});
	});

	describe("abstains: shapes the device treats differently", () => {
		test.each([
			// A menu path with no verb after it — `bad parameter`, but so is any
			// operand a menu does not accept; deciding it needs per-menu positional
			// schema and a separator is not necessarily the fix.
			["a menu path alone", "/ip/address add interface=ether1 /ip/route"],
			[
				"a menu path then a non-verb word",
				"/ip/address add interface=ether1 /ip/route placeholder",
			],
			// Not a path at all. Hard-rejected by the device, but for the head's own
			// argument-abbreviation reasons, not a missing separator.
			[
				"a bare word then a verb",
				"/ip/address add interface=ether1 placeholder add x=1",
			],
			[
				"a path absent from the structure table",
				"/ip/address add interface=ether1 /flash/skins add x=1",
			],
		])("%s", (_name, input) => {
			expect(flags(input)).toEqual([]);
		});
	});

	describe("the reach the tolerant token stream buys (#316)", () => {
		// This was the pinned reach LIMIT until #316: the strict lexer aborted its
		// whole walk at the first token it declined, so a statement holding a
		// variable carried no tokens for the rule to read. The rule now reads
		// `lexArgumentTokens`, which publishes the undecodable token located and
		// keeps walking, so the run is found wherever it sits relative to it.
		test.each([
			["after the undecodable token", "gateway=$g", "interface=ether1"],
			// Design A (prefix only) reaches the row above and NOT this one: the
			// prefix is empty here, which is why the fork mattered.
			["before it", "gateway=1.1.1.1", "interface=$x"],
		])("a variable %s still finds the run", (_label, tail, head) => {
			const input = `/ip/address add ${head} /ip/route add ${tail}`;
			const [only] = explainCommand(input, {}).structure.statements;
			// The STRICT reading still refuses — the tolerant stream is a second
			// reading for rules, never a relaxation of what may be rendered.
			expect(only?.arguments?.read).toBe(false);
			expect(flags(input)).toHaveLength(1);
		});

		test("the literal twin is unchanged", () => {
			expect(
				flags("/ip/address add interface=ether1 /ip/route add gateway=1.1.1.1"),
			).toHaveLength(1);
		});

		// Still out of reach, and still not a judgement: an unterminated string has
		// no knowable end, so neither walk can resume past it.
		test("an unterminated string stops both walks", () => {
			expect(
				flags('/ip/address add comment="oops /ip/route add gateway=1.1.1.1'),
			).toHaveLength(0);
		});
	});

	describe("controls: input the device accepts cleanly", () => {
		test.each([
			// A slash-shaped operand IS legal after a verb — it lowers to `numbers=`.
			["a post-verb file path", "/file remove /flash/skins/foo.html"],
			["a single positional", "/file remove a"],
			[
				"a CIDR slash in a value",
				"/ip/route add dst-address=0.0.0.0/0 gateway=1.2.3.4",
			],
			[
				"a URL slash in a value",
				"/tool/fetch url=https://example.com/a/b mode=https",
			],
			[
				"a quoted second run",
				'/ip/address add interface=ether1 comment="/ip/route add gateway=1.2.3.4"',
			],
			[
				"a second run inside a command substitution",
				"/ip/address add interface=ether1 comment=[/ip/route add gateway=1.2.3.4]",
			],
			[
				"a second run inside a scope block",
				":foreach i in={1;2} do={/ip/route add gateway=192.168.88.1}",
			],
			["two bare print flags", "/ip/route print detail terse"],
			["a two-operand menu action", "/interface/ethernet/monitor 0 once"],
			// A menu path IS a legal operand with no verb after it — the device
			// lowers this to `number=/ip/route`. This is why the condition is
			// "path THEN verb" and not "a menu path in operand position".
			["a bracketed second run", ":put [/ip/route print]"],
		])("%s stays clean", (_name, input) => {
			const result = explainCommand(input, {});
			expect(result.diagnostics.filter((d) => d.code === CODE)).toEqual([]);
			expect(result.verdict).toBe("pass");
		});
	});

	describe("the corrected forms", () => {
		test.each([
			[
				";",
				"/ip/address add interface=ether1; /ip/route add gateway=192.168.88.1",
			],
			[
				"a newline",
				"/ip/address add interface=ether1\n/ip/route add gateway=192.168.88.1",
			],
		])(
			"a separator spelled with %s resolves two statements",
			(_name, input) => {
				const result = explainCommand(input, {});
				expect(result.verdict).toBe("pass");
				expect(result.diagnostics).toEqual([]);
				expect(result.structure.statementCount).toBe(2);
				expect(result.structure.statements.map((s) => s.command?.path)).toEqual(
					["/ip/address", "/ip/route"],
				);
			},
		);
	});

	describe("the reading the run contradicts is withdrawn", () => {
		const input =
			"/ip/address add interface=ether1 /ip/route add gateway=192.168.88.1";

		test("the source stays ONE statement — no fabricated second command", () => {
			const result = explainCommand(input, {});
			expect(result.structure.statementCount).toBe(1);
			const [only] = result.structure.statements;
			expect(only?.resolution).toBe("resolved");
			expect(only?.command).toMatchObject({ path: "/ip/address", verb: "add" });
		});

		test("`gateway` is no longer an attribute of `/ip/address add`", () => {
			const [only] = explainCommand(input, {}).structure.statements;
			// `args` is present exactly when the argument list read, so asserting
			// the whole reading is the same claim as `args === undefined`.
			expect(only?.command).toEqual({ path: "/ip/address", verb: "add" });
			expect(only?.arguments?.read).toBe(false);
			expect(
				only?.arguments?.read === false ? only.arguments.why : "",
			).toContain("second command-shaped run");
		});

		test("no runnable invocation is offered for bytes the result rejects", () => {
			// Without the refusal this falls through to `execute`, which renders a
			// ready-to-paste `centrs execute` line for a syntax error.
			const [only] = explainCommand(input, {}).structure.statements;
			expect(only?.transport?.classification).toBe("unknown");
			expect(JSON.stringify(only?.transport)).not.toContain("centrs execute");
		});

		test("no value fact is published for the withdrawn run", () => {
			// `data.values` is its own axis, not a projection of `arguments`, so the
			// withdrawal above does not reach it — this cut does. The device draws
			// the line in the same place: `:parse` reads `gateway` as the VALUE of
			// `/ip/address/add`'s `address=`, never as an attribute NAME, while the
			// head's own `interface=ether1` survives into the IL.
			const result = explainCommand(input, {});
			expect(result.values.occurrences.map((o) => [o.name, o.kind])).toEqual([
				["interface", "attribute"],
			]);
			expect(JSON.stringify(result.values)).not.toContain("gateway");
		});

		test("the withdrawn run claims no token class either", () => {
			// The value fill reads the same occurrences, so a cut value must not come
			// back as a `value` token for bytes the result calls a syntax error.
			const { tokens = [] } = explainCommand(input, { tokens: true });
			const classes = tokens.filter((t) => t.end > 33).map((t) => t.class);
			expect(new Set(classes)).toEqual(new Set(["unclassified"]));
		});

		test("a head value BEFORE the run keeps its shape hint", () => {
			// Not "every value in a degraded statement": the cut is the run's first
			// byte, and `note=hello` is device-read: `:parse` on that row returns
			// `(evl bad parameter /ip/route (line 1 column 38) /system/note/setnote=hello)`
			// on CHR 7.24.2 — the IL keeps the head's attribute and drops the run.
			const result = explainCommand(
				"/system/note set note=hello /ip/route add gateway=1.2.3.4",
				{},
			);
			expect(
				result.values.occurrences.map((o) => [
					o.name,
					o.facts.shapeHints?.values,
				]),
			).toEqual([["note", ["str"]]]);
		});

		test("the corrected form keeps its argument reading", () => {
			const result = explainCommand(
				"/ip/address add interface=ether1; /ip/route add gateway=192.168.88.1",
				{},
			);
			expect(result.structure.statements.map((s) => s.command)).toEqual([
				{ path: "/ip/address", verb: "add", args: { interface: "ether1" } },
				{ path: "/ip/route", verb: "add", args: { gateway: "192.168.88.1" } },
			]);
		});
	});
});
