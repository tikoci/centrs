import type { ExplainToken, ExplainTokenClass } from "../explain.ts";

export interface TokenRange {
	start: number;
	end: number;
}

export function clipToResidual(
	start: number,
	end: number,
	residual: readonly TokenRange[],
): TokenRange[] {
	if (start >= end || residual.length === 0) return [];
	let lo = 0;
	let hi = residual.length - 1;
	let first = residual.length;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const range = residual[mid] as TokenRange;
		if (range.end <= start) lo = mid + 1;
		else {
			first = mid;
			hi = mid - 1;
		}
	}
	const out: TokenRange[] = [];
	for (let i = first; i < residual.length; i++) {
		const range = residual[i] as TokenRange;
		if (range.start >= end) break;
		const clippedStart = Math.max(start, range.start);
		const clippedEnd = Math.min(end, range.end);
		if (clippedStart < clippedEnd)
			out.push({ start: clippedStart, end: clippedEnd });
	}
	return out;
}

export function mergeAdjacentTokens(
	tokens: readonly ExplainToken[],
): ExplainToken[] {
	const sorted = [...tokens].sort((a, b) => a.start - b.start || a.end - b.end);
	const out: ExplainToken[] = [];
	for (const token of sorted) {
		const last = out.at(-1);
		if (
			last !== undefined &&
			last.end === token.start &&
			last.class === token.class &&
			last.ev === token.ev
		) {
			last.end = token.end;
			continue;
		}
		out.push({ ...token });
	}
	return out;
}

export function tokensOnResidual(
	ranges: readonly TokenRange[],
	residual: readonly TokenRange[],
	class_: ExplainTokenClass,
	ev: string,
): ExplainToken[] {
	return ranges.flatMap((range) =>
		clipToResidual(range.start, range.end, residual).map((clipped) => ({
			...clipped,
			class: class_,
			ev,
		})),
	);
}
