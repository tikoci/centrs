/**
 * CMR facts shared by the surfaces that can reach `/cmr/device/run-script`
 * directly (`api`, plain `execute`) and by `execute --cmr` (#450).
 */

import { CentrsError } from "../errors.ts";
import type { ProtocolAdapter } from "../protocols/adapter.ts";
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

/** The policies CMR gives every `run-script` script on a client (manual; 7.26beta1). */
export const CMR_SCRIPT_POLICIES = ["read", "write", "test", "reboot"] as const;

/** The controller login's own group and its granted policies. */
export interface CmrCallerPolicy {
	username: string;
	group: string;
	/** Granted policy names; `!name` entries are dropped. */
	policy: readonly string[];
}

/**
 * Read the session user's group policy on the controller, or `undefined` when
 * it cannot be read (a RADIUS login has no `/user` row). Grounded on
 * 7.26beta1 over REST and native API: a login with only `read` and `api`
 * (`!sensitive !policy` too) can read its own `/user` row and `/user/group`.
 */
export async function readCmrCallerPolicy(
	adapter: Pick<ProtocolAdapter, "apiRequest">,
	username: string,
): Promise<CmrCallerPolicy | undefined> {
	const first = async (path: string, name: string) => {
		const result = await adapter.apiRequest({
			verb: "print",
			path,
			query: [`name=${name}`],
		});
		return Array.isArray(result.data)
			? (result.data[0] as Record<string, string> | undefined)
			: undefined;
	};
	try {
		const group = (await first("/user", username))?.["group"];
		if (!group) return undefined;
		const policy = (await first("/user/group", group))?.["policy"];
		if (policy === undefined) return undefined;
		return {
			username,
			group,
			policy: policy
				.split(",")
				.map((name) => name.trim())
				.filter((name) => name.length > 0 && !name.startsWith("!")),
		};
	} catch {
		return undefined;
	}
}

/**
 * #456: RouterOS does not hold a CMR fleet command to the caller's policy. On
 * 7.26beta1 `run-script` needs only `read` + `api` on the controller login,
 * yet the script runs on each client (the controller's own row included) with
 * {@link CMR_SCRIPT_POLICIES}. A "reader" login wrote and rebooted clients
 * through it. Warn when the login lacks a policy the command will run with,
 * so a caller does not take the login for the limit; centrs' own write gate
 * is the only one. MikroTik says 7.26beta2 refuses this for a `read` group
 * (forum topic 273582, post 139); not yet checked on a beta2 build.
 */
export function cmrCallerPolicyWarning(
	caller: CmrCallerPolicy,
	runsWith: readonly string[],
): Warning | undefined {
	const missing = runsWith.filter((name) => !caller.policy.includes(name));
	if (missing.length === 0) return undefined;
	return {
		code: "cmr/caller-policy-not-enforced",
		message: `The controller login \`${caller.username}\` (group \`${caller.group}\`) lacks ${missing.join(", ")}, but CMR runs this on the clients with ${runsWith.join(", ")}. RouterOS 7.26beta1 does not check the caller's policy here, so the login does not limit what a CMR command can change (MikroTik says 7.26beta2 will).`,
		context: {
			username: caller.username,
			group: caller.group,
			missing,
			runsWith: [...runsWith],
		},
	};
}
