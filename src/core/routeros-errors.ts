/**
 * Grounded RouterOS error vocabulary.
 *
 * RouterOS surfaces faults as plain strings. Over REST those strings arrive in
 * the HTTP `detail` field (HTTP >=400); over the native API they arrive as the
 * `!trap` `message` attribute. Grounded on CHR 7.23, the two transports carry
 * the **same** text for the same fault, so one ordered rule table maps both.
 *
 * `mapRouterOsError` is the single place that turns a raw RouterOS string into a
 * typed `CentrsError`. New groundings are added by appending a rule to
 * `routerOsErrorRules`; the matcher is ordered, first-match-wins. Every mapping
 * preserves the original RouterOS string in `context.detail` so nothing is lost.
 *
 * The authoritative vocabulary is the live router's own strings (see
 * `docs/CONSTITUTION.md`, "Error model"). Ground new mappings on CHR evidence,
 * not on assumption.
 */

import {
	CentrsError,
	type CentrsErrorCode,
	type RouterOsErrorPosition,
} from "../errors.ts";

/**
 * Matches RouterOS's `(line N column M)` source location. Not anchored — the
 * console embeds it mid-string (e.g. `(evl bad parameter no-such-arg (line 1
 * column 28) /ip/address/add)`), so the location is found wherever it appears.
 */
const ROUTEROS_POSITION_RE = /\(line (\d+) column (\d+)\)/i;

/**
 * Extract RouterOS's `(line N column M)` parse position from a raw fault string,
 * or `undefined` when absent. The console `:parse` rejection carries it — either
 * bare (`bad parameter address (line 1 column 35)`) or embedded in the parsed
 * `(evl … (line N column M) /path)` form; REST/native `unknown parameter` strings
 * do not. `column` is RouterOS's authoritative 1-based **byte** offset — see
 * {@link RouterOsErrorPosition}.
 */
export function parseRouterOsPosition(
	text: string,
): RouterOsErrorPosition | undefined {
	const match = text.match(ROUTEROS_POSITION_RE);
	if (!match) {
		return undefined;
	}
	const line = Number.parseInt(match[1] ?? "", 10);
	const column = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(line) || !Number.isFinite(column)) {
		return undefined;
	}
	return { line, column };
}

/** Transport that produced the raw RouterOS string. */
export type RouterOsErrorTransport =
	| "rest-api"
	| "native-api"
	| "mac-telnet"
	| "ssh";

/** Options that refine how a raw RouterOS string is mapped. */
export interface MapRouterOsErrorOptions {
	/** Transport the string came from; selects the catch-all code. */
	transport?: RouterOsErrorTransport;
	/** HTTP status, when the string came from a REST `detail` body. */
	httpStatus?: number;
	/** Extra context merged into the resulting error (caller wins). */
	context?: Record<string, unknown>;
}

/** What a rule's `build` step contributes to the resulting error. */
export interface RouterOsErrorRuleResult {
	summary: string;
	remediation: string;
	context?: Record<string, unknown>;
}

/**
 * One ordered grounding rule. `test` is matched (case-insensitively) against the
 * trimmed RouterOS string; the first rule whose `test` matches wins and its
 * `build` produces the normalized error fields.
 */
export interface RouterOsErrorRule {
	/** Normalized `routeros/*` code this rule yields. */
	code: CentrsErrorCode;
	/** One-line human description of the fault class (used for docs/tests). */
	description: string;
	/** Pattern matched against the trimmed RouterOS string. */
	test: RegExp;
	/**
	 * HTTP status the rule is limited to. When set, the rule matches only a REST
	 * reply with that status; a native trap or `/execute` text never matches it.
	 */
	httpStatus?: number;
	/**
	 * Anchored form safe for classifying a successful transport's returned text.
	 * Unlike an HTTP error body / native trap, `/execute as-string` also carries
	 * ordinary stdout, so substring matches would turn user output into failures.
	 */
	resultTest?: RegExp;
	/** Builds the normalized error fields from the regex match and raw string. */
	build: (match: RegExpMatchArray, raw: string) => RouterOsErrorRuleResult;
}

const UNKNOWN_PATH_REMEDIATION =
	"Check the path and verb against the device's command tree with `centrs explain <router> '<command>'`. A menu path alone is not a command: add a verb such as `print`. A menu whose package is not installed is missing too.";

const NO_SUCH_ITEM_REMEDIATION =
	"The menu exists, but no item matches the `.id`, number or name given. List the items with `centrs retrieve <router> <menu>` and use an `.id` from that list; a number from an earlier `print` does not carry over to another session.";

function cleanToken(token: string): string {
	return token.replace(/^["'`]+|["'`.,;:]+$/g, "");
}

/**
 * Ordered RouterOS error groundings (CHR 7.23). First match wins. Append new
 * rules here; keep the most specific patterns above broader ones.
 */
export const routerOsErrorRules: readonly RouterOsErrorRule[] = [
	{
		code: "routeros/permission-denied",
		description:
			"RouterOS refused the command because the user's group lacks a policy it needs.",
		// Grounded on CHR 7.25. REST answers HTTP 500 with this as `detail`:
		// `not enough permissions (9)` for a write without `write`, and
		// `std failure: not allowed (9)` for any request (even a GET) when the
		// group has `rest-api` but not `api` (fixed in 7.26beta3). The native API traps with the
		// first string; `/execute as-string` returns it as text with a
		// `(<path>; line N)` suffix. In a multi-statement script the refusal is
		// the last line, after earlier statements' stdout (#549: `:put
		// "p5-first"; /system/identity/set …` as a read-only user returns HTTP
		// 200 with ret `p5-first\r\nnot enough permissions (9)
		// (/system/identity/set; line 1)`, identical on native-api), so the
		// trailed form matches too — with the location suffix required, so a
		// script that merely prints the bare phrase stays ordinary output.
		test: /not enough permissions|not allowed \(9\)/i,
		resultTest:
			/^(?:not enough permissions \(9\)(?: \(\/[^\s();]+; line \d+\))?|[\s\S]*\r?\nnot enough permissions \(9\) \(\/[^\s();]+; line \d+\))$/i,
		build: (_match, raw) => ({
			summary: `RouterOS refused the command for lack of permission: ${raw.trim()}`,
			remediation:
				"Grant the missing policy to the RouterOS user's group (`/user/group`): `read` for reads, `write` for changes. If every REST request fails with `not allowed (9)`, the group has `rest-api` without `api`; before RouterOS 7.26beta3, REST needs both. Retrying will not help.",
		}),
	},
	{
		code: "routeros/no-such-item",
		description:
			"The menu exists, but no item matches the id, number or name given ('no such item').",
		// Grounded on CHR 7.25.1 (#659). The native API traps with `no such
		// item` (`/system/script/run number=nosuch`), or `no such item (4)`
		// (`/ip/address/remove numbers=*FFFF`). `/execute as-string` returns
		// `no such item (4) (/ip/address/set; line 1)` as text on both transports.
		test: /no such item|no such entry/i,
		resultTest: /^(?:failure:\s*)?(?:no such item|no such entry)\b.*$/i,
		build: (_match, raw) => ({
			summary: `RouterOS has no such item: ${raw.trim()}`,
			remediation: NO_SUCH_ITEM_REMEDIATION,
		}),
	},
	{
		code: "routeros/no-such-item",
		description:
			"REST answered HTTP 404: the menu exists, but no item matches the id, number or name given.",
		// Grounded on CHR 7.25.1 (#659). REST answers a missing item with a bare
		// `{"error":404,"message":"Not Found"}` and no `detail`, for a GET of
		// `/rest/ip/address/*FFFF` and a POST of `/system/script/run
		// number=nosuch`, `/ip/address/remove .id=*FFFF` or `/file/get
		// .id=<missing>`. An unknown path is HTTP 400, never 404.
		httpStatus: 404,
		test: /"error"\s*:\s*404\b/,
		build: () => ({
			summary: "RouterOS has no such item: REST answered HTTP 404 Not Found.",
			remediation: NO_SUCH_ITEM_REMEDIATION,
		}),
	},
	{
		code: "routeros/unknown-path",
		description: "RouterOS has no command at the path ('no such command ...').",
		// Grounded on CHR 7.25.1 (#659), the same text on REST `detail` (HTTP
		// 400) and the native `!trap`: `no such command prefix` for an unknown
		// menu under a known one, `no such command` for a menu or command with
		// no such verb (`/system/reboot/print`, a bare `/system/identity`), and
		// REST's `no such command or directory (<word>)` for an unknown top word.
		test: /no such command(?: prefix| or directory)?\b/i,
		resultTest:
			/^(?:failure:\s*)?no such command(?: prefix| or directory)?\b.*$/i,
		build: (_match, raw) => ({
			summary: `RouterOS has no command at this path: ${raw.trim()}`,
			remediation: UNKNOWN_PATH_REMEDIATION,
		}),
	},
	{
		code: "routeros/unknown-attribute",
		description: "RouterOS rejected an unknown parameter/attribute name.",
		// REST/native say "unknown parameter <name>"; the interactive console
		// (mac-telnet) says "bad parameter <name> (line N column M)" for the same
		// fault. Grounded on CHR 7.23.1.
		test: /(?:unknown|bad) parameter\s+(\S+)/i,
		resultTest: /^(?:failure:\s*)?(?:unknown|bad) parameter\s+\S+.*$/i,
		build: (match) => {
			const parameter = cleanToken(match[1] ?? "");
			return {
				summary: `RouterOS does not recognize the parameter "${parameter}".`,
				remediation:
					"Remove or rename the attribute; use `--list-attributes` to see the parameters this RouterOS path accepts.",
				context: { parameter },
			};
		},
	},
	{
		code: "routeros/unknown-path",
		description:
			"RouterOS console rejected the command word ('bad command name …').",
		// Console form (mac-telnet) of an unrecognized command/path word.
		test: /bad command name/i,
		resultTest: /^(?:failure:\s*)?(?:\(<%%\s*)?bad command name\b.*$/i,
		build: (_match, raw) => ({
			summary: `RouterOS has no command at this path: ${raw.trim()}`,
			remediation: UNKNOWN_PATH_REMEDIATION,
		}),
	},
	{
		code: "routeros/invalid-value",
		description: "RouterOS rejected the value supplied for an argument.",
		test: /invalid value (?:for argument|of)\s+(\S+)/i,
		resultTest: /^(?:failure:\s*)?invalid value (?:for argument|of)\s+\S+.*$/i,
		build: (match) => {
			const argument = cleanToken(match[1] ?? "");
			return {
				summary: `RouterOS rejected the value supplied for "${argument}".`,
				remediation:
					"Supply a value that matches the argument's expected type/format for this RouterOS path.",
				context: { argument },
			};
		},
	},
	{
		code: "routeros/invalid-value",
		description:
			"RouterOS rejected a value because it does not match the accepted domain.",
		test: /input does not match/i,
		resultTest: /^(?:failure:\s*)?input does not match\b.*$/i,
		build: (_match, raw) => ({
			summary: `RouterOS rejected the supplied value: ${raw.trim()}`,
			remediation:
				"Check the accepted values for this command on the target RouterOS version, then retry with a matching value.",
		}),
	},
	{
		code: "routeros/session-closed",
		description:
			"RouterOS closed the REST session before the request completed (60-second cap).",
		test: /session closed/i,
		resultTest: /^(?:failure:\s*)?session closed\b.*$/i,
		build: () => ({
			summary: "RouterOS closed the session before the request completed.",
			remediation:
				"RouterOS ends a REST request after 60 seconds, or sooner when it is still busy with earlier requests, and `--timeout` cannot extend that. A command that was already sent may still be running or may have finished, so check the router's state before running it again. Keep each REST call under 60 seconds: start long work in the background (`:execute {…}` without `as-string` runs it as a `/system/script/job`) and poll for its result (`centrs retrieve … --wait 2m --until …`).",
		}),
	},
	{
		code: "routeros/action-timed-out",
		description:
			"RouterOS dropped the reply of a command with its own reply limit (native-API `action timed out (13)`).",
		// Grounded on CHR 7.24.6, 7.25 and 7.25.1 (#639): the native API traps
		// with `action timed out (13)` when `/execute as-string` finishes a
		// script that ran longer than about 60 s (7.24.6: at a fixed 60 s while
		// the script keeps running), and `/container/shell` traps at about 60 s
		// while its command keeps running. These are per-command limits;
		// structured native-API commands collect replies until `!done`.
		test: /\baction timed out\b/i,
		build: () => ({
			summary:
				"RouterOS dropped the reply for this command (action timed out): the command may still be running, or may have finished.",
			remediation:
				"This RouterOS command has its own reply limit of about 60 seconds (a script run through `/execute as-string`, `/container/shell`); centrs `--timeout` does not extend it. Check the router's state before running the command again. For long work, start it in the background (`:execute {…}` without `as-string` runs it as a `/system/script/job`) and poll for its result (`centrs retrieve … --wait 2m --until …`), or bound it with the command's own timeout where it has one (`/container/shell timeout=<seconds>`, bare seconds).",
		}),
	},
	{
		code: "routeros/command-failed",
		description:
			"Generic RouterOS command failure carrying a `failure: <msg>` string.",
		test: /^\s*failure:\s*(.+?)\s*$/i,
		resultTest: /^\s*failure:\s*.+?\s*$/i,
		build: (match) => {
			const failure = (match[1] ?? "").trim();
			return {
				summary: `RouterOS command failed: ${failure}`,
				remediation:
					"Inspect the RouterOS failure message, then adjust the path, attributes, or request shape accordingly.",
				context: { failure },
			};
		},
	},
	{
		code: "routeros/command-failed",
		description: "Generic RouterOS command failure carrying an error prefix.",
		test: /^\s*error:\s*(.+?)\s*$/i,
		resultTest: /^\s*error:\s*.+?\s*$/i,
		build: (match) => {
			const failure = (match[1] ?? "").trim();
			return {
				summary: `RouterOS command failed: ${failure}`,
				remediation:
					"Inspect the RouterOS error message, then adjust the script or request shape accordingly.",
				context: { failure },
			};
		},
	},
	{
		code: "routeros/command-failed",
		description:
			"RouterOS /execute as-string returned a script :error value with source location.",
		test: /^\s*(.+?)\s*\(:error; line \d+\)\s*$/i,
		resultTest: /^\s*.+?\s*\(:error; line \d+\)\s*$/i,
		build: (match) => {
			const failure = (match[1] ?? "").trim();
			return {
				summary: `RouterOS command failed: ${failure}`,
				remediation:
					"Inspect the RouterOS failure message, then adjust the script or request shape accordingly.",
				context: { failure },
			};
		},
	},
	{
		// Bare path-shaped `<path> not found` (no `failure:` prefix). Placed AFTER
		// `routeros/command-failed` so a `failure: <object> not found` command
		// rejection is classified as a command failure, not a path mismatch.
		code: "routeros/unknown-path",
		description: "RouterOS reported a path-shaped 'not found'.",
		test: /not found/i,
		resultTest: /^\s*\/\S+\s+not found\s*$/i,
		build: (_match, raw) => ({
			summary: `RouterOS has no command at this path: ${raw.trim()}`,
			remediation: UNKNOWN_PATH_REMEDIATION,
		}),
	},
];

/**
 * Grounded result shapes that intentionally use the transport-specific
 * catch-all mapping. They are errors, but do not carry enough information for a
 * more specific normalized code.
 */
const ROUTEROS_RESULT_CATCH_ALL =
	/^(?:syntax error|expected (?:end of command|command name|input value))\b[^\n]*$/i;

/**
 * Map text returned by a successful transport only when it matches a grounded,
 * stdout-safe result shape. Returns `undefined` for ordinary script output.
 */
export function mapRouterOsResultError(
	raw: string,
	opts: MapRouterOsErrorOptions = {},
): CentrsError | undefined {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return undefined;
	const matched =
		ROUTEROS_RESULT_CATCH_ALL.test(trimmed) ||
		routerOsErrorRules.some((rule) => rule.resultTest?.test(trimmed));
	return matched ? mapRouterOsError(raw, opts) : undefined;
}

/**
 * Maps a raw RouterOS error string to a normalized {@link CentrsError}.
 *
 * Matching is case-insensitive and tolerant of leading/trailing whitespace and
 * an optional `failure: ` prefix. When no rule matches, the catch-all depends on
 * the transport: native API yields `routeros/api-trap`, REST yields
 * `routeros/request-failed`. The original string is always preserved in
 * `context.detail` (and `cause` for the catch-all).
 */
export function mapRouterOsError(
	raw: string,
	opts: MapRouterOsErrorOptions = {},
): CentrsError {
	const trimmed = raw.trim();
	const position = parseRouterOsPosition(raw);
	const baseContext: Record<string, unknown> = {
		detail: raw,
		...(opts.httpStatus !== undefined ? { httpStatus: opts.httpStatus } : {}),
	};

	for (const rule of routerOsErrorRules) {
		if (rule.httpStatus !== undefined && rule.httpStatus !== opts.httpStatus) {
			continue;
		}
		const match = trimmed.match(rule.test);
		if (!match) {
			continue;
		}
		const result = rule.build(match, raw);
		return new CentrsError({
			code: rule.code,
			summary: result.summary,
			remediation: result.remediation,
			context: { ...baseContext, ...result.context, ...opts.context },
			...(position ? { position } : {}),
			causeData: raw,
		});
	}

	const catchAllCode: CentrsErrorCode =
		opts.transport === "rest-api" ||
		opts.transport === "mac-telnet" ||
		opts.transport === "ssh"
			? "routeros/request-failed"
			: "routeros/api-trap";

	return new CentrsError({
		code: catchAllCode,
		summary: trimmed
			? `RouterOS reported an error: ${trimmed}`
			: "RouterOS reported an unspecified error.",
		remediation:
			"RouterOS reported an error, and its message is the reason. The command may have partly run: before repeating a write, check the router's state, since a rerun repeats every step before the error. If the message names part of the input (a path, parameter or value), fix that; otherwise the router may be busy or the operation unavailable right now.",
		context: { ...baseContext, ...opts.context },
		...(position ? { position } : {}),
		causeData: raw,
	});
}
