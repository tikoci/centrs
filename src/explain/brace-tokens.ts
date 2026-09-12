/**
 * B3 brace fill — claims brace delimiters on the residual.
 *
 * Value-anchored array literals are claimed as `value` leaves, but their outer
 * delimiters remain unclassified (container excluded to avoid overlap). Scope
 * braces (`do={...}` etc.) are never array values. Both families therefore
 * appear on the residual after the `value` and `string` fills, so this fill
 * claims every remaining `{` / `}` byte there as `brace`. #264 B5 kept scope
 * and array delimiters in one class: `structure.blocks[]` already locates every
 * scope block, and an array container is the `data.values.occurrences[]` entry
 * that is some other occurrence's `parent`, so the distinction is a join away.
 */

import type { ExplainToken } from "../explain.ts";
import { clipToResidual } from "./token-ranges.ts";

/** Brace delimiter spans on the residual. */
export function braceSpans(
	analyzed: string,
	residual: readonly { start: number; end: number }[],
): ExplainToken[] {
	const len = analyzed.length;
	if (len === 0 || residual.length === 0) return [];
	const out: ExplainToken[] = [];
	for (let i = 0; i < analyzed.length; i++) {
		const c = analyzed[i] as string;
		if (c !== "{" && c !== "}") continue;
		for (const r of clipToResidual(i, i + 1, residual)) {
			out.push({
				start: r.start,
				end: r.end,
				class: "brace" as const,
				ev: "e14",
			});
		}
	}
	out.sort((a, b) => a.start - b.start || a.end - b.end);
	return out;
}
