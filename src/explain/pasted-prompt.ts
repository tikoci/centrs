import { buildTip, type Tip } from "../core/envelope.ts";
import { type Segment, segmentStatements } from "./segment.ts";

/**
 * Pasted console-prompt repair (#370).
 *
 * Recognizes two grounded prompt shapes at the start of a *statement* (not a
 * raw line, so prompt-looking text inside strings and comments stays legal):
 *
 * - `[user@host] > <command>` — e.g. `[admin@MikroTik] > /ip/address print`
 * - `/menu/path> <command>` — e.g. `/interface/lte> monitor lte1`
 *
 * Segmentation already split the document on real statement boundaries with
 * string/comment awareness, so testing each segment's start is a lexical
 * position, not a line-start regex. A prompt-looking line inside a multiline
 * string is interior to its segment and never at a segment start; comment
 * lines never become segments at all.
 *
 * Severity / envelope behavior (chosen, documented here per #370 scope):
 * the tip is ADVISORY only and never changes `data.verdict`. The bracket
 * shape already fails via `invalid-at-sign` (the `@` is a hard fault); the
 * menu shape stays `warn` (abstention — offline cannot prove the menu
 * exists on any given device). Output banners (`Flags:`, `Columns:`) and
 * bare `>` forms are deliberately NOT detected here; they are separately
 * grounded cases, not automatic extensions.
 *
 * The stripped candidate is offered as repair TEXT only and is never adopted
 * or executed: tips carry no execution semantics. For the menu shape the
 * candidate is the literal text after `>` (it runs in that menu's context
 * on the device, not from the root).
 *
 * A pasted line may join statements with `;`, which the segmenter splits:
 * `[x@h] > :put 1; :put 2` is two segments, but the repair must keep both.
 * The candidate therefore extends along `;`-terminated followers (same
 * pasted line, re-joined with `; `), stopping at a newline boundary or at a
 * follower that starts with its own prompt — that one gets its own hit.
 */
const BRACKET_PROMPT_RE = /^\[[^[\]\r\n]*@[^[\]\r\n]*\]\s*>\s*([\s\S]*)$/;
const MENU_PROMPT_RE = /^(\/[A-Za-z0-9_\-/]+)\s*>\s*([\s\S]*)$/;

export interface PastedPromptHit {
	shape: "bracket" | "menu";
	menu?: string;
	candidate: string;
}

export function detectPastedPrompts(input: string): PastedPromptHit[] {
	const hits: PastedPromptHit[] = [];
	let segments: Segment[];
	try {
		segments = segmentStatements(input).segments;
	} catch {
		return hits;
	}
	const stripped = segments.map((segment) => {
		const text = segment.text;
		if (text.length === 0) return null;
		const bracket = BRACKET_PROMPT_RE.exec(text);
		if (bracket !== null) {
			const candidate = (bracket[1] ?? "").trim();
			return candidate.length > 0
				? { shape: "bracket" as const, candidate }
				: null;
		}
		const menu = MENU_PROMPT_RE.exec(text);
		if (menu !== null) {
			const candidate = (menu[2] ?? "").trim();
			return candidate.length > 0
				? { shape: "menu" as const, menu: menu[1], candidate }
				: null;
		}
		return null;
	});
	for (let i = 0; i < segments.length; i++) {
		const hit = stripped[i];
		if (hit === null || hit === undefined) continue;
		let candidate = hit.candidate;
		let j = i;
		while (
			segments[j]?.terminator === ";" &&
			j + 1 < segments.length &&
			stripped[j + 1] === null &&
			(segments[j + 1]?.text.length ?? 0) > 0
		) {
			j += 1;
			candidate += `; ${segments[j]?.text ?? ""}`;
		}
		hits.push({ ...hit, candidate });
	}
	return hits;
}

export function pastedPromptTips(input: string): Tip[] {
	return detectPastedPrompts(input).map((hit) =>
		hit.shape === "bracket"
			? buildTip(
					"tip/explain-pasted-prompt",
					"This looks like a pasted console transcript (`[user@host] >`), not a command to run.",
					`Drop the pasted prompt and try \`${hit.candidate}\` instead — this input was not executed.`,
				)
			: buildTip(
					"tip/explain-pasted-prompt",
					`This looks like a pasted \`${hit.menu}\` menu prompt, not a command to run from the root.`,
					`Drop the pasted prompt and try \`${hit.candidate}\` (typed at \`${hit.menu}\`) instead — this input was not executed.`,
				),
	);
}
