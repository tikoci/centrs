/**
 * Offline lexical value-shape hints (#225).
 *
 * These are deliberately not RouterOS types. A spelling can carry several
 * hints (`2.2` is decimal-shaped and an IPv4 shortcut), while the live parser,
 * an argument schema, and runtime casting may each answer differently.
 */

import { isIP } from "node:net";

export const VALUE_SHAPES = [
	"bool",
	"num",
	"ip",
	"ip-prefix",
	"ip6",
	"ip6-prefix",
	"time",
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
	const matches = [...value.matchAll(/(\d+(?:\.\d+)?)(ns|us|ms|w|d|h|m|s)/g)];
	return (
		matches.length > 0 && matches.map((match) => match[0]).join("") === value
	);
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
		return hints.length > 0 || !options.allowBareString ? hints : ["str"];
	}

	if (/^(?:yes|no|true|false)$/.test(value)) hints.push("bool");
	if (/^-?\d+(?:\.\d+)?$/.test(value)) hints.push("num");
	if (isIpv4Shortcut(value)) hints.push("ip");
	else if (isIP(value) === 6) hints.push("ip6");
	if (isTimeShape(value)) hints.push("time");

	if (hints.length === 0 && options.allowBareString) hints.push("str");
	return hints;
}
