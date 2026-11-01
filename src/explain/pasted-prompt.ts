import { buildTip, type Tip } from "../core/envelope.ts";
import { type Segment, segmentStatements } from "./segment.ts";

/**
 * Pasted console-prompt repair (#370).
 *
 * Recognizes two grounded prompt shapes at the start of a *statement* (not a
 * raw line, so prompt-looking text inside strings and comments stays legal):
 *
 * - `[user@host] <menu>> <command>` — e.g. `[admin@MikroTik] > /ip/address print`
 *   at the root, or `[admin@MikroTik] /ip/address> add …` inside a menu, the
 *   shape the manual's Console page shows; a HotLock prompt doubles the `>`
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
 * The candidate is the prompt-stripped tail of the ORIGINAL input — separators,
 * blocks and newlines preserved verbatim — bounded by the next pasted prompt
 * or the end of input, so each prompt in a transcript gets its own repair.
 * Reconstructing from segment texts would flatten `{ ... }` blocks and drop
 * whatever follows them. The slice needs analyzed-byte offsets as JS indices,
 * which hold only when the segmentation reports `ascii`; otherwise the
 * per-segment candidate stands (narrow, never wrong).
 */
const BRACKET_PROMPT_RE =
	/^\[[^[\]\r\n]*@[^[\]\r\n]*\]\s*(\/[A-Za-z0-9_\-/]*)?\s*>>?\s*([\s\S]*)$/;
const MENU_PROMPT_RE = /^(\/[A-Za-z0-9_\-/]+)\s*>>?\s*([\s\S]*)$/;

export interface PastedPromptHit {
	shape: "bracket" | "menu";
	menu?: string;
	candidate: string;
}

interface StrippedPrompt {
	shape: "bracket" | "menu";
	menu?: string;
	/** Length of the prompt prefix within the segment text. */
	promptEnd: number;
	candidate: string;
}

/** True when re-segmenting `text` reports an unbalanced delimiter. */
function hasUnbalancedDelimiters(text: string): boolean {
	try {
		return segmentStatements(text).defects.some(
			(d) => d.code === "unbalanced-close" || d.code === "unclosed",
		);
	} catch {
		return true;
	}
}

export function detectPastedPrompts(input: string): PastedPromptHit[] {
	const hits: PastedPromptHit[] = [];
	let segments: Segment[];
	let ascii: boolean;
	try {
		const result = segmentStatements(input);
		segments = result.segments;
		ascii = result.ascii;
	} catch {
		return hits;
	}
	// Per-segment prompt match. A bare prompt with no command ("prompt-empty")
	// earns no hit but still bounds the previous hit's region.
	const stripped: (StrippedPrompt | "prompt-empty" | null)[] = segments.map(
		(segment) => {
			const text = segment.text;
			if (text.length === 0) return null;
			const bracket = BRACKET_PROMPT_RE.exec(text);
			if (bracket !== null) {
				const menu = bracket[1];
				const group = bracket[2] ?? "";
				return group.trim().length > 0
					? {
							shape: "bracket",
							...(menu && menu !== "/" ? { menu } : {}),
							promptEnd: text.length - group.length,
							candidate: group.trim(),
						}
					: "prompt-empty";
			}
			const menu = MENU_PROMPT_RE.exec(text);
			if (menu !== null) {
				const group = menu[2] ?? "";
				return group.trim().length > 0
					? {
							shape: "menu",
							menu: menu[1],
							promptEnd: text.length - group.length,
							candidate: group.trim(),
						}
					: "prompt-empty";
			}
			return null;
		},
	);
	for (let i = 0; i < segments.length; i++) {
		const hit = stripped[i];
		if (hit === null || hit === undefined || hit === "prompt-empty") continue;
		let candidate = hit.candidate;
		if (ascii) {
			const segment = segments[i];
			let end = input.length;
			for (let j = i + 1; j < segments.length; j++) {
				if (stripped[j] !== null && stripped[j] !== undefined) {
					end = segments[j]?.start ?? end;
					break;
				}
			}
			const sliced = input
				.slice((segment?.start ?? 0) + hit.promptEnd, end)
				.trim();
			// The slice must not cross the prompt's enclosing container: it is
			// kept only when it re-segments balanced, else the narrow
			// per-segment candidate stands (`{ /menu> cmd }` would otherwise
			// offer `cmd }`).
			if (sliced.length > 0 && !hasUnbalancedDelimiters(sliced))
				candidate = sliced;
		}
		hits.push({
			shape: hit.shape,
			...(hit.menu ? { menu: hit.menu } : {}),
			candidate,
		});
	}
	return hits;
}

/**
 * A markdown code span that survives backticks in `text`: the fence is one
 * longer than the longest backtick run inside, padded when `text` starts or
 * ends with one (CommonMark code spans).
 */
function codeSpan(text: string): string {
	const longest = Math.max(
		0,
		...(text.match(/`+/g) ?? []).map((run) => run.length),
	);
	const fence = "`".repeat(longest + 1);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

export function pastedPromptTips(input: string): Tip[] {
	return detectPastedPrompts(input).map((hit) => {
		const where = hit.menu ? ` (typed at ${codeSpan(hit.menu)})` : "";
		const fix = `Drop the pasted prompt and try ${codeSpan(hit.candidate)}${where} instead — this input was not executed.`;
		if (hit.shape === "menu")
			return buildTip(
				"tip/explain-pasted-prompt",
				`This looks like a pasted ${codeSpan(hit.menu ?? "")} menu prompt, not a command to run from the root.`,
				fix,
			);
		const prompt = hit.menu ? `[user@host] ${hit.menu}>` : "[user@host] >";
		return buildTip(
			"tip/explain-pasted-prompt",
			`This looks like a pasted console transcript (${codeSpan(prompt)}), not a command to run.`,
			fix,
		);
	});
}
