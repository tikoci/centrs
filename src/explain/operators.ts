/**
 * The RouterOS operator surface, as the DEVICE describes it (#255).
 *
 * Every row here was scored on CHR 7.23.3 (stable) and re-scored on 7.24rc4
 * (testing) and 7.21.5 (long-term) by `bun run explain:probe:operators` — one
 * build per release channel; the reviewed slice is
 * `test/fixtures/explain/operators.json` → `sweep`, and
 * `test/unit/explain-operators.test.ts` asserts this table still equals it.
 * The three versions differ in exactly one row, and it is not a lexer row —
 * see {@link ARRAY_COMPARISON_NOTE}.
 *
 * ## Why this is not the manual's list
 *
 * The manual's operator section is a LOWER BOUND, the same way its escape table
 * was in #252. Scoring the complement on the device moved five things:
 *
 *  1. **`not` is not an operator.** Neither are `xor`, `mod`, `is`, `div`,
 *     `band`, `bor`, `shl`, `shr`, `eq` or `ne`. They lex as bare words, which
 *     inside a paren group become VARIABLE REFERENCES: `(1 not 2)` parses, as
 *     `(  1 $not 2)`. A reader that treats "parsed" as "is an operator" gets
 *     all eleven wrong.
 *  2. **`..` is not a range operator.** `(1 .. 2)` is `(  (. 1 $.) 2)` —
 *     concatenation applied to a variable named `.`. Likewise `//` is `/` and
 *     `$/`, and `<>` is `<` applied to a DEFERRED `2`, not "not equal".
 *  3. **`$`, `[`, `]`, `;` are syntax, not operators**, though the manual lists
 *     the first three under "other operators". They never head a node: `$x` is
 *     an atom in the IL and `[…]` lowers to `(evl …)`. Keeping them in an
 *     operator table would put a class on bytes that belong to another axis.
 *  4. **`any` is an operator and the manual does not list it.** Prefix, arity
 *     1: `(any 1)` lowers to `(any 1)`.
 *  5. **`&&` and `||` are spellings, not operators.** They lower to the `and`
 *     and `or` nodes; nothing in the IL remembers which spelling was written.
 *
 * And one the manual does not contradict so much as omit: **spacing decides the
 * tokens.** `(1.2)` is an IP literal and `(.1)` a time literal, neither of them
 * concatenation. `(1 . 2)` and `(1 .2)` are both `(. 1 2)` — a leading `.` is
 * still the operator — but `(1. 2)` is `(  $1. 2)`: `1.` lexes as a VARIABLE
 * NAME and the row is juxtaposition, with no operator in it at all. A fill rule
 * that claims every `.` byte gets that last one wrong in the one direction that
 * matters, by emitting a span the device does not have.
 *
 * ## Which oracle decided what, and what `highlight` cannot do
 *
 * **`:parse` IL decided every row.** IL is prefix form with the operator as the
 * head of its node, so it names the operator and shows its operands — the only
 * oracle that can tell `(> 1)` from `(2 > 1)`.
 *
 * **`highlight` decided nothing, and must not be read as if it could.** Its
 * `syntax-meta` class is the device's RESIDUAL STRUCTURE class: measured over
 * `test/fixtures/explain/highlight-streams.slice.json` it covers `=`, `"`, `$`,
 * `[`, `]`, `{`, `}`, `(`, `)`, `;`, `,`, `/` and whitespace runs alongside
 * `||`, `&&`, `!=`, `.` and `~`. Adjacent same-class bytes are also MERGED into
 * one run — `="`, `($`, `")+`, `]!="` each arrive as a single token, and in
 * this sweep the run for `and`, `or` and `in` carried the leading space. So an
 * operator boundary is not recoverable from `highlight` at all, and
 * {@link RouterosOperator.deviceHighlightRun} records the run rather than a
 * per-byte class for that reason.
 *
 * What `highlight` does decide is **structure versus word**, which is exactly
 * what rules `not` out: it comes back `variable-undefined`, the device saying
 * it lexed a variable reference.
 *
 * ## Nothing here emits a span
 *
 * This module is data plus accessors. Turning it into token output is #264's
 * B2 operator fill, and the `centrs -> highlight` projection is B4; both read
 * this table rather than re-deriving it. The one consumer today is the
 * generated operator section of `commands/explain/README.md`.
 */

/** Where the manual files an operator, or `other` for the ones it does not. */
export type OperatorCategory =
	| "arithmetic"
	| "relational"
	| "logical"
	| "bitwise"
	| "concatenation"
	| "access"
	| "apply";

/**
 * How the device nested `(1 A 2 A 3)`.
 *
 * `variadic` is a real third answer, not a way of saying "either": RouterOS
 * FLATTENS those operators into one node with three children, so there is no
 * inner node to associate. A consumer building a tree has to know that `+` is
 * variadic while `-` is binary-left, or it will build a shape the device never
 * produces.
 */
export type OperatorAssociativity = "variadic" | "left" | "right";

export interface RouterosOperator {
	/** As written in source. */
	spelling: string;
	/** The IL node head. Equal to the spelling for every row in this table. */
	ilHead: string;
	/** Operand counts the device accepted, ascending. */
	arities: readonly number[];
	/**
	 * 1 binds loosest, 14 binds tightest; `null` for a prefix-only operator.
	 *
	 * Measured, not transcribed: over all 576 ordered pairs of binary operators,
	 * count how often each was the OUTER node. The counts landed exactly on
	 * `2 x (tighter) + (same level)` for all 24 spellings with 0 pairs dropped,
	 * which is what a strict weak order looks like — so these levels are read
	 * off the device rather than assumed. `!` and `any` are prefix-only, never
	 * appear in a pair, and are honestly `null` rather than guessed.
	 */
	precedence: number | null;
	/** `null` where precedence is null, for the same reason. */
	associativity: OperatorAssociativity | null;
	category: OperatorCategory;
	/**
	 * The `highlight` RUN containing this operator in `:put (1 <op> 2)` — not
	 * the operator's own class, because the device has no such thing. For
	 * `and`, `or` and `in` the run includes the preceding space.
	 */
	deviceHighlightRun: string;
	/** The class of that run. `syntax-meta` for every operator in this table. */
	deviceHighlightClass: string;
}

/**
 * The 26 operators, in the order the sweep scored them.
 *
 * `<%%` and the arity-1 `>` are in here on the same footing as `+`: they are
 * undocumented, but the device builds nodes headed by them, which is the only
 * membership test this table uses.
 */
const OPERATORS: readonly RouterosOperator[] = [
	op("+", [2], 11, "variadic", "arithmetic", "+"),
	op("-", [1, 2], 11, "left", "arithmetic", "-"),
	op("*", [2], 12, "variadic", "arithmetic", "*"),
	op("/", [2], 12, "left", "arithmetic", "/"),
	op("%", [2], 12, "left", "arithmetic", "%"),
	op("<", [2], 5, "left", "relational", "<"),
	// Arity 1 is NOT "less than with one operand": `(> x)` is the deferred
	// expression form, `(>[…])`, whose runtime type is `op`. Same spelling,
	// different operator, and arity is the only thing that separates them.
	op(">", [1, 2], 5, "left", "relational", ">"),
	op("=", [2], 5, "left", "relational", "="),
	op("<=", [2], 5, "left", "relational", "<="),
	op(">=", [2], 5, "left", "relational", ">="),
	op("!=", [2], 5, "left", "relational", "!="),
	op("!", [1], null, null, "logical", "!"),
	op("and", [2], 3, "variadic", "logical", " and"),
	op("or", [2], 2, "variadic", "logical", " or"),
	op("in", [2], 4, "left", "logical", " in"),
	op("~", [1, 2], 5, "left", "relational", "~"),
	op("|", [2], 8, "variadic", "bitwise", "|"),
	op("^", [2], 9, "variadic", "bitwise", "^"),
	op("&", [2], 10, "variadic", "bitwise", "&"),
	op("<<", [2], 7, "right", "bitwise", "<<"),
	op(">>", [2], 7, "right", "bitwise", ">>"),
	op(".", [2], 6, "variadic", "concatenation", "."),
	op(",", [2], 1, "variadic", "concatenation", ","),
	op("->", [2], 14, "left", "access", "->"),
	op("<%%", [2], 13, "right", "apply", "<%%"),
	// Undocumented and prefix-only. Not in the manual's list at all.
	//
	// `any` is a nil-check: `:typeof (any x)` is always `bool`; it is `false`
	// only for `nil`/`nothing` (the value of an undefined `:local` and of
	// `[:nothing]`), `true` for everything else — `0`, `""`, `false`, arrays
	// included.  Typical use is `:if (any $x) ...` to test a `:local`/`:global`
	// that may be `nil` (see issue #255 thread: `any $x` guards the
	// `[:typeof]` branch).  Infix uses like `(true any false)` are not an infix
	// `any` at all — the space-separated form is the juxtaposition node
	// `(  true (any false))`, and `(1 any [:nothing])` is juxt `1` and `false`
	// while `(1 . any [:nothing])` is concat `1`+`false`.
	//
	// `!` and `any` are prefix-only, so the PAIR sweep never carries them and
	// the table honestly stores `null` for measured precedence.  The sweep asks
	// them separately: every `(U 1 B 2)` and `(1 B U 2)` for `U` in
	// `!`/`any`/`~`/`-`/`>` against all 24 binaries, 240 probes, published as
	// the fixture's `unary` block.  All 240 accept and `B` is outermost in
	// every one, on 7.21.5, 7.23.3 and 7.24rc4 alike — so both bind TIGHTER
	// than every binary, including `->` (14) and `<%%` (13).  That is level 15,
	// right-assoc, shared with the unary arities of `~`, `-`, `>` (whose binary
	// arities sit at 5, 11, 5).  The single `precedence` per spelling is
	// therefore the binary level; the unary level is documented here until a
	// split field lands.
	op("any", [1], null, null, "logical", "any"),
];

function op(
	spelling: string,
	arities: number[],
	precedence: number | null,
	associativity: OperatorAssociativity | null,
	category: OperatorCategory,
	deviceHighlightRun: string,
): RouterosOperator {
	return {
		spelling,
		ilHead: spelling,
		arities,
		precedence,
		associativity,
		category,
		deviceHighlightRun,
		// Every operator scored `syntax-meta`. Stored per row rather than implied
		// so a future version that moves one is a diff, not a rewrite.
		deviceHighlightClass: "syntax-meta",
	};
}

/**
 * A spelling the device reads as something OTHER than an operator of its own
 * name.
 *
 * Two different things, and the distinction is load-bearing for anything that
 * wants to render or rewrite source:
 *
 * - `alias` — the whole spelling becomes one node with the same operands.
 *   `(1 && 2)` is `(and 1 2)`. Round-tripping through IL loses the spelling.
 * - `re-lexed` — the spelling was never one token. `(1 <> 2)` is
 *   `(< 1 (> 2))`: `<` applied to a DEFERRED `2`. It is not "not equal", it is
 *   two operators, and a table that recorded `<>` as an alias of `!=` would be
 *   confidently wrong about what the program does.
 */
export interface LoweredSpelling {
	spelling: string;
	kind: "alias" | "re-lexed";
	/** The head(s) the device actually built. */
	ilHeads: readonly string[];
	/** The device IL for the binary carrier, as evidence for `kind`. */
	example: string;
}

const LOWERED: readonly LoweredSpelling[] = [
	{
		spelling: "&&",
		kind: "alias",
		ilHeads: ["and"],
		example: "(<%% (and 1 2) )",
	},
	{
		spelling: "||",
		kind: "alias",
		ilHeads: ["or"],
		example: "(<%% (or 1 2) )",
	},
	{
		spelling: "<>",
		kind: "re-lexed",
		ilHeads: ["<"],
		example: "(<%% (< 1 (> 2)) )",
	},
];

/**
 * Why a swept spelling is not an operator. Three device behaviors, not one.
 *
 * These are the sweep's derived categories, not a reading of them — the slice
 * computes each from the carriers' IL and `test/unit/explain-operators.test.ts`
 * asserts the mapping. Where a row deserves an interpretation on top (`$` and
 * `[` are syntax on the substitution axis, whatever the carriers did with
 * them), that interpretation lives in {@link MANUAL_OTHER_OPERATORS} and in
 * prose, so it stays visibly separate from what the device said.
 */
export type NonOperatorReason =
	/** `:parse` refused every carrier. */
	| "rejected"
	/**
	 * Accepted somewhere, but with part of the spelling lexed as a `$name`:
	 * `(1 not 2)` -> `(  1 $not 2)`, `(1 .. 2)` -> `(  (. 1 $.) 2)`.
	 */
	| "reads-as-variable"
	/**
	 * Accepted only inside RouterOS's unnamed juxtaposition node, with no
	 * invented `$` and no node of its own.
	 */
	| "juxtaposition-only";

export interface NonOperator {
	spelling: string;
	reason: NonOperatorReason;
	/** What `highlight` called it. `variable-undefined` for every word here. */
	deviceHighlightClass: string;
}

/**
 * The grounded COMPLEMENT — spellings the sweep asked about and the device
 * refused.
 *
 * This half is the point. An allow-list assembled from documentation cannot say
 * a spelling is absent; it can only fail to mention it, which is a different
 * claim and the one #252 got wrong. Eighteen of these are word-shaped and would
 * have been plausible keywords in any other language — including the eleven the
 * probe's first verdict rule wrongly promoted, listed at the top of this file.
 */
const NOT_OPERATORS: readonly NonOperator[] = [
	// Word-shaped. Every one of these would be a keyword in some other language,
	// and every one is a variable reference here.
	notOp("not", "reads-as-variable", "variable-undefined"),
	notOp("xor", "reads-as-variable", "variable-undefined"),
	notOp("mod", "reads-as-variable", "variable-undefined"),
	notOp("is", "reads-as-variable", "variable-undefined"),
	notOp("div", "reads-as-variable", "variable-undefined"),
	notOp("band", "reads-as-variable", "variable-undefined"),
	notOp("bor", "reads-as-variable", "variable-undefined"),
	notOp("shl", "reads-as-variable", "variable-undefined"),
	notOp("shr", "reads-as-variable", "variable-undefined"),
	notOp("eq", "reads-as-variable", "variable-undefined"),
	notOp("ne", "reads-as-variable", "variable-undefined"),
	notOp("line", "reads-as-variable", "variable-undefined"),
	notOp("array", "reads-as-variable", "variable-undefined"),
	notOp("as", "reads-as-variable", "variable-undefined"),
	notOp("at", "reads-as-variable", "variable-undefined"),
	notOp("for", "reads-as-variable", "variable-undefined"),
	notOp("none", "reads-as-variable", "variable-undefined"),
	notOp("outside", "reads-as-variable", "variable-undefined"),
	// `evl` is the IL's own node name for a command. It is not source syntax:
	// only the no-space carrier `(1evl2)` survives, and it survives as `$1evl2`.
	notOp("evl", "reads-as-variable", "syntax-meta"),
	// Punctuation that re-lexes into an operator plus a variable named after the
	// remaining byte: `..` -> `.` and `$.`; `//` -> `/` and `$/`.
	notOp("..", "reads-as-variable", "syntax-meta"),
	notOp("//", "reads-as-variable", "syntax-meta"),
	notOp("**", "rejected", "syntax-meta"),
	notOp("===", "rejected", "syntax-meta"),
	notOp("+=", "rejected", "syntax-meta"),
	notOp("++", "rejected", "syntax-meta"),
	notOp("?", "rejected", "error"),
	notOp("?:", "rejected", "error"),
	notOp("<%", "rejected", "syntax-meta"),
	notOp("%%", "rejected", "syntax-meta"),
	notOp(";", "rejected", "error"),
	// The manual's "other operators" — see MANUAL_OTHER_OPERATORS.
	notOp("$", "juxtaposition-only", "syntax-meta"),
	notOp("[", "rejected", "syntax-meta"),
	notOp("]", "rejected", "error"),
];

/**
 * Spellings the manual files under "other operators" that never head a node.
 *
 * `$`, `[` and `]` are real RouterOS syntax and the manual is not wrong to
 * mention them — but they are on the SUBSTITUTION axis, not the operator axis.
 * `$x` stays an atom in the IL (`(+ 1 $x)`), and `[:tostr 1]` lowers to an
 * `evl` node named after the command, not to a node named `[`. Their carrier
 * rows in {@link nonOperators} say only what the generic carriers did with
 * them, which for `[` is "rejected" — true, and not the reason they are out.
 *
 * A token stream must still claim these bytes; they belong to `symbols.ts` and
 * to whatever B2 fill covers bracket substitution, not to an operator fill.
 */
export const MANUAL_OTHER_OPERATORS: readonly string[] = ["$", "[", "]"];

function notOp(
	spelling: string,
	reason: NonOperatorReason,
	deviceHighlightClass: string,
): NonOperator {
	return { spelling, reason, deviceHighlightClass };
}

/**
 * The single version-dependent fact the sweep found.
 *
 * Every operator, arity, precedence level, associativity, `highlight` class and
 * op-axis row is identical on 7.21.5, 7.23.3 and 7.24rc4 — and identical is a
 * measurement here, not a reading: `buildSweep` diffs each of those axes per
 * version, so a build that re-ranked `->` would appear in
 * `sweep.versionDifferences` rather than in nobody's notes.
 *
 * The one row that moved is a RUNTIME semantic, not a lexer fact:
 * `:put ({2;1} > {1;2;3})` is `true` on 7.24rc4 and an error on the two older
 * builds. So the offline lexer needs no version gate for operators — and
 * anything that reports what a comparison MEANS does.
 */
export const ARRAY_COMPARISON_NOTE =
	"array comparison with `>` errors on 7.21.5 and 7.23.3 and evaluates on " +
	"7.24rc4; the operator table itself is identical on all three. The two " +
	"errors are not the same error: 7.23.3 says `cannot compare if array is " +
	"more than array` and 7.21.5 says `cannot compare if nothing is more than " +
	"nothing`, so on 7.21.5 the `{2;1}` operands did not survive to the " +
	"comparison at all. That is a RUNTIME difference either way — no version " +
	"disagrees about what `>` is";

const BY_SPELLING: ReadonlyMap<string, RouterosOperator> = new Map(
	OPERATORS.map((entry) => [entry.spelling, entry]),
);

/** Every operator, in table order. */
export function routerosOperators(): readonly RouterosOperator[] {
	return OPERATORS;
}

/** Spellings the device reads as another operator, or as several. */
export function loweredSpellings(): readonly LoweredSpelling[] {
	return LOWERED;
}

/** The grounded complement: swept spellings that are not operators. */
export function nonOperators(): readonly NonOperator[] {
	return NOT_OPERATORS;
}

/** The operator with this exact spelling, or `undefined`. */
export function operatorFor(spelling: string): RouterosOperator | undefined {
	return BY_SPELLING.get(spelling);
}

/**
 * Whether this spelling heads an operator node on the device.
 *
 * `false` for `&&` and `||` even though both are real RouterOS operators to
 * write — they are spellings of `and` and `or`, and this predicate answers
 * "does the IL have a node by this name". Use {@link resolveSpelling} to go
 * from source text to the operator it denotes.
 */
export function isOperatorSpelling(spelling: string): boolean {
	return BY_SPELLING.has(spelling);
}

/**
 * Source spelling -> the operator it denotes, following one alias hop.
 *
 * Returns `undefined` for a re-lexed spelling such as `<>`, because there is no
 * single operator to return: the device read it as two.
 */
export function resolveSpelling(
	spelling: string,
): RouterosOperator | undefined {
	const direct = BY_SPELLING.get(spelling);
	if (direct !== undefined) return direct;
	const lowered = LOWERED.find((entry) => entry.spelling === spelling);
	if (lowered === undefined || lowered.kind !== "alias") return undefined;
	return BY_SPELLING.get(lowered.ilHeads[0] ?? "");
}

/**
 * The table as flat comparable rows, for the fixture-drift assertion.
 *
 * Flat strings rather than objects so a mismatch prints the row that moved
 * instead of two JSON blobs (the #260 lesson about comparing serialized
 * tallies).
 */
export function operatorRows(): string[] {
	return OPERATORS.map(
		(entry) =>
			`${entry.spelling} arities=${entry.arities.join(",")} ` +
			`precedence=${entry.precedence ?? "-"} assoc=${entry.associativity ?? "-"} ` +
			`hl=${entry.deviceHighlightClass}`,
	).sort();
}

/** The complement as flat comparable rows, same reason. */
export function nonOperatorRows(): string[] {
	return NOT_OPERATORS.map(
		(entry) =>
			`${entry.spelling} ${entry.reason} hl=${entry.deviceHighlightClass}`,
	).sort();
}
