/**
 * Offline lexical value-shape hints (#225).
 *
 * These are deliberately not RouterOS types: a spelling is one axis, while the
 * live parser, an argument schema, and runtime casting may each answer
 * differently. The vocabulary still borrows RouterOS's type NAMES, so a shape
 * must never be spelled in a way the device would contradict — `num` is
 * integer-only here because RouterOS numbers are integers, and `2.2` is
 * observed as `ip` (`2.0.0.2`), never as a decimal.
 */

import { isIP } from "node:net";

/**
 * The closed V1 vocabulary — an ENUMERATION, not an ordering.
 *
 * Nothing sorts by this list: {@link valueShapeHints} emits in the order it
 * tests spellings, so reordering the members here must not change any result.
 * Members the grounded lexicon still owes (a colon time spelling, `mac`) are
 * tracked in #243 and abstain rather than borrowing a near member.
 */
export const VALUE_SHAPES = [
	"num",
	"ip",
	"ip-prefix",
	"ip6",
	"ip6-prefix",
	"time",
	"bool",
	"str",
] as const;

export type ValueShape = (typeof VALUE_SHAPES)[number];

export interface ValueShapeOptions {
	/** A fully enclosing quoted run always has string shape. */
	quoted: boolean;
	/** A named attribute makes an otherwise-generic bare string addressable. */
	allowBareString?: boolean;
}

function unsignedParts(value: string): bigint[] | null {
	if (value.length > 39) return null;
	if (!/^\d+(?:\.\d+){1,3}$/.test(value)) return null;
	return value.split(".").map((part) => BigInt(part));
}

/** RouterOS's class-based IPv4 shortcut spellings (`1.1`, `2.1.1`, and full). */
function isIpv4Shortcut(value: string): boolean {
	const parts = unsignedParts(value);
	if (parts === null) return false;
	const [first, second, third] = parts;
	if (first === undefined || second === undefined) return false;
	if (parts.length === 2) return first <= 255n && second <= 16_777_215n;
	if (parts.length === 3)
		return (
			third !== undefined && first <= 255n && second <= 255n && third <= 65_535n
		);
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

function isTimeShape(value: string): boolean {
	if (value.length > 64) return false;
	// Longest suffixes must precede their one-letter prefixes: otherwise `ms`
	// could be consumed as minutes plus seconds instead of milliseconds.
	const matches = [...value.matchAll(/(\d+(?:\.\d+)?)(ns|us|ms|w|d|h|m|s)/g)];
	return (
		matches.length > 0 && matches.map((match) => match[0]).join("") === value
	);
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
	if (options.quoted) return ["str"];

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
	if (isIpv4Shortcut(value)) hints.push("ip");
	else if (isIP(value) === 6) hints.push("ip6");
	if (isTimeShape(value)) hints.push("time");

	if (hints.length === 0 && options.allowBareString && !isAddressLike(value))
		hints.push("str");
	return hints;
}
