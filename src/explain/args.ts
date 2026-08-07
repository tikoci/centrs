/**
 * Statement-scope ARGUMENT lexing for `explain` (#202c).
 *
 * Phase 0.5 promoted nine analyzers that answer where a statement STARTS, where
 * its menu ends and its verb begins — and stop there. `structure.statements[]`
 * has carried `path` + `verb` and no arguments since #202a, with the gap
 * written down (`commands/explain/README.md` → *What phase 1 offline actually
 * emits*): splitting one statement's arguments needs a lexer for quoted values,
 * `[…]` selectors and `?` queries at statement scope, and it was parked until
 * `--curl` made it load-bearing. This is that lexer.
 *
 * ## It abstains for the WHOLE statement, never per token
 *
 * The consumer is a REST mapping that renders a runnable `curl` body. A
 * partially-read argument list is worse there than no list at all: dropping one
 * token silently changes what the rendered command DOES, which is the
 * fabrication the fail-closed floor exists to prevent. So every token must be
 * decided, or {@link lexArguments} decides nothing and says why. The price is
 * measured rather than assumed — see the abstention rates in the #202c PR body.
 *
 * ## What it refuses, and why each refusal is a fact rather than a gap
 *
 *   - **A value that is not a literal.** `[…]` command substitution, `(…)`
 *     expression, `$var`, `{…}` array — the token's VALUE is whatever RouterOS
 *     computes at run time, so offline has no value to send. (`canonicalize
 *     ExecuteCommand` takes the same line for `[`/`]` and falls back to script
 *     mode, `src/execute.ts`.)
 *   - **An escape inside a quoted value.** `\n`/`\xHH`/`\"` need a decoder to
 *     turn source bytes into the value the device receives, and a decoder that
 *     is wrong about one escape corrupts a write. Decoding is grounded work
 *     (#225's probe matrix territory), not something to guess at here.
 *   - **A name that is not a name.** `{a=1;b=2}` fuses an array literal into
 *     what looks like `name=value`, which the phase-0 Q0 catalog measured as the
 *     IL oracle's own worst confusion (383 corpus hits). A token whose left side
 *     is not a bare RouterOS name is not read as an attribute.
 *   - **A `\<newline>` continuation.** The bytes of a continued value are not
 *     contiguous, so a `valueSpan` over them would be a lie. `verbsplit.ts`'s
 *     word scanner handles continuations for the run END; a VALUE needs its
 *     interior, which is exactly what a continuation breaks.
 *
 * ## It emits no defects
 *
 * Every defect class this scan could raise (`unterminated-string`,
 * `bad-escape`, `unclosed`) is already located document-wide by `segment.ts` and
 * `symbols.ts`, whose regions are the ratified ones. Re-raising them here with
 * statement-relative regions would double-report the same byte range under two
 * spans, which `attributeDefects` (`src/explain.ts`) cannot de-duplicate because
 * the regions differ. A defect the caller can see is not this module's to
 * re-announce; the abstention reason names it instead.
 */

import { scanQuotedString } from "./segment.ts";

/** A RouterOS argument name: bare word, optionally dotted (`.id`, `.proplist`). */
const ARGUMENT_NAME = /^\.?[A-Za-z][A-Za-z0-9._-]*$/;

/** What one argument token is. */
export type ArgumentKind = "attribute" | "positional" | "query";

/**
 * One argument token, located in the text it was lexed from.
 *
 * The ordered list is the primary shape and the object view is derived from it
 * (the phase-0 normal form: "an ordered token/argument list with spans, never a
 * pre-reduced args object"). Order and multiplicity are observable here and are
 * flattened by {@link ArgumentReading.args}, so a consumer that needs to know a
 * name was given twice still can.
 */
export interface Argument {
	kind: ArgumentKind;
	/** The whole token, in the coordinate space of the text passed to the lexer. */
	span: { start: number; end: number };
	/** Attribute name / query word. Absent on a positional. */
	name?: string;
	/**
	 * The token's LITERAL value, quotes removed — for an attribute the part after
	 * `=`, for a positional the whole token.
	 *
	 * **Absent means there is no literal value**, whatever the kind: the source
	 * spells a substitution, an expression, or an escape this phase does not
	 * decode. A consumer rendering a runnable command must read this field, not
	 * `text`, and must treat absence as "not renderable" — `text` is the source
	 * bytes, which are not the value the device would receive. A query is always
	 * absent: `?` words are a grammar of their own and splitting them is not this
	 * lexer's claim to make.
	 */
	value?: string;
	/** Where the value sits, quotes INCLUDED. Absent whenever `value` is. */
	valueSpan?: { start: number; end: number };
	/** The token verbatim, for a positional and for rendering. */
	text: string;
}

/** Every token decided. */
export interface ArgumentsRead {
	read: true;
	tokens: Argument[];
	/**
	 * The derived object view: attribute names to values, LAST occurrence winning
	 * — the reading `canonicalizeExecuteCommand` already applies to a repeated
	 * name (`src/execute.ts`), so the gate and the analysis cannot disagree about
	 * a duplicate. `tokens` is where multiplicity survives.
	 */
	args: Record<string, string>;
	/** `?`-prefixed query words, in order, verbatim. */
	queries: string[];
	/**
	 * Bare tokens, in order — an id (`*1`), a `where`, a `find` operand — as
	 * SOURCE text. A consumer needing the value reads `tokens` (see
	 * {@link Argument.value}); this list exists so the common "is there an id"
	 * question needs no walk.
	 */
	positional: string[];
}

/** Nothing decided, and the reason. */
export interface ArgumentsUnread {
	read: false;
	/** Why the lexer refused. Rendered into the transport basis, never dropped. */
	why: string;
}

export type ArgumentReading = ArgumentsRead | ArgumentsUnread;

/** A refusal, carrying the reason a consumer quotes instead of a bare `unknown`. */
function unread(why: string): ArgumentsUnread {
	return { read: false, why };
}

/**
 * Lex the arguments of ONE statement, starting at `from`.
 *
 * `text` is the statement, `from` is where its leading run ended
 * (`VerbSplitCommandReading.argsAt`). Offsets in the result are relative to
 * `text`, so a caller rebases them by the statement's own span; it never throws.
 *
 * Only ASCII text may be passed. The analyzed surface is ASCII by construction
 * (`coordinates.ts` stands one byte in for every non-ASCII one), and a caller
 * that hands over the ORIGINAL text of a non-ASCII statement would get spans
 * that do not map back — `src/explain.ts` verifies the two agree before calling.
 */
export function lexArguments(text: string, from: number): ArgumentReading {
	const tokens: Argument[] = [];
	let i = Math.max(0, from);
	while (i < text.length) {
		const c = text[i] as string;
		if (c === " " || c === "\t" || c === "\r" || c === "\n") {
			i++;
			continue;
		}
		// A continuation between tokens is harmless — it is whitespace RouterOS
		// removes — but one INSIDE a token breaks the value's contiguity, which
		// `scanToken` reports.
		const continuation = continuationLength(text, i);
		if (continuation > 0) {
			i += continuation;
			continue;
		}
		const token = scanToken(text, i);
		if (typeof token === "string") return unread(token);
		const read = readToken(text, i, token.end);
		if (typeof read === "string") return unread(read);
		tokens.push(read);
		i = token.end;
	}

	const args: Record<string, string> = {};
	const queries: string[] = [];
	const positional: string[] = [];
	for (const token of tokens) {
		if (token.kind === "attribute" && token.name !== undefined)
			args[token.name] = token.value ?? "";
		else if (token.kind === "query") queries.push(token.text);
		else if (token.kind === "positional") positional.push(token.text);
	}
	return { read: true, tokens, args, queries, positional };
}

/**
 * Length of the `\<newline>` continuation at `at`, or 0 — the ONE boundary rule
 * this module and `verbsplit.ts`'s word scanner share.
 *
 * A lone `\r` is deliberately NOT a continuation. Accepting one and then
 * skipping three bytes ate the following character, so an argument the source
 * spells `x` + `comment=2` lexed as plain `comment=2` — a token whose reported
 * name is not the one in the source.
 * That is a silent misread rather than a refusal, which is the one failure this
 * module must not have — and the two scanners disagreeing about where a
 * continuation ends is exactly how `argsAt` and the token stream come to
 * describe different text. Found in review of #202c-1; `\<CR>` alone now falls
 * through to the invalid-escape refusal below.
 */
function continuationLength(text: string, at: number): 0 | 2 | 3 {
	if (text[at] !== "\\") return 0;
	if (text[at + 1] === "\n") return 2;
	if (text[at + 1] === "\r" && text[at + 2] === "\n") return 3;
	return 0;
}

/**
 * Find where the token starting at `start` ends, or return the reason it is not
 * lexable. A quoted run is skipped by the ONE shared string scanner (#199), so a
 * `"` inside this statement is read exactly as the segmenter read it.
 */
function scanToken(text: string, start: number): { end: number } | string {
	let i = start;
	while (i < text.length) {
		const c = text[i] as string;
		if (c === " " || c === "\t" || c === "\r" || c === "\n") break;
		if (c === '"') {
			const scan = scanQuotedString(text, i);
			if (!scan.closed) return "unterminated string in an argument";
			i = scan.end;
			continue;
		}
		if (c === "[" || c === "(") return "a substitution or expression value";
		if (c === "{") return "an array or block value";
		if (c === "$") return "a variable value";
		if (c === "\\") {
			if (continuationLength(text, i) > 0)
				return "a line continuation inside an argument";
			// The #201 rule: in code a backslash is valid only before whitespace.
			// `symbols.ts` already located the defect; refusing is enough here.
			if (text[i + 1] !== " " && text[i + 1] !== "\t")
				return "an invalid escape in an argument";
			i += 2;
			continue;
		}
		if (c === ";") return "a statement separator inside an argument";
		i++;
	}
	return { end: i };
}

/** Classify one already-bounded token, or say why it cannot be read. */
function readToken(
	text: string,
	start: number,
	end: number,
): Argument | string {
	const raw = text.slice(start, end);
	const span = { start, end };
	if (raw.startsWith("?")) {
		const divergent = queryDisagreement(raw);
		return divergent ?? { kind: "query", span, name: raw.slice(1), text: raw };
	}

	const eq = unquotedEquals(text, start, end);
	if (eq === null) {
		// A positional: an id, a `where`, a `find` operand, a `:log info` message.
		// It carries a literal `value` under exactly the same rule an attribute
		// does, and NOTHING where that rule refuses — `"…$[:tostr $x]"` is a
		// located token whose value only the device knows. That uniformity is the
		// contract a consumer reads: **`value === undefined` means there is no
		// literal value here**, whatever the token's kind. Refusing the statement
		// instead would be wrong — the token IS decided; only its value is not,
		// and a `print` positional never needed one.
		const positional = literalValue(text, start, end);
		return typeof positional === "string"
			? { kind: "positional", span, text: raw }
			: {
					kind: "positional",
					span,
					value: positional.value,
					valueSpan: span,
					text: raw,
				};
	}
	const name = text.slice(start, eq);
	if (!ARGUMENT_NAME.test(name))
		return `\`${name}=\` is not a RouterOS argument name`;
	// An empty value is LEGAL (`comment=` clears it), so `literalValue` reports a
	// refusal as a `string` and a decided value — empty included — as an object.
	// Two different types rather than a sentinel string, which `""` would collide
	// with.
	const value = literalValue(text, eq + 1, end);
	if (typeof value === "string") return value;
	return {
		kind: "attribute",
		span,
		name,
		value: value.value,
		valueSpan: { start: eq + 1, end },
		text: raw,
	};
}

/** Offset of the first `=` outside a quoted run, or null. */
function unquotedEquals(
	text: string,
	start: number,
	end: number,
): number | null {
	let i = start;
	while (i < end) {
		const c = text[i] as string;
		if (c === '"') {
			i = scanQuotedString(text, i).end;
			continue;
		}
		if (c === "=") return i;
		if (c === "\\") {
			i += 2;
			continue;
		}
		i++;
	}
	return null;
}

/**
 * The literal value in `[start,end)`, or the reason there is no literal one.
 *
 * Two shapes are literal: a bare run, and a run that is ONE fully-enclosing
 * quoted string. Anything else — a partly-quoted value (`a"b"`), or a quoted
 * value carrying an escape — needs a decoder this phase does not have, and a
 * decoder that is wrong about one escape corrupts a write.
 */
function literalValue(
	text: string,
	start: number,
	end: number,
): { value: string } | string {
	if (start >= end) return { value: "" };
	if ((text[start] as string) === '"') {
		const scan = scanQuotedString(text, start);
		if (!scan.closed) return "unterminated string in an argument value";
		if (scan.end !== end) return "a partly-quoted argument value";
		const body = text.slice(start + 1, end - 1);
		if (body.includes("\\")) return "an escape in a quoted argument value";
		if (body.includes("$")) return "a substitution in a quoted argument value";
		return { value: body };
	}
	const body = text.slice(start, end);
	if (body.includes('"')) return "a partly-quoted argument value";
	// An UNQUOTED escape needs decoding just as much as a quoted one:
	// `comment=a\ b` is the value `a b` on the device, and returning the source
	// run would send the backslash. `scanToken` accepts `\ `/`\\t` as part of a
	// token (it is legal RouterOS), so the refusal has to happen here — the token
	// is decided, its literal value is not. Found in review of #202c-1.
	if (body.includes("\\")) return "an escape in an argument value";
	const disagreement = gateDisagreement(body);
	if (disagreement !== null) return disagreement;
	return { value: body };
}

/**
 * The same guard for a `?query` word — which is where the first two versions of
 * it did NOT reach, because the query branch of {@link readToken} returns before
 * any value is read (found by review of #202c-1, twice: the fix was written at
 * the value level and one of the three token kinds has no value).
 *
 * A query is kept VERBATIM: `ArgumentsRead.queries` is source text, and a query
 * word's `?` forms (`?>`, `?#|`, existence tests) are a grammar this lexer does
 * not split. So the check is not about values but about whether the gate's
 * tokenizer would produce the same STRING — and it is the identity only on a run
 * with no quote, escape, or `\s`-but-not-ASCII-whitespace byte in it:
 *
 *   - `'` and `\f`/`\v` — the two disagreements above, unchanged in cause.
 *   - `"` — the gate STRIPS quotes, so `?comment="lan uplink"` is the word
 *     `?comment=lan uplink` there and the source text here.
 *   - `\` — the gate consumes it as an escape, so `?comment=a\ b` is
 *     `?comment=a b` there and `?comment=a\ b` here.
 *
 * What survives is exactly the shape on which the gate's tokenizer is a no-op,
 * which is what makes `arguments.queries` and `canonical.queries` comparable at
 * all — and that comparison is now an anchored test rather than an assumption.
 */
function queryDisagreement(raw: string): string | null {
	const found = gateDisagreement(raw);
	if (found !== null) return found;
	if (raw.includes('"'))
		return "a quoted query word, which centrs's execute gate unquotes and this reading keeps verbatim";
	if (raw.includes("\\"))
		return "an escape in a query word, which centrs's execute gate decodes and this reading keeps verbatim";
	return null;
}

/**
 * Characters an UNQUOTED value may not contain, because centrs's two readers
 * genuinely disagree about them — so phase 1 publishes neither reading.
 *
 * Both cases were found by review of #202c-1, and neither is reachable from the
 * corpus:
 *
 *   - **`'`** — RouterOS does not use it as a string delimiter; it is an
 *     ordinary character, which is what this lexer reads. But
 *     `canonicalizeExecuteCommand`'s tokenizer DOES treat it as a quote
 *     (`src/execute.ts`), so `comment='lan uplink'` is `{comment: "lan uplink"}`
 *     to the gate and `{comment: "'lan"}` + a positional here, and
 *     `comment=it's` is `its` there and `it's` here.
 *   - **`\f` / `\v`** — the gate splits tokens on JavaScript `\s`, which
 *     includes them; every `explain` module splits on ASCII whitespace (space,
 *     tab, CR, LF), which does not. So `comment=x\fdisabled=no` is two
 *     arguments to the gate and one value here.
 *
 * **Refusing is not a claim that the gate is right.** The device-correct reading
 * is this module's in both cases, and the gate is locked — widening or
 * correcting it is a product regression (`docs/CONSTITUTION.md`). What is
 * refused is putting a SECOND confident value in the same result, which is the
 * contradiction `command.args` beside `canonical.args` must never contain.
 *
 * Two boundaries this deliberately does NOT cross:
 *
 *   - **Only unquoted values.** Inside a `"…"` run the gate treats all three as
 *     content exactly as this lexer does, so the two agree and refusing there
 *     would cost real readings.
 *   - **Only these two control characters, not the gate's whole `\s` class.**
 *     Adopting `\s` here would put this scanner at odds with `verbsplit.ts` and
 *     `segment.ts` about where a token ends — two scanners disagreeing about a
 *     boundary is the failure the shared `continuationLength` above exists to
 *     prevent. The rest of `\s` is non-ASCII and never reaches this module
 *     as itself: `coordinates.ts` normalization stands a placeholder in, so the
 *     statement fails the addressability check in `src/explain.ts` first
 *     (verified for NBSP, U+2028, U+FEFF and U+3000).
 */
function gateDisagreement(body: string): string | null {
	if (body.includes("'"))
		return "a single quote in an unquoted value, which centrs's execute gate and RouterOS read differently";
	if (body.includes("\f") || body.includes("\v"))
		return "a form feed or vertical tab in an unquoted value, which centrs's execute gate treats as a token boundary and RouterOS does not";
	return null;
}
