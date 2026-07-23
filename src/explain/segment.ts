/**
 * Statement segmenter for `explain` (centrs canonicalizer).
 *
 * Ratified by the phase-0 lab, question Q1 (#185) and promoted from the
 * throwaway probe `.scratch/explain-lab-segmenter.ts`. This is the first walker
 * stage: a schema-free, device-free splitter of multi-statement RouterOS input
 * into top-level statements, matching `(evl …)` sibling adjacency in `:parse`
 * IL. It never throws; structural surprises are reported in `notes`.
 *
 * Segmentation runs on the byte-count-preserving `analyzed` surface from
 * `./coordinates.ts`, so a segment's `start`/`end` are **analyzed-byte offsets**
 * (half-open, aligned with the coordinate contract and device highlight spans),
 * while `text` is the **original** human-readable statement, recovered through
 * the coordinate mapping. Because non-ASCII bytes are `SUB` in `analyzed` and
 * `SUB` is none of the RouterOS delimiters, prose or names cannot corrupt the
 * delimiter stack.
 *
 * The boundary rules (grounded from the documented scripting semantics before
 * any scoring, so the disagreement bins meant something):
 *   H1  Statements separate on `;` and newline, at nesting depth 0 only.
 *   H2  Depth counts `{}`, `[]`, `()` uniformly; a newline inside any of them
 *       continues the statement.
 *   H3  `"` opens a string; `\` escapes the next char inside it; a string
 *       suppresses every separator and depth character. RouterOS has no
 *       single-quote string form, so `'` is an ordinary character.
 *   H4  `#` starts a comment ONLY in statement-leading position (start of
 *       input, or the first non-space after `;`, a newline, or an opening `{`),
 *       runs to end of line, and produces no statement. Recognized at every
 *       nesting depth, so a `#` line inside a `do={…}` body cannot leak an
 *       apostrophe or stray brace into the delimiter stack.
 *   H5  A backslash at end of line is a continuation: it does not separate.
 *   H6  Empty statements (`;;`, blank lines) produce nothing.
 *   H7  A statement that is only a `{…}` group (optionally behind a bare menu
 *       path) is a CONTAINER: IL flattens its children into siblings, so its
 *       children are segmented in its place.
 */

import {
	analyzeCoordinates,
	type CoordinateAnalysis,
	runAtByte,
} from "./coordinates.ts";

/** One top-level statement located in analyzed-byte space. */
export interface Segment {
	/** analyzed-byte offset, inclusive. */
	start: number;
	/** analyzed-byte offset, exclusive. */
	end: number;
	/** the original (human-readable) statement text, trimmed. */
	text: string;
	/** the separator that ENDED this statement, for the boundary taxonomy. */
	terminator: ";" | "newline" | "eof";
	/**
	 * true when the statement *looks* like pure menu navigation: a `/`-rooted
	 * path of path-shaped tokens with no `=`, quotes, brackets, or `$`. This is
	 * a SHAPE hint, not a verb claim — offline (schema-free) cannot tell a
	 * trailing verb (`/ip address print`) from a deeper menu (`/ip address`), so
	 * both are `menuOnly: true`. Q4/Q6 decide what it means. See `isMenuOnly`.
	 */
	menuOnly: boolean;
}

/** The full segmentation of one input string. */
export interface SegmentResult {
	segments: Segment[];
	/** comment spans (analyzed-byte offsets), dropped from the statement stream. */
	comments: { start: number; end: number }[];
	/** unbalanced-delimiter and other structural notes; never a throw. */
	notes: string[];
}

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\r";

/**
 * Segment `original` into top-level statements. Spans are analyzed-byte offsets
 * (see module header); `text` is the original substring for each span.
 */
export function segmentStatements(original: string): SegmentResult {
	const analysis = analyzeCoordinates(original);
	// `analyzed` is pure ASCII, so a string built from it has index === byte.
	const ascii = new TextDecoder().decode(analysis.analyzed);
	const raw = segmentAscii(ascii);
	// Recover the human-readable `text` for each segment from the original.
	const segments = raw.segments.map((s) => ({
		...s,
		text: originalSlice(analysis, s.start, s.end),
	}));
	return { segments, comments: raw.comments, notes: raw.notes };
}

/** Original substring for an analyzed-byte span (boundaries are char-aligned). */
function originalSlice(
	a: CoordinateAnalysis,
	start: number,
	end: number,
): string {
	return a.original.slice(utf16At(a, start), utf16At(a, end));
}

/** UTF-16 offset in the original for an analyzed-byte boundary. */
function utf16At(a: CoordinateAnalysis, byte: number): number {
	if (byte >= a.analyzed.length) return a.original.length;
	return runAtByte(a, byte).utf16Start;
}

/** Segment a pure-ASCII string; offsets are byte === string indices. */
function segmentAscii(text: string): SegmentResult {
	const raw = segmentRaw(text);
	// H7 — expand bare `{…}` container statements in place.
	const segments: Segment[] = [];
	for (const s of raw.segments) {
		const open = containerOpen(s.text);
		if (open >= 0) {
			const prefix = s.text.slice(0, open).trim();
			const body = s.text.slice(open + 1, -1);
			// Only `inner.segments` is new: the outer `segmentRaw` pass already
			// records comments (H4, every depth) and notes at every depth, so
			// re-merging `inner.comments`/`inner.notes` would double-count them.
			const inner = segmentAscii(body);
			const base = s.start + open + 1;
			if (inner.segments.length > 0) {
				if (prefix.length > 0)
					segments.push({
						start: s.start,
						end: s.start + prefix.length,
						text: prefix,
						terminator: "newline",
						menuOnly: isMenuOnly(prefix),
					});
				for (const c of inner.segments)
					segments.push({ ...c, start: c.start + base, end: c.end + base });
				continue;
			}
		}
		segments.push(s);
	}
	return { ...raw, segments };
}

/**
 * Index of the `{` opening a CONTAINER group, or -1. A container is a trailing
 * `{…}` that closes at the very end of the statement, preceded by nothing or by
 * a bare menu path. The `/`-prefix requirement keeps `:local arr {1;2}` out (an
 * array literal is a VALUE, not a scope); `do={…}`/`in=[…]` are excluded by the
 * same test — their prefix carries an `=`.
 */
function containerOpen(text: string): number {
	if (!text.endsWith("}")) return -1;
	const last = text.length - 1;
	let depth = 0;
	let groupOpen = -1; // start of the current depth-0 group
	// Single left-to-right pass (O(n)): the trailing group is the one whose
	// close is the final char; record where each depth-0 group opened and check
	// only that group when depth returns to 0 at the end.
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			i++;
			while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
			continue;
		}
		if (c === "{" || c === "[" || c === "(") {
			if (depth === 0) groupOpen = i;
			depth++;
			continue;
		}
		if (c === "}" || c === "]" || c === ")") {
			depth--;
			if (depth === 0 && i === last && text[groupOpen] === "{") {
				const prefix = text.slice(0, groupOpen).trim();
				if (prefix.length === 0) return groupOpen;
				if (!prefix.startsWith("/")) return -1;
				if (/[=[($"]/.test(prefix)) return -1;
				return groupOpen;
			}
		}
	}
	return -1;
}

function segmentRaw(text: string): SegmentResult {
	const segments: Segment[] = [];
	const comments: { start: number; end: number }[] = [];
	const notes: string[] = [];

	let i = 0;
	let stmtStart = -1;
	let atStatementLead = true; // H4: still before the first real token?
	const stack: string[] = []; // H2

	const flush = (end: number, terminator: Segment["terminator"]): void => {
		if (stmtStart < 0) return;
		const raw = text.slice(stmtStart, end);
		const lead = raw.length - raw.trimStart().length;
		const trimmed = raw.trim();
		stmtStart = -1;
		if (trimmed.length === 0) return; // H6
		segments.push({
			start: end - raw.length + lead,
			end: end - (raw.length - lead - trimmed.length),
			text: trimmed,
			terminator,
			menuOnly: isMenuOnly(trimmed),
		});
	};

	while (i < text.length) {
		const c = text[i] as string;

		// H4 — comment, only in statement-leading position.
		if (c === "#" && atStatementLead) {
			const nl = text.indexOf("\n", i);
			const end = nl === -1 ? text.length : nl;
			comments.push({ start: i, end });
			i = end;
			continue;
		}

		// H3 — string.
		if (c === '"') {
			if (stmtStart < 0) stmtStart = i;
			atStatementLead = false;
			i++;
			let closed = false;
			while (i < text.length) {
				if (text[i] === "\\") {
					i += 2;
					continue;
				}
				if (text[i] === '"') {
					i++;
					closed = true;
					break;
				}
				i++;
			}
			if (!closed) notes.push("unterminated-string");
			continue;
		}

		// H5 — line continuation.
		if (
			c === "\\" &&
			(text[i + 1] === "\n" || (text[i + 1] === "\r" && text[i + 2] === "\n"))
		) {
			if (stmtStart < 0) stmtStart = i;
			i += text[i + 1] === "\r" ? 3 : 2;
			continue;
		}

		// H2 — nesting.
		if (c === "{" || c === "[" || c === "(") {
			if (stmtStart < 0) stmtStart = i;
			atStatementLead = c === "{";
			stack.push(c);
			i++;
			continue;
		}
		if (c === "}" || c === "]" || c === ")") {
			const want = c === "}" ? "{" : c === "]" ? "[" : "(";
			if (stack.at(-1) === want) stack.pop();
			else notes.push(`unbalanced-close:${c}`);
			if (stmtStart < 0) stmtStart = i;
			atStatementLead = false;
			i++;
			continue;
		}

		// H1 — separators. They only END a statement at depth 0, but restore
		// statement-leading position at every depth so H4 can see a comment
		// inside a block body.
		if (c === ";" || c === "\n") {
			if (stack.length === 0) flush(i, c === ";" ? ";" : "newline");
			atStatementLead = true;
			i++;
			continue;
		}

		if (isSpace(c)) {
			i++;
			continue;
		}

		if (stmtStart < 0) stmtStart = i;
		atStatementLead = false;
		i++;
	}
	flush(text.length, "eof");
	if (stack.length > 0) notes.push(`unclosed:${stack.join("")}`);
	return { segments, comments, notes };
}

/**
 * A menu-navigation SHAPE: a `/`-rooted path of path-shaped tokens (letters,
 * digits, space, and `/_.-`) with no `=`, quotes, brackets, or `$` — e.g.
 * `/ip address`, `/interface`, `/`. It is deliberately shape-only: offline
 * cannot tell a trailing verb (`/ip address print`) from a deeper menu without
 * a schema, so `print` still reads as menu-shaped here. A HINT for Q4/Q6, not a
 * claim that no verb is present.
 */
function isMenuOnly(trimmed: string): boolean {
	if (!trimmed.startsWith("/")) return false;
	return /^\/[A-Za-z0-9 /_.-]*$/.test(trimmed);
}
