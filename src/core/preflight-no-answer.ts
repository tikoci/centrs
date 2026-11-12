/**
 * A validation check centrs sends before the command itself (`:parse`,
 * `/console/inspect`) that RouterOS did not answer (#638, #639). The generic
 * text for these codes is about a dispatched command whose reply was lost
 * ("may still be running"); here only the check was sent, so nothing ran.
 * The code is kept, and `context.commandSent` is `false`. Shared by
 * `execute`, `api` and `retrieve` (all its modes), which send the command
 * only after their checks answer.
 */

import { CentrsError } from "../errors.ts";
import type { RouterOsProtocol } from "../protocols/index.ts";

/**
 * RouterOS errors that mean the device did not answer a check at all, rather
 * than rejecting the command: REST's `Session closed` (60-second
 * session cap, or a router still busy with earlier requests, #638) and the
 * native-API `action timed out` trap (#639). The gate gave no verdict, so the
 * error keeps its own code and the device stage reads `not reached`.
 */
export const PREFLIGHT_NO_ANSWER_CODES: ReadonlySet<string> = new Set([
	"routeros/action-timed-out",
	"routeros/session-closed",
]);

/** A validation request sent before the command: its name and envelope source. */
export interface PreflightCheck {
	readonly name: string;
	readonly validationSource: string;
}

export const PARSE_CHECK: PreflightCheck = {
	name: "`:parse` check",
	validationSource: ":put [:parse ...]",
};

export const INSPECT_CHECK: PreflightCheck = {
	name: "`/console/inspect` check",
	validationSource: "/console/inspect request=child",
};

/**
 * The same code, with text for the preflight: the generic text for these codes
 * is about a dispatched command whose reply was lost ("may still be running"),
 * but here only a validation check was sent, so nothing ran.
 */
function preflightNoAnswerError(
	error: CentrsError,
	via: RouterOsProtocol,
	check: PreflightCheck,
): CentrsError {
	const what =
		error.code === "routeros/session-closed"
			? "closed the session"
			: "dropped the reply (action timed out)";
	return new CentrsError({
		code: error.code,
		summary: `RouterOS ${what} during the ${check.name}, so the command was not sent.`,
		remediation: `Nothing ran: centrs sends the command only after its ${check.name} is answered. The router was busy or slow to answer. Run the command again once it answers; \`centrs retrieve <target> /system/resource\` shows its load.`,
		context: {
			...error.context,
			via,
			validationSource: check.validationSource,
			commandSent: false,
		},
		...(error.position ? { position: error.position } : {}),
		cause: error,
		causeData: error.causeData,
	});
}

/**
 * `error` with preflight text when it is a no-answer from a check sent before
 * the command (see {@link preflightNoAnswerError}); otherwise `error` itself.
 */
export function asPreflightNoAnswer(
	error: unknown,
	via: RouterOsProtocol,
	check: PreflightCheck,
): unknown {
	return isPreflightNoAnswer(error)
		? preflightNoAnswerError(error, via, check)
		: error;
}

/** Whether `error` is a check RouterOS did not answer (see {@link PREFLIGHT_NO_ANSWER_CODES}). */
export function isPreflightNoAnswer(error: unknown): error is CentrsError {
	return (
		error instanceof CentrsError && PREFLIGHT_NO_ANSWER_CODES.has(error.code)
	);
}
