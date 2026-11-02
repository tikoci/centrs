/**
 * RouterOS menu-path grammar for the read surfaces (`retrieve`, `api`) and
 * the REST URL guard every REST request passes through (#586).
 *
 * Every dir and command name in the RouterOS 7.9–7.26 command tree (rosetta
 * v0.12.0, 579 dirs / 5370 commands) is letters, digits and hyphens,
 * starting with a letter or digit (`/interface/6to4`); case folds. Anything else
 * in a menu segment is not a menu, and some of it changes what the request
 * addresses: in a REST URL, `#` and `?` turn the appended `/print` into a
 * fragment or query, so `retrieve '/system/reboot#'` posted to
 * `/rest/system/reboot` and rebooted the router (CHR 7.24.5).
 */

import { CentrsError } from "../errors.ts";
import { pathTokens } from "./inspect.ts";

const MENU_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/** The menu segments of `path` that are not RouterOS menu or command names. */
export function invalidMenuSegments(path: string): string[] {
	// Case folds, as RouterOS menus do (`src/explain/menus.ts` isMenuPath);
	// letter case cannot change how a URL parses, so it is not a hazard.
	return pathTokens(path).filter(
		(segment) => !MENU_SEGMENT.test(segment.toLowerCase()),
	);
}

/**
 * Reject a read-surface path whose segments are not RouterOS menu names.
 * Runs before any network work and regardless of `--validate`: that flag
 * skips command validation, not the guarantee that a read dispatches a read.
 */
export function assertRouterOsMenuPath(
	path: string,
	context: { readonly flag?: string; readonly endpoint?: string } = {},
): void {
	const invalid = invalidMenuSegments(path);
	if (invalid.length === 0) {
		return;
	}
	throw new CentrsError({
		code: "input/invalid-routeros-path",
		summary: `RouterOS path ${JSON.stringify(path)} has a segment that is not a menu name: ${invalid.map((segment) => JSON.stringify(segment)).join(", ")}.`,
		remediation:
			"Write the menu path with letters, digits and hyphens between slashes, such as `/ip/address` or `/system/resource`. Filter rows with `--query`, not characters in the path.",
		context: { path, invalidSegments: invalid, ...context },
	});
}

/**
 * Characters and segments that make a WHATWG URL address something other
 * than the path as written: `?` starts a query, `#` a fragment, `\` is read
 * as `/`, tabs and newlines are stripped, and `.`/`..` segments collapse
 * (also percent-encoded: `%2e%2e`, `.%2E`).
 * RouterOS does not decode percent-escapes in REST paths (`reboot%23` is
 * "no such command or directory" on CHR 7.24.5), so the rest is inert.
 */
function hasUrlStructuralCharacter(path: string): boolean {
	for (const char of path) {
		const code = char.charCodeAt(0);
		if (char === "?" || char === "#" || char === "\\") return true;
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

/** `.`/`..` and the percent-encoded forms WHATWG also collapses (`%2e%2e`, `.%2E`). */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * Refuse a REST request path that the URL parser would rewrite. This is the
 * backstop under every REST caller (retrieve, api, execute, transfer, explain)
 * so an appended `/print` can never be cut off before dispatch.
 */
export function assertRestRequestPath(path: string): void {
	const dotSegment = path
		.split("/")
		.some((segment) => DOT_SEGMENT.test(segment));
	if (!hasUrlStructuralCharacter(path) && !dotSegment) {
		return;
	}
	throw new CentrsError({
		code: "input/invalid-routeros-path",
		summary: `Refusing REST request path ${JSON.stringify(path)}: it contains characters the URL would reinterpret (?, #, \\, control characters, or a . / .. segment), so the request would not reach the path as written.`,
		remediation:
			"Remove the character from the path. Pass filters with `--query` and values as fields; names containing these characters can be selected with a query instead of the URL path.",
		context: { path, via: "rest-api" },
	});
}
