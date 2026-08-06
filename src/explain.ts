/**
 * `explain` — the offline analysis, composed.
 *
 * Phase 0.5 promoted nine ratified analyzers into `src/explain/` with **no
 * caller**: segment, blocks, coordinates, pathresolve, verbsplit, write,
 * symbols, plus the internal menus/verbs tables. Each answers one lab question
 * and none of them knows the others exist. This module is the composition
 * (#202): one pass over one input producing the result shape
 * `commands/explain/README.md` → *Result shape* specifies, so a caller sequences
 * nothing and every fact carries its provenance.
 *
 * ## The two verdicts are different questions
 *
 *   `data.verdict` (`pass`/`warn`/`fail`) is the maximum DIAGNOSTIC SEVERITY. It
 *   exists to drive `--fail-on` and nothing else.
 *   `structure.statements[].resolution` (`resolved`/`ambiguous`/`unknown`) is
 *   what the CANONICALIZER decided about one statement.
 *
 *   They are deliberately not collapsed: a document can be perfectly well-formed
 *   (`verdict: "pass"`) and still be unreadable offline (`/system/reboot` is
 *   `ambiguous` — a menu and a no-argument command are the same text without a
 *   schema), and a document riddled with defects still returns `ok: true`
 *   because the diagnostics ARE the data.
 *
 * ## What the gate is, and what it is not
 *
 *   `data.canonical` reproduces `canonicalizeExecuteCommand` field for field.
 *   That function is centrs's script-vs-structured EXECUTION gate and widening
 *   it is a product regression (`docs/CONSTITUTION.md`); the richer analysis
 *   sits BESIDE it and never feeds back into it. Two consequences a reader will
 *   otherwise trip on:
 *
 *   - The gate wants the verb IN the path. `/ip/route/add dst-address=…` is
 *     `structured`; the CLI spelling `/ip/route add dst-address=…` is `script`,
 *     because `add` is a bare token with no `=`. `structure.statements[]` reads
 *     BOTH as `/ip/route` + `add`, and that disagreement is not a bug — the gate
 *     is answering "may this be sent as a structured REST call", the analysis is
 *     answering "what did the human write".
 *   - The gate reads a bare `/ip/route` as path `/ip` + verb `route`, while the
 *     analysis reads it as menu navigation (the #207 table confirms it). Again
 *     two different questions over the same bytes.
 *
 * ## Declared gaps (phase 1 offline)
 *
 *   - **No per-statement argument list.** `structure.statements[].command`
 *     carries `path` and `verb` only. Splitting a statement's arguments needs a
 *     lexer that handles quoted values, `[…]` selectors and `?` queries at
 *     statement scope — new lexical work that gets the #201 probe-matrix
 *     treatment when `--curl` needs it (#202c), not a split on spaces here.
 *     `canonical.args` is the whole-input structured case and is exact.
 *   - **No transport classification.** `api-candidate`/`execute`/`unknown` and
 *     `--curl` are #202c. The field is absent rather than defaulted, so nothing
 *     reads as decided that was never decided.
 *   - **`spans` covers what offline can PROVE**: comment runs and resolved
 *     variable occurrences (Q13 scored 100% precision on resolved bindings, and
 *     abstentions are omitted rather than guessed). The full Q12 vocabulary over
 *     path/verb/argument bytes needs device `highlight` as its oracle and is
 *     phase 2. A subset is not a claim that the vocabulary is closed.
 *   - **No value TYPE, and highlight will not supply one.** RouterOS types
 *     values at parse time and its highlighter classes every value byte `none`,
 *     so the value axis has a different oracle (`:parse`/IL and `:typeof`) and
 *     three facts that must not collapse into one field: a lexical SHAPE hint
 *     (non-authoritative, possibly several, because shapes overlap — `2.2` is
 *     number-shaped and ip-completable), the type OBSERVED from a live reading,
 *     and the argument's SCHEMA type. Each needs its own provenance. The
 *     decision and the probe matrix are #202's value-shape section; this module
 *     is deliberately type-blind, which is why a verdict that looks wrong around
 *     a value is a type-axis question before it is a lexical one.
 *   - **`runtimeAcceptance` is always `"not-proven"`**, offline and live alike.
 *     It is the inspect-vs-runtime gap made machine-readable, not a placeholder.
 */

import type {
	CentrsErrorEnvelope,
	CentrsSuccessEnvelope,
	CommonSettingsMeta,
	EnvelopeMeta,
} from "./core/envelope.ts";
import { buildTip, type Tip, type Warning } from "./core/envelope.ts";
import { CentrsError, serializeCentrsError } from "./errors.ts";
import {
	type CanonicalExecuteCommand,
	canonicalizeExecuteCommand,
	isWriteShaped,
} from "./execute.ts";
import { scopeBlocks } from "./explain/blocks.ts";
import {
	analyzeCoordinates,
	type CoordinateAnalysis,
} from "./explain/coordinates.ts";
import {
	type Defect,
	type DefectCode,
	isPositionalFact,
} from "./explain/defects.ts";
import { type Resolution, resolveDocument } from "./explain/pathresolve.ts";
import { segmentStatements } from "./explain/segment.ts";
import { resolveSymbols } from "./explain/symbols.ts";
import {
	type DocumentVerbSplit,
	resolveVerb,
	resolveVerbs,
	type VerbSplit,
} from "./explain/verbsplit.ts";
import { containsWrite, type WriteVerdict } from "./explain/write.ts";
import {
	type ResolvedSetting,
	resolveStringSetting,
	toCoreSource,
} from "./resolver/settings.ts";
import { toYaml } from "./retrieve.ts";

/** A half-open analyzed-byte span, the coordinate contract of `coordinates.ts`. */
export interface ExplainSpanRange {
	start: number;
	end: number;
}

/**
 * One run of the analyzed input mapped back to the original.
 *
 * Identity runs are retained (the spec's requirement) so a consumer needs no
 * second coordinate contract for un-normalized input. A run is coalesced only
 * while the mapping inside it is 1 byte : 1 UTF-16 unit; every non-ASCII code
 * point gets its own entry, because the mapping across a 4-byte/2-unit
 * character is not linear and a coalesced run could not be indexed into.
 */
export interface ExplainPositionMapEntry {
	analyzed: ExplainSpanRange;
	originalUtf16: ExplainSpanRange;
}

export interface ExplainInput {
	/** Length of the analyzed surface, in bytes. Equals the UTF-8 byte length. */
	bytes: number;
	/** True when normalization stood in for at least one non-ASCII byte. */
	normalized: boolean;
	/**
	 * Whether the ANALYZED INPUT was cut short. Always `false` in phase 1: there
	 * is no input size cap yet. It is not the `--full` smart-sizing flag, which
	 * bounds the RESULT.
	 */
	truncated: boolean;
	positionMap: ExplainPositionMapEntry[];
}

/** Maximum diagnostic severity. Drives `--fail-on`; nothing else. */
export type ExplainVerdict = "pass" | "warn" | "fail";

/** The whole-input execute gate, reproduced. */
export interface ExplainCanonical {
	mode: CanonicalExecuteCommand["mode"];
	path: string;
	verb: string;
	/** `CanonicalExecuteCommand.attributes` under the ratified envelope name. */
	args: Record<string, string>;
	queries: string[];
	/** `isWriteShaped(canonical)` — the write-confirmation predicate, verbatim. */
	writeShaped: boolean;
}

/** What the canonicalizer decided about one statement. */
export type ExplainResolution = "resolved" | "ambiguous" | "unknown";

/**
 * A resolved menu. Navigation names a menu and nothing else, so there is no
 * verb — not an absent one.
 */
export interface ExplainMenuReading {
	resolution: "resolved";
	kind: "menu";
	command: { path: string };
	unresolved?: undefined;
}

/** A resolved command: a path AND the verb that was decided on it. */
export interface ExplainCommandReading {
	resolution: "resolved";
	kind: "command";
	command: { path: string; verb: string };
	unresolved?: undefined;
}

/** A refusal. It carries its reason and nothing that would read as a reading. */
export interface ExplainRefusal {
	resolution: "ambiguous" | "unknown";
	kind?: undefined;
	command?: undefined;
	/** Why the analyzer refused. */
	unresolved: string;
}

/**
 * What the analyzer read, as a discriminated union.
 *
 * `verbsplit` reports menu navigation as its own `navigation` resolution so
 * that `resolved` keeps meaning "a verb was decided" for its callers; the
 * envelope folds the two into `resolved` + `kind`, which is the ratified
 * vocabulary. The union rather than four independent optionals, because these
 * fields co-vary and the intended consumers (LSP, MCP) narrow on them:
 * `resolution === "resolved"` must yield a `command`, and `kind === "command"`
 * must yield a `verb`, at compile time. Independently optional fields also
 * describe three shapes that cannot occur — a resolved statement with no
 * command, a menu with a verb, a refusal with a command.
 *
 * Every variant declares the other variants' discriminants as `?: undefined`,
 * so `s.kind` and `s.command` stay readable without narrowing first.
 */
export type ExplainReading =
	| ExplainMenuReading
	| ExplainCommandReading
	| ExplainRefusal;

/** Where a statement is, and how much the analyzer knew when it read it. */
export interface ExplainStatementFacts {
	span: ExplainSpanRange;
	/**
	 * Was the menu context in force BEFORE this statement known? A `false` here
	 * does not invalidate a `resolved` reading — the resolver already degrades
	 * every context-DEPENDENT statement when context is lost, so a statement that
	 * still resolved did not consume it (#192, #197).
	 */
	contextCertain: boolean;
	ev: string;
}

export type ExplainStatement = ExplainStatementFacts & ExplainReading;

/**
 * A `[…]` command substitution, re-constituted against its enclosing menu.
 *
 * Same vocabulary as {@link ExplainStatement}, deliberately: an inner command is
 * a command, and a caller should not have to learn a second shape to read one.
 *
 * That means the verb boundary here is Q6's answer (`resolveVerb` over the
 * bracket's inner text), not Q3's `Resolution.path`. The two are not always the
 * same — Q3's `path` is documented as the greedy leading run, its "best guess",
 * and it reads `[/system/identity/get name]` as the menu
 * `/system/identity/get` where Q6 reads menu `/system/identity` + verb `get`.
 * Q6 is the module that decides verbs (and #211's R9 exists precisely so these
 * two stop contradicting each other), so it is what the envelope presents; Q3's
 * alternative readings survive as {@link candidates}. Where Q3 REFUSED, this
 * refuses too, whatever Q6 says — the fail-closed floor is not up for a second
 * opinion.
 */
export interface ExplainSubcommandFacts extends ExplainStatementFacts {
	/** Menu context in force at the bracket, `/` at document root. */
	context: string;
	/** Every path the inner command could resolve to, shortest first. */
	candidates: string[];
	/** Bracket nesting depth; 0 is directly inside a statement. */
	depth: number;
}

export type ExplainSubcommand = ExplainSubcommandFacts & ExplainReading;

/** A `{…}` scope at document level. */
export interface ExplainBlock {
	/** The argument or directive that opened it (`do`, `on-error`, …). */
	name: string;
	/** The BODY's span, braces excluded. */
	span: ExplainSpanRange;
	ev: string;
}

export interface ExplainStructure {
	/**
	 * `statements.length`, which counts BLOCK-BODY statements too — see
	 * {@link ExplainStructure.statements}. Not the number of top-level statements.
	 */
	statementCount: number;
	/**
	 * Every statement the analyzer read, in discovery order.
	 *
	 * A `do={…}` body's statements are flattened in after their parent (which is
	 * what RouterOS IL does to them), so a body statement's span is CONTAINED by
	 * its parent's rather than following it, and spans may overlap. A consumer
	 * that wants only the top level filters on containment; one that wants "every
	 * command in this script" — the common case, and the reason to flatten — reads
	 * the list as it stands.
	 */
	statements: ExplainStatement[];
	blocks: ExplainBlock[];
	/**
	 * The Q16 tristate. `"unknown"` is a real value, not a missing one: a
	 * write-shaped command outside the small version-stable write table
	 * (`/disk format-drive`) must never report `false`.
	 */
	containsWrite: boolean | "unknown";
	subcommands: ExplainSubcommand[];
	ev: string;
}

/**
 * A classified byte run.
 *
 * The vocabulary is centrs-owned (the ratified decision): consumers depend on
 * it rather than on raw RouterOS `highlight` classes, so cross-version drift in
 * those classes is centrs's problem to absorb. For these five the two names
 * currently coincide, which is a convenience, not the contract.
 */
export type ExplainSpanClass =
	| "comment"
	| "variable-local"
	| "variable-global"
	| "variable-auto"
	| "variable-parameter";

export interface ExplainSpan extends ExplainSpanRange {
	class: ExplainSpanClass;
	ev: string;
}

export type ExplainSeverity = "error" | "warning" | "info";

export interface ExplainDiagnostic {
	/** Slash-namespaced `explain/<source>/<slug>`. */
	code: string;
	severity: ExplainSeverity;
	message: string;
	span: ExplainSpanRange;
	ev: string;
}

/**
 * Where a derived fact came from — the OFFLINE SUBSET of the contract.
 *
 * The spec's evidence entry also carries `source: "live-inspect"` and a
 * RouterOS version stamp per probe, neither of which phase 1 can produce: no
 * probe runs and there is no device to stamp. The type says only what offline
 * emits rather than pre-declaring variants with no producer, so a consumer
 * cannot narrow on a `source` that never appears; phase 2 widens the union and
 * adds the stamp, which is an ADDITION to the shape a caller reads today.
 */
export interface ExplainEvidence {
	id: string;
	source: "canonicalizer";
	/** The analyzer that produced the facts citing this entry. */
	probe: string;
	/**
	 * `direct` — a deterministic reading of the bytes (the gate, the coordinate
	 * pass). `heuristic` — a ratified offline rule that a live probe could
	 * overturn (path resolution, the verb boundary, the write tristate, symbol
	 * classes). No offline fact is `derived`, which is reserved for a conclusion
	 * drawn from live responses.
	 */
	basis: "direct" | "heuristic" | "derived";
	outcome: "ok" | "empty" | "timeout" | "transport-error";
}

export interface ExplainData {
	input: ExplainInput;
	verdict: ExplainVerdict;
	canonical: ExplainCanonical;
	structure: ExplainStructure;
	spans: ExplainSpan[];
	diagnostics: ExplainDiagnostic[];
	evidence: ExplainEvidence[];
	/**
	 * Always `"not-proven"`. `/console/inspect` accepts forms the runtime
	 * rejects, so no amount of offline or probe evidence proves acceptance.
	 */
	runtimeAcceptance: "not-proven";
}

export interface ExplainOperationMeta {
	command: "explain";
	/** `offline` is the only mode phase 1 has; live evidence is phase 2. */
	mode: "offline";
	statementCount: number;
	verdict: ExplainVerdict;
}

export type ExplainEnvelope = CentrsSuccessEnvelope<
	ExplainData,
	ExplainOperationMeta
>;

/**
 * Stable evidence ids, one per analysis PASS.
 *
 * A pass is the finest distinction that is REAL offline: every fact a pass
 * produces has the same provenance, and a per-fact id would imply a granularity
 * the analyzers do not have. But it has to be the pass that actually produced
 * the fact — `statements` and `subcommands` are separate entries because they
 * come from different walks, and a defect is tagged where it is RAISED (below),
 * not with whichever analyzer happens to be merged first.
 */
const EV = {
	canonical: "e0",
	coordinates: "e1",
	segment: "e2",
	blocks: "e3",
	statements: "e4",
	subcommands: "e5",
	write: "e6",
	symbols: "e7",
} as const;

type EvidenceKey = keyof typeof EV;

const EVIDENCE: Record<EvidenceKey, ExplainEvidence> = {
	canonical: {
		id: EV.canonical,
		source: "canonicalizer",
		probe: "canonicalizeExecuteCommand",
		basis: "direct",
		outcome: "ok",
	},
	coordinates: {
		id: EV.coordinates,
		source: "canonicalizer",
		probe: "analyzeCoordinates",
		basis: "direct",
		outcome: "ok",
	},
	segment: {
		id: EV.segment,
		source: "canonicalizer",
		probe: "segmentStatements",
		basis: "direct",
		outcome: "ok",
	},
	blocks: {
		id: EV.blocks,
		source: "canonicalizer",
		probe: "scopeBlocks",
		basis: "direct",
		outcome: "ok",
	},
	statements: {
		id: EV.statements,
		source: "canonicalizer",
		probe: "resolveVerbs",
		basis: "heuristic",
		outcome: "ok",
	},
	subcommands: {
		id: EV.subcommands,
		source: "canonicalizer",
		probe: "resolveDocument + resolveVerb",
		basis: "heuristic",
		outcome: "ok",
	},
	write: {
		id: EV.write,
		source: "canonicalizer",
		probe: "containsWrite",
		basis: "heuristic",
		outcome: "ok",
	},
	symbols: {
		id: EV.symbols,
		source: "canonicalizer",
		probe: "resolveSymbols",
		basis: "heuristic",
		outcome: "ok",
	},
};

/** Diagnostic rendering for each defect class. */
const DEFECT_DIAGNOSTICS: Record<
	DefectCode,
	{ severity: ExplainSeverity; message: (d: Defect) => string }
> = {
	unclosed: {
		severity: "error",
		message: (d) => `unclosed \`${d.detail ?? "delimiter"}\` — never closed`,
	},
	"unbalanced-close": {
		severity: "error",
		message: (d) => `stray \`${d.detail ?? "close"}\` closes nothing`,
	},
	"unterminated-string": {
		severity: "error",
		message: () => "unterminated string — no closing quote",
	},
	"bad-escape": {
		severity: "error",
		message: () =>
			"invalid escape: a backslash in code is valid only before whitespace",
	},
	"bad-sigil": {
		severity: "error",
		message: () => "invalid sigil: the run must be zero or one character",
	},
	// centrs's own resource bound, not a RouterOS rule. The input may be entirely
	// legal; what is reported is that the analyzer stopped descending, so the
	// honest severity is a warning about incomplete analysis.
	"over-depth": {
		severity: "warning",
		message: () => "nesting past the analyzer's depth bound — not descended",
	},
	// Positional facts. `isPositionalFact` exists so these can never be given
	// error severity: `name="router-🚀"` is a legal command and non-ASCII occurs
	// in ~12% of the phase-0 corpus.
	bom: {
		severity: "info",
		message: () => "byte-order mark",
	},
	"non-ascii": {
		severity: "info",
		message: () => "non-ASCII bytes, normalized one-for-one for analysis",
	},
};

/** A defect plus the analysis pass that raised it. */
interface AttributedDefect {
	defect: Defect;
	ev: string;
}

/**
 * De-duplicate the analyzers' defect lists, keeping each region's FIRST
 * attribution.
 *
 * `mergeDefects` answers "which regions are defective"; this also answers "who
 * said so", which the evidence table needs and cannot recover afterwards — once
 * the lists are concatenated a `bad-sigil` is indistinguishable from an
 * `unclosed`, and guessing by class is wrong for the three classes two analyzers
 * both raise.
 *
 * FIRST wins rather than "all who saw it", because a fact carries ONE `ev`. The
 * order is the argument order, and the coordinate pass is not in it at all: its
 * two classes are raised inside `segmentStatements`' result, so they are
 * re-tagged here by class — they are readings of the input as received, not of
 * any structural walk.
 *
 * Identity matches `mergeDefects`: the whole region plus `detail`, never the
 * code alone, so two `over-depth` events at different offsets stay two defects.
 */
function attributeDefects(
	sources: readonly (readonly [string, readonly Defect[]])[],
): AttributedDefect[] {
	const seen = new Map<string, AttributedDefect>();
	for (const [ev, list] of sources)
		for (const defect of list) {
			const key = JSON.stringify([
				defect.code,
				defect.start,
				defect.end,
				defect.detail,
			]);
			if (seen.has(key)) continue;
			seen.set(key, {
				defect,
				ev: isPositionalFact(defect.code) ? EV.coordinates : ev,
			});
		}
	return [...seen.values()].sort(
		(a, b) =>
			a.defect.start - b.defect.start ||
			a.defect.end - b.defect.end ||
			a.defect.code.localeCompare(b.defect.code),
	);
}

/** Build `input.positionMap`: coalesced identity runs, one entry per non-ASCII code point. */
function positionMap(a: CoordinateAnalysis): ExplainPositionMapEntry[] {
	const out: ExplainPositionMapEntry[] = [];
	let run: ExplainPositionMapEntry | null = null;
	for (const r of a.runs) {
		const identity = r.ascii;
		if (
			identity &&
			run !== null &&
			run.analyzed.end === r.byteStart &&
			run.originalUtf16.end === r.utf16Start
		) {
			run.analyzed.end = r.byteStart + r.byteLen;
			run.originalUtf16.end = r.utf16Start + r.utf16Len;
			continue;
		}
		run = {
			analyzed: { start: r.byteStart, end: r.byteStart + r.byteLen },
			originalUtf16: { start: r.utf16Start, end: r.utf16Start + r.utf16Len },
		};
		out.push(run);
		if (!identity) run = null;
	}
	return out;
}

const SPAN_CLASS_OF_SYMBOL: Record<string, ExplainSpanClass> = {
	local: "variable-local",
	global: "variable-global",
	auto: "variable-auto",
	parameter: "variable-parameter",
};

function severityRank(s: ExplainSeverity): number {
	return s === "error" ? 2 : s === "warning" ? 1 : 0;
}

function verdictOf(diagnostics: readonly ExplainDiagnostic[]): ExplainVerdict {
	let worst = 0;
	for (const d of diagnostics)
		worst = Math.max(worst, severityRank(d.severity));
	return worst === 2 ? "fail" : worst === 1 ? "warn" : "pass";
}

/**
 * Analyze one RouterOS input offline. Never throws, never contacts a device.
 *
 * Deliberately takes no options: the only ones the spec describes
 * (`--complete`, `--schema`, a resolved target) are live evidence, and an
 * options bag that accepts nothing today would invite callers to pass something
 * that is silently ignored. A second parameter is a non-breaking addition when
 * phase 2 has something to put in it.
 */
export function explainCommand(input: string): ExplainData {
	const coordinates = analyzeCoordinates(input);
	const segmented = segmentStatements(input);
	const verbs = resolveVerbs(input);
	const brackets = resolveDocument(input);
	const write = containsWrite(input);
	const symbols = resolveSymbols(input);

	// Every analyzer re-derives the document's defects from its own walk, so a
	// defect two analyzers both see must be reported once — and tagged with the
	// analyzer that RAISED it, not with whichever list was merged first. The
	// classes do not partition: `unclosed`/`unbalanced-close`/`unterminated-string`
	// come from the segmenter AND the symbol scan, while `bad-escape`/`bad-sigil`
	// are the symbol scan alone (they are lexical rules, hence `heuristic`, where
	// the segmenter's delimiter stack is a `direct` reading). Attributing all of
	// them to the segmenter said "direct/segmentStatements" about a fact the
	// segmenter cannot produce.
	const defects = attributeDefects([
		[EV.segment, segmented.defects],
		[EV.statements, verbs.defects],
		[EV.subcommands, brackets.defects],
		[EV.write, write.defects],
		[EV.symbols, symbols.defects],
	]);

	// From the SPLITS, not from the segmentation. The resolver flattens `do={…}`
	// bodies in after their parent, so its list is longer than the top-level
	// segments and pairing the two by index attaches the wrong span to every statement after
	// the first block. Each split carries its own document-space span.
	const statements: ExplainStatement[] = verbs.splits.map(statementOf);

	const diagnostics: ExplainDiagnostic[] = [
		...defects.map(({ defect: d, ev }) => {
			const render = DEFECT_DIAGNOSTICS[d.code];
			return {
				code: `explain/canonicalizer/${d.code}`,
				severity: render.severity,
				message: render.message(d),
				span: { start: d.start, end: d.end },
				ev,
			};
		}),
		...statements.flatMap((s) => diagnosticsForStatement(s)),
	].sort(
		(a, b) =>
			a.span.start - b.span.start ||
			severityRank(b.severity) - severityRank(a.severity),
	);

	const spans: ExplainSpan[] = [
		...segmented.comments.map((c) => ({
			start: c.start,
			end: c.end,
			class: "comment" as const,
			ev: EV.segment,
		})),
		...symbols.occurrences.flatMap((o) => {
			const cls = o.cls === null ? undefined : SPAN_CLASS_OF_SYMBOL[o.cls];
			// An abstention (`cls: null`) and the device-only `undefined` class are
			// omitted rather than rendered as a guess.
			return cls === undefined
				? []
				: [{ start: o.start, end: o.end, class: cls, ev: EV.symbols }];
		}),
	].sort((a, b) => a.start - b.start || a.end - b.end);

	const canonical = canonicalizeExecuteCommand(input);
	const structure: ExplainStructure = {
		statementCount: statements.length,
		statements,
		blocks: scopeBlocks(input).map((b) => ({
			name: b.name,
			span: { start: b.start, end: b.start + b.body.length },
			ev: EV.blocks,
		})),
		containsWrite: renderWriteVerdict(write.verdict),
		subcommands: brackets.resolutions.map(subcommandOf),
		// `containsWrite` is the fact `structure` itself asserts; the statements
		// and subcommands beside it carry their own.
		ev: EV.write,
	};

	return {
		input: {
			bytes: coordinates.analyzed.length,
			normalized: coordinates.runs.some((r) => !r.ascii),
			truncated: false,
			positionMap: positionMap(coordinates),
		},
		verdict: verdictOf(diagnostics),
		canonical: {
			mode: canonical.mode,
			path: canonical.path,
			verb: canonical.verb,
			args: canonical.attributes,
			queries: canonical.queries,
			writeShaped: isWriteShaped(canonical),
		},
		structure,
		spans,
		diagnostics,
		evidence: citedEvidence(structure, diagnostics, spans),
		runtimeAcceptance: "not-proven",
	};
}

/**
 * One statement, in the envelope's vocabulary.
 *
 * The fold that happens here: `verbsplit` reports menu navigation as its own
 * `navigation` resolution, because for ITS callers `resolved` has to keep
 * meaning "a verb was decided". The envelope's ratified vocabulary is
 * `resolved` + `kind`, and the mapping is total — `navigation` → menu,
 * `resolved` → command, and the two refusals carry no kind at all.
 *
 * The span comes from the split itself, because the resolver FLATTENS block
 * bodies into its statement list — a body statement's span is contained by its
 * parent's rather than following it, and the list is longer than the top-level
 * segmentation. That is why `statements[]` may overlap, and why the count is not
 * the number of top-level statements.
 */
function statementOf(split: DocumentVerbSplit): ExplainStatement {
	return {
		span: { start: split.span.start, end: split.span.end },
		...readingOf(split),
		contextCertain: split.contextCertain,
		ev: EV.statements,
	};
}

/** One `[…]` substitution in the envelope's vocabulary. See {@link ExplainSubcommand}. */
function subcommandOf(r: Resolution): ExplainSubcommand {
	// Q3 refused: the bracket is unreadable and Q6's reading of the same text
	// cannot promote it.
	const reading =
		r.unresolved !== undefined || r.path === null
			? {
					resolution: "unknown" as const,
					unresolved: r.unresolved ?? "no reading of this substitution",
				}
			: readingOf(resolveVerb(r.inner, r.context));
	return {
		span: { start: r.span.start, end: r.span.end },
		context: r.context,
		...reading,
		candidates: r.candidates,
		contextCertain: r.contextCertain,
		depth: r.depth,
		ev: EV.subcommands,
	};
}

/**
 * The `resolution`/`kind`/`command` fold, shared by statements and subcommands.
 *
 * Total over `VerbSplit` with no null-guard, because that module's union states
 * what each resolution carries: `navigation` has a path, `resolved` has a path
 * and a verb, a refusal has neither. A guard here would be an unreachable
 * branch pretending the invariant is unknown.
 */
function readingOf(split: VerbSplit): ExplainReading {
	if (split.resolution === "navigation")
		return {
			resolution: "resolved",
			kind: "menu",
			command: { path: split.path },
		};
	if (split.resolution === "resolved")
		return {
			resolution: "resolved",
			kind: "command",
			command: { path: split.path, verb: split.verb },
		};
	return { resolution: split.resolution, unresolved: split.why };
}

/** The tristate as the envelope renders it: a real `"unknown"`, never a boolean. */
function renderWriteVerdict(verdict: WriteVerdict): boolean | "unknown" {
	return verdict === "unknown" ? "unknown" : verdict === "true";
}

/**
 * Per-statement diagnostics — the abstentions, said out loud.
 *
 * A refusal is a first-class result, not an error: `ambiguous` and `unknown` are
 * the ratified vocabulary for "the input has several valid schema-free readings"
 * and "analysis cannot safely recover one". They are WARNINGS, never errors, so
 * the default `--fail-on error` does not fail a document whose only sin is being
 * unreadable without a schema — which is most of RouterOS scripting.
 */
function diagnosticsForStatement(s: ExplainStatement): ExplainDiagnostic[] {
	const out: ExplainDiagnostic[] = [];
	if (s.resolution === "ambiguous")
		out.push({
			code: "explain/canonicalizer/ambiguous-statement",
			severity: "warning",
			message:
				s.unresolved ??
				"menu or no-argument command: the same text offline, decidable only against a schema",
			span: s.span,
			ev: s.ev,
		});
	if (s.resolution === "unknown")
		out.push({
			code: "explain/canonicalizer/unresolved-statement",
			severity: "warning",
			message: s.unresolved ?? "no safe reading of this statement",
			span: s.span,
			ev: s.ev,
		});
	// The #192 signal: a reading that is CORRECT while the document context was
	// already lost. Info severity — the statement resolved without consuming the
	// context, so nothing about it is wrong; a consumer ranking readings or
	// offering completions is the one that needs to know.
	if (s.resolution === "resolved" && !s.contextCertain)
		out.push({
			code: "explain/canonicalizer/context-lost",
			severity: "info",
			message:
				"resolved without the document's menu context, which an earlier unreadable statement destroyed",
			span: s.span,
			ev: s.ev,
		});
	return out;
}

/**
 * Only evidence something cites.
 *
 * A dangling entry would claim a probe ran for a fact that is not in the result
 * — the opposite of what the provenance table is for.
 */
function citedEvidence(
	structure: ExplainStructure,
	diagnostics: readonly ExplainDiagnostic[],
	spans: readonly ExplainSpan[],
): ExplainEvidence[] {
	// `canonical` and `input` carry no `ev` of their own — they are whole-result
	// fields, not entries in a list — so their two passes are seeded here.
	const cited = new Set<string>([EV.canonical, EV.coordinates, structure.ev]);
	for (const s of structure.statements) cited.add(s.ev);
	for (const s of structure.subcommands) cited.add(s.ev);
	for (const b of structure.blocks) cited.add(b.ev);
	for (const d of diagnostics) cited.add(d.ev);
	for (const s of spans) cited.add(s.ev);
	return Object.values(EVIDENCE)
		.filter((e) => cited.has(e.id))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The offline envelope.
 *
 * `ok: true` whenever the analysis RAN, mirroring `check`: the diagnostics are
 * the data, and `ok: false` is reserved for genuine command failure (an
 * unresolvable target, a usage error). `via` is `null` because offline explain
 * never chooses a transport — there is nothing to choose.
 */
export function explainEnvelope(
	input: string,
	options: ExplainEnvelopeOptions = {},
): ExplainEnvelope {
	const data = explainCommand(input);
	const tips: Tip[] = [
		buildTip(
			"tip/explain-offline-only",
			"No router was given, so this is the canonicalizer's reading alone.",
			"Completion, schema, and `:parse` evidence come from a live target (`centrs explain <router> '<input>'`), which is phase 2 and not accepted yet.",
		),
		...(options.tips ?? []),
	];
	const warnings: Warning[] = [...(options.warnings ?? [])];
	const meta: EnvelopeMeta<ExplainOperationMeta> = {
		target: {},
		via: null,
		settings: settingsMeta(options.format),
		validation: { enabled: false, result: "skipped" },
		operation: {
			command: "explain",
			mode: "offline",
			statementCount: data.structure.statementCount,
			verdict: data.verdict,
		},
	};
	return { ok: true, data, warnings, tips, meta };
}

/**
 * The facets that need a device, requested offline.
 *
 * `--complete` and `--schema` are enumeration, and enumeration is live evidence:
 * offline has no schema snapshot to consult (the ratified no-static-snapshot
 * decision), so the honest answer is an empty result plus a tip naming what
 * would answer it. Fabricating candidates from a bundled table is exactly the
 * failure mode the decision exists to prevent.
 */
export function buildExplainFacetTip(facets: readonly string[]): Tip {
	const named = facets.join(" and ");
	return buildTip(
		"tip/explain-live-facets",
		`${named} enumerate what a device accepts, and no router was given — so nothing is enumerated here.`,
		"Name a router once live evidence lands (phase 2); until then use `rosetta` for documented RouterOS schema facts.",
	);
}

export const explainOutputFormats = ["text", "json", "yaml"] as const;
export type ExplainOutputFormat = (typeof explainOutputFormats)[number];

/**
 * Envelope-level options. Not analysis options — {@link explainCommand} still
 * takes none, and phase 2's `{ target, facets }` is a different parameter on a
 * different function. What lives here is what the ENVELOPE needs and the
 * analysis does not: the resolved render format (so `meta.settings` can name
 * the tier that won) and any tips the caller adds.
 */
export interface ExplainEnvelopeOptions {
	format?: ResolvedSetting<ExplainOutputFormat>;
	tips?: readonly Tip[];
	/** Facts about the INVOCATION, not the analysis (e.g. an ignored stdin). */
	warnings?: readonly Warning[];
}

function settingsMeta(
	format: ResolvedSetting<ExplainOutputFormat> | undefined,
): CommonSettingsMeta {
	return format === undefined ? {} : { format: toCoreSource(format.source) };
}

/**
 * Resolve the render format across the settings ladder: `centrs.env` config <
 * `CENTRS_FORMAT` env < the CLI flag (`docs/CONSTITUTION.md` → Settings
 * precedence). Throws `settings/invalid-format` on a bad value from ANY tier —
 * a typo in `centrs.env` that silently rendered text would be the same silent
 * fallback the constitution forbids on the CLI.
 */
export function resolveExplainFormat(
	explicit: string | undefined,
	env: Record<string, string | undefined> = Bun.env,
	config: Record<string, string | undefined> = {},
): ResolvedSetting<ExplainOutputFormat> {
	return resolveStringSetting(
		explicit,
		env,
		"CENTRS_FORMAT",
		"text",
		"format",
		parseExplainOutputFormat,
		undefined,
		config,
	) as ResolvedSetting<ExplainOutputFormat>;
}

function parseExplainOutputFormat(value: string): ExplainOutputFormat {
	if ((explainOutputFormats as readonly string[]).includes(value))
		return value as ExplainOutputFormat;
	throw new CentrsError({
		code: "settings/invalid-format",
		summary: `Unsupported explain output format: ${value}`,
		remediation: `Choose one of ${explainOutputFormats.join(", ")}.`,
		context: { format: value },
	});
}

/** `--fail-on` thresholds, in the order the CLI documents them. */
export const explainFailOnLevels = ["error", "warning", "never"] as const;
export type ExplainFailOn = (typeof explainFailOnLevels)[number];

/**
 * Exit `2` when the verdict meets the threshold, `0` otherwise — the `check`
 * pattern (`commands/explain/README.md` → Surface).
 *
 * Note what `--fail-on error` does NOT fail on: an `ambiguous`/`unknown`
 * statement is a warning by construction, so a script that is merely unreadable
 * without a schema still exits `0`. That is the whole reason the two verdicts
 * are separate — a resolution is not a severity.
 */
export function explainExitCode(
	verdict: ExplainVerdict,
	failOn: ExplainFailOn,
): 0 | 2 {
	if (failOn === "never") return 0;
	if (failOn === "warning") return verdict === "pass" ? 0 : 2;
	return verdict === "fail" ? 2 : 0;
}

export type ExplainErrorEnvelope = CentrsErrorEnvelope<ExplainOperationMeta>;

/**
 * A usage failure, in the same envelope. No `operation` block: nothing was
 * analyzed, so there is no statement count or verdict to report, and an
 * invented one would read as an analysis that ran.
 */
export function buildExplainErrorEnvelope(
	error: unknown,
	tips: readonly Tip[] = [],
	format?: ResolvedSetting<ExplainOutputFormat>,
): ExplainErrorEnvelope {
	const centrs =
		error instanceof CentrsError
			? error
			: new CentrsError({
					code: "internal/unhandled",
					summary: error instanceof Error ? error.message : String(error),
					remediation:
						"This is a centrs bug; re-run with --verbose and file an issue with the printed code.",
				});
	return {
		ok: false,
		error: serializeCentrsError(centrs),
		warnings: [],
		tips,
		meta: { target: {}, via: null, settings: settingsMeta(format) },
	};
}

export function renderExplainEnvelope(
	envelope: ExplainEnvelope | ExplainErrorEnvelope,
	format: ExplainOutputFormat,
): string {
	if (format === "json") return JSON.stringify(envelope, null, 2);
	if (format === "yaml") return toYaml(envelope);
	return renderExplainText(envelope);
}

function span(s: ExplainSpanRange): string {
	return `[${s.start},${s.end})`;
}

/** Tips in the shared text shape (`src/cli/missing-target.ts` renders the same block). */
function tipLines(tips: readonly Tip[]): string[] {
	if (tips.length === 0) return [];
	const lines = ["", "Tips:"];
	for (const tip of tips) {
		lines.push(`  - [${tip.code}] ${tip.message}`);
		if (tip.fix) lines.push(`    fix: ${tip.fix}`);
	}
	return lines;
}

/**
 * One statement or subcommand: what it resolved to, or why it did not.
 *
 * `path=`/`verb=` rather than a bare `<path> <verb>`, because a scripting
 * command resolves to path `/` plus its verb (`:foreach` is `/` + `foreach`)
 * and `/ foreach` reads like a typo, while `/foreach` reads like a menu.
 */
function renderReading(reading: ExplainReading): string {
	if (reading.resolution !== "resolved")
		return `${reading.resolution.padEnd(9)}  ${reading.unresolved}`;
	return reading.kind === "menu"
		? `resolved  menu     path=${reading.command.path}`
		: `resolved  command  path=${reading.command.path} verb=${reading.command.verb}`;
}

/**
 * The human format.
 *
 * Deliberately not a pretty-print of `data`: the text surface answers "what did
 * I write and what is wrong with it", so it leads with the two verdicts and the
 * gate, and drops empty sections. `--json` is the complete shape.
 */
function renderExplainText(
	envelope: ExplainEnvelope | ExplainErrorEnvelope,
): string {
	const lines: string[] = [];
	if (!envelope.ok) {
		lines.push(`[${envelope.error.code}] ${envelope.error.summary}`);
		if (envelope.error.remediation)
			lines.push(`Fix: ${envelope.error.remediation}`);
		if (envelope.error.detailsUrl)
			lines.push(`Details: ${envelope.error.detailsUrl}`);
		lines.push(...tipLines(envelope.tips));
		return lines.join("\n");
	}

	const { data } = envelope;
	const { canonical, structure } = data;
	lines.push(
		`verdict: ${data.verdict} — ${structure.statementCount} statement(s), ${data.diagnostics.length} diagnostic(s)`,
	);
	const argCount = Object.keys(canonical.args).length;
	lines.push(
		`gate: ${canonical.mode}${canonical.path ? ` ${canonical.path}` : ""}${canonical.verb ? ` ${canonical.verb}` : ""} · ${argCount} arg(s)${canonical.writeShaped ? " · write-shaped" : ""}`,
	);
	lines.push(`write: ${structure.containsWrite}`);
	if (data.input.normalized)
		lines.push(
			`input: ${data.input.bytes} byte(s), normalized (non-ASCII stood in for one-for-one)`,
		);
	if (structure.statements.length > 0) {
		lines.push("statements:");
		for (const s of structure.statements)
			lines.push(
				`  ${span(s.span).padEnd(12)} ${renderReading(s)}${s.contextCertain ? "" : "  (context lost)"}`,
			);
	}
	if (structure.subcommands.length > 0) {
		lines.push("subcommands:");
		for (const s of structure.subcommands)
			lines.push(
				`  ${span(s.span).padEnd(12)} ${renderReading(s)}  (in ${s.context}, depth ${s.depth})`,
			);
	}
	if (structure.blocks.length > 0) {
		lines.push("blocks:");
		for (const b of structure.blocks)
			lines.push(`  ${span(b.span).padEnd(12)} ${b.name}`);
	}
	if (data.diagnostics.length > 0) {
		lines.push("diagnostics:");
		for (const d of data.diagnostics)
			lines.push(
				`  ${d.severity.padEnd(7)} ${span(d.span).padEnd(12)} ${d.code}: ${d.message}`,
			);
	}
	lines.push(
		`evidence: ${data.evidence.map((e) => `${e.id} ${e.probe} (${e.basis})`).join(", ")}`,
	);
	lines.push(`runtimeAcceptance: ${data.runtimeAcceptance}`);
	for (const w of envelope.warnings)
		lines.push(`warning: [${w.code}] ${w.message}`);
	lines.push(...tipLines(envelope.tips));
	return lines.join("\n");
}
