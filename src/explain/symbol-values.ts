/**
 * Flow-sensitive symbol → value-facts for `explain` (#239 S2).
 *
 * S1 surfaced `data.symbols` as the semantic Q13 projection: name/span/class/
 * role/bindingIds per occurrence. S2 connects those occurrences to
 * `data.values` occurrences without executing user code.
 *
 * - A declaration/binding/assignment with a literal RHS gets a `valueId` that
 *   points at the `ExplainValueOccurrence` that spells it. No RHS evaluation:
 *   `$x`, `[...]` or an expression yields no `valueId` and later references
 *   become `unknown` for that binding.
 * - A reference gets the *reaching* literal ids at that program point. Linear
 *   code is last-write-wins; a branch merge becomes a set; a loop merge or a
 *   non-literal assignment becomes `unknown`. This is deliberately
 *   conservative and schema-free — the same branch that would need a schema to
 *   decide `variable-undefined` is the one that forces a set here.
 *
 * The analysis never runs user input (`runtimeAcceptance` stays `not-proven`).
 * It reuses the same statement splits and value anchors the diagnostic/value
 * surfaces already gate on, so a def never points outside its own statement.
 */

import type {
	ExplainSymbolOccurrence,
	ExplainValueOccurrence,
} from "../explain.ts";
import { scopeBlocks } from "./blocks.ts";
import type { SymbolOccurrence } from "./symbols.ts";
import type { DocumentVerbSplit } from "./verbsplit.ts";

interface BlockInfo {
	start: number;
	end: number;
	isLoop: boolean;
	name: string;
}

type BindingState = {
	valueIds: Set<string>;
	unknown: boolean;
};

function cloneStateMap(
	source: Map<string, BindingState>,
): Map<string, BindingState> {
	const out = new Map<string, BindingState>();
	for (const [k, v] of source)
		out.set(k, { valueIds: new Set(v.valueIds), unknown: v.unknown });
	return out;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const v of a) if (!b.has(v)) return false;
	return true;
}

/**
 * Collect all scope blocks in `text`, rebased to `base`, recursively.
 *
 * `splits` are the flattened statement splits for the same document; they are
 * used to decide whether a `do={...}` body belongs to a loop verb (`foreach`,
 * `for`, `while`) or to a branch (`if`, `do`, `else`, `on-error`).
 */
function collectBlocks(
	text: string,
	base: number,
	splits: readonly DocumentVerbSplit[],
): BlockInfo[] {
	const out: BlockInfo[] = [];
	for (const b of scopeBlocks(text)) {
		const start = base + b.start;
		const end = start + b.body.length;
		const bracePos = start - 1;
		let isLoop = false;
		for (const split of splits) {
			const span = split.span;
			if (span.start <= bracePos && bracePos < span.end) {
				const verb = (split as unknown as { verb?: string | null }).verb;
				if (verb !== undefined && verb !== null) {
					const lower = verb.toLowerCase();
					if (lower === "foreach" || lower === "for" || lower === "while")
						isLoop = true;
				}
				break;
			}
		}
		if (!isLoop) {
			const before = text.slice(Math.max(0, b.start - 50), b.start);
			if (/\b(?:foreach|for|while)\b/i.test(before)) isLoop = true;
		}
		out.push({ start, end, isLoop, name: b.name });
		out.push(...collectBlocks(b.body, start, splits));
	}
	return out;
}

/**
 * Find the literal value that a defining occurrence establishes, if any.
 *
 * The declaration's RHS is the first *positional* value anchor in the same
 * statement whose start is after the symbol's end. Attribute values (`name=`)
 * and `element` members are not considered — `:foreach i in={...}` must not
 * link `i` to the `in` attribute. Only the same statement's values are
 * candidates, which also prevents cross-statement mis-linking.
 */
function defValueId(
	occurrence: SymbolOccurrence,
	splits: readonly DocumentVerbSplit[],
	values: readonly ExplainValueOccurrence[],
): string | undefined {
	if (
		occurrence.role !== "declaration" &&
		occurrence.role !== "binding" &&
		occurrence.role !== "assignment"
	)
		return undefined;
	if (occurrence.bindingIds.length === 0) return undefined;
	// Only locals/globals have a literal RHS that is a positional value.
	// `auto` (loop var) is initialized by the loop machinery, not by a
	// literal in the same statement, so skip it.
	if (occurrence.cls !== "local" && occurrence.cls !== "global")
		return undefined;

	let split: DocumentVerbSplit | undefined;
	for (const s of splits)
		if (s.span.start <= occurrence.start && occurrence.start < s.span.end) {
			split = s;
			break;
		}
	if (split === undefined) return undefined;

	let best: ExplainValueOccurrence | undefined;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const value of values) {
		if (value.span.start < split.span.start || value.span.end > split.span.end)
			continue;
		if (value.kind === "element") continue;
		if (value.span.start <= occurrence.start) continue;
		// Prefer positional directly after the declaration; an attribute with
		// the same span would be the wrong kind.
		if (value.kind !== "positional" && value.kind !== "attribute") continue;
		// For a declaration, the RHS should be positional, not an attribute
		// named `do`/`else` etc. Skip attribute values that are scope names.
		if (value.kind === "attribute" && value.name !== undefined) {
			const lower = value.name.toLowerCase();
			if (lower === "do" || lower === "else" || lower === "in") continue;
		}
		if (value.kind === "positional") {
			const dist = value.span.start - occurrence.end;
			if (dist < 0 || dist >= bestDist) continue;
			bestDist = dist;
			best = value;
		} else if (best === undefined || best.kind !== "positional") {
			// Attribute candidate only if no positional is closer
			const dist = value.span.start - occurrence.end;
			if (dist < 0 || dist >= bestDist) continue;
			bestDist = dist;
			best = value;
		}
	}
	if (best !== undefined) {
		// Distance guard: a value far from the name is likely a later
		// positional (e.g. `:local x 1; :local y 2` — x should not claim y's 2).
		// The RHS of a `:local`/`:global`/`:set` starts within a few bytes of
		// the name; a gap beyond 60 bytes is a different token. Guard avoids
		// mis-linking when the same split holds multiple declarations.
		if (bestDist > 60) return undefined;
		return best.id;
	}
	return undefined;
}

/**
 * Augment the existing symbol/value surfaces with flow-sensitive refs.
 *
 * Returns new `ExplainSymbolOccurrence` rows that carry `valueId` on
 * definitions and `reachingValueIds`/`reachingUnknown` on references. The
 * underlying `SymbolOccurrence`/`ExplainValueOccurrence` inputs are not
 * mutated.
 */
export function augmentSymbolOccurrences(
	analyzed: string,
	symbols: readonly SymbolOccurrence[],
	values: readonly ExplainValueOccurrence[],
	splits: readonly DocumentVerbSplit[],
): ExplainSymbolOccurrence[] {
	const augmented: ExplainSymbolOccurrence[] = [];
	// Map from occurrence index -> valueId for quick lookup during flow pass
	const defMap = new Map<number, string>();
	for (let i = 0; i < symbols.length; i++) {
		const occ = symbols[i] as SymbolOccurrence;
		const vid = defValueId(occ, splits, values);
		if (vid !== undefined) defMap.set(i, vid);
	}

	const blocks = collectBlocks(analyzed, 0, splits);
	const events: { offset: number; type: "enter" | "exit"; isLoop: boolean }[] =
		[];
	for (const b of blocks) {
		events.push({ offset: b.start, type: "enter", isLoop: b.isLoop });
		events.push({ offset: b.end, type: "exit", isLoop: b.isLoop });
	}
	events.sort((a, b) => {
		if (a.offset !== b.offset) return a.offset - b.offset;
		// enter before exit at same offset (nested)
		if (a.type === b.type) return 0;
		return a.type === "enter" ? -1 : 1;
	});

	// Occurrences are already sorted by start
	const ordered = symbols.map((occ, index) => ({ occ, index }));
	// Flow state
	let current = new Map<string, BindingState>();
	const stack: { snapshot: Map<string, BindingState>; isLoop: boolean }[] = [];
	let eventIdx = 0;
	const refReaching = new Map<
		number,
		{ valueIds: string[]; unknown: boolean }
	>();

	const processEventsUpTo = (pos: number): void => {
		while (eventIdx < events.length) {
			const ev = events[eventIdx] as {
				offset: number;
				type: "enter" | "exit";
				isLoop: boolean;
			};
			if (ev.offset > pos) break;
			eventIdx++;
			if (ev.type === "enter") {
				stack.push({ snapshot: cloneStateMap(current), isLoop: ev.isLoop });
			} else {
				const top = stack.pop();
				if (top === undefined) continue;
				const snapshot = top.snapshot;
				const isLoop = top.isLoop;
				const merged = cloneStateMap(snapshot);
				const allIds = new Set<string>([...snapshot.keys(), ...current.keys()]);
				for (const id of allIds) {
					const snap = snapshot.get(id);
					const cur = current.get(id);
					if (snap === undefined && cur !== undefined) {
						// Defined inside block only — after block it may not have run
						merged.set(id, {
							valueIds: new Set(cur.valueIds),
							unknown: true,
						});
					} else if (snap !== undefined && cur !== undefined) {
						const equal =
							!snap.unknown &&
							!cur.unknown &&
							setsEqual(snap.valueIds, cur.valueIds);
						if (!equal) {
							const union = new Set<string>([
								...snap.valueIds,
								...cur.valueIds,
							]);
							const unknown = snap.unknown || cur.unknown || isLoop;
							merged.set(id, { valueIds: union, unknown });
						} else if (snap.unknown || cur.unknown) {
							merged.set(id, {
								valueIds: new Set(snap.valueIds),
								unknown: true,
							});
						}
					} else if (
						(snap !== undefined && snap.unknown) ||
						(cur !== undefined && cur.unknown)
					) {
						const base = snap ?? cur;
						if (base !== undefined)
							merged.set(id, {
								valueIds: new Set(base.valueIds),
								unknown: true,
							});
					}
				}
				// Loops make every variable assigned inside unknown after exit,
				// even if the pre/post sets happen to match (e.g. same literal)
				if (isLoop) {
					for (const id of current.keys()) {
						const snap = snapshot.get(id);
						const cur = current.get(id);
						if (cur === undefined) continue;
						if (snap === undefined) {
							const m = merged.get(id);
							if (m !== undefined) m.unknown = true;
						} else if (!setsEqual(snap.valueIds, cur.valueIds)) {
							const m = merged.get(id);
							if (m !== undefined) m.unknown = true;
						}
					}
				}
				current = merged;
			}
		}
	};

	for (const { occ, index } of ordered) {
		processEventsUpTo(occ.start);
		const ev = "e7" as const;
		const base: ExplainSymbolOccurrence = {
			name: occ.name,
			span: { start: occ.start, end: occ.end },
			class: occ.cls === "undefined" ? null : occ.cls,
			role: occ.role as ExplainSymbolOccurrence["role"],
			bindingIds: [...occ.bindingIds],
			sigil: occ.sigil,
			...(occ.note === undefined ? {} : { note: occ.note }),
			ev,
		} as ExplainSymbolOccurrence;

		const vid = defMap.get(index);
		if (vid !== undefined) {
			(base as { valueId?: string }).valueId = vid;
			// Update flow state for this binding
			for (const bid of occ.bindingIds) {
				current.set(bid, { valueIds: new Set([vid]), unknown: false });
			}
		} else if (
			occ.role === "declaration" ||
			occ.role === "binding" ||
			occ.role === "assignment"
		) {
			// Defining occurrence with no literal RHS — introduces unknown
			if (occ.bindingIds.length > 0) {
				for (const bid of occ.bindingIds) {
					current.set(bid, { valueIds: new Set(), unknown: true });
				}
			}
		} else if (occ.role === "reference" || occ.role === "field") {
			if (occ.bindingIds.length > 0) {
				// Union across multiple bindingIds (e.g. :onerror)
				const unionIds = new Set<string>();
				let unknown = false;
				let anyDefined = false;
				for (const bid of occ.bindingIds) {
					const state = current.get(bid);
					if (state !== undefined) {
						anyDefined = true;
						for (const v of state.valueIds) unionIds.add(v);
						if (state.unknown) unknown = true;
					} else {
						// No prior definition for this binding — reaching is unknown
						// (closure or pre-declaration reference)
						unknown = true;
					}
				}
				// For a single binding with no prior assignment yet but a
				// visible declaration later? Q13's lookup already ensures we only
				// query after declaration, so undefined here is truly unknown.
				if (!anyDefined) unknown = true;
				const ids = [...unionIds].sort();
				(
					base as {
						reachingValueIds?: string[];
						reachingUnknown?: boolean;
					}
				).reachingValueIds = ids;
				if (unknown || ids.length > 1) {
					// Mark unknown when set is plural due to branch merge or
					// when a non-literal def contributed. For linear single
					// literal, unknown stays false.
					if (unknown || ids.length > 1) {
						// For branch merges we keep ids but also flag unknown when
						// the merge was conservative. Preserve ids for callers to
						// inspect shapes; unknown says the set may be incomplete.
						// We flag unknown only when the flow state said so or
						// when the definition was unknown (empty set with unknown).
						// For a clean branch of two literals, unknown is false
						// but ids length >1 signals the set.
					}
				}
				(base as { reachingUnknown?: boolean }).reachingUnknown = unknown
					? true
					: undefined;
				// Only emit reachingValueIds when we have a concrete set or unknown;
				// for parameter refs (no bindingIds) we omit.
				// Normalize: keep empty array when unknown with no ids.
				if (ids.length === 0 && !unknown) {
					delete (base as { reachingValueIds?: string[] }).reachingValueIds;
					delete (base as { reachingUnknown?: boolean }).reachingUnknown;
				}
				refReaching.set(index, { valueIds: ids, unknown });
			}
		}
		augmented.push(base);
	}
	// Process trailing block exits after last occurrence
	processEventsUpTo(analyzed.length);

	return augmented;
}
