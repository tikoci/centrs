/**
 * B2 path fill — claims resolved menu and command-name bytes on the residual.
 *
 * Only decided `navigation` and `resolved` readings participate. Ambiguous or
 * unknown runs stay unclassified, and a statement whose source bytes cannot be
 * mapped exactly is refused just like argument/value fills.
 *
 * Slash separators belong to `dir` when they are part of a valid path. Space
 * separators remain unclassified. A `\<newline>` inside a name interrupts the
 * emitted range so the continuation bytes remain available to the escape fill.
 *
 * Vocabulary is provisional until #264 B5: `dir` and `cmd` mirror the useful
 * lexical distinction already produced by RouterOS highlight, but are
 * centrs-owned classes.
 */

import type { ExplainToken } from "../explain.ts";
import {
	mergeAdjacentTokens,
	type TokenRange,
	tokensOnResidual,
} from "./token-ranges.ts";
import { locatedRunTokens, type VerbSplit } from "./verbsplit.ts";

export interface PathTokenCandidate {
	text: string;
	span: TokenRange;
	split: VerbSplit;
	ev: string;
}

export function pathSpans(
	analyzed: string,
	residual: readonly TokenRange[],
	candidates: readonly PathTokenCandidate[],
): ExplainToken[] {
	if (analyzed.length === 0 || residual.length === 0) return [];
	const out: ExplainToken[] = [];

	for (const candidate of candidates) {
		if (
			candidate.split.resolution !== "resolved" &&
			candidate.split.resolution !== "navigation"
		)
			continue;
		const { start, end } = candidate.span;
		if (
			!Number.isInteger(start) ||
			!Number.isInteger(end) ||
			start < 0 ||
			end <= start ||
			end > analyzed.length ||
			analyzed.slice(start, end) !== candidate.text
		)
			continue;

		let bodyStart = 0;
		while (
			bodyStart < candidate.text.length &&
			[" ", "\t", "\r", "\n"].includes(candidate.text[bodyStart] as string)
		)
			bodyStart++;
		const directiveColon = candidate.text[bodyStart] === ":";
		if (directiveColon) bodyStart++;
		const run = locatedRunTokens(candidate.text.slice(bodyStart));
		const last =
			candidate.split.resolution === "resolved"
				? candidate.split.verbAt
				: run.length - 1;
		if (last < 0 || last >= run.length) continue;
		const slashPositions = new Set<number>();
		let coveredEnd = bodyStart;
		for (let index = 0; index <= last; index++) {
			const token = run[index];
			if (token === undefined) continue;
			for (const range of token.nameSpans)
				coveredEnd = Math.max(coveredEnd, bodyStart + range.end);
			if (token.slashBefore !== undefined) {
				slashPositions.add(bodyStart + token.slashBefore.start);
				coveredEnd = Math.max(coveredEnd, bodyStart + token.slashBefore.end);
			}
			if (token.slashAfter !== undefined) {
				slashPositions.add(bodyStart + token.slashAfter.start);
				coveredEnd = Math.max(coveredEnd, bodyStart + token.slashAfter.end);
			}
		}
		let malformedSlash = false;
		for (let offset = 0; offset < coveredEnd; offset++) {
			if (candidate.text[offset] === "/" && !slashPositions.has(offset)) {
				malformedSlash = true;
				break;
			}
		}
		if (malformedSlash) continue;
		if (directiveColon) {
			out.push(
				...tokensOnResidual(
					[
						{
							start: start + bodyStart - 1,
							end: start + bodyStart,
						},
					],
					residual,
					"dir",
					candidate.ev,
				),
			);
		}

		for (let index = 0; index <= last; index++) {
			const token = run[index];
			if (token === undefined) continue;
			const class_ =
				candidate.split.resolution === "resolved" &&
				index === candidate.split.verbAt
					? "cmd"
					: "dir";
			const ranges: TokenRange[] = token.nameSpans.map((range) => ({
				start: start + bodyStart + range.start,
				end: start + bodyStart + range.end,
			}));
			if (token.slashBefore !== undefined) {
				out.push(
					...tokensOnResidual(
						[
							{
								start: start + bodyStart + token.slashBefore.start,
								end: start + bodyStart + token.slashBefore.end,
							},
						],
						residual,
						"dir",
						candidate.ev,
					),
				);
			}
			if (class_ === "dir" && token.slashAfter !== undefined) {
				ranges.push({
					start: start + bodyStart + token.slashAfter.start,
					end: start + bodyStart + token.slashAfter.end,
				});
			}
			out.push(...tokensOnResidual(ranges, residual, class_, candidate.ev));
		}
	}

	return mergeAdjacentTokens(out);
}
