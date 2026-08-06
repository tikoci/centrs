/**
 * Verb / menu boundary resolution for `explain` (centrs canonicalizer).
 *
 * Ratified by the phase-0 lab, question Q6 (#185) and promoted from the
 * throwaway probe `.scratch/explain-lab-verbsplit.ts`. Q6 asks the residual the
 * path resolver (Q3/Q4) deliberately left open: within a statement's leading
 * path run, where does the MENU end and the VERB begin — and when must offline
 * refuse to guess? `pathresolve.ts` reports a greedy full-run `path` plus the
 * shorter `candidates`; this module decides the boundary and, crucially, emits
 * the ratified **`ambiguous`** verdict where a schema-free reading genuinely
 * cannot.
 *
 * The lab priced seven boundary policies (`minimal`, `greedy`, `last`,
 * `punctuation`, `vocab`, `abstain`, `proposed`) against the device command
 * tree as oracle. Only the ratified `proposed` arm is promoted — it scored
 * ~99.9% precision on decided statements at ~3% abstention and is entirely
 * version-independent (no schema snapshot, per decision 3). The other six arms
 * existed only to price it and stayed in the lab.
 *
 * The signals, all schema-free and read off the statement's own text:
 *   V1  Every run token carries a separator: `start`, `slash`, `space`.
 *       RouterOS console convention writes menu segments slash-joined and the
 *       verb space-separated, so the writer's punctuation is a boundary signal
 *       that Q3/Q4's flattened run threw away.
 *   V2  A token containing `=` is an ARGUMENT and ends the run. The only
 *       certain verb/arg tell offline has.
 *   V3  A `[`, `(`, `"`, `$` token ends the run.
 *   V4  Whether anything FOLLOWS the run is itself a signal. A statement that
 *       is nothing but a path (`/ip/address` vs `/system/reboot`) is textually
 *       identical whether it navigates to a directory or invokes a no-argument
 *       command — Q4's cascade residual. This is the ONLY case `proposed`
 *       abstains on, and it carries no length floor.
 *
 * The `proposed` rule, in order: a scripting directive's operand is positional
 * (R10) with the one measured sub-menu exception (`:log <level>`); then a
 * FROZEN 13-verb CRUD vocabulary; then punctuation (the maximal slash-joined
 * prefix is menu, the first space token is the verb); and abstention ONLY at
 * V4's bare path.
 *
 * **V4 is now decidable where the baked container table reaches it (#210).**
 * `splitRun` below still implements `proposed` exactly as ratified — it is the
 * schema-free rule, and it stays that way so its abstention rate remains an
 * honest price for decision 3. `resolveVerb` then reads that `ambiguous`
 * verdict and, for the bare-path case ONLY, asks `menus.ts` whether the path
 * the statement names is a known RouterOS container; if it is, the statement is
 * `navigation` rather than a refusal. `/ip/address` is in the table and
 * `/system/reboot` is not, which is precisely the twin V4 could not separate.
 * A path the table does not carry stays `ambiguous` — the table is a floor, so
 * absence is not evidence of a command (see `menus.ts`).
 *
 * That makes confident menu navigation this module's surface after all, but on
 * a firmer basis than `pathresolve.ts`'s `isNav`, which claims navigation for
 * every `/`-led bare path unconditionally and so reports `/system/reboot` as a
 * menu (#211). Where the two disagree, this module is the narrower answer.
 *
 * Like `blocks.ts`, this ships only the boundary primitives. Argument parsing
 * (`k=v` / `?query` after the verb) belongs to the phase-1 canonical assembly,
 * not to the Q6 question. `resolveVerb(text, context)` takes the enclosing menu
 * context explicitly; `resolveVerbs(text)` walks a whole document on top of the
 * resolver's context-certainty contract (#192).
 */

import { scopeBodies } from "./blocks.ts";
import type { Defect } from "./defects.ts";
import { isMenuPath } from "./menus.ts";
import { resolveStatements, type Span } from "./pathresolve.ts";
import { SUBMENU_DIRECTIVES, VERBS } from "./verbs.ts";

const ASCII_WHITESPACE = /[ \t\r\n]+/;
const BARE_WORD = /^[A-Za-z][A-Za-z0-9._-]*$/;
/**
 * A word that ends the leading run: it carries `=` (V2) or opens a group /
 * string / variable (V3). `:` is deliberately NOT here — RouterOS uses it only
 * to start a scripting directive, not as a mid-statement opener, and a
 * `:`-prefixed token is already rejected by `BARE_WORD` below, so it ends the
 * run regardless.
 */
const RUN_TERMINATOR = /^[[({"$]/;

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

function asciiWords(text: string): string[] {
	// H5 from the Q1 segmenter: a backslash-newline is removed before RouterOS
	// parses the continued line. Keep any surrounding spaces intact so the
	// writer's slash/space boundary signal remains observable.
	const trimmed = trimAscii(text.replace(/\\\r?\n/g, ""));
	return trimmed.length === 0 ? [] : trimmed.split(ASCII_WHITESPACE);
}

/**
 * The frozen vocabulary lives in the leaf `verbs.ts` because `pathresolve.ts`
 * needs it too (R9, #211) and this module already imports that one. Re-exported
 * here so the vocabulary still reads as part of the Q6 surface.
 */
export { SUBMENU_DIRECTIVES, VERBS } from "./verbs.ts";

/** Separator that precedes a run token (V1). */
export type Sep = "start" | "slash" | "space";

/** One token of the leading path run, with the punctuation that introduced it. */
export interface RunToken {
	name: string;
	sep: Sep;
}

/**
 * The leading path-token run WITH separators preserved (V1). Same stopping
 * rules as `pathresolve`'s run (V2/V3), so the two stay comparable: a slash-
 * joined word expands to several `slash`-separated tokens; a space-separated
 * word is one `space` token. Stops at the first `=`/group/string/var word, and
 * at any word carrying a non-`BARE_WORD` segment (a variable segment truncates
 * the run before the verb).
 */
export function runTokens(text: string): RunToken[] {
	const out: RunToken[] = [];
	for (const word of asciiWords(text)) {
		if (word.includes("=") || RUN_TERMINATOR.test(word)) break;
		const parts = word.split("/").filter((p) => p.length > 0);
		if (parts.length === 0) continue;
		if (!parts.every((p) => BARE_WORD.test(p))) break;
		for (let i = 0; i < parts.length; i++) {
			const leadingSlash = word.startsWith("/") && i === 0;
			out.push({
				name: parts[i] as string,
				sep:
					out.length === 0
						? "start"
						: i > 0 || leadingSlash
							? "slash"
							: "space",
			});
		}
	}
	return out;
}

/** True when the statement is a scripting directive (`:x`, or a bare `x do={…}`). */
export function isDirective(text: string): boolean {
	const t = trimAscii(text);
	if (t.startsWith(":")) return true;
	return !t.startsWith("/") && scopeBodies(t).length > 0;
}

/** Everything the boundary rule needs from one statement's text. */
export function describeStatement(text: string): {
	run: RunToken[];
	directive: boolean;
	whole: boolean;
} {
	const t = trimAscii(text);
	const body = t.startsWith(":") ? t.slice(1) : t;
	const run = runTokens(body);
	// V4 — did the run consume every whitespace-separated word? A slash-joined
	// word expands to several run tokens, so compare against the SOURCE words the
	// run covers, not the run length.
	const words = asciiWords(body);
	let covered = 0;
	let index = 0;
	for (const word of words) {
		const parts = word.split("/").filter((p) => p.length > 0);
		if (parts.length === 0) continue;
		if (index + parts.length > run.length) break;
		if (
			!parts.every(
				(p, i) => (run[index + i] as RunToken | undefined)?.name === p,
			)
		)
			break;
		index += parts.length;
		covered++;
	}
	return {
		run,
		directive: isDirective(text),
		whole: covered === words.length && run.length > 0,
	};
}

/** The verb/menu boundary decision for one run. */
export interface Split {
	/** Index of the verb inside the run, or null for "no verb decided". */
	verbAt: number | null;
	/**
	 * True when the schema-free rule cannot decide the run (V4's bare path).
	 * `resolveVerb` upgrades this to `navigation` when the container table
	 * recognizes the path; here it stays a refusal, so `splitRun`'s abstention
	 * rate keeps pricing `proposed` on its own terms.
	 */
	ambiguous: boolean;
	/** The rule that fired, for provenance. */
	why: string;
}

/** The maximal slash-joined prefix length: run[0..k-1] are all `start`/`slash`. */
function slashPrefixLen(run: RunToken[]): number {
	let k = 0;
	while (k < run.length && (run[k] as RunToken).sep !== "space") k++;
	return k;
}

/**
 * The ratified `proposed` boundary rule. `directive` marks a `:`/bare scripting
 * directive; `whole` is V4 (the run is the entire statement — nothing follows).
 */
export function splitRun(
	run: RunToken[],
	opts: { directive: boolean; whole: boolean },
): Split {
	if (run.length === 0)
		return { verbAt: null, ambiguous: false, why: "empty run" };

	if (opts.directive) {
		const head = (run[0] as RunToken).name;
		if (SUBMENU_DIRECTIVES.has(head) && run.length >= 2)
			return {
				verbAt: 1,
				ambiguous: false,
				why: "`:log <level>` — the one sub-menu directive",
			};
		return {
			verbAt: 0,
			ambiguous: false,
			why: "R10: a directive's operand is positional",
		};
	}

	const vocab = run.findIndex((t) => VERBS.has(t.name));
	if (vocab >= 0)
		return {
			verbAt: vocab,
			ambiguous: false,
			why: `vocabulary hit \`${run[vocab]?.name}\``,
		};

	// V4 — a statement that is nothing but a path carries no verb signal at all:
	// `/ip/address` (dir) and `/system/reboot` (no-arg cmd) are the same text.
	if (opts.whole)
		return {
			verbAt: null,
			ambiguous: true,
			why: "bare path, nothing follows — navigation or no-arg command?",
		};

	// Punctuation: the maximal slash-joined prefix is menu; the first space token
	// is the verb; with no space token but arguments following (V4 false), the
	// last run token is the verb (`/system/identity/print value=…`).
	const k = slashPrefixLen(run);
	return k < run.length
		? {
				verbAt: k,
				ambiguous: false,
				why: `first space token after ${k} slash-joined`,
			}
		: {
				verbAt: run.length - 1,
				ambiguous: false,
				why: "no space token, arguments follow — last segment",
			};
}

/** Whether a reading was decided, or refused. */
export type VerbResolution =
	| "resolved"
	| "navigation"
	| "ambiguous"
	| "unknown";

/** The verb/menu split of one statement, context applied. */
export interface VerbSplit {
	resolution: VerbResolution;
	/**
	 * `command` for a decided verb, `menu` for a bare path the container table
	 * confirms as navigation, `null` for `ambiguous`/`unknown`. These are the
	 * ratified envelope's two kinds (`commands/explain/README.md`), so phase 1
	 * renders them without inventing a third word for the same concept — the
	 * `navigation` resolution above maps to envelope `resolved` + `kind: "menu"`.
	 *
	 * This is **fully derived** from `resolution` and carries no independent
	 * information: `resolution` says what the analyzer did, `kind` says what the
	 * statement is. It is kept because it is the envelope's vocabulary and the
	 * field phase 1 renders, and the mapping is pinned in both directions by a
	 * test so the two can never drift apart.
	 */
	kind: "command" | "menu" | null;
	/**
	 * The menu path: context + the run before the verb when `resolved`, and the
	 * whole run when `navigation` (a navigation statement names only a menu).
	 * Null for `ambiguous`/`unknown`.
	 */
	path: string | null;
	/** The verb token; null unless `resolved`. */
	verb: string | null;
	/** Index of the verb within the run; null unless `resolved`. */
	verbAt: number | null;
	/** Context extended by each run prefix — the path readings. */
	candidates: string[];
	/** The rule that fired, for provenance. */
	why: string;
}

/** Join a base menu with bare run segments (run tokens are `BARE_WORD`, no `..`/`.`). */
function joinBase(base: string, names: string[]): string {
	const parts = [...base.split("/").filter(Boolean), ...names];
	return `/${parts.join("/")}`;
}

function unknownSplit(why: string): VerbSplit {
	return {
		resolution: "unknown",
		kind: null,
		path: null,
		verb: null,
		verbAt: null,
		candidates: [],
		why,
	};
}

/**
 * Resolve one statement's verb/menu boundary, applying the enclosing menu
 * `context`. Mirrors `pathresolve`'s base rule: a `:`/bare directive and an
 * absolute (`/`) statement resolve at the root; everything else inherits
 * `context`. Substitution-headed and variable-segment statements are `unknown`
 * — offline refuses rather than guessing (the Q3/Q4/Q14 fail-closed floor).
 */
export function resolveVerb(text: string, context: string): VerbSplit {
	const t = trimAscii(text);
	if (t.startsWith("$") || t.startsWith("[") || t.startsWith("("))
		return unknownSplit("dynamic or substitution-headed statement");

	const { run, directive, whole } = describeStatement(text);
	if (run.length === 0) return unknownSplit("no leading path token");
	if (
		!directive &&
		!t.startsWith("/") &&
		!t.startsWith(":") &&
		!VERBS.has((run[0] as RunToken).name)
	)
		return unknownSplit("bare-word head is not a known verb");

	// `directive` already folds in the bare-directive case (`isDirective`), so it
	// stands in for the `:`-prefixed and `x do={…}` readings — no second
	// `scopeBodies` scan. A directive or an absolute (`/`) statement resolves at
	// the root; everything else inherits `context`.
	const base = directive || t.startsWith("/") ? "/" : context;

	const candidates: string[] = [];
	for (let k = 1; k <= run.length; k++)
		candidates.push(
			joinBase(
				base,
				run.slice(0, k).map((r) => r.name),
			),
		);

	const split = splitRun(run, { directive, whole });
	if (split.ambiguous) {
		// V4's bare path, the one case `proposed` refuses — and the one the baked
		// container table can answer (#210). The lookup reads the LAST candidate,
		// which is the whole run with `base` already applied, so it stays correct
		// under a non-root context instead of relying on the (currently true)
		// property that only `/`-led statements reach here.
		const full = candidates[candidates.length - 1] as string;
		if (isMenuPath(full.split("/").filter(Boolean)))
			return {
				resolution: "navigation",
				kind: "menu",
				path: full,
				verb: null,
				verbAt: null,
				candidates,
				why: "bare path, and a known RouterOS menu — navigation",
			};
		return {
			resolution: "ambiguous",
			kind: null,
			path: null,
			verb: null,
			verbAt: null,
			candidates,
			why: split.why,
		};
	}
	if (split.verbAt === null) return unknownSplit(split.why);

	const j = split.verbAt;
	return {
		resolution: "resolved",
		kind: "command",
		path: joinBase(
			base,
			run.slice(0, j).map((r) => r.name),
		),
		verb: (run[j] as RunToken).name,
		verbAt: j,
		candidates,
		why: split.why,
	};
}

/**
 * One statement's split, as seen by the DOCUMENT walker.
 *
 * The two extra fields are the difference between the entry points, and both are
 * required rather than optional on purpose. `resolveVerb` is handed one
 * statement and an explicit context, so it has nothing to say about where that
 * statement sits or whether the context was knowable; `resolveVerbs` walks the
 * document and always does. An optional flag would make "absent" mean both
 * "single-statement call" and "certain", and the whole point of the field is
 * that silence must not read as certainty.
 */
export interface DocumentVerbSplit extends VerbSplit {
	/**
	 * This statement in DOCUMENT analyzed-byte space, straight from the resolver.
	 *
	 * Carried because the walk FLATTENS: a block body's statements are appended
	 * after their parent, so `splits` is longer than the top-level segmentation
	 * and a caller pairing the two by index silently attaches the wrong span to every
	 * statement after the first `do={…}`. With the span here there is nothing to
	 * pair — the location travels with the reading.
	 */
	span: Span;
	/**
	 * Was the menu context in force BEFORE this statement known? (Q14 C3b, #192.)
	 *
	 * `false` does NOT invalidate `path`: the resolver already degrades every
	 * context-DEPENDENT statement to `unresolved` when context is lost, so a split
	 * that still says `resolved` here resolved WITHOUT consuming the context — an
	 * absolute path, a `:` directive, or a bare directive. What this carries is
	 * the thing that was otherwise dropped on the floor: `/ip) address` followed
	 * by `/ip route print` yields a perfectly correct `resolved` split whose
	 * document had already lost its context, and a consumer ranking readings or
	 * offering completions needs to know that.
	 */
	contextCertain: boolean;
}

/** A document's per-statement verb/menu splits, plus structural defects. */
export interface VerbAnalysis {
	splits: DocumentVerbSplit[];
	/** Located structural surprises; see `defects.ts`. */
	defects: Defect[];
}

/**
 * Verb/menu split of every statement in source order, tracking the persistent
 * menu context via the shipped Q4 resolver (`resolveStatements`).
 *
 * This walker was pulled from the Q6 PR (#193) because it fabricated on the
 * Q14 C3b cascade: after an upstream defect destroyed the document context, a
 * following relative statement headed by a known CRUD verb still resolved
 * confidently against the stale value. It returns unchanged in shape, because
 * the fix belonged in the resolver, not here — `resolveStatements` now degrades
 * exactly the context-DEPENDENT statements to `unresolved` when the context is
 * lost, while leaving a context-NEUTRAL dynamic head (`$x`) alone. So the
 * single rule below — a statement the resolver refused stays `unknown` here —
 * fails closed on the cascade without a local taint that would over-fire on
 * benign statements. The distinction is only visible to the resolver; this
 * module sees flattened statements.
 *
 * What the walker does add is {@link DocumentVerbSplit.contextCertain} and
 * {@link DocumentVerbSplit.span}: the resolver's per-statement certainty and
 * location, carried through instead of dropped. The certainty was the last of
 * #192's three bullets — the cascade FIX shipped in #197, but the signal it
 * produced stopped here.
 *
 * The returned array is the RESOLVER's statement list, which is longer than the
 * top-level segmentation: a `do={…}` body's statements are flattened in after
 * their parent (matching what IL does to them), so a body statement's span is
 * CONTAINED by its parent's rather than following it. Read the spans; do not
 * pair this array with `segmentStatements` by index.
 */
export function resolveVerbs(text: string): VerbAnalysis {
	const { statements, defects } = resolveStatements(text);
	return {
		splits: statements.map((s) => ({
			...(s.unresolved
				? unknownSplit(s.unresolved)
				: resolveVerb(s.text, s.context)),
			span: s.span,
			contextCertain: s.contextCertain,
		})),
		defects,
	};
}
