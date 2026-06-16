/**
 * MAC-address identity helpers and host-ARP resolution.
 *
 * A `<router>` argument may be a MAC address. The constitution resolves a MAC
 * through the CDB first; only when no CDB record matches may the caller opt into
 * local ARP resolution (`--resolve arp` / `CENTRS_RESOLVE=arp`) to turn the MAC
 * into an IP-level target. This module owns MAC recognition/normalization and
 * the platform ARP-table lookup; the policy (when ARP is allowed) lives in the
 * command resolution seam.
 *
 * ARP is a host-local cache: the neighbor must have been talked to recently for
 * its MAC→IP mapping to exist. Resolution is therefore best-effort and the
 * caller surfaces an actionable error when the MAC is absent.
 */

import { CentrsError } from "../errors.ts";

/** How an unresolved MAC target may be turned into an IP-level target. */
export type ResolvePolicy = "none" | "arp";

const MAC_RE = /^(?:[0-9a-fA-F]{1,2})(?:[:-][0-9a-fA-F]{1,2}){5}$/;

/** True when `value` looks like a 6-octet MAC (colon or dash separated). */
export function isMacAddress(value: string): boolean {
	return MAC_RE.test(value.trim());
}

/**
 * True for transports that connect to an IP/host:port and can therefore use an
 * ARP-resolved MAC. L2/identity transports (mac-telnet, romon) take the MAC
 * directly and must not be ARP-resolved.
 */
export function isIpTransport(via: string): boolean {
	return (
		via === "rest-api" ||
		via === "native-api" ||
		via === "ssh" ||
		via === "snmp"
	);
}

/**
 * Normalize a MAC to lower-case, colon-separated, zero-padded octets
 * (`8a:6:1c:a:2:1f` → `8a:06:1c:0a:02:1f`). Returns `undefined` when the input
 * is not a MAC, so callers can use it as a recognizer + canonicalizer in one.
 */
export function normalizeMac(value: string): string | undefined {
	const trimmed = value.trim();
	if (!isMacAddress(trimmed)) {
		return undefined;
	}
	return trimmed
		.split(/[:-]/)
		.map((octet) => octet.toLowerCase().padStart(2, "0"))
		.join(":");
}

/** A single host ARP-cache entry. */
export interface ArpEntry {
	ip: string;
	mac: string;
}

/**
 * Parse the output of `arp -an` (BSD/macOS and Linux both emit
 * `? (10.0.0.1) at 8a:6:1c:a:2:1f on en0 ...`). macOS prints octets without
 * leading zeros, so every MAC is normalized for stable comparison.
 */
export function parseArpTable(output: string): ArpEntry[] {
	const entries: ArpEntry[] = [];
	const line =
		/\(([0-9.]+)\)\s+at\s+([0-9a-fA-F]{1,2}(?::[0-9a-fA-F]{1,2}){5})/g;
	for (const match of output.matchAll(line)) {
		const ip = match[1];
		const mac = match[2] ? normalizeMac(match[2]) : undefined;
		if (ip && mac) {
			entries.push({ ip, mac });
		}
	}
	return entries;
}

/**
 * Look up `mac` in the host ARP cache and return its IPv4 address, or
 * `undefined` when absent. Spawns `arp -an`; a spawn failure is swallowed
 * (treated as "not found") so the caller emits a single actionable error.
 */
export async function resolveMacViaArp(
	mac: string,
	run: (cmd: string[]) => Promise<string> = defaultRunArp,
): Promise<string | undefined> {
	const target = normalizeMac(mac);
	if (!target) {
		return undefined;
	}
	let output: string;
	try {
		output = await run(["arp", "-an"]);
	} catch {
		return undefined;
	}
	const match = parseArpTable(output).find((entry) => entry.mac === target);
	return match?.ip;
}

async function defaultRunArp(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
	const output = await new Response(proc.stdout).text();
	await proc.exited;
	return output;
}

/**
 * Coerce a `--resolve` / `CENTRS_RESOLVE` value to a {@link ResolvePolicy}.
 * Defaults to `none`; an unrecognized value is an actionable error.
 */
export function parseResolvePolicy(value: string | undefined): ResolvePolicy {
	if (value === undefined || value.trim().length === 0) {
		return "none";
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "none" || normalized === "arp") {
		return normalized;
	}
	throw new CentrsError({
		code: "validation/option",
		summary: `Unknown --resolve value "${value}".`,
		remediation: "Use `--resolve none` (default) or `--resolve arp`.",
		context: { resolve: value },
	});
}

/**
 * Compute the effective host candidate using the same precedence as
 * {@link resolveTarget}: explicit host > `CENTRS_HOST` > CDB target > the bare
 * `<router>` positional.
 */
export function effectiveHostCandidate(opts: {
	host?: string;
	targetInput?: string;
	cdbTarget?: string;
	env: Record<string, string | undefined>;
}): string | undefined {
	const candidate =
		opts.host ?? opts.env["CENTRS_HOST"] ?? opts.cdbTarget ?? opts.targetInput;
	return candidate?.trim() ? candidate.trim() : undefined;
}

/**
 * Resolve a MAC target to an IP via host ARP, honoring the opt-in policy.
 *
 * Returns `undefined` when the effective target is not a MAC (the normal IP /
 * hostname path). When it is a MAC: with policy `none` it throws an actionable
 * error (ARP not opted into); with policy `arp` it spawns `arp -an` and returns
 * `{ mac, ip }`, or throws when the MAC is absent from the cache.
 */
export async function resolveMacTarget(opts: {
	host?: string;
	targetInput?: string;
	cdbTarget?: string;
	env: Record<string, string | undefined>;
	policy: ResolvePolicy;
	operation: "retrieve" | "execute" | "terminal";
	runArp?: (cmd: string[]) => Promise<string>;
}): Promise<{ mac: string; ip: string } | undefined> {
	const candidate = effectiveHostCandidate(opts);
	const mac = candidate ? normalizeMac(candidate) : undefined;
	if (!mac) {
		return undefined;
	}
	if (opts.policy !== "arp") {
		throw unresolvedMacError(candidate ?? mac, opts.policy, opts.operation);
	}
	const ip = await resolveMacViaArp(mac, opts.runArp ?? defaultRunArp);
	if (!ip) {
		throw unresolvedMacError(candidate ?? mac, "arp", opts.operation);
	}
	return { mac, ip };
}

/**
 * Build the actionable error raised when a MAC target cannot be turned into an
 * IP-level target for a read/REST/native path. `policy` distinguishes "you did
 * not opt into ARP" from "ARP had no entry".
 */
export function unresolvedMacError(
	mac: string,
	policy: ResolvePolicy,
	operation: "retrieve" | "execute" | "terminal",
): CentrsError {
	if (policy !== "arp") {
		return new CentrsError({
			code: "target/mac-unresolved",
			summary: `Target ${mac} is a MAC address with no matching CDB record.`,
			remediation: unresolvedMacRemediation(operation),
			context: { mac, resolve: policy },
		});
	}
	return new CentrsError({
		code: "target/mac-not-in-arp",
		summary: `MAC ${mac} is not in the host ARP cache, so it cannot be resolved to an IP.`,
		remediation:
			operation === "terminal"
				? "Reach it over Layer 2 with `--via mac-telnet` (no IP needed), or make the device IP-reachable first (e.g. ping it, or run `centrs discover`) so the host learns its MAC→IP mapping, then retry."
				: "Make the device reachable first (e.g. ping its IP, or run `centrs discover`) so the host learns its MAC→IP mapping, then retry — or pass the IP/hostname directly.",
		context: { mac, resolve: policy },
	});
}

/**
 * The non-ARP "MAC has no CDB record" remediation, tailored per command. For
 * `terminal` the natural alternative is L2 (`--via mac-telnet` needs no IP); the
 * IP-only `retrieve`/`execute` paths lead with an IP/hostname instead.
 */
function unresolvedMacRemediation(
	operation: "retrieve" | "execute" | "terminal",
): string {
	switch (operation) {
		case "terminal":
			return "Reach it over Layer 2 with `--via mac-telnet` (no IP needed), pass an IP/hostname, add a CDB record for this MAC, or opt into host ARP resolution with `--resolve arp`.";
		case "execute":
			return "Pass an IP/hostname, add a CDB record for this MAC, or opt into host ARP resolution with `--resolve arp` (mac-telnet L2 execute is not yet available).";
		default:
			return "Pass an IP/hostname, add a CDB record for this MAC, or opt into host ARP resolution with `--resolve arp`.";
	}
}
