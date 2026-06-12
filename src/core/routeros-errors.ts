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

import { CentrsError, type CentrsErrorCode } from "../errors.ts";

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
	/** Builds the normalized error fields from the regex match and raw string. */
	build: (match: RegExpMatchArray, raw: string) => RouterOsErrorRuleResult;
}

function cleanToken(token: string): string {
	return token.replace(/^["'`]+|["'`.,;:]+$/g, "");
}

/**
 * Ordered RouterOS error groundings (CHR 7.23). First match wins. Append new
 * rules here; keep the most specific patterns above broader ones.
 */
export const routerOsErrorRules: readonly RouterOsErrorRule[] = [
	{
		code: "routeros/unknown-path",
		description:
			"RouterOS did not recognize the command path or menu item ('no such ...').",
		test: /no such command prefix|no such item|no such entry/i,
		build: (_match, raw) => ({
			summary: `RouterOS does not recognize the path: ${raw.trim()}`,
			remediation:
				"Check the slash-prefixed RouterOS path against the device's command tree (use `--list-attributes` or `--no-validate` to narrow the mismatch).",
		}),
	},
	{
		code: "routeros/unknown-attribute",
		description: "RouterOS rejected an unknown parameter/attribute name.",
		// REST/native say "unknown parameter <name>"; the interactive console
		// (mac-telnet) says "bad parameter <name> (line N column M)" for the same
		// fault. Grounded on CHR 7.23.1.
		test: /(?:unknown|bad) parameter\s+(\S+)/i,
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
		build: (_match, raw) => ({
			summary: `RouterOS does not recognize the command: ${raw.trim()}`,
			remediation:
				"Check the slash-prefixed RouterOS path/command against the device's command tree.",
		}),
	},
	{
		code: "routeros/invalid-value",
		description: "RouterOS rejected the value supplied for an argument.",
		test: /invalid value (?:for argument|of)\s+(\S+)/i,
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
		code: "routeros/session-closed",
		description:
			"RouterOS closed the REST session before the request completed (60-second cap).",
		test: /session closed/i,
		build: () => ({
			summary: "RouterOS closed the session before the request completed.",
			remediation:
				"RouterOS enforces a 60-second hard timeout on REST sessions; reduce the scope of the request or choose a path that completes within that ceiling.",
		}),
	},
	{
		code: "routeros/command-failed",
		description:
			"Generic RouterOS command failure carrying a `failure: <msg>` string.",
		test: /^\s*failure:\s*(.+?)\s*$/i,
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
		description:
			"RouterOS /execute as-string returned a script :error value with source location.",
		test: /^\s*(.+?)\s*\(:error; line \d+\)\s*$/i,
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
		build: (_match, raw) => ({
			summary: `RouterOS does not recognize the path: ${raw.trim()}`,
			remediation:
				"Check the slash-prefixed RouterOS path against the device's command tree (use `--list-attributes` or `--no-validate` to narrow the mismatch).",
		}),
	},
];

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
	const baseContext: Record<string, unknown> = {
		detail: raw,
		...(opts.httpStatus !== undefined ? { httpStatus: opts.httpStatus } : {}),
	};

	for (const rule of routerOsErrorRules) {
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
			"Inspect the original RouterOS message; the command word, path, or an attribute is likely invalid.",
		context: { ...baseContext, ...opts.context },
		causeData: raw,
	});
}
