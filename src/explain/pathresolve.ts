/**
 * Offline path resolution for `explain` (centrs canonicalizer).
 *
 * Ratified by the phase-0 lab, questions Q3 and Q4 (#185), promoted from the
 * throwaway probe `.scratch/explain-lab-pathresolve.ts`. Two surfaces:
 *
 *   resolveStatements  (Q4) — the fully-qualified canonical path of every
 *                       statement in source order, tracking the persistent menu
 *                       context across statements.
 *   resolveDocument    (Q3) — the re-constituted path of every `[…]` command
 *                       substitution, the spec's flagship example
 *                       (`remove [find …]` inherits the statement's own menu).
 *
 * The lab priced three context models; only the ratified `stateful` rule set is
 * promoted (`stateless`/`stateful-append` were A/B arms to justify it, left in
 * the lab). The rules:
 *   R1 An inner command starting with `/` is ABSOLUTE; context is ignored.
 *   R2 Otherwise it inherits the nearest enclosing MENU CONTEXT.
 *   R3 The nearest enclosing context of a `[…]` inside a statement is that
 *      STATEMENT's own path, not the document's.
 *   R4 Document context is set by a menu-navigation statement and by a
 *      menu-block prefix, and persists to following statements. An absolute
 *      NAVIGATION replaces context; an absolute COMMAND does not move it (the
 *      CHR-confirmed cascade — see the Q4 corners).
 *   R5 A block body inherits the context in force where the block appears.
 *   R6 Nested `[…]` inherit from the bracket that encloses them.
 *   R7 A variable (`$x`) path segment makes the path UNRESOLVED — offline says
 *      so rather than guessing.
 *   R8 `..` ascends and a bare `/` resets; a bare word alone is navigation only
 *      when a shipped structure table confirms the context-applied path (R13).
 *   R9 A `/`-led bare path whose run carries a FROZEN-VOCABULARY VERB is a
 *      command, not navigation (#211). Q6 already decides these, so without it
 *      this module and `verbsplit` returned contradictory answers for the same
 *      text — and this one INVENTED a menu (`/ip address print` navigating to
 *      `/ip/address/print`). See `menuNavPath`.
 *   R10 A `:` scripting directive takes its operand POSITIONALLY (`:global x`
 *      is `/global`, not `/global/x`); a menu command spells its menu out.
 *   R11 A bare directive (`while (…) do={…}`) is at the root, and hands its
 *      body the root context too. The schema-free tell is the scope block: no
 *      menu command takes `do=`.
 *   R12 A `/`-led bare path the published CATALOG names as a command is not
 *      navigation either (#228). The verb-free half R9 left open (#211 B2):
 *      `/system/reboot` is a command, so it must not move the context and the
 *      statement after it must not resolve against `/system/reboot`.
 *   R13 A relative bare path that a shipped table names as a menu advances the
 *      context (#235). Its run is read exactly as R9 reads an absolute one —
 *      whitespace and `/` are interchangeable on the device, so `firewall
 *      filter` and `firewall/filter` under `/ip` are one form. If neither table
 *      knows the joined path, offline abstains and the following relative
 *      statements lose context certainty.
 *
 * Verb-vs-menu identification is deliberately NOT decided here — offline cannot
 * tell `find` (verb) from a deeper menu without a schema (that is Q6). A
 * resolution therefore reports a best-guess `path` AND the full `candidates`
 * set (context, then context extended by each leading token), so a consumer can
 * present alternatives rather than assert a coin flip.
 *
 * ## Context certainty (Q14 C3b — the cascade, #192)
 *
 * The Q14 floor shipped in #191 degrades a MALFORMED statement to `unresolved`
 * and does not descend into it. That is statement-local, and the lab measured a
 * second failure on top of it: the defect also destroys the DOCUMENT CONTEXT,
 * and every later RELATIVE statement was still resolved confidently against the
 * stale value. `/ip) address` + `add address=…` reported a confident `/add` —
 * a path no device would accept, invented from a context the resolver had
 * already admitted it could not read.
 *
 * So each statement now also reports `contextCertain`: whether the menu context
 * in force BEFORE it is known. A statement that CONSUMES an unknown context
 * degrades to `unresolved` instead of resolving; one that does not consume it
 * is unaffected. Which is which is exactly the `base` split already used for
 * path resolution:
 *   - context-INDEPENDENT — an absolute (`/`-led) statement, a `:` directive,
 *     and a bare directive (R11) all resolve against the root. They keep
 *     resolving confidently while context is lost.
 *   - context-DEPENDENT — a relative statement (`add address=…`) resolves
 *     against the context, so it degrades.
 *
 * Three things make the context unknown, all cases where the statement might
 * have been navigation and offline cannot read where to:
 *   - a structural defect (the text is unreadable, so it may have been a nav),
 *   - a `/`-led statement whose leading run is unreadable (`/ip/$menu`, and
 *     equally the mixed spelling `/ip route/$menu`), which is a navigation to a
 *     computed menu as easily as it is a command,
 *   - a relative bare path that neither shipped structure table knows (#235).
 * A dynamic-headed statement (`$x`, `[…]`, `(…)`) is context-NEUTRAL — it
 * evaluates a value and does not navigate — so it must NOT poison; that
 * distinction is the whole reason this lives here rather than in a caller,
 * which sees only flattened statements. An ABSOLUTE navigation re-establishes
 * certainty, because R4 has it REPLACE the context rather than extend it.
 */

import { isScopeBrace, scopeBlocks, scopeBodies } from "./blocks.ts";
import { commandVerbIndex } from "./catalog.ts";
import {
	type Defect,
	isPositionalFact,
	mergeDefects,
	rebaseDefects,
} from "./defects.ts";
import { isKnownMenuPath } from "./is-known-menu.ts";
import { braceStartsStatements, hashStartsHardError } from "./scope-brace.ts";
import {
	maskComments,
	type SegmentResult,
	scanQuotedString,
	segmentStatements,
} from "./segment.ts";
import { VERBS } from "./verbs.ts";

const BARE_WORD = /^[A-Za-z][A-Za-z0-9._-]*$/;
/**
 * A whole path segment that is a variable reference (`$menu` in `/ip/$menu`).
 *
 * Deliberately "begins with `$`" and NOT an enumeration of name spellings. This
 * makes NO claim about which spellings RouterOS accepts — the point is the
 * opposite: every `$`-headed segment is unreadable HERE, whether it is a valid
 * reference (`$menu`, `$"quoted name"`) or something the device would itself
 * reject (`${braced}` is rejected at the `{` on 7.24rc1; a bare `$`). Offline
 * cannot resolve either kind, so both must abstain.
 *
 * A pattern like `\$[A-Za-z_]…` instead recognizes only the shapes it lists and
 * lets every other one through as an ordinary readable menu segment, which
 * fails OPEN. That is the same trap as the unanchored-regex and reason-prefix
 * bugs earlier in this module: a guard that decides whether to ABSTAIN must
 * match the general shape and let the unknown case block, never enumerate the
 * known ones. `write.ts` reaches the same conclusion at head position, where
 * `isDynamicForm` tests a bare `text.startsWith("$")`.
 */
function isVariableSegment(part: string): boolean {
	return part.startsWith("$");
}
const ASCII_WHITESPACE = /[ \t\r\n]+/;

function isAsciiWhitespace(char: string | undefined): boolean {
	return char === " " || char === "\t" || char === "\r" || char === "\n";
}

function trimAscii(text: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && isAsciiWhitespace(text[start])) start++;
	while (end > start && isAsciiWhitespace(text[end - 1])) end--;
	return text.slice(start, end);
}

function trimAsciiStart(text: string): string {
	let start = 0;
	while (start < text.length && isAsciiWhitespace(text[start])) start++;
	return text.slice(start);
}

function asciiWords(text: string): string[] {
	const trimmed = trimAscii(text);
	return trimmed.length === 0 ? [] : trimmed.split(ASCII_WHITESPACE);
}

function isAbsolutePathToken(token: string): boolean {
	if (!token.startsWith("/")) return false;
	const parts = token.split("/").filter(Boolean);
	return parts.length > 0 && parts.every((part) => BARE_WORD.test(part));
}

/**
 * Defensive recursion bound. `explain` accepts untrusted editor/MCP input, so
 * deeply nested substitutions/blocks must make the analysis ABSTAIN (an
 * `over-depth` note) rather than consume the JS stack. Matches the segmenter's
 * `MAX_CONTAINER_DEPTH`; far beyond any real script. Unlike the segmenter's H7
 * flattening — now a single left-to-right pass (#190) — this resolver's descent
 * is a genuine tree walk (block topology + bracket sub-command path
 * re-constitution), so it stays recursive under this bound.
 */
const MAX_DEPTH = 256;

/**
 * True when a statement's own delimiters are not well-formed — unbalanced
 * `()`/`[]`/`{}` or an unterminated string. Q14 fail-closed floor: a malformed
 * statement must never yield a confident command, so the resolver degrades it
 * to `unresolved` and does not descend into it. Statement-local; the
 * segmenter's document-level defects are surfaced separately on the envelope.
 */
function structuralDefect(text: string): string | null {
	// Mask comments so a `#`-comment `}`/`)` is not counted as a real delimiter.
	const masked = maskComments(text);
	const openOf: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
	const stack: { char: string; statements: boolean }[] = [];
	for (let i = 0; i < masked.length; i++) {
		const c = masked[i];
		if (c === '"') {
			const str = scanQuotedString(masked, i);
			if (!str.closed)
				return "structural defect: unbalanced delimiter or string";
			i = str.end - 1;
			continue;
		}
		if (
			c === "#" &&
			hashStartsHardError(masked, i, stack.at(-1)?.statements === false)
		)
			return "structural defect: invalid unquoted hash";
		if (c === "(" || c === "[" || c === "{")
			stack.push({
				char: c,
				statements:
					c === "[" || (c === "{" && braceStartsStatements(masked, i)),
			});
		else if (c === ")" || c === "]" || c === "}") {
			if (stack.pop()?.char !== openOf[c])
				return "structural defect: unbalanced delimiter or string";
		}
	}
	return stack.length > 0
		? "structural defect: unbalanced delimiter or string"
		: null;
}

/**
 * The `unresolved` reason of a statement (or bracket) that needed the document
 * context and could not have it. Distinct from every other reason: the
 * statement itself is perfectly readable — what failed is upstream.
 */
const CONTEXT_LOST = "context lost to an earlier unreadable statement";

/** R11 — a directive written without its colon, told by its scope block. */
function isBareDirective(trimmed: string): boolean {
	return (
		!trimmed.startsWith(":") &&
		!trimmed.startsWith("/") &&
		scopeBodies(trimmed).length > 0
	);
}

/**
 * Does this statement resolve its OWN path without consulting the document
 * context? Mirrors `canonicalPath`'s `base` exactly — absolute, `:` directive,
 * or bare directive (R11) all resolve at the root.
 */
function isContextIndependent(text: string): boolean {
	const t = trimAscii(text);
	return t.startsWith(":") || t.startsWith("/") || isBareDirective(t);
}

/**
 * Does the context this statement hands its BLOCK BODIES (and its own brackets,
 * R3) ignore the document context? Mirrors `statementPath`'s base, which is NOT
 * the same predicate as `isContextIndependent`: a `:` directive resolves itself
 * at the root but hands its body the context in force (R5), so `:foreach … do={
 * add … }` still depends on an upstream context its own path does not.
 */
function isBodyContextIndependent(text: string): boolean {
	const t = trimAscii(text);
	return t.startsWith("/") || isBareDirective(t);
}

/**
 * Does this text NAME a menu path that offline could not read?
 *
 * True when the leading run starts out path-shaped and is then TRUNCATED by a
 * variable segment: `/ip/$menu/remove`, `/ip route/$menu/remove`, and the
 * relative `route/$verb`. R7 says such a path is unresolved, so nothing may
 * inherit a base derived from it.
 *
 * Two traps this exists to avoid, both found in review:
 *   - `statementRun` DISCARDS the whole word carrying the variable, so after a
 *     static word (`/ip route/$menu/…`) its output is a clean, variable-free
 *     prefix and the statement reads as perfectly resolvable. The signal has to
 *     be taken from the raw words, not from the collected run.
 *   - Spelling is not the discriminator. Mixed space/slash menu spelling is a
 *     supported contract, and a RELATIVE head is just as much a menu name, so
 *     this must not test for a leading `/`.
 *
 * What it deliberately does NOT match is text that names no menu at all — a
 * head that is a variable, group, string or directive (`$fn [get …]`,
 * `-z "$URL"`, `iter(hip)`), and a `$` word in ARGUMENT position
 * (`get $item time`), which is a positional operand rather than a path
 * segment. Those establish no menu, so the ambient context still governs.
 */
function isUnreadablePath(text: string): boolean {
	const t = trimAscii(text);
	if (t.length === 0) return false;
	// A head that is not path-shaped names no menu.
	if (/^[$[("':]/.test(t)) return false;
	for (const word of asciiWords(t)) {
		// Arguments begin: everything before this was readable. A `$` word
		// STANDING ALONE is a positional operand (`get $item time`), not a path
		// segment — only a `$` slash-joined inside a word is a menu segment.
		if (word.includes("=") || /^[[({"$:]/.test(word)) return false;
		const parts = word.split("/").filter((p) => p.length > 0);
		if (parts.length === 0) continue;
		for (const part of parts) {
			if (BARE_WORD.test(part)) continue;
			// A whole segment that is a variable is the unreadable-menu case.
			if (isVariableSegment(part)) return true;
			// Anything else is not a path segment at all, so the run ended here and
			// everything before it was readable. This is why the test cannot simply
			// look for a `$` anywhere: `print where comment~[$strfind …]` and
			// `/ppp secret print where comment~"\\$SECRET"` carry a `$` inside an
			// ARGUMENT — the `~` means no `=` ends the run first — and both name a
			// perfectly readable menu.
			return false;
		}
	}
	return false;
}

/**
 * A `/`-led statement whose leading run offline cannot read — a variable
 * segment truncates it (`/ip/$menu`, `/interface/$type/print`). It is a
 * navigation to a computed menu exactly as plausibly as it is a command, so the
 * context after it is unknown. `menuNavPath` has already claimed every readable
 * absolute navigation before this is consulted.
 */
function isUnreadableAbsolute(text: string): boolean {
	const t = trimAscii(text);
	if (!t.startsWith("/")) return false;
	if (isUnreadablePath(t)) return true;
	const tokens = statementRun(t);
	return tokens.length === 0 || tokens.some((x) => x.startsWith("$"));
}

/**
 * Is the context this statement hands its own brackets (R3) and its block
 * bodies (R5) KNOWN?
 *
 * Two conditions, and BOTH are needed. The base must be knowable — the
 * statement is `/`-led or a bare directive, or the document context is certain.
 * And the statement's own leading run must be READABLE: `/ip/$menu/remove` is
 * `/`-led, so its base does not depend on the document context, but `R7` says a
 * variable path segment leaves the path unresolved, and `statementPath` derives
 * a menu from it anyway (`/ip/$menu`). Anchoring brackets to that hands them a
 * fabricated base — `[find]` at a "path" containing a literal `$menu` — while
 * `resolveStatements` refuses the very same statement. So an unreadable menu
 * anchors nothing, in EITHER spelling: `statementPath` derives a base from a
 * relative one too (`route/$verb remove [find]` yields `<ctx>/route/$verb`).
 */
function handsKnownContext(text: string, contextCertain: boolean): boolean {
	// Either spelling of an unreadable menu anchors nothing. `statementPath`
	// derives a base from a RELATIVE one too (`route/$verb remove [find]` yields
	// `<ctx>/route/$verb`), so this cannot test only the absolute form.
	if (isUnreadableAbsolute(text) || isUnreadablePath(text)) return false;
	return contextCertain || isBodyContextIndependent(text);
}

/** A re-constituted `[…]` command substitution (Q3). */
export interface Resolution {
	/** Raw text inside the brackets. */
	inner: string;
	/** Context in force at the bracket, `/` when at document root. */
	context: string;
	/** Leading `/`-path token run of the inner command, context applied. */
	tokens: string[];
	/**
	 * Every path the inner command could resolve to: the context alone, then the
	 * context extended by each leading token in turn. Offline cannot pick one
	 * without knowing which token is the verb (Q6); `path` is the best guess.
	 */
	candidates: string[];
	/** Best single guess: the first bare token is the verb (Q1's rule). */
	path: string | null;
	unresolved?: string;
	/**
	 * Was the menu context this bracket inherited (R3) known? False once an
	 * earlier unreadable statement destroyed it — a RELATIVE inner command is
	 * then `unresolved` rather than resolved against a stale value.
	 */
	contextCertain: boolean;
	/** Nesting depth of this bracket (0 = directly in a statement). */
	depth: number;
	/** Feature class, for per-class reporting. */
	klass: string;
	/**
	 * The `[…]` in DOCUMENT analyzed-byte space, closing bracket included. Widens
	 * to the enclosing statement where interior offsets cannot be mapped — see
	 * {@link Loc}.
	 */
	span: Span;
}

/** The canonical path of one statement in source order (Q4). */
export interface StatementResolution {
	text: string;
	/** Offline read this statement as menu navigation, not a command. */
	isNav: boolean;
	/** Context in force BEFORE this statement. */
	context: string;
	/**
	 * Fully-qualified canonical path, menu AND verb (`/ip/route/add`). Where the
	 * path stops and POSITIONAL arguments begin is still a Q6 boundary: `path` is
	 * the greedy full-run reading and `candidates` carries the shorter readings.
	 */
	path: string | null;
	/** Context extended by each prefix of the leading run, shortest first. */
	candidates?: string[];
	unresolved?: string;
	/**
	 * Was the menu context in force BEFORE this statement known? False once an
	 * earlier unreadable statement destroyed it (Q14 C3b). A context-DEPENDENT
	 * statement is then `unresolved`; a context-INDEPENDENT one still resolves,
	 * so a `false` here does not by itself invalidate `path`.
	 */
	contextCertain: boolean;
	/** This statement in DOCUMENT analyzed-byte space. */
	span: Span;
}

/** Q3 result: bracket resolutions plus any structural / over-depth defects. */
export interface DocumentAnalysis {
	resolutions: Resolution[];
	/**
	 * Located defects surfaced from the segmenter (`unclosed`, `unbalanced-close`,
	 * `unterminated-string`) plus `over-depth` when a bounded traversal abstained,
	 * and defects raised inside a block body. A caller must not treat resolutions
	 * as confident while a NON-POSITIONAL defect is present — `isPositionalFact`
	 * in `defects.ts` is that test.
	 */
	defects: Defect[];
}

/** Q4 result: per-statement resolutions plus structural / over-depth defects. */
export interface StatementAnalysis {
	statements: StatementResolution[];
	/** As {@link DocumentAnalysis.defects}. */
	defects: Defect[];
}

/** A half-open analyzed-byte span. */
export interface Span {
	start: number;
	end: number;
}

/**
 * Where the text a walker is scanning sits in the DOCUMENT.
 *
 * `base` is the document analyzed-byte offset that index 0 of that text maps to,
 * or -1 when the mapping is unavailable. It goes to -1 for exactly one reason:
 * a statement's `text` is the ORIGINAL substring (UTF-16 code units), so an
 * index into it is an analyzed-byte offset only while the statement is pure
 * ASCII. Once -1 it stays -1 for everything nested inside.
 *
 * The check for that is a length comparison, and it is exact rather than a
 * heuristic: every non-ASCII code point has a UTF-8 length strictly greater than
 * its UTF-16 length (2>1, 3>1, 4>2), so the two lengths agree if and only if
 * every character is ASCII.
 *
 * `fallback` is the enclosing statement's span, used when `base` is -1. Widening
 * a defect to its statement is the fail-closed choice in the Q14 sense: a region
 * that is too WIDE still points the reader at real text, while one computed from
 * a mismatched index space points confidently at the wrong byte.
 */
interface Loc {
	base: number;
	fallback: Span;
}

/** A `[start, end)` of the scanned text, in document space. */
function spanIn(loc: Loc, start: number, end: number): Span {
	return loc.base < 0
		? { start: loc.fallback.start, end: loc.fallback.end }
		: { start: loc.base + start, end: loc.base + end };
}

/**
 * A defect region for `[start, end)` of the scanned text, never zero-width.
 *
 * An empty extent is reachable — `do={}` at the block-depth limit, `[]` at the
 * bracket limit — and `Defect` contracts `end > start`, so an empty one falls
 * back to the enclosing statement rather than emitting `start === end`.
 */
function regionIn(loc: Loc, start: number, end: number): Span {
	return end > start
		? spanIn(loc, start, end)
		: { start: loc.fallback.start, end: loc.fallback.end };
}

/** Move `loc` to a nested text beginning at index `start` of the current one. */
function nest(loc: Loc, start: number, fallback: Span): Loc {
	return { base: loc.base < 0 ? -1 : loc.base + start, fallback };
}

/** Carry `defects` (offsets into the scanned text) into document space. */
function attribute(defects: readonly Defect[], loc: Loc): Defect[] {
	if (loc.base >= 0) return rebaseDefects(defects, loc.base);
	return defects.map((d) =>
		d.detail === undefined
			? { code: d.code, start: loc.fallback.start, end: loc.fallback.end }
			: {
					code: d.code,
					start: loc.fallback.start,
					end: loc.fallback.end,
					detail: d.detail,
				},
	);
}

/** One statement to walk, already located in document space. */
interface Located {
	text: string;
	span: Span;
	loc: Loc;
}

/**
 * Segment `text` and locate every statement in document space, carrying the
 * segmenter's own defects out with them.
 *
 * The offsets and defects a plain `segments.map((s) => s.text)` would discard
 * are what every span and region downstream is built from.
 */
function locate(
	segmented: SegmentResult,
	loc: Loc,
): { units: Located[]; defects: Defect[] } {
	const units = segmented.segments.map((s) => {
		const span = spanIn(loc, s.start, s.end);
		// `s.start`/`s.end` are analyzed bytes of THIS text; `s.text` is the
		// original substring. Interior indices into `s.text` are analyzed-byte
		// offsets only when the two lengths agree (see `Loc`).
		const asciiOnly = s.end - s.start === s.text.length;
		return {
			text: s.text,
			span,
			loc:
				loc.base < 0 || !asciiOnly
					? { base: -1, fallback: span }
					: { base: loc.base + s.start, fallback: span },
		};
	});
	// STRUCTURAL defects only. `segmentStatements` merges `coordinateDefects`
	// into every result, so a nested call on a block body would re-run the
	// coordinate pass over that SUBSTRING — and a coordinate fact is a property
	// of the ROOT input, not of any slice of it. Two things went wrong when this
	// filter was missing: a non-ASCII run already reported by the document pass
	// came back a second time widened to its whole statement, and a U+FEFF in
	// document-MIDDLE position was re-classified `bom` because it happens to be
	// leading within the body — contradicting `coordinateDefects`' own contract.
	// The entry points seed these once from the root `SegmentResult`.
	const structural = segmented.defects.filter((d) => !isPositionalFact(d.code));
	return { units, defects: attribute(structural, loc) };
}

/**
 * The whole-document starting location. `base` is 0 and always valid — the
 * segmenter's offsets are already document analyzed bytes — so the fallback is
 * unreachable here and every statement gets its own from {@link locate}.
 */
const DOCUMENT_LOC: Loc = { base: 0, fallback: { start: 0, end: 0 } };

/** Q3 — resolve every `[…]` command substitution in `text`. */
export function resolveDocument(text: string): DocumentAnalysis {
	// Segment ONCE and hand the result to `locate` — `containsWrite` calls both
	// entry points, and re-segmenting here would put a document through the
	// segmenter four times on input its own comment calls "not cheap".
	const segmented = segmentStatements(text);
	// The ROOT segmentation is the only source of coordinate facts (`bom`,
	// `non-ascii`); `locate` strips them so recursion cannot re-derive them in a
	// substring's coordinate space.
	const defects: Defect[] = [...segmented.defects];
	const resolutions: Resolution[] = [];
	const top = locate(segmented, DOCUMENT_LOC);
	defects.push(...top.defects);
	walk(top.units, "/", resolutions, 0, defects, true);
	return { resolutions, defects: mergeDefects(defects) };
}

function walk(
	units: Located[],
	context: string,
	out: Resolution[],
	blockDepth: number,
	defects: Defect[],
	contextCertain: boolean,
): void {
	let ctx = context;
	let certain = contextCertain;
	for (const unit of units) {
		const { text, loc } = unit;
		// R4 — a menu-navigation statement moves the document context.
		const nav = menuNavPath(text, ctx);
		if (nav !== null) {
			const relative = !trimAscii(text).startsWith("/");
			// A `..` read against an unknown context stays unknown; an absolute
			// navigation replaces it and re-establishes certainty.
			if (relative && !certain) continue;
			ctx = nav;
			if (!relative) certain = true;
			continue;
		}
		// Q14 fail-closed — a structurally malformed statement yields no confident
		// bracket path and is not descended. It may have been a navigation, so the
		// context after it is unknown (Q14 C3b, the same contract the statement
		// walk applies — these two walks must move in lockstep).
		if (structuralDefect(text) !== null) {
			certain = false;
			continue;
		}
		// #235 — a relative bare-word that abstained (neither table) poisons
		// downstream context, so the next relative statement cannot fabricate.
		const poisonAbstention = isAbstainedRelativeNav(text, ctx);
		// R3 — the statement's own path is the context its brackets see.
		const stmtCtx = statementPath(text, ctx);
		// Derived BEFORE the poison, from the certainty in force at this statement:
		// `handsKnownContext` answers about the context this statement HANDS DOWN,
		// which its own unreadability already governs. An abstained nav poisons
		// what follows, so its own body must already be uncertain.
		const stmtCertain = poisonAbstention
			? false
			: handsKnownContext(text, certain);
		if (isUnreadableAbsolute(text) || poisonAbstention) certain = false;
		collectBrackets(text, stmtCtx, 0, out, defects, stmtCertain, loc);
		// R5 — block bodies inherit the context in force here.
		for (const block of scopeBlocks(text)) {
			if (blockDepth >= MAX_DEPTH) {
				// The BLOCK that exceeded the limit, not the whole statement —
				// narrowing regions is what this channel is for.
				defects.push({
					code: "over-depth",
					...regionIn(loc, block.start, block.start + block.body.length),
				});
				continue;
			}
			const bodyLoc = nest(loc, block.start, unit.span);
			const body = locate(segmentStatements(block.body), bodyLoc);
			defects.push(...body.defects);
			walk(body.units, stmtCtx, out, blockDepth + 1, defects, stmtCertain);
		}
	}
}

/** Q4 — canonical path of every statement in source order. */
export function resolveStatements(text: string): StatementAnalysis {
	const segmented = segmentStatements(text);
	// As `resolveDocument`: coordinate facts come from the root only.
	const defects: Defect[] = [...segmented.defects];
	const statements: StatementResolution[] = [];
	const top = locate(segmented, DOCUMENT_LOC);
	defects.push(...top.defects);
	walkStatements(top.units, "/", statements, 0, defects, true);
	return { statements, defects: mergeDefects(defects) };
}

function walkStatements(
	units: Located[],
	context: string,
	out: StatementResolution[],
	blockDepth: number,
	defects: Defect[],
	contextCertain: boolean,
): void {
	let ctx = context;
	let certain = contextCertain;
	for (const unit of units) {
		const { text, span } = unit;
		const nav = menuNavPath(text, ctx);
		if (nav !== null) {
			// `..` ascends FROM the context, so it cannot be read while the context
			// is unknown. A `/`-led navigation (and a bare `/`) REPLACES it (R4) and
			// therefore re-establishes certainty.
			const relative = !trimAscii(text).startsWith("/");
			if (relative && !certain) {
				out.push({
					text,
					isNav: true,
					context: ctx,
					path: null,
					unresolved: CONTEXT_LOST,
					contextCertain: false,
					span,
				});
				continue;
			}
			out.push({
				text,
				isNav: true,
				context: ctx,
				path: nav,
				contextCertain: certain,
				span,
			});
			ctx = nav;
			if (!relative) certain = true;
			continue;
		}
		// Q14 fail-closed — a malformed statement degrades to unresolved and is
		// not descended; it does not move the context either. It may however have
		// BEEN a navigation, so what the context now is becomes unknown.
		const defectReason = structuralDefect(text);
		if (defectReason !== null) {
			out.push({
				text,
				isNav: false,
				context: ctx,
				path: null,
				unresolved: defectReason,
				contextCertain: certain,
				span,
			});
			certain = false;
			continue;
		}
		// #235 — a relative bare-word that abstained (neither table) poisons
		// downstream context. Capture before the push so the current statement's
		// own `contextCertain` stays true while the following statements lose it.
		const poisonAbstention = isAbstainedRelativeNav(text, ctx);
		// Q14 C3b — the cascade. A statement that CONSUMES the context cannot be
		// resolved against a value the resolver has already admitted it lost.
		// Applied to the RESOLUTION, not ahead of it, so a statement that would
		// have refused on its own terms keeps its own — more specific — reason.
		const resolved = canonicalPath(text, ctx);
		out.push({
			text,
			isNav: false,
			context: ctx,
			...(resolved.path !== null && !certain && !isContextIndependent(text)
				? { path: null, unresolved: CONTEXT_LOST }
				: resolved),
			contextCertain: certain,
			span,
		});
		// A block body's statements are the parent's siblings after flattening,
		// and R5 gives them the context in force here — which is the ROOT, hence
		// knowable, when the statement spells its path out or is a bare directive,
		// and unknowable when the statement's own path could not be read. Same
		// predicate and same order as the bracket walk, per the lockstep rule.
		const stmtCtx = statementPath(text, ctx);
		const bodyCertain = poisonAbstention
			? false
			: handsKnownContext(text, certain);
		if (isUnreadableAbsolute(text) || poisonAbstention) certain = false;
		for (const block of scopeBlocks(text)) {
			if (blockDepth >= MAX_DEPTH) {
				defects.push({
					code: "over-depth",
					...regionIn(unit.loc, block.start, block.start + block.body.length),
				});
				continue;
			}
			const bodyLoc = nest(unit.loc, block.start, span);
			const body = locate(segmentStatements(block.body), bodyLoc);
			defects.push(...body.defects);
			walkStatements(
				body.units,
				stmtCtx,
				out,
				blockDepth + 1,
				defects,
				bodyCertain,
			);
		}
	}
}

/**
 * `/ip address` alone on a statement → the new context. Otherwise null.
 *
 * R8/R13 — `..` ascends, a bare `/` resets, and a relative bare path advances
 * only when a shipped structure table confirms the context-applied menu
 * ({@link readRelativeBare}). An absolute navigation REPLACES the context
 * rather than extending it; a relative one EXTENDS it.
 *
 * R9 (#211 B1) — a `/`-led bare path whose run carries a FROZEN-VOCABULARY VERB
 * is a command, not navigation. Without this the shape test alone claimed
 * `/ip address print` as a navigation to `/ip/address/print` — a menu that does
 * not exist — and then resolved the rest of the document against it. Q6 already
 * decides these statements: `verbsplit` reads the very same text as verb `print`
 * at `/ip/address`, so the two promoted modules returned contradictory answers
 * for 34 dev / 13 holdout statements, `verbsplit` right in every one. The verb
 * set is deliberately the SAME `VERBS` object and the same case-sensitive
 * lookup, so the modules cannot drift apart; `explain-pathresolve.test.ts` pins
 * the invariant that a `verbsplit`-`resolved` statement is never `isNav`.
 *
 * This costs no abstention — the statements it removes from navigation were
 * already decided, just decided wrongly. It also does not collide with any menu
 * the generated table knows: no path in `MENU_PATHS` carries a verb segment,
 * asserted in the same test so a regeneration that introduced one fails. That
 * is a claim about the TABLE, not about RouterOS — `MENU_PATHS` is a floor
 * (#207), so a real menu absent from it and named `.../print` would still be
 * read as a command here. Nothing in the corpus or the four pinned trees looks
 * like that, and such a menu would be indistinguishable from `print` at its
 * parent anyway.
 *
 * R12 (#228 step 2) — a `/`-led bare path the published CATALOG names as a
 * command is not navigation either. This is the harder half R9 could not reach
 * (#211 B2): `/system/reboot`, `/quit` and `/tool/speed-test` carry no
 * vocabulary verb, and #211 could only have refused them by reading ABSENCE from
 * `MENU_PATHS` as evidence of a command — which inverts the floor contract
 * (#207) and is why B2 was parked rather than guessed at. The command axis is
 * the missing POSITIVE evidence, so nothing about the floor changes: presence in
 * either table decides, absence from both still abstains.
 *
 * It is also no longer optional. `verbsplit` reads `/system reboot` as verb
 * `reboot` at `/system`, so leaving it navigation here would re-open exactly the
 * contradiction R9 closed — and worse than before, since the two modules would
 * now disagree CONFIDENTLY rather than one of them refusing. The same test pins
 * the invariant for both rules.
 */
function menuNavPath(text: string, ctx: string): string | null {
	const trimmed = trimAscii(text);
	if (trimmed === "/") return "/";
	if (/^\.\.(?:[ \t\r\n]|$)/.test(trimmed)) {
		const tokens = asciiWords(trimmed);
		if (!tokens.every((token) => token === "..")) return null;
		return joinPath(ctx, tokens.join("/"));
	}
	if (!trimmed.startsWith("/")) {
		// #235 R13 — relative bare-word menu navigation.
		const reading = readRelativeBare(text, ctx);
		return reading?.kind === "nav" ? reading.path : null;
	}
	if (/[=[({"$]/.test(trimmed)) return null;
	const tokens = asciiWords(trimmed);
	if (
		!tokens.every((token, i) =>
			i === 0 ? isAbsolutePathToken(token) : BARE_WORD.test(token),
		)
	)
		return null;
	// R9 — the run is verb-free, or this is not navigation. Tokens may be
	// slash-joined (`/ip/address/print` is one token), so the verb test has to run
	// over path SEGMENTS, exactly as `verbsplit`'s `runTokens` splits them.
	const segments = tokens.flatMap((token) =>
		token.split("/").filter((part) => part.length > 0),
	);
	if (segments.some((segment) => VERBS.has(segment))) return null;
	// R12 — the same segments, against the published command axis.
	if (commandVerbIndex(segments) !== null) return null;
	return joinPath("/", tokens.join("/"));
}

/**
 * How a RELATIVE bare-path statement reads against `ctx` (#235, R13).
 *
 * - `nav` — a shipped table confirms the context-applied path, so it navigates.
 * - `abstain` — the statement HAS the shape of relative navigation but neither
 *   table knows the joined path. Offline cannot say which it was, so the caller
 *   poisons what follows rather than resolve it against a context that may
 *   already have moved.
 * - `null` — not a relative bare path at all: absolute, dynamic, a directive,
 *   or a run carrying a vocabulary verb / published command, which is a
 *   COMMAND and therefore not a maybe-navigation either.
 *
 * ONE classifier rather than a shape test per question. The nav reading and the
 * poison test must agree about which statements are in scope; written twice
 * they can drift, and a drift there is silently either a lost navigation or a
 * poisoned document.
 */
type RelativeBareReading = { kind: "nav"; path: string } | { kind: "abstain" };

function readRelativeBare(
	text: string,
	ctx: string,
): RelativeBareReading | null {
	const trimmed = trimAscii(text);
	if (
		trimmed.length === 0 ||
		trimmed.startsWith("/") ||
		trimmed.startsWith(":") ||
		trimmed.startsWith("$") ||
		trimmed.startsWith("[") ||
		trimmed.startsWith("(") ||
		isBareDirective(trimmed)
	)
		return null;
	// Whitespace and `/` are interchangeable on the device, so the run is read
	// over path SEGMENTS exactly as R9 reads an absolute one: `firewall filter`
	// and `firewall/filter` under `/ip` are the same navigation (CHR 7.24rc1 —
	// see the `pathresolve.json` corner). A `..`/`.` segment fails `BARE_WORD`,
	// so the `..` form above stays the only ascent this function admits.
	const parts = asciiWords(trimmed).flatMap((word) => word.split("/"));
	if (!parts.every((part) => BARE_WORD.test(part))) return null;
	const path = joinPath(ctx, parts.join("/"));
	const segments = path.split("/").filter(Boolean);
	// R9/R12 on the JOINED path — a verb-bearing or published-command path is a
	// command, not navigation, and not an abstention either: `address print`
	// under `/ip` is verb `print` at `/ip/address`, which `verbsplit` decides.
	if (segments.some((segment) => VERBS.has(segment))) return null;
	if (commandVerbIndex(segments) !== null) return null;
	return isKnownMenuPath(segments)
		? { kind: "nav", path }
		: { kind: "abstain" };
}

/**
 * #235 — does `text` look like a relative menu navigation that ABSTAINED?
 *
 * Presence in a table → nav; absence → abstain → poison downstream, so the
 * next relative statement cannot resolve against a context that may have moved.
 */
function isAbstainedRelativeNav(text: string, ctx: string): boolean {
	return readRelativeBare(text, ctx)?.kind === "abstain";
}

function canonicalPath(
	text: string,
	ctx: string,
): { path: string | null; candidates?: string[]; unresolved?: string } {
	const t = trimAscii(text);
	if (t.startsWith("$") || t.startsWith("[") || t.startsWith("("))
		return {
			path: null,
			unresolved: "dynamic or substitution-headed statement",
		};
	// A `:` scripting directive is always at the ROOT, whatever the context —
	// but it is not necessarily one segment: `:log info "x"` is `/log/info`.
	const body = t.startsWith(":") ? t.slice(1) : t;
	// R11 — a scripting directive written WITHOUT its colon is still at the root.
	// A statement that carries a SCOPE-valued block is a directive, because no
	// menu command takes one — a schema-free tell.
	const bareDirective = isBareDirective(t);
	// The cascade contract reads this same split to decide which statements may
	// keep resolving once the context is lost, so both must come from one place.
	const base = isContextIndependent(t) ? "/" : ctx;
	// R7 — a variable segment anywhere in the leading run leaves the path
	// unresolved, INCLUDING after a static word. `statementRun` drops the whole
	// word carrying the variable, so `/ip route/$menu/remove` would otherwise
	// report a confident, truncated `/ip`.
	if (isUnreadablePath(t))
		return { path: null, unresolved: "variable path segment" };
	const tokens = statementRun(body);
	if (tokens.length === 0)
		return { path: null, unresolved: "no leading path token" };
	if (tokens.some((x) => x.startsWith("$")))
		return { path: null, unresolved: "variable path segment" };
	const candidates: string[] = [];
	for (let k = 1; k <= tokens.length; k++)
		candidates.push(joinPath(base, tokens.slice(0, k).join("/")));
	// R10 — the path/positional boundary, split by statement kind: a `:` (or
	// bare) directive takes its operand positionally, so its path is the
	// directive alone; a menu command spells its whole menu out.
	const path =
		t.startsWith(":") || bareDirective
			? (candidates[0] as string)
			: joinPath(base, tokens.join("/"));
	return { path, candidates };
}

/**
 * Leading path-token run of a statement. Stops at the first token that cannot
 * be a path segment: an argument (`x=1`), a group, a quoted string, or anything
 * not shaped like an identifier — a bare `9` is a positional argument, never a
 * menu. It does NOT stop at identifier-shaped positional arguments (`enable
 * www-ssl`); nothing offline can, and that residue is Q6.
 */
function statementRun(text: string): string[] {
	const out: string[] = [];
	for (const t of asciiWords(text)) {
		if (t.includes("=") || /^[[({"$:]/.test(t)) break;
		const parts = t.split("/").filter((p) => p.length > 0);
		if (parts.length === 0) continue;
		if (!parts.every((p) => BARE_WORD.test(p))) break;
		out.push(...parts);
	}
	return out;
}

/**
 * The menu path a statement's own brackets inherit. For `/ip route remove
 * [find …]` that is `/ip/route`: the leading path run minus its last token,
 * which is the verb (Q6's reading, right ~93.7% of the time).
 */
function statementPath(text: string, ctx: string): string {
	const t = trimAsciiStart(text);
	// R11 — a bare directive is at the root, so the context it hands its body is
	// the root too, not `<ctx>/while`.
	if (isBareDirective(trimAscii(t))) return "/";
	const lead = leadingRun(text);
	if (lead.length === 0) return ctx;
	// Same split `isBodyContextIndependent` reports to the cascade contract.
	const base = isBodyContextIndependent(t) ? "/" : ctx;
	return joinPath(base, lead.slice(0, -1).join("/"));
}

/** Leading bare/path tokens, stopping at the first argument or group. */
function leadingRun(text: string): string[] {
	const out: string[] = [];
	for (const t of asciiWords(text)) {
		if (t.includes("=") || /^[[({"$:]/.test(t)) break;
		for (const part of t.split("/")) if (part.length > 0) out.push(part);
		if (out.length === 0 && t === "/") out.push("");
	}
	return out;
}

function joinPath(base: string, rest: string): string {
	const parts = [
		...base.split("/").filter(Boolean),
		...rest.split("/").filter((p) => p.length > 0),
	];
	const stack: string[] = [];
	for (const p of parts) {
		if (p === "..") stack.pop();
		else if (p !== ".") stack.push(p);
	}
	return `/${stack.join("/")}`;
}

function collectBrackets(
	text: string,
	ctx: string,
	depth: number,
	out: Resolution[],
	defects: Defect[],
	contextCertain: boolean,
	loc: Loc,
): void {
	// Bound the recursion (bracket nesting AND literal-brace descent) so
	// untrusted deeply nested input abstains instead of overflowing the stack.
	if (depth >= MAX_DEPTH) {
		// `text` is empty when the nesting bottoms out on an empty body (`[]`),
		// which `regionIn` widens rather than emitting a zero-width region.
		defects.push({ code: "over-depth", ...regionIn(loc, 0, text.length) });
		return;
	}
	// Scan a comment-masked copy so a `#`-comment `[`/`{` is not treated as a
	// substitution or scope. Comments never hold valid inner commands (`#` mid
	// `[…]` is not statement-leading), so masked slices equal the originals.
	const masked = maskComments(text);
	for (let i = 0; i < masked.length; i++) {
		const c = masked[i];
		if (c === '"') {
			// A string is opaque EXCEPT for `$[ … ]` interpolation, a real command
			// substitution: `:put "$[:pick $ip 0 $n]"` lowers with `/pick` inside
			// (topic-…/post-0003-snippet-01 @ 7.22.1).
			const strEnd = stringEnd(masked, i);
			scanInterpolations(
				masked.slice(i + 1, strEnd),
				ctx,
				depth,
				out,
				defects,
				contextCertain,
				nest(loc, i + 1, loc.fallback),
			);
			i = strEnd;
			continue;
		}
		if (c === "{") {
			// A literal body is a value (Q2), but can still contain command
			// substitutions: `{[/terminal/inkey]}` lowers the bracket. Descend for
			// brackets only; scope bodies are walked by walk().
			const end = matchDelim(masked, i, "{", "}");
			if (!isScopeBrace(masked, i))
				collectBrackets(
					masked.slice(i + 1, end),
					ctx,
					depth + 1,
					out,
					defects,
					contextCertain,
					nest(loc, i + 1, loc.fallback),
				);
			i = end;
			continue;
		}
		if (c !== "[") continue;
		const end = matchDelim(masked, i, "[", "]");
		const inner = trimAscii(masked.slice(i + 1, end));
		// The span covers the whole `[…]`, closing bracket included.
		out.push({
			...resolveInner(inner, ctx, depth, contextCertain),
			span: spanIn(loc, i, Math.min(end + 1, text.length)),
		});
		// R6 — nested brackets inherit from this one's resolution.
		const nestedCtx = out[out.length - 1]?.path ?? ctx;
		collectBrackets(
			inner,
			nestedCtx,
			depth + 1,
			out,
			defects,
			nestedCertainty(out[out.length - 1], contextCertain),
			// `inner` is the trimmed slice of `masked` starting at i+1; the leading
			// whitespace trim shifts it further right.
			nest(
				loc,
				i +
					1 +
					(masked.slice(i + 1, end).length -
						trimAsciiStart(masked.slice(i + 1, end)).length),
				loc.fallback,
			),
		);
		i = end;
	}
}

/**
 * Index of the closing quote of the string starting at `open`. Delegates to the
 * shared `scanQuotedString`, so a `$[…]` substitution carrying its own string
 * does not end the outer one early and cut `scanInterpolations`' body short
 * (#199).
 */
function stringEnd(text: string, open: number): number {
	const str = scanQuotedString(text, open);
	return str.closed ? str.end - 1 : text.length;
}

/** `$[ … ]` command substitutions inside a string body. */
function scanInterpolations(
	body: string,
	ctx: string,
	depth: number,
	out: Resolution[],
	defects: Defect[],
	contextCertain: boolean,
	loc: Loc,
): void {
	for (let i = 0; i < body.length - 1; i++) {
		if (body[i] !== "$" || body[i + 1] !== "[") continue;
		const end = matchDelim(body, i + 1, "[", "]");
		const raw = body.slice(i + 2, end);
		const inner = trimAscii(raw);
		// Span the `$[…]` from its sigil through the closing bracket.
		out.push({
			...resolveInner(inner, ctx, depth, contextCertain),
			span: spanIn(loc, i, Math.min(end + 1, body.length)),
		});
		collectBrackets(
			inner,
			out[out.length - 1]?.path ?? ctx,
			depth + 1,
			out,
			defects,
			nestedCertainty(out[out.length - 1], contextCertain),
			nest(
				loc,
				i + 2 + (raw.length - trimAsciiStart(raw).length),
				loc.fallback,
			),
		);
		i = end;
	}
}

/**
 * Certainty a NESTED bracket inherits (R6). Three cases, and the middle one is
 * the whole subtlety:
 *
 *   1. The enclosing bracket RESOLVED — its path is the nested bracket's base,
 *      so the nested one is anchored even while the document context is lost
 *      (`[/ip/route/get [find …] gateway]` is absolute, hence independent).
 *   2. The enclosing bracket is a MENU COMMAND WE COULD NOT READ — then the
 *      real base is a menu we cannot name, and `collectBrackets` falls back to
 *      the STATEMENT's context, which is a different menu. In `/ip route` +
 *      `remove [/interface/$type/get [find]]` that fallback reports the nested
 *      `[find]` at `/ip/route`, a context it never had. It must abstain — and
 *      equally for a RELATIVE unreadable menu (`[route/$verb [find]]`), because
 *      spelling is not what makes a menu unreadable.
 *   3. The enclosing bracket is NOT A MENU COMMAND AT ALL — a user function
 *      (`$formatDate`), a value expression, a `:` directive. It
 *      establishes no menu, so the AMBIENT context still governs its arguments
 *      and the fallback is correct. Corpus evidence for this being the common
 *      shape rather than a corner: under `/log`,
 *      `:set x "$[$formatDate [get $item time]]"` must keep resolving
 *      `[get …]` at `/log` (rextended/topic-166898). Refusing case 3 as well
 *      costs 12 further brackets and one document's `containsWrite` verdict,
 *      all of them correct answers thrown away.
 *
 * Case 2 is told from case 3 by `isUnreadablePath`, the same test the statement
 * walk uses: the inner NAMES a menu (a path-shaped head) whose leading run is
 * truncated by a variable segment, in either the absolute or the relative
 * spelling. Case 3 is text that names no menu at all.
 */
function nestedCertainty(
	enclosing: Pick<Resolution, "path" | "inner"> | undefined,
	contextCertain: boolean,
): boolean {
	if (enclosing === undefined) return contextCertain;
	if (enclosing.path !== null) return true;
	if (isUnreadablePath(enclosing.inner)) return false;
	return contextCertain;
}

/**
 * Resolve one bracket body. The caller owns the `span`, because only it knows
 * where the bracket sat in the text it was scanning.
 */
function resolveInner(
	inner: string,
	ctx: string,
	depth: number,
	contextCertain: boolean,
): Omit<Resolution, "span"> {
	const absolute = inner.startsWith("/");
	const klass = classify(inner, absolute, depth);
	if (klass === "cli-prompt-artifact")
		return {
			inner,
			context: ctx,
			tokens: [],
			candidates: [],
			path: null,
			unresolved: "looks like a pasted CLI prompt, not a substitution",
			contextCertain,
			depth,
			klass,
		};
	// A `:` scripting directive is ALWAYS at the root — `[:tostr $x]` lowers to
	// `(evl (evl /tostrvalue=$x))`, path `/`, whatever context is in force.
	if (trimAsciiStart(inner).startsWith(":"))
		return {
			inner,
			context: ctx,
			tokens: [],
			candidates: ["/"],
			path: "/",
			contextCertain,
			depth,
			klass,
		};
	const tokens = leadingRun(inner);
	if (tokens.length === 0)
		return {
			inner,
			context: ctx,
			tokens,
			candidates: [],
			path: null,
			unresolved: "no leading path token",
			contextCertain,
			depth,
			klass,
		};
	// R7 — a `$var` anywhere in the leading run makes the path unknowable.
	if (tokens.some((t) => t.startsWith("$")))
		return {
			inner,
			context: ctx,
			tokens,
			candidates: [],
			path: null,
			unresolved: "variable path segment",
			contextCertain,
			depth,
			klass,
		};
	// Q14 C3b — a RELATIVE inner command inherits the statement's menu (R2/R3),
	// so it cannot be re-constituted once that context is lost. Checked only once
	// the inner command has been read, so a bracket that refuses on its own terms
	// keeps its own reason; an absolute inner path and the `:` directive above are
	// context-independent and still resolve.
	if (!contextCertain && !absolute)
		return {
			inner,
			context: ctx,
			tokens,
			candidates: [],
			path: null,
			unresolved: CONTEXT_LOST,
			contextCertain,
			depth,
			klass,
		};
	const base = absolute ? "/" : ctx; // R1 / R2
	const candidates: string[] = [joinPath(base, "")];
	for (let k = 1; k < tokens.length; k++)
		candidates.push(joinPath(base, tokens.slice(0, k).join("/")));
	return {
		inner,
		context: ctx,
		tokens,
		candidates,
		// Absolute inner paths spell their menu out, so the verb is the last
		// segment of the slash-joined head; relative ones lead with the verb.
		path: absolute
			? joinPath(base, tokens.slice(0, -1).join("/"))
			: joinPath(base, ""),
		contextCertain,
		depth,
		klass,
	};
}

// `[admin@Router] > /ip address print` — a pasted terminal transcript. The
// prompt is bracketed exactly like a command substitution, and offline has no
// way to tell them apart by shape alone. Left unguarded it manufactures phantom
// inner commands from any pasted session, which matters because `explain` takes
// editor and MCP input. `user@host` with no command shape is the tell; the
// resolver abstains rather than inventing a path.
const CLI_PROMPT_RE = /^[^ \t\r\n@/[\]]+@[^ \t\r\n@/[\]]+$/;

function classify(inner: string, absolute: boolean, depth: number): string {
	if (CLI_PROMPT_RE.test(trimAscii(inner))) return "cli-prompt-artifact";
	if (depth > 0) return "nested-bracket";
	if (absolute) return "absolute-inner-path";
	const head = (asciiWords(inner)[0] ?? "").toLowerCase();
	if (head.startsWith("$")) return "dynamic-invocation";
	if (head.startsWith(":")) return "scripting-directive";
	if (head === "find") return "bare-find";
	return "bare-inner-command";
}

function matchDelim(
	text: string,
	start: number,
	open: string,
	close: string,
): number {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			i = scanQuotedString(text, i).end - 1;
			continue;
		}
		if (c === open) depth++;
		else if (c === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return text.length;
}
