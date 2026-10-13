/**
 * CMR facts shared by the surfaces that can reach `/cmr/device/run-script`
 * directly (`api`, plain `execute`) and by `execute --cmr` (#450).
 */

import type { Warning } from "./envelope.ts";

/** The controller command that runs a script on CMR clients. */
export const CMR_RUN_SCRIPT_PATH = "/cmr/device/run-script";

const clientScriptNotValidated: Warning = {
	code: "cmr/client-script-not-validated",
	message:
		"Validation covered the controller request only; the `script=` sent to CMR clients was not validated on them. Use `centrs execute <controller> --cmr --labels <expr> -- '<command>'` to validate on each client first.",
	context: { path: CMR_RUN_SCRIPT_PATH },
};

/**
 * A caller-addressed `run-script` is validated as a controller request only:
 * `/console/inspect` checks its arguments, and the `script=` value is an opaque
 * string to the controller's `:parse`. The script itself then runs without validation
 * on every selected client, so say so next to the `passed` gate.
 */
export function cmrRunScriptWarnings(commandPath: string): Warning[] {
	if (commandPath.replace(/\/+$/, "") !== CMR_RUN_SCRIPT_PATH) return [];
	return [clientScriptNotValidated];
}

/**
 * Script-shaped `execute` input is opaque to the canonicalizer, so a
 * `run-script` inside it (console spacing, a `:do {}` body) is found by text.
 * A false positive costs only a warning.
 */
export function cmrScriptWarnings(script: string): Warning[] {
	return /cmr[\s/]+device[\s/]+run-script\b/.test(script)
		? [clientScriptNotValidated]
		: [];
}
