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
 *   - **Per-statement arguments are read where they are LITERAL** (#202c).
 *     `structure.statements[].command.args` and the ordered `arguments.tokens`
 *     beside it come from `explain/args.ts`, which decides every token of a
 *     statement or refuses the whole list with a reason — a partially-read list
 *     would silently change what a rendered command does. On the frozen corpus
 *     40% of CRUD-verb commands are read; the refusals are overwhelmingly a
 *     value only the device can compute (`[…]`, `$x`, `{…}`). The gate's
 *     `canonical.args` and a read list never contradict each other (measured:
 *     83 corpus statements where both decided, 0 contradictions), though the
 *     analysis may abstain where the gate decided.
 *   - **Transport classification is fail-closed.** `api-candidate` is emitted
 *     only for the nine Q8 shapes runtime-exercised on two CHR versions;
 *     script-shaped input routes to `execute`, and every other resolved command
 *     is `unknown` with a reason. Curl is rendered only when requested.
 *   - **`spans` covers what offline can PROVE**: comment runs and resolved
 *     variable occurrences (Q13 scored 100% precision on resolved bindings, and
 *     abstentions are omitted rather than guessed). The full Q12 vocabulary over
 *     path/verb/argument bytes needs device `highlight` as its oracle and is
 *     phase 2. A subset is not a claim that the vocabulary is closed.
 *   - **Value facts have three axes, and highlight supplies none of them.**
 *     Offline analysis now publishes non-authoritative lexical SHAPE hints. The
 *     hint list may carry several shapes, but it borrows RouterOS's own type
 *     names, so it must never spell one the device contradicts: `2.2` is an
 *     IPv4 shortcut (`2.0.0.2`), not a decimal, because RouterOS numbers are
 *     integers. The type OBSERVED from a live reading and the SCHEMA type have
 *     separate optional homes but no offline producer. Each fact has its own
 *     provenance; no hint validates a value or becomes a diagnostic. The
 *     decision and the probe matrix are #225; this module
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
import { argSpans } from "./explain/arg-tokens.ts";
import {
	type ArgumentKind,
	invalidCommandBraceOffsets,
	lexArguments,
	lexValueAnchors,
	type ValueAnchorKind,
} from "./explain/args.ts";
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
import { isKnownMenuPath } from "./explain/is-known-menu.ts";
import { operatorSpans } from "./explain/operator-tokens.ts";
import { type PathTokenCandidate, pathSpans } from "./explain/path-tokens.ts";
import { type Resolution, resolveDocument } from "./explain/pathresolve.ts";
import { collectStringEscapeDefects } from "./explain/quoted-string.ts";
import { maskComments, segmentStatements } from "./explain/segment.ts";
import {
	resolveSymbols,
	type SymbolClass,
	type SymbolRole,
} from "./explain/symbols.ts";
import {
	classifyExplainTransport,
	type ExplainTransport,
} from "./explain/transport.ts";
import { valueSpans } from "./explain/value-tokens.ts";
import { type ValueShape, valueShapeHints } from "./explain/values.ts";
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
	/** Navigation names a menu and nothing else — there is no argument list. */
	arguments?: undefined;
	/** A menu is navigation, not a transportable command. */
	transport?: undefined;
	unresolved?: undefined;
}

/**
 * One argument token, located in DOCUMENT analyzed-byte space.
 *
 * The ordered list is the primary shape and {@link ExplainCommandReading.command}
 * `.args` is the object VIEW derived from it — the phase-0 normal form, which
 * requires order and multiplicity to survive somewhere a consumer can read them.
 */
export interface ExplainArgumentToken {
	kind: ArgumentKind;
	span: ExplainSpanRange;
	/** Attribute name / query word; absent on a positional. */
	name?: string;
	/**
	 * The token's LITERAL value, quotes removed — for an attribute the part after
	 * `=`, for a positional the whole token.
	 *
	 * **Absent means there is no literal value**, whatever the kind: the source
	 * spells a substitution, an expression, or an escape this phase does not
	 * decode. A consumer rendering a runnable command reads this, never `text`,
	 * and treats absence as "not renderable". A query is always absent.
	 */
	value?: string;
	/** Where the value sits, quotes INCLUDED. Absent whenever `value` is. */
	valueSpan?: ExplainSpanRange;
	/** The token verbatim. */
	text: string;
}

/**
 * What the statement-scope lexer decided about one command's arguments.
 *
 * All-or-nothing by construction (`src/explain/args.ts`): the consumer is a REST
 * rendering, and a partially-read argument list changes what the rendered
 * command DOES. `read: false` carries the reason, which the transport basis then
 * quotes rather than reporting a bare `unknown`.
 */
export type ExplainArguments =
	| {
			read: true;
			tokens: ExplainArgumentToken[];
			/** `?`-prefixed query words, in order. */
			queries: string[];
			/** Bare tokens, in order — an id (`*1`), a `where`, a `find` operand. */
			positional: string[];
	  }
	| { read: false; why: string };

/** A resolved command: a path AND the verb that was decided on it. */
export interface ExplainCommandReading {
	resolution: "resolved";
	kind: "command";
	/**
	 * `args` is present exactly when {@link arguments} read: it is that reading's
	 * object view (last occurrence wins), in the ratified sketch's place
	 * (`commands/explain/README.md` → *Result shape*). Absent is not `{}` — a
	 * command with no arguments reads as `{}`.
	 */
	command: { path: string; verb: string; args?: Record<string, string> };
	/**
	 * ABSENT rather than refused where no attempt was made — the same convention
	 * transport follows. Statements always carry it; a `[…]` subcommand does not,
	 * because its inner text has its own coordinate space that phase 1 does not
	 * rebase (see {@link ExplainSubcommand}).
	 */
	arguments?: ExplainArguments;
	/**
	 * Present on document statements after the #202c-2 transport pass. Absent on
	 * subcommands, whose inner argument coordinates phase 1 does not rebase.
	 */
	transport?: ExplainTransport;
	unresolved?: undefined;
}

/** A refusal. It carries its reason and nothing that would read as a reading. */
export interface ExplainRefusal {
	resolution: "ambiguous" | "unknown";
	kind?: undefined;
	command?: undefined;
	/** No command was read, so nothing here is an argument OF one. */
	arguments?: undefined;
	/** No command was read, so no transport can be classified. */
	transport?: undefined;
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

/**
 * One analyzer's contribution to the token partition.
 *
 * A fill is already-sorted, non-overlapping spans in document (analyzed-byte)
 * space. `buildTokens` takes fills **in order** — fill 0 claims first, fill 1
 * sees only the residual, and so on — so the argument order IS the fill order
 * (#290 design decision 1) and a structural ambiguity (`/` path sep vs `division`)
 * resolves by which analyzer came first rather than by a smarter byte scanner.
 *
 * A fill is typed as `ExplainToken[]` because B2 fills (path, argument, value,
 * then operator) introduce classes outside `ExplainSpanClass`; the proof-only
 * `spans[]` (ExplainSpan[]) remains a subtype and so fits the same slot.
 */
export type TokenFill = readonly ExplainToken[];

/**
 * A token in the total, gapless byte partition (B1).
 *
 * Every byte of the analyzed input belongs to exactly one token — a
 * contiguous, non-overlapping partition of `[0, input.bytes)` — sorted by
 * `start`, with no gaps and `tokens.map(t => slice).join("") === input`.
 * Byte-exact, inheriting the #215/#252 offset discipline. Offsets are on the
 * analyzed text; `input.positionMap` applies when normalized.
 *
 * `class` is **explicitly provisional until #264 B5** — the vocabulary here is
 * not the final LSP/SCIP legend, and every byte no analyzer claims becomes
 * `unclassified`. Filling those holes is B2, one PR per fill. `unclassified`
 * is a first-class answer, not a placeholder to be avoided.
 *
 * B2 so far: `dir` / `cmd` (resolved path and verb bytes, including valid path
 * slashes), `operator` (26 spellings + 2 aliases, `syntax-meta` is a residual
 * merge, never a source, #255), `arg` (argument names and their `=` as located
 * by `args.ts`), and `value` (argument value bytes and leaf array-literal
 * members from `data.values.occurrences`, quotes included, #295). Whether
 * separators or per-shape values later deserve distinct classes is #264 B5
 * vocabulary and does not move byte coverage.
 */
export type ExplainTokenClass =
	| ExplainSpanClass
	| "dir"
	| "cmd"
	| "operator"
	| "arg"
	| "value"
	| "unclassified";

export interface ExplainToken extends ExplainSpanRange {
	/**
	 * Provisional until #264 B5 — do not treat as the final vocabulary.
	 * `unclassified` means no analyzer claimed this byte.
	 */
	class: ExplainTokenClass;
	ev: string;
}

/** The Q13 class, or `null` where offline analysis must abstain. */
export type ExplainSymbolClass = Exclude<SymbolClass, "undefined"> | null;

export interface ExplainSymbolOccurrence {
	name: string;
	span: ExplainSpanRange;
	class: ExplainSymbolClass;
	role: SymbolRole;
	/** Stable only within this result; empty when no visible binding was decided. */
	bindingIds: string[];
	/** Whether the source used a `$`-sigilled reference spelling. */
	sigil: boolean;
	/** The resolver's reason for an abstention or special reading. */
	note?: string;
	ev: string;
}

/** Semantic symbol facts; `spans` remains the token/LSP-oriented projection. */
export interface ExplainSymbols {
	occurrences: ExplainSymbolOccurrence[];
}

export interface ExplainValueShapeFact {
	/**
	 * A list because the axis admits overlap; the 7.23.3/7.24rc3-grounded V1
	 * lexicon happens to assign at most one shape per spelling, and abstains
	 * where it has no grounded member (#243) rather than widening a near miss.
	 */
	values: ValueShape[];
	ev: string;
}

export interface ExplainValueTypeFact {
	value: string;
	ev: string;
}

/** The three #225 axes; live producers add the latter two without reshaping. */
export interface ExplainValueFacts {
	shapeHints?: ExplainValueShapeFact;
	observedType?: ExplainValueTypeFact;
	schemaType?: ExplainValueTypeFact;
}

export interface ExplainValueOccurrence {
	/** Result-local identity for #239's later flow-sensitive references. */
	id: string;
	/** Literal source bytes, quotes included. */
	span: ExplainSpanRange;
	tokenSpan: ExplainSpanRange;
	/** `element` is one member of an array literal, located inside its container. */
	kind: ValueAnchorKind;
	/** An attribute's name, or an array member's key. */
	name?: string;
	quoted: boolean;
	/**
	 * The `id` of the array literal this value is a member of.
	 *
	 * Present only on `element` rows. Containment is a reference rather than
	 * nesting so the list stays flat and ordered, and so #239 can point a symbol
	 * at one member without re-walking a tree.
	 */
	parent?: string;
	facts: ExplainValueFacts;
}

export interface ExplainValues {
	occurrences: ExplainValueOccurrence[];
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
	symbols: ExplainSymbols;
	values: ExplainValues;
	spans: ExplainSpan[];
	/**
	 * Total, gapless token partition of `[0, input.bytes)`.
	 *
	 * Present only when `--tokens` is requested, matching the `--complete` /
	 * `--schema` / `--curl` facet pattern. Every byte belongs to exactly one
	 * token, sorted by `start`, with no gaps and no overlaps:
	 * `tokens.map(t => input.slice(t.start, t.end)).join("") === input`.
	 * The `class` field is provisional until #264 B5; every byte no analyzer
	 * claims is `unclassified`.
	 */
	tokens?: ExplainToken[];
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
	transport: "e8",
	values: "e9",
	operators: "e10",
	args: "e11",
	paths: "e12",
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
	transport: {
		id: EV.transport,
		source: "canonicalizer",
		probe: "classifyExplainTransport",
		basis: "heuristic",
		outcome: "ok",
	},
	values: {
		id: EV.values,
		source: "canonicalizer",
		probe: "valueShapeHints",
		basis: "heuristic",
		outcome: "ok",
	},
	operators: {
		id: EV.operators,
		source: "canonicalizer",
		probe: "operatorSpans",
		basis: "heuristic",
		outcome: "ok",
	},
	/**
	 * `heuristic`, not `direct`, even though the span arithmetic is exact.
	 *
	 * `basis` describes the FACT, not the arithmetic. The fact here is "these
	 * bytes are an argument name and its `=`", and it rests on `argsAt` — the
	 * verb boundary, which `EV.statements` already records as `heuristic` and
	 * which this type's own doc names as the example of a rule a live probe
	 * could overturn. A misread boundary shifts every token this fill emits.
	 * `operatorSpans` sits at `heuristic` on identical grounds: deterministic
	 * byte arithmetic over a grounded table, downstream of an offline rule.
	 */
	args: {
		id: EV.args,
		source: "canonicalizer",
		probe: "argSpans",
		basis: "heuristic",
		outcome: "ok",
	},
	paths: {
		id: EV.paths,
		source: "canonicalizer",
		probe: "pathSpans",
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
	"bad-string-escape": {
		severity: "error",
		message: () =>
			'invalid escape in string: unknown escape, truncated hex, or lowercase hex digit — use \\n \\r \\t \\" \\\\ \\$ \\_ \\? \\a \\b \\f \\v, \\XX with uppercase hex, or \\ before whitespace to continue the line',
	},
	"bad-sigil": {
		severity: "error",
		message: () => "invalid sigil: the run must be zero or one character",
	},
	"invalid-hash": {
		severity: "error",
		message: () =>
			"unquoted `#` is a syntax error here — quote it where a value is accepted, or move it to statement-leading position to start a comment",
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

/**
 * Complement of claimed spans within `[0, len)` — the residual runs a fill
 * sees.
 *
 * Factored out of `buildTokens` so every fill can compute it and so tests can
 * assert it directly. `claimed` need not be sorted; the result is sorted and
 * coalesced with no gaps or overlaps relative to the claimed set.
 */
export function residualRanges(
	len: number,
	claimed: readonly ExplainSpanRange[],
): { start: number; end: number }[] {
	if (len === 0) return [];
	const sorted = [...claimed].sort(
		(a, b) => a.start - b.start || a.end - b.end,
	);
	let cursor = 0;
	const out: { start: number; end: number }[] = [];
	for (const r of sorted) {
		if (cursor < r.start) out.push({ start: cursor, end: r.start });
		cursor = Math.max(cursor, r.end);
	}
	if (cursor < len) out.push({ start: cursor, end: len });
	return out;
}

/**
 * Build the total, gapless token partition (B1).
 *
 * Every byte of `[0, bytes)` belongs to exactly one token: `spans` are
 * placed sorted, no gaps become `unclassified`, and the result is sorted by
 * `start` with no overlaps and `join(slice) === input`. The `class` field is
 * provisional until #264 B5.
 *
 * B2: `buildTokens` now takes an **ordered list of fills**. Fill 0 claims
 * first, fill 1 sees only the residual of fill 0, and so on — the argument
 * order IS the fill order (#290 design decision 1). An overlap across fills is
 * a hard throw (structural impossibility is achieved by callers offering only
 * residual; the throw is the safety net). For backward compatibility a single
 * fill may be passed as a flat span array.
 */
export function buildTokens(
	analyzed: string,
	spansOrFills: readonly ExplainSpan[] | readonly TokenFill[],
): ExplainToken[] {
	const len = analyzed.length;
	// Normalize the overload: a flat span array is one fill.
	let fills: readonly TokenFill[];
	if (spansOrFills.length === 0) {
		fills = [];
	} else {
		const first = spansOrFills[0] as unknown as Record<string, unknown>;
		const isFlatSpan =
			first !== null &&
			typeof first === "object" &&
			"class" in first &&
			"ev" in first &&
			"start" in first;
		fills = isFlatSpan
			? ([spansOrFills] as unknown as readonly TokenFill[])
			: (spansOrFills as readonly TokenFill[]);
	}
	// Validate each fill internally (non-integer, bounds, overlap within fill).
	for (const fill of fills) {
		const sorted = [...fill].sort((a, b) => a.start - b.start || a.end - b.end);
		let prev = 0;
		for (const s of sorted) {
			if (!Number.isInteger(s.start) || !Number.isInteger(s.end))
				throw new Error(
					`buildTokens: non-integer span [${s.start},${s.end}) for length ${len}`,
				);
			if (s.start < 0 || s.end <= s.start || s.end > len)
				throw new Error(
					`buildTokens: span out of bounds [${s.start},${s.end}) for length ${len}`,
				);
			if (s.start < prev)
				throw new Error(
					`buildTokens: overlapping spans at [${s.start},${s.end})`,
				);
			prev = Math.max(prev, s.end);
		}
	}
	const flat: ExplainToken[] = fills.flatMap((fill) => [...fill]);
	const sorted = [...flat].sort((a, b) => a.start - b.start || a.end - b.end);
	// Cross-fill overlap is also a hard throw — callers achieve impossibility by
	// offering only residual; this is the safety net.
	let prev = 0;
	for (const s of sorted) {
		if (s.start < prev)
			throw new Error(
				`buildTokens: overlapping spans at [${s.start},${s.end})`,
			);
		prev = Math.max(prev, s.end);
	}
	if (len === 0) return [];
	const out: ExplainToken[] = [];
	let cursor = 0;
	for (const s of sorted) {
		if (cursor < s.start) {
			out.push({
				start: cursor,
				end: s.start,
				class: "unclassified",
				// The pass that produced an UNCLAIMED byte is the one that produced
				// the analyzed surface it sits on — `analyzeCoordinates`, not the
				// execute canonicalizer. A B2 fill replaces this with the pass that
				// claimed the byte.
				ev: EV.coordinates,
			});
		}
		out.push({ start: s.start, end: s.end, class: s.class, ev: s.ev });
		cursor = s.end;
	}
	if (cursor < len) {
		out.push({
			start: cursor,
			end: len,
			class: "unclassified",
			ev: EV.coordinates, // see above
		});
	}
	return out;
}

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
 * Extensible analysis options.
 *
 * ONE additive bag, which is why the previous no-options signature could be
 * widened without a second shape: phase 2 puts `target` and the live facets
 * here, and `curl` stays orthogonal to both — it asks for a rendering of a
 * result, not for more evidence. A caller can still tell an honored option from
 * an ignored one, because every field here changes the result.
 */
export interface ExplainCommandOptions {
	/** Include a ready-to-edit REST curl on API-candidate statements. */
	curl?: boolean;
	/**
	 * Emit the total, gapless token partition behind `data.tokens[]`.
	 *
	 * Mirrors `--complete` / `--schema` / `--curl`: an opt-in facet whose
	 * presence changes the result. The `class` field is provisional until
	 * #264 B5.
	 */
	tokens?: boolean;
}

/**
 * Analyze one RouterOS input offline. Never throws, never contacts a device.
 *
 * Curl rendering is an opt-in presentation concern. It adds a shell-safe view
 * of an already-classified request and does not alter canonical analysis.
 */
export function explainCommand(
	input: string,
	options: ExplainCommandOptions = {},
): ExplainData {
	const coordinates = analyzeCoordinates(input);
	// The ANALYZED text is what arguments are lexed from: it is pure ASCII with
	// one byte standing in for every non-ASCII one, so an index into it IS a
	// document byte offset. Decoding it once here keeps `statementOf` and the
	// string-escape walk from re-deriving the same string.
	const analyzed = new TextDecoder().decode(coordinates.analyzed);
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
		[EV.symbols, collectStringEscapeDefects(analyzed, segmented.comments)],
	]);

	// From the SPLITS, not from the segmentation. The resolver flattens `do={…}`
	// bodies in after their parent, so its list is longer than the top-level
	// segments and pairing the two by index attaches the wrong span to every statement after
	// the first block. Each split carries its own document-space span.
	//
	const readStatements: ExplainStatement[] = verbs.splits.map((split) =>
		statementOf(split, analyzed),
	);
	const canonical = canonicalizeExecuteCommand(input);
	const statements = enforceGateParity(readStatements, canonical).map(
		(statement, index) =>
			withStatementTransport(
				statement,
				verbs.splits[index]?.text ?? "",
				options,
			),
	);

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
		...invalidCommandBraceDiagnostics(verbs.splits, analyzed),
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
	const symbolFacts: ExplainSymbols = {
		occurrences: symbols.occurrences.map((o) => ({
			name: o.name,
			span: { start: o.start, end: o.end },
			// `undefined` is a live-device class Q13 forbids offline. Fail closed if
			// the lower-level vocabulary ever grows a producer accidentally.
			class: o.cls === "undefined" ? null : o.cls,
			role: o.role,
			bindingIds: [...o.bindingIds],
			sigil: o.sigil,
			...(o.note === undefined ? {} : { note: o.note }),
			ev: EV.symbols,
		})),
	};
	const valueFacts = valuesOf(verbs.splits, analyzed);

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

	// B2 fill order — the argument order IS the order (#290 design decision 1).
	// `spans` (proof-only: comment + variables) claims first; path, argument,
	// value, then operator fills each see only the residual left before them.
	// Structural ambiguity (`/` path vs division, `=` arg sep vs comparison)
	// therefore resolves by the analyzer that already proved ownership, not by a
	// wider byte scanner. The operator scanner keeps its conservative guards for
	// bytes no earlier fill can decide.
	//
	// Gate the scan on `options.tokens` — no residual work when the caller
	// did not ask for `data.tokens`. Future B2 fills belong inside this branch.
	let tokens: ExplainToken[] | undefined;
	if (options.tokens === true) {
		const residual0 = residualRanges(analyzed.length, spans);
		const pathCandidates: PathTokenCandidate[] = [
			...verbs.splits.map((split) => ({
				text: split.text,
				span: split.span,
				split,
				ev: EV.paths,
			})),
			...brackets.resolutions.flatMap((resolution) => {
				if (resolution.unresolved !== undefined || resolution.path === null)
					return [];
				return [
					{
						text: resolution.inner,
						span: {
							start: resolution.span.start + 1,
							end: resolution.span.end - 1,
						},
						split: resolveVerb(resolution.inner, resolution.context),
						ev: EV.paths,
					},
				];
			}),
		];
		const pathSpansList = pathSpans(analyzed, residual0, pathCandidates);
		const residual1 = residualRanges(analyzed.length, [
			...spans,
			...pathSpansList,
		]);
		const argCandidates = statements.flatMap((s) =>
			s.arguments?.read === true ? s.arguments.tokens : [],
		);
		const argSpansList = argSpans(analyzed, residual1, argCandidates);
		const residual2 = residualRanges(analyzed.length, [
			...spans,
			...pathSpansList,
			...argSpansList,
		]);
		const valueSpansList = valueSpans(
			analyzed,
			residual2,
			valueFacts.occurrences,
		);
		const residual3 = residualRanges(analyzed.length, [
			...spans,
			...pathSpansList,
			...argSpansList,
			...valueSpansList,
		]);
		const opSpans = operatorSpans(analyzed, residual3);
		const fills: TokenFill[] = [
			spans,
			pathSpansList,
			argSpansList,
			valueSpansList,
			opSpans,
		];
		tokens = buildTokens(analyzed, fills);
	}

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
		symbols: symbolFacts,
		values: valueFacts,
		spans,
		...(tokens === undefined ? {} : { tokens }),
		diagnostics,
		evidence: citedEvidence(
			structure,
			diagnostics,
			spans,
			symbolFacts,
			valueFacts,
			tokens,
		),
		runtimeAcceptance: "not-proven",
	};
}

/** Attach transport only after the gate-parity guard has had the final word. */
function withStatementTransport(
	statement: ExplainStatement,
	source: string,
	options: ExplainCommandOptions,
): ExplainStatement {
	if (statement.kind !== "command" || statement.arguments === undefined)
		return statement;
	return {
		...statement,
		transport: classifyExplainTransport(
			{
				command: statement.command,
				arguments: statement.arguments,
				source,
			},
			{ renderCurl: options.curl, evidenceId: EV.transport },
		),
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
function statementOf(
	split: DocumentVerbSplit,
	analyzed: string,
): ExplainStatement {
	const reading = readingOf(split);
	return {
		span: { start: split.span.start, end: split.span.end },
		...(reading.kind === "command"
			? withArguments(reading, split, analyzed)
			: reading),
		contextCertain: split.contextCertain,
		ev: EV.statements,
	};
}

/**
 * Attach the statement's argument reading, rebased into document space.
 *
 * The **span check** is the load-bearing line. `argsAt` indexes the statement's
 * OWN text, and the document offsets come from `span` — so the two are only
 * compatible when `span` really is where that text sits. It is not always:
 * `pathresolve.ts`'s `Loc` widens a nested body statement's span to the
 * enclosing statement when interior offsets cannot be mapped, and a non-ASCII
 * statement's original text is shorter than its analyzed byte range. Both would
 * lex the wrong bytes and report confident arguments for them, which is the one
 * failure a fail-closed lexer must not have. Comparing the analyzed slice with
 * the resolver's own text catches both at once and costs one string compare.
 */
function withArguments(
	reading: ExplainCommandReading,
	split: DocumentVerbSplit,
	analyzed: string,
): ExplainCommandReading {
	const read = argumentsOf(split, analyzed);
	return {
		...reading,
		command:
			read.args === undefined
				? reading.command
				: { ...reading.command, args: read.args },
		arguments: read.arguments,
	};
}

/**
 * The statement's argument reading, plus the object view that goes on
 * `command.args`.
 *
 * The two travel together because the LEXER owns the object view: it builds a
 * last-wins map while it walks the tokens, and recomputing that here from the
 * rebased tokens would be a second implementation of one rule — free to diverge
 * from the lexer's, and so from `canonicalizeExecuteCommand`'s, which is the
 * duplicate-name agreement this module's header asserts. Raised in review of
 * #202c-1.
 */
function argumentsOf(
	split: DocumentVerbSplit,
	analyzed: string,
): { arguments: ExplainArguments; args?: Record<string, string> } {
	if (split.argsAt === null)
		return {
			arguments: {
				read: false,
				why: "the verb is not the last token of the leading path run, so what follows the run is not this command's argument list",
			},
		};
	const { start, end } = split.span;
	const text = analyzed.slice(start, end);
	if (text !== split.text)
		return {
			arguments: {
				read: false,
				why: "this statement's bytes are not addressable: its text was normalized (non-ASCII), or its span was widened to the enclosing statement",
			},
		};
	const lexed = lexArguments(text, split.argsAt);
	if (!lexed.read) return { arguments: lexed };
	return {
		args: lexed.args,
		arguments: {
			read: true,
			tokens: lexed.tokens.map((token) => ({
				...token,
				span: { start: start + token.span.start, end: start + token.span.end },
				...(token.valueSpan === undefined
					? {}
					: {
							valueSpan: {
								start: start + token.valueSpan.start,
								end: start + token.valueSpan.end,
							},
						}),
			})),
			queries: lexed.queries,
			positional: lexed.positional,
		},
	};
}

function invalidCommandBraceDiagnostics(
	splits: readonly DocumentVerbSplit[],
	analyzed: string,
): ExplainDiagnostic[] {
	const out: ExplainDiagnostic[] = [];
	for (const split of splits) {
		if (split.resolution !== "resolved" || split.argsAt === null) continue;
		const { start, end } = split.span;
		const text = analyzed.slice(start, end);
		if (text !== split.text) continue;
		// The verb splitter cannot yet flatten every relative nested menu block.
		// Do not reinterpret a known submenu's leading `{` as an argument value,
		// but retain diagnostics for rejected braces later in the same split.
		// Require evidence that the brace actually opens a menu container
		// (body starts with a submenu name), so `/ip/route/print {1;2}` and
		// `/ip { firewall/filter/print {1;2} }` still diagnose the `{1;2}` array.
		const argsText = text.slice(split.argsAt);
		const leadingBraceAt = argsText.search(/\S/);
		let menuBraceAt: number | null = null;
		if (
			leadingBraceAt >= 0 &&
			argsText[leadingBraceAt] === "{" &&
			split.candidates.some((candidate) =>
				isKnownMenuPath(candidate.split("/").filter(Boolean)),
			)
		) {
			const braceAt = split.argsAt + leadingBraceAt;
			const structural = maskComments(text);
			const trimmed = structural.slice(braceAt + 1).trimStart();
			if (trimmed.length === 0 || trimmed[0] === "}") {
				menuBraceAt = braceAt;
			} else {
				const match = /^\/?([A-Za-z][A-Za-z0-9._-]*)/.exec(trimmed);
				if (match) {
					const firstWord = match[1] as string;
					const isMenuContainer = split.candidates.some((candidate) => {
						const segments = candidate.split("/").filter(Boolean);
						if (!isKnownMenuPath(segments)) return false;
						return isKnownMenuPath([...segments, firstWord]);
					});
					if (isMenuContainer) menuBraceAt = braceAt;
				}
			}
		}
		for (const at of invalidCommandBraceOffsets(
			text,
			split.argsAt,
			split.path === "/" ? split.verb : undefined,
		)) {
			if (at === menuBraceAt) continue;
			out.push({
				code: "explain/canonicalizer/invalid-command-brace",
				severity: "error",
				message:
					"brace arrays are not valid in command arguments — use a parenthesized comma list such as `(1,2)`, or a bare comma list where the argument schema accepts one",
				span: { start: start + at, end: start + at + 1 },
				ev: EV.values,
			});
		}
	}
	return out;
}

/** Compose safely located literals into the three-axis #225 value surface. */
function valuesOf(
	splits: readonly DocumentVerbSplit[],
	analyzed: string,
): ExplainValues {
	const occurrences: ExplainValueOccurrence[] = [];
	for (const split of splits) {
		if (split.resolution !== "resolved" || split.argsAt === null) continue;
		const { start, end } = split.span;
		const text = analyzed.slice(start, end);
		if (text !== split.text) continue;
		const anchored = lexValueAnchors(text, split.argsAt, {
			// A `{…}` array literal is legal only in a ROOT scripting directive's
			// value slot; `/ip/dns/set servers={…}` and `:log info message={…}` are
			// both device syntax errors at the `{`. `path` is how that position is
			// spelled offline: `:local`/`:put`/`:foreach` resolve to `/`, while
			// `:log info` resolves to `/log` — and the device agrees with the split.
			...(split.path === "/" ? { directiveVerb: split.verb } : {}),
		});
		// Prefix completeness is intentionally not an envelope fact: shape hints are
		// advisory and never turn the later refusal reason into a diagnostic.
		const ids = new Map<number, string>();
		for (const [index, anchor] of anchored.anchors.entries()) {
			const hints: ValueShape[] =
				// A source-proved shape wins outright: the delimiters prove `array`,
				// and an `=` that binds no key proves `str` or `bool` (#258). None is
				// recoverable from the decoded scalar `valueShapeHints` reads.
				anchor.sourceShape !== undefined
					? [anchor.sourceShape]
					: valueShapeHints(anchor.value, {
							quoted: anchor.quoted,
							allowBareString: anchor.kind === "attribute",
							context: anchor.kind === "element" ? "array-member" : "argument",
						});
			if (hints.length === 0) continue;
			const span = {
				start: start + anchor.valueSpan.start,
				end: start + anchor.valueSpan.end,
			};
			const id = `v${occurrences.length}`;
			ids.set(index, id);
			const parent =
				anchor.parent === undefined ? undefined : ids.get(anchor.parent);
			occurrences.push({
				id,
				span,
				tokenSpan: {
					start: start + anchor.tokenSpan.start,
					end: start + anchor.tokenSpan.end,
				},
				kind: anchor.kind,
				...(anchor.name === undefined ? {} : { name: anchor.name }),
				quoted: anchor.quoted,
				...(parent === undefined ? {} : { parent }),
				facts: { shapeHints: { values: hints, ev: EV.values } },
			});
		}
	}
	return { occurrences };
}

/**
 * The last line of the "never two confident answers" rule: where the gate and
 * the analysis read the SAME bytes and disagree about the arguments, the
 * analysis abstains.
 *
 * `args.ts` guards the characters centrs's two readers are known to differ on,
 * and that is where a specific, quotable reason belongs. But a token-level guard
 * can only see what reaches the lexer, and the gate reads the RAW INPUT while
 * the analysis reads a SEGMENTED statement — so a byte segmentation removes is
 * invisible to every such guard. A trailing `;` is exactly that: the gate keeps
 * it (`comment=x;` → the value `x;`), the segmenter strips it as the statement
 * terminator (`x`), and no character rule in `args.ts` can be written to catch
 * it, because by then it is gone.
 *
 * So the invariant is ENFORCED here rather than claimed. It is checkable only in
 * the one case where the two readers genuinely share bytes — the gate read the
 * whole input as `structured`, and there is exactly one statement — which is
 * also the only case where a consumer could see both answers side by side. A
 * multi-statement document makes the gate `script` with empty args, so there is
 * nothing to compare and the token-level guards are what protect each
 * statement's own reading.
 *
 * Abstaining is again not a concession that the gate is right: on `;` the
 * ANALYSIS is device-correct (`;` ends a statement in RouterOS; it is not part
 * of a value). The gate is locked, so neither value is published.
 *
 * Cost, measured: a printable-ASCII differential over 8 templates finds 675
 * cases where both decide and 0 surviving mismatches with this in place, and the
 * corpus parity probe is unchanged at 83 both-decided, 0 contradictions — so
 * this fires on `;` and nothing else that has been found. Raised as a P1 in
 * review of #202c-1, after three character-level guards each closed only what
 * had been reported.
 */
function enforceGateParity(
	statements: readonly ExplainStatement[],
	canonical: CanonicalExecuteCommand,
): ExplainStatement[] {
	const out = [...statements];
	if (canonical.mode !== "structured" || out.length !== 1) return out;
	const only = out[0];
	if (only?.kind !== "command" || only.arguments?.read !== true) return out;
	const same =
		JSON.stringify([only.command.args ?? {}, only.arguments.queries]) ===
		JSON.stringify([canonical.attributes, canonical.queries]);
	if (same) return out;
	const { args: _dropped, ...command } = only.command;
	out[0] = {
		...only,
		command,
		arguments: {
			read: false,
			why: "centrs's execute gate reads these bytes as a different argument list, and offline cannot prove which reading a device would apply",
		},
	};
	return out;
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
	symbols: ExplainSymbols,
	values: ExplainValues,
	tokens?: readonly ExplainToken[] | readonly ExplainSpan[] | undefined,
): ExplainEvidence[] {
	// `canonical` and `input` carry no `ev` of their own — they are whole-result
	// fields, not entries in a list — so their two passes are seeded here.
	const cited = new Set<string>([EV.canonical, EV.coordinates, structure.ev]);
	for (const s of structure.statements) cited.add(s.ev);
	for (const s of structure.statements)
		if (s.kind === "command" && s.transport !== undefined)
			cited.add(s.transport.ev);
	for (const s of structure.subcommands) cited.add(s.ev);
	for (const b of structure.blocks) cited.add(b.ev);
	for (const d of diagnostics) cited.add(d.ev);
	for (const s of spans) cited.add(s.ev);
	for (const occurrence of symbols.occurrences) cited.add(occurrence.ev);
	for (const occurrence of values.occurrences) {
		if (occurrence.facts.shapeHints !== undefined)
			cited.add(occurrence.facts.shapeHints.ev);
		if (occurrence.facts.observedType !== undefined)
			cited.add(occurrence.facts.observedType.ev);
		if (occurrence.facts.schemaType !== undefined)
			cited.add(occurrence.facts.schemaType.ev);
	}
	if (tokens !== undefined) for (const t of tokens) cited.add(t.ev);
	return Object.values(EVIDENCE)
		.filter((e) => cited.has(e.id))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The offline envelope.
 *
 * `ok: true` whenever the analysis RAN, mirroring `check`: the diagnostics are
 * the data, and `ok: false` is reserved for genuine command failure (an
 * unresolvable target, a usage error). `via` is `null` because the offline
 * classifier plans each statement but does not open a protocol connection.
 */
export function explainEnvelope(
	input: string,
	options: ExplainEnvelopeOptions = {},
): ExplainEnvelope {
	const data = explainCommand(input, {
		curl: options.curl,
		tokens: options.tokens,
	});
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
 * Envelope-level options. Curl is forwarded to the analysis as an opt-in
 * rendering; the remaining fields are invocation metadata the analysis does
 * not need. Phase 2's `{ target, facets }` remains a separate live concern.
 */
export interface ExplainEnvelopeOptions {
	format?: ResolvedSetting<ExplainOutputFormat>;
	/** Include curl rendering for API-candidate statements. */
	curl?: boolean;
	/**
	 * Include the gapless token partition behind `data.tokens[]`.
	 *
	 * Mirrors `--complete` / `--schema` / `--curl` facet pattern. Provisional
	 * vocabulary until #264 B5.
	 */
	tokens?: boolean;
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

function renderSymbol(occurrence: ExplainSymbolOccurrence): string {
	const binding =
		occurrence.bindingIds.length === 0
			? ""
			: ` bindings=${occurrence.bindingIds.join(",")}`;
	const note = occurrence.note === undefined ? "" : `  (${occurrence.note})`;
	return `${(occurrence.class ?? "unknown").padEnd(9)} ${occurrence.role.padEnd(11)} name=${JSON.stringify(occurrence.name)}${binding}${note}`;
}

function renderValue(occurrence: ExplainValueOccurrence): string {
	const name = occurrence.name === undefined ? "" : ` name=${occurrence.name}`;
	const shapes = occurrence.facts.shapeHints?.values.join("|") ?? "unknown";
	const parent =
		occurrence.parent === undefined ? "" : ` in=${occurrence.parent}`;
	return `${occurrence.kind.padEnd(10)}${name}${parent} shapes=${shapes}`;
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
		for (const s of structure.statements) {
			lines.push(
				`  ${span(s.span).padEnd(12)} ${renderReading(s)}${s.kind === "command" && s.transport !== undefined ? `  via=${s.transport.classification}` : ""}${s.contextCertain ? "" : "  (context lost)"}`,
			);
			if (s.kind === "command" && s.transport?.centrs !== undefined)
				lines.push(`    centrs: ${s.transport.centrs}`);
			if (s.kind === "command" && s.transport?.curl !== undefined)
				lines.push(`    curl: ${s.transport.curl}`);
			// A refusal must say why in the DEFAULT surface. `api-candidate` and
			// `execute` render the command they chose, which is the reason; only
			// `unknown` renders nothing, and the basis is the actionable half.
			if (s.kind === "command" && s.transport?.classification === "unknown")
				lines.push(`    why: ${s.transport.basis}`);
		}
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
	const comments = data.spans.filter((entry) => entry.class === "comment");
	if (comments.length > 0) {
		lines.push("comments:");
		for (const comment of comments)
			lines.push(`  ${span(comment).padEnd(12)} comment`);
	}
	if (data.symbols.occurrences.length > 0) {
		lines.push("symbols:");
		for (const occurrence of data.symbols.occurrences)
			lines.push(
				`  ${span(occurrence.span).padEnd(12)} ${renderSymbol(occurrence)}`,
			);
	}
	if (data.values.occurrences.length > 0) {
		lines.push("values:");
		for (const occurrence of data.values.occurrences)
			lines.push(
				`  ${span(occurrence.span).padEnd(12)} ${renderValue(occurrence)}`,
			);
	}
	// `--tokens` is opt-in, so it must CHANGE this surface — a flag that only
	// moves `--json` reads as a no-op from the default format. The header is the
	// #289 deliverable (a coverage number) for this one input; the rows are the
	// partition itself, `unclassified` runs included.
	if (data.tokens !== undefined) {
		const classified = data.tokens.reduce(
			(sum, t) => sum + (t.class === "unclassified" ? 0 : t.end - t.start),
			0,
		);
		const bytes = data.input.bytes;
		const pct = bytes === 0 ? 0 : (classified / bytes) * 100;
		lines.push(
			`tokens: ${data.tokens.length} token(s), ${classified}/${bytes} byte(s) classified (${pct.toFixed(1)}%), class provisional`,
		);
		for (const t of data.tokens)
			lines.push(`  ${span(t).padEnd(12)} ${t.class}`);
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
