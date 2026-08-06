/**
 * `src/explain/args.ts` — the statement-scope argument lexer (#202c).
 *
 * Four things are pinned here, in the order they matter:
 *
 *   1. **The token grammar**, directly on `lexArguments`.
 *   2. **The abstentions**, each with its reason. An abstention is the product
 *      here, not a gap: every one of these is a shape whose VALUE offline cannot
 *      know, and the alternative to refusing is rendering a `curl` that does
 *      something other than what the source says.
 *   3. **Composition**, through `explainCommand`: document-space spans, a
 *      `do={…}` body statement, and the span check that catches a statement
 *      whose bytes are not addressable.
 *   4. **Gate parity.** Where `canonicalizeExecuteCommand` reads the whole input
 *      as `structured` AND the analysis reads the same statement's arguments,
 *      the two argument objects must be IDENTICAL. The two surfaces are allowed
 *      to disagree about `path`/`verb`/`mode` (they answer different questions,
 *      and that is tested in `explain-envelope.test.ts`); they are not allowed
 *      to contradict each other about what the arguments ARE. Measured across
 *      the frozen corpus one statement at a time: 83 statements where both
 *      decided, 0 contradictions.
 *
 * The corpus lines below are real, taken from the frozen 913-script phase-0
 * corpus, so the fixtures exercise the shapes that actually occur (a
 * continuation inside an argument list, `where`, a dotted `.ssid=` name, and a
 * value that itself contains `=`) rather than shapes invented here.
 *
 * Measured on the corpus at the commit that added this file: of the CRUD-verb
 * commands the analysis reads, 40.0% have their arguments read and 60.0% abstain
 * — 97% of those abstentions being a non-literal value (`[…]`, `$x`, `{…}`). Of
 * the statements scored against the IL oracle, **0 dropped an argument IL saw**,
 * and the oracle-free coverage invariant below held over all 4,389 read
 * statements.
 */

import { describe, expect, test } from "bun:test";
import { lexArguments } from "../../src/explain/args.ts";
import { explainCommand } from "../../src/explain.ts";

/** Lex a whole statement's arguments from the first space, the common case. */
function lex(text: string, from: number) {
	return lexArguments(text, from);
}

describe("the token grammar", () => {
	test("an attribute carries its name, its value, and where each sits", () => {
		const text = "/ip/address add address=198.51.100.10/32";
		const read = lex(text, "/ip/address add".length);
		if (!read.read) throw new Error(`expected a reading, got ${read.why}`);
		expect(read.tokens).toEqual([
			{
				kind: "attribute",
				span: { start: 16, end: 40 },
				name: "address",
				value: "198.51.100.10/32",
				valueSpan: { start: 24, end: 40 },
				text: "address=198.51.100.10/32",
			},
		]);
		expect(read.args).toEqual({ address: "198.51.100.10/32" });
	});

	test("a quoted value loses its quotes but keeps its spaces", () => {
		const text = '/ip/address add comment="lan uplink"';
		const read = lex(text, "/ip/address add".length);
		if (!read.read) throw new Error(read.why);
		expect(read.args).toEqual({ comment: "lan uplink" });
		// The span covers the QUOTES; the value does not. A consumer highlighting
		// the value needs the source bytes, and one sending it needs the content.
		expect(text.slice(read.tokens[0]?.valueSpan?.start ?? 0)).toBe(
			'"lan uplink"',
		);
	});

	test("an empty value is a value, not an absence", () => {
		const read = lex("/ip/address set comment=", "/ip/address set".length);
		if (!read.read) throw new Error(read.why);
		expect(read.args).toEqual({ comment: "" });
	});

	test("a positional, a query and an attribute are three different things", () => {
		const text = "/ip/address set 0 comment=x ?disabled";
		const read = lex(text, "/ip/address set".length);
		if (!read.read) throw new Error(read.why);
		expect(read.tokens.map((t) => t.kind)).toEqual([
			"positional",
			"attribute",
			"query",
		]);
		expect(read.positional).toEqual(["0"]);
		expect(read.queries).toEqual(["?disabled"]);
		expect(read.args).toEqual({ comment: "x" });
	});

	test("a bare word the path run swallowed is still an argument", () => {
		// `runTokens` consumes every leading bare word, so `detail` is IN the run.
		// Ending the argument list at the run rather than at the VERB abstained on
		// 60% of the corpus's CRUD commands.
		const statement = explainCommand("/interface print detail").structure
			.statements[0];
		if (statement?.arguments?.read !== true)
			throw new Error("expected a reading");
		expect(statement.arguments.positional).toEqual(["detail"]);
	});

	test("the first unquoted `=` splits, so a value may itself contain `=`", () => {
		// Real corpus line: two arguments ran together in the source. RouterOS
		// splits on the first `=` and so does this; inventing a second argument
		// from the second `=` would be a guess about the writer's intent.
		const text = "/interface wifiwave2 add disabled=nomaster-interface=wifi1";
		const read = lex(text, "/interface wifiwave2 add".length);
		if (!read.read) throw new Error(read.why);
		expect(read.args).toEqual({ disabled: "nomaster-interface=wifi1" });
	});

	test("a dotted name is a name (`.ssid`, `.id`, `.proplist`)", () => {
		const read = lex("/interface add .ssid=NodeRED", "/interface add".length);
		if (!read.read) throw new Error(read.why);
		expect(read.args).toEqual({ ".ssid": "NodeRED" });
	});

	test("a repeated name keeps both tokens and resolves last-wins", () => {
		const text = "/ip/address set comment=first comment=second";
		const read = lex(text, "/ip/address set".length);
		if (!read.read) throw new Error(read.why);
		// Multiplicity survives in `tokens`; the object view collapses it the way
		// `canonicalizeExecuteCommand` does, so the gate and the analysis agree.
		expect(read.tokens).toHaveLength(2);
		expect(read.args).toEqual({ comment: "second" });
	});

	test("a continuation BETWEEN tokens is whitespace, not a refusal", () => {
		const text = '/ip/address add address=10.0.0.1 \\\n    comment="x"';
		const read = lex(text, "/ip/address add".length);
		if (!read.read) throw new Error(read.why);
		expect(read.args).toEqual({ address: "10.0.0.1", comment: "x" });
	});

	test("`value` absent means no literal value — for a positional too", () => {
		// The token is DECIDED (it is located and classified); only its value is
		// unknowable offline. A consumer rendering a runnable command reads
		// `value`, never `text`.
		const text = '/log info "result: $[:tostr $x]"';
		const read = lex(text, "/log info".length);
		if (!read.read) throw new Error(read.why);
		expect(read.tokens[0]?.kind).toBe("positional");
		expect(read.tokens[0]?.value).toBeUndefined();
		expect(read.tokens[0]?.text).toBe('"result: $[:tostr $x]"');
	});
});

describe("abstention is whole-statement, and says why", () => {
	const cases: [string, string, string][] = [
		[
			"a command substitution",
			"/ip/address remove numbers=[find comment=x]",
			"substitution or expression",
		],
		[
			"an expression",
			"/ip/address set ttl=(1 + 2)",
			"substitution or expression",
		],
		["a variable", "/ip/route add gateway=$GW", "variable value"],
		["an array literal", "/ip/address add list={a;b}", "array or block value"],
		[
			"a substitution inside a quoted value",
			'/system/identity set name="rtr-$id"',
			"substitution in a quoted argument value",
		],
		[
			"an escape inside a quoted value",
			'/ip/address add comment="a\\nb"',
			"escape in a quoted argument value",
		],
		[
			"a name that is not a name",
			"/ip/address add 1abc=x",
			"is not a RouterOS argument name",
		],
		[
			"a continuation inside a token",
			"/ip/address add comment=a\\\nb",
			"line continuation inside an argument",
		],
	];
	for (const [name, input, why] of cases)
		test(`${name} refuses the whole statement`, () => {
			const statement = explainCommand(input).structure.statements[0];
			if (statement?.kind !== "command")
				throw new Error(`expected a command, got ${statement?.resolution}`);
			expect(statement.arguments?.read).toBe(false);
			expect(
				statement.arguments?.read === false ? statement.arguments.why : "",
			).toContain(why);
			// …and nothing partial leaks into the object view.
			expect(statement.command.args).toBeUndefined();
		});
});

describe("a structural defect degrades the READING, before arguments matter", () => {
	test("an unterminated string leaves no command to carry arguments", () => {
		// The lexer has an `unterminated string in an argument` refusal, and it is
		// unreachable through the composition: `pathresolve.ts` already degrades a
		// statement carrying a structural defect to `unknown`, so there is no
		// command reading to attach an argument list to. Pinned because the
		// fail-closed floor being reached EARLIER than this module is the correct
		// order, and a future change that let such a statement resolve would make
		// the lexer the last line of defense instead of the second.
		const statement = explainCommand('/ip/address add comment="open').structure
			.statements[0];
		expect(statement?.resolution).toBe("unknown");
		expect(statement?.arguments).toBeUndefined();
	});
});

describe("through the composition", () => {
	test("spans are DOCUMENT offsets, so they index the input directly", () => {
		const input = '/ip/address add address=10.0.0.1 comment="x"';
		const statement = explainCommand(input).structure.statements[0];
		if (statement?.arguments?.read !== true)
			throw new Error("expected a reading");
		for (const token of statement.arguments.tokens)
			expect(input.slice(token.span.start, token.span.end)).toBe(token.text);
	});

	test("a `do={…}` body statement's spans rebase out of the body", () => {
		const input = ":foreach i in={1} do={ /ip/address print detail }";
		const statements = explainCommand(input).structure.statements;
		// The resolver flattens the body in after its parent, so the INNER command
		// is the second entry and its span is contained by the first.
		const inner = statements[1];
		if (inner?.arguments?.read !== true) throw new Error("expected a reading");
		const token = inner.arguments.tokens[0];
		expect(input.slice(token?.span.start, token?.span.end)).toBe("detail");
	});

	test("a statement whose bytes are not addressable abstains", () => {
		// Example 22's input. `🚀` is four analyzed bytes standing in for two
		// UTF-16 units, so the statement's original text and its analyzed span do
		// not line up — and lexing the wrong bytes would report confident
		// arguments for them. The span check catches it; the READING survives.
		const statement = explainCommand('/system identity set name="router-🚀"')
			.structure.statements[0];
		expect(statement?.resolution).toBe("resolved");
		expect(statement?.arguments?.read).toBe(false);
		expect(
			statement?.arguments?.read === false ? statement.arguments.why : "",
		).toContain("not addressable");
	});

	test("every non-whitespace byte of a read argument list is inside a token", () => {
		// The oracle-free invariant: a dropped token is exactly what this catches,
		// and it needs no IL. It held over all 4,389 read statements in the frozen
		// corpus; these are the shapes that made it interesting.
		const corpus = [
			'/ip firewall address-list add list=test-0001 address=10.0.0.1 comment="entry-0001"',
			'/console/inspect request=syntax input="put " path=ip',
			'/log print where topics~"script" time>5m',
			'/interface/lte/at-chat lte1 input="AT#CAINFO?"',
			'/system/ssh address=192.168.1.2 user=usr command="date +%s"',
			"/system script environment print detail where name=x",
			'/tool/fetch url="https://wttr.in/Riga+LV?T&format=2" output=user',
			'/ip/address add address=10.0.0.1 \\\n    comment="x" disabled=no',
			'/interface lte apn add apn=vzwinternet default-route-distance=11 name="Verizon" use-peer-dns=no',
		];
		for (const input of corpus) {
			const statement = explainCommand(input).structure.statements[0];
			if (statement?.arguments?.read !== true)
				throw new Error(
					`expected a reading for ${input}: ${statement?.arguments?.read === false ? statement.arguments.why : statement?.resolution}`,
				);
			const covered = new Set<number>();
			let previousEnd = -1;
			for (const token of statement.arguments.tokens) {
				expect(token.span.start).toBeGreaterThanOrEqual(previousEnd);
				expect(token.span.end).toBeGreaterThan(token.span.start);
				expect(token.span.end).toBeLessThanOrEqual(input.length);
				previousEnd = token.span.end;
				for (let b = token.span.start; b < token.span.end; b++) covered.add(b);
			}
			const first = statement.arguments.tokens[0]?.span.start ?? input.length;
			for (let b = first; b < input.length; b++) {
				const char = input[b] as string;
				if (/\s/.test(char)) continue;
				// A `\<newline>` is whitespace RouterOS removes before parsing, so the
				// backslash belongs to no token by design (H5).
				if (char === "\\" && /[\r\n]/.test(input[b + 1] ?? "")) continue;
				expect(covered.has(b)).toBe(true);
			}
		}
	});
});

describe("the gate and the analysis never contradict each other about arguments", () => {
	// Each of these is `structured` to `canonicalizeExecuteCommand` (the verb is
	// IN the path), so both surfaces read the same bytes and must agree.
	const inputs = [
		"/ip/route/add dst-address=10.9.0.0/16 gateway=192.0.2.1",
		'/ip/address/add address=198.51.100.10/32 comment="lan uplink"',
		"/ip/address/set comment=",
		"/interface/wifiwave2/add .ssid=NodeRED disabled=no",
		"/ip/address/set comment=first comment=second",
	];
	for (const input of inputs)
		test(input, () => {
			const data = explainCommand(input);
			expect(data.canonical.mode).toBe("structured");
			const statement = data.structure.statements[0];
			if (statement?.kind !== "command" || statement.arguments?.read !== true)
				throw new Error("expected a command with a reading");
			expect(statement.command.args).toEqual(data.canonical.args);
		});

	test("the analysis may abstain where the gate decided — but never differ", () => {
		// The gate strips quotes and escapes anywhere; this lexer refuses an
		// escape it cannot decode. Abstaining is a narrower claim than the gate's,
		// which is allowed. Reporting a DIFFERENT value would not be.
		const data = explainCommand('/ip/address/add comment="a\\nb"');
		expect(data.canonical.mode).toBe("structured");
		const statement = data.structure.statements[0];
		if (statement?.kind !== "command") throw new Error("expected a command");
		expect(statement.arguments?.read).toBe(false);
		expect(statement.command.args).toBeUndefined();
	});
});
