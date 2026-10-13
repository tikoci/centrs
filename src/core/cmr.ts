/**
 * CMR facts shared by the surfaces that can reach `/cmr/device/run-script`
 * directly (`api`, plain `execute`) and by `execute --cmr` (#450).
 */

import { CentrsError } from "../errors.ts";
import type { Warning } from "./envelope.ts";

/** The controller command that runs a script on CMR clients. */
export const CMR_RUN_SCRIPT_PATH = "/cmr/device/run-script";

/**
 * The console-only live view. Grounded on 7.26beta1 CHR: over the native API
 * `/cmr/device/dashboard` closed the API session; over REST it never returned,
 * and every other REST call on the controller then waited 10–30 s.
 */
const CMR_DASHBOARD = ["cmr", "device", "dashboard"] as const;
const DASHBOARD_PATH = "/cmr/device/dashboard";

/**
 * Whether a structured RouterOS path (an `api` endpoint, or a single
 * `execute` command's path and verb) is the dashboard. Each segment may be an
 * abbreviation, as RouterOS accepts (`/cmr/dev/dash`). This needs no router, so
 * it refuses the plain spellings before anything is dialed.
 */
export function isCmrDashboardPath(path: string): boolean {
	const segments = path
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((segment) => segment.toLowerCase());
	return (
		segments.length === CMR_DASHBOARD.length &&
		segments.every((segment, k) =>
			(CMR_DASHBOARD[k] as string).startsWith(segment),
		)
	);
}

/**
 * Whether a `:parse` return invokes the dashboard. The device resolves every
 * spelling to one invocation: abbreviations, console spacing, a relative menu
 * change across `;` or a newline, and `:do`/`:if`/`[...]` bodies. Strings stay
 * `=` values and comments are dropped (7.26beta1 CHR). An invocation follows
 * the start of the IL, a `;` or another `(evl `. A string value sits after `=`.
 */
export function ilInvokesCmrDashboard(il: string): boolean {
	return /(?:^|;|\(evl )\(evl \/cmr\/device\/dashboard/.test(il);
}

function consoleOnlyError(input: string): CentrsError {
	return new CentrsError({
		code: "cmr/console-only",
		summary: `\`${DASHBOARD_PATH}\` (in any spelling) is an interactive console view, not an API command. Over the native API it closes the session; over REST it holds the controller's REST service for every caller until it times out.`,
		remediation:
			"Open it in WinBox 4 or WebFig, or run it in `centrs terminal <controller>`. For the data behind it, read `/cmr/device`, `/cmr/alert` or `/cmr/upgrade/job` with `centrs retrieve`.",
		context: { path: DASHBOARD_PATH, input },
	});
}

/** Refuse a structured dashboard path before anything is dialed. */
export function assertNotCmrDashboardPath(path: string): void {
	if (isCmrDashboardPath(path)) throw consoleOnlyError(path);
}

/** Refuse a command whose accepted `:parse` return invokes the dashboard. */
export function assertNotCmrDashboardIl(il: string, command: string): void {
	if (ilInvokesCmrDashboard(il)) throw consoleOnlyError(command);
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
