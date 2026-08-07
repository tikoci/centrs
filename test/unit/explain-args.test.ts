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
 *      decided, 0 contradictions — which holds BECAUSE of a fail-closed rule,
 *      not by accident. The single-quote anchors below are a case that
 *      contradicted until review found it, and that the corpus cannot reach.
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
 *
 * Those numbers did not move when review found three defects (the lone `\r`
 * continuation, the unquoted escape, and the single-quote gate disagreement,
 * all pinned below): no corpus line spells any of the shapes. That is the
 * standing lesson — corpus-green is a size estimate for a risk, never evidence
 * that a lexical rule is right.
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

describe("the two silent misreads review found (#202c-1)", () => {
	test("a lone `\\r` after a backslash is not a continuation", () => {
		// It was, and the skip then advanced three bytes and ate the following
		// character: the argument below (source name `x` + `comment`) lexed as
		// plain `comment=2`, a reported name that is not the one in the source. A
		// silent misread, not a refusal — the one failure this module must not
		// have. `verbsplit.ts`'s word scanner requires `\r\n`; the two scanners
		// now share the rule. (Spelled as a concatenation so the corrupted token
		// is not a word in this file.)
		const read = lex(`/ip/address add a=1 \\\r${"x"}comment=2`, 15);
		expect(read.read).toBe(false);
		expect(read.read === false ? read.why : "").toContain("invalid escape");
	});

	test("an UNQUOTED escape has no literal value either", () => {
		// `comment=a\ b` is the value `a b` on the device. Returning the source run
		// would send the backslash — a wrong value, where the quoted spelling was
		// already refused. The token is decided; only its value is not.
		const read = lex("/ip/address add comment=a\\ b", 15);
		expect(read.read).toBe(false);
		expect(read.read === false ? read.why : "").toContain(
			"escape in an argument value",
		);
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

	test("a single quote in an unquoted value fails closed — with a space", () => {
		// The P1 from review. RouterOS does not use `'` as a string delimiter, but
		// `canonicalizeExecuteCommand`'s tokenizer does, and that gate is locked.
		// This spelling was `{comment: "lan uplink"}` to the gate and
		// `{comment: "'lan"}` + positional `uplink'` here — two confident answers
		// to one question, in one result. The device-correct reading is this
		// module's; refusing is about not publishing the second value, not about
		// conceding the first.
		const data = explainCommand("/ip/address/add comment='lan uplink'");
		expect(data.canonical.args).toEqual({ comment: "lan uplink" });
		const statement = data.structure.statements[0];
		if (statement?.kind !== "command") throw new Error("expected a command");
		expect(statement.arguments?.read).toBe(false);
		expect(statement.command.args).toBeUndefined();
	});

	test("a single quote in an unquoted value fails closed — without a space", () => {
		// The no-space form contradicted too (`x` vs `'x'`), so it gets its own
		// anchor: a fix that only handled the token-splitting case would pass the
		// spaced test and still emit a second value here.
		const data = explainCommand("/ip/address/add comment='x'");
		expect(data.canonical.args).toEqual({ comment: "x" });
		const statement = data.structure.statements[0];
		if (statement?.kind !== "command") throw new Error("expected a command");
		expect(statement.arguments?.read).toBe(false);
		expect(statement.command.args).toBeUndefined();
	});

	test("a single quote INSIDE a double-quoted value is not a disagreement", () => {
		// The gate treats `'` as content inside a `"…"` run, exactly as this lexer
		// does, so there is nothing to fail closed on. Pinned so the refusal above
		// cannot widen into over-abstention.
		const data = explainCommand('/ip/address/add comment="it\'s fine"');
		const statement = data.structure.statements[0];
		if (statement?.kind !== "command" || statement.arguments?.read !== true)
			throw new Error("expected a command with a reading");
		expect(statement.command.args).toEqual(data.canonical.args);
		expect(statement.command.args).toEqual({ comment: "it's fine" });
	});

	test.each([
		["form feed", "\f"],
		["vertical tab", "\v"],
	])("a %s in an unquoted value fails closed", (_name: string, char: string) => {
		// The gate splits tokens on JavaScript `\s`, which includes these two;
		// every explain module splits on ASCII whitespace, which does not. So
		// `comment=x<FF>disabled=no` was two arguments to the gate and one value
		// here. Adopting `\s` in the lexer was the other option and would have
		// put this scanner at odds with `verbsplit.ts` and `segment.ts` about
		// where a token ends — the failure `continuationLength` exists to
		// prevent.
		const data = explainCommand(`/ip/address/add comment=x${char}disabled=no`);
		expect(data.canonical.args).toEqual({ comment: "x", disabled: "no" });
		const statement = data.structure.statements[0];
		if (statement?.kind !== "command") throw new Error("expected a command");
		expect(statement.arguments?.read).toBe(false);
		expect(statement.command.args).toBeUndefined();
	});

	test("no character JavaScript `\\s` splits on can produce a contradiction", () => {
		// The class, not the two reported instances. Every character the gate
		// treats as a token boundary and ASCII whitespace does not must end in
		// EITHER agreement or a refusal — never a second confident value. The
		// non-ASCII ones are caught upstream, by the addressability check: they
		// cannot survive `coordinates.ts` normalization as themselves.
		const splitters = [
			"\f",
			"\v",
			"\u00a0",
			"\u1680",
			"\u2000",
			"\u2028",
			"\u2029",
			"\u202f",
			"\u205f",
			"\u3000",
			"\ufeff",
		];
		for (const char of splitters) {
			const data = explainCommand(
				`/ip/address/add comment=x${char}disabled=no`,
			);
			const statement = data.structure.statements[0];
			if (statement?.kind !== "command" || statement.arguments?.read !== true)
				continue; // refused — fail-closed, which is the acceptable outcome
			expect(statement.command.args).toEqual(data.canonical.args);
		}
	});

	test("a divergent `?query` word fails the whole list closed", () => {
		// The guard was written at the VALUE level, and a query has no value — so
		// the one token kind with its own early return bypassed both earlier
		// fixes. `?comment='lan uplink'` stayed `read: true` with query
		// `?comment='lan` plus positional `uplink'` against the gate's single
		// `?comment=lan uplink`.
		for (const input of [
			"/ip/address/print ?comment='lan uplink'",
			"/ip/address/print ?type=ether\f?disabled=true",
			"/ip/address/print ?type=ether\v?disabled=true",
			'/ip/address/print ?comment="lan uplink"',
			"/ip/address/print ?comment=a\\ b",
		]) {
			const statement = explainCommand(input).structure.statements[0];
			if (statement?.kind !== "command")
				throw new Error(`expected a command for ${input}`);
			expect(statement.arguments?.read).toBe(false);
		}
	});

	test("`arguments.queries` equals `canonical.queries` wherever both decide", () => {
		// The reason the two are comparable at all: what survives the query guard
		// is exactly the shape on which the gate's tokenizer is the identity — no
		// quote to strip, no escape to decode, no byte it splits on that ASCII
		// whitespace does not. Anchored rather than assumed.
		for (const input of [
			"/ip/address/print ?type=ether ?disabled",
			"/ip/address/print ?#|",
			"/ip/address/print ?>0 ?type=ether",
			"/ip/address/print",
		]) {
			const data = explainCommand(input);
			const statement = data.structure.statements[0];
			if (statement?.kind !== "command" || statement.arguments?.read !== true)
				throw new Error(`expected a reading for ${input}`);
			expect(statement.arguments.queries).toEqual(data.canonical.queries);
		}
	});

	test.each([
		["an attribute value", "/ip/address/add comment=x;", "comment"],
		["a query word", "/ip/address/print ?type=ether;", "?type=ether"],
	])("a trailing `;` cannot leave two readings of %s", (_name: string, input: string) => {
		// The delimiter no character guard in `args.ts` can see: the gate reads
		// the RAW input and keeps `;` (the value `x;`), the segmenter strips it
		// as the statement terminator (`x`), so by the time the lexer runs it is
		// gone. Enforced at the composition boundary instead — and the ANALYSIS
		// is the device-correct reader here, since `;` ends a statement in
		// RouterOS rather than belonging to a value.
		const data = explainCommand(input);
		expect(data.canonical.mode).toBe("structured");
		const statement = data.structure.statements[0];
		if (statement?.kind !== "command") throw new Error("expected a command");
		expect(statement.arguments?.read).toBe(false);
		expect(statement.command.args).toBeUndefined();
	});

	test("no printable ASCII character leaves two decided views of one input", () => {
		// The CLASS, swept rather than sampled. Three character guards were each
		// written from a reported instance; this is what says none is left. 675
		// cases where both readers decide, 0 mismatches — re-run it after any
		// change to the lexer, the segmenter, or the gate.
		const templates = [
			(c: string) => `/ip/address/add comment=x${c}`,
			(c: string) => `/ip/address/add comment=x${c}y`,
			(c: string) => `/ip/address/add comment=${c}x`,
			(c: string) => `/ip/address/add comment=x${c} disabled=no`,
			(c: string) => `/ip/address/print ?type=ether${c}`,
			(c: string) => `/ip/address/print ?type=ether${c}?disabled=true`,
			(c: string) => `/ip/address/add ${c}comment=x`,
			(c: string) => `/ip/address/add comment="x${c}y"`,
		];
		const chars: string[] = ["\t", "\n", "\r", "\f", "\v", "\0"];
		for (let code = 0x20; code <= 0x7e; code++)
			chars.push(String.fromCharCode(code));
		let bothDecided = 0;
		for (const char of chars)
			for (const template of templates) {
				const input = template(char);
				const data = explainCommand(input);
				if (data.canonical.mode !== "structured") continue;
				if (data.structure.statements.length !== 1) continue;
				const only = data.structure.statements[0];
				if (only?.kind !== "command" || only.arguments?.read !== true) continue;
				bothDecided++;
				expect({
					args: only.command.args ?? {},
					queries: only.arguments.queries,
					input,
				}).toEqual({
					args: data.canonical.args,
					queries: data.canonical.queries,
					input,
				});
			}
		// Guard the guard: if a future change made every case abstain, the loop
		// above would pass vacuously.
		expect(bothDecided).toBeGreaterThan(500);
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
