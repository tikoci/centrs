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
 */

import { isScopeBrace, scopeBodies } from "./blocks.ts";
import { segmentStatements } from "./segment.ts";

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
}

/** Statement texts of `text`, via the Q1 segmenter. */
function statementTexts(text: string): string[] {
	return segmentStatements(text).segments.map((s) => s.text);
}

/** Q3 — resolve every `[…]` command substitution in `text`. */
export function resolveDocument(text: string): Resolution[] {
	const out: Resolution[] = [];
	walk(statementTexts(text), "/", out);
	return out;
}

function walk(segments: string[], context: string, out: Resolution[]): void {
	let ctx = context;
	for (const text of segments) {
		// R4 — a menu-navigation statement moves the document context.
		const nav = menuNavPath(text, ctx);
		if (nav !== null) {
			ctx = nav;
			continue;
		}
		// R3 — the statement's own path is the context its brackets see.
		const stmtCtx = statementPath(text, ctx);
		collectBrackets(text, stmtCtx, 0, out);
		// R5 — block bodies inherit the context in force here.
		for (const body of scopeBodies(text))
			walk(statementTexts(body), stmtCtx, out);
	}
}

/** Q4 — canonical path of every statement in source order. */
export function resolveStatements(text: string): StatementResolution[] {
	const out: StatementResolution[] = [];
	walkStatements(statementTexts(text), "/", out);
	return out;
}

function walkStatements(
	segments: string[],
	context: string,
	out: StatementResolution[],
): void {
	let ctx = context;
	for (const text of segments) {
		const nav = menuNavPath(text, ctx);
		if (nav !== null) {
			out.push({ text, isNav: true, context: ctx, path: nav });
			ctx = nav;
			continue;
		}
		out.push({ text, isNav: false, context: ctx, ...canonicalPath(text, ctx) });
		// A block body's statements are the parent's siblings after flattening,
		// and R5 gives them the context in force here.
		const stmtCtx = statementPath(text, ctx);
		for (const body of scopeBodies(text))
			walkStatements(statementTexts(body), stmtCtx, out);
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
	if (!text.startsWith("/")) return null;
	if (/[=[({"$]/.test(text)) return null;
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
	const bareDirective =
		!t.startsWith(":") && !t.startsWith("/") && scopeBodies(t).length > 0;
	const base =
		t.startsWith(":") || t.startsWith("/") || bareDirective ? "/" : ctx;
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
	if (!t.startsWith(":") && !t.startsWith("/") && scopeBodies(t).length > 0)
		return "/";
	const lead = leadingRun(text);
	if (lead.length === 0) return ctx;
	const base = t.startsWith("/") ? "/" : ctx;
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
): void {
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			// A string is opaque EXCEPT for `$[ … ]` interpolation, a real command
			// substitution: `:put "$[:pick $ip 0 $n]"` lowers with `/pick` inside
			// (topic-…/post-0003-snippet-01 @ 7.22.1).
			const strEnd = stringEnd(text, i);
			scanInterpolations(text.slice(i + 1, strEnd), ctx, depth, out);
			i = strEnd;
			continue;
		}
		if (c === "{") {
			// A literal body is a value (Q2), but can still contain command
			// substitutions: `{[/terminal/inkey]}` lowers the bracket. Descend for
			// brackets only; scope bodies are walked by walk().
			const end = matchDelim(text, i, "{", "}");
			if (!isScopeBrace(text, i))
				collectBrackets(text.slice(i + 1, end), ctx, depth, out);
			i = end;
			continue;
		}
		if (c !== "[") continue;
		const end = matchDelim(text, i, "[", "]");
		const inner = trimAscii(text.slice(i + 1, end));
		out.push(resolveInner(inner, ctx, depth));
		// R6 — nested brackets inherit from this one's resolution.
		const nestedCtx = out[out.length - 1]?.path ?? ctx;
		collectBrackets(inner, nestedCtx, depth + 1, out);
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
): void {
	for (let i = 0; i < body.length - 1; i++) {
		if (body[i] !== "$" || body[i + 1] !== "[") continue;
		const end = matchDelim(body, i + 1, "[", "]");
		const inner = trimAscii(body.slice(i + 2, end));
		out.push(resolveInner(inner, ctx, depth));
		collectBrackets(inner, out[out.length - 1]?.path ?? ctx, depth + 1, out);
		i = end;
	}
}

function resolveInner(inner: string, ctx: string, depth: number): Resolution {
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
