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
	analyzed: string,
	splits: readonly DocumentVerbSplit[],
): BlockInfo[] {
	const out: BlockInfo[] = [];
	for (const b of scopeBlocks(text)) {
		const start = base + b.start;
		const end = start + b.body.length;
		const bracePos = start - 1;
		const ownerIndex = owningSplitIndex(
			analyzed,
			splits,
			bracePos,
			bracePos + 1,
		);
		const owner = ownerIndex === undefined ? undefined : splits[ownerIndex];
		// If source mapping cannot identify the owning statement, use loop-like
		// merging: an incomplete reaching set is safer than treating an unknown
		// repeated body as a one-shot branch. Otherwise the resolved verb, not a
		// nearby word or string, decides loop semantics.
		const isLoop =
			owner === undefined ||
			(owner.verb !== null &&
				["foreach", "for", "while"].includes(owner.verb.toLowerCase()));
		out.push({ start, end, isLoop });
		out.push(...collectBlocks(b.body, start, analyzed, splits));
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
function owningSplitIndex(
	analyzed: string,
	splits: readonly DocumentVerbSplit[],
	start: number,
	end: number,
): number | undefined {
	let owner: number | undefined;
	let ownerLength = Number.POSITIVE_INFINITY;
	for (let i = 0; i < splits.length; i++) {
		const split = splits[i] as DocumentVerbSplit;
		if (split.span.start > start || end > split.span.end) continue;
		// A widened fallback span cannot prove statement ownership. Match the
		// same addressability gate used by `valuesOf`/`argumentsOf`.
		if (analyzed.slice(split.span.start, split.span.end) !== split.text)
			continue;
		const length = split.span.end - split.span.start;
		if (length < ownerLength) {
			owner = i;
			ownerLength = length;
		}
	}
	return owner;
}

function defValueId(
	occurrence: SymbolOccurrence,
	splitIndex: number | undefined,
	values: readonly ExplainValueOccurrence[],
	valueSplitIndexes: readonly (number | undefined)[],
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

	if (splitIndex === undefined) return undefined;

	let best: ExplainValueOccurrence | undefined;
	let bestDist = Number.POSITIVE_INFINITY;
	for (let i = 0; i < values.length; i++) {
		const value = values[i] as ExplainValueOccurrence;
		// Parent statement spans include their scope bodies. Requiring the
		// innermost addressable statement to match prevents `:local f do={:put
		// 1}` from claiming the body's `1`, and prevents one branch from lending
		// a literal to a non-literal definition in another branch.
		if (valueSplitIndexes[i] !== splitIndex) continue;
		if (value.kind === "element") continue;
		if (value.span.start <= occurrence.start) continue;
		// RouterOS declaration/assignment RHS syntax is positional. Attribute
		// values in the same statement belong to the directive, not this symbol.
		if (value.kind !== "positional") continue;
		const dist = value.span.start - occurrence.end;
		if (dist < 0 || dist >= bestDist) continue;
		bestDist = dist;
		best = value;
	}
	return best?.id;
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
	const symbolSplitIndexes = symbols.map((occ) =>
		owningSplitIndex(analyzed, splits, occ.start, occ.end),
	);
	const valueSplitIndexes = values.map((value) =>
		owningSplitIndex(analyzed, splits, value.span.start, value.span.end),
	);
	const valueOrder = new Map(values.map((value, index) => [value.id, index]));
	// Map from occurrence index -> valueId for quick lookup during flow pass
	const defMap = new Map<number, string>();
	for (let i = 0; i < symbols.length; i++) {
		const occ = symbols[i] as SymbolOccurrence;
		const vid = defValueId(
			occ,
			symbolSplitIndexes[i],
			values,
			valueSplitIndexes,
		);
		if (vid !== undefined) defMap.set(i, vid);
	}

	const blocks = collectBlocks(analyzed, 0, analyzed, splits);
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
				const ids = [...unionIds].sort(
					(a, b) =>
						(valueOrder.get(a) ?? Number.POSITIVE_INFINITY) -
						(valueOrder.get(b) ?? Number.POSITIVE_INFINITY),
				);
				(
					base as {
						reachingValueIds?: string[];
						reachingUnknown?: boolean;
					}
				).reachingValueIds = ids;
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
			}
		}
		augmented.push(base);
	}
	// Process trailing block exits after last occurrence
	processEventsUpTo(analyzed.length);

	return augmented;
}
