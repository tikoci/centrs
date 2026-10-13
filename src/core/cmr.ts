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
 * Whether `text` (a path, a command or a whole script) names the dashboard:
 * three consecutive words joined only by spaces or `/`, each a non-empty
 * prefix of `cmr`, `device`, `dashboard` in turn. That covers RouterOS abbreviations
 * (`/cmr/dev/dash`) and console spacing anywhere in a multi-line script. It
 * cannot follow a relative menu change across statements; a false positive
 * (a string spelling the same words) costs a refusal with this remediation.
 */
export function namesCmrDashboard(text: string): boolean {
	const words = [...text.matchAll(/[A-Za-z0-9-]+/g)].map((match) => ({
		word: match[0].toLowerCase(),
		start: match.index,
		end: match.index + match[0].length,
	}));
	for (let i = 0; i + 2 < words.length; i += 1) {
		const run = words.slice(i, i + 3);
		const matches = run.every((current, k) => {
			const target = CMR_DASHBOARD[k] as string;
			if (!target.startsWith(current.word)) return false;
			const previous = run[k - 1];
			return (
				previous === undefined ||
				/^[\s/]+$/.test(text.slice(previous.end, current.start))
			);
		});
		if (matches) return true;
	}
	return false;
}

/** Refuse the console-only CMR view before anything is dialed. */
export function assertNotCmrConsoleOnly(text: string): void {
	if (!namesCmrDashboard(text)) return;
	throw new CentrsError({
		code: "cmr/console-only",
		summary: `\`${DASHBOARD_PATH}\` (in any spelling) is an interactive console view, not an API command. Over the native API it closes the session; over REST it holds the controller's REST service for every caller until it times out.`,
		remediation:
			"Open it in WinBox 4 or WebFig, or run it in `centrs terminal <controller>`. For the data behind it, read `/cmr/device`, `/cmr/alert` or `/cmr/upgrade/job` with `centrs retrieve`.",
		context: { path: DASHBOARD_PATH, input: text },
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
