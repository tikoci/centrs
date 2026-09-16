/**
 * Stage 1 of the validation gate: the offline analyzer in front of the device
 * preflight (GH#354).
 *
 * centrs used to run two validators that did not know about each other — the
 * device preflight (`:put [:parse …]` plus `/console/inspect request=child`)
 * that `execute` / `api` / `validate` share, and offline `explain`, which is
 * byte-accurate and corpus-gated but took no part in validation at all. This
 * module is the seam that joins them: every CLI-shaped input is analyzed here
 * first, with no connection, and only then handed to the device stage.
 *
 * Three things that buys, in the order they matter:
 *
 * 1. A syntax fault is rejected with a **byte span** and **no round trip** — the
 *    protocol adapter is never even constructed.
 * 2. The device stage narrows to the semantic half it is actually needed for
 *    (`:parse` is name-level only; `/console/inspect` owns the attribute set).
 * 3. Where the device probe is unsafe or unavailable — the 7.12.2 class of
 *    problem in GH#343 — the gate degrades to a real gate instead of to nothing.
 *
 * **A clean offline pass is necessary, never sufficient.** `explain` publishes
 * `runtimeAcceptance: "not-proven"` for a reason: `/console/inspect` accepts
 * forms the runtime rejects, and the analyzer has no per-menu schema (decision 3
 * — no offline schema snapshot). The device stage is not optional and this
 * module never reports success on its behalf. `verdict: "warn"` is an
 * ABSTENTION, not a rejection, and passes through for the same reason.
 *
 * `--validate=false` disables BOTH stages — one flag, one meaning. That was
 * settled with the `--raw` precedence layer on GH#154 and is why callers gate
 * this on the same resolved `validate` setting as the device stage; the escape
 * hatch has to cover a stage-1 defect too (GH#355 is a live example of the
 * analyzer being wrong in the other direction).
 *
 * The offending byte range rides `context.span`, never {@link CentrsError}'s
 * `position`. `RouterOsErrorPosition` is documented as RouterOS's own
 * authoritative 1-based byte column, "carried verbatim; never re-derived"
 * (`errors.ts`) — synthesizing one from offline analysis would make a
 * centrs-derived offset indistinguishable from a device-reported one.
 */

import { CentrsError } from "./errors.ts";
import { type ExplainDiagnostic, explainCommand } from "./explain.ts";

/** Validator identity for `meta.validation` and error context. */
export const OFFLINE_GATE_SOURCE = "offline explain (canonicalizer)";

/** Which stage of the two-stage gate produced a verdict. */
export type ValidationStageName = "offline" | "device";

/** One rejected span, flattened out of {@link ExplainDiagnostic} for the error context. */
export interface OfflineGateFinding {
	/** The `explain/<analyzer>/<slug>` diagnostic code. */
	code: string;
	message: string;
	/** Byte offsets into the analyzed input, end-exclusive. */
	start: number;
	end: number;
}

/** Outcome of a stage-1 run that did not reject. */
export interface OfflineGateResult {
	/**
	 * `pass` — the analyzer read the whole input. `warn` — it ABSTAINED on part
	 * of it (an unresolved menu, say). Both proceed to the device stage; only
	 * `fail` throws.
	 */
	verdict: "pass" | "warn";
	/** Warning-severity diagnostics, kept so a caller can surface the abstention. */
	warnings: readonly OfflineGateFinding[];
}

function findingOf(diagnostic: ExplainDiagnostic): OfflineGateFinding {
	return {
		code: diagnostic.code,
		message: diagnostic.message,
		start: diagnostic.span.start,
		end: diagnostic.span.end,
	};
}

/**
 * Run the offline stage over a RouterOS CLI string.
 *
 * Throws `validation/syntax` when the analyzer rejects the input; returns the
 * verdict otherwise. Never opens a connection and never throws for any other
 * reason — `explainCommand` itself is documented as total.
 *
 * `surface` names the caller in the error context (`execute`, `api /execute`) so
 * a reader can tell which command's gate spoke; `via` is the resolved protocol
 * when the caller has one, purely for context.
 */
export function assertOfflineSyntax(
	command: string,
	options: { surface: string; via?: string },
): OfflineGateResult {
	const analysis = explainCommand(command);
	const errors = analysis.diagnostics.filter(
		(diagnostic) => diagnostic.severity === "error",
	);
	const warnings = analysis.diagnostics
		.filter((diagnostic) => diagnostic.severity === "warning")
		.map(findingOf);

	if (analysis.verdict !== "fail") {
		assertBalancedQuotes(command, options);
		return { verdict: analysis.verdict === "warn" ? "warn" : "pass", warnings };
	}

	// A `fail` verdict always carries at least one error diagnostic, but read it
	// defensively: an empty list would otherwise produce an error that says
	// nothing about what was wrong, which is worse than a generic summary.
	const findings = errors.map(findingOf);
	const first = findings[0];
	throw new CentrsError({
		code: "validation/syntax",
		summary: first
			? `RouterOS syntax rejected by offline analysis: ${first.message}`
			: "RouterOS syntax rejected by offline analysis.",
		remediation:
			"Run `centrs explain '<command>'` to see the offending bytes in context, " +
			"fix the syntax, then retry. `--validate=false` bypasses both validation " +
			"stages if you are deliberately probing a RouterOS edge centrs reads wrong.",
		context: {
			command,
			validationStage: "offline" satisfies ValidationStageName,
			validationSource: OFFLINE_GATE_SOURCE,
			surface: options.surface,
			...(options.via ? { via: options.via } : {}),
			...(first ? { span: { start: first.start, end: first.end } } : {}),
			diagnostics: findings,
		},
		causeData: first?.code ?? "offline analysis rejected the input",
	});
}

/**
 * The quote-balance supplement to the analyzer, and the reason stage 1 is not
 * `explainCommand` alone.
 *
 * `\'` is not a RouterOS string delimiter — it is not a legal token at all.
 * `:put \'abc\'` and `name=don\'t` are both rejected, balanced or not,
 * byte-identically on CHR 7.21.5 / 7.23.5 / 7.24.2 / 7.25beta3. The analyzer
 * passes all of them with zero diagnostics (GH#355), so dropping this check
 * would make stage 1 blind to a whole character class.
 *
 * This ran as a private `hasUnbalancedQuotes` preflight inside `execute`'s
 * device gate until GH#354. It belongs here instead: it opens no connection, so
 * filing it under the device stage made an error envelope report a `:parse` that
 * never happened.
 *
 * The rule below is the one that shipped, not the correct one — it models `\'`
 * as a delimiter and so only catches the UNBALANCED case. GH#355 owns replacing
 * it with "an apostrophe outside a `"`-string is a syntax error", which needs a
 * corpus census re-run because it can only add rejections. Until then, keeping
 * the weaker rule is strictly better than keeping none.
 *
 * Runs only AFTER the analyzer has passed, so a defect the analyzer can describe
 * precisely reports its byte span rather than this coarser message.
 */
function assertBalancedQuotes(
	command: string,
	options: { surface: string; via?: string },
): void {
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const char of command) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
		}
	}
	if (quote === undefined) {
		return;
	}
	throw new CentrsError({
		code: "validation/syntax",
		summary: `RouterOS syntax rejected by offline analysis: unterminated ${quote === '"' ? "string" : "`'`"} literal.`,
		remediation:
			"Close the RouterOS string quote, then retry. The command was not executed. " +
			"`--validate=false` bypasses both validation stages.",
		context: {
			command,
			validationStage: "offline" satisfies ValidationStageName,
			validationSource: `${OFFLINE_GATE_SOURCE} + quote balance`,
			surface: options.surface,
			...(options.via ? { via: options.via } : {}),
		},
		causeData: "unterminated string literal",
	});
}

/**
 * True when `error` is the rejection {@link assertOfflineSyntax} throws.
 *
 * Callers use this to build honest envelope metadata: on a stage-1 rejection the
 * device stage did not run, and no connection was opened, so the meta must not
 * claim `:parse` or `/console/inspect` failed.
 */
export function isOfflineGateRejection(error: unknown): boolean {
	return (
		error instanceof CentrsError &&
		error.code === "validation/syntax" &&
		(error.context?.["validationStage"] as string | undefined) === "offline"
	);
}
