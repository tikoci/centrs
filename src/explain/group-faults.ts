/**
 * Device syntax errors inside groups: `( … )` expressions, `{ … }` arrays,
 * the head word of a statement, and the tokens of one (#505, #506, #509, #511,
 * #512, #518).
 *
 * One walk over the comment-masked document, with the same frame roles as the
 * other walkers (`segment.ts` → `maskUncached`): `[` opens a statement
 * context, `(` an expression, and `{` a statement body when its enclosing
 * frame bears statements and either `braceStartsStatements` says so or the
 * statement's directive takes a program in that slot (`:execute {…}`,
 * `:time {…}`, `brace-slots.ts`). Every other `{` is an array. Each group
 * reports at most one fault, because the device stops at its first error and a
 * second report from the same group would describe input it never read.
 *
 * What each rule says was grounded with `:parse` on a stored `/system script`
 * source, on CHR 7.24.5 and 7.23.8, identical on both:
 *
 * - **Expressions (#505).** `()`, `(1 +)`, `(+ 1)`, `(1 + + 2)`, `(!)`,
 *   `(1,)` and `(1 any)` are `syntax error`. `(1 2)` (juxtaposition),
 *   `(- 1)`, `(1 + -2)`, `(-> 1)` and `(any any 1)` parse: `-`, `!`, `>`, `~`
 *   and `any` are prefix operators, and the rest need a left operand. A `;`
 *   or a newline directly inside the group is an error too (`(1; 2)`,
 *   `(1⏎+ 2)`); a `\`-continued line is not a newline. At operand position
 *   `and`, `or`, `in`, `.` and `/` are variable names (`(and 1)` is
 *   `( $and 1)`, `(. 1)` is `( $. 1)`), and `1.`, `1/`, `a_b`, `1:2` and
 *   `a/b` are single words. `-` never joins a word: `(a-b)` is `(- $a $b)`
 *   and `(a-)` an error. A `$name` stops at `.`, `-` and `/`.
 * - **Queries.** Inside `where …` and `find …` the device parses the value
 *   after `<name>=` with the property's own parser: `where (comment=+)`,
 *   `(comment=a-)`, `(comment=@)` and `(.id=*1)` parse, though each is an
 *   expression error elsewhere. So a group in a query gets only the structural
 *   checks (empty, `;`, newline), #509's brace rule and the unquoted-byte
 *   rule below, never the operand or `@` rules.
 * - **Arrays (#511).** An array that is the whole value of a statement or an
 *   argument must have an element: `:local z {}`, `:put {}`, `:return {}`,
 *   `[:len {}]` and `in={}` are errors, while `{1;{}}`, `{a={}}`, `({})`,
 *   `where … in {}` and a body (`do={}`, `source={}`, `:execute {}`) parse. A
 *   `;` with no element before it on its line is an error (`{;1}`, `{1;;2}`,
 *   `{1⏎;2}`), and a trailing one is not (`{1;}`, `{1;2;⏎}`). A newline
 *   separates elements (`{1⏎2}` is `1;2`). `,` is the list operator, so
 *   `{1,}`, `{,1}` and `{1,⏎2}` are errors.
 * - **`@` (#512).** A `@` is an error in the head word of a statement at any
 *   level (`admin@x`, `[admin@MikroTik]`, `:put@x`, `/ip@x`), anywhere in an
 *   array (`{1;a@b}`, `{a=c@d}`) and in an expression (`(a@b)`). It is a value
 *   byte in an argument (`comment=a@b`, `:put a@b`, `[:len a@b]`).
 * - **Named comparisons (#509).** A brace after `<property>=` in a query that
 *   `args.ts` cannot see, inside `( … )` or a `[ … ]` command, uses the
 *   property's parser and is rejected, as at the top level (#502).
 *
 * - **Tokens (#506, #518).** The same walk reads each statement-level token
 *   part by part (a bare word, a string, a `$name`, a group) outside a query:
 *   a closed part glued to the next byte, a `$` with no name after it, and a
 *   declared name that is not letters and digits. `gluedAt`, `wordFaults` and
 *   `nameFault` carry the device rules. One token fault is reported per
 *   statement, and the head word is never read.
 * - **Unquoted bytes (#358, #371).** A `?`, a backtick and a non-ASCII byte
 *   are never part of a bare word: the device rejects each at its byte in a
 *   head word, a name, a `$name`, a value, a query, an array and an
 *   expression (`/systemé`, `print?`, `$café`, `url=http://x/a?b`,
 *   `where comment=café`, `{a`b}`, `(café)`), but a menu command's argument
 *   name at the name's first byte (`addré=1`, `a?b=1`). A second `=` in a
 *   menu command's argument is rejected too (`name=a=b`, a bare base64 key
 *   ending in `=`). In a query and in an array it is an operator and a key
 *   (`where comment=a=b`, `{a=b}` parse), and a query group takes the byte
 *   rule but no other (`where (comment=a?b)` and `in {a?b}` are rejected at
 *   the `?`, `where (comment=a=b)` parses); a directive's `a=b` is a named
 *   argument on 7.24.5 and a syntax error on 7.23.8, so it is left alone. No
 *   property parser was found that takes these bytes (`regexp=a?b`,
 *   `public-key=…=`, `secret=…==`, `on-event=a=b` are all rejected). Strings
 *   and comments carry any byte (`"café"`, `$"café"`, `:local "café"`).
 *
 * Deliberately not here: a `$( … )` group (`:put $({})` is rejected and is
 * read as `({})`), the `@` in a later head word (`/ip address@ print`), and
 * operand rules for array elements other than `,`.
 */

import { comparesNamedValue } from "./args.ts";
import { braceSlotTakesArray, braceSlotTakesProgram } from "./brace-slots.ts";
import { scanQuotedString } from "./quoted-string.ts";
import { braceStartsStatements } from "./scope-brace.ts";

export type GroupFaultCode =
	| "empty-group"
	| "misplaced-separator"
	| "missing-operand"
	| "invalid-at-sign"
	| "named-value-brace"
	| "glued-token"
	| "invalid-variable"
	| "invalid-name"
	| "unquoted-non-ascii"
	| "unquoted-reserved-byte";

export interface GroupFault {
	code: GroupFaultCode;
	/** Analyzed-byte offset, inclusive. */
	start: number;
	/** Analyzed-byte offset, exclusive. */
	end: number;
	/** The operator, separator or opener the fault is about. */
	detail?: string;
	/** The group the fault sits in, for a message that must say which. */
	group?: "(" | "{";
	/**
	 * Where an unquoted-byte fault sits when it is not in a value: a menu
	 * command's argument name, or a statement's head word (path, command,
	 * `$name`). The remedy differs, since neither has a value to quote.
	 */
	site?: "argument-name" | "head-word";
}

interface StatementFrame {
	kind: "statement";
	char: "" | "[" | "{";
	/** The statement has said `where` or `find`, so its groups are queries. */
	query: boolean;
	/** The end of the statement's `where`, the floor for #509. */
	whereEnd: number | null;
	/** The head word without its colon, the key into `brace-slots.ts`. */
	verb: string | null;
	/** The head word is a `$` call, whose arguments no menu reads (`$f a=1`). */
	call: boolean;
	/** Positional operands read after the head. */
	positionals: number;
	/** No token of the current statement read yet. */
	lead: boolean;
	/** The whitespace-delimited token being read, if any. */
	token: StatementToken | null;
	/**
	 * The token rules stop for the rest of the statement: one already
	 * reported, or a boundary they cannot trust (a string ending in `$"`).
	 */
	settled: boolean;
}

interface StatementToken {
	start: number;
	head: boolean;
	equals: boolean;
	/** Just past the token's last closed part (`"…"`, `$name`, a group), or -1. */
	closedAt: number;
	/** Just past the token's last bare-word run, or -1. */
	wordEnd: number;
	/** The token's first bare `=`, or -1. */
	eqAt: number;
}

interface ArrayFrame {
	kind: "array";
	open: number;
	/** What the last significant byte was; `key` is a named element's `=`. */
	last: "open" | "separator" | "comma" | "element" | "key";
	commaAt: number;
	element: boolean;
	/** The current element is `name=value`, which takes a trailing `,`. */
	named: boolean;
	query: boolean;
	done: boolean;
}

interface ExpressionFrame {
	kind: "expression";
	open: number;
	/** Whether the next token must be an operand. */
	wantOperand: boolean;
	empty: boolean;
	/** The operator still waiting for its operand. */
	pending: { start: number; spelling: string } | null;
	query: boolean;
	whereEnd: number | null;
	done: boolean;
}

/**
 * A `{` whose role is not grounded: a brace after a relative menu word
 * (`/ip { route { } }`, a menu body the device accepts empty), or one in a
 * command argument, which `args.ts` already judges. Also every group inside
 * one that has already faulted, since the device never reads past the fault.
 * Only nesting is tracked.
 */
interface OpaqueFrame {
	kind: "opaque";
	close: ")" | "]" | "}";
	query: boolean;
	/** Inside a faulted group: every descendant is opaque too. */
	muted: boolean;
}

type Frame = StatementFrame | ArrayFrame | ExpressionFrame | OpaqueFrame;

/** Prefix operators: the device accepts each with no left operand. */
const PREFIX = new Set(["-", "!", ">", "~"]);

/** Every operator spelling after an operand, longest first. */
const INFIX_SPELLINGS = [
	"<%%",
	"<<",
	">>",
	"<=",
	">=",
	"!=",
	"&&",
	"||",
	"->",
	"+",
	"-",
	"*",
	"/",
	"%",
	"<",
	">",
	"=",
	"!",
	"~",
	"|",
	"^",
	"&",
	".",
	",",
];
const OPERATOR_BYTES = "+-*/%<>=!~|^&.,";
const WORD_OPERATORS = new Set(["and", "or", "in"]);
const BARE_DECLARATIONS = new Set(["local", "global"]);
/** Directives whose first operand is a variable name (`:local a_b` is rejected). */
const NAME_DIRECTIVES = new Set(["local", "global", "set", "for", "foreach"]);
/** The ones whose name must also START alphanumeric; `:set (a) 1` parses. */
const STRICT_NAME_DIRECTIVES = new Set(["local", "global", "foreach"]);
const ALNUM = /[A-Za-z0-9]/;
const SUB = "\x1a";

/** A byte no bare word holds: `?`, a backtick, a non-ASCII stand-in (#358, #371). */
function isUnquotedFaultByte(c: string | undefined): boolean {
	return c === "?" || c === "`" || c === SUB;
}

/** The first such byte in `[from, end)`, or -1. */
function unquotedFaultByteAt(masked: string, from: number, end: number) {
	for (let j = from; j < end; j++) if (isUnquotedFaultByte(masked[j])) return j;
	return -1;
}

/** The fault for the byte at `at`; a non-ASCII run is reported whole. */
function unquotedByteFault(masked: string, at: number): GroupFault {
	if (masked[at] !== SUB)
		return {
			code: "unquoted-reserved-byte",
			start: at,
			end: at + 1,
			detail: masked[at],
		};
	let end = at;
	while (masked[end] === SUB) end++;
	return { code: "unquoted-non-ascii", start: at, end };
}

function statementFrame(char: StatementFrame["char"]): StatementFrame {
	return {
		kind: "statement",
		char,
		query: false,
		whereEnd: null,
		verb: null,
		call: false,
		positionals: 0,
		lead: true,
		token: null,
		settled: false,
	};
}

function isSpace(c: string | undefined): boolean {
	return c === " " || c === "\t" || c === "\r";
}

function isWordByte(c: string | undefined): boolean {
	return c !== undefined && /[A-Za-z0-9_.:/]/.test(c);
}

function continuationLength(text: string, at: number): number {
	if (text[at] !== "\\") return 0;
	if (text[at + 1] === "\n") return 2;
	return text[at + 1] === "\r" && text[at + 2] === "\n" ? 3 : 0;
}

/** A statement-frame word ends at whitespace, a separator or a delimiter. */
function statementWordEnd(text: string, from: number): number {
	let j = from;
	while (j < text.length && !/[\s;"()[\]{}\\]/.test(text[j] as string)) j++;
	return Math.max(j, from + 1);
}

/** The token being read in `frame`, opened at `at` if there is none. */
function openToken(frame: StatementFrame, at: number) {
	if (frame.token === null)
		frame.token = {
			start: at,
			head: frame.lead,
			equals: false,
			closedAt: -1,
			wordEnd: -1,
			eqAt: -1,
		};
	frame.lead = false;
	return frame.token;
}

/** Whether the token rules read this byte of `frame`'s current token. */
function readsTokens(frame: StatementFrame): frame is StatementFrame & {
	token: StatementToken;
} {
	return (
		!frame.settled && !frame.query && frame.token !== null && !frame.token.head
	);
}

/**
 * The glued-token fault at `at`, the first byte of a token part (a word, a
 * string, a `$`, a group), or `null`.
 *
 * After a closed part only a separator may follow: `"a"b`, `$v.b`, `(1)"a"`,
 * `[:len a]b`, `{1}b` and `do={…}else={…}` are `expected end of command` at
 * this byte, in a directive and in a command argument alike
 * (`src-address=$v/24`, `dst-port="80",443`). After a bare word the device
 * rejects a `"`, `$`, `(`, `[` or `{` (`a"b"`, `a$v`, `a(1)`), but in a
 * command argument the property's own parser can take the glued part when the
 * word ends in a prefix or a separator (`dst-address-list=!"my list"`,
 * `dst-port=80,"443"` parse on CHR 7.24.5 and 7.23.8). So there the rule
 * fires only after an alphanumeric byte, and never after the `=`.
 */
function gluedAt(
	masked: string,
	frame: StatementFrame & { token: StatementToken },
	at: number,
): GroupFault | null {
	const { token } = frame;
	const before = masked[at - 1];
	const glued =
		token.closedAt === at ||
		(token.wordEnd === at &&
			before !== "=" &&
			(frame.verb !== null || ALNUM.test(before ?? "")));
	if (!glued) return null;
	const c = masked[at];
	frame.settled = true;
	// A stray `\` is `symbols.ts`'s; a non-ASCII byte is its own fault (`"x"é`).
	if (c === "\\") return null;
	if (c === SUB) return unquotedByteFault(masked, at);
	return { code: "glued-token", start: at, end: at + 1 };
}

/** Is the `$` at `at` escaped by an odd run of `\` before it? */
function escapedAt(text: string, at: number): boolean {
	let n = 0;
	for (let j = at - 1; j >= 0 && text[j] === "\\"; j--) n++;
	return n % 2 === 1;
}

/**
 * The faults in one statement-frame word `[at, end)` (a run with no
 * whitespace, separator, quote, bracket or `\` in it), and the token state it
 * leaves for the next part.
 *
 * - **`$` (#506).** Outside a string a `$` takes a name (`[A-Za-z0-9]+`) or
 *   `$"…"`; `$_`, `$-`, `$.`, `$` before a space and a bare trailing `$` are
 *   `syntax error` at the byte after it. The name is a closed part, so
 *   `$a_b`, `$x$x` and `$a->1` are glued tokens. `$(…)`, `$[…]` and `${…}`
 *   are rejected too, at the end of the group, and `$$v` after the name;
 *   both are left unreported.
 * - **Declared names (#506).** The first operand of `:local`, `:global`,
 *   `:set`, `:for` and `:foreach` is a name: `[A-Za-z0-9]+` or a string. Any
 *   other byte after the name is `expected end of command` there (`a_b`,
 *   `a-b`, `a.b`, `a~b`, `a$v`), and for `:local`, `:global` and `:foreach`
 *   so is any first byte that is not alphanumeric (`:local $a`, `:local -a`).
 *   `:foreach` takes a comma list (`a,b`, `a,"b"`), and an empty slot in it
 *   is rejected (`a,`, `,a`, `a,,b`). A `name=` operand is a named argument
 *   and is not read here.
 */
function wordFaults(
	masked: string,
	frame: StatementFrame & { token: StatementToken },
	at: number,
	end: number,
): GroupFault | null {
	const { token } = frame;
	const glued = gluedAt(masked, frame, at);
	if (glued !== null || frame.settled) return glued;
	let j = at;
	if (
		token.start === at &&
		frame.positionals === 0 &&
		frame.verb !== null &&
		NAME_DIRECTIVES.has(frame.verb)
	) {
		const named = nameFault(masked, frame, at, end);
		if (named !== undefined) return named;
	}
	while (j < end) {
		const c = masked[j];
		if (isUnquotedFaultByte(c)) {
			frame.settled = true;
			return (
				argumentNameFault(masked, frame, j, end) ?? unquotedByteFault(masked, j)
			);
		}
		if (c === "=") {
			if (token.eqAt < 0) token.eqAt = j;
			else if (frame.verb === null && !frame.call) {
				frame.settled = true;
				return unquotedByteFault(masked, j);
			}
		}
		if (c !== "$") {
			j++;
			continue;
		}
		if (j > at) {
			token.wordEnd = j;
			const fault = gluedAt(masked, frame, j);
			if (fault !== null || frame.settled) return fault;
		}
		const next = masked[j + 1];
		if (next !== undefined && ALNUM.test(next)) {
			let k = j + 1;
			while (k < end && ALNUM.test(masked[k] as string)) k++;
			token.closedAt = k;
			token.wordEnd = -1;
			if (k < end) return gluedAt(masked, frame, k);
			return null;
		}
		if (next === '"') {
			// `$"name"`: the string branch reads the name, not glued to the `$`.
			token.closedAt = -1;
			token.wordEnd = -1;
			return null;
		}
		if (next === SUB) {
			frame.settled = true;
			return unquotedByteFault(masked, j + 1);
		}
		// `$$v` is rejected after the name, not at the second `$`.
		if (next === "(" || next === "[" || next === "{" || next === "$") {
			frame.settled = true;
			return null;
		}
		frame.settled = true;
		return {
			code: "invalid-variable",
			start: j,
			end: Math.min(j + 2, masked.length),
		};
	}
	token.wordEnd = end;
	token.closedAt = -1;
	return null;
}

/**
 * A bad byte at `at` inside a menu command's argument name: the device
 * reports it at the name's first byte (`/ip/address/add addré=1` and
 * `a?b=1` at the `a`), and the span is the name. A directive (`:put café=1`)
 * and a `$` call (`$f café=1`) report at the byte, so this is `null` there.
 */
function argumentNameFault(
	masked: string,
	frame: StatementFrame & { token: StatementToken },
	at: number,
	end: number,
): GroupFault | null {
	const { token } = frame;
	if (frame.verb !== null || frame.call || token.eqAt >= 0) return null;
	const eq = masked.indexOf("=", at);
	if (eq < 0 || eq >= end) return null;
	const fault = unquotedByteFault(masked, at);
	return { ...fault, start: token.start, end: eq, site: "argument-name" };
}

/**
 * The declared-name fault in the word at `at`, `null` when the name is
 * well formed, or `undefined` when the word is not a bare name at all (a
 * `name=` argument, or a `:set`/`:for` operand that is not one).
 */
function nameFault(
	masked: string,
	frame: StatementFrame & { token: StatementToken },
	at: number,
	end: number,
): GroupFault | null | undefined {
	const verb = frame.verb as string;
	const fault = (start: number): GroupFault => {
		frame.settled = true;
		return {
			code: "invalid-name",
			start: Math.min(start, masked.length - 1),
			end: Math.min(start, masked.length - 1) + 1,
		};
	};
	if (!ALNUM.test(masked[at] as string))
		return STRICT_NAME_DIRECTIVES.has(verb) ? fault(at) : undefined;
	let k = at;
	for (;;) {
		while (k < end && ALNUM.test(masked[k] as string)) k++;
		const next = masked[k];
		if (k === end) {
			frame.token.wordEnd = end;
			frame.token.closedAt = -1;
			// `a,"b"`: a string may fill a slot, and the rules after it are the
			// list's, not the glued-token rule's.
			if (verb === "foreach" && masked[k - 1] === ",") frame.settled = true;
			return null;
		}
		if (next === "=") return undefined;
		if (next === "," && verb === "foreach") {
			const after = masked[k + 1];
			if (after !== undefined && ALNUM.test(after)) {
				k++;
				continue;
			}
			if (after === '"' && k + 1 === end) {
				k++;
				continue;
			}
			return fault(k + 1);
		}
		return fault(k);
	}
}

function closeToken(frame: StatementFrame) {
	if (frame.token !== null && !frame.token.head && !frame.token.equals)
		frame.positionals++;
	frame.token = null;
}

/**
 * What the `{` at `at` is in a root directive's slot, by the device-swept
 * `(verb, slot)` table: a program (`:execute {…}`, `:time {…}`, which
 * `braceStartsStatements` does not know), an array (`:local z {…}`,
 * `in={…}`), or unknown.
 */
function directiveSlotRole(
	masked: string,
	at: number,
	frame: StatementFrame,
): "program" | "array" | null {
	if (frame.verb === null) return null;
	const token = frame.token;
	let slot: string;
	if (token === null) slot = `#${frame.positionals}`;
	else if (!token.head && masked[at - 1] === "=")
		slot = masked.slice(token.start, at - 1).toLowerCase();
	else return null;
	if (braceSlotTakesProgram(frame.verb, slot)) return "program";
	return braceSlotTakesArray(frame.verb, slot) ? "array" : null;
}

const CLOSER = { "(": ")", "[": "]", "{": "}" } as const;

/**
 * Find every group fault in an analyzed document. `masked` is its comment
 * mask; `text` is read only to tell a masked comment line from spaces. The
 * walk starts at `from`, past a leading BOM, which is a positional fact and
 * not a byte of the first word.
 */
export function findGroupFaults(
	text: string,
	masked: string,
	from = 0,
): GroupFault[] {
	const faults: GroupFault[] = [];
	const frames: Frame[] = [statementFrame("")];
	const top = (): Frame => frames[frames.length - 1] as Frame;
	const report = (fault: GroupFault, frame: ArrayFrame | ExpressionFrame) => {
		faults.push(fault);
		frame.done = true;
	};
	// A completed operand (a word, string, `$name` or closed group).
	const operand = () => {
		const frame = top();
		if (frame.kind === "array") {
			frame.element = true;
			frame.last = "element";
		} else if (frame.kind === "expression") {
			frame.empty = false;
			frame.wantOperand = false;
			frame.pending = null;
		}
	};

	// H5, as `segment.ts` → `maskUncached` reads it: a `\` continuation runs on
	// across blank lines and line-leading comment lines, and a blank line after
	// a comment line ends it. CHR 7.24.5 and 7.23.8 join `(1 +\⏎# c⏎2)` and
	// `(1 +\⏎⏎2)`, and reject `(1 +\⏎# c⏎⏎2)` at the blank line.
	let cont: "none" | "escape" | "comment" = "none";
	let contLineStart = false;
	let i = from;
	while (i < masked.length) {
		const c = masked[i] as string;
		const frame = top();
		if (cont !== "none") {
			if (c === "\n" && cont === "escape") {
				contLineStart = true;
				i++;
				continue;
			}
			if (text[i] === "#" && contLineStart) {
				const newline = masked.indexOf("\n", i);
				cont = "comment";
				contLineStart = true;
				i = newline < 0 ? masked.length : newline + 1;
				continue;
			}
			if (isSpace(c)) contLineStart = false;
			else cont = "none";
		}
		const continued = continuationLength(masked, i);
		if (continued > 0 || isSpace(c)) {
			if (continued > 0) {
				cont = "escape";
				contLineStart = true;
			}
			if (frame.kind === "statement") closeToken(frame);
			i += Math.max(continued, 1);
			continue;
		}
		if (c === '"') {
			const end = scanQuotedString(masked, i).end;
			if (frame.kind === "statement") {
				openToken(frame, i);
				if (readsTokens(frame)) {
					const glued = gluedAt(masked, frame, i);
					if (glued !== null) faults.push(glued);
					frame.token.closedAt = end;
					frame.token.wordEnd = -1;
					// `:foreach "a",b in=…` parses: a string fills a counter slot.
					if (
						frame.verb === "foreach" &&
						frame.positionals === 0 &&
						frame.token.start === i
					)
						frame.settled = true;
					// `"a$"v""` is ONE string on the device, which reads `$"` as a
					// quoted name; every scanner here ends it at the second quote.
					if (masked[end - 2] === "$" && !escapedAt(masked, end - 2))
						frame.settled = true;
				}
			} else operand();
			i = end;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") {
			if (frame.kind === "statement") {
				if (readsTokens(frame)) {
					const glued = gluedAt(masked, frame, i);
					if (glued !== null) faults.push(glued);
				} else if (
					frame.token === null &&
					!frame.lead &&
					!frame.settled &&
					frame.positionals === 0 &&
					frame.verb !== null &&
					STRICT_NAME_DIRECTIVES.has(frame.verb)
				) {
					// `:local (a)`, `:local [x]`, `:local {a}`: a name never starts
					// with a group (`syntax error` at it).
					frame.settled = true;
					faults.push({ code: "invalid-name", start: i, end: i + 1 });
				}
			}
			const query = frame.query;
			const whereEnd =
				frame.kind === "statement" || frame.kind === "expression"
					? frame.whereEnd
					: null;
			if (
				((frame.kind === "array" || frame.kind === "expression") &&
					frame.done) ||
				(frame.kind === "opaque" && frame.muted)
			) {
				frames.push({ kind: "opaque", close: CLOSER[c], query, muted: true });
				i++;
				continue;
			}
			// #509: the top level and scope bodies are `args.ts`'s; a bracket
			// command and a group are only visible here.
			const floor =
				frame.kind === "expression" ||
				(frame.kind === "statement" && frame.char === "[")
					? whereEnd
					: null;
			const role =
				c === "{" && frame.kind === "statement"
					? braceStartsStatements(masked, i)
						? "program"
						: directiveSlotRole(masked, i, frame)
					: null;
			// A body (`do={`) is never a comparison, though `where` is still open:
			// corpus `eworm/hotspot-to-wpa.template.rsc` interleaves two `:if`s.
			if (
				c === "{" &&
				role !== "program" &&
				floor !== null &&
				comparesNamedValue(masked, i, floor)
			) {
				// The device stops at this brace, so neither its contents nor the
				// rest of the enclosing group are read.
				faults.push({ code: "named-value-brace", start: i, end: i + 1 });
				if (frame.kind === "expression") frame.done = true;
				frames.push({ kind: "opaque", close: "}", query, muted: true });
				if (frame.kind === "statement") openToken(frame, i);
				i++;
				continue;
			}
			if (c === "[") frames.push(statementFrame("["));
			else if (c === "(")
				frames.push({
					kind: "expression",
					open: i,
					wantOperand: true,
					empty: true,
					pending: null,
					query,
					whereEnd,
					done: false,
				});
			else if (role === "program") frames.push(statementFrame("{"));
			else if (
				frame.kind === "opaque" ||
				(frame.kind === "statement" && role !== "array")
			)
				frames.push({ kind: "opaque", close: "}", query, muted: false });
			else
				frames.push({
					kind: "array",
					open: i,
					last: "open",
					commaAt: -1,
					element: false,
					named: false,
					query,
					done: false,
				});
			// After the slot was read: the brace starts or continues a token.
			if (frame.kind === "statement") openToken(frame, i);
			i++;
			continue;
		}
		if (c === ")" || c === "]" || c === "}") {
			const matches =
				frame.kind === "expression"
					? c === ")"
					: frame.kind === "array"
						? c === "}"
						: frame.kind === "opaque"
							? c === frame.close
							: frame.char === (c === "]" ? "[" : c === "}" ? "{" : "");
			if (!matches || frames.length === 1) {
				i++;
				continue;
			}
			frames.pop();
			const parent = top();
			if (parent.kind === "statement" && parent.token !== null) {
				parent.token.closedAt = i + 1;
				parent.token.wordEnd = -1;
			}
			if (frame.kind === "expression" && !frame.done && frame.wantOperand) {
				if (frame.empty)
					faults.push({
						code: "empty-group",
						start: frame.open,
						end: i + 1,
						detail: "(",
					});
				else if (frame.pending !== null)
					faults.push({
						code: "missing-operand",
						start: frame.pending.start,
						end: frame.pending.start + frame.pending.spelling.length,
						detail: frame.pending.spelling,
					});
			}
			if (frame.kind === "array" && !frame.done) {
				if (frame.last === "comma" && !frame.named)
					faults.push({
						code: "missing-operand",
						start: frame.commaAt,
						end: frame.commaAt + 1,
						detail: ",",
					});
				else if (!frame.element && parent.kind === "statement")
					faults.push({
						code: "empty-group",
						start: frame.open,
						end: i + 1,
						detail: "{",
					});
			}
			operand();
			i++;
			continue;
		}

		if (frame.kind === "statement") {
			if (c === ";" || c === "\n") {
				frames[frames.length - 1] = statementFrame(frame.char);
				i++;
				continue;
			}
			const end = statementWordEnd(masked, i);
			const word = masked.slice(i, end);
			const token = openToken(frame, i);
			if (token.head && token.start === i) {
				// The head word runs to its first `=` too: `a=b@c` is no head.
				const cut = word.indexOf("=");
				const at = (cut < 0 ? word : word.slice(0, cut)).indexOf("@");
				if (at >= 0)
					faults.push({
						code: "invalid-at-sign",
						start: i + at,
						end: i + at + 1,
					});
				// A `:` directive, or a bare declaration: `local where (comment={})`
				// is `/localname=$where` at the root on CHR 7.24.5 and 7.23.8 (in a
				// menu it is `bad command name local`). A bare `set` or `find` may be
				// a menu command, so it stays unread.
				frame.verb = word.startsWith(":")
					? word.slice(1)
					: BARE_DECLARATIONS.has(word)
						? word
						: null;
				frame.call = word.startsWith("$");
				// `[/ip/address/find comment=a=b]` is a query, as `[find …]` is.
				if (frame.verb === null && /(^|\/)find$/i.test(word))
					frame.query = true;
				const bad = unquotedFaultByteAt(masked, i, end);
				if (bad >= 0 && (at < 0 || i + at > bad)) {
					frame.settled = true;
					faults.push({ ...unquotedByteFault(masked, bad), site: "head-word" });
				}
			}
			if (readsTokens(frame)) {
				const fault = wordFaults(masked, frame, i, end);
				if (fault !== null) faults.push(fault);
			} else if (frame.query && !frame.settled && !token.head) {
				// A query keeps `=` as an operator, but not these bytes.
				const bad = unquotedFaultByteAt(masked, i, end);
				if (bad >= 0) {
					frame.settled = true;
					faults.push(unquotedByteFault(masked, bad));
				}
			}
			if (word.includes("=")) token.equals = true;
			const lower = word.toLowerCase();
			// A directive's operand is a name, never a query: `:local where
			// (comment={})` parses, and `:local where (1 +)` is a syntax error.
			if (
				frame.verb === null &&
				token.start === i &&
				(lower === "where" || lower === "find")
			) {
				frame.query = true;
				if (lower === "where") frame.whereEnd = end;
			}
			i = end;
			continue;
		}

		if (frame.kind === "opaque") {
			// A query's `in {…}` is read as opaque, so `where … in {}` keeps
			// parsing; its bytes are still rejected (`in {a?b}` at the `?`).
			if (frame.query && !frame.muted && isUnquotedFaultByte(c)) {
				faults.push(unquotedByteFault(masked, i));
				frame.muted = true;
			}
			i++;
			continue;
		}

		if (frame.kind === "array") {
			if (frame.done) {
				i++;
				continue;
			}
			if (c === ";" || c === "\n") {
				// A named element takes a trailing `,`: `{a=1,}` is `value=a` and
				// `{a=1,;b=2}` is `value=a;b=2` on CHR 7.24.5 and 7.23.8, while
				// `{1,}`, `{a=,1}` and `{a=1,,2}` are syntax errors.
				if (frame.last === "comma" && !frame.named)
					report(
						{
							code: "missing-operand",
							start: frame.commaAt,
							end: frame.commaAt + 1,
							detail: ",",
						},
						frame,
					);
				else if (
					c === ";" &&
					(frame.last === "open" || frame.last === "separator")
				)
					report(
						{
							code: "misplaced-separator",
							start: i,
							end: i + 1,
							detail: ";",
							group: "{",
						},
						frame,
					);
				frame.last = "separator";
				frame.named = false;
				i++;
				continue;
			}
			if (c === "=" && frame.last === "element" && !frame.named) {
				frame.named = true;
				frame.last = "key";
				i++;
				continue;
			}
			if (c === ",") {
				if (frame.last !== "element")
					report(
						{ code: "missing-operand", start: i, end: i + 1, detail: "," },
						frame,
					);
				frame.last = "comma";
				frame.commaAt = i;
				i++;
				continue;
			}
			if (c === "@" && !frame.query) {
				report({ code: "invalid-at-sign", start: i, end: i + 1 }, frame);
				i++;
				continue;
			}
			// Unlike `@`, these bytes are rejected in a query too (`in {a?b}`).
			if (isUnquotedFaultByte(c)) {
				report(unquotedByteFault(masked, i), frame);
				i++;
				continue;
			}
			frame.element = true;
			frame.last = "element";
			i++;
			continue;
		}

		// An expression group.
		if (frame.done) {
			i++;
			continue;
		}
		if (c === ";" || c === "\n") {
			report(
				{
					code: "misplaced-separator",
					start: i,
					end: i + 1,
					detail: c,
					group: "(",
				},
				frame,
			);
			i++;
			continue;
		}
		// A query group keeps its operators, but not these bytes:
		// `where (comment=a?b)` is a `syntax error` at the `?`.
		if (isUnquotedFaultByte(c)) {
			report(unquotedByteFault(masked, i), frame);
			i++;
			continue;
		}
		if (frame.query) {
			// Structural and byte checks only (module header): any other byte is
			// content.
			frame.empty = false;
			frame.wantOperand = false;
			i++;
			continue;
		}
		if (c === "@") {
			report({ code: "invalid-at-sign", start: i, end: i + 1 }, frame);
			i++;
			continue;
		}
		if (c === "$") {
			const next = masked[i + 1];
			if (next !== undefined && /[A-Za-z0-9_]/.test(next)) {
				let j = i + 1;
				while (j < masked.length && /[A-Za-z0-9_]/.test(masked[j] as string))
					j++;
				operand();
				i = j;
				continue;
			}
			// `$"name"` and `$(…)`/`$[…]`/`${…}`: the operand is what follows.
			if (next === '"' || next === "(" || next === "[" || next === "{") {
				i++;
				continue;
			}
			frame.done = true;
			i++;
			continue;
		}
		// `.`, `/` and `:` start a word only where an operand is due: `(. 1)` is
		// `( $. 1)` and `(::1)` an address, while `(1 .2)` is `(. 1 2)`.
		if (isWordByte(c) && (/[A-Za-z0-9_]/.test(c) || frame.wantOperand)) {
			let j = i;
			while (j < masked.length && isWordByte(masked[j])) j++;
			const word = masked.slice(i, j);
			if (word === "any" || (!frame.wantOperand && WORD_OPERATORS.has(word))) {
				frame.empty = false;
				frame.wantOperand = true;
				frame.pending = { start: i, spelling: word };
			} else operand();
			i = j;
			continue;
		}
		if (OPERATOR_BYTES.includes(c)) {
			const spelling =
				frame.wantOperand && PREFIX.has(c)
					? c
					: (INFIX_SPELLINGS.find((s) => masked.startsWith(s, i)) ?? c);
			if (frame.wantOperand && !PREFIX.has(c)) {
				report(
					{
						code: "missing-operand",
						start: i,
						end: i + spelling.length,
						detail: spelling,
					},
					frame,
				);
				i += spelling.length;
				continue;
			}
			frame.empty = false;
			frame.wantOperand = true;
			frame.pending = { start: i, spelling };
			i += spelling.length;
			continue;
		}
		// `#`, `'`, a stray `\`: another rule's byte, and nothing here can say
		// what the group means after it.
		frame.done = true;
		i++;
	}
	return faults;
}
