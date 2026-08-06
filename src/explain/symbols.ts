/**
 * Symbol scope resolution for `explain` (centrs canonicalizer).
 *
 * Ratified by the phase-0 lab, question Q13 (#185) and promoted from the
 * throwaway probe `.scratch/explain-lab-symbols.ts`. Q13 asks whether an
 * offline, schema-free reader can reproduce the class the console assigns to
 * every variable occurrence — `variable-local` / `-global` / `-auto` /
 * `-parameter` / `-undefined` in `/console/inspect request=highlight`.
 *
 * **The ratified answer: yes for the lexical classes, and `undefined` must
 * ABSTAIN.** The naive rule from the device's own documentation ("a bare
 * identifier in expression position that resolves to nothing is undefined")
 * scored 2.5% precision in the lab — 39 false positives against 1 true
 * positive — because a bare word in expression position is far more often a
 * menu field the console binds as a local, a bare query flag, or an operator
 * keyword. The device emits `variable-undefined` in 9 of 580 clean corpus
 * files. So this module says what a name is bound TO and never says that a
 * bare word is unbound: `cls: null` is a first-class outcome, the same
 * abstain-never-assert conclusion Q3 (absolute inner paths), Q6 (`ambiguous`)
 * and Q16 (`unknown`) reached independently.
 *
 * Two console conflations are MATCHED rather than beaten:
 *   - an undeclared `$typo` is `parameter`, not an error — the console cannot
 *     tell "undeclared" from "supplied at call time", so S5 is the ANSWER, not
 *     a fallback. Flagging it would be wrong.
 *   - a bare identifier in `where`/filter position is a menu field bound as a
 *     local, and telling a real field from a typo needs the menu schema, so
 *     S8 abstains.
 *
 * Spans are **analyzed-byte offsets** (half-open), like `segment.ts` and the
 * coordinate contract (#188): the ASCII normalization is byte-count-preserving,
 * so an occurrence offset is also its offset in the device's highlight byte
 * stream — which is what made scoring against that stream possible at all.
 * An occurrence's `name` is the key it binds as, which is not always its span's
 * text (S11 quotes, S19 prefixes); slice the span for display text.
 *
 * The rules, as ratified (S-numbers are the lab's):
 *   S1  `:local NAME` declares NAME `local` from the declaration to the end of
 *       the enclosing brace scope; an inner `:local` shadows an outer one. (The
 *       `:` is optional on every head below — see F3.)
 *   S2  `:global NAME` declares NAME `global`. (As ratified this said "visible
 *       for the remainder of the document regardless of brace nesting"; the
 *       device disagrees — see F7, which supersedes the extent half of it.)
 *   S3  `:foreach A[,B] in=… do={…}` / `:for I from=… do={…}` declare their
 *       loop variables `auto`. (Their EXTENT is F7's statement scope.)
 *   S4  A reference resolves to the nearest enclosing declaration and takes
 *       its class. (Within one scope, "nearest" is F7's claim, not the nearest
 *       preceding declaration.)
 *   S5  `$NAME` with no visible declaration is `parameter` (see above).
 *   S6  `$0`, `$1`, … are `parameter`.
 *   S7  A bare identifier in expression position is NOT asserted `undefined`;
 *       a resolvable one takes its binding's class, an unresolvable one
 *       abstains (the 2.5%-precision finding above).
 *   S8  Every bare identifier in a `where`/`find` filter region is a menu
 *       field — not only the `field=value` form — so it abstains.
 *   S9  `$NAME` inside a double-quoted string interpolates and is classified;
 *       inside a comment it is not.
 *   S10 `:set NAME` is a REFERENCE, never a declaration; on an undeclared name
 *       the device raises a hard error, which is not a class — so it abstains.
 *   S11 A quoted declaration name (`:global "set-dns"`) carries its class
 *       across the quotes, and the span includes them.
 *   S12 A word carrying a `:` or `/` sigil is a directive or menu-path
 *       segment, never a symbol.
 *   S13 Bare literals (`true`/`false`/`yes`/`no`/`nothing`, anything starting
 *       with a digit) are values.
 *   S14 The reference-name boundary is not the argument-name charset: `->`
 *       and `.` terminate a name.
 *   S15 A bare word right after `=` or `,` is a VALUE.
 *   S16 A bare word continuing a space-separated menu path is a path segment.
 *   S17 `or` / `and` / `not` / `in` are operators, not symbols.
 *   S18 `:onerror NAME` binds NAME `local` (in TWO places — see F7).
 *   S19 `-` is both legal inside a name (`$set-dns`) and the subtraction
 *       operator (`$octive-1`); the tie is broken by the longest prefix that
 *       resolves against the document's OWN declarations.
 *
 * EIGHT behaviors go beyond the lab SUT. None is invented: the probe declared the
 * first two and left them unmodeled (it was throwaway and depth-scoped), F2 is
 * required verbatim by the ratified spec — `commands/explain/README.md`, "Symbol
 * scopes follow RouterOS scope identity, not brace depth alone" — and F3/F4 are
 * lexical facts the probe simply got wrong. Each was priced against the frozen
 * corpus streams before being shipped, then device-verified per occurrence on
 * CHR 7.23.2 (`.scratch/q13-arms.ts` + `-arms-score.ts` + `-anchor-chr-probe.ts`,
 * the Q16 re-score method):
 *
 *   F1  A `$[…]` / `$(…)` substitution inside a double-quoted string is CODE
 *       (Q3 grounded the same fact in `:parse` IL). A scan that treats it as
 *       string bytes flips its quote phase on the first nested string, which
 *       silently destroys every later binding. Modeling it moved holdout
 *       precision 96.75% → 99.85% and dev 93.06% → 98.50%.
 *   F3  The SIGIL on a scripting head is optional in both directions, but the
 *       head must be at STATEMENT START and carry at most ONE sigil character. Q2
 *       grounded the colon-less form for body-taking directives (`do {` ≡
 *       `:do {`); CHR 7.23.2 extends it to every head this module reads —
 *       `local foo 1`, `global foo 1`, `foreach i in={1} …`, `for i from=1 …`
 *       and `set foo 2` bind exactly like their `:` twins, and so does the `/`
 *       spelling, because these directives are also ROOT commands (`/global g 1`
 *       → `g` = `variable-global`, the same root vocabulary `write.ts` froze as
 *       `ROOT_CMDS`). A deeper path is untouched: in `/ip/local foo 1` the head
 *       word is `ip` and `local` is an `obj-inactive` menu item. Requiring the
 *       colon dropped those declarations and then reported every later use as a
 *       confident `parameter` — a false class on valid input, which is exactly
 *       what Q13's posture forbids. The two guards matter as much as the rule:
 *       `$fn local foo 1` makes `local` an ordinary word (device: `none`), and
 *       `//local foo 1` is a device error, so neither may declare.
 *   F5  A sigil RUN at statement start is a hard error — `//local`, `::put` and
 *       `:/local` all error at the second character and class every later byte
 *       `none` — so it fails closed with `bad-sigil:<offset>` like a malformed
 *       escape. Inside a VALUE a doubled slash is ordinary text (`url=http://…`
 *       and `comment=a//b` are clean). F8 extends the same stop past the
 *       statement lead.
 *   F4  A backslash in CODE is valid only before whitespace; before a newline it
 *       is the H5 CONTINUATION, so the statement head, the pending declaration
 *       and `declaredHere` all survive it. Treating it as a boundary lost
 *       `:local \<nl>foo 1` outright and reset the closure flag in
 *       `:local fn do=\<nl>{ … }`, leaking the outer scope into a body the device
 *       treats as a closure. Every other spelling (`\a`, `\$v`, `\\ `, `\{`) is a
 *       hard device error that classes the whole remainder `none`, so the walker
 *       records `bad-escape:<offset>` and stops there instead of reading
 *       `do=\{` as a closure. `escapeKind` is shared with the `do=` lookback on
 *       purpose: `do=\ {`, `do=\<tab>{` and `do=\<nl>{` are all `do={` on the
 *       device, and a scan that accepted an escape the lookback did not would
 *       silently stop treating the body as a closure. The continuation reaches
 *       past its own line — blank lines and an IMMEDIATE `#` comment line keep
 *       the statement pending, and statement-leading position survives both — so
 *       the walker carries the `Continuation` state `segment.ts` defines, in the
 *       same shape as the two scanners there (#215).
 *   F2  A NAMED-FUNCTION body (`:local`/`:global NAME do={…}`) is a CLOSURE:
 *       outer names read `parameter` inside it, and a global needs an in-body
 *       `:global NAME` re-import to read `global`. A control-flow `do={…}`
 *       (`:if`/`:foreach`/`:while`/`:do`) SHARES the enclosing scope; both
 *       spell `do={`, and the statement head is the distinguisher. The lab
 *       could not express this because a depth counter has no scope IDENTITY;
 *       this walker carries a scope stack, so it does. Modeling it moved
 *       holdout 99.85% → 99.97% and dev 98.50% → 99.73% at zero abstention
 *       cost. The ratified alternative — abstaining inside function bodies
 *       instead — measured 100.00% / 99.76% but at +1.7pp / +2.9pp abstention,
 *       so modeling won on the trade.
 *
 *   F6  A `[…]` substitution is a nested STATEMENT context, and the two
 *       positions it can appear in differ in SCOPE EXTENT (#201, was K1). The
 *       claim K1 carried was measured from a mid-statement bracket and
 *       generalized; CHR 7.23.2 splits them:
 *
 *         - a statement-LEADING `[` lets what it declares ESCAPE. `[:local b 1]`
 *           + `:put $b` reads `local`, and so does a `:global`. "Leading"
 *           survives indentation, a preceding `;`, and the lead of a `do={`
 *           body, and it composes: a lead bracket nested in a mid-statement one
 *           escapes INTO that bracket, not past it. (F6 called this TRANSPARENT.
 *           F7 corrects the mechanism: the bracket has its own scope and
 *           PROMOTES it outwards at the `]`. The two are indistinguishable until
 *           the enclosing scope already claims the name.)
 *         - a MID-statement `[` CONFINES what it declares — `:put [:local b 1]`
 *           + `:put $b` reads `parameter`. Globals are confined too, which is
 *           where K1 was most wrong (`:put [:global g 1]` does NOT escape; only
 *           the statement-leading spelling does).
 *
 *       Either way the bracket SHARES the enclosing bindings — it is not a
 *       closure — and the `]` RESUMES the interrupted statement instead of
 *       starting one (`:put [:put 1] :local v 1` declares nothing), which is why
 *       the statement state is saved and restored rather than reset. A `$[…]` in
 *       a string is the same context and can never be leading. `(` is NOT this:
 *       the device reads a directive inside parens as an ordinary expression
 *       term (`(:local v 1)` classes the `:local` text itself
 *       `variable-undefined`), so no statement context opens there.
 *
 *       Modeling it moved holdout abstention 4.53% → 4.25% and dev 6.27% →
 *       5.40%, at no precision cost. Two rules had to move to the HEAD branch to
 *       hold that: a `/`-sigilled head opens a menu path (S16) and a
 *       `find`/`where` head opens a filter region (S8). Both were previously
 *       written only on the general word path, and were unreachable from a head
 *       only because a bracket used to inherit its head from the enclosing
 *       statement; without them `[find comment=$tag]`, the corpus's commonest
 *       bracket, stopped reporting its field. That is #201's "one rule, one
 *       implementation" exactly.
 *
 *       F6 also composes with H4: the first position inside a `[` is
 *       statement-leading, so a `#` there opens a COMMENT — which then swallows
 *       the `]` and runs to the newline. CHR 7.23.2 agrees (`[# c<nl>…` classes
 *       `# c<nl>` `comment` in both spellings, while a mid-statement `#` is a
 *       hard `error`), so the declarations that follow such a `]` are real. The
 *       head-position `find` is device-grounded the same way
 *       (`/ip route<nl>find comment=x` reads `comment` `variable-local`).
 *
 *   F7  The FIRST declaration written directly in a scope CLAIMS the name for
 *       that scope (#201, was the K3 known limit). A later redeclaration in the
 *       same scope binds nothing — its own span still reads its own head's
 *       class, but every reference keeps the first one's:
 *
 *         :global v 1 / :local v 2 / :put $v   ->  the use is GLOBAL
 *         :local v 1 / :global v 2 / :put $v   ->  the use is LOCAL
 *
 *       K3 read the first row as "an earlier `:global` outranks a later
 *       `:local`". The second row shows it is not a precedence between the
 *       classes at all. Probing the extent of the real rule overturned three
 *       more things, all measured on CHR 7.23.2 AND 7.24rc2, which agreed on
 *       every row of the deciding round:
 *
 *         - A `:global` does NOT escape the `{…}` it was written in. S2 as
 *           ratified says it is visible for the remainder of the document;
 *           `:if (1=1) do={:global v 1}` + `:put $v` reads PARAMETER. `:global`
 *           and `:local` have IDENTICAL lexical visibility and differ only in
 *           the class they emit, so `bind` writes to the current scope and
 *           nowhere else. This is the only rule here the CORPUS reaches: it
 *           moved 4 dev occurrences, all onto the device's reading (a `:global`
 *           re-import inside a named-function body that used to leak out of it).
 *         - A statement-LEADING `[` PROMOTES rather than being transparent (see
 *           F6). Promotion is subject to the claim rule, which is the only thing
 *           that distinguishes the two: with `:global x 1` in force,
 *           `[:local x 2; :put $x]` reads the in-bracket use LOCAL and the use
 *           after the `]` GLOBAL.
 *         - Loop variables (S3) and the `:onerror` error variable (S18) bind in
 *           a STATEMENT scope that wraps the rest of the statement, body
 *           included. Neither the enclosing scope nor the body scope can hold
 *           them: an enclosing claim would swallow the binding (`:global i 1` +
 *           a loop over `i` still reads `auto` inside the body), and the body's
 *           own `:local i` has to be able to shadow it. `:onerror` ALSO claims
 *           the enclosing scope, which a loop variable does not — the device
 *           reads `$e` after `:onerror e …` as `local` but `$i` after
 *           `:foreach i …` as `parameter`.
 *
 *       The control that made all of this measurable: `request=highlight` is
 *       purely LEXICAL. Inspecting `:global zzz 1` does not change how a later
 *       inspect reads `$zzz`, and `/system/script/environment` stays empty
 *       throughout, so none of these readings are probe-ordering artifacts.
 *
 *       Modeling it moved dev precision 99.75% → 99.79% at unchanged abstention
 *       and unchanged `missed`, with holdout unchanged; a per-offset corpus diff
 *       against the pre-change module shows 4 changed occurrences on dev, all 4
 *       toward the device, none away, none dropped.
 *
 *   F8  A sigil is a DEFECT in menu-PATH position, not only at the statement
 *       lead (#201, was the K2 known limit). `/ip//address print` is a hard
 *       device error exactly like `//local foo 1`, and the walker now stops on
 *       both. Three device readings fix the shape:
 *
 *         - The region ENDS AT THE COMMAND, and the device does not end it at a
 *           verb. `/ip address zzzz //foo` is as clean as
 *           `/ip address print //foo`, while `/ip address //foo` — nothing
 *           having ended the path — errors. So the question is "is this word
 *           still a submenu?", which `menus.ts` (#207) answers; K2 read it as
 *           needing parser context that did not exist, when what it needed was
 *           the baked table.
 *         - WHICH BYTE errors depends on the sigil. A `/` is a legal separator
 *           when it is ADJACENT to the segment before it, so a doubled one errors
 *           on the second (`/ip//address` → offset 4); after a space it is
 *           already wrong, so `/ip /address` errors on the first (offset 4 too,
 *           for a different reason). A `:` is never legal in a path and errors on
 *           itself, doubled or not (`/ip:address` → offset 3).
 *         - A `:`-spelled head is a scripting directive and opens no path at all
 *           (`:put //foo`, `:put ::foo`, `:put :/foo` are clean), and so is a
 *           colon-less head the table does not know (`put //foo`).
 *
 *         - A token that cannot be a path segment ENDS the region. A digit-led
 *           object name is the one that matters: `/ip 1 //ip/address` is CLEAN
 *           on the device (`1` is `obj-inactive`, every later byte `none`) and
 *           only the RUNTIME rejects it — "bad command name 1 (line 1 column
 *           5)", at the `1`, never at the `//`. `$`, `"`, `(` and `[` there are
 *           hard errors on their own first byte, which this walker does not
 *           model, so it closes the region and stays silent rather than
 *           reporting a defect at the wrong offset.
 *
 *       `menus.ts` being a FLOOR is the safe direction: an unlisted menu closes
 *       the region and the defect goes unreported, rather than a valid script
 *       being truncated. Measured that way — 91/97 device rows, **0 false
 *       positives and 0 wrong offsets** — and over the whole 913-script frozen
 *       corpus **no file where this stops and the device is clean**. The 6
 *       remaining rows are device errors this walker does not model at all (the
 *       "argument before a command" error, which lands on the `=`, and the four
 *       non-path tokens above), every one of them the silent direction. The
 *       corpus moves no occurrence: the 14 files it newly stops in are
 *       non-RouterOS snippets (YAML, log text) that the device already rejects
 *       earlier, so they were past a cliff already.
 *
 *       The path-region guard came out of review. Without it the walker scored 7
 *       FALSE POSITIVES and 4 wrong offsets on those same rows — a defect stop on
 *       input the device's highlight reads clean, which is the one failure mode
 *       this rule may not have.
 *
 * Measured on the frozen split (`.scratch/explain-lab-partition.json`) against
 * the per-occurrence highlight streams for 7.23.2 AND 7.24rc2: **holdout 99.98%
 * precision on decided (6155/6156), 4.25% abstention, 14 missed; dev 99.79%
 * (8733/8751), 5.40%, 34 missed.**
 *
 * ONE KNOWN LIMIT is carried as measured, pinned by an explicit test and tracked
 * in the lexical-boundary issue (#201) rather than patched here:
 *
 *   K4  A BARE `$name-with-hyphen` reference never carries the hyphen on the
 *       device, whatever the document declared. `:global "set-dns" 1` +
 *       `:put $set-dns` ERRORS at the `-` and reads only `$set`
 *       (`variable-parameter`); the quoted spelling `$"set-dns"` is the one that
 *       resolves. S19 tries the FULL run first and so reports a confident
 *       `global` where the device errors. Pre-existing — the same rows fail
 *       identically on the pre-F7 module — and it belongs to S19/S11 rather than
 *       to scope resolution, so it is carried here and tracked on its own issue.
 *       (Numbered in the K series, not the S series: `S3` and `S4` are already
 *       taken by the rules above.)
 *
 * The scan is a single left-to-right pass with an explicit delimiter stack (no
 * recursion, Q17 posture) and never throws; structural surprises land in
 * `notes` with the same vocabulary the segmenter uses. Scope creation is capped
 * at `MAX_SCOPE_DEPTH` so pathological nesting cannot make lookup unbounded.
 */

import { analyzeCoordinates } from "./coordinates.ts";
import { type Defect, defectAt } from "./defects.ts";
import { isMenuPath } from "./menus.ts";
import type { Continuation } from "./segment.ts";

/** The five variable classes the console assigns. */
export type SymbolClass =
	| "local"
	| "global"
	| "auto"
	| "parameter"
	| "undefined";

/**
 * Device highlight token-class name for each class, for callers comparing
 * against `/console/inspect request=highlight` output.
 *
 * `undefined` is present for completeness of the device vocabulary: this
 * resolver never emits it offline (the ratified Q13 answer), it abstains
 * instead.
 */
export const HIGHLIGHT_CLASS: Record<SymbolClass, string> = {
	local: "variable-local",
	global: "variable-global",
	auto: "variable-auto",
	parameter: "variable-parameter",
	undefined: "variable-undefined",
};

/** One located variable occurrence — a declaration or a reference. */
export interface SymbolOccurrence {
	/** analyzed-byte offset, inclusive. */
	start: number;
	/** analyzed-byte offset, exclusive. */
	end: number;
	/**
	 * the symbol's name — the key it binds/resolves as, which is NOT always the
	 * span's text: a quoted declaration's span includes its quotes (S11) and a
	 * `$octive-1` span stops at the resolving prefix (S19). Slice `start`/`end`
	 * out of the original for display text. Names are read off the `analyzed`
	 * surface, so a non-ASCII byte in a name reads as the `SUB` placeholder.
	 */
	name: string;
	/** true when written with the `$` sigil. */
	sigil: boolean;
	/** true at the declaration site, false at a use. */
	declaration: boolean;
	/** resolved class, or null where offline must abstain (S7/S8/S10). */
	cls: SymbolClass | null;
	/** why the resolver abstained, or how the reference was read. */
	note?: string;
}

export interface SymbolAnalysis {
	occurrences: SymbolOccurrence[];
	/** structural notes; never a throw. */
	notes: string[];
	/** The same structural surprises as {@link notes}, each located. */
	defects: Defect[];
}

interface Binding {
	cls: SymbolClass;
	/** analyzed-byte offset from which the binding is visible. */
	from: number;
}

interface Scope {
	/** true for a named-function body: a closure boundary (F2). */
	closure: boolean;
	/**
	 * At most ONE binding per name: the FIRST declaration written directly in
	 * this scope CLAIMS the name and no later one in the same scope rebinds it
	 * (F7).
	 */
	bindings: Map<string, Binding>;
}

/**
 * Statement state saved at a `[`, restored at its `]` (F6).
 *
 * A bracket is a nested STATEMENT context, so the walk resets the statement
 * bookkeeping on the way in; the enclosing statement has to survive that, since
 * a `]` resumes it rather than starting a new one.
 */
interface BracketFrame {
	head: string | null;
	filterDepth: number | null;
	inMenuPath: boolean;
	pendingSetTarget: boolean;
	pendingErrVar: boolean;
	pendingDecl: SymbolClass | null;
	pendingLoopVars: boolean;
	declaredHere: boolean;
	headSigil: ":" | "/" | "";
	cont: Continuation;
	contLineStart: boolean;
	/** the scope this bracket pushed, or null when the depth cap refused one. */
	scope: Scope | null;
	/** statement-LEADING: its claims are PROMOTED to the enclosing scope (F7). */
	lead: boolean;
	/** F8 — the enclosing statement's menu-path state. */
	pathSegments: string[];
	pathOpen: boolean;
}

/**
 * F7 — `:foreach`/`:for` loop variables and the `:onerror` error variable bind
 * in a scope of their own that wraps the rest of the STATEMENT, body included,
 * and pops with it.
 *
 * Neither the enclosing scope nor the body scope can hold them: an enclosing
 * claim would swallow the binding (`:global i 1` + a loop over `i` still reads
 * `auto` inside the body), and the body's own `:local i` has to be able to
 * shadow it (`:foreach i … do={:local i 9; :put $i}` reads `local`).
 */
interface StatementScope {
	scope: Scope;
	/** delimiter depth of the binding head; the scope pops at a reset back here. */
	depth: number;
}

/** Heads that declare a name in their next word. */
const DECL: Record<string, SymbolClass> = { local: "local", global: "global" };
/** Heads whose leading words are loop variables (S3). */
const LOOP_HEADS: ReadonlySet<string> = new Set(["foreach", "for"]);
/** Heads that bind an error variable in their next word (S18). */
const ERRVAR_HEADS: ReadonlySet<string> = new Set(["onerror"]);
/**
 * Words that open a filter/query region where bare identifiers are menu fields
 * (S8). `where` is the documented one; `find` takes the same shorthand.
 */
const FILTER_WORDS: ReadonlySet<string> = new Set(["where", "find"]);
/** Operator keywords the console tokenizes as `syntax-meta`, not symbols (S17). */
const OPERATOR_WORDS: ReadonlySet<string> = new Set(["or", "and", "not", "in"]);

/**
 * Scope-stack cap.
 *
 * Not a RouterOS limit — the same resource guard `segment.ts` applies to
 * container frames. Beyond this depth a `{` still tracks as a delimiter but
 * opens no new scope (inner declarations join the innermost one) and `notes`
 * carries `over-depth:<analyzed-byte-offset>`, so lookup stays bounded on
 * adversarial input.
 */
const MAX_SCOPE_DEPTH = 256;

const isIdent = (c: string): boolean => /[A-Za-z0-9_.-]/.test(c);
const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);

/** Resolve every variable occurrence in `original`. Never throws. */
export function resolveSymbols(original: string): SymbolAnalysis {
	const analysis = analyzeCoordinates(original);
	// `analyzed` is pure ASCII, so a string built from it has index === byte.
	const text = new TextDecoder().decode(analysis.analyzed);

	// S7's "inside a `(…)` expression" test, precomputed in one forward pass.
	// Scanning backward per bare word was O(n²) on a long single-line script: an
	// unmatched `)` kept the scan from stopping at the newline, so it could run
	// back to offset 0 for every word. This table is line-scoped, which is what
	// the rule says and what the backward scan did on balanced input.
	const openParen = parenMap(text);

	const occurrences: SymbolOccurrence[] = [];
	const notes: string[] = [];
	const defects: Defect[] = [];
	const root: Scope = { closure: false, bindings: new Map() };
	const scopes: Scope[] = [root];
	/** F6 — saved statement state per open `[`, innermost last. */
	const brackets: BracketFrame[] = [];
	/** F7 — open statement scopes (loop / error variables), innermost last. */
	const statementScopes: StatementScope[] = [];
	/**
	 * open delimiters, innermost last; `"` is a string frame. Each carries WHERE
	 * it opened so an `unclosed`/`unterminated-string` defect can point at the
	 * opener instead of at end-of-input (#192).
	 */
	const frames: { char: "{" | "[" | "(" | '"'; at: number }[] = [];
	/** bracket/brace nesting, strings excluded (the S8 filter region uses it). */
	let depth = 0;
	/** `{` opens past the cap that pushed no scope; their `}` must not pop one. */
	let suppressedScopes = 0;
	let overDepth = false;
	/** a malformed escape ended the analysis (the device errors out there). */
	let defect = false;

	/** lowercased leading word of the current statement. */
	let head: string | null = null;
	/** depth at which a filter word opened its region, or null. */
	let filterDepth: number | null = null;
	let pendingDecl: SymbolClass | null = null;
	let pendingLoopVars = false;
	/** inside a space-separated menu path run, where bare words are `dir` (S16). */
	let inMenuPath = false;
	/**
	 * F8 — the menu-path segments read so far in this statement, and whether the
	 * console would still be reading the PATH at this point.
	 *
	 * Deliberately NOT `inMenuPath`, which answers a different question (is this
	 * bare word a symbol?) and stays true past the verb to the end of the
	 * statement. The defect rule needs the narrower region that ENDS at the
	 * command, so it accumulates segments and asks `menus.ts`.
	 */
	let pathSegments: string[] = [];
	let pathOpen = false;
	let pendingSetTarget = false;
	let pendingErrVar = false;
	/** this statement declared a name, so a `do={` it opens is a closure (F2). */
	let declaredHere = false;
	/** the sigil the statement head was written with: `:`, `/`, or none. */
	let headSigil: ":" | "/" | "" = "";
	/** H4 — still before the first real token of the current statement? */
	let atLead = true;
	/** H5 — how far the pending `\<newline>` continuation still reaches (#215). */
	let cont: Continuation = "none";
	/** H5 — at the immediate start of a line the continuation carried into? */
	let contLineStart = false;

	/**
	 * F7 — drop every statement scope whose statement cannot still be running at
	 * the current depth. A reset INSIDE the body (its newlines, its `{`) must not
	 * take one down, which is why the depth of the binding head is what decides.
	 */
	const unwindStatementScopes = (): void => {
		while (statementScopes.length > 0) {
			const top = statementScopes[statementScopes.length - 1] as StatementScope;
			if (top.depth < depth) return;
			statementScopes.pop();
			if (scopes[scopes.length - 1] === top.scope) scopes.pop();
		}
	};

	/**
	 * F7 — open the scope a statement binds its own variables in, once per
	 * statement (`:foreach k,v in=…` shares one).
	 */
	const openStatementScope = (at: number): void => {
		const top = statementScopes[statementScopes.length - 1];
		if (top !== undefined && top.depth === depth) return;
		if (scopes.length >= MAX_SCOPE_DEPTH) {
			if (!overDepth) {
				overDepth = true;
				notes.push(`over-depth:${at}`);
				defects.push(defectAt("over-depth", at));
			}
			return;
		}
		const scope: Scope = { closure: false, bindings: new Map() };
		scopes.push(scope);
		statementScopes.push({ scope, depth });
	};

	const resetStatement = (): void => {
		unwindStatementScopes();
		head = null;
		filterDepth = null;
		inMenuPath = false;
		pendingSetTarget = false;
		pendingErrVar = false;
		pendingDecl = null;
		pendingLoopVars = false;
		declaredHere = false;
		headSigil = "";
		cont = "none";
		contLineStart = false;
		pathSegments = [];
		pathOpen = false;
	};

	/**
	 * Nearest visible binding for `name` at `at`, innermost scope first. The
	 * search STOPS at a closure boundary (F2): a named-function body cannot see
	 * the names around it.
	 */
	const lookup = (name: string, at: number): Binding | null => {
		for (let s = scopes.length - 1; s >= 0; s--) {
			const scope = scopes[s] as Scope;
			const b = scope.bindings.get(name);
			// A claim that has not been reached yet does not hide the enclosing
			// binding: in `:global v 1` + `{:put $v; :local v 2; :put $v}` the device
			// reads the first in-body use `global` and the second `local`.
			if (b !== undefined && b.from <= at) return b;
			if (scope.closure) return null;
		}
		return null;
	};

	/**
	 * F7 — the FIRST declaration written directly in a scope claims the name.
	 * Returns false when the scope already had it, which is not an error: the
	 * declaration's own span still records its own head's class, it just binds
	 * nothing.
	 */
	const claim = (
		scope: Scope,
		name: string,
		cls: SymbolClass,
		from: number,
	): boolean => {
		if (scope.bindings.has(name)) return false;
		scope.bindings.set(name, { cls, from });
		return true;
	};

	// Case matters: RouterOS variable resolution is CASE-SENSITIVE (`:local
	// UserName` then `$username` reads `parameter` on the device, not local), so
	// binding keys are never folded.
	//
	// F7 — `:global` and `:local` bind IDENTICALLY: current scope, from here on,
	// not escaping the enclosing `{…}`. Only the class they emit differs.
	const bind = (name: string, cls: SymbolClass, from: number): void => {
		claim(scopes[scopes.length - 1] as Scope, name, cls, from);
	};

	/**
	 * F6/F7 — enter a `[`. Saves the enclosing statement, opens a nested
	 * statement context, and pushes a scope. EVERY bracket gets one: a
	 * statement-LEADING bracket differs only in what happens at the `]`, where
	 * its claims are promoted outwards.
	 */
	const openBracket = (lead: boolean, at: number): void => {
		const frame: BracketFrame = {
			head,
			filterDepth,
			inMenuPath,
			pendingSetTarget,
			pendingErrVar,
			pendingDecl,
			pendingLoopVars,
			declaredHere,
			headSigil,
			cont,
			contLineStart,
			scope: null,
			lead,
			pathSegments,
			pathOpen,
		};
		if (scopes.length >= MAX_SCOPE_DEPTH) {
			if (!overDepth) {
				overDepth = true;
				notes.push(`over-depth:${at}`);
				defects.push(defectAt("over-depth", at));
			}
		} else {
			const scope: Scope = { closure: false, bindings: new Map() };
			scopes.push(scope);
			frame.scope = scope;
		}
		brackets.push(frame);
		resetStatement();
	};

	/**
	 * F6/F7 — leave a `]`. `atLead` is deliberately NOT restored: the H4
	 * bookkeeping already cleared it for this character, and the device agrees
	 * that a `]` resumes the enclosing statement rather than starting one
	 * (`:put [:put 1] :local v 1` declares nothing).
	 */
	const closeBracket = (): void => {
		const frame = brackets.pop();
		if (frame === undefined) return;
		if (frame.scope !== null && scopes[scopes.length - 1] === frame.scope) {
			scopes.pop();
			// F7 — a statement-LEADING bracket runs at the enclosing level, so what
			// it declared escapes: each claim is re-offered outwards, and the claim
			// rule decides. A name the enclosing scope already holds keeps its
			// class, which is the whole lead-vs-mid difference once a conflict
			// exists (`:global x 1` + `[:local x 2; :put $x]` reads the in-bracket
			// use `local` and the one after the `]` `global`).
			if (frame.lead) {
				const outer = scopes[scopes.length - 1] as Scope;
				for (const [name, b] of frame.scope.bindings)
					claim(outer, name, b.cls, b.from);
			}
		}
		head = frame.head;
		filterDepth = frame.filterDepth;
		inMenuPath = frame.inMenuPath;
		pendingSetTarget = frame.pendingSetTarget;
		pendingErrVar = frame.pendingErrVar;
		pendingDecl = frame.pendingDecl;
		pendingLoopVars = frame.pendingLoopVars;
		declaredHere = frame.declaredHere;
		headSigil = frame.headSigil;
		cont = frame.cont;
		contLineStart = frame.contLineStart;
		pathSegments = frame.pathSegments;
		pathOpen = frame.pathOpen;
	};

	/** Record a `$`-sigilled reference, applying S5/S6/S19. */
	const pushRef = (
		r: { start: number; end: number; name: string },
		note?: string,
	): void => {
		if (/^\d+$/.test(r.name)) {
			// S6 — `$0`, `$1`, … are positional parameters.
			occurrences.push({
				start: r.start,
				end: r.end,
				name: r.name,
				sigil: true,
				declaration: false,
				cls: "parameter",
				note,
			});
			return;
		}
		let name = r.name;
		let end = r.end;
		let binding = lookup(name, r.start);
		// S19 — a greedy scan takes `octive-1` where the device reads the variable
		// `octive` and the subtraction operator. The document's own declarations
		// break the tie without a schema: if the full run does not resolve but a
		// prefix ending at a `-` does, the reference is that prefix.
		// Only the bare `$name` form has span === name text; `$"quoted-name"` and
		// `${…}` start their span on the delimiter, so a prefix cut there would
		// land inside the quotes. Gate on the two agreeing.
		const spanIsName = r.end - r.start === r.name.length;
		if (binding === null && spanIsName && name.includes("-")) {
			for (
				let cut = name.lastIndexOf("-");
				cut > 0;
				cut = name.lastIndexOf("-", cut - 1)
			) {
				const prefix = name.slice(0, cut);
				const hit = lookup(prefix, r.start);
				if (hit !== null) {
					binding = hit;
					name = prefix;
					end = r.start + prefix.length;
					break;
				}
			}
		}
		occurrences.push({
			start: r.start,
			end,
			name,
			sigil: true,
			declaration: false,
			// S5 — no visible declaration is `parameter`, matching the console.
			cls: binding === null ? "parameter" : binding.cls,
			note,
		});
	};

	const record = (
		start: number,
		end: number,
		name: string,
		cls: SymbolClass | null,
		declaration: boolean,
		note?: string,
	): void => {
		occurrences.push({
			start,
			end,
			name,
			sigil: false,
			declaration,
			cls,
			note,
		});
	};

	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;

		// --- inside a double-quoted string --------------------------------------
		if (frames[frames.length - 1]?.char === '"') {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === '"') {
				frames.pop();
				continue;
			}
			if (c === "$") {
				const next = text[i + 1];
				if (next === "[" || next === "(") {
					// F1 — a substitution inside a string is CODE. Push its frame and
					// keep scanning normally; the matching close pops back into the
					// string. A scan that swallowed this as string bytes would flip
					// its quote phase on the first nested string and lose every
					// binding after it.
					frames.push({ char: next, at: i + 1 });
					depth++;
					if (next === "[") {
						// F6 — and it is a statement context like any other `[`. A `$[`
						// can never be statement-LEADING (a string opened it), so it is
						// always the confining, mid-statement form.
						openBracket(false, i + 1);
						atLead = true;
					}
					i++;
					continue;
				}
				const r = readRef(text, i, true);
				if (r !== null) {
					// S9 — interpolated references classify like any other.
					pushRef(r, "in-string");
					i = r.next - 1;
				}
			}
			continue;
		}

		// H5 continuation reach (#215) — decided BEFORE the bookkeeping below, so an
		// indented `#` mid-continuation stays content. See `Continuation`.
		const inCont = cont !== "none";
		const contComment = c === "#" && inCont && contLineStart;
		if (inCont && !contComment) {
			if (c === " " || c === "\t" || c === "\r") {
				contLineStart = false;
			} else if (c === "\n" && cont === "escape") {
				// A blank line inside the `\` run is still the run: the statement, its
				// head and its pending declaration all survive it.
				contLineStart = true;
				continue;
			} else {
				// Real content, or the blank line that spends a comment run's reach —
				// which then ends the statement in the newline branch below.
				cont = "none";
				contLineStart = false;
			}
		}

		// --- H5 line continuation and escape validity ---------------------------
		//
		// In CODE a backslash is valid ONLY before whitespace (CHR 7.23.2:
		// `:put \\ $v` and `:put \\<tab>$v` are clean, `:put \\a`, `:put \\$v` and
		// `:put \\\\ $v` all raise a hard `error`). Before a newline it is the H5
		// CONTINUATION, so the statement head, the pending declaration and
		// `declaredHere` — which decides whether the next `do={` opens a closure —
		// must all survive it.
		//
		// Anything else is a malformed escape. The device dies there and classes
		// every later byte `none`, so this resolver stops too: it records
		// `bad-escape:<offset>` and reports nothing further, rather than carrying
		// confident classes across a boundary the console never crossed. Occurrences
		// BEFORE the defect stand (the lab's X1 rule).
		if (c === "\\") {
			const kind = escapeKind(text, i);
			if (kind === "continuation") {
				// `atLead` survives: on CHR 7.23.3 `do={\` + newline + `:local x 1`
				// still reads `:local` as the head and declares `x` (#215).
				cont = "escape";
				contLineStart = true;
				i += text[i + 1] === "\r" ? 2 : 1;
				continue;
			}
			if (kind === "whitespace") {
				i += 1;
				continue;
			}
			notes.push(`bad-escape:${i}`);
			defects.push(defectAt("bad-escape", i));
			defect = true;
			break;
		}

		// --- comments: `#` in statement-leading position (Q1 rule H4) ------------
		//
		// Done inline rather than through `segment.ts`'s shared `maskComments`:
		// this walk needs the substitution's code CLASSIFIED, not skipped, and it
		// already carries the frame stack for that. Pre-masking measured 98.50% dev
		// where this reads 99.59% — the F1 defect behind that gap (a `$[…]` with a
		// nested string flipping the quote phase, so every later `#` line read as
		// string content) is now fixed in the shared scanner too, via the same
		// frame model (#199); the two must stay in step.
		if (c === "#" && (atLead || contComment)) {
			while (i < text.length && text[i] !== "\n") i++;
			if (contComment) {
				// H5 — the comment line does not end the statement: the head, the
				// pending declaration and `declaredHere` all survive it. The loop's
				// i++ steps over the newline so it cannot reset anything either.
				cont = "comment";
				contLineStart = true;
			} else {
				atLead = true;
				resetStatement();
			}
			continue;
		}
		// H4 bookkeeping. `leadBefore` is the value for the character ABOUT to be
		// read, which is what decides whether a word is the statement HEAD.
		const leadBefore = atLead;
		// F6 — a `[` opens a nested statement context, so the word after it is a
		// HEAD. `(` does not: the device reads a directive there as an ordinary
		// expression term (`(:local v 1)` classes `:local` itself
		// `variable-undefined`), which is why only the bracket is listed here.
		if (c === ";" || c === "\n" || c === "{" || c === "[") atLead = true;
		else if (c !== " " && c !== "\t" && c !== "\r") atLead = false;

		// F8 — anything that cannot be a path token ENDS the path region, so no
		// defect may be reported past it. A digit-led object name is the case that
		// matters: `/ip 1 //ip/address` is CLEAN on CHR 7.23.2 (`1` is
		// `obj-inactive`, every later byte `none`) and only the RUNTIME rejects it,
		// at the `1` — "bad command name 1 (line 1 column 5)" — never at the `//`.
		// Reporting the `//` there was a false positive against the very oracle
		// this module is scored on. The same holds for `1.1.1.1`, `-1` and a `:`
		// following any of them.
		//
		// `$`, `"`, `(` and `[` in path position are hard device ERRORS on their
		// own first byte, which this walker does not model; closing the region
		// there keeps it silent rather than reporting a defect at the wrong offset.
		// Word characters never reach here — the word branch consumes them — and
		// `\` is the H5 continuation, which a path survives.
		if (
			pathOpen &&
			!isIdentStart(c) &&
			c !== ":" &&
			c !== "/" &&
			c !== " " &&
			c !== "\t" &&
			c !== "\r" &&
			c !== "\\"
		)
			pathOpen = false;

		if (c === '"') {
			// S11 — a QUOTED declaration name. `:global "set-dns" do={…}` declares
			// `set-dns`, and the console carries the class across the quotes, so the
			// span includes them. Without this the string is skipped and the next
			// bare word (`do`) is declared instead.
			if (pendingDecl !== null || pendingLoopVars || pendingErrVar) {
				const close = text.indexOf('"', i + 1);
				if (close > i) {
					const name = text.slice(i + 1, close);
					// F7 — a quoted name binds exactly like a bare one, and the three
					// binding heads differ. Routing them all through `bind` in the
					// enclosing scope (what this branch used to do) broke every F7 rule
					// for the quoted spelling, device-verified on CHR 7.23.2:
					// `:foreach "i" …` + `$"i"` reads `parameter` after the statement,
					// an enclosing `:global i` does not swallow the in-body `auto`, and
					// `:for "i" … do={$"i"}` reads `auto` — so `declaredHere`, which
					// makes the following `do={` an F2 closure, belongs to a
					// `:local`/`:global` declaration ONLY. `:onerror` was not accepted
					// here at all, so its `pendingErrVar` survived to the next bare
					// word and declared `in`.
					const cls: SymbolClass =
						pendingDecl ?? (pendingErrVar ? "local" : "auto");
					if (pendingDecl !== null) {
						bind(name, cls, i + 1);
						pendingDecl = null;
						declaredHere = true;
					} else {
						// F7 — statement scope, and for `:onerror` the enclosing claim
						// too. Same order as the bare paths: claim before the statement
						// scope exists.
						if (pendingErrVar)
							claim(scopes[scopes.length - 1] as Scope, name, "local", i + 1);
						openStatementScope(i + 1);
						bind(name, cls, i + 1);
						pendingErrVar = false;
					}
					// The span includes the quotes; the NAME does not.
					record(i, close + 1, name, cls, true);
					i = close;
					continue;
				}
			}
			frames.push({ char: '"', at: i });
			continue;
		}

		if (c === "{" || c === "[" || c === "(") {
			frames.push({ char: c, at: i });
			depth++;
			if (c === "[") openBracket(leadBefore, i);
			if (c === "{") {
				if (scopes.length >= MAX_SCOPE_DEPTH) {
					suppressedScopes++;
					if (!overDepth) {
						overDepth = true;
						notes.push(`over-depth:${i}`);
						defects.push(defectAt("over-depth", i));
					}
				} else {
					// F2 — `:local F do={…}` opens a closure; `:if … do={…}` does not.
					// Both spell `do={`; the declaring statement head decides.
					scopes.push({
						closure: declaredHere && argNameBefore(text, i) === "do",
						bindings: new Map(),
					});
				}
				resetStatement();
			}
			continue;
		}
		if (c === "}" || c === "]" || c === ")") {
			const want = c === "}" ? "{" : c === "]" ? "[" : "(";
			// F7 — a statement scope opened INSIDE this delimiter ends with it, and
			// it sits above the scope this close is about to pop, so it comes down
			// first. `depth` is still the inner value here (it decrements below).
			if (frames[frames.length - 1]?.char === want) unwindStatementScopes();
			if (frames[frames.length - 1]?.char !== want) {
				// A mismatched close is not a close: popping it would unwind a real
				// enclosing scope and drop its bindings early. `segment.ts` takes the
				// same line — report it and treat the character as content.
				notes.push(`unbalanced-close:${c}`);
				defects.push(defectAt("unbalanced-close", i, c));
				continue;
			}
			frames.pop();
			if (filterDepth !== null && depth <= filterDepth) filterDepth = null;
			// F6 — restore the statement the `[` interrupted, and drop the bracket's
			// scope. Ordered after the `filterDepth` clear on purpose: the saved
			// value is the enclosing region, which outlives this bracket.
			if (c === "]") closeBracket();
			if (c === "}") {
				// S1 — locals declared inside this brace scope go out of view.
				if (suppressedScopes > 0) suppressedScopes--;
				else if (scopes.length > 1) scopes.pop();
				resetStatement();
			}
			if (depth > 0) depth--;
			continue;
		}

		if (c === ";" || c === "\n") {
			resetStatement();
			continue;
		}

		// --- `$` reference --------------------------------------------------------
		if (c === "$") {
			const r = readRef(text, i, false);
			if (r !== null) {
				pushRef(r);
				i = r.next - 1;
			}
			continue;
		}

		// --- bare word ------------------------------------------------------------
		if (isIdentStart(c) || c === ":" || c === "/") {
			const start = i;
			// `:` and `/` are sigils/path characters, not part of the word.
			let j = i;
			while (j < text.length && (text[j] === ":" || text[j] === "/")) j++;
			const wordStart = j;
			while (j < text.length && isIdent(text[j] as string)) j++;
			const word = text.slice(wordStart, j);
			const lower = word.toLowerCase();
			const sigilRun = wordStart - start;
			i = j - 1;
			// A sigil RUN at statement start is a hard device error — `//local`,
			// `::put`, `:/local` and a bare `//` all error at the second character
			// and class every later byte `none`. Checked BEFORE the empty-word exit,
			// because `//` on its own carries no word and would otherwise slip past.
			// Inside a value a doubled slash is ordinary text (`url=http://example.com`,
			// `comment=a//b`, `:put //foo`), so this gate is statement-leading only.
			// The MID-statement form (`/ip//address`) is a defect too, but only in
			// menu-path position — F8 below decides that, and the value forms above
			// stay clean because the path region has already closed by then.
			if (leadBefore && sigilRun > 1) {
				notes.push(`bad-sigil:${start + 1}`);
				defects.push(defectAt("bad-sigil", start + 1));
				defect = true;
				break;
			}
			// F8 — the same failure MID-statement, now that the walker can tell
			// path position from the rest. Only inside the path region (see
			// `pathOpen`), and the offending byte differs by which sigil it is:
			// a `/` is a legal SEPARATOR when it is adjacent to the segment before
			// it, so the error lands on the second one; after a space it is already
			// wrong, so it lands on the first. A `:` is never legal in a path.
			if (pathOpen && sigilRun > 0) {
				const adjacent = start > 0 && !/\s/.test(text[start - 1] as string);
				const at =
					text[start] === ":" || !adjacent
						? start
						: sigilRun > 1
							? start + 1
							: -1;
				if (at >= 0) {
					notes.push(`bad-sigil:${at}`);
					defects.push(defectAt("bad-sigil", at));
					defect = true;
					break;
				}
			}
			if (word === "") continue;

			// A directive head must be at STATEMENT START. `head === null` alone is
			// not that test: nothing before it sets `head`, so after a dynamic
			// command (`$fn local foo 1`) or a bracket the next word looked like a
			// head and fabricated a declaration. CHR 7.23.2 classes `local`/`foo`
			// there as `none` and the later `$foo` as `variable-parameter`.
			//
			// The sigil run must also be zero or one character: `//local foo 1` and
			// `/:local foo 1` are device errors (every byte `none`), not
			// declarations.
			if (head === null && leadBefore && sigilRun <= 1) {
				head = lower;
				// The sigil on a scripting head is OPTIONAL — in BOTH directions.
				// Q2 grounded the colon-less form for body-taking directives
				// (`do {` ≡ `:do {`), and CHR 7.23.2 classes `local foo 1`,
				// `global foo 1`, `foreach i in={1} do={…}` and `for i from=1 …`
				// exactly like their `:`-spelled twins. The `/` spelling binds too,
				// because these directives ARE root commands (`/global g 1` →
				// `g` = `variable-global`) — the same root vocabulary `write.ts`
				// froze as ROOT_CMDS. A DEEPER path is unaffected: `/ip/local foo 1`
				// and `/interface local foo 1` make `local` an `obj-inactive` menu
				// item, and there the head word is `ip`/`interface`, not `local`.
				headSigil = text[start] === ":" ? ":" : text[start] === "/" ? "/" : "";
				// S16 — a `/`-sigilled HEAD opens a menu path just as a `/`-sigilled
				// later word does, so the space-separated segments after it are `dir`,
				// not symbols. The rule lived only on the non-head path below, which
				// was invisible while a bracket inherited its head from the enclosing
				// statement; once `[` opens its own statement context (F6) the first
				// word inside IS the head, and `[/interface list find …]` started
				// abstaining on `list`.
				if (headSigil === "/") inMenuPath = true;
				// F8 — the DEFECT region opens only on a head the baked menu table
				// recognizes, whatever its sigil. A `:`-spelled head is a scripting
				// directive, never a path (`:put //foo` and `:put ::foo` are clean on
				// the device), and a `/`-spelled head that is not a known menu — the
				// `/global g 1` form F3 grounds — is a command, not navigation. The
				// table being a FLOOR is the safe direction here: an unlisted menu
				// closes the region and the defect simply goes unreported.
				if (headSigil !== ":" && isMenuPath([lower])) {
					pathSegments = [lower];
					pathOpen = true;
				}
				if (DECL[lower] !== undefined) pendingDecl = DECL[lower] as SymbolClass;
				else if (LOOP_HEADS.has(lower)) pendingLoopVars = true;
				else if (lower === "set") pendingSetTarget = true;
				else if (ERRVAR_HEADS.has(lower)) pendingErrVar = true;
				// S8 — `find`/`where` open a filter region from HEAD position too.
				// `[find comment=$tag]` is the commonest shape of the whole corpus and
				// its `find` only became a head once `[` started a statement context
				// (F6); before that the bracket inherited the enclosing head, so this
				// branch never saw a filter word and the region was opened below.
				else if (FILTER_WORDS.has(lower)) filterDepth = depth;
				continue;
			}

			const prevChar = prevNonSpace(text, start);
			const isValue = prevChar === "=" || prevChar === ",";
			const sigilled = wordStart > start;

			// F8 — extend or CLOSE the path region. The device ends it at the first
			// word that is not a known submenu of the path so far, whether or not
			// that word is a verb: `/ip address zzzz //foo` is clean exactly like
			// `/ip address print //foo`, while `/ip address //foo` — nothing having
			// ended the path — is a hard error. An `arg=value` also ends it (the
			// device rejects an argument before a command outright), which keeps
			// the `://` inside a `url=` value out of path position no matter how the
			// menu table reads the words before it.
			if (pathOpen) {
				if (isValue || nextNonSpace(text, j) === "=") pathOpen = false;
				else if (isMenuPath([...pathSegments, lower])) pathSegments.push(lower);
				else pathOpen = false;
			}

			// S10 — `:set NAME` is a REFERENCE carrying the class NAME was declared
			// as. On an undeclared name the device raises a hard error, which is not
			// a class at all, so abstain rather than invent one.
			if (head === "set" && pendingSetTarget) {
				pendingSetTarget = false;
				const binding = lookup(word, start);
				// Spelling decides what an unresolved target means on the device:
				// `set foo 2` with no `foo` in scope is the MENU verb `set` and the
				// device reports no variable at all, while `:set`/`/set` are the
				// scripting command and report a hard `error` — not a class either,
				// so those abstain (S10) instead of inventing one.
				if (binding === null && headSigil === "") continue;
				record(
					wordStart,
					j,
					word,
					binding === null ? null : binding.cls,
					false,
					binding === null
						? "S10 :set on an undeclared name — the device raises a hard error here"
						: undefined,
				);
				continue;
			}

			// S18 — the error variable of `:onerror NAME {…}`.
			if (pendingErrVar) {
				pendingErrVar = false;
				// F7 — it binds TWICE, and the two are separable on the device: a
				// statement scope makes it `local` inside the body even when the
				// enclosing scope already claims the name (`:global e 1` + `:onerror
				// e … do={:put $e}` reads the use `local`), while a claim on the
				// enclosing scope is what keeps it visible AFTER the statement
				// (`:onerror e …` + `:put $e` reads `local`, where the same shape
				// with a loop variable reads `parameter`). Order matters: the claim
				// is offered to the ENCLOSING scope, before the statement scope
				// exists.
				claim(scopes[scopes.length - 1] as Scope, word, "local", wordStart);
				openStatementScope(wordStart);
				bind(word, "local", wordStart);
				record(wordStart, j, word, "local", true);
				continue;
			}

			// S1/S2 — this word is the declared name.
			if (pendingDecl !== null) {
				bind(word, pendingDecl, wordStart);
				record(wordStart, j, word, pendingDecl, true);
				pendingDecl = null;
				declaredHere = true;
				continue;
			}

			// S3 — `:foreach k,v in=…`: every word before `in=`/`from=` is a loop
			// variable.
			if (pendingLoopVars) {
				if (lower === "in" || lower === "from") {
					pendingLoopVars = false;
					continue;
				}
				// F7 — loop variables get a scope of their own, wrapping the rest of
				// the statement including its body.
				openStatementScope(wordStart);
				bind(word, "auto", wordStart);
				record(wordStart, j, word, "auto", true);
				continue;
			}

			if (FILTER_WORDS.has(lower)) {
				filterDepth = depth;
				continue;
			}

			// S8 — inside a filter/query region EVERY bare identifier is a menu
			// field, not only the `field=value` form: `[find … !ca (common-name or
			// subject-alt-name)]` and the bare flag in `[find running]` are all
			// `variable-local` on the device. Schema-dependent, so abstain.
			if (
				filterDepth !== null &&
				!isValue &&
				!sigilled &&
				!isLiteralWord(lower) &&
				!OPERATOR_WORDS.has(lower)
			) {
				record(wordStart, j, word, null, false, FILTER_NOTE);
				continue;
			}

			// A bare word followed by `=` is an argument NAME, not a symbol — except
			// inside a `(…)` expression, where `word = value` is a COMPARISON and the
			// left side is a symbol position (the device's own `variable-undefined`
			// example is `(lppp=0)` in an `:if` condition). Abstain there rather than
			// stay silent, so a caller still learns a symbol is present.
			if (nextNonSpace(text, j) === "=") {
				if (
					filterDepth !== null ||
					(!sigilled && !isLiteralWord(lower) && openParen[start] === 1)
				)
					record(wordStart, j, word, null, false, FILTER_NOTE);
				continue;
			}

			// S16 — a bare word CONTINUING a space-separated menu path is a path
			// segment (`/interface list find`), which the S12 sigil rule alone
			// cannot see because only the first segment carries the `/`.
			if (sigilled && text[start] === "/") inMenuPath = true;
			else if (
				isValue ||
				prevChar === "[" ||
				prevChar === "(" ||
				prevChar === null
			)
				inMenuPath = false;
			if (inMenuPath) continue;
			// S17 — operator keywords are `syntax-meta`, never symbols. Schema-free
			// and knowable, so they are excluded outright rather than abstained.
			if (OPERATOR_WORDS.has(lower)) continue;
			// S7/S12/S13/S15 — only inside an expression or a filter region does the
			// console treat a bare word as a symbol at all; a sigilled word is a
			// directive or path segment, a literal is a value, and a word right
			// after `=`/`,` is a value.
			if (
				!sigilled &&
				!isValue &&
				!isLiteralWord(lower) &&
				depth > 0 &&
				(filterDepth !== null || openParen[start] === 1)
			) {
				const binding = lookup(word, start);
				record(
					wordStart,
					j,
					word,
					binding === null ? null : binding.cls,
					false,
					// S7 — a resolved binding is asserted (that part is lexical and
					// scored 100% precision); an unresolved bare word is NOT called
					// `undefined`, because menu field vs unbound name needs a schema.
					binding === null ? BARE_WORD_NOTE : undefined,
				);
			}
		}
	}

	if (!defect && frames.length > 0) {
		const open = frames.map((f) => f.char).join("");
		if (open.includes('"')) notes.push("unterminated-string");
		const brackets = open.replace(/"/g, "");
		if (brackets.length > 0) notes.push(`unclosed:${brackets}`);
		// The note fuses every open delimiter into one string; the region channel
		// keeps them addressable, one defect per frame pointing at its OPENER. An
		// unterminated string spans from its quote to end of input — that whole
		// run is what the scan swallowed — while a bracket marks just its opener,
		// since its intended extent is exactly what is unknown.
		for (const f of frames)
			defects.push(
				f.char === '"'
					? { code: "unterminated-string", start: f.at, end: text.length }
					: defectAt("unclosed", f.at, f.char),
			);
	}

	return { occurrences, notes, defects };
}

const FILTER_NOTE =
	"S8 filter-field: schema-dependent (local if a real menu field, undefined if not)";
const BARE_WORD_NOTE =
	"S7 bare word in expression position: menu field vs undefined name needs a schema";

/**
 * Read a `$name`, `${name}` or `$"quoted name"` reference at `at`.
 *
 * `next` is where the scan RESUMES, which is not always `end`: the `${…}` and
 * `$"…"` forms consume their own closing delimiter, while a bare `$name` stops
 * ON its terminator, which the caller still has to see. Conflating the two made
 * every `$var]` swallow its bracket in the lab's first run, drifting the
 * nesting depth upward across a whole script.
 */
function readRef(
	text: string,
	at: number,
	inString: boolean,
): { start: number; end: number; name: string; next: number } | null {
	let i = at + 1;
	if (text[i] === "{") {
		const close = text.indexOf("}", i);
		if (close < 0) return null;
		return {
			start: i + 1,
			end: close,
			name: text.slice(i + 1, close),
			next: close + 1,
		};
	}
	if (text[i] === '"' && !inString) {
		const close = text.indexOf('"', i + 1);
		if (close < 0) return null;
		// The span includes the quotes — the class runs across them (S11).
		return {
			start: i,
			end: close + 1,
			name: text.slice(i + 1, close),
			next: close + 1,
		};
	}
	if (text[i] === "[" || text[i] === "(") return null; // substitution, not a name
	const start = i;
	// S14 — the reference-name boundary is NOT the argument-name charset:
	//   `->`  indexing. `$vlanbytes->0` is `vlanbytes` then an operator; a
	//         `-`-greedy scan yields `vlanbytes-`, fails lookup, and degrades to
	//         `parameter`. A lone `-` inside a name is legal (`$my-var`), so only
	//         `-` FOLLOWED BY `>` terminates.
	//   `.`   property access. `$ipprefix.0` is `ipprefix` then `.0`.
	while (i < text.length) {
		const ch = text[i] as string;
		if (ch === ".") break;
		if (ch === "-" && text[i + 1] === ">") break;
		if (!isIdent(ch)) break;
		i++;
	}
	if (i === start) return null;
	return { start, end: i, name: text.slice(start, i), next: i };
}

/** The `name=` immediately before the `{` at `open`, lowercased, or null. */
function argNameBefore(text: string, open: number): string | null {
	let i = open - 1;
	// Every escape the WALKER accepts has to be transparent here too, or the two
	// disagree about where `do=` ends: `do=\ {`, `do=\<tab>{` and `do=\<nl>{` are
	// all `do={` on the device (the body is a closure), while `do=\{` is a hard
	// error the walker already stopped on. Sharing `escapeKind` is what keeps the
	// closure test and the scan from drifting apart.
	while (i >= 0) {
		const c = text[i] as string;
		if (isSpace(c)) {
			i--;
			continue;
		}
		if (c === "\\" && escapeKind(text, i) !== "invalid") {
			i--;
			continue;
		}
		break;
	}
	if (text[i] !== "=") return null;
	i--;
	const end = i + 1;
	while (i >= 0 && isIdent(text[i] as string)) i--;
	const name = text.slice(i + 1, end);
	return name === "" ? null : name.toLowerCase();
}

/**
 * What the backslash at `at` means in CODE.
 *
 * Grounded on CHR 7.23.2: a backslash is valid ONLY before whitespace. Before a
 * newline it is the H5 line continuation (`\<nl>` and `\<cr><nl>`); before a
 * space, a tab or a lone carriage return it escapes that character and the
 * statement carries on; before anything else (`\a`, `\$v`, `\\`, `\{`) the
 * console raises a hard error and classes the whole remainder `none`.
 */
function escapeKind(
	text: string,
	at: number,
): "continuation" | "whitespace" | "invalid" {
	const next = text[at + 1];
	if (next === "\n") return "continuation";
	if (next === "\r")
		return text[at + 2] === "\n" ? "continuation" : "whitespace";
	if (next === " " || next === "\t") return "whitespace";
	return "invalid";
}

const isSpace = (c: string): boolean =>
	c === " " || c === "\t" || c === "\r" || c === "\n";

/** Previous non-blank character on this line, or null at line start. */
function prevNonSpace(text: string, from: number): string | null {
	for (let i = from - 1; i >= 0; i--) {
		const c = text[i] as string;
		if (c === " " || c === "\t") continue;
		if (c === "\n") return null;
		return c;
	}
	return null;
}

/** Next non-blank character at or after `from`, or null at end of input. */
function nextNonSpace(text: string, from: number): string | null {
	for (let i = from; i < text.length; i++) {
		const c = text[i] as string;
		if (c !== " " && c !== "\t") return c;
	}
	return null;
}

/**
 * Per-byte flag: is this offset inside an unclosed `(` on its own line?
 *
 * Strings are deliberately not special-cased — the rule this feeds (S7) was
 * scored with a paren test that counted every `(`, and this table reproduces it
 * on any line whose parentheses balance.
 */
function parenMap(text: string): Uint8Array {
	const open = new Uint8Array(text.length);
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "\n") {
			depth = 0;
			continue;
		}
		if (c === "(") {
			open[i] = depth > 0 ? 1 : 0;
			depth++;
			continue;
		}
		if (c === ")" && depth > 0) depth--;
		open[i] = depth > 0 ? 1 : 0;
	}
	return open;
}

/**
 * S13 — bare words the console classifies as `none` (literal values), not as
 * symbols. Booleans/nothing are keywords; anything starting with a digit is a
 * number, time, IP, or version literal.
 */
function isLiteralWord(lower: string): boolean {
	if (/^[0-9]/.test(lower)) return true;
	return (
		lower === "true" ||
		lower === "false" ||
		lower === "yes" ||
		lower === "no" ||
		lower === "nothing"
	);
}
