/**
 * Statement segmenter for `explain` (centrs canonicalizer).
 *
 * Ratified by the phase-0 lab, question Q1 (#185) and promoted from the
 * throwaway probe `.scratch/explain-lab-segmenter.ts`. This is the first walker
 * stage: a schema-free, device-free splitter of multi-statement RouterOS input
 * into top-level statements, matching `(evl …)` sibling adjacency in `:parse`
 * IL. It never throws; structural surprises are reported as located
 * {@link Defect}s.
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
 *       single-quote string form, so `'` is an ordinary character. A string is
 *       not opaque to the NEXT quote, though: a `$[…]`/`$(…)` substitution
 *       inside it is code that may carry strings of its own, so where a string
 *       ends is decided by the one shared `scanQuotedString` (#199).
 *   H4  `#` starts a comment in statement-leading position (start of input, or
 *       the first non-space after `;`, a newline, or an opening `{`) — and, per
 *       H5 below, at the immediate start of a line that a continuation carried
 *       into. It runs to end of line and produces no statement. Recognized at
 *       every nesting depth, so a `#` line inside a `do={…}` body cannot leak an
 *       apostrophe or stray brace into the delimiter stack.
 *   H5  A backslash at end of line is a continuation: it does not separate. Its
 *       reach is wider than one line, and was measured on CHR 7.23.3 (#215):
 *         - blank and whitespace-only lines right after the `\` are part of the
 *           continuation (the device classes the whole run `escaped`);
 *         - a `#` at the IMMEDIATE start of such a line is a comment, and the
 *           comment line does not end the pending statement — `:local \` +
 *           newline + `# c` + newline + `foo 1` still declares `foo`;
 *         - after a continuation COMMENT line the reach is spent: the next
 *           blank line ENDS the statement (where directly after the `\` it
 *           would not), while ordinary content simply continues it;
 *         - a continuation never moves statement-leading position. `do={\` +
 *           newline + `:local x 1` still reads `:local` as the head, and an
 *           indented `#` is a comment there (lead) but content mid-statement.
 *   H6  Empty statements (`;;`, blank lines) produce nothing.
 *   H7  A statement that is only a `{…}` group (optionally behind a bare menu
 *       path) is a CONTAINER: IL flattens its children into siblings, so its
 *       children are segmented in its place.
 *
 * The scan is a single left-to-right pass (Q17, #190): one index-based walker
 * with an explicit `frames` stack does H7 flattening inline — no per-container
 * recursion and no re-scan of container bodies. Each open container is a frame
 * whose inner statements accumulate in a buffer; on its closing `}` the frame
 * either COMMITS (its buffered statements, behind an optional menu-prefix
 * segment, replace the container) or is DISCARDED (an empty body, trailing
 * content after the `}`, or an unclosed brace — the parent statement absorbs the
 * whole `{…}` verbatim). This reproduces the recursive `containerOpen` +
 * body re-scan contract the earlier version pinned, at O(n) time / O(depth)
 * space with no stack-overflow surface.
 *
 * H7 stays depth-bounded even so. `explain` accepts untrusted editor/MCP input,
 * so `MAX_CONTAINER_DEPTH` container frames is a hard cap: a `{` that would open
 * a deeper container is treated as an opaque group instead, the innermost
 * remainder stays one segment, and an `over-depth` defect is raised at that
 * offset. With recursion gone the cap is now a resource guard (bounding the
 * `frames` array and abstention granularity), not the stack-safety boundary it
 * once was.
 */

import {
	analyzeCoordinates,
	type CoordinateAnalysis,
	coordinateDefects,
	runAtByte,
} from "./coordinates.ts";
import { type Defect, defectAt, mergeDefects } from "./defects.ts";

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
	/**
	 * Unbalanced delimiters and other structural surprises, each located; never
	 * a throw. Includes the two coordinate-pass classes (`bom`, `non-ascii`).
	 */
	defects: Defect[];
}

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\r";

/**
 * Frame-stack cap for `scanQuotedString` — the string-scan twin of
 * `MAX_CONTAINER_DEPTH`, and the same kind of guard: a resource bound on
 * untrusted input, not a RouterOS grammar limit. Without it a crafted string of
 * unclosed substitutions (`"$[$[$[…`) grows one frame per two bytes; measured on
 * a 1 MB input that is ~19 MB of array churn, against ~9 MB for the
 * `original.split("")` `maskComments` already allocates for the same text. 256
 * is far past any real script — the frozen 913-script corpus peaks at 8, and
 * 866 of 913 files never pass 3 — and it turns that worst case into an early,
 * O(1) exit. Raised on the PR #214 review.
 */
const MAX_STRING_FRAME_DEPTH = 256;

/** Where a double-quoted string ends, and whether it was closed at all. */
export interface QuotedStringScan {
	/** index just past the closing `"`, or `text.length` when unterminated. */
	end: number;
	closed: boolean;
}

/**
 * Find the end of the double-quoted string that opens at `open` (H3).
 *
 * The one shared string skip for every structural scan in `explain`. A string is
 * NOT opaque up to the next `"`: a `$[…]` or `$(…)` substitution inside it is
 * CODE, and that code may open strings of its own —
 * `:local a "$[[:parse "(\"x\")"]]"` is ONE string on the device (CHR 7.23.2
 * `/console/inspect request=highlight` classes the following `#` line `comment`
 * and both `$a` occurrences `variable-local`). A scanner that stops at the first
 * nested `"` flips its quote phase and reads every later comment as string
 * content; on the frozen 913-script corpus that hid 2,184 device-`comment` bytes
 * across 7 files, and cost `symbols.ts` 3.1 points of precision before it grew
 * the frame model this function now shares (#198/#199).
 *
 * Frames mirror `symbols.ts`: a `"` frame is string phase (`\` escapes the next
 * character, `$[`/`$(` push a code frame), anything else is code phase (`"`
 * opens a nested string, brackets nest, a mismatched close is content rather
 * than a close — the same line `segment.ts` and `symbols.ts` take elsewhere).
 * Iterative, so deeply nested input cannot overflow the stack. Escapes and
 * comments inside the substitution are NOT interpreted here: the whole string,
 * substitutions included, stays opaque to the caller — only its END moves.
 *
 * Frame depth is capped for the same reason `MAX_CONTAINER_DEPTH` is: `explain`
 * accepts untrusted editor/MCP input. Past `MAX_STRING_FRAME_DEPTH` the scan
 * stops and reports the string UNCLOSED — fail-closed, the direction every
 * caller already handles (`unterminated-string` → `structuralDefect` →
 * `unresolved`). Only an input that opens that many frames without closing them
 * can reach it, which is malformed by construction; sequential substitutions
 * (`"$[a]$[b]…"`) pop and never accumulate.
 */
export function scanQuotedString(text: string, open: number): QuotedStringScan {
	const frames: string[] = ['"'];
	let i = open + 1;
	while (i < text.length) {
		if (frames.length > MAX_STRING_FRAME_DEPTH) break;
		const top = frames[frames.length - 1] as string;
		const c = text[i] as string;
		if (top === '"') {
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === '"') {
				frames.pop();
				i++;
				if (frames.length === 0) return { end: i, closed: true };
				continue;
			}
			// `$"…"` is NOT a quoted name inside a string (the device closes the
			// string on that quote), so only the bracket forms open code.
			if (c === "$" && (text[i + 1] === "[" || text[i + 1] === "(")) {
				frames.push(text[i + 1] as string);
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		if (c === '"' || c === "[" || c === "(" || c === "{") {
			frames.push(c);
			i++;
			continue;
		}
		if (c === "]" || c === ")" || c === "}") {
			const want = c === "]" ? "[" : c === ")" ? "(" : "{";
			if (top === want) frames.pop();
			i++;
			continue;
		}
		i++;
	}
	return { end: text.length, closed: false };
}

/**
 * How far a H5 `\<newline>` continuation still reaches (#215, CHR 7.23.3).
 *
 *   "none"    — no continuation pending.
 *   "escape"  — inside the `\<newline>` run itself. Blank and whitespace-only
 *               lines stay inside it (the device classes them `escaped`).
 *   "comment" — the run was ended by a continuation COMMENT line, which does
 *               not end the pending statement but does spend the run's reach:
 *               a following blank line now terminates.
 *
 * `Continuation` and the `lineStart` flag beside it are the vocabulary the
 * three parallel walkers (`maskComments`, `scanAscii`, `symbols.ts`) share, so
 * a change to the rule can be made in the same shape in each. #199 was two of
 * them drifting apart; this state is where the third one can.
 */
export type Continuation = "none" | "escape" | "comment";

/**
 * Blank out RouterOS comments so a later delimiter re-scan cannot be fooled by
 * `#` text (a `}` or `[` inside a comment is not a real delimiter). A `#` starts
 * a comment in statement-leading position (H4) or at the immediate start of a
 * line a continuation carried into (H5); any intervening space or tab makes it
 * content rather than a comment. Comments are opaque inside strings. Comment
 * characters become spaces; length and every non-comment offset are preserved,
 * so indices stay valid against the original and callers can slice the original
 * for content. Idempotent.
 */
export function maskComments(original: string): string {
	const out = original.split("");
	let atLead = true;
	let cont: Continuation = "none";
	let contLineStart = false;
	for (let i = 0; i < original.length; i++) {
		const c = original[i];
		const inCont = cont !== "none";
		const contComment = c === "#" && inCont && contLineStart;
		if (inCont && !contComment) {
			if (c === " " || c === "\t" || c === "\r") {
				contLineStart = false;
			} else if (c === "\n" && cont === "escape") {
				contLineStart = true;
				continue; // a blank line inside the `\` run is still the run
			} else {
				// Real content, or the blank line that spends a comment run's reach.
				cont = "none";
				contLineStart = false;
			}
		}
		if (c === '"') {
			atLead = false;
			i = scanQuotedString(original, i).end - 1;
			continue; // i rests on the closing quote (or past end)
		}
		// H4 is unchanged and H5 only ADDS the immediate-line-start case: an
		// indented `#` is a comment when the statement is still empty (`do={\` +
		// newline + `  # c`) and content when it is not (`:put a\` + newline +
		// `  # x`, which the device classes `error`) — exactly what `atLead` says.
		if (c === "#" && (atLead || contComment)) {
			while (i < original.length && original[i] !== "\n") {
				out[i] = " ";
				i++;
			}
			if (contComment) {
				// The comment line does not end the statement: step over its newline
				// (the loop's i++) with the continuation still pending.
				cont = "comment";
				contLineStart = true;
				continue;
			}
			i--; // let the loop advance onto the newline (or end)
			continue;
		}
		if (
			c === "\\" &&
			(original[i + 1] === "\n" ||
				(original[i + 1] === "\r" && original[i + 2] === "\n"))
		) {
			// H5 leaves `atLead` alone: `do={\` + newline + `:local x 1` still reads
			// `:local` as the statement head on the device.
			cont = "escape";
			contLineStart = true;
			i += original[i + 1] === "\r" ? 2 : 1;
			continue;
		}
		if (c === ";" || c === "\n" || c === "{") atLead = true;
		else if (c !== " " && c !== "\t" && c !== "\r") atLead = false;
	}
	return out.join("");
}

/**
 * Container-frame depth cap.
 *
 * Not a RouterOS grammar limit — an implementation guard derived from the Q17
 * stress finding (the lab walker overflowed the JS stack around 32k nested
 * containers). The single-pass scanner no longer recurses, so this is now a
 * resource guard rather than a stack-safety boundary: 256 preserves far more
 * nesting than normal scripts use while bounding the `frames` array. A `{` that
 * would open frame 257 is kept as an opaque group and the analysis abstains with
 * an `over-depth:<analyzed-byte-offset>` note.
 */
const MAX_CONTAINER_DEPTH = 256;

/**
 * Segment `original` into top-level statements. Spans are analyzed-byte offsets
 * (see module header); `text` is the original substring for each span.
 */
export function segmentStatements(original: string): SegmentResult {
	const analysis = analyzeCoordinates(original);
	// `analyzed` is pure ASCII, so a string built from it has index === byte.
	const ascii = new TextDecoder().decode(analysis.analyzed);
	const raw = scanAscii(ascii);
	// Recover the human-readable `text` for each segment from the original.
	const segments = raw.segments.map((s) => ({
		...s,
		text: originalSlice(analysis, s.start, s.end),
	}));
	return {
		segments,
		comments: raw.comments,
		// Coordinate-pass regions first: they are facts about the input as
		// received, and they exist even when the scan finds nothing structural.
		defects: mergeDefects(coordinateDefects(analysis), raw.defects),
	};
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

/** A located statement before its `text` is recovered from the original. */
type RawSegment = Omit<Segment, "text">;

/**
 * One nesting level of the single-pass walker. The top level is `frames[0]`
 * (`container: false`); each open CONTAINER `{…}` pushes a frame. Statements
 * accumulate in the active (innermost) frame's `buffer`; a container's buffer is
 * spliced into its parent on COMMIT and dropped on DISCARD.
 */
interface Frame {
	/** in-progress statement start in analyzed-byte space, or -1 (H6). */
	stmtStart: number;
	/** H4 — still before the first real token of the current statement? */
	atLead: boolean;
	/** H5 — how far the pending `\<newline>` continuation still reaches. */
	cont: Continuation;
	/** H5 — at the immediate start of a line the continuation carried into? */
	contLineStart: boolean;
	/**
	 * A mismatched close occurred in this statement/container. A container with
	 * a known structural defect must DISCARD rather than promote its buffered
	 * children as confident sibling statements.
	 */
	structurallyInvalid: boolean;
	/** Start/end of the prefix range already classified for H7. */
	prefixScanStart: number;
	prefixScanEnd: number;
	/** Incremental equivalent of trimming and checking the H7 prefix. */
	prefixSawNonSpace: boolean;
	prefixValid: boolean;
	/** statements collected here; the flattened output for a committed container. */
	buffer: RawSegment[];
	/** true for a container frame; false for the synthetic top level. */
	container: boolean;
	/** analyzed-byte index of the `{` that opened this container. */
	openIndex: number;
	/**
	 * Start of the statement this container belongs to — the menu prefix before
	 * the `{`. On DISCARD the parent statement resumes from here, so the whole
	 * `{…}` is absorbed verbatim, matching the old `containerOpen` = -1 path.
	 */
	prefixStart: number;
}

/**
 * Single left-to-right walk of a pure-ASCII string (byte === string index),
 * flattening H7 containers inline. Returns spans only; `segmentStatements`
 * recovers each `text` from the original afterward.
 */
function scanAscii(ascii: string): {
	segments: RawSegment[];
	comments: { start: number; end: number }[];
	defects: Defect[];
} {
	const comments: { start: number; end: number }[] = [];
	const defects: Defect[] = [];
	const overDepth: number[] = [];
	// H2 — every open bracket, for balance. Each frame carries WHERE it opened so
	// an `unclosed` defect can point at the opener rather than at the end of
	// input.
	const delimStack: { char: string; at: number }[] = [];
	const top: Frame = {
		stmtStart: -1,
		atLead: true,
		cont: "none",
		contLineStart: false,
		structurallyInvalid: false,
		prefixScanStart: -1,
		prefixScanEnd: -1,
		prefixSawNonSpace: false,
		prefixValid: true,
		buffer: [],
		container: false,
		openIndex: -1,
		prefixStart: -1,
	};
	const frames: Frame[] = [top];
	const cur = (): Frame => frames[frames.length - 1] as Frame;

	// At container level when every open bracket is a container `{` — i.e. no
	// value bracket (`[ ( ` or a non-container `{`) is open. Only then do
	// separators split and only then can a `{` open a new container. (Container
	// frames only open at this level, so they always sit at the bottom of
	// `delimStack`; plain brackets sit above.)
	const atContainerLevel = (): boolean =>
		delimStack.length === frames.length - 1;

	const ensureStmt = (f: Frame, i: number): void => {
		if (f.stmtStart < 0) f.stmtStart = i;
	};

	const resetPrefixScan = (f: Frame): void => {
		f.prefixScanStart = -1;
		f.prefixScanEnd = -1;
		f.prefixSawNonSpace = false;
		f.prefixValid = true;
	};

	const makeSegment = (
		start: number,
		end: number,
		terminator: Segment["terminator"],
	): RawSegment | null => {
		const raw = ascii.slice(start, end);
		const trimmed = raw.trim();
		if (trimmed.length === 0) return null; // H6
		const lead = raw.length - raw.trimStart().length;
		const s = start + lead;
		return {
			start: s,
			end: s + trimmed.length,
			terminator,
			menuOnly: isMenuOnly(trimmed),
		};
	};

	const flush = (
		f: Frame,
		end: number,
		terminator: Segment["terminator"],
	): void => {
		if (f.stmtStart < 0) return;
		const s = makeSegment(f.stmtStart, end, terminator);
		f.stmtStart = -1;
		resetPrefixScan(f);
		if (s) f.buffer.push(s);
		// The synthetic top frame can recover at a real statement boundary. A
		// container stays poisoned until it closes so a defect in one buffered
		// child cannot make later children look independently trustworthy.
		if (!f.container) f.structurallyInvalid = false;
	};

	// A container prefix is empty or a bare `/`-menu path with no `=[($"` — the
	// same test the old `containerOpen` applied to the group's prefix.
	const validPrefix = (f: Frame, start: number, end: number): boolean => {
		if (f.prefixScanStart !== start || f.prefixScanEnd > end) {
			resetPrefixScan(f);
			f.prefixScanStart = start;
			f.prefixScanEnd = start;
		}
		if (!f.prefixValid) {
			f.prefixScanEnd = end;
			return false;
		}
		for (let i = f.prefixScanEnd; i < end; i++) {
			const c = ascii[i] as string;
			if (!f.prefixSawNonSpace) {
				if (c.trim().length === 0) continue;
				f.prefixSawNonSpace = true;
				if (c !== "/") {
					f.prefixValid = false;
					break;
				}
			}
			if (/[=[($"]/.test(c)) {
				f.prefixValid = false;
				break;
			}
		}
		f.prefixScanEnd = end;
		return f.prefixValid;
	};

	const openContainer = (i: number): void => {
		const parent = cur();
		// prefixStart = the parent statement's start, or the `{` itself when the
		// container has no prefix (so a DISCARD absorbs from the `{`).
		const prefixStart = parent.stmtStart >= 0 ? parent.stmtStart : i;
		delimStack.push({ char: "{", at: i });
		frames.push({
			stmtStart: -1,
			atLead: true,
			cont: "none",
			contLineStart: false,
			structurallyInvalid: parent.structurallyInvalid,
			prefixScanStart: -1,
			prefixScanEnd: -1,
			prefixSawNonSpace: false,
			prefixValid: true,
			buffer: [],
			container: true,
			openIndex: i,
			prefixStart,
		});
	};

	// A container's `}` ends the parent statement (so the group is a real trailing
	// container) when the next non-blank char is a separator, end of input, or the
	// `}` that closes an enclosing container. Any other trailing content means the
	// `}` was mid-statement — the old `containerOpen` = -1 case.
	const trailingEndsStatement = (closeIndex: number): boolean => {
		let j = closeIndex + 1;
		while (j < ascii.length && isSpace(ascii[j] as string)) j++;
		if (j >= ascii.length) return true;
		const n = ascii[j];
		if (n === ";" || n === "\n") return true;
		if (n === "}") return cur().container; // closes the parent container
		return false;
	};

	const closeContainer = (i: number): void => {
		const frame = frames.pop() as Frame;
		// Flush the body's last statement. Its terminator is "eof" — the end of
		// the container body, matching the old per-body scan; the `}` itself is
		// not a statement terminator token (only `;`/newline/actual EOF are).
		flush(frame, i, "eof");
		const parent = cur();
		if (
			!frame.structurallyInvalid &&
			frame.buffer.length > 0 &&
			trailingEndsStatement(i)
		) {
			// COMMIT: menu-prefix segment (if any), then the buffered body, replace
			// the container in the parent stream; the parent statement is consumed.
			const prefix = makeSegment(frame.prefixStart, frame.openIndex, "newline");
			if (prefix) parent.buffer.push(prefix);
			for (const s of frame.buffer) parent.buffer.push(s);
			parent.stmtStart = -1;
			resetPrefixScan(parent);
		} else {
			// DISCARD: empty body or trailing content — the parent statement absorbs
			// the whole `{…}` verbatim by resuming from the container's prefix.
			parent.stmtStart = frame.prefixStart;
			parent.structurallyInvalid ||= frame.structurallyInvalid;
		}
		parent.atLead = false;
	};

	let i = 0;
	while (i < ascii.length) {
		const c = ascii[i] as string;
		const f = cur();

		// H4/H5 — a comment is statement-leading, or at the immediate start of a
		// line a continuation carried into. Both are decided from state as it
		// stands BEFORE the continuation bookkeeping below, so an indented `#`
		// mid-continuation stays content.
		const inCont = f.cont !== "none";
		const contComment = c === "#" && inCont && f.contLineStart;
		if (c === "#" && (f.atLead || contComment)) {
			const nl = ascii.indexOf("\n", i);
			const end = nl === -1 ? ascii.length : nl;
			comments.push({ start: i, end });
			if (contComment) {
				// The comment line does not end the statement — step over its newline
				// rather than letting the separator branch flush there.
				f.cont = "comment";
				f.contLineStart = true;
				i = nl === -1 ? end : end + 1;
			} else {
				i = end;
			}
			continue;
		}

		if (inCont) {
			if (c === " " || c === "\t" || c === "\r") {
				f.contLineStart = false;
			} else if (c === "\n" && f.cont === "escape") {
				// A blank line inside the `\` run is still the run: no flush.
				f.contLineStart = true;
				i++;
				continue;
			} else {
				// Real content, or the blank line that spends a comment run's reach
				// and so falls through to the separator branch below.
				f.cont = "none";
				f.contLineStart = false;
			}
		}

		// H3 — string.
		if (c === '"') {
			ensureStmt(f, i);
			f.atLead = false;
			const str = scanQuotedString(ascii, i);
			if (!str.closed) {
				// The region is the whole unterminated run — from the opening quote
				// to where the scan gave up — not just the quote. A consumer
				// highlighting the defect wants the text that is swallowed by it.
				defects.push({ code: "unterminated-string", start: i, end: str.end });
			}
			i = str.end;
			continue;
		}

		// H5 — line continuation.
		if (
			c === "\\" &&
			(ascii[i + 1] === "\n" ||
				(ascii[i + 1] === "\r" && ascii[i + 2] === "\n"))
		) {
			// `atLead` deliberately survives: `do={\` + newline + `:local x 1` still
			// reads `:local` as the statement head on the device (#215).
			ensureStmt(f, i);
			f.cont = "escape";
			f.contLineStart = true;
			i += ascii[i + 1] === "\r" ? 3 : 2;
			continue;
		}

		// H2/H7 — opens. A `{` at container level with a valid prefix opens a
		// container frame (or, past the cap, abstains); everything else is a plain
		// group that only tracks balance and suppresses separators.
		if (c === "{" || c === "[" || c === "(") {
			if (
				c === "{" &&
				atContainerLevel() &&
				validPrefix(f, f.stmtStart >= 0 ? f.stmtStart : i, i)
			) {
				if (frames.length - 1 < MAX_CONTAINER_DEPTH) {
					openContainer(i);
				} else {
					overDepth.push(i);
					ensureStmt(f, i);
					delimStack.push({ char: "{", at: i });
					f.atLead = true;
				}
			} else {
				ensureStmt(f, i);
				delimStack.push({ char: c, at: i });
				f.atLead = c === "{";
			}
			i++;
			continue;
		}

		// H2 — closes.
		if (c === "}" || c === "]" || c === ")") {
			const want = c === "}" ? "{" : c === "]" ? "[" : "(";
			if (delimStack[delimStack.length - 1]?.char === want) {
				const isContainerClose =
					c === "}" &&
					frames.length > 1 &&
					delimStack.length === frames.length - 1;
				delimStack.pop();
				if (isContainerClose) {
					closeContainer(i);
				} else {
					ensureStmt(f, i);
					f.atLead = false;
				}
			} else {
				defects.push(defectAt("unbalanced-close", i, c));
				ensureStmt(f, i);
				f.atLead = false;
				f.structurallyInvalid = true;
			}
			i++;
			continue;
		}

		// H1 — separators. They END a statement only at container level, but
		// restore statement-leading position at every depth so H4 can see a
		// comment inside a block body.
		if (c === ";" || c === "\n") {
			if (atContainerLevel()) flush(f, i, c === ";" ? ";" : "newline");
			f.atLead = true;
			i++;
			continue;
		}

		if (isSpace(c)) {
			i++;
			continue;
		}

		ensureStmt(f, i);
		f.atLead = false;
		i++;
	}

	// End of input: any still-open container never closed, so it never flattens —
	// unwind each as a DISCARD (outermost open container's prefix wins), then flush
	// the surviving top-level statement.
	while (frames.length > 1) {
		const frame = frames.pop() as Frame;
		const parent = cur();
		parent.stmtStart = frame.prefixStart;
		parent.atLead = false;
	}
	flush(top, ascii.length, "eof");
	if (delimStack.length > 0) {
		// One defect per still-open delimiter, each pointing at its OPENER —
		// "something is unclosed" is not actionable, "the `{` at byte 41 is
		// unclosed" is.
		for (const d of delimStack)
			defects.push(defectAt("unclosed", d.at, d.char));
	}

	return {
		segments: top.buffer,
		comments,
		defects: [
			...defects,
			// No `detail`: `symbols.ts` and `pathresolve.ts` emit this class without
			// one, and `mergeDefects` keys on it, so a `"{"` here would make the same
			// event fail to de-duplicate across analyzers.
			...overDepth.map((offset) => defectAt("over-depth", offset)),
		],
	};
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
