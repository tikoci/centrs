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
 *   R8 `..` ascends and a bare `/` resets; a bare word alone is NOT treated as
 *      navigation (offline cannot tell a submenu from a no-argument command
 *      without a schema — the known limit, reported not guessed).
 *   R10 A `:` scripting directive takes its operand POSITIONALLY (`:global x`
 *      is `/global`, not `/global/x`); a menu command spells its menu out.
 *   R11 A bare directive (`while (…) do={…}`) is at the root, and hands its
 *      body the root context too. The schema-free tell is the scope block: no
 *      menu command takes `do=`.
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
 * Only two things make the context unknown, and both are cases where the
 * statement MIGHT have been navigation and offline cannot read where to:
 *   - a structural defect (the text is unreadable, so it may have been a nav),
 *   - a `/`-led statement whose leading run is unreadable (`/ip/$menu`), which
 *     is a navigation to a computed menu as easily as it is a command.
 * A dynamic-headed statement (`$x`, `[…]`, `(…)`) is context-NEUTRAL — it
 * evaluates a value and does not navigate — so it must NOT poison; that
 * distinction is the whole reason this lives here rather than in a caller,
 * which sees only flattened statements. An ABSOLUTE navigation re-establishes
 * certainty, because R4 has it REPLACE the context rather than extend it.
 *
 * DECLARED LIMIT: a relative statement whose run is unreadable does not poison.
 * A bare word is already not navigation offline (R8) — the CHR-confirmed known
 * limit that the device descends a submenu where offline reads a command — so
 * poisoning here would re-price that limit rather than close the cascade.
 */

import { isScopeBrace, scopeBodies } from "./blocks.ts";
import { maskComments, segmentStatements } from "./segment.ts";

const BARE_WORD = /^[A-Za-z][A-Za-z0-9._-]*$/;
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
 * segmenter's document-level notes are surfaced separately on the envelope.
 */
function structuralDefect(text: string): boolean {
	// Mask comments so a `#`-comment `}`/`)` is not counted as a real delimiter.
	const masked = maskComments(text);
	const openOf: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
	const stack: string[] = [];
	for (let i = 0; i < masked.length; i++) {
		const c = masked[i];
		if (c === '"') {
			i++;
			let closed = false;
			while (i < masked.length) {
				if (masked[i] === "\\") {
					i += 2;
					continue;
				}
				if (masked[i] === '"') {
					closed = true;
					break;
				}
				i++;
			}
			if (!closed) return true;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") stack.push(c);
		else if (c === ")" || c === "]" || c === "}") {
			if (stack.pop() !== openOf[c]) return true;
		}
	}
	return stack.length > 0;
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
 * A `/`-led statement whose leading run offline cannot read — a variable
 * segment truncates it (`/ip/$menu`, `/interface/$type/print`). It is a
 * navigation to a computed menu exactly as plausibly as it is a command, so the
 * context after it is unknown. `menuNavPath` has already claimed every readable
 * absolute navigation before this is consulted.
 */
function isUnreadableAbsolute(text: string): boolean {
	const t = trimAscii(text);
	if (!t.startsWith("/")) return false;
	const tokens = statementRun(t);
	return tokens.length === 0 || tokens.some((x) => x.startsWith("$"));
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
}

/** Q3 result: bracket resolutions plus any structural / over-depth notes. */
export interface DocumentAnalysis {
	resolutions: Resolution[];
	/**
	 * Diagnostics surfaced from the segmenter (`unclosed:…`, `unbalanced-close:…`,
	 * `unterminated-string`) plus `over-depth` when a bounded traversal abstained.
	 * A caller must not treat resolutions as confident while notes are non-empty.
	 */
	notes: string[];
}

/** Q4 result: per-statement resolutions plus structural / over-depth notes. */
export interface StatementAnalysis {
	statements: StatementResolution[];
	notes: string[];
}

/** Statement texts of `text`, via the Q1 segmenter. */
function statementTexts(text: string): string[] {
	return segmentStatements(text).segments.map((s) => s.text);
}

/** Q3 — resolve every `[…]` command substitution in `text`. */
export function resolveDocument(text: string): DocumentAnalysis {
	const notes = new Set(segmentStatements(text).notes);
	const resolutions: Resolution[] = [];
	walk(statementTexts(text), "/", resolutions, 0, notes, true);
	return { resolutions, notes: [...notes] };
}

function walk(
	segments: string[],
	context: string,
	out: Resolution[],
	blockDepth: number,
	notes: Set<string>,
	contextCertain: boolean,
): void {
	let ctx = context;
	let certain = contextCertain;
	for (const text of segments) {
		// R4 — a menu-navigation statement moves the document context.
		const nav = menuNavPath(text, ctx);
		if (nav !== null) {
			const relative = trimAscii(text).startsWith("..");
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
		if (structuralDefect(text)) {
			certain = false;
			continue;
		}
		// R3 — the statement's own path is the context its brackets see.
		const stmtCtx = statementPath(text, ctx);
		if (isUnreadableAbsolute(text)) certain = false;
		// Derived AFTER the poison, exactly as `walkStatements` orders it, so the
		// two walks cannot drift. The value is the same either way — an unreadable
		// absolute is `/`-led, so `isBodyContextIndependent` is true regardless,
		// and the segmenter refuses to flatten a container whose menu prefix holds
		// a `$` at all — but the contract's rule is that these walks move in
		// lockstep, not that they happen to agree.
		const stmtCertain = certain || isBodyContextIndependent(text);
		collectBrackets(text, stmtCtx, 0, out, notes, stmtCertain);
		// R5 — block bodies inherit the context in force here.
		for (const body of scopeBodies(text)) {
			if (blockDepth >= MAX_DEPTH) {
				notes.add("over-depth");
				continue;
			}
			walk(
				statementTexts(body),
				stmtCtx,
				out,
				blockDepth + 1,
				notes,
				stmtCertain,
			);
		}
	}
}

/** Q4 — canonical path of every statement in source order. */
export function resolveStatements(text: string): StatementAnalysis {
	const notes = new Set(segmentStatements(text).notes);
	const statements: StatementResolution[] = [];
	walkStatements(statementTexts(text), "/", statements, 0, notes, true);
	return { statements, notes: [...notes] };
}

function walkStatements(
	segments: string[],
	context: string,
	out: StatementResolution[],
	blockDepth: number,
	notes: Set<string>,
	contextCertain: boolean,
): void {
	let ctx = context;
	let certain = contextCertain;
	for (const text of segments) {
		const nav = menuNavPath(text, ctx);
		if (nav !== null) {
			// `..` ascends FROM the context, so it cannot be read while the context
			// is unknown. A `/`-led navigation (and a bare `/`) REPLACES it (R4) and
			// therefore re-establishes certainty.
			const relative = trimAscii(text).startsWith("..");
			if (relative && !certain) {
				out.push({
					text,
					isNav: true,
					context: ctx,
					path: null,
					unresolved: CONTEXT_LOST,
					contextCertain: false,
				});
				continue;
			}
			out.push({
				text,
				isNav: true,
				context: ctx,
				path: nav,
				contextCertain: certain,
			});
			ctx = nav;
			if (!relative) certain = true;
			continue;
		}
		// Q14 fail-closed — a malformed statement degrades to unresolved and is
		// not descended; it does not move the context either. It may however have
		// BEEN a navigation, so what the context now is becomes unknown.
		if (structuralDefect(text)) {
			out.push({
				text,
				isNav: false,
				context: ctx,
				path: null,
				unresolved: "structural defect: unbalanced delimiter or string",
				contextCertain: certain,
			});
			certain = false;
			continue;
		}
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
		});
		if (isUnreadableAbsolute(text)) certain = false;
		// A block body's statements are the parent's siblings after flattening,
		// and R5 gives them the context in force here — which is the ROOT, hence
		// knowable, when the statement spells its path out or is a bare directive.
		const stmtCtx = statementPath(text, ctx);
		const bodyCertain = certain || isBodyContextIndependent(text);
		for (const body of scopeBodies(text)) {
			if (blockDepth >= MAX_DEPTH) {
				notes.add("over-depth");
				continue;
			}
			walkStatements(
				statementTexts(body),
				stmtCtx,
				out,
				blockDepth + 1,
				notes,
				bodyCertain,
			);
		}
	}
}

/**
 * `/ip address` alone on a statement → the new context. Otherwise null.
 *
 * R8 — `..` and a bare `/` are the only RELATIVE forms offline can recognize;
 * a bare word alone (`address`) is indistinguishable from a no-argument command
 * (`print`) without a schema, so it is NOT navigation. An absolute navigation
 * REPLACES the context rather than extending it.
 */
function menuNavPath(text: string, ctx: string): string | null {
	const trimmed = trimAscii(text);
	if (trimmed === "/") return "/";
	if (/^\.\.(?:[ \t\r\n]|$)/.test(trimmed)) {
		const tokens = asciiWords(trimmed);
		if (!tokens.every((token) => token === "..")) return null;
		return joinPath(ctx, tokens.join("/"));
	}
	if (!trimmed.startsWith("/")) return null;
	if (/[=[({"$]/.test(trimmed)) return null;
	const tokens = asciiWords(trimmed);
	if (
		!tokens.every((token, i) =>
			i === 0 ? isAbsolutePathToken(token) : BARE_WORD.test(token),
		)
	)
		return null;
	return joinPath("/", tokens.join("/"));
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
	notes: Set<string>,
	contextCertain: boolean,
): void {
	// Bound the recursion (bracket nesting AND literal-brace descent) so
	// untrusted deeply nested input abstains instead of overflowing the stack.
	if (depth >= MAX_DEPTH) {
		notes.add("over-depth");
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
				notes,
				contextCertain,
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
					notes,
					contextCertain,
				);
			i = end;
			continue;
		}
		if (c !== "[") continue;
		const end = matchDelim(masked, i, "[", "]");
		const inner = trimAscii(masked.slice(i + 1, end));
		out.push(resolveInner(inner, ctx, depth, contextCertain));
		// R6 — nested brackets inherit from this one's resolution.
		const nestedCtx = out[out.length - 1]?.path ?? ctx;
		collectBrackets(
			inner,
			nestedCtx,
			depth + 1,
			out,
			notes,
			nestedCertainty(out[out.length - 1], contextCertain),
		);
		i = end;
	}
}

/** Index of the closing quote of the string starting at `open`. */
function stringEnd(text: string, open: number): number {
	let i = open + 1;
	while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
	return Math.min(i, text.length);
}

/** `$[ … ]` command substitutions inside a string body. */
function scanInterpolations(
	body: string,
	ctx: string,
	depth: number,
	out: Resolution[],
	notes: Set<string>,
	contextCertain: boolean,
): void {
	for (let i = 0; i < body.length - 1; i++) {
		if (body[i] !== "$" || body[i + 1] !== "[") continue;
		const end = matchDelim(body, i + 1, "[", "]");
		const inner = trimAscii(body.slice(i + 2, end));
		out.push(resolveInner(inner, ctx, depth, contextCertain));
		collectBrackets(
			inner,
			out[out.length - 1]?.path ?? ctx,
			depth + 1,
			out,
			notes,
			nestedCertainty(out[out.length - 1], contextCertain),
		);
		i = end;
	}
}

/**
 * Certainty a NESTED bracket inherits (R6). An enclosing bracket that resolved
 * hands its own path down as a KNOWN base, even while the document context is
 * lost: an absolute inner path (`[/ip/route/get [find …] gateway]`) and a `:`
 * directive are context-independent, so the `[find …]` inside them is anchored
 * regardless of what the document context did. A non-null `path` is exactly
 * that condition — a relative inner command with a lost context resolves to
 * `null` — so nesting recovers certainty rather than propagating abstention
 * into brackets that are in fact anchored.
 */
function nestedCertainty(
	enclosing: Resolution | undefined,
	contextCertain: boolean,
): boolean {
	return contextCertain || (enclosing?.path ?? null) !== null;
}

function resolveInner(
	inner: string,
	ctx: string,
	depth: number,
	contextCertain: boolean,
): Resolution {
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
			i++;
			while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
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
