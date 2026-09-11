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
import type { SplitOwnerIndex } from "./split-owner.ts";
import { buildSplitOwnerIndex } from "./split-owner.ts";
import type { SymbolOccurrence } from "./symbols.ts";
import type { DocumentVerbSplit } from "./verbsplit.ts";

interface BlockInfo {
	start: number;
	end: number;
	isLoop: boolean;
	branchGroup?: number;
	branchArm?: "do" | "else";
}

/**
 * One binding's reaching literals at a program point.
 *
 * Treated as immutable: a state is replaced, never edited in place, so the same
 * object can sit in the live map and in a journal entry at once. That aliasing
 * is what makes an unchanged binding cost nothing at a block edge (#320).
 */
type BindingState = {
	readonly valueIds: ReadonlySet<string>;
	readonly unknown: boolean;
};

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const v of a) if (!b.has(v)) return false;
	return true;
}

/**
 * Merge one binding across a non-exhaustive block edge: the block may not have
 * run, so the state after it admits both the pre-block value and whatever the
 * block left. A loop body may also have run more than once, which is what makes
 * a changed binding `unknown` even when both ends spell the same literal.
 *
 * Returning `snap` itself when the block did not change the binding is
 * deliberate: it is the case that used to cost a full map copy.
 */
function mergeBlockExit(
	snap: BindingState | undefined,
	current: BindingState,
	isLoop: boolean,
): BindingState {
	// Introduced inside the block: after the block it may never have been set.
	if (snap === undefined)
		return { valueIds: new Set(current.valueIds), unknown: true };
	if (
		!snap.unknown &&
		!current.unknown &&
		setsEqual(snap.valueIds, current.valueIds)
	)
		return snap;
	return {
		valueIds: new Set([...snap.valueIds, ...current.valueIds]),
		unknown: snap.unknown || current.unknown || isLoop,
	};
}

/**
 * Merge one binding across an exhaustive `if`/`else` pair. Exactly one arm runs,
 * so a value seen in both arms stays known and the reaching set is their union;
 * a binding only one arm defines is `unknown` after the merge.
 */
function mergeBranchArms(
	left: BindingState | undefined,
	right: BindingState | undefined,
): BindingState | undefined {
	if (left === undefined || right === undefined) {
		const present = left ?? right;
		if (present === undefined) return undefined;
		return { valueIds: new Set(present.valueIds), unknown: true };
	}
	return {
		valueIds: new Set([...left.valueIds, ...right.valueIds]),
		unknown: left.unknown || right.unknown,
	};
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
	owners: SplitOwnerIndex,
	splits: readonly DocumentVerbSplit[],
): BlockInfo[] {
	const out: BlockInfo[] = [];
	const blocks = scopeBlocks(text).map((block) => {
		const start = base + block.start;
		const bracePos = start - 1;
		const ownerIndex = owners.ownerOf(bracePos, bracePos + 1);
		return {
			block,
			ownerIndex,
			owner: ownerIndex === undefined ? undefined : splits[ownerIndex],
		};
	});
	// Group the siblings once. Re-filtering `blocks` inside a loop over
	// `blocks` is the same quadratic shape #317 removed from the owner lookup,
	// and a `do={…}`-heavy document grows both factors together.
	const byOwner = new Map<number, typeof blocks>();
	for (const entry of blocks) {
		if (entry.ownerIndex === undefined) continue;
		const list = byOwner.get(entry.ownerIndex);
		if (list === undefined) byOwner.set(entry.ownerIndex, [entry]);
		else list.push(entry);
	}
	const exhaustiveGroups = new Set<number>();
	// One pass per owner, not per block: every sibling of an `if` reaches the
	// same verdict, so asking each of them re-runs both filters over the whole
	// group. Siblings share an owner index, so they share the owner itself.
	for (const [ownerIndex, siblings] of byOwner) {
		if (siblings[0]?.owner?.verb?.toLowerCase() !== "if") continue;
		const doBlocks = siblings.filter(
			(other) => other.block.name.toLowerCase() === "do",
		);
		const elseBlocks = siblings.filter(
			(other) => other.block.name.toLowerCase() === "else",
		);
		if (
			doBlocks.length === 1 &&
			elseBlocks.length === 1 &&
			(doBlocks[0]?.block.start ?? Number.POSITIVE_INFINITY) <
				(elseBlocks[0]?.block.start ?? Number.NEGATIVE_INFINITY)
		)
			exhaustiveGroups.add(ownerIndex);
	}

	for (const { block: b, ownerIndex, owner } of blocks) {
		const start = base + b.start;
		const end = start + b.body.length;
		// If source mapping cannot identify the owning statement, use loop-like
		// merging: an incomplete reaching set is safer than treating an unknown
		// repeated body as a one-shot branch. Otherwise the resolved verb, not a
		// nearby word or string, decides loop semantics.
		const isLoop =
			owner === undefined ||
			(owner.verb !== null &&
				["foreach", "for", "while"].includes(owner.verb.toLowerCase()));
		const arm = b.name.toLowerCase();
		const branchArm = arm === "do" || arm === "else" ? arm : undefined;
		out.push({
			start,
			end,
			isLoop,
			...(ownerIndex !== undefined &&
			exhaustiveGroups.has(ownerIndex) &&
			branchArm !== undefined
				? { branchGroup: ownerIndex, branchArm }
				: {}),
		});
		out.push(...collectBlocks(b.body, start, owners, splits));
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
	splitIndex: number | undefined,
	values: readonly ExplainValueOccurrence[],
	positionalValuesBySplit: ReadonlyMap<number, readonly number[]>,
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
	// Parent statement spans include their scope bodies. Requiring the
	// innermost addressable statement to match prevents `:local f do={:put 1}`
	// from claiming the body's `1`, and prevents one branch from lending a
	// literal to a non-literal definition in another branch. That same
	// requirement is what lets the candidates be bucketed per statement once
	// instead of re-scanned per symbol (#317).
	for (const i of positionalValuesBySplit.get(splitIndex) ?? []) {
		const value = values[i] as ExplainValueOccurrence;
		if (value.span.start <= occurrence.start) continue;
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
	const owners = buildSplitOwnerIndex(analyzed, splits);
	const symbolSplitIndexes = symbols.map((occ) =>
		owners.ownerOf(occ.start, occ.end),
	);
	// RouterOS declaration/assignment RHS syntax is positional, so an attribute
	// value in the same statement belongs to the directive, not to the symbol —
	// `:foreach i in={…}` must not link `i` to the `in` attribute. Bucketing
	// only the positional values keeps `defValueId`'s search inside the one
	// statement that can supply the RHS.
	const positionalValuesBySplit = new Map<number, number[]>();
	for (let i = 0; i < values.length; i++) {
		const value = values[i] as ExplainValueOccurrence;
		if (value.kind !== "positional") continue;
		const splitIndex = owners.ownerOf(value.span.start, value.span.end);
		if (splitIndex === undefined) continue;
		const list = positionalValuesBySplit.get(splitIndex);
		if (list === undefined) positionalValuesBySplit.set(splitIndex, [i]);
		else list.push(i);
	}
	const valueOrder = new Map(values.map((value, index) => [value.id, index]));
	// Map from occurrence index -> valueId for quick lookup during flow pass
	const defMap = new Map<number, string>();
	for (let i = 0; i < symbols.length; i++) {
		const occ = symbols[i] as SymbolOccurrence;
		const vid = defValueId(
			occ,
			symbolSplitIndexes[i],
			values,
			positionalValuesBySplit,
		);
		if (vid !== undefined) defMap.set(i, vid);
	}

	const blocks = collectBlocks(analyzed, 0, owners, splits);
	type FlowEvent =
		| {
				offset: number;
				type: "enter" | "exit";
				isLoop: boolean;
				branchGroup?: number;
				branchArm?: "do" | "else";
		  }
		| { offset: number; type: "unknown-definition"; bindingIds: string[] };
	const events: FlowEvent[] = [];
	for (const b of blocks) {
		const branch =
			b.branchGroup === undefined || b.branchArm === undefined
				? {}
				: { branchGroup: b.branchGroup, branchArm: b.branchArm };
		events.push({
			offset: b.start,
			type: "enter",
			isLoop: b.isLoop,
			...branch,
		});
		events.push({
			offset: b.end,
			type: "exit",
			isLoop: b.isLoop,
			...branch,
		});
	}
	const deferredDefinitions = new Set<number>();
	for (let i = 0; i < symbols.length; i++) {
		const occ = symbols[i] as SymbolOccurrence;
		if (defMap.has(i) || occ.bindingIds.length === 0) continue;
		if (
			occ.role !== "declaration" &&
			occ.role !== "binding" &&
			occ.role !== "assignment"
		)
			continue;
		const splitIndex = symbolSplitIndexes[i];
		if (splitIndex === undefined) continue;
		deferredDefinitions.add(i);
		events.push({
			offset: (splits[splitIndex] as DocumentVerbSplit).span.end,
			type: "unknown-definition",
			bindingIds: [...occ.bindingIds],
		});
	}
	events.sort((a, b) => {
		if (a.offset !== b.offset) return a.offset - b.offset;
		// Enter the block first, then apply a statement-final definition, then
		// exit/merge the block. This keeps a definition ending at a block edge
		// inside that block's final state.
		const priority = { enter: 0, "unknown-definition": 1, exit: 2 } as const;
		return priority[a.type] - priority[b.type];
	});

	// Occurrences are already sorted by start
	const ordered = symbols.map((occ, index) => ({ occ, index }));
	// Flow state.
	//
	// One live map, plus a journal per open block recording the pre-block value
	// of every binding that block writes. A block edge then costs what the block
	// CHANGED, not what the document declares (#320): snapshotting the whole map
	// at every enter and rebuilding it at every exit made a branch-dense script
	// quadratic — 3.1 M binding copies on 89 KiB — because blocks and bindings
	// both grow with the document.
	const current = new Map<string, BindingState>();
	type Frame = {
		/** binding id -> its value when this block was entered (absent = new). */
		journal: Map<string, BindingState | undefined>;
		isLoop: boolean;
		branchGroup?: number;
		branchArm?: "do" | "else";
	};
	const stack: Frame[] = [];
	/** Per exhaustive `if` group: the `do` arm's pre/post pair per touched id. */
	const branchGroups = new Map<
		number,
		Map<string, { snap: BindingState | undefined; doFinal: BindingState }>
	>();
	/** Record a binding's pre-block value once per frame; later writes keep it. */
	const note = (
		frame: Frame | undefined,
		id: string,
		before: BindingState | undefined,
	): void => {
		if (frame !== undefined && !frame.journal.has(id))
			frame.journal.set(id, before);
	};
	const setBinding = (id: string, state: BindingState): void => {
		note(stack[stack.length - 1], id, current.get(id));
		current.set(id, state);
	};
	/** Write a merged/rewound value for a binding the enclosing frame now owns. */
	const applyToParent = (
		id: string,
		before: BindingState | undefined,
		after: BindingState | undefined,
	): void => {
		note(stack[stack.length - 1], id, before);
		if (after === undefined) current.delete(id);
		else current.set(id, after);
	};
	let eventIdx = 0;
	const processEventsUpTo = (pos: number): void => {
		while (eventIdx < events.length) {
			const ev = events[eventIdx] as FlowEvent;
			if (ev.offset > pos) break;
			eventIdx++;
			if (ev.type === "unknown-definition") {
				for (const bid of ev.bindingIds)
					setBinding(bid, { valueIds: new Set(), unknown: true });
				continue;
			}
			if (ev.type === "enter") {
				stack.push({
					journal: new Map(),
					isLoop: ev.isLoop,
					...(ev.branchGroup === undefined || ev.branchArm === undefined
						? {}
						: { branchGroup: ev.branchGroup, branchArm: ev.branchArm }),
				});
				continue;
			}
			const top = stack.pop();
			if (top === undefined) continue;
			// A binding the block never wrote has the same state on both sides of
			// the edge, and every merge rule below maps that pair back to itself.
			// So the journal — the bindings the block DID write — is the whole
			// edge, whatever else the document has declared.
			if (top.branchGroup !== undefined && top.branchArm === "do") {
				const arm = new Map<
					string,
					{ snap: BindingState | undefined; doFinal: BindingState }
				>();
				for (const [id, snap] of top.journal) {
					arm.set(id, { snap, doFinal: current.get(id) as BindingState });
					// Rewind: the `else` arm starts from the state before the `if`.
					if (snap === undefined) current.delete(id);
					else current.set(id, snap);
				}
				branchGroups.set(top.branchGroup, arm);
				continue;
			}
			if (top.branchGroup !== undefined && top.branchArm === "else") {
				const arm = branchGroups.get(top.branchGroup);
				if (arm !== undefined) {
					const touched = new Set<string>([
						...arm.keys(),
						...top.journal.keys(),
					]);
					for (const id of touched) {
						const recorded = arm.get(id);
						// Untouched by one arm means that arm left the pre-`if` value.
						const before =
							recorded === undefined ? top.journal.get(id) : recorded.snap;
						const left = recorded === undefined ? before : recorded.doFinal;
						applyToParent(id, before, mergeBranchArms(left, current.get(id)));
					}
					branchGroups.delete(top.branchGroup);
					continue;
				}
			}
			for (const [id, snap] of top.journal)
				applyToParent(
					id,
					snap,
					mergeBlockExit(snap, current.get(id) as BindingState, top.isLoop),
				);
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
				setBinding(bid, { valueIds: new Set([vid]), unknown: false });
			}
		} else if (
			occ.role === "declaration" ||
			occ.role === "binding" ||
			occ.role === "assignment"
		) {
			// Defining occurrence with no literal RHS — introduces unknown
			if (occ.bindingIds.length > 0 && !deferredDefinitions.has(index)) {
				for (const bid of occ.bindingIds) {
					setBinding(bid, { valueIds: new Set(), unknown: true });
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
