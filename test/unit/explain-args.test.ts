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
import {
	lexArguments,
	lexArgumentTokens,
	lexValueAnchors,
} from "../../src/explain/args.ts";
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

	test("a continuation comment is whitespace to both argument readers (#245)", () => {
		const text = "/ip/address add address=1.2.3.4 \\\n# a note\n comment=x";
		const from = "/ip/address add".length;
		const strict = lexArguments(text, from);
		if (!strict.read) throw new Error(strict.why);
		expect(strict.args).toEqual({ address: "1.2.3.4", comment: "x" });
		expect(strict.positional).toEqual([]);

		const anchors = lexValueAnchors(text, from);
		expect(anchors.complete).toBeTrue();
		expect(anchors.anchors.map((anchor) => anchor.value)).toEqual([
			"1.2.3.4",
			"x",
		]);
	});

	test("an unquoted hash inside a structured value is a grounded refusal", () => {
		for (const text of [
			":local z {#test}",
			":local z {1;#test}",
			":local z (1,#test)",
		]) {
			const strict = lexArguments(text, ":local".length);
			expect(strict.read).toBeFalse();
			// The strict REST reader refuses every structured positional before
			// inspecting its contents; the advisory anchor reader descends far enough
			// to preserve the more specific grounded reason.
			expect(strict.read ? "" : strict.why).toMatch(
				/array or block value|substitution or expression value/,
			);

			const anchors = lexValueAnchors(text, ":local".length, {
				directiveVerb: "local",
			});
			expect(anchors.complete).toBeFalse();
			expect(anchors.complete ? "" : anchors.why).toContain(
				"invalid hash in a structured argument value",
			);
		}
	});

	test("a real nested scope comment does not poison an enclosing array", () => {
		for (const text of [
			":local z {[:do { # c\n:put 1\n}]}",
			":local z {[:if (true) do={ # c\n:put 1\n}]}",
		]) {
			const anchors = lexValueAnchors(text, ":local".length, {
				directiveVerb: "local",
			});
			expect(anchors.complete).toBeTrue();
			expect(
				anchors.anchors.some((anchor) => anchor.sourceShape === "array"),
			).toBeTrue();
		}
	});

	/**
	 * The bracket RESTORES the statement role its enclosing array dropped, so the
	 * hash inside it is a value again — but only until a brace or paren inside
	 * that bracket drops the role a second time. Every row is the class CHR
	 * 7.23.3 `/console/inspect request=highlight` gives the `#` byte. A scan that
	 * skipped whole `[…]` regions instead would wrongly accept rows 3 and 4.
	 */
	test("a bracket inside an array restores the value role for a hash", () => {
		const readable = [
			":local z {[:put #test]}",
			":local z {1;[:put #test]}",
			":local z {[:len #test]}",
		];
		for (const text of readable) {
			const anchors = lexValueAnchors(text, ":local".length, {
				directiveVerb: "local",
			});
			expect(anchors.complete).toBeTrue();
			expect(
				anchors.anchors.some((anchor) => anchor.sourceShape === "array"),
			).toBeTrue();
		}

		// Dropping back into an array or a group inside that bracket is an error
		// again — the role is per-frame, not "anywhere under a bracket".
		for (const text of [
			":local z {[:put {#test}]}",
			":local z {[:put (1,#test)]}",
		]) {
			const anchors = lexValueAnchors(text, ":local".length, {
				directiveVerb: "local",
			});
			expect(anchors.complete).toBeFalse();
			expect(anchors.complete ? "" : anchors.why).toContain(
				"invalid hash in a structured argument value",
			);
		}
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
	])(
		"a %s in an unquoted value fails closed",
		(_name: string, char: string) => {
			// The gate splits tokens on JavaScript `\s`, which includes these two;
			// every explain module splits on ASCII whitespace, which does not. So
			// `comment=x<FF>disabled=no` was two arguments to the gate and one value
			// here. Adopting `\s` in the lexer was the other option and would have
			// put this scanner at odds with `verbsplit.ts` and `segment.ts` about
			// where a token ends — the failure `continuationLength` exists to
			// prevent.
			const data = explainCommand(
				`/ip/address/add comment=x${char}disabled=no`,
			);
			expect(data.canonical.args).toEqual({ comment: "x", disabled: "no" });
			const statement = data.structure.statements[0];
			if (statement?.kind !== "command") throw new Error("expected a command");
			expect(statement.arguments?.read).toBe(false);
			expect(statement.command.args).toBeUndefined();
		},
	);

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
	])(
		"a trailing `;` cannot leave two readings of %s",
		(_name: string, input: string) => {
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
		},
	);

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

/**
 * The THIRD reading (#316): same walk, same reasons, different answer to a
 * refusal. What is pinned here is the relationship between the three, because
 * that relationship is the whole safety argument — a rule gets reach, and
 * nothing that renders a command does.
 */
describe("the skip-tolerant token stream (#316)", () => {
	test("the strict tokens are the tolerant walk's prefix, reason included", () => {
		const text = "/ip/route add dst-address=1.2.3.0/24 gateway=$g comment=x";
		const from = "/ip/route add".length;
		const strict = lexArguments(text, from);
		const tolerant = lexArgumentTokens(text, from);
		expect(strict.read).toBeFalse();

		// Everything the strict walk decided before it aborted is here, unchanged.
		const decided = tolerant.tokens.filter((t) => t.undecided === undefined);
		expect(decided[0]).toEqual({
			kind: "attribute",
			span: { start: 14, end: 36 },
			name: "dst-address",
			value: "1.2.3.0/24",
			valueSpan: { start: 26, end: 36 },
			text: "dst-address=1.2.3.0/24",
		});
		// And the token it aborted AT carries that abort's own reason.
		const stopped = tolerant.tokens.find((t) => t.undecided !== undefined);
		expect(stopped?.undecided).toBe(strict.read ? "" : strict.why);
		// Which is what the strict walk never reached: the tokens AFTER it.
		expect(tolerant.tokens.at(-1)?.value).toBe("x");
		expect(tolerant.complete).toBeTrue();
	});

	test.each([
		["a variable", "gateway=$g", "a variable value"],
		[
			"a substitution",
			"gateway=[/ip/route/get 0]",
			"a substitution or expression value",
		],
		["an expression", "gateway=(1+2)", "a substitution or expression value"],
		["an array", "gateway={1;2}", "an array or block value"],
		[
			"an escape in a quoted value",
			'comment="a\\nb"',
			"an escape in a quoted argument value",
		],
		[
			"a substitution in a quoted value",
			'comment="a$xb"',
			"a substitution in a quoted argument value",
		],
	])(
		"%s is located, never decoded, and does not stop the walk",
		(_label, token, why) => {
			const text = `/ip/route add ${token} comment=after`;
			const from = "/ip/route add".length;
			expect(lexArguments(text, from).read).toBeFalse();

			const tolerant = lexArgumentTokens(text, from);
			expect(tolerant.complete).toBeTrue();
			const [first, second] = tolerant.tokens;
			expect(first?.text).toBe(token);
			expect(first?.undecided).toBe(why);
			// The one invariant a renderer depends on: located is not decoded.
			expect(first?.value).toBeUndefined();
			// The walk carried on, which is the difference from design A.
			expect(second?.value).toBe("after");
		},
	);

	test("a left side that is not a RouterOS name is not promoted to an attribute", () => {
		const text = "/ip/route/add {a=1;b=2} gateway=1.1.1.2";
		const tolerant = lexArgumentTokens(text, "/ip/route/add".length);
		const [first] = tolerant.tokens;
		expect(first?.kind).toBe("positional");
		expect(first?.name).toBeUndefined();
		expect(first?.value).toBeUndefined();
		expect(first?.undecided).toBe("an array or block value");
	});

	test("an attribute's `=` stays locatable even when its value is not", () => {
		const text = "/ip/route add gateway=$g";
		const [only] = lexArgumentTokens(text, "/ip/route add".length).tokens;
		expect(only?.kind).toBe("attribute");
		expect(only?.name).toBe("gateway");
		// `valueSpan.start - 1` is the `=`, which is how the `arg` fill finds it.
		expect(only?.valueSpan).toEqual({ start: 22, end: 24 });
		expect(text[(only?.valueSpan?.start ?? 0) - 1]).toBe("=");
		expect(only?.value).toBeUndefined();
	});

	test.each([
		[
			"an unterminated string",
			'/ip/route add comment="oops gateway=1.1.1.1',
			"unterminated string in an argument",
		],
		[
			"a statement separator",
			"/ip/route add gateway=1.1.1.1;comment=x",
			"a statement separator inside an argument",
		],
	])(
		"%s stops BOTH walks — no boundary to resume from",
		(_label, text, why) => {
			const from = "/ip/route add".length;
			const strict = lexArguments(text, from);
			expect(strict.read ? "" : strict.why).toBe(why);
			const tolerant = lexArgumentTokens(text, from);
			expect(tolerant.complete).toBeFalse();
			expect(tolerant.complete ? "" : tolerant.why).toBe(why);
		},
	);

	test("an unbalanced delimiter stops both walks, for different reasons", () => {
		// The one place the two readings name a different reason, and it follows
		// from what each needed to know. The strict walk refuses a `[…]` on sight
		// and never asks where it ends; the tolerant walk asks, because the answer
		// is what it would resume from — and there is no answer here.
		const text = "/ip/route add gateway=[find name=x";
		const from = "/ip/route add".length;
		const strict = lexArguments(text, from);
		expect(strict.read ? "" : strict.why).toBe(
			"a substitution or expression value",
		);
		const tolerant = lexArgumentTokens(text, from);
		expect(tolerant.complete).toBeFalse();
		expect(tolerant.complete ? "" : tolerant.why).toBe(
			"an unclosed structured argument value",
		);
		// It keeps the bytes it did bound — `gateway=` is an argument name and its
		// `=` whatever follows them — and publishes no value for a value it never
		// found the end of.
		expect(tolerant.tokens).toHaveLength(1);
		expect(tolerant.tokens[0]?.name).toBe("gateway");
		expect(tolerant.tokens[0]?.text).toBe("gateway=");
		expect(tolerant.tokens[0]?.value).toBeUndefined();
		expect(tolerant.tokens[0]?.undecided).toBe(
			"a substitution or expression value",
		);
	});

	test("`undecided` never appears on a strict reading", () => {
		for (const text of [
			"/ip/route add dst-address=1.2.3.0/24 gateway=1.1.1.1",
			"/ip/address/print ?address=1.1.1.1",
			"/ip address print where chain=forward",
			"/file remove a",
		]) {
			const read = lexArguments(text, text.indexOf(" ", 1));
			if (!read.read) throw new Error(read.why);
			for (const token of read.tokens) expect(token.undecided).toBeUndefined();
		}
	});
});
