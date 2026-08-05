/**
 * Offline write-shape inference for `explain` — `structure.containsWrite`.
 *
 * Ratified by the phase-0 lab, question Q16 (#185) and promoted from the
 * throwaway probe `.scratch/explain-lab-q16-write.ts`. Q16 asked what shape the
 * field should have and answered that the spec's sketched **boolean is unsafe**:
 * a fail-closed `true | false | unknown` reaches 100% precision on what it
 * decides (226/226 holdout, 469/469 dev) with zero false negatives, abstaining
 * on ~35%, while a two-valued field would have to call `/disk format-drive` a
 * non-write. The tristate is the ratified amendment; this module implements it.
 *
 * **This is not the execute gate.** `canonicalizeExecuteCommand`'s `mode` /
 * `writeShaped` verdict is reproduced verbatim elsewhere and is unchanged by
 * anything here (constitution: canonicalizer ownership). `containsWrite` is a
 * distinct explain-only inference with basis `heuristic`, so an agent can never
 * mistake it for a guard `execute` actually applies.
 *
 * **Write-ness is not device-published.** No schema artifact carries mutation
 * semantics: `inspect.json` tags nodes `path|dir|cmd|arg` and nothing more, and
 * restraml's `openapi.json` method assignment is rule-derived (2,844 of 3,649
 * endpoints are a `post` catch-all), so reading it back would be circular. The
 * table below is therefore CURATED, which makes its edges the whole question —
 * hence `unknown` as a first-class outcome rather than a synonym for "no". The
 * gap is standing, not staleness: a 17-name table covers 93.1% of cmd nodes on
 * 7.24beta1 and 93.8% on 7.9.2 (flat to 0.7pp across all of 7.x, ~0.07% churn
 * per minor version), yet 56 of the 225 uncovered verb names on 7.24beta1 are
 * write-shaped (`reboot`, `format`, `delete`, `reset-configuration`, `sign`,
 * `flush`, …).
 *
 * **Two vocabularies, measured not guessed.** Menu verbs are the CRUD verbs —
 * every entry appears under 45+ menus in all 52 trees 7.9→7.24beta1, with none
 * added or removed. Root cmds are RouterOS scripting directives, a CLOSED list
 * enumerated from the tree (41 names on 7.9.2, 55 on 7.24beta1, +15/−1 over the
 * whole 7.x series). The root list is load-bearing: `set`, `find`, `export`,
 * `import`, `password`, `undo` and `redo` are ALL root cmds as well as menu
 * verbs and do not mean the same thing in both places — `:set x 5` assigns a
 * script variable, `/ip/route set …` writes the device. Write-ness genuinely
 * depends on the menu, but only across that one boundary, which is exactly the
 * boundary Q6 measured at 99.9% precision. Q16 composes with Q6 rather than
 * needing a schema of its own (decision 3 stays closed).
 *
 * **What #207 changed, and what it did NOT.** This module now reads one baked
 * artifact, `menus.ts` — the `dir`/`path` node set, i.e. exactly the
 * `path|dir|cmd|arg` tagging named above as carrying no mutation semantics. It
 * still carries none, and nothing here infers write-ness from it. It answers a
 * strictly narrower question that Q6 leaves open: whether a bare path is a
 * MENU or a no-argument command. Decision 3 stays closed — the two vocabularies
 * above are unchanged, still curated, still frozen against tuning — and the
 * module stays offline, because a baked constant is not a lookup.
 *
 * **Fail-closed is enforced where input is DISCARDED, not where it is
 * classified** (Q16 finding 2, the part worth carrying past this module). The
 * lab priced three navigation arms; only the ratified `failclosed` one is
 * promoted. The two naive arms are not actually fail-closed whatever the rollup
 * rule says: `/interface ethernet reset-counters` is bare-word-shaped, so Q4's
 * nav rule swallows the statement, AND carries a verb outside Q6's frozen
 * table, so the verb rule cannot rescue it — and a swallowed statement produces
 * no occurrence, so nothing is left to abstain about and the document
 * confidently reports "no write". The two abstention mechanisms cancelled
 * instead of composing. A classifier can only be conservative about what it is
 * given, so every statement that cannot be CONFIRMED as navigation emits an
 * occurrence here. Cost on holdout: +0.8pp abstention, and the overconfident
 * bin halves.
 *
 * That rule binds the BRACKET walk exactly as it binds the statement walk, and
 * the two must be kept in step. Both fail-closed guards below — the Q14 defect
 * floor and the path-shaped-but-unread abstention — were originally applied to
 * statements only, so `/ip/$menu/remove 0` abstained while `:put [/ip/$menu/remove
 * 0]` cleared the document to a confident `false`. Discarding input inside a
 * bracket discards it just as thoroughly. Cost of closing it over the frozen
 * 911-script corpus: +0.8pp abstention on both splits (7 documents, all
 * `false` -> `unknown`, none off `true`), and two of the seven are pasted CLI
 * transcripts that hide a real write behind the `[user@device]` prompt — i.e.
 * genuine false negatives the tristate exists to prevent.
 */

import { isMenuPath } from "./menus.ts";
import {
	type DocumentAnalysis,
	resolveDocument,
	resolveStatements,
	type StatementAnalysis,
	type StatementResolution,
} from "./pathresolve.ts";
import { describeStatement, type RunToken, splitRun } from "./verbsplit.ts";

/** One statement's run, directive flag and V4 flag — parsed once, read by every rule. */
type Described = ReturnType<typeof describeStatement>;

/**
 * Menu verbs that mutate persistent device state. Frequency-justified against
 * the command trees, and frozen against tuning per the Q6 vocabulary discipline
 * — this is a curated list, not a schema, and its honesty depends on it not
 * being fitted to scoring output.
 */
export const WRITE_VERBS: ReadonlySet<string> = new Set([
	"add",
	"remove",
	"set",
	"unset",
	"enable",
	"disable",
	"comment",
	"move",
	"edit",
	"reset",
	// Counter resets mutate device state (statistics), not configuration. They
	// are included because this field is a SAFETY signal, and the same frequency
	// justification applies: `reset-counters` under 29 menus and
	// `reset-counters-all` under 18, in every tree 7.9→7.24beta1.
	"reset-counters",
	"reset-counters-all",
]);

/** Menu verbs that read only. `export` emits config, it does not apply it. */
export const READ_VERBS: ReadonlySet<string> = new Set([
	"print",
	"get",
	"find",
	"export",
	"monitor",
]);

/**
 * Root cmds (scripting directives) that DO mutate device state. Four names, and
 * the argument for each is that its documented effect is a configuration
 * change, not that its name merely looked mutating:
 *   `password`  changes the logged-in user's password
 *   `undo`      reverts the previous configuration change
 *   `redo`      re-applies it
 *   `import`    applies an .rsc file to the configuration
 * Every other root cmd is control flow, a pure function, or output.
 */
export const ROOT_WRITE: ReadonlySet<string> = new Set([
	"password",
	"undo",
	"redo",
	"import",
]);

/**
 * Root cmds that run a command built at runtime. Offline cannot see what they
 * will do, so they force `unknown` — never `false`.
 */
export const ROOT_DYNAMIC: ReadonlySet<string> = new Set(["execute", "parse"]);

/**
 * The closed root-cmd vocabulary, union across the 7.9.2 / 7.20.8 / 7.23rc1 /
 * 7.24beta1 trees. Membership is what makes a root-level command classifiable
 * at all: a root cmd NOT in this set is a directive this table has not seen, so
 * it abstains rather than being read as harmless control flow.
 */
export const ROOT_CMDS: ReadonlySet<string> = new Set([
	"beep",
	"break",
	"continue",
	"convert",
	"delay",
	"deserialize",
	"do",
	"error",
	"execute",
	"exit",
	"export",
	"find",
	"for",
	"foreach",
	"global",
	"grep",
	"if",
	"import",
	"jobname",
	"len",
	"local",
	"lock",
	"nothing",
	"onerror",
	"parse",
	"password",
	"pick",
	"ping",
	"put",
	"quit",
	"range",
	"recursive-print",
	"redo",
	"resolve",
	"retry",
	"return",
	"rndnum",
	"rndstr",
	"serialize",
	"set",
	"time",
	"timestamp",
	"toarray",
	"tobool",
	"tocrlf",
	"toid",
	"toip",
	"toip6",
	"tolf",
	"tonsec",
	"tonum",
	"tostr",
	"totime",
	"typeof",
	"undo",
	"while",
]);

/**
 * The `pathresolve` refusal reasons that name no command at this level, so the
 * statement may be classified normally instead of blocking. Deliberately an
 * ALLOW list: an unrecognized reason is treated as a defect, so this composition
 * fails closed when the resolver grows a new one.
 *
 * `no leading path token` is clearable only because `classifyStatement`'s
 * `isPathShapedButUnread` guard catches the dangerous half of it — the run of a
 * `/`-led statement being TRUNCATED by a variable segment (`/ip/$menu/remove`)
 * rather than genuinely absent (`"a string"`, `=`).
 */
const CLEARABLE_UNRESOLVED: ReadonlySet<string> = new Set([
	"dynamic or substitution-headed statement",
	"no leading path token",
]);

/**
 * Whether the command itself is not statically knowable, so the verdict must
 * degrade to `unknown` rather than `false`. Checked BEFORE the navigation gate:
 * `/system/script run myscript` is entirely bare words, so the nav rule would
 * otherwise drop the one form that is unknowable by definition.
 *
 * Read the leading run rather than searching the raw statement. A raw substring
 * probe masks known writes whose argument merely contains `/system script run`,
 * and separate slash/space regexes miss valid mixed spellings such as
 * `/system/script run myscript`.
 */
function isDynamicForm(text: string, described: Described): boolean {
	if (text.startsWith("$") || /^\[\s*\$/.test(text)) return true;
	if (!text.startsWith("/") || described.run.length < 3) return false;
	const [system, script, run] = described.run;
	return (
		system?.name.toLowerCase() === "system" &&
		script?.name.toLowerCase() === "script" &&
		run?.name.toLowerCase() === "run"
	);
}

/**
 * The tristate. Rendered to the `structure.containsWrite` JSON field as
 * `true | false | "unknown"`; kept as a string union here so `unknown` can
 * never be reached by boolean coercion.
 */
export type WriteVerdict = "true" | "false" | "unknown";

/** How one classified command occurrence bears on the rollup. */
export type OccurrenceClass =
	/** A curated write verb, in the vocabulary that matches its position. */
	| "write"
	/** A curated read verb. */
	| "read"
	/** A decided verb outside both curated tables — abstains. */
	| "unknown-verb"
	/**
	 * A path-shaped statement whose verb/menu boundary Q6 refused — abstains.
	 * `/system/reboot` and `/ip/address` are the same text, so a bare path may be
	 * a no-argument WRITE. See the note on `classifyStatement`.
	 */
	| "ambiguous"
	/** The command is built at runtime; offline cannot read it — abstains. */
	| "dynamic"
	/** A statement the path resolver refused (Q14 structural defect) — abstains. */
	| "defect"
	/**
	 * The statement has no leading path run at all (it opens with `[`, `(` or a
	 * string), so it names no command. Carries no write signal either way — an
	 * inner `[…]` command is reached by the bracket walk instead.
	 */
	| "no-verb";

/** One command offline can see, at any block or bracket depth. */
export interface Occurrence {
	kind: "statement" | "bracket";
	/** Trimmed source text of the statement or bracket inner. */
	text: string;
	/** Menu context in force, `/` at document root. */
	context: string;
	/** The verb the Q6 boundary decided, or null. */
	verb: string | null;
	/** Root-level (`:foo` or a root cmd) rather than a menu command. */
	directive: boolean;
	klass: OccurrenceClass;
}

/** Classify one decided verb in its position. The (menu, verb) dependency. */
export function classifyVerb(
	verb: string | null,
	directive: boolean,
): OccurrenceClass {
	if (verb === null) return "no-verb";
	const v = verb.toLowerCase();
	if (directive) {
		if (ROOT_DYNAMIC.has(v)) return "dynamic";
		if (ROOT_WRITE.has(v)) return "write";
		if (ROOT_CMDS.has(v)) return "read";
		return "unknown-verb";
	}
	if (WRITE_VERBS.has(v)) return "write";
	if (READ_VERBS.has(v)) return "read";
	return "unknown-verb";
}

/** The verb Q6's ratified boundary decides for a run, or null if it refuses. */
function verbOfRun(
	run: RunToken[],
	directive: boolean,
	whole: boolean,
): string | null {
	const split = splitRun(run, { directive, whole });
	if (split.ambiguous || split.verbAt === null) return null;
	return (run[split.verbAt] as RunToken | undefined)?.name ?? null;
}

/**
 * Can this statement be CONFIRMED as pure menu navigation? Only when the path it
 * names is a known menu — which is now decidable offline, against the baked
 * container table in `menus.ts`.
 *
 * **What this replaced, and why (#207).** The original rule read token SHAPE: a
 * hyphenated word anywhere after the first token is verb-shaped
 * (`reset-counters`, `format-drive`, `firmware-upgrade`), and testing only the
 * final token would miss `/disk format-drive disk1`, where the verb carries a
 * positional operand. The reasoning was sound; the premise was not. Hyphenated
 * MENU segments are ordinary on a real device, so the rule fired on genuine
 * navigation constantly — measured on the #203 export stratum (120 captures,
 * pinned 7.23.2 and 7.24rc2), **every Q16 abstention in the entire stratum was
 * this one rule**, across 25 distinct menus, at a 100% false-positive rate.
 *
 * The corpus could not have shown it: the rule fires on 2.97% of documents and
 * changes the verdict of three, because the corpus is 96.8% two forum authors
 * writing scripts, and bare-path navigation into a hyphenated menu is an
 * *export* idiom. Corpus-green was not evidence the rule was right.
 *
 * **Why shape cannot be fixed.** `/interface wireless reset-configuration wlan1`
 * is a command, `/ip dhcp-server network` and `/tool mac-server mac-winbox` are
 * menus, and no token-shape rule separates them — the distinction is semantic.
 * `menus.ts` supplies it as a baked constant rather than a live lookup, so this
 * module stays offline. See that file for the source pin.
 *
 * **Still fail-closed, and in both directions.** A path the table does not carry
 * is not confirmed navigation, so it emits an occurrence and abstains — the
 * pre-#207 behaviour for an unrecognized menu, and the reason a pinned,
 * deliberately incomplete table is safe. Going the other way, a bare-path
 * COMMAND is no longer confirmed as navigation at all: `/system reboot` used to
 * pass this rule (no hyphen) and be dropped mid-document, clearing the document
 * to `false` on a statically obvious write. That was the exact false negative
 * Q16's hard threshold forbids, and only `isDanglingBarePath` below caught the
 * end-of-document case. It is closed here.
 *
 * Measured over the frozen 911-script corpus: abstention **unchanged** at 44.8%
 * dev / 46.0% holdout, and exactly two documents move, in opposite directions.
 * One gains an abstention (a pasted `/system/gps/monitor once` transcript, where
 * the abstention is correct). One loses one — a rextended snippet whose elided
 * `... script=… ...` line names no command, so its `unknown` was reached only
 * *via* this bug misreading `/ip dhcp-client`; the residual question of how
 * elided pastes should classify belongs to #192, not here. On the export stratum
 * abstention drops from 3.8% compact / 11.2–11.6% verbose to **0.0% on every
 * stratum**, with no document changing verdict.
 */
function isConfirmedNav(described: Described): boolean {
	// Only reached for a statement the Q4 resolver already read as navigation, so
	// an empty run means the bare `/` or `..` forms — the two Q4's CHR round
	// confirmed as valid RouterOS navigation. They name no command at all.
	if (described.run.length === 0) return true;
	// Argument-looking text after the run means this was never navigation.
	if (!described.whole) return false;
	return isMenuPath(described.run.map((t) => t.name));
}

/**
 * A bare path with NOTHING after it in the whole document. Q6 ratified that such
 * a statement is `ambiguous` — `/ip/route` is a directory and `/system/reboot` is
 * a no-argument command, and the text is identical — but `isConfirmedNav` above
 * decides at STATEMENT scale and would drop both as navigation, so a lone or
 * trailing `/system/reboot` cleared the document to `false`. That is a false
 * negative on a statically obvious write, the one thing Q16's hard threshold
 * forbids, and it reproduces inside the tristate exactly the failure the tristate
 * was ratified to prevent.
 *
 * Position was the one schema-free confirmation available at document scale:
 * navigating and then ending the script is a no-op, while a no-argument command
 * is meaningful. This is deliberately the WEAKEST rule that closes the reported
 * case — measured over the frozen 911-script corpus it moves **zero** documents,
 * so the ratified navigation arm's abstention (44.0% dev / 45.2% holdout) is
 * unchanged. Every corpus bare path sits mid-document, followed by further
 * statements; working scripts do not end on a menu path.
 *
 * **#207 narrowed what this rule is for.** `isConfirmedNav` now knows whether the
 * path is a menu, so `/system/reboot` is refused there — at any position, and
 * without the +1.4pp / +1.9pp abstention that closing it positionally would have
 * cost. What is left here is a document-scale hedge over paths the table DOES
 * carry: a known menu that ends the document is still suspicious, since a
 * trailing no-op is not what working scripts do, and the table is version-less
 * so a name can be a menu on one RouterOS and a command on another the pinned
 * trees never saw. Retained on that basis; it fires on no corpus document and no
 * export capture.
 *
 * The bare `/` and `..` forms are exempt: they carry no run, name no command, and
 * Q4's CHR round confirmed them as navigation outright.
 *
 * `lastNonEmpty` is the index of the document's last non-blank statement, walked
 * once by `collect`; a statement at or past it is followed only by blanks.
 */
function isDanglingBarePath(
	described: Described,
	lastNonEmpty: number,
	index: number,
): boolean {
	if (described.run.length === 0) return false;
	return index >= lastNonEmpty;
}

/** Does the run carry a token Q6's boundary would call the verb? */
function isCommandShaped(described: Described): boolean {
	if (described.run.length === 0) return false;
	const split = splitRun(described.run, {
		directive: described.directive,
		whole: described.whole,
	});
	return !split.ambiguous && split.verbAt !== null;
}

/**
 * Classify one statement the Q4 walker read as navigation but Q6 could not
 * confirm as a command. Reached only when every other rule has already
 * abstained, so it falls back to Q6's `last`-token reading purely to obtain a
 * verb CANDIDATE — and is never allowed to produce `false`: an unrecognized
 * candidate stays `unknown-verb`, and even a recognized READ verb is downgraded
 * to `unknown-verb`, because the reading that produced it is not trusted enough
 * to clear the document.
 */
function classifyUnconfirmedNav(
	statement: StatementResolution,
	text: string,
	described: Described,
): Occurrence {
	const run = described.run;
	const candidate = (run[run.length - 1] as RunToken | undefined)?.name ?? null;
	const klass =
		candidate === null ? "unknown-verb" : classifyVerb(candidate, false);
	return {
		kind: "statement",
		text,
		context: statement.context,
		verb: candidate,
		directive: false,
		klass: klass === "read" ? "unknown-verb" : klass,
	};
}

/**
 * Classify a statement that reached neither the dynamic, defect, nor
 * navigation branch: read Q6's boundary and look the verb up in the vocabulary
 * that matches its position.
 *
 * The `ambiguous` arm is where this composition departs from the lab SUT, and
 * it is a fail-closed correction rather than a port. The lab's path resolver
 * called any all-bare-word statement navigation, so a bare-word head reached
 * the unconfirmed-nav fallback and was classified from its last token. The
 * production resolver does not: `menuNavPath` requires a leading `/`, because
 * Q4's CHR round confirmed bare-word navigation is not valid RouterOS. That
 * correction means a statement like `reset-counters` (relative to an
 * `/interface` context) now arrives here with V4 ambiguity and no decided verb
 * — and clearing it would be a false negative on a curated write verb, the one
 * thing Q16's hard threshold forbids. So an undecided boundary over a non-empty
 * run abstains, which is Q14's rule (b) — a bare-word-headed statement degrades
 * to `unknown` — enforced at the rollup.
 */
function classifyStatement(
	statement: StatementResolution,
	text: string,
	described: Described,
): Occurrence {
	const verb = verbOfRun(described.run, described.directive, described.whole);
	// A single-token command at document root is a root cmd written without its
	// `:` sigil (`/import file-name=…`), so it reads against the root vocabulary
	// rather than the menu one.
	const directive =
		described.directive ||
		(verb !== null && statement.context === "/" && described.run.length === 1);
	const klass =
		verb === null && isPathShapedButUnread(text, described)
			? "ambiguous"
			: classifyVerb(verb, directive);
	return {
		kind: "statement",
		text,
		context: statement.context,
		verb,
		directive,
		klass,
	};
}

/**
 * Does this text name a command the run could not read? Used to decide whether
 * a `null` verb may clear the document or must abstain.
 *
 * A NON-EMPTY run with no decided verb is V4's bare path — Q6's ratified
 * `ambiguous`. An EMPTY run usually means the text names no command at this
 * level (`[find]`, `(1)`, `"a string"`, `=`) and is safely `no-verb`: an inner
 * `[…]` command is reached by the bracket walk instead.
 *
 * The exception is a `/`-led statement, where an empty run means the run was
 * TRUNCATED rather than absent — `runTokens` stops at the first segment that is
 * not a bare word, so `/ip/$menu/remove 0` and `/ip/$m/add address=…` yield an
 * empty run while plainly naming a write. Clearing those is a false negative on
 * a curated write verb, so a path-shaped statement whose path could not be read
 * abstains.
 */
function isPathShapedButUnread(text: string, described: Described): boolean {
	return described.run.length > 0 || text.startsWith("/");
}

/**
 * Every command occurrence offline can see: statements at every block depth
 * (Q4's stateful walker) plus bracket-inner commands at every nesting depth
 * (Q3's resolver).
 *
 * The ORDER carries no meaning, even though the list is emitted in source order
 * and repeats are significant (`writes` counts multiplicity — do not dedupe).
 * Both lab harness bugs corrected during phase 0 were alignment bugs, where a
 * positional correspondence silently lined the wrong pair up; `containsWrite`
 * consumes this only as a rollup, so it cannot repeat that failure.
 */
export function occurrences(text: string): Occurrence[] {
	return collect(resolveStatements(text), resolveDocument(text));
}

function collect(
	statements: StatementAnalysis,
	brackets: DocumentAnalysis,
): Occurrence[] {
	const out: Occurrence[] = [];
	const list = statements.statements;
	// Walked once here rather than per statement, so the dangling-bare-path rule
	// stays O(n) on nav-heavy documents.
	let lastNonEmpty = -1;
	for (let i = list.length - 1; i >= 0; i--)
		if ((list[i] as StatementResolution).text.trim().length > 0) {
			lastNonEmpty = i;
			break;
		}

	for (let index = 0; index < list.length; index++) {
		const statement = list[index] as StatementResolution;
		const t = statement.text.trim();
		if (t.length === 0) continue;
		// One parse per statement, threaded through every rule below: the Q6
		// boundary reads the same run three or four times otherwise.
		const described = describeStatement(t);
		if (isDynamicForm(t, described)) {
			out.push({
				kind: "statement",
				text: t,
				context: statement.context,
				verb: null,
				directive: false,
				klass: "dynamic",
			});
			continue;
		}
		// Q14 floor — the resolver refused this statement and did not descend, so
		// a write may be hiding in a body that was never walked. Only the reasons
		// on the safe list clear: those name no command at this level, and their
		// inner brackets are classified by the bracket walk below. Any OTHER
		// reason blocks, including one this list has not seen — so rewording a
		// reason in `pathresolve` degrades to over-abstention rather than
		// silently clearing a hidden write.
		if (
			statement.unresolved !== undefined &&
			!CLEARABLE_UNRESOLVED.has(statement.unresolved)
		) {
			out.push({
				kind: "statement",
				text: t,
				context: statement.context,
				verb: null,
				directive: false,
				klass: "defect",
			});
			continue;
		}
		if (statement.isNav && !isCommandShaped(described)) {
			if (
				isConfirmedNav(described) &&
				!isDanglingBarePath(described, lastNonEmpty, index)
			)
				continue;
			out.push(classifyUnconfirmedNav(statement, t, described));
			continue;
		}
		out.push(classifyStatement(statement, t, described));
	}

	for (const bracket of brackets.resolutions) {
		const inner = bracket.inner.trim();
		if (inner.length === 0) continue;
		const described = describeStatement(inner);
		if (isDynamicForm(inner, described)) {
			out.push({
				kind: "bracket",
				text: inner,
				context: bracket.context,
				verb: null,
				directive: false,
				klass: "dynamic",
			});
			continue;
		}
		// The same Q14 defect floor the statement walk applies above. A bracket
		// carries its own refusal reasons and its own vocabulary — `variable path
		// segment` is reachable here but not at statement scale — so the ALLOW
		// list does the same work: an unrecognized reason blocks.
		if (
			bracket.unresolved !== undefined &&
			!CLEARABLE_UNRESOLVED.has(bracket.unresolved)
		) {
			out.push({
				kind: "bracket",
				text: inner,
				context: bracket.context,
				verb: null,
				directive: false,
				klass: "defect",
			});
			continue;
		}
		const verb = verbOfRun(described.run, described.directive, described.whole);
		const klass =
			verb === null && isPathShapedButUnread(inner, described)
				? "ambiguous"
				: classifyVerb(verb, described.directive);
		out.push({
			kind: "bracket",
			text: inner,
			context: bracket.context,
			verb,
			directive: described.directive,
			klass,
		});
	}

	return out;
}

/** Q16 result: the tristate plus everything the caller needs to see why. */
export interface WriteAnalysis {
	verdict: WriteVerdict;
	/** How many occurrences were proven writes. Agreed with IL 100% on both splits. */
	writes: number;
	/**
	 * Unclassifiable occurrences. These force `unknown` only when no proven write
	 * exists; rule 1 may therefore return `true` with blockers still reported.
	 */
	blockers: Occurrence[];
	occurrences: Occurrence[];
	/** Structural notes from the segmenter / bounded traversal; any note abstains. */
	notes: string[];
}

const BLOCKING: ReadonlySet<OccurrenceClass> = new Set([
	"unknown-verb",
	"ambiguous",
	"dynamic",
	"defect",
]);

/**
 * Fail-closed rollup, per the four rules ratified with the tristate:
 *
 * 1. A proven write wins outright — an `unknown` elsewhere cannot make a
 *    document that definitely writes stop writing.
 * 2. With no proven write, ANY unclassifiable occurrence yields `unknown`,
 *    never `false`. That is the spec's zero-false-negative requirement
 *    expressed as a rule rather than a hope.
 * 3. Statements the parser cannot confirm as navigation emit an occurrence
 *    rather than being dropped (enforced in `occurrences`).
 * 4. `unknown` is reported with its blockers, so the caller can see why.
 *
 * A document-level structural note (unterminated string, over-depth nesting)
 * means part of the input was never walked, so it abstains under rule 2 for the
 * same reason a `defect` occurrence does.
 */
export function containsWrite(text: string): WriteAnalysis {
	// One resolution pass each for the statement walk (Q4) and the bracket walk
	// (Q3); both are re-entrant over the same segmentation and neither is cheap
	// on adversarial input, so they are not re-run for the notes.
	const statements = resolveStatements(text);
	const brackets = resolveDocument(text);
	const found = collect(statements, brackets);
	const notes = [...new Set([...statements.notes, ...brackets.notes])];
	const writes = found.filter((o) => o.klass === "write").length;
	const blockers = found.filter((o) => BLOCKING.has(o.klass));
	if (writes > 0)
		return { verdict: "true", writes, blockers, occurrences: found, notes };
	if (blockers.length > 0 || notes.length > 0)
		return {
			verdict: "unknown",
			writes: 0,
			blockers,
			occurrences: found,
			notes,
		};
	return {
		verdict: "false",
		writes: 0,
		blockers: [],
		occurrences: found,
		notes,
	};
}
