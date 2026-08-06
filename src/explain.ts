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
 *     path/verb/argument/value bytes needs device `highlight` as its oracle and
 *     is phase 2. A subset is not a claim that the vocabulary is closed.
 *   - **`runtimeAcceptance` is always `"not-proven"`**, offline and live alike.
 *     It is the inspect-vs-runtime gap made machine-readable, not a placeholder.
 */

import type { CentrsSuccessEnvelope, EnvelopeMeta } from "./core/envelope.ts";
import { buildTip, type Tip, type Warning } from "./core/envelope.ts";
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
	mergeDefects,
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

export interface ExplainStatement {
	span: ExplainSpanRange;
	resolution: ExplainResolution;
	/**
	 * Present only when `resolution` is `resolved`. `verbsplit` reports menu
	 * navigation as its own `navigation` resolution so that `resolved` keeps
	 * meaning "a verb was decided" for its callers; the envelope folds the two
	 * into `resolved` + `kind`, which is the ratified vocabulary.
	 */
	kind?: "menu" | "command";
	/** The decided reading. A menu statement carries a `path` and no `verb`. */
	command?: { path: string; verb?: string };
	/** Why the analyzer refused, when it did. */
	unresolved?: string;
	/**
	 * Was the menu context in force BEFORE this statement known? A `false` here
	 * does not invalidate a `resolved` reading — the resolver already degrades
	 * every context-DEPENDENT statement when context is lost, so a statement that
	 * still resolved did not consume it (#192, #197).
	 */
	contextCertain: boolean;
	ev: string;
}

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
export interface ExplainSubcommand {
	span: ExplainSpanRange;
	/** Menu context in force at the bracket, `/` at document root. */
	context: string;
	resolution: ExplainResolution;
	kind?: "menu" | "command";
	command?: { path: string; verb?: string };
	/** Every path the inner command could resolve to, shortest first. */
	candidates: string[];
	unresolved?: string;
	contextCertain: boolean;
	/** Bracket nesting depth; 0 is directly inside a statement. */
	depth: number;
	ev: string;
}

/** A `{…}` scope at document level. */
export interface ExplainBlock {
	/** The argument or directive that opened it (`do`, `on-error`, …). */
	name: string;
	/** The BODY's span, braces excluded. */
	span: ExplainSpanRange;
}

export interface ExplainStructure {
	statementCount: number;
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

/** Where a derived fact came from. Offline every entry is `canonicalizer`. */
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

/** Stable evidence ids. One per analysis PASS, because offline that is the
 * finest real distinction: every fact a pass produces has the same provenance,
 * and inventing a per-fact id would imply the passes disagree per fact. */
const EV = {
	canonical: "e0",
	coordinates: "e1",
	segment: "e2",
	resolve: "e3",
	write: "e4",
	symbols: "e5",
} as const;

const EVIDENCE: Record<keyof typeof EV, ExplainEvidence> = {
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
	resolve: {
		id: EV.resolve,
		source: "canonicalizer",
		probe: "resolveVerbs",
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

	// Every analyzer re-derives the document's defects from its own walk; the
	// merge de-dupes on the whole region, so a defect two analyzers both see is
	// reported once and one only `symbols` sees (its lexical classes) still lands.
	const defects = mergeDefects(
		segmented.defects,
		verbs.defects,
		brackets.defects,
		write.defects,
		symbols.defects,
	).sort((a, b) => a.start - b.start || a.end - b.end);

	const statements: ExplainStatement[] = segmented.segments.map((seg, i) =>
		statementOf({ start: seg.start, end: seg.end }, verbs.splits[i]),
	);

	const diagnostics: ExplainDiagnostic[] = [
		...defects.map((d) => {
			const render = DEFECT_DIAGNOSTICS[d.code];
			return {
				code: `explain/canonicalizer/${d.code}`,
				severity: render.severity,
				message: render.message(d),
				span: { start: d.start, end: d.end },
				// A positional fact is a coordinate reading; everything else was
				// raised by a structural walk.
				ev:
					d.code === "bom" || d.code === "non-ascii"
						? EV.coordinates
						: EV.segment,
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
		structure: {
			statementCount: statements.length,
			statements,
			blocks: scopeBlocks(input).map((b) => ({
				name: b.name,
				span: { start: b.start, end: b.start + b.body.length },
			})),
			containsWrite: renderWriteVerdict(write.verdict),
			subcommands: brackets.resolutions.map(subcommandOf),
			ev: EV.write,
		},
		spans,
		diagnostics,
		evidence: citedEvidence(statements, diagnostics, spans),
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
 * The `splits` array is built from the same segmentation as `segments`, so a
 * missing entry is impossible; it is handled as `unknown` rather than asserted,
 * because a fail-closed refusal is the right answer to an invariant this module
 * cannot itself prove.
 */
function statementOf(
	span: ExplainSpanRange,
	split: DocumentVerbSplit | undefined,
): ExplainStatement {
	if (split === undefined)
		return {
			span,
			resolution: "unknown",
			unresolved: "no verb analysis for this statement",
			contextCertain: false,
			ev: EV.resolve,
		};
	return {
		span,
		...readingOf(split),
		contextCertain: split.contextCertain,
		ev: EV.resolve,
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
		ev: EV.resolve,
	};
}

/** The `resolution`/`kind`/`command` fold, shared by statements and subcommands. */
function readingOf(split: VerbSplit): {
	resolution: ExplainResolution;
	kind?: "menu" | "command";
	command?: { path: string; verb?: string };
	unresolved?: string;
} {
	if (split.resolution === "navigation")
		return {
			resolution: "resolved",
			kind: "menu",
			...(split.path === null ? {} : { command: { path: split.path } }),
		};
	if (split.resolution === "resolved")
		return {
			resolution: "resolved",
			kind: "command",
			...(split.path === null || split.verb === null
				? {}
				: { command: { path: split.path, verb: split.verb } }),
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
	statements: readonly ExplainStatement[],
	diagnostics: readonly ExplainDiagnostic[],
	spans: readonly ExplainSpan[],
): ExplainEvidence[] {
	const cited = new Set<string>([EV.canonical, EV.coordinates, EV.write]);
	for (const s of statements) cited.add(s.ev);
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
export function explainEnvelope(input: string): ExplainEnvelope {
	const data = explainCommand(input);
	const tips: Tip[] = [
		buildTip(
			"tip/explain-offline-only",
			"No router was given, so this is the canonicalizer's reading alone.",
			"Pass a router (`centrs explain <router> '<input>'`) for completion, schema, and `:parse` evidence.",
		),
	];
	const warnings: Warning[] = [];
	const meta: EnvelopeMeta<ExplainOperationMeta> = {
		target: {},
		via: null,
		settings: {},
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
