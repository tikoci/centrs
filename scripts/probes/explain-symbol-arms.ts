// cspell:ignore premask scanfix
// Q13 promotion — the candidate resolver arms that selected the shipped rule.
//
// Method copied from the Q16 nav-arm re-score (#195): before shipping a
// promotion that differs from the throwaway lab SUT, price every arm against the
// frozen corpus oracle instead of arguing about it. The per-occurrence highlight
// streams (`.scratch/explain-lab-q13-streams.v*.json`) make that measurable
// offline, so the only honest reason to ship an arm is a number.
//
// Arms:
//   lab       — the lab SUT's scanner semantics, re-expressed on this structure
//               (ad-hoc `#` handling, string scan blind to `$[…]` substitution,
//               document-scoped bindings). Must reproduce 96.75% holdout.
//   scanfix   — H4 comments via the ratified `maskComments`, and a string scan
//               that treats `$[…]`/`$(…)` as CODE (Q3: a `$[…]` inside a
//               double-quoted string lowers in IL).
//   closure   — scanfix + corpus-scale finding 2: a NAMED-FUNCTION body
//               (`:local/:global F do={…}`) is a closure; outer bindings are not
//               visible inside it (they read `parameter`), and a global needs an
//               in-body `:global X` re-import.
//   abstain   — scanfix + finding 2's other permitted answer: abstain (cls null)
//               on any reference inside a named-function body that resolves only
//               through the closure boundary.
//
// This is measurement code, not the product resolver. The shipped winner lives
// in `src/explain/symbols.ts`; keeping the arms here lets us score the choice
// against a later RouterOS highlight capture instead of preserving only prose.
import { analyzeCoordinates } from "../../src/explain/coordinates.ts";
import { maskComments } from "../../src/explain/segment.ts";

export type Arm = "lab" | "premask" | "scanfix" | "closure" | "abstain";

export type SymbolClass =
	| "local"
	| "global"
	| "auto"
	| "parameter"
	| "undefined";

export const HIGHLIGHT_CLASS: Record<SymbolClass, string> = {
	local: "variable-local",
	global: "variable-global",
	auto: "variable-auto",
	parameter: "variable-parameter",
	undefined: "variable-undefined",
};

export interface SymbolOccurrence {
	start: number;
	end: number;
	name: string;
	sigil: boolean;
	declaration: boolean;
	cls: SymbolClass | null;
	note?: string;
}

export interface SymbolAnalysis {
	occurrences: SymbolOccurrence[];
	notes: string[];
}

interface Binding {
	cls: SymbolClass;
	from: number;
}

interface Scope {
	closure: boolean;
	bindings: Map<string, Binding[]>;
}

const DECL: Record<string, SymbolClass> = { local: "local", global: "global" };
const LOOP_HEADS = new Set(["foreach", "for"]);
const ERRVAR_HEADS = new Set(["onerror"]);
const FILTER_WORDS = new Set(["where", "find"]);
const OPERATOR_WORDS = new Set(["or", "and", "not", "in"]);
const MAX_SCOPE_DEPTH = 256;

const isIdent = (c: string): boolean => /[A-Za-z0-9_.-]/.test(c);
const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);

export function resolveSymbols(original: string, arm: Arm): SymbolAnalysis {
	const analysis = analyzeCoordinates(original);
	const ascii = new TextDecoder().decode(analysis.analyzed);
	// The shared `maskComments` has the SAME blind spot as the lab string scan:
	// a `$[…]` substitution carrying a nested string flips its quote phase, so a
	// later `#` line is read as string content (device: `comment`). This walker
	// models substitutions, so it does H4 inline instead. `maskComments` is kept
	// imported for the `premask` arm, which prices doing it the shared way.
	const text = arm === "premask" ? maskComments(ascii) : ascii;
	const inlineComments = arm !== "lab" && arm !== "premask";
	const substitutionsAreCode = arm !== "lab";
	let atLead = true;
	const closureScopes = arm === "closure" || arm === "abstain";
	const abstainAcrossClosure = arm === "abstain";

	const occurrences: SymbolOccurrence[] = [];
	const notes: string[] = [];
	const root: Scope = { closure: false, bindings: new Map() };
	const scopes: Scope[] = [root];
	/** open delimiters, innermost last; `"` is a string frame. */
	const frames: ("{" | "[" | "(" | '"')[] = [];
	let depth = 0; // bracket/brace depth, strings excluded
	let overDepth = false;
	/** Braces past the cap pushed no scope, so their closes must pop no scope. */
	let suppressedScopes = 0;

	let head: string | null = null;
	let filterDepth: number | null = null;
	let pendingDecl: SymbolClass | null = null;
	let pendingLoopVars = false;
	let inMenuPath = false;
	let pendingSetTarget = false;
	let pendingErrVar = false;
	/** this statement has declared a name — so a `do={` it opens is a closure. */
	let declaredHere = false;

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

	/** Nearest visible binding, stopping at a closure boundary. */
	const lookup = (
		name: string,
		at: number,
	): { binding: Binding | null; crossedClosure: boolean } => {
		let crossed = false;
		for (let s = scopes.length - 1; s >= 0; s--) {
			const scope = scopes[s] as Scope;
			const list = scope.bindings.get(name);
			if (list !== undefined) {
				let best: Binding | null = null;
				for (const b of list)
					if (b.from <= at && (best === null || b.from > best.from)) best = b;
				if (best !== null) return { binding: best, crossedClosure: crossed };
			}
			if (closureScopes && scope.closure)
				return { binding: null, crossedClosure: true };
			if (scope.closure) crossed = true;
		}
		return { binding: null, crossedClosure: crossed };
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

	const bind = (name: string, cls: SymbolClass, from: number): void => {
		if (cls === "global") {
			bindIn(root, name, cls, from);
			// An in-body `:global X` re-import must be visible inside the body it
			// was written in, which the root binding alone cannot express once a
			// closure boundary hides the outer scope.
			const inner = scopes[scopes.length - 1] as Scope;
			if (inner !== root) bindIn(inner, name, cls, from);
			return;
		}
		bindIn(scopes[scopes.length - 1] as Scope, name, cls, from);
	};

	const pushRef = (
		r: { start: number; end: number; name: string },
		note?: string,
	): void => {
		if (/^\d+$/.test(r.name)) {
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
		let { name, end } = r;
		let hit = lookup(name, r.start);
		if (hit.binding === null && name.includes("-")) {
			for (
				let cut = name.lastIndexOf("-");
				cut > 0;
				cut = name.lastIndexOf("-", cut - 1)
			) {
				const prefix = name.slice(0, cut);
				const attempt = lookup(prefix, r.start);
				if (attempt.binding !== null) {
					hit = attempt;
					name = prefix;
					end = r.start + prefix.length;
					break;
				}
			}
		}
		const abstain =
			abstainAcrossClosure && hit.binding === null && hit.crossedClosure;
		occurrences.push({
			start: r.start,
			end,
			name,
			sigil: true,
			declaration: false,
			cls: abstain
				? null
				: hit.binding === null
					? "parameter"
					: hit.binding.cls,
			note: abstain
				? "closure boundary: outer binding not visible offline"
				: note,
		});
	};

	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		const top = frames[frames.length - 1];

		// --- inside a double-quoted string --------------------------------------
		if (top === '"') {
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
				if (substitutionsAreCode && (next === "[" || next === "(")) {
					// `$[…]` / `$(…)` is CODE inside the string (Q3). The lab arm
					// treats it as ordinary string bytes, which loses synchronization in the
					// scan on any nested quote.
					frames.push(next);
					depth++;
					i++;
					continue;
				}
				const r = readRef(text, i, true);
				if (r !== null) {
					pushRef(r, "in-string");
					i = r.next - 1;
				}
			}
			continue;
		}

		// --- comments -----------------------------------------------------------
		if (
			c === "#" &&
			(inlineComments ? atLead : arm === "lab" && head === null)
		) {
			while (i < text.length && text[i] !== "\n") i++;
			atLead = true;
			resetStatement();
			continue;
		}
		if (c === ";" || c === "\n" || c === "{") atLead = true;
		else if (c !== " " && c !== "\t" && c !== "\r") atLead = false;

		if (c === '"') {
			// S11 — a QUOTED declaration name carries its class across the quotes.
			if (pendingDecl !== null || pendingLoopVars) {
				const close = text.indexOf('"', i + 1);
				if (close > i) {
					const name = text.slice(i + 1, close);
					const cls = pendingDecl ?? "auto";
					bind(name, cls, i + 1);
					occurrences.push({
						start: i,
						end: close + 1,
						name,
						sigil: false,
						declaration: true,
						cls,
					});
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
			if (frames.length > 0) frames.pop();
			if (filterDepth !== null && depth <= filterDepth) filterDepth = null;
			if (c === "}") {
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

		if (c === "$") {
			const r = readRef(text, i, false);
			if (r !== null) {
				pushRef(r);
				i = r.next - 1;
			}
			continue;
		}

		if (isIdentStart(c) || c === ":" || c === "/") {
			const start = i;
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

			if (head === "set" && pendingSetTarget) {
				pendingSetTarget = false;
				const hit = lookup(word, start);
				occurrences.push({
					start: wordStart,
					end: j,
					name: word,
					sigil: false,
					declaration: false,
					cls: hit.binding === null ? null : hit.binding.cls,
					note:
						hit.binding === null ? "S10 :set on an undeclared name" : undefined,
				});
				continue;
			}

			if (pendingErrVar) {
				pendingErrVar = false;
				bind(word, "local", wordStart);
				occurrences.push({
					start: wordStart,
					end: j,
					name: word,
					sigil: false,
					declaration: true,
					cls: "local",
				});
				continue;
			}

			if (pendingDecl !== null) {
				bind(word, pendingDecl, wordStart);
				occurrences.push({
					start: wordStart,
					end: j,
					name: word,
					sigil: false,
					declaration: true,
					cls: pendingDecl,
				});
				pendingDecl = null;
				declaredHere = true;
				continue;
			}

			if (pendingLoopVars) {
				if (lower === "in" || lower === "from") {
					pendingLoopVars = false;
					continue;
				}
				bind(word, "auto", wordStart);
				occurrences.push({
					start: wordStart,
					end: j,
					name: word,
					sigil: false,
					declaration: true,
					cls: "auto",
				});
				continue;
			}

			if (FILTER_WORDS.has(lower)) {
				filterDepth = depth;
				continue;
			}

			const prevChar = prevNonSpace(text, start);
			const isValuePos = prevChar === "=" || prevChar === ",";
			const sigilled = wordStart > start;
			if (
				filterDepth !== null &&
				!isValuePos &&
				!sigilled &&
				!isLiteralWord(lower) &&
				!OPERATOR_WORDS.has(lower)
			) {
				occurrences.push({
					start: wordStart,
					end: j,
					name: word,
					sigil: false,
					declaration: false,
					cls: null,
					note: "S8 filter-field: schema-dependent",
				});
				continue;
			}

			const next = nextNonSpace(text, j);
			if (next === "=") {
				if (
					filterDepth !== null ||
					(!sigilled && !isLiteralWord(lower) && inParen(text, start))
				)
					occurrences.push({
						start: wordStart,
						end: j,
						name: word,
						sigil: false,
						declaration: false,
						cls: null,
						note: "S8 filter-field: schema-dependent",
					});
				continue;
			}

			if (sigilled && text[start] === "/") inMenuPath = true;
			else if (
				isValuePos ||
				prevChar === "[" ||
				prevChar === "(" ||
				prevChar === null
			)
				inMenuPath = false;
			if (inMenuPath) continue;
			if (OPERATOR_WORDS.has(lower)) continue;
			if (
				!sigilled &&
				!isValuePos &&
				!isLiteralWord(lower) &&
				depth > 0 &&
				(filterDepth !== null || inParen(text, start))
			) {
				const hit = lookup(word, start);
				occurrences.push({
					start: wordStart,
					end: j,
					name: word,
					sigil: false,
					declaration: false,
					cls: hit.binding === null ? null : hit.binding.cls,
					note:
						hit.binding === null
							? "S7 bare word in expression position"
							: undefined,
				});
			}
		}
	}

	return { occurrences, notes };
}

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
		return {
			start: i,
			end: close + 1,
			name: text.slice(i + 1, close),
			next: close + 1,
		};
	}
	if (text[i] === "[" || text[i] === "(") return null;
	const start = i;
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
	while (
		i >= 0 &&
		(text[i] === " " ||
			text[i] === "\t" ||
			text[i] === "\r" ||
			text[i] === "\n")
	)
		i--;
	if (text[i] !== "=") return null;
	i--;
	const end = i + 1;
	while (i >= 0 && isIdent(text[i] as string)) i--;
	const name = text.slice(i + 1, end);
	return name === "" ? null : name.toLowerCase();
}

function prevNonSpace(text: string, from: number): string | null {
	for (let i = from - 1; i >= 0; i--) {
		const c = text[i] as string;
		if (c === " " || c === "\t") continue;
		if (c === "\n") return null;
		return c;
	}
	return null;
}

function nextNonSpace(text: string, from: number): string | null {
	for (let i = from; i < text.length; i++) {
		const c = text[i] as string;
		if (c !== " " && c !== "\t") return c;
	}
	return null;
}

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
