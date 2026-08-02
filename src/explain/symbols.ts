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
 *       the enclosing brace scope; an inner `:local` shadows an outer one.
 *   S2  `:global NAME` declares NAME `global`, visible for the remainder of
 *       the document regardless of brace nesting.
 *   S3  `:foreach A[,B] in=… do={…}` / `:for I from=… do={…}` declare their
 *       loop variables `auto`.
 *   S4  A reference resolves to the nearest enclosing declaration and takes
 *       its class.
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
 *   S18 `:onerror NAME` binds NAME `local`.
 *   S19 `-` is both legal inside a name (`$set-dns`) and the subtraction
 *       operator (`$octive-1`); the tie is broken by the longest prefix that
 *       resolves against the document's OWN declarations.
 *
 * Two behaviors go BEYOND the lab SUT. Neither is invented: the probe declared
 * both and left them unmodeled (it was throwaway and depth-scoped), and F2 is
 * required verbatim by the ratified spec — `commands/explain/README.md`, "Symbol
 * scopes follow RouterOS scope identity, not brace depth alone". Each was priced
 * against the frozen corpus streams before being shipped, then device-verified
 * per occurrence on CHR 7.23.2 (`.scratch/q13-arms.ts` + `-arms-score.ts` +
 * `-anchor-chr-probe.ts`, the Q16 re-score method):
 *
 *   F1  A `$[…]` / `$(…)` substitution inside a double-quoted string is CODE
 *       (Q3 grounded the same fact in `:parse` IL). A scan that treats it as
 *       string bytes flips its quote phase on the first nested string, which
 *       silently destroys every later binding. Modeling it moved holdout
 *       precision 96.75% → 99.85% and dev 93.06% → 98.50%.
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
 * Measured on the frozen split (`.scratch/explain-lab-partition.json`) against
 * the per-occurrence highlight streams for 7.23.2 AND 7.24rc2, byte-identical
 * across the two versions: **holdout 99.97% precision on decided (6151/6153),
 * 4.23% abstention; dev 99.73% (8708/8732), 6.40%.**
 *
 * The scan is a single left-to-right pass with an explicit delimiter stack (no
 * recursion, Q17 posture) and never throws; structural surprises land in
 * `notes` with the same vocabulary the segmenter uses. Scope creation is capped
 * at `MAX_SCOPE_DEPTH` so pathological nesting cannot make lookup unbounded.
 */

import { analyzeCoordinates } from "./coordinates.ts";

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
}

interface Binding {
	cls: SymbolClass;
	/** analyzed-byte offset from which the binding is visible. */
	from: number;
}

interface Scope {
	/** true for a named-function body: a closure boundary (F2). */
	closure: boolean;
	bindings: Map<string, Binding[]>;
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

	const occurrences: SymbolOccurrence[] = [];
	const notes: string[] = [];
	const root: Scope = { closure: false, bindings: new Map() };
	const scopes: Scope[] = [root];
	/** open delimiters, innermost last; `"` is a string frame. */
	const frames: ("{" | "[" | "(" | '"')[] = [];
	/** bracket/brace nesting, strings excluded (the S8 filter region uses it). */
	let depth = 0;
	/** `{` opens past the cap that pushed no scope; their `}` must not pop one. */
	let suppressedScopes = 0;
	let overDepth = false;

	/** lowercased leading word of the current statement. */
	let head: string | null = null;
	/** depth at which a filter word opened its region, or null. */
	let filterDepth: number | null = null;
	let pendingDecl: SymbolClass | null = null;
	let pendingLoopVars = false;
	/** inside a space-separated menu path run, where bare words are `dir` (S16). */
	let inMenuPath = false;
	let pendingSetTarget = false;
	let pendingErrVar = false;
	/** this statement declared a name, so a `do={` it opens is a closure (F2). */
	let declaredHere = false;
	/** H4 — still before the first real token of the current statement? */
	let atLead = true;

	const resetStatement = (): void => {
		head = null;
		filterDepth = null;
		inMenuPath = false;
		pendingSetTarget = false;
		pendingErrVar = false;
		pendingDecl = null;
		pendingLoopVars = false;
		declaredHere = false;
	};

	/**
	 * Nearest visible binding for `name` at `at`, innermost scope first. The
	 * search STOPS at a closure boundary (F2): a named-function body cannot see
	 * the names around it.
	 */
	const lookup = (name: string, at: number): Binding | null => {
		for (let s = scopes.length - 1; s >= 0; s--) {
			const scope = scopes[s] as Scope;
			const list = scope.bindings.get(name);
			if (list !== undefined) {
				let best: Binding | null = null;
				for (const b of list)
					if (b.from <= at && (best === null || b.from > best.from)) best = b;
				if (best !== null) return best;
			}
			if (scope.closure) return null;
		}
		return null;
	};

	const bindIn = (
		scope: Scope,
		name: string,
		cls: SymbolClass,
		from: number,
	): void => {
		const list = scope.bindings.get(name);
		if (list === undefined) scope.bindings.set(name, [{ cls, from }]);
		else list.push({ cls, from });
	};

	// Case matters: RouterOS variable resolution is CASE-SENSITIVE (`:local
	// UserName` then `$username` reads `parameter` on the device, not local), so
	// binding keys are never folded.
	const bind = (name: string, cls: SymbolClass, from: number): void => {
		const inner = scopes[scopes.length - 1] as Scope;
		if (cls !== "global") {
			bindIn(inner, name, cls, from);
			return;
		}
		// S2 — a global is visible for the rest of the document, so it is recorded
		// at the document scope no matter where it was written. It is ALSO
		// recorded in the current scope, which is how an in-body `:global NAME`
		// re-import stays visible inside a closure that hides the outer one (F2).
		bindIn(root, name, cls, from);
		if (inner !== root) bindIn(inner, name, cls, from);
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
		if (frames[frames.length - 1] === '"') {
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
					frames.push(next);
					depth++;
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

		// --- comments: `#` in statement-leading position (Q1 rule H4) ------------
		//
		// Done inline rather than through `segment.ts`'s shared `maskComments`,
		// which is blind to F1: a `$[…]` carrying a nested string flips its quote
		// phase, and every later `#` line then reads as string content (the device
		// says `comment`). Pre-masking measured 98.50% dev where this reads 99.59%.
		if (c === "#" && atLead) {
			while (i < text.length && text[i] !== "\n") i++;
			atLead = true;
			resetStatement();
			continue;
		}
		if (c === ";" || c === "\n" || c === "{") atLead = true;
		else if (c !== " " && c !== "\t" && c !== "\r") atLead = false;

		if (c === '"') {
			// S11 — a QUOTED declaration name. `:global "set-dns" do={…}` declares
			// `set-dns`, and the console carries the class across the quotes, so the
			// span includes them. Without this the string is skipped and the next
			// bare word (`do`) is declared instead.
			if (pendingDecl !== null || pendingLoopVars) {
				const close = text.indexOf('"', i + 1);
				if (close > i) {
					const name = text.slice(i + 1, close);
					const cls = pendingDecl ?? "auto";
					bind(name, cls, i + 1);
					// The span includes the quotes; the NAME does not.
					record(i, close + 1, name, cls, true);
					pendingDecl = null;
					declaredHere = true;
					i = close;
					continue;
				}
			}
			frames.push('"');
			continue;
		}

		if (c === "{" || c === "[" || c === "(") {
			frames.push(c);
			depth++;
			if (c === "{") {
				if (scopes.length >= MAX_SCOPE_DEPTH) {
					suppressedScopes++;
					if (!overDepth) {
						overDepth = true;
						notes.push(`over-depth:${i}`);
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
			if (frames[frames.length - 1] !== want) {
				// A mismatched close is not a close: popping it would unwind a real
				// enclosing scope and drop its bindings early. `segment.ts` takes the
				// same line — report it and treat the character as content.
				notes.push(`unbalanced-close:${c}`);
				continue;
			}
			frames.pop();
			if (filterDepth !== null && depth <= filterDepth) filterDepth = null;
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
			i = j - 1;
			if (word === "") continue;

			if (head === null) {
				head = lower;
				if (DECL[lower] !== undefined && text[start] === ":")
					pendingDecl = DECL[lower] as SymbolClass;
				else if (LOOP_HEADS.has(lower) && text[start] === ":")
					pendingLoopVars = true;
				else if (lower === "set" && text[start] === ":")
					pendingSetTarget = true;
				else if (ERRVAR_HEADS.has(lower)) pendingErrVar = true;
				continue;
			}

			// S10 — `:set NAME` is a REFERENCE carrying the class NAME was declared
			// as. On an undeclared name the device raises a hard error, which is not
			// a class at all, so abstain rather than invent one.
			if (head === "set" && pendingSetTarget) {
				pendingSetTarget = false;
				const binding = lookup(word, start);
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
				bind(word, "auto", wordStart);
				record(wordStart, j, word, "auto", true);
				continue;
			}

			if (FILTER_WORDS.has(lower)) {
				filterDepth = depth;
				continue;
			}

			const prevChar = prevNonSpace(text, start);
			const isValue = prevChar === "=" || prevChar === ",";
			const sigilled = wordStart > start;

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
					(!sigilled && !isLiteralWord(lower) && inParen(text, start))
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
				(filterDepth !== null || inParen(text, start))
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

	if (frames.length > 0) {
		const open = frames.join("");
		if (open.includes('"')) notes.push("unterminated-string");
		const brackets = open.replace(/"/g, "");
		if (brackets.length > 0) notes.push(`unclosed:${brackets}`);
	}

	return { occurrences, notes };
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
	while (i >= 0 && isSpace(text[i] as string)) i--;
	if (text[i] !== "=") return null;
	i--;
	const end = i + 1;
	while (i >= 0 && isIdent(text[i] as string)) i--;
	const name = text.slice(i + 1, end);
	return name === "" ? null : name.toLowerCase();
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

/** True when `at` sits inside a `(`…`)` expression on its own line region. */
function inParen(text: string, at: number): boolean {
	let d = 0;
	for (let i = at - 1; i >= 0; i--) {
		const c = text[i];
		if (c === "\n" && d === 0) return false;
		if (c === ")") d++;
		else if (c === "(") {
			if (d === 0) return true;
			d--;
		}
	}
	return false;
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
