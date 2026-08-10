/**
 * Offline lexical value-shape hints (#225).
 *
 * These are deliberately not RouterOS types: a spelling is one axis, while the
 * live parser, an argument schema, and runtime casting may each answer
 * differently. The vocabulary still borrows RouterOS's type NAMES, so a shape
 * must never be spelled in a way the device would contradict — `num` is
 * integer-only here because RouterOS numbers are integers, and `2.2` is
 * observed as `ip` (`2.0.0.2`), never as a decimal. `mac` is the deliberate
 * exception: it names the CLI Reference's `macAddr` schema spelling, not a
 * `:typeof` result (a bare MAC is observed as `str`).
 *
 * ## The two contexts are different lexicons, not one lexicon plus a fallback
 *
 * An argument value is console text the command's schema interprets. An ARRAY
 * MEMBER is parsed as an expression, and that changes the answer for whole
 * classes of spelling. Grounded on CHR 7.23.3, reading each member's own
 * `:typeof` and the `:parse` IL of the enclosing statement:
 *
 * | member | IL | `:typeof` |
 * | ------ | -- | --------- |
 * | `{abc}` | `$abc` | `nothing` — a bare word is a VARIABLE REFERENCE |
 * | `{00:11:22:33:44:55}` | `$00:11:…` | `nothing` — no MAC literal exists |
 * | `{100000w}` | `$100000w` | `nothing` — out of the time range |
 * | `{*1}` | — | hard syntax error; `id` has no expression spelling |
 * | `{0x10}` | `16` | `num` — hex is a number here |
 * | `{Yes}` | `$Yes` | `nothing` — the boolean words are lower-case only |
 * | `{"abc"}` | `abc` | `str` — quoting is how a member becomes text |
 *
 * So the member lexicon drops `str`-by-fallback, `mac` and `id`, adds hex, and
 * range-checks time. Everything it cannot place is a variable reference or an
 * expression, and an abstention says exactly that.
 */

import { isIP } from "node:net";

/**
 * The closed offline vocabulary — an ENUMERATION, not an ordering.
 *
 * Nothing sorts by this list: {@link valueShapeHints} emits in the order it
 * tests spellings, so reordering the members here must not change any result.
 * `array` is emitted by the structured anchor reader rather than
 * {@link valueShapeHints}, which receives decoded scalar values only.
 */
export const VALUE_SHAPES = [
	"num",
	"ip",
	"ip-prefix",
	"ip6",
	"ip6-prefix",
	"id",
	"time",
	"array",
	"mac",
	"bool",
	"str",
] as const;

export type ValueShape = (typeof VALUE_SHAPES)[number];

/**
 * Where the value sits, because RouterOS reads the same bytes differently.
 *
 * `argument` is a command's `name=value` or positional operand; `array-member`
 * is one member of a `{…}`/`(…)` literal, which the device parses as an
 * expression (see the module header's table).
 */
export type ValueContext = "argument" | "array-member";

export interface ValueShapeOptions {
	/** A fully enclosing quoted run always has string shape. */
	quoted: boolean;
	/** A named attribute makes an otherwise-generic bare string addressable. */
	allowBareString?: boolean;
	/** Defaults to `argument`, the only context before #225's interior work. */
	context?: ValueContext;
}

/**
 * Nanoseconds RouterOS can still hold in a time literal, measured rather than
 * assumed: on 7.23.3 `9223372036s` is `time` and `9223372037s` is a variable
 * reference, and the same cliff sits between `15250w`/`15251w` and
 * `106751d`/`106752d`. That is exactly a signed 64-bit nanosecond count.
 */
const MAX_TIME_NS = 9_223_372_036_854_775_807n;

const UNIT_NS: Record<string, bigint> = {
	ns: 1n,
	us: 1_000n,
	ms: 1_000_000n,
	s: 1_000_000_000n,
	m: 60_000_000_000n,
	h: 3_600_000_000_000n,
	d: 86_400_000_000_000n,
	w: 604_800_000_000_000n,
};

function unsignedParts(value: string): bigint[] | null {
	if (value.length > 39) return null;
	if (!/^\d+(?:\.\d+){1,3}$/.test(value)) return null;
	return value.split(".").map((part) => BigInt(part));
}

/**
 * RouterOS's short IPv4 spellings (`1.1`, `2.1.1`, and the full four parts).
 *
 * The shortcut fills the LOW octets — `1.1` is `1.0.0.1` and `2.1.1` is
 * `2.1.0.1` — but it does NOT accept the class-based wide final field this
 * originally allowed (`second <= 16777215`, `third <= 65535`, transcribed from
 * the class-based description). Every part is a single octet on 7.23.3, in both
 * the argument and the member position:
 *
 * | literal | `:typeof` | value |
 * | ------- | --------- | ----- |
 * | `1.255` | `ip` | `1.0.0.255` |
 * | `1.256` | `time` | `00:00:01.256` — a decimal count of seconds |
 * | `1.16777215` | `time` | `00:00:01.167772150`, never `1.255.255.255` |
 * | `1.1.255` | `ip` | `1.1.0.255` |
 * | `1.1.256` | `str` | plain text; as a member, a variable reference |
 *
 * A too-large field therefore does not narrow the address — it stops being an
 * address, which is why the wide bounds produced an `ip` hint the device
 * contradicted.
 */
function isIpv4Shortcut(value: string): boolean {
	const parts = unsignedParts(value);
	if (parts === null) return false;
	return parts.every((part) => part <= 255n);
}

function prefixParts(
	value: string,
): { address: string; prefix: number } | null {
	const slash = value.lastIndexOf("/");
	if (slash <= 0 || slash === value.length - 1) return null;
	const prefixText = value.slice(slash + 1);
	if (!/^\d+$/.test(prefixText)) return null;
	return { address: value.slice(0, slash), prefix: Number(prefixText) };
}

/**
 * Fragment COVERAGE, deliberately not unit order.
 *
 * On 7.23.3 and 7.24rc3 a time literal is order-independent and additive:
 * `1s1m` is `00:01:01`, `1m1m` sums to `00:02:00`, `1h1h1h` to `03:00:00`, and
 * `1d2d` to `3d00:00:00` — all typed `time`. Rejecting an out-of-order or
 * repeated unit would make the hint disagree with the device, so the only
 * question asked here is whether recognized fragments cover the whole value.
 * Reported as an ordering defect in review of #242; the fixture's
 * `timeOrdering` block is the refutation.
 */
function isTimeShape(value: string): boolean {
	if (value.length > 64) return false;
	// RouterOS also accepts its own display form: optional additive week/day
	// fragments followed by H:M or H:M:S, with a fractional final component.
	// The fields are normalized rather than range-rejected (`00:60:00` becomes
	// `01:00:00`). This branch must run before the colon/address abstention guard.
	if (/^(?:\d+[wd])*\d+:\d+(?::\d+)?(?:\.\d+)?$/.test(value)) return true;
	// Longest suffixes must precede their one-letter prefixes: otherwise `ms`
	// could be consumed as minutes plus seconds instead of milliseconds.
	const matches = [...value.matchAll(/(\d+(?:\.\d+)?)(ns|us|ms|w|d|h|m|s)/g)];
	return (
		matches.length > 0 && matches.map((match) => match[0]).join("") === value
	);
}

/** One `<digits>[.<digits>]` quantity of `unit`, in nanoseconds. */
function fragmentNanos(quantity: string, unit: string): bigint {
	const scale = UNIT_NS[unit] as bigint;
	const [whole, fraction] = quantity.split(".");
	let total = BigInt(whole as string) * scale;
	if (fraction !== undefined && fraction !== "")
		total += (BigInt(fraction) * scale) / 10n ** BigInt(fraction.length);
	return total;
}

/**
 * Total nanoseconds of a time-shaped value, or null when it does not fit.
 *
 * Only the member context asks: an out-of-range literal is a plain variable
 * reference there (`{100000w}` -> IL `$100000w`), whereas an argument value is
 * console text the schema still reads, which is why the argument lexicon keeps
 * the documented `100000w`-is-`str` deviation instead of abstaining.
 */
function timeNanos(value: string): bigint | null {
	if (!isTimeShape(value)) return null;
	const colon = value.match(
		/^((?:\d+[wd])*)(\d+):(\d+)(?::(\d+))?(?:\.(\d+))?$/,
	);
	if (colon !== null) {
		let total = 0n;
		for (const [, quantity, unit] of (colon[1] as string).matchAll(
			/(\d+)([wd])/g,
		))
			total += fragmentNanos(quantity as string, unit as string);
		total += fragmentNanos(colon[2] as string, "h");
		total += fragmentNanos(colon[3] as string, "m");
		if (colon[4] !== undefined) total += fragmentNanos(colon[4], "s");
		if (colon[5] !== undefined) total += fragmentNanos(`0.${colon[5]}`, "s");
		return total > MAX_TIME_NS ? null : total;
	}
	let total = 0n;
	for (const [, quantity, unit] of value.matchAll(
		/(\d+(?:\.\d+)?)(ns|us|ms|w|d|h|m|s)/g,
	)) {
		total += fragmentNanos(quantity as string, unit as string);
		if (total > MAX_TIME_NS) return null;
	}
	return total;
}

/**
 * Shapes for ONE member of an array literal — an expression position.
 *
 * Every abstention here is a positive device reading rather than a gap: what
 * is not a literal in this position is a variable reference (`{abc}`,
 * `{100000w}`), an expression (`{1+1}`, `{a-b}`), or, for `*1`, a hard syntax
 * error. Nested `{…}`/`(…)` members are shaped by the caller from their
 * delimiters, not from here.
 */
function memberShapeHints(value: string, quoted: boolean): ValueShape[] {
	if (quoted) return ["str"];
	if (/^(?:yes|no|true|false)$/.test(value)) return ["bool"];
	// `0x10` is 16 but `0X10` is a variable reference, and `+1` is a syntax
	// error — the accepted spellings are exactly these two.
	if (/^-?\d+$/.test(value) || /^-?0x[0-9a-fA-F]+$/.test(value)) return ["num"];
	const prefix = prefixParts(value);
	if (prefix !== null) {
		if (prefix.prefix <= 32 && isIpv4Shortcut(prefix.address))
			return ["ip-prefix"];
		if (prefix.prefix <= 128 && isIP(prefix.address) === 6)
			return ["ip6-prefix"];
		return [];
	}
	if (isIpv4Shortcut(value)) return ["ip"];
	if (isIP(value) === 6) return ["ip6"];
	// A dotted decimal that is NOT a valid address falls through to SECONDS on
	// the device (`{256.1}` is `00:04:16.100`, `{1.256}` is `00:00:01.256`).
	// `isTimeShape` does not spell that form, so it abstains here already —
	// deliberately, because the reading depends on the failed address attempt
	// and an abstention never has to be unsaid.
	if (timeNanos(value) !== null) return ["time"];
	return [];
}

/** Full six-octet CLI Reference `macAddr` spelling; shorter runs are time/text. */
function isMacShape(value: string): boolean {
	return /^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}$/.test(value);
}

/**
 * IPv6 text always carries at least two colons (`::` counts as its own pair),
 * so a single colon is not an address attempt: `comment=foo:bar` is a string,
 * while `1::1`, a colon time spelling, and a MAC stay conservative.
 */
function isColonAddressLike(value: string): boolean {
	if (!value.includes("::") && (value.match(/:/g) ?? []).length < 2)
		return false;
	return /^[0-9a-fA-F:.]+$/.test(value);
}

/**
 * A conservative address attempt whose failed validation must not become `str`.
 *
 * The FIRST slash bounds the address here, while {@link prefixParts} reads the
 * LAST one. The asymmetry is deliberate: a two-slash value like `1.1.1.1/24/x`
 * is not a prefix any reading can accept, and splitting on the first slash is
 * the reading that still recognizes the address attempt and abstains.
 */
function isAddressLike(value: string): boolean {
	const slash = value.indexOf("/");
	const address = slash < 0 ? value : value.slice(0, slash);
	return /^\d+(?:\.\d+){1,3}$/.test(address) || isColonAddressLike(address);
}

/**
 * The bare comma spelling — the one place a spelling has TWO device readings.
 *
 * `{1;2}` is a syntax error in a command argument, but `=1,2,3` is not, and
 * which reading it gets is decided by the ARGUMENT's type, which offline does
 * not have. On 7.23.3 the device splits it for a list-typed attribute and keeps
 * it whole for a single-valued one, with no syntactic difference between them:
 *
 * | input | `:parse` IL |
 * | ----- | ----------- |
 * | `servers=1.1.1.1,8.8.8.8` | `servers=1.1.1.1;8.8.8.8` — a list |
 * | `dst-port=80,443` | `dst-port=;80;443` — a list |
 * | `connection-state=established,related` | `…=;established;related` — a list |
 * | `comment=a,b` | `comment=a,b` — ONE string |
 * | `interface=ether1,ether2` | `interface=ether1,ether2` — ONE string |
 *
 * So a NAMED attribute carries both readings, which is what the hint list is a
 * list for. In an expression position there is no second reading to carry:
 * `:local x 1,2` is a two-member `array` (and so is `a,b`), and no text reading
 * exists — which is exactly the slots where `allowBareString` is already false.
 *
 * No members are located for it. Whether the run splits at all is the schema's
 * answer, so member spans here would be a guess; the `(1,2)` spelling, where
 * the delimiters prove it, is anchored and descended into as usual.
 */
function commaSpellingHints(options: ValueShapeOptions): ValueShape[] {
	return options.allowBareString ? ["array", "str"] : ["array"];
}

/**
 * Infer non-authoritative shapes from one already-decoded literal.
 *
 * Generic bare positional words abstain: in `:local x 2.2`, `x` is a binding
 * name, not a value. A named attribute can safely fall back to `str`, and a
 * quoted positional is unambiguously string-shaped.
 */
export function valueShapeHints(
	value: string,
	options: ValueShapeOptions,
): ValueShape[] {
	if (options.context === "array-member")
		return memberShapeHints(value, options.quoted);
	if (options.quoted) return ["str"];
	if (value.includes(",")) return commaSpellingHints(options);

	const hints: ValueShape[] = [];
	const prefix = prefixParts(value);
	if (prefix !== null) {
		if (prefix.prefix <= 32 && isIpv4Shortcut(prefix.address))
			hints.push("ip-prefix");
		else if (prefix.prefix <= 128 && isIP(prefix.address) === 6)
			hints.push("ip6-prefix");
		if (hints.length > 0 || isAddressLike(value)) return hints;
		return options.allowBareString ? ["str"] : [];
	}

	if (/^(?:yes|no|true|false)$/.test(value)) hints.push("bool");
	// Integer-only: a dotted decimal is an IPv4 shortcut on the device, not a
	// number, so `num` here would contradict the observed type it is named after.
	if (/^-?\d+$/.test(value)) hints.push("num");
	if (/^\*[0-9a-fA-F]+$/.test(value)) hints.push("id");
	if (isIpv4Shortcut(value)) hints.push("ip");
	else if (isIP(value) === 6) hints.push("ip6");
	if (isTimeShape(value)) hints.push("time");
	if (isMacShape(value)) hints.push("mac");

	if (hints.length === 0 && options.allowBareString && !isAddressLike(value))
		hints.push("str");
	return hints;
}
