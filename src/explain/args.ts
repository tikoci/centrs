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

import { isScopeBrace } from "./blocks.ts";
import { braceSlotTakesArray } from "./brace-slots.ts";
import { braceStartsStatements } from "./scope-brace.ts";
import { maskComments, scanQuotedString } from "./segment.ts";

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

/** Internal token classification; quote state is stripped from the REST view. */
interface ReadArgument extends Argument {
	literalQuoted?: boolean;
	/** A located structured literal that the strict REST view still refuses. */
	sourceShape?: "array";
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

/** What a located value IS: a command's argument, or one array member. */
export type ValueAnchorKind = Exclude<ArgumentKind, "query"> | "element";

/** One safely located value shape, before any later unreadable token. */
export interface ValueAnchor {
	kind: ValueAnchorKind;
	/** The whole argument token, or the whole member run including its key. */
	tokenSpan: { start: number; end: number };
	/** Attribute name, or an array member's key; absent on a positional. */
	name?: string;
	/** The literal's source bytes, quotes included. */
	valueSpan: { start: number; end: number };
	/** Decoded scalar value, or exact source spelling when `sourceShape` is set. */
	value: string;
	/** True only when one quoted run encloses the whole scalar value. */
	quoted: boolean;
	/** Present only when source delimiters, rather than scalar decoding, prove it. */
	sourceShape?: "array";
	/**
	 * Index, in this same list, of the array literal this member belongs to.
	 *
	 * An index rather than a nested list because the list stays ONE ordered
	 * sequence of located values — the phase-0 normal form — and because a
	 * consumer that only wants spans should not have to walk a tree. Members
	 * follow their container immediately, so a parent index is always smaller.
	 */
	parent?: number;
}

/** Prefix-safe value anchoring; `complete: false` explains where scanning stopped. */
export type ValueAnchorReading =
	| { complete: true; anchors: ValueAnchor[] }
	| { complete: false; anchors: ValueAnchor[]; why: string };

/** A refusal, carrying the reason a consumer quotes instead of a bare `unknown`. */
function unread(why: string): ArgumentsUnread {
	return { read: false, why };
}

interface WalkOptions {
	/** Locate `{…}`/`(…)` literals instead of refusing the statement at one. */
	allowArrayValues?: boolean;
	/**
	 * The root scripting directive whose slots decide whether a `{…}` here is an
	 * array literal, or undefined when this statement has none.
	 *
	 * A command argument never takes one. On CHR 7.23.3 `/console/inspect`
	 * classes the `{` byte `error` and `:parse` refuses the statement for
	 * `/ip/route/add comment={1;2}`, `/ip/dns/set servers={1.1.1.1;8.8.8.8}`
	 * (a LIST-typed attribute, which rules out a schema-shaped reading),
	 * `/interface/print .proplist={name;comment}`,
	 * `/ip/route/print where comment={1;2}`, the relative spelling
	 * `ip route add comment={1;2}`, and `:log info message={1;2}`. A `(…)`
	 * array is accepted in every one of those positions, so only the brace is
	 * gated.
	 *
	 * Being a directive is necessary but NOT sufficient — `:delay {1;2}` and
	 * `:local name={1;2}` are syntax errors too — so which slot it is decides:
	 * see {@link braceSlotTakesArray}.
	 */
	directiveVerb?: string;
}

/** How deep member scanning descends before it stops and keeps only the shape. */
const MAX_MEMBER_DEPTH = 8;

/**
 * The argument name whose value the brace at `at` opens, `null` when the brace
 * IS the token (a positional value), or undefined when it opens neither.
 */
function braceValueOwner(
	text: string,
	tokenStart: number,
	at: number,
): string | null | undefined {
	if (at === tokenStart) return null;
	if (text[at - 1] !== "=") return undefined;
	const name = text.slice(tokenStart, at - 1);
	return ARGUMENT_NAME.test(name) ? name.toLowerCase() : undefined;
}

/**
 * Whether a `{` at `at` may open an array literal in this statement.
 *
 * `positionalIndex` is how many positionals the walk has already read, which is
 * this token's own index if it turns out to be one. Position is load-bearing:
 * `:local {1;2}` puts the literal in the NAME slot and does not parse, while
 * `:local z {1;2}` puts it in the VALUE slot and does.
 */
function braceOpensArray(
	text: string,
	tokenStart: number,
	at: number,
	positionalIndex: number,
	options: WalkOptions,
): boolean {
	const verb = options.directiveVerb;
	if (verb === undefined) return false;
	const owner = braceValueOwner(text, tokenStart, at);
	if (owner === undefined) return false;
	return braceSlotTakesArray(
		verb,
		owner === null ? `#${positionalIndex}` : owner,
	);
}

/**
 * The ONE argument token walk, shared by both readings.
 *
 * Yields each decided token in order, or one refusal string and stops. The
 * strict {@link lexArguments} discards everything on that refusal while
 * {@link lexValueAnchors} keeps the prefix — but they must never disagree about
 * where a token starts, ends, or becomes unreadable, so the boundary rules live
 * here once.
 */
function* walkArguments(
	text: string,
	from: number,
	options: WalkOptions = {},
): Generator<ReadArgument | string> {
	const structural = maskComments(text);
	let i = Math.max(0, from);
	// How many positionals have been read, which is the NEXT positional's index.
	let positionals = 0;
	while (i < text.length) {
		// The MASKED view decides whitespace, because `maskComments` blanks a
		// continuation comment that `text` still spells with a `#`. Reading `text`
		// here left the walk and `scanToken` disagreeing about the same byte: the
		// scan broke on the masked space and returned a zero-length token, so
		// `readToken` emitted an empty positional and `i` never advanced — an
		// `explain` that never returns on `list={1;2} \<nl># c<nl> in=foo`. The
		// strict view uses the same mask: a real continuation comment is whitespace,
		// not positional arguments. Found in review of #243/#245.
		const c = structural[i] as string;
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
		const token = scanToken(text, structural, i, positionals, options);
		if (typeof token === "string") {
			yield token;
			return;
		}
		const read = readToken(text, structural, i, token.end, options);
		if (typeof read === "string") {
			yield read;
			return;
		}
		if (read.kind === "positional") positionals++;
		yield read;
		i = token.end;
	}
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
	for (const step of walkArguments(text, from)) {
		if (typeof step === "string") return unread(step);
		const publicToken = { ...step };
		delete publicToken.literalQuoted;
		tokens.push(publicToken);
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
function scanToken(
	text: string,
	structural: string,
	start: number,
	positionalIndex: number,
	options: WalkOptions,
): { end: number } | string {
	let i = start;
	while (i < text.length) {
		const c = structural[i] as string;
		if (c === " " || c === "\t" || c === "\r" || c === "\n") break;
		if (c === '"') {
			const scan = scanQuotedString(structural, i);
			if (!scan.closed) return "unterminated string in an argument";
			i = scan.end;
			continue;
		}
		if (c === "[") return "a substitution or expression value";
		if (c === "(" || c === "{") {
			if (!options.allowArrayValues)
				return c === "("
					? "a substitution or expression value"
					: "an array or block value";
			if (c === "{" && isScopeBrace(text, i)) return "a scope block value";
			if (
				c === "{" &&
				!braceOpensArray(text, start, i, positionalIndex, options)
			)
				return "a brace value RouterOS does not read as an array here";
			const end = delimitedEnd(structural, i);
			if (end === null) return "an unclosed structured argument value";
			if (hasUnquotedHash(structural, i, end))
				return "an invalid hash in a structured argument value";
			i = end;
			const next = nextNonWhitespace(structural, i);
			if (continuesExpression(structural, i, next))
				return "an expression continuing after a structured value";
			continue;
		}
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

/**
 * RouterOS rejects an unquoted `#` inside array/group expressions (#245) — but
 * only where the expression role actually reaches the hash.
 *
 * A `[…]` substitution nested in an array RE-ENTERS a statement context, and
 * the device keeps the hash there as a value. A flat scan cannot tell the two
 * apart, so carry the same delimiter roles `segment.ts` and `symbols.ts` use.
 * Grounded on CHR 7.23.3 `/console/inspect request=highlight`, class at the `#`:
 *
 *   `:local z {[:put #test]}`      `none`   — bracket restores statements
 *   `:local z {1;[:put #test]}`    `none`
 *   `:local z {[:put {#test}]}`    `error`  — array again inside the bracket
 *   `:local z {[:put (1,#test)]}`  `error`  — group again inside the bracket
 *   `:local z {#test}`             `error`  — the plain array case
 *
 * Skipping whole `[…]` regions instead would wrongly accept rows 3 and 4.
 */
function hasUnquotedHash(text: string, start: number, end: number): boolean {
	// `start` is the `{`/`(` of an array-or-group value: not a statement context.
	const statements: boolean[] = [false];
	for (let i = start + 1; i < end - 1; i++) {
		const c = text[i];
		if (c === '"') {
			i = scanQuotedString(text, i).end - 1;
			continue;
		}
		const enclosing = statements[statements.length - 1] === true;
		if (c === "[") statements.push(true);
		else if (c === "{")
			// Only a brace whose enclosing context ALREADY bears statements can be a
			// scope; nested in an array it is another array, so the role is known
			// without the reverse-prefix scan. The short-circuit is what keeps this
			// O(1) per brace on the deep-nesting inputs `explain-write` and Q17 pin.
			statements.push(enclosing && braceStartsStatements(text, i));
		else if (c === "(") statements.push(false);
		else if (c === "]" || c === "}" || c === ")") {
			if (statements.length > 1) statements.pop();
		} else if (c === "#" && statements[statements.length - 1] === false)
			return true;
	}
	return false;
}

function nextNonWhitespace(text: string, from: number): number {
	let i = from;
	while (
		text[i] === " " ||
		text[i] === "\t" ||
		text[i] === "\r" ||
		text[i] === "\n"
	)
		i++;
	return i;
}

function startsDottedArgument(text: string, at: number): boolean {
	const match = text.slice(at).match(/^(\.[A-Za-z][A-Za-z0-9._-]*)=/);
	return match !== null && ARGUMENT_NAME.test(match[1] as string);
}

/** Operators that prove a closed group is only the left side of an expression. */
function continuesExpression(
	text: string,
	structuredEnd: number,
	at: number,
): boolean {
	const c = text[at];
	// A space separates RouterOS arguments. Dotted names are legal arguments,
	// so `{1;2} .proplist=.id` is not the `.` operator. Without the separation,
	// `{1;2}.proplist=...` remains one expression token and must be refused.
	if (c === "." && at > structuredEnd && startsDottedArgument(text, at))
		return false;
	if (c !== undefined && ".,+-*/%&|^~<>=!".includes(c)) return true;
	return /^(?:and|or|in)(?=[ \t\r\n(])/.test(text.slice(at).toLowerCase());
}

/** One balanced `(...)`/`{...}` run, including nested groups and strings. */
function delimitedEnd(text: string, start: number): number | null {
	const stack: string[] = [];
	for (let i = start; i < text.length; i++) {
		const c = text[i] as string;
		if (c === '"') {
			const scan = scanQuotedString(text, i);
			if (!scan.closed) return null;
			i = scan.end - 1;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") stack.push(c);
		else if (c === ")" || c === "]" || c === "}") {
			const want = c === ")" ? "(" : c === "]" ? "[" : "{";
			if (stack.pop() !== want) return null;
			if (stack.length === 0) return i + 1;
		}
	}
	return null;
}

/** Whether an exact structured source run is an array literal, not grouping. */
function isArraySource(
	text: string,
	structural: string,
	start: number,
	end: number,
): boolean {
	const open = text[start];
	if (open !== "(" && open !== "{") return false;
	if (delimitedEnd(structural, start) !== end) return false;
	if (open === "{")
		return (
			!isScopeBrace(text, start) &&
			structural.slice(start + 1, end - 1).trim().length > 0
		);

	let depth = 0;
	let memberStart = start + 1;
	let sawComma = false;
	for (let i = start + 1; i < end - 1; i++) {
		const c = structural[i] as string;
		if (c === '"') {
			i = scanQuotedString(structural, i).end - 1;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === "," && depth === 0) {
			if (structural.slice(memberStart, i).trim().length === 0) return false;
			sawComma = true;
			memberStart = i + 1;
		}
	}
	return sawComma && structural.slice(memberStart, end - 1).trim().length > 0;
}

function startsStructuredSource(text: string, start: number): boolean {
	return text[start] === "(" || text[start] === "{";
}

/** Classify one already-bounded token, or say why it cannot be read. */
function readToken(
	text: string,
	structural: string,
	start: number,
	end: number,
	options: WalkOptions,
): ReadArgument | string {
	const raw = text.slice(start, end);
	const span = { start, end };
	if (raw.startsWith("?")) {
		const divergent = queryDisagreement(raw);
		return divergent ?? { kind: "query", span, name: raw.slice(1), text: raw };
	}
	if (options.allowArrayValues && startsStructuredSource(text, start)) {
		if (isArraySource(text, structural, start, end))
			return {
				kind: "positional",
				span,
				valueSpan: span,
				sourceShape: "array",
				text: raw,
			};
		return "a grouped or expression value";
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
					literalQuoted: positional.quoted,
					text: raw,
				};
	}
	const name = text.slice(start, eq);
	if (!ARGUMENT_NAME.test(name))
		return `\`${name}=\` is not a RouterOS argument name`;
	if (options.allowArrayValues && startsStructuredSource(text, eq + 1)) {
		if (isArraySource(text, structural, eq + 1, end))
			return {
				kind: "attribute",
				span,
				name,
				valueSpan: { start: eq + 1, end },
				sourceShape: "array",
				text: raw,
			};
		return "a grouped or expression value";
	}
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
		literalQuoted: value.quoted,
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
): { value: string; quoted: boolean } | string {
	if (start >= end) return { value: "", quoted: false };
	if ((text[start] as string) === '"') {
		const scan = scanQuotedString(text, start);
		if (!scan.closed) return "unterminated string in an argument value";
		if (scan.end !== end) return "a partly-quoted argument value";
		const body = text.slice(start + 1, end - 1);
		if (body.includes("\\")) return "an escape in a quoted argument value";
		if (body.includes("$")) return "a substitution in a quoted argument value";
		return { value: body, quoted: true };
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
	return { value: body, quoted: false };
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

/** Trim ASCII whitespace off a range, returning the tightened bounds. */
function trimRange(
	text: string,
	start: number,
	end: number,
): { start: number; end: number } {
	let from = start;
	let to = end;
	while (from < to && " \t\r\n".includes(text[from] as string)) from++;
	while (to > from && " \t\r\n".includes(text[to - 1] as string)) to--;
	return { start: from, end: to };
}

/**
 * Split `[from,to)` on depth-0 `separator`, or null when the device would call
 * the literal a syntax error.
 *
 * On CHR 7.23.3 an empty member is fatal — `{;}`, `{;1}`, `{1;;2}` and `(1,)`
 * are all `syntax error` — with exactly one exception: a brace array tolerates
 * ONE trailing separator (`{1;}` is a one-member array, `{1;2;}` a two-member
 * one). Returning null rather than "no members" matters, because the enclosing
 * `array` shape is wrong too when the literal does not parse.
 */
function splitMembers(
	structural: string,
	from: number,
	to: number,
	separator: ";" | ",",
): { start: number; end: number }[] | null {
	const runs: { start: number; end: number }[] = [];
	let memberStart = from;
	for (const at of depthZeroOffsets(structural, from, to, separator)) {
		runs.push({ start: memberStart, end: at });
		memberStart = at + 1;
	}
	runs.push({ start: memberStart, end: to });
	const trimmed = runs.map((run) => trimRange(structural, run.start, run.end));
	const trailingEmpty =
		separator === ";" &&
		trimmed.length > 1 &&
		(trimmed[trimmed.length - 1] as { start: number; end: number }).start ===
			(trimmed[trimmed.length - 1] as { start: number; end: number }).end;
	const members = trailingEmpty ? trimmed.slice(0, -1) : trimmed;
	if (members.some((run) => run.start === run.end)) return null;
	return members;
}

/** Why a located array literal was withdrawn; each is a device syntax error. */
const EMPTY_MEMBER = "an array literal with an empty member";
const EMPTY_GROUP = "an array member that is an empty group";
const DEPTH_BOUND_REACHED =
	"an array literal nested deeper than this phase reads";
const UNPARSEABLE_MEMBER =
	"an array member RouterOS rejects at its first character";

/**
 * Why a `(…)` member cannot stand where it is, or null when it can.
 *
 * A parenthesis inside a literal is either a GROUP — `{(1)}` is the one-member
 * array `1` — or a comma array, and {@link isArraySource} only recognizes the
 * second. That left the first sharing the fallback branch with every other
 * expression, which is an abstention, so a group the device REJECTS kept the
 * enclosing `array` shape instead of withdrawing it (found in review).
 *
 * On CHR 7.23.3 an empty group (`{()}`, `{a=()}`) and an empty comma member
 * (`{(1,)}`, `{(,)}`, `{1;(2,)}`, `(1,(2,))`) are syntax errors at every
 * nesting depth, while `{(1)}`, `{a=(1)}` and `{1;(2)}` all parse — so the
 * check has to name the fault rather than refuse every parenthesis.
 *
 * `highlight` is not the oracle here: it accepts `{1;2,}`, `{2,}` and
 * `{(1,2),}`, all of which `:parse` rejects.
 */
function parenMemberFault(
	text: string,
	structural: string,
	start: number,
	end: number,
): string | null {
	if (text[start] !== "(") return null;
	if (delimitedEnd(structural, start) !== end) return null;
	if (structural.slice(start + 1, end - 1).trim().length === 0)
		return EMPTY_GROUP;
	return splitMembers(structural, start + 1, end - 1, ",") === null
		? EMPTY_MEMBER
		: null;
}

/** Characters that cannot OPEN an array member; see {@link pushArrayMembers}. */
function leadsInvalidMember(c: string | undefined): boolean {
	return c === "*" || c === "+";
}

/** A member key: a bare word or one fully-enclosing quoted run. */
function memberKey(
	text: string,
	structural: string,
	start: number,
	end: number,
): string | null {
	if (start >= end) return null;
	if (text[start] === '"') {
		const scan = scanQuotedString(structural, start);
		if (!scan.closed || scan.end !== end) return null;
		const body = text.slice(start + 1, end - 1);
		return body.includes("\\") || body.includes("$") ? null : body;
	}
	const raw = text.slice(start, end);
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw) ? raw : null;
}

/**
 * Every offset of `needle` at depth 0 in `[start,end)`, strings skipped.
 *
 * Member splitting, the key split, and the nested-comma test are the same walk
 * asked three questions, so they share it: this module's standing failure mode
 * is two scanners disagreeing about one byte (see {@link continuationLength}).
 */
function depthZeroOffsets(
	structural: string,
	start: number,
	end: number,
	needle: string,
): number[] {
	const found: number[] = [];
	let depth = 0;
	for (let i = start; i < end; i++) {
		const c = structural[i] as string;
		if (c === '"') {
			i = scanQuotedString(structural, i).end - 1;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === needle && depth === 0) found.push(i);
	}
	return found;
}

/**
 * Append the members of one array literal, depth first (#225 V1 interior).
 *
 * Returns null when every member was read, or the REASON the literal does not
 * parse on the device — the caller withdraws the enclosing `array` shape and
 * publishes that reason, so a consumer is never told "empty member" about a
 * literal whose actual fault was something else (found in review).
 *
 * Every rule below is a CHR 7.23.3 reading, taken from each member's own
 * `:typeof` under `:foreach k,v` and the statement's `:parse` IL:
 *
 *   - the separator is the DELIMITER's, not a choice: `{1;2}` has two members
 *     while `{1,2}` has ONE (`(, 1 2)`, a nested array), and `(1;2)` is a
 *     syntax error;
 *   - `=` binds a key in the brace form (`{a=1}` -> key `a`, value `num`) and
 *     COMPARES in the paren form (`(a=1,b=2)` -> two `bool` members), so keys
 *     are read in braces only;
 *   - a member that is itself `{…}`/`(…)`, or a brace member carrying a depth-0
 *     comma, is an array and is descended into;
 *   - everything else is offered to the literal reader, and what it refuses is
 *     a variable reference or an expression on the device — which is exactly
 *     what an abstention should mean.
 */
function pushArrayMembers(
	anchors: ValueAnchor[],
	text: string,
	structural: string,
	parent: number,
	contentStart: number,
	contentEnd: number,
	separator: ";" | ",",
	depth: number,
): string | null {
	// Past the bound the interior is UNVERIFIED, and an unverified interior can
	// hold a fault that makes the whole statement a syntax error — `:parse`
	// rejects a `(1,)` buried nine levels deep exactly as it rejects a shallow
	// one. Returning null here called those bytes an array anyway, so the bound
	// withdraws instead. Deepest member in the 948-script corpus is 6, so this
	// costs nothing that has ever been seen.
	if (depth >= MAX_MEMBER_DEPTH) return DEPTH_BOUND_REACHED;
	const members = splitMembers(structural, contentStart, contentEnd, separator);
	if (members === null) return EMPTY_MEMBER;
	for (const member of members) {
		let valueStart = member.start;
		let name: string | undefined;
		// A member may not OPEN with `*` or `+`: `{*1}`, `{ *1 }`, `(*1,2)`,
		// `{a=*1}` and `{+1}` are all syntax errors on 7.23.3, even though `*1` is
		// a perfectly good value one position out (`:local x *1` is typed `id`).
		// Only the first byte is read, because both characters are ordinary
		// operators between operands — `{2*3}` is `num` 6 and `{1+1}` is 2 — and
		// unary minus is fine either way (`{-1}` is `num` -1).
		if (leadsInvalidMember(text[member.start])) return UNPARSEABLE_MEMBER;
		if (separator === ";") {
			const eq = depthZeroOffsets(structural, member.start, member.end, "=")[0];
			if (eq !== undefined) {
				const key = memberKey(text, structural, member.start, eq);
				const value = trimRange(structural, eq + 1, member.end);
				// `{a=}` is not an empty-valued key: the device drops the `=` and
				// keeps the NAME as a string member, so neither reading is safe.
				if (key === null || value.start === value.end) continue;
				if (leadsInvalidMember(text[value.start])) return UNPARSEABLE_MEMBER;
				name = key;
				valueStart = value.start;
			}
		}
		const anchor: ValueAnchor = {
			kind: "element",
			tokenSpan: { start: member.start, end: member.end },
			...(name === undefined ? {} : { name }),
			valueSpan: { start: valueStart, end: member.end },
			value: text.slice(valueStart, member.end),
			quoted: false,
			parent,
		};
		const fault = parenMemberFault(text, structural, valueStart, member.end);
		if (fault !== null) return fault;
		if (isArraySource(text, structural, valueStart, member.end)) {
			const at = anchors.length;
			anchors.push({ ...anchor, sourceShape: "array" });
			const nested = pushArrayMembers(
				anchors,
				text,
				structural,
				at,
				valueStart + 1,
				member.end - 1,
				text[valueStart] === "{" ? ";" : ",",
				depth + 1,
			);
			if (nested !== null) return nested;
			continue;
		}
		if (
			separator === ";" &&
			depthZeroOffsets(structural, valueStart, member.end, ",").length > 0
		) {
			// `{1;2,3}` is two members, the second a comma array carrying no
			// delimiters of its own — IL `1;(, 2 3)`. It splits on commas.
			const at = anchors.length;
			anchors.push({ ...anchor, sourceShape: "array" });
			const nested = pushArrayMembers(
				anchors,
				text,
				structural,
				at,
				valueStart,
				member.end,
				",",
				depth + 1,
			);
			if (nested !== null) return nested;
			continue;
		}
		const literal = literalValue(text, valueStart, member.end);
		if (typeof literal === "string") continue;
		anchors.push({ ...anchor, value: literal.value, quoted: literal.quoted });
	}
	return null;
}

/**
 * Locate the literal-value prefix of one statement's arguments (#225 V1).
 *
 * {@link lexArguments} remains all-or-nothing because its consumer may render a
 * runnable REST request. Hints are different: an unreadable later expression
 * must not erase an earlier, independently bounded literal. This scan therefore
 * reuses the exact same token and literal readers, returns every safe anchor
 * before the first refusal, and stops there. The one V2 extension is an exact
 * array literal: braces, or parentheses with a depth-zero comma, are locatable
 * without evaluating their contents. Other expressions, including `.` concat,
 * still stop the scan. The strict REST reading remains unchanged.
 *
 * A located array is then DESCENDED into, so each member is anchored in its own
 * right ({@link pushArrayMembers}); a member that does not parse withdraws the
 * whole literal, since the device rejects the statement in that case.
 */
export function lexValueAnchors(
	text: string,
	from: number,
	options: { directiveVerb?: string } = {},
): ValueAnchorReading {
	const anchors: ValueAnchor[] = [];
	const structural = maskComments(text);
	for (const read of walkArguments(text, from, {
		allowArrayValues: true,
		...(options.directiveVerb === undefined
			? {}
			: { directiveVerb: options.directiveVerb }),
	})) {
		if (typeof read === "string")
			return { complete: false, anchors, why: read };
		if (read.kind !== "query" && read.valueSpan !== undefined) {
			if (read.sourceShape !== undefined) {
				const at = anchors.length;
				anchors.push({
					kind: read.kind,
					tokenSpan: read.span,
					...(read.name === undefined ? {} : { name: read.name }),
					valueSpan: read.valueSpan,
					value: text.slice(read.valueSpan.start, read.valueSpan.end),
					sourceShape: read.sourceShape,
					quoted: false,
				});
				const unparsed = pushArrayMembers(
					anchors,
					text,
					structural,
					at,
					read.valueSpan.start + 1,
					read.valueSpan.end - 1,
					text[read.valueSpan.start] === "{" ? ";" : ",",
					0,
				);
				if (unparsed !== null) {
					anchors.length = at;
					return { complete: false, anchors, why: unparsed };
				}
				continue;
			}
			if (read.value === undefined) continue;
			anchors.push({
				kind: read.kind,
				tokenSpan: read.span,
				...(read.name === undefined ? {} : { name: read.name }),
				valueSpan: read.valueSpan,
				value: read.value,
				quoted: read.literalQuoted ?? false,
			});
		}
	}
	return { complete: true, anchors };
}
