/**
 * Device syntax errors inside groups: `( … )` expressions, `{ … }` arrays and
 * the head word of a statement (#505, #509, #511, #512).
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
 *   checks (empty, `;`, newline) and #509's brace rule, never the operand or
 *   `@` rules.
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
 * Deliberately not here: a `$( … )` group (`:put $({})` is rejected and is
 * read as `({})`), the `@` in a later head word (`/ip address@ print`), operand
 * rules for array elements other than `,`, and adjacency without whitespace
 * (`"x"~a`), which is its own rule.
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
	| "named-value-brace";

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
	/** Positional operands read after the head. */
	positionals: number;
	/** No token of the current statement read yet. */
	lead: boolean;
	/** The whitespace-delimited token being read, if any. */
	token: { start: number; head: boolean; equals: boolean } | null;
}

interface ArrayFrame {
	kind: "array";
	open: number;
	/** What the last significant byte was. */
	last: "open" | "separator" | "comma" | "element";
	commaAt: number;
	element: boolean;
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
 * command argument, which `args.ts` already judges. Only nesting is tracked.
 */
interface OpaqueFrame {
	kind: "opaque";
	query: boolean;
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

function statementFrame(char: StatementFrame["char"]): StatementFrame {
	return {
		kind: "statement",
		char,
		query: false,
		whereEnd: null,
		verb: null,
		positionals: 0,
		lead: true,
		token: null,
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
		frame.token = { start: at, head: frame.lead, equals: false };
	frame.lead = false;
	return frame.token;
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

/** Find every group fault in a comment-masked, analyzed document. */
export function findGroupFaults(masked: string): GroupFault[] {
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

	let i = 0;
	while (i < masked.length) {
		const c = masked[i] as string;
		const frame = top();
		const continued = continuationLength(masked, i);
		if (continued > 0 || isSpace(c)) {
			if (frame.kind === "statement") closeToken(frame);
			i += Math.max(continued, 1);
			continue;
		}
		if (c === '"') {
			if (frame.kind === "statement") openToken(frame, i);
			else operand();
			i = scanQuotedString(masked, i).end;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") {
			const query = frame.query;
			const whereEnd =
				frame.kind === "statement" || frame.kind === "expression"
					? frame.whereEnd
					: null;
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
			)
				faults.push({ code: "named-value-brace", start: i, end: i + 1 });
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
				frames.push({ kind: "opaque", query });
			else
				frames.push({
					kind: "array",
					open: i,
					last: "open",
					commaAt: -1,
					element: false,
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
					: frame.kind === "array" || frame.kind === "opaque"
						? c === "}"
						: frame.char === (c === "]" ? "[" : c === "}" ? "{" : "");
			if (!matches || frames.length === 1) {
				i++;
				continue;
			}
			frames.pop();
			const parent = top();
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
				if (frame.last === "comma")
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
				// Only a `:` directive: a bare `set` or `find` may be a menu command.
				frame.verb = word.startsWith(":") ? word.slice(1) : null;
			}
			if (word.includes("=")) token.equals = true;
			const lower = word.toLowerCase();
			if (token.start === i && (lower === "where" || lower === "find")) {
				frame.query = true;
				if (lower === "where") frame.whereEnd = end;
			}
			i = end;
			continue;
		}

		if (frame.kind === "opaque") {
			i++;
			continue;
		}

		if (frame.kind === "array") {
			if (frame.done) {
				i++;
				continue;
			}
			if (c === ";" || c === "\n") {
				if (frame.last === "comma")
					report(
						{
							code: "missing-operand",
							start: frame.commaAt,
							end: frame.commaAt + 1,
							detail: ",",
						},
						frame,
					);
				else if (c === ";" && frame.last !== "element")
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
		if (frame.query) {
			// Structural checks only (module header): any other byte is content.
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
		// `#`, `?`, a backtick, `'`, a stray `\`, a non-ASCII placeholder: another
		// rule's byte, and nothing here can say what the group means after it.
		frame.done = true;
		i++;
	}
	return faults;
}
