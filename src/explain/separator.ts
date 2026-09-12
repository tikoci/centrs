/**
 * The missing statement separator between two command-shaped runs (#311).
 *
 * RouterOS accepts slash-shaped operands after a verb — `/file remove
 * /flash/skins/foo.html` lowers cleanly to `numbers=/flash/skins/foo.html` — so
 * "a `/` after the verb" is NOT the signal, and a rule built on it would reject
 * valid input. What the device rejects is narrower: a known **menu** path in
 * operand position, followed by a console **verb**.
 *
 * ## What the device actually does (CHR 7.24.2, `:parse` + `highlight`)
 *
 * #311 reported the error byte as the `=` of the trailing attribute
 * (`expected end of command (line 1 column 55)` for `/ip/address add
 * interface=ether1 /ip/route add gateway=192.168.88.1`). Probing the shape
 * around that row shows the `=` is an ARTEFACT of that particular head:
 * `add` abbreviates `/ip/address/add`'s own `address=` argument, so the console
 * reads `add gateway` as `address=gateway` and only complains at the `=` after
 * it. Vary the head so the second verb abbreviates nothing and the byte moves —
 * `/system/note set note=hello /ip/route add gateway=1.2.3.4` is not a hard
 * reject at all; `:parse` returns IL carrying `bad parameter /ip/route
 * (line 1 column 38)`, naming the second PATH. The same input also proves the
 * head's own argument list is not safe to keep: `… /ip/route add placeholder` lowers
 * to `address=placeholder;;interface=ether1`, a phantom attribute the source never
 * wrote, and whether that happens depends on per-menu argument names — schema
 * knowledge offline does not ship.
 *
 * So the grounded invariant is: **RouterOS never accepts a known menu path
 * followed by a verb in operand position.** Across every probed row it answers
 * either `bad parameter <that path>` or `expected end of command`; none is
 * clean. It is also the shape with an obvious fix, which is what makes it worth
 * a diagnostic rather than an abstention.
 *
 * ## What this deliberately does not decide
 *
 * A bare operand the head does not accept (`… placeholder`, `/file remove a b`) also
 * draws `bad parameter`, and so does a menu path with no verb after it
 * (`… /ip/route`). Those are the generic "this menu takes no such positional"
 * complaint — deciding them needs the per-menu positional list, which
 * `catalog.ts` deliberately is not, and a separator is not necessarily the fix.
 * They abstain.
 *
 * The rule reads only what the argument lexer already DECIDED. It never
 * re-scans bytes, so a `[…]` substitution (a located token the lexer declined
 * to decode, hence no `value` and no operand), a `{…}` body (a separate
 * flattened statement), a quoted operand and a `/` inside a VALUE are all
 * outside its input by construction rather than by a guard it could get wrong.
 * `bareOperand` is that construction: `value` absent is the lexer saying it
 * decoded nothing, whatever the token's bytes spell.
 *
 * ## The reach it has, stated
 *
 * The input is `lexArgumentTokens`, the skip-tolerant reading (#316), never the
 * strict `lexArguments`. The strict lexer discards every token it decoded as
 * soon as it declines one, so a statement holding a variable — `… gateway=$g` —
 * used to carry no token list for this rule at all and the run in it was missed
 * while its literal twin was found. The tolerant reading locates the
 * undecodable token and keeps walking, so the run is found on either side of
 * it; that the strict reading still refuses the statement is correct and
 * separate, since nothing here makes `$g` renderable.
 *
 * What remains out of reach is an unterminated string and an unbalanced
 * delimiter, where no walk can find a boundary to resume from. That is still a
 * reach limit rather than a judgement: nothing here decides those shapes are
 * acceptable.
 */

import type { Argument } from "./args.ts";
import { isKnownMenuPath } from "./is-known-menu.ts";
import { VERBS } from "./verbs.ts";

/** A second command-shaped run where a `;` or newline should have been. */
export interface MissingSeparator {
	/** The whole second run — first byte of its path through the end of its verb. */
	span: { start: number; end: number };
	/** Where a `;` or newline belongs: the first byte of the second path. */
	insertAt: number;
	/** The second run's menu path, slash-spelled and leading-slashed. */
	path: string;
	/** The verb token that closed the second run. */
	verb: string;
}

// Both patterns below admit a segment that STARTS WITH A DIGIT. `/interface/6to4`
// is the shipped tables' one such name — a menu in both `MENU_PATHS` and
// `PATH_CATALOG` — and requiring a leading letter made every spelling of it miss
// the rule. These are only a cheap shape filter; presence in the structure table
// is the actual gate, so a wider first character cannot admit a path the table
// does not already list.

/** A bare path segment run, `route` or `firewall/filter`, with no leading slash. */
const RELATIVE_SEGMENTS =
	/^[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9-]*)*$/;

/** An absolute menu path spelled with slashes, `/ip` or `/ip/firewall/filter`. */
const ABSOLUTE_SEGMENTS =
	/^\/[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9-]*)*$/;

/**
 * A positional whose source text IS its value — so it carries no quotes, no
 * substitution and no escape. `Argument.value` is already quote-stripped, which
 * makes the comparison the whole quoting check; `value` absent means the lexer
 * declined to decode the token and there is nothing to match against.
 */
function bareOperand(token: Argument | undefined): string | undefined {
	if (token === undefined || token.kind !== "positional") return undefined;
	if (token.value === undefined || token.value !== token.text) return undefined;
	return token.value;
}

/**
 * Every complete second command-shaped run in one statement's argument tokens.
 *
 * Coordinate-space agnostic: the spans come back in whatever space `tokens`
 * were lexed in, so the caller passes document-rebased tokens and gets document
 * offsets.
 */
export function findMissingSeparators(
	tokens: readonly Argument[],
): MissingSeparator[] {
	const out: MissingSeparator[] = [];
	let i = 0;
	while (i < tokens.length) {
		const run = separatorAt(tokens, i);
		if (run === null) {
			i++;
			continue;
		}
		out.push(run.separator);
		i = run.next;
	}
	return out;
}

/** One run starting at `i`, or `null` when the tokens there are not that shape. */
function separatorAt(
	tokens: readonly Argument[],
	i: number,
): { separator: MissingSeparator; next: number } | null {
	const head = bareOperand(tokens[i]);
	if (head === undefined || !ABSOLUTE_SEGMENTS.test(head)) return null;
	const run = longestKnownMenuRun(tokens, i, head);
	if (run === null) return null;
	const verb = bareOperand(tokens[run.last + 1]);
	if (verb === undefined || !VERBS.has(verb)) return null;
	const pathStart = tokens[i]?.span.start;
	const verbEnd = tokens[run.last + 1]?.span.end;
	if (pathStart === undefined || verbEnd === undefined) return null;
	return {
		separator: {
			span: { start: pathStart, end: verbEnd },
			insertAt: pathStart,
			path: `/${run.segments.join("/")}`,
			verb,
		},
		next: run.last + 2,
	};
}

/**
 * The longest run of operands from `i` that spells a known menu path.
 *
 * A menu path may be written with slashes, spaces, or a mix (Q3 rule R4), so
 * `/ip/route`, `/ip route` and `/ip route` split across operands are the same
 * path and all of them have to be reachable — the device rejects the spaced
 * spelling identically. Longest wins: `/ip route` is a menu and so is `/ip`, and
 * only the longer one leaves `add` in verb position. `null` when no prefix is a
 * known menu — absence in the structure table abstains and never asserts a
 * command (`is-known-menu.ts`).
 */
function longestKnownMenuRun(
	tokens: readonly Argument[],
	i: number,
	head: string,
): { last: number; segments: string[] } | null {
	const segments = head.slice(1).split("/");
	const runs: { last: number; segments: string[] }[] = [];
	if (isKnownMenuPath(segments))
		runs.push({ last: i, segments: [...segments] });
	for (let j = i + 1; j < tokens.length; j++) {
		const next = bareOperand(tokens[j]);
		if (next === undefined || !RELATIVE_SEGMENTS.test(next)) break;
		segments.push(...next.split("/"));
		if (isKnownMenuPath(segments))
			runs.push({ last: j, segments: [...segments] });
	}
	return runs.at(-1) ?? null;
}
