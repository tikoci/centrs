/**
 * CMR facts shared by the surfaces that can reach `/cmr/device/run-script`
 * directly (`api`, plain `execute`) and by `execute --cmr` (#450).
 */

import { CentrsError } from "../errors.ts";
import type { Warning } from "./envelope.ts";

/** The controller command that runs a script on CMR clients. */
export const CMR_RUN_SCRIPT_PATH = "/cmr/device/run-script";

/**
 * Console-only live views. Grounded on 7.26beta1 CHR: over the native API
 * `/cmr/device/dashboard` closed the API session; over REST it never returned,
 * and every other REST call on the controller then waited 10–30 s.
 */
const CMR_CONSOLE_ONLY: ReadonlySet<string> = new Set([
	"/cmr/device/dashboard",
]);

/**
 * Refuse a console-only CMR view before anything is dialed. Matches the
 * literal path only; an abbreviated spelling is not recognized.
 */
export function assertNotCmrConsoleOnly(commandPath: string): void {
	const path = withoutTrailingSlashes(commandPath);
	if (!CMR_CONSOLE_ONLY.has(path)) return;
	throw new CentrsError({
		code: "cmr/console-only",
		summary: `\`${path}\` is an interactive console view, not an API command. Over the native API it closes the session; over REST it holds the controller's REST service for every caller until it times out.`,
		remediation:
			"Open it in WinBox 4 or WebFig, or run it in `centrs terminal <controller>`. For the data behind it, read `/cmr/device`, `/cmr/alert` or `/cmr/upgrade/job` with `centrs retrieve`.",
		context: { path },
	});
}

function withoutTrailingSlashes(path: string): string {
	// A loop, not `/\/+$/`: that regex is quadratic on a long run of `/`.
	let end = path.length;
	while (end > 0 && path[end - 1] === "/") end -= 1;
	return path.slice(0, end);
}

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
	if (withoutTrailingSlashes(commandPath) !== CMR_RUN_SCRIPT_PATH) return [];
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
