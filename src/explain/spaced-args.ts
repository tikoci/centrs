/**
 * The space-for-`=` argument spelling (#350).
 *
 * RouterOS lets a space stand in for the `=` of an ordinary command argument:
 * `/ip/firewall/layer7-protocol add comment "something" regexp 1.1` lowers to
 * `(evl /ip/firewall/layer7-protocol/addcomment=something;regexp=1.1)`, byte for
 * byte the IL of the `=` spelling, and the spellings mix freely. That is not a
 * schema-free rule. The device pairs `comment` with `"something"` because it
 * knows `/ip/firewall/layer7-protocol/add` has a `comment` argument:
 * `/system/script add zzznotanarg beep` is `bad parameter zzznotanarg` on
 * 7.24.5 and `expected end of command` on 7.22.1.
 *
 * ## What the device actually does (CHR 7.22.1 and 7.24.5, `:parse` + `highlight`)
 *
 * Identical on both builds:
 *
 * | input | IL | `highlight` on the gap |
 * | ----- | -- | ---------------------- |
 * | `/interface set ether1 comment "x"` | `setcomment=x;numbers=ether1` | `syntax-obsolete` |
 * | `/interface set ether1 name x` | `setname=x;numbers=ether1` | `syntax-obsolete` |
 * | `/interface set ether1 disabled yes` | `setdisabled=true;numbers=ether1` | `syntax-obsolete` |
 * | `/user group set full policy "read,write"` | `setnumbers=full;policy=read,write` | `syntax-obsolete` |
 * | `/interface print detail without-paging` | `printdetail=true;without-paging=true` | none |
 *
 * Two facts come out of that table, and they are why this module has two
 * outputs rather than one.
 *
 * - **Two adjacent bare operands have no schema-free reading.** `name x` is an
 *   argument and its value; `detail without-paging` is two value-less flags;
 *   `ether1 name` is an unnamed `numbers` operand and then an argument name. The
 *   bytes are the same shape in all three. So the strict reading ABSTAINS on any
 *   such pair: it never publishes `args: {}` plus a positional list, which
 *   claims the list was read and holds no arguments.
 * - **The obsolete marker follows the value, not the name.** The device marks
 *   the gap `syntax-obsolete` exactly when it paired the words, and a flag pair
 *   gets no marker. Offline can see one half of that: a second operand that is
 *   not itself name-shaped (`"x"`, `1.1`, `10s`, `$v`) cannot be a flag, so the
 *   pair is very probably the spaced spelling and gets a warning. A bare-word
 *   second operand (`name x`, `disabled yes`) is also obsolete on device, but
 *   offline cannot tell it from `detail without-paging`, so it abstains with no
 *   warning rather than flagging the most common `print` spelling there is. The
 *   warning says "possible"; a live probe (#491) is what makes it definite.
 *
 * ## What this deliberately does not decide
 *
 * Root statements are out of scope. A scripting directive's operands are
 * positional by grammar, not spelling: `:pick abc 0 1` lowers to
 * `pickbegin=0;counter=abc;end=1`, and `:local t 200ms` to `name=t;value=200ms`.
 * Pairing those would fabricate argument names the device never uses. `/ping
 * 1.1.1.1 count 1` is spaced (`count` is `syntax-obsolete`) and resolves to the
 * root, so it stays read here; telling a root command's positional grammar from a
 * spaced argument is per-command schema and belongs to the live probe.
 *
 * `where` ends the scan. What follows it is a query expression, and the word
 * before it is never paired with it: `print count-only where …` lowers to
 * `count-only=true;where=…`.
 *
 * Like the #311 separator rule, this reads only what the argument lexer
 * already decided (`lexArgumentTokens`, the skip-tolerant reading), so a
 * `[…]` substitution or a quoted run is one token by construction.
 */

import { ARGUMENT_NAME, type Argument } from "./args.ts";

/** Two adjacent operands that may be the spaced spelling of `name=value`. */
export interface SpacedPair {
	/** First byte of the would-be name through the end of the would-be value. */
	span: { start: number; end: number };
	/** The would-be argument name, verbatim. */
	name: string;
	/** The would-be value, verbatim (quotes kept). */
	value: string;
	/**
	 * The second operand cannot be a flag, so the device very probably reads the
	 * pair as `name=value` and marks the gap `syntax-obsolete`.
	 */
	valueShaped: boolean;
}

/**
 * An argument-name-shaped bare word. This is the lexer's own grammar, so a word
 * the lexer would read as `name=` in the `=` spelling is a name here too.
 */
const NAME_SHAPED = ARGUMENT_NAME;

function isWhere(token: Argument): boolean {
	return token.kind === "positional" && token.text.toLowerCase() === "where";
}

/**
 * Every adjacent `name operand` pair in one statement's argument tokens.
 *
 * Pairs overlap on purpose. `set ether1 comment "x"` yields `ether1 comment`
 * and `comment "x"`: the first only abstains, the second also warns, and
 * consuming the first would hide the second.
 *
 * Coordinate-space agnostic, like `findMissingSeparators`: spans come back in
 * whatever space `tokens` were lexed in.
 */
export function findSpacedPairs(tokens: readonly Argument[]): SpacedPair[] {
	const out: SpacedPair[] = [];
	for (let i = 0; i + 1 < tokens.length; i++) {
		const name = tokens[i] as Argument;
		const value = tokens[i + 1] as Argument;
		if (isWhere(name)) break;
		if (name.kind !== "positional" || value.kind !== "positional") continue;
		if (!NAME_SHAPED.test(name.text) || isWhere(value)) continue;
		out.push({
			span: { start: name.span.start, end: value.span.end },
			name: name.text,
			value: value.text,
			valueShaped: !NAME_SHAPED.test(value.text),
		});
	}
	return out;
}
