/**
 * The input corpus for the offline-entry browser consumer proof (#312).
 *
 * Its own module because both sides of the check read it: the driver
 * (`explain-browser-consumer.ts`) runs these through the Bun-native library,
 * and the worker entry — which is BUNDLED for the browser — runs the same list
 * through the bundle. One list, so the two sides cannot drift into comparing
 * different inputs.
 *
 * It must stay pure data with no imports but types: whatever this file pulls in
 * is bundled alongside `src/explain.ts` and would be measured as if the entry
 * had imported it.
 */

/** One input class the browser consumer must reproduce. */
export interface ConsumerCase {
	name: string;
	input: string;
	/** `explainCommand` options; both facets on unless a case needs otherwise. */
	options?: { tokens?: boolean; curl?: boolean };
}

/** Options a case runs under, with the shared default applied. */
export function caseOptions(testCase: ConsumerCase): {
	tokens?: boolean;
	curl?: boolean;
} {
	return testCase.options ?? { tokens: true, curl: true };
}

/**
 * The boundary corpus — the input classes #312 names, plus the two the entry's
 * own polyfill substitutions put at risk.
 *
 * `unicode` and `astral` are here because the browser bundle re-derives every
 * span from `analyzeCoordinates`: a position-mapping divergence shows up as a
 * span mismatch on exactly these, and on nothing else. `ipv6*` are here for the
 * polyfilled `isIP` (see the consumer's `ALLOWED_BUILTINS`) — a value-shape
 * hint is the only place its verdict is observable.
 */
export const BROWSER_CONSUMER_CASES: readonly ConsumerCase[] = [
	{ name: "normal-command", input: "/ip address print" },
	{
		name: "normal-write",
		input: "/ip address add address=10.0.0.1/24 interface=ether1",
	},
	{
		name: "multi-statement",
		input:
			"/ip address add address=1.1.1.1/24;\n/ip route print\n:put [/system identity get name]",
	},
	{
		name: "nested-block",
		input:
			':foreach i in=[/ip/route find] do={ :put $i; :if ($i > 1) do={ /log info message="x" } }',
	},
	{ name: "malformed-paren", input: "/ip) address\nadd address=1.1.1.1/24" },
	{
		name: "malformed-unterminated-string",
		input: '/log info message="unterminated',
	},
	{
		name: "malformed-missing-separator",
		input: "/ip address print /ip route print",
	},
	{ name: "unicode", input: '/system identity set name="café-日本語"' },
	{ name: "astral", input: '/log info message="emoji 🇯🇵🧑‍🚀 tail"' },
	{ name: "bom-leading", input: "﻿/system identity print" },
	{
		name: "ipv6-address",
		input: "/ipv6 address add address=2001:db8::1/64 interface=ether1",
	},
	{
		name: "ipv6-ambiguous",
		input: '/log info message="::ffff:192.0.2.1 and 1::2::3"',
	},
	{ name: "empty", input: "" },
	{
		name: "tokens-off",
		input: "/ip address print",
		options: { tokens: false, curl: false },
	},
];
