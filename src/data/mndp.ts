/**
 * Pure MNDP (MikroTik Neighbor Discovery Protocol) wire codec.
 *
 * MNDP is the UDP/5678 protocol RouterOS (and WinBox) use to discover
 * neighbors on a layer-2 segment. This module is intentionally pure:
 * {@link parseMndpPacket} turns bytes into a typed {@link MndpNeighbor} and
 * {@link encodeMndpPacket} does the reverse, so the codec is unit-tested
 * without any socket. The socket/IO layer lives in `src/discover.ts`.
 *
 * ## Grounding
 *
 * The wire map below comes from the tikoci/m2ir MNDP grounding lab
 * (`work/2026-11-mndp-grounding/FINDINGS.md`, tikoci/m2ir#4): CHR labs on
 * 6.49.23, 7.24.6, 7.25 and 7.26beta5 changing one setting per step, plus a
 * field capture of 6.49–7.26beta5 on ARM, ARM64 and MIPSBE. The follow-up
 * "hub lab" (tikoci/m2ir#5) put 6.49.23, 7.17.2, 7.18.2, 7.20.8 and 7.26beta5
 * on one segment to ground requests, TLV 14 by version, and the TLV 18
 * bitmask. The unit tests lift the lab's captured payloads verbatim as
 * fixtures.
 *
 * ## Packet layout
 *
 * - **Header** (bytes 0–3): one `u32` announcement counter in the
 *   **sender's CPU byte order** — little-endian on x86, ARM and ARM64,
 *   big-endian on MIPSBE. It counts every announcement on that interface
 *   (periodic or triggered) and restarts at boot. The packet does not say
 *   which byte order it used, and triggered announcements mean no rate bound
 *   tells the two readings apart, so the codec keeps the raw bytes
 *   ({@link MndpNeighbor.headerHex}) and does not decode a counter. A caller
 *   that knows the sender's CPU can read it; the lab confirmed the order by
 *   checking that uptime ÷ counter ≈ discover-interval. A header of
 *   `00000000` also marks a request (see Requests below).
 * - **TLVs** follow at offset 4: `type` (`u16` big-endian), `length` (`u16`
 *   big-endian), then `length` value bytes. TLV order changes between
 *   RouterOS versions (7.24 moves 17/15 after 18/19 and puts 2–4/9 right
 *   after 1), so the decoder never depends on order.
 *
 * ## TLV types ({@link mndpTlvType})
 *
 * | Type | Field | Value |
 * | ---- | ----- | ----- |
 * | 1 | `macAddress` | 6 bytes |
 * | 2, 3, 4 | `unpack` | Empty flags: 2 = `simple`, 2+3 = `uncompress-headers`, 2+3+4 = `uncompress-all`. Sent only when the sender's `/ip/packing` `unpacking` is not `none` |
 * | 5 | `identity` | UTF-8 |
 * | 6 | `request` | Empty flag: the packet is a refresh request (see Requests). Never in an announcement |
 * | 7 | `version` | Text; format varies by version (see {@link MndpNeighbor.version}) |
 * | 8 | `platform` | Text: `MikroTik`, or the branding package's name |
 * | 9 | `aggregatedSize` | `/ip/packing` `aggregated-size`, `u32` little-endian (seen on x86; unverified on big-endian CPUs). Sent with TLV 2 |
 * | 10 | `uptimeSeconds` | `u32` little-endian, also on MIPSBE |
 * | 11 | `softwareId` | Text |
 * | 12 | `board` | Text, the short board id (`CHR`, `RB1100Dx4`) |
 * | 14 | `ipv6Enabled` | 1 byte, `01`/`00`; its meaning depends on the sender's version (see {@link MndpNeighbor.ipv6Enabled}) |
 * | 15 | `ipv6Addresses` | 16 bytes; **repeats** once per IPv6 address on the interface (global first, then link-local) |
 * | 16 | `interfaceName` | Text; `bridge/port` for a bridge port |
 * | 17 | `ipv4` | 4 bytes, network order |
 * | 18 | `running` | `u8` bitmask (7.20+): `01` CAPsMAN, `02` CMR controller, `03` both, `00` neither |
 * | 19 | `ttlSeconds` | `u8` (7.24+): `min(discover-interval × 4 + 1, 255)`; `00` is a dying gasp |
 *
 * Type 6 appears only in requests; 13 and anything above 19 have appeared in
 * no capture. Every TLV
 * type the codec does not interpret — and any known type whose value has an
 * unexpected length — is preserved verbatim in
 * {@link MndpNeighbor.unknownTlvs} and never causes a throw. Only a
 * structurally malformed packet (too-short header, or a TLV whose declared
 * length runs past the buffer) throws.
 *
 * ## Transport and lifecycle
 *
 * Each announcement goes out twice, as an IPv4 broadcast and an IPv6
 * `ff02::1` multicast, with the same payload and counter; a receiver that
 * listens on both should treat (MAC, header) as one announcement. A **dying
 * gasp** (7.24+, `dying-gasp=yes`) is a short announcement sent before a
 * graceful reboot or shutdown: header, then TLVs 1, 19 = `00`, 17, 15.
 *
 * ## Requests
 *
 * A packet is a refresh request when its header is `00000000` **or** it
 * carries TLV 6. RouterOS drops a datagram whole when its TLVs do not end
 * exactly at the end of the datagram, so a trailing byte (the old 9-zero-byte
 * form) gets no reply. {@link mndpRefreshPacket} sends header `00000000` plus
 * an empty TLV 6: every tested version (6.49.23–7.26beta5) answers it, and it
 * does not add the requester to their neighbor tables (a bare `00000000` does
 * on 7.x, with an empty identity). The reply is an ordinary announcement,
 * broadcast from port 5678 to `255.255.255.255:5678` and `ff02::1:5678` 21 ms
 * to ~2 s later, even when the request was unicast or sent over IPv6, so a
 * requester must listen on 5678. On 7.x a burst of requests gets one reply.
 * The first announcement after boot has header `00000000` (IPv4 copy only),
 * so it doubles as a request; it carries a MAC and decodes as a neighbor.
 */

import { CentrsError } from "../errors.ts";

/** MNDP transport facts, exported so the IO layer does not re-declare them. */
export const MNDP_PORT = 5678;
export const MNDP_BROADCAST_ADDRESS = "255.255.255.255";
export const MNDP_IPV6_MULTICAST_ADDRESS = "ff02::1";

/** TLV type identifiers (see the module doc's TLV table for each value). */
export const mndpTlvType = {
	macAddress: 1,
	unpackSimple: 2,
	unpackHeaders: 3,
	unpackAll: 4,
	identity: 5,
	request: 6,
	version: 7,
	platform: 8,
	aggregatedSize: 9,
	uptime: 10,
	softwareId: 11,
	board: 12,
	ipv6Enabled: 14,
	ipv6Address: 15,
	interfaceName: 16,
	ipv4: 17,
	running: 18,
	ttl: 19,
} as const;

/**
 * Bits of the TLV 18 `running` bitmask (7.20+). RouterOS prints them as
 * `running=capsman`, `running=cmr` and `running=capsman,cmr` (`03`), and
 * omits the field for `00`.
 */
export const mndpRunningBit = {
	/** `/interface/wifi/capsman` is enabled. */
	capsman: 0x01,
	/** The router is a CMR controller (`/cmr`). */
	cmrController: 0x02,
} as const;

/**
 * The `/ip/neighbor` `unpack` value a receiver derives from the empty flag
 * TLVs 2, 3 and 4. Absent when none of them is sent (`unpack=none`, or a
 * sender that predates packing TLVs).
 */
export type MndpUnpack = "simple" | "uncompress-headers" | "uncompress-all";

/** A TLV record whose `type` the codec does not interpret; preserved verbatim. */
export interface MndpUnknownTlv {
	type: number;
	value: Uint8Array;
}

/**
 * A decoded MNDP announcement. Every advertised field is optional because a
 * device only sends what it has; `headerHex` and `unknownTlvs` are always set
 * so consumers never branch on their existence.
 */
export interface MndpNeighbor {
	/**
	 * Raw header bytes 0–3 as lower-case hex (e.g. `08000000`): the
	 * announcement counter in the sender's CPU byte order. The IPv4 and IPv6
	 * copies of one announcement carry the same header.
	 */
	headerHex: string;
	/** TLV 1: per-interface MAC, lower-case colon-separated (e.g. `e4:8d:8c:11:22:33`). */
	macAddress?: string;
	/** TLVs 2–4: the `unpack` mode the sender's `/ip/packing` advertises. */
	unpack?: MndpUnpack;
	/** TLV 5: identity; shared across all interfaces of one device. */
	identity?: string;
	/**
	 * TLV 6: `true` when the packet is a refresh request. A request carries no
	 * MAC, so the `discover` listener never caches one.
	 */
	request?: boolean;
	/**
	 * TLV 7: RouterOS version text. The format changes by version: 6.x
	 * `6.49.21 (long-term)`, 7.6–7.13 `7.12.1 (stable) Nov/17/2023 11:38:45`,
	 * 7.14–7.24 `7.24.6 (long-term) 2026-10-30 08:24:29`, and 7.25+
	 * `7.25.1 2026-11-02 12:39:53` (no channel).
	 */
	version?: string;
	/** TLV 8: `MikroTik`, or the branding package's name. */
	platform?: string;
	/** TLV 9: `/ip/packing` `aggregated-size` (little-endian `u32`). */
	aggregatedSize?: number;
	/** TLV 10: seconds since boot. */
	uptimeSeconds?: number;
	/** TLV 11: license software id. */
	softwareId?: string;
	/** TLV 12: short board id, e.g. `RB4011iGS+5HacQ2HnD` or `CHR`. */
	board?: string;
	/**
	 * TLV 14: `true` = IPv6 enabled. What that tracks depends on the sender's
	 * version: before 7.18 it means IPv6 is present (6.x: the `ipv6` package
	 * is enabled; 7.17 always sends `01`), not the setting. On 7.18–7.20 it
	 * follows `/ipv6/settings disable-ipv6` asymmetrically: disabling IPv6
	 * leaves `true` until the sender reboots, while re-enabling it sets `true`
	 * at once, so `true` there does not prove IPv6 is enabled. 7.26beta5
	 * follows the setting at once in both directions. The live-update boundary is
	 * probably 7.21 ("fixed MNDP IPv6 status reporting"); 7.21–7.25 were not
	 * tested.
	 */
	ipv6Enabled?: boolean;
	/**
	 * TLV 15, repeated: the sending interface's IPv6 addresses in arrival
	 * order (global first, then link-local).
	 */
	ipv6Addresses?: readonly string[];
	/** TLV 16: sending interface, e.g. `ether1`, or `bridge/port` for a bridge port. */
	interfaceName?: string;
	/** TLV 17: IPv4 of the sending interface, dotted-quad. */
	ipv4?: string;
	/** TLV 18 (7.20+): services bitmask; see {@link mndpRunningBit}. */
	running?: number;
	/**
	 * TLV 19 (7.24+): seconds a receiver should keep this neighbor,
	 * `min(discover-interval × 4 + 1, 255)`. `0` is a dying gasp: the sender is
	 * rebooting or shutting down. It is an approximate lifetime: RouterOS
	 * removed a silent neighbor at about the TTL or up to ~20 s after it.
	 */
	ttlSeconds?: number;
	/** TLV records the codec does not interpret, preserved in arrival order. */
	unknownTlvs: readonly MndpUnknownTlv[];
}

const MNDP_HEADER_LENGTH = 4;
const TLV_HEADER_LENGTH = 4;

function malformed(summary: string, context: Record<string, unknown>): never {
	throw new CentrsError({
		code: "mndp/malformed",
		summary,
		remediation:
			"Drop the packet; a well-formed MNDP response is a 4-byte header followed by complete big-endian TLV records. This is likely a non-MNDP datagram on the port.",
		context,
	});
}

function formatMac(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join(":");
}

function formatIpv4(bytes: Uint8Array): string {
	return Array.from(bytes).join(".");
}

function formatIpv6(bytes: Uint8Array): string {
	const groups: string[] = [];
	for (let index = 0; index < bytes.length; index += 2) {
		const hi = bytes[index] ?? 0;
		const lo = bytes[index + 1] ?? 0;
		groups.push(((hi << 8) | lo).toString(16));
	}
	return collapseIpv6(groups);
}

/** Collapse the longest run of zero groups into `::` per RFC 5952. */
function collapseIpv6(groups: readonly string[]): string {
	let bestStart = -1;
	let bestLen = 0;
	let runStart = -1;
	let runLen = 0;
	for (let index = 0; index < groups.length; index += 1) {
		if (groups[index] === "0") {
			if (runStart === -1) {
				runStart = index;
				runLen = 1;
			} else {
				runLen += 1;
			}
			if (runLen > bestLen) {
				bestLen = runLen;
				bestStart = runStart;
			}
		} else {
			runStart = -1;
			runLen = 0;
		}
	}
	if (bestLen < 2) {
		return groups.join(":");
	}
	const head = groups.slice(0, bestStart).join(":");
	const tail = groups.slice(bestStart + bestLen).join(":");
	return `${head}::${tail}`;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

type MutableNeighbor = Omit<MndpNeighbor, "unknownTlvs" | "ipv6Addresses"> & {
	unknownTlvs: MndpUnknownTlv[];
	ipv6Addresses?: string[];
};

/**
 * Decode a raw MNDP datagram into a {@link MndpNeighbor}. Throws a
 * `mndp/malformed` {@link CentrsError} on a structurally invalid packet
 * (too-short header or a TLV whose length overruns the buffer). Unknown TLV
 * types, and known types with an unexpected value length, are preserved in
 * `unknownTlvs`, not rejected.
 */
export function parseMndpPacket(bytes: Uint8Array): MndpNeighbor {
	if (bytes.length < MNDP_HEADER_LENGTH) {
		malformed(
			`MNDP packet too short: ${bytes.length} byte(s), need at least ${MNDP_HEADER_LENGTH} for the header.`,
			{ byteLength: bytes.length },
		);
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const neighbor: MutableNeighbor = {
		headerHex: toHex(bytes.subarray(0, MNDP_HEADER_LENGTH)),
		unknownTlvs: [],
	};
	const unpackFlags = new Set<number>();

	let offset = MNDP_HEADER_LENGTH;
	while (offset + TLV_HEADER_LENGTH <= bytes.length) {
		const type = view.getUint16(offset, false);
		const length = view.getUint16(offset + 2, false);
		const valueStart = offset + TLV_HEADER_LENGTH;
		const valueEnd = valueStart + length;
		if (valueEnd > bytes.length) {
			malformed(
				`MNDP TLV (type ${type}) declares ${length} byte(s) but only ${bytes.length - valueStart} remain.`,
				{ tlvType: type, declaredLength: length, byteLength: bytes.length },
			);
		}
		const value = bytes.subarray(valueStart, valueEnd);
		if (!applyTlv(neighbor, unpackFlags, type, value, view, valueStart)) {
			neighbor.unknownTlvs.push({ type, value: value.slice() });
		}
		offset = valueEnd;
	}

	const unpack = deriveUnpack(unpackFlags);
	if (unpack !== undefined) {
		neighbor.unpack = unpack;
	}
	return neighbor;
}

/** Map the TLV 2/3/4 flags to `/ip/neighbor` `unpack`; the highest flag wins. */
function deriveUnpack(flags: ReadonlySet<number>): MndpUnpack | undefined {
	if (flags.has(mndpTlvType.unpackAll)) {
		return "uncompress-all";
	}
	if (flags.has(mndpTlvType.unpackHeaders)) {
		return "uncompress-headers";
	}
	if (flags.has(mndpTlvType.unpackSimple)) {
		return "simple";
	}
	return undefined;
}

/**
 * Apply one TLV to the neighbor. Returns `false` when the codec does not
 * interpret it (unknown type, or a known type with an unexpected length) so
 * the caller preserves it in `unknownTlvs`.
 */
function applyTlv(
	neighbor: MutableNeighbor,
	unpackFlags: Set<number>,
	type: number,
	value: Uint8Array,
	view: DataView,
	valueStart: number,
): boolean {
	const text = (): string => new TextDecoder().decode(value);
	switch (type) {
		case mndpTlvType.macAddress:
			neighbor.macAddress = formatMac(value);
			return true;
		case mndpTlvType.unpackSimple:
		case mndpTlvType.unpackHeaders:
		case mndpTlvType.unpackAll:
			if (value.length !== 0) {
				return false;
			}
			unpackFlags.add(type);
			return true;
		case mndpTlvType.identity:
			neighbor.identity = text();
			return true;
		case mndpTlvType.request:
			if (value.length !== 0) {
				return false;
			}
			neighbor.request = true;
			return true;
		case mndpTlvType.version:
			neighbor.version = text();
			return true;
		case mndpTlvType.platform:
			neighbor.platform = text();
			return true;
		case mndpTlvType.aggregatedSize:
			if (value.length !== 4) {
				return false;
			}
			neighbor.aggregatedSize = view.getUint32(valueStart, true);
			return true;
		case mndpTlvType.uptime:
			if (value.length !== 4) {
				return false;
			}
			neighbor.uptimeSeconds = view.getUint32(valueStart, true);
			return true;
		case mndpTlvType.softwareId:
			neighbor.softwareId = text();
			return true;
		case mndpTlvType.board:
			neighbor.board = text();
			return true;
		case mndpTlvType.ipv6Enabled:
			if (value.length !== 1) {
				return false;
			}
			neighbor.ipv6Enabled = value[0] !== 0;
			return true;
		case mndpTlvType.ipv6Address:
			if (value.length !== 16) {
				return false;
			}
			neighbor.ipv6Addresses ??= [];
			neighbor.ipv6Addresses.push(formatIpv6(value));
			return true;
		case mndpTlvType.interfaceName:
			neighbor.interfaceName = text();
			return true;
		case mndpTlvType.ipv4:
			if (value.length !== 4) {
				return false;
			}
			neighbor.ipv4 = formatIpv4(value);
			return true;
		case mndpTlvType.running:
			if (value.length !== 1) {
				return false;
			}
			neighbor.running = value[0];
			return true;
		case mndpTlvType.ttl:
			if (value.length !== 1) {
				return false;
			}
			neighbor.ttlSeconds = value[0];
			return true;
		default:
			return false;
	}
}

/**
 * Names of the bits set in a TLV 18 `running` bitmask: `capsman`, `cmr`, and
 * `bit<n>` for a bit no capture has grounded yet.
 */
export function mndpRunningNames(running: number): string[] {
	const names: string[] = [];
	for (let bit = 0; bit < 8; bit += 1) {
		const mask = 1 << bit;
		if ((running & mask) === 0) {
			continue;
		}
		if (mask === mndpRunningBit.capsman) {
			names.push("capsman");
		} else if (mask === mndpRunningBit.cmrController) {
			names.push("cmr");
		} else {
			names.push(`bit${bit}`);
		}
	}
	return names;
}

/** A single TLV record for {@link encodeMndpPacket}. */
export interface MndpTlvInput {
	type: number;
	value: Uint8Array;
}

function macToBytes(mac: string): Uint8Array {
	const parts = mac.split(":");
	if (parts.length !== 6) {
		throw new CentrsError({
			code: "mndp/encode-failed",
			summary: `Cannot encode MAC "${mac}": expected six colon-separated octets.`,
			remediation: "Pass a MAC like `e4:8d:8c:11:22:33`.",
			context: { mac },
		});
	}
	return Uint8Array.from(parts.map((part) => Number.parseInt(part, 16) & 0xff));
}

function ipv4ToBytes(ipv4: string): Uint8Array {
	const parts = ipv4.split(".");
	if (parts.length !== 4) {
		throw new CentrsError({
			code: "mndp/encode-failed",
			summary: `Cannot encode IPv4 "${ipv4}": expected dotted-quad.`,
			remediation: "Pass an IPv4 like `192.0.2.5`.",
			context: { ipv4 },
		});
	}
	return Uint8Array.from(parts.map((part) => Number.parseInt(part, 10) & 0xff));
}

function headerToBytes(headerHex: string): Uint8Array {
	if (!/^[0-9a-fA-F]{8}$/.test(headerHex)) {
		throw new CentrsError({
			code: "mndp/encode-failed",
			summary: `Cannot encode MNDP header "${headerHex}": expected 8 hex digits.`,
			remediation: "Pass the 4 header bytes as hex, like `08000000`.",
			context: { headerHex },
		});
	}
	return Uint8Array.from(
		[0, 2, 4, 6].map((index) =>
			Number.parseInt(headerHex.slice(index, index + 2), 16),
		),
	);
}

function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function u32le(value: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value, true);
	return out;
}

const UNPACK_FLAG_TYPES: Record<MndpUnpack, readonly number[]> = {
	simple: [mndpTlvType.unpackSimple],
	"uncompress-headers": [mndpTlvType.unpackSimple, mndpTlvType.unpackHeaders],
	"uncompress-all": [
		mndpTlvType.unpackSimple,
		mndpTlvType.unpackHeaders,
		mndpTlvType.unpackAll,
	],
};

/**
 * Encode a {@link MndpNeighbor} (plus any extra raw TLVs) back into a wire
 * packet. Primarily a round-trip aid for tests and for crafting fixtures. The
 * header is `headerHex` (default all zeros); TLVs follow the 7.24.5+ order,
 * led by TLV 6 when `request` is set, except that IPv6 addresses are not
 * encoded (pass TLV 15 in `extraTlvs`).
 */
export function encodeMndpPacket(
	neighbor: Partial<MndpNeighbor>,
	extraTlvs: readonly MndpTlvInput[] = [],
): Uint8Array {
	const tlvs: MndpTlvInput[] = [];
	const push = (type: number, value: Uint8Array): void => {
		tlvs.push({ type, value });
	};
	if (neighbor.request === true) {
		push(mndpTlvType.request, new Uint8Array(0));
	}
	if (neighbor.macAddress !== undefined) {
		push(mndpTlvType.macAddress, macToBytes(neighbor.macAddress));
	}
	if (neighbor.unpack !== undefined) {
		for (const type of UNPACK_FLAG_TYPES[neighbor.unpack]) {
			push(type, new Uint8Array(0));
		}
	}
	if (neighbor.aggregatedSize !== undefined) {
		push(mndpTlvType.aggregatedSize, u32le(neighbor.aggregatedSize));
	}
	if (neighbor.identity !== undefined) {
		push(mndpTlvType.identity, utf8(neighbor.identity));
	}
	if (neighbor.version !== undefined) {
		push(mndpTlvType.version, utf8(neighbor.version));
	}
	if (neighbor.platform !== undefined) {
		push(mndpTlvType.platform, utf8(neighbor.platform));
	}
	if (neighbor.uptimeSeconds !== undefined) {
		push(mndpTlvType.uptime, u32le(neighbor.uptimeSeconds));
	}
	if (neighbor.softwareId !== undefined) {
		push(mndpTlvType.softwareId, utf8(neighbor.softwareId));
	}
	if (neighbor.board !== undefined) {
		push(mndpTlvType.board, utf8(neighbor.board));
	}
	if (neighbor.ipv6Enabled !== undefined) {
		push(
			mndpTlvType.ipv6Enabled,
			Uint8Array.from([neighbor.ipv6Enabled ? 1 : 0]),
		);
	}
	if (neighbor.interfaceName !== undefined) {
		push(mndpTlvType.interfaceName, utf8(neighbor.interfaceName));
	}
	if (neighbor.running !== undefined) {
		push(mndpTlvType.running, Uint8Array.from([neighbor.running & 0xff]));
	}
	if (neighbor.ttlSeconds !== undefined) {
		push(mndpTlvType.ttl, Uint8Array.from([neighbor.ttlSeconds & 0xff]));
	}
	if (neighbor.ipv4 !== undefined) {
		push(mndpTlvType.ipv4, ipv4ToBytes(neighbor.ipv4));
	}
	for (const tlv of extraTlvs) {
		tlvs.push(tlv);
	}

	let bodyLength = 0;
	for (const tlv of tlvs) {
		bodyLength += TLV_HEADER_LENGTH + tlv.value.length;
	}
	const out = new Uint8Array(MNDP_HEADER_LENGTH + bodyLength);
	const view = new DataView(out.buffer);
	out.set(headerToBytes(neighbor.headerHex ?? "00000000"), 0);

	let offset = MNDP_HEADER_LENGTH;
	for (const tlv of tlvs) {
		view.setUint16(offset, tlv.type, false);
		view.setUint16(offset + 2, tlv.value.length, false);
		out.set(tlv.value, offset + TLV_HEADER_LENGTH);
		offset += TLV_HEADER_LENGTH + tlv.value.length;
	}
	return out;
}

/**
 * MNDP refresh request: header `00000000` plus an empty TLV 6, and no
 * trailing bytes, since RouterOS drops a datagram whose TLVs do not end
 * exactly at its end. Every RouterOS version from 6.49.23 to 7.26beta5
 * answers it with a broadcast announcement to port 5678, and it does not add
 * the requester to their neighbor tables. See the module doc's Requests
 * section (tikoci/m2ir#5).
 */
export function mndpRefreshPacket(): Uint8Array {
	return Uint8Array.of(0, 0, 0, 0, 0, mndpTlvType.request, 0, 0);
}

/**
 * Stable cache/identity key for a neighbor: the lower-cased MAC when present,
 * else a synthetic key from identity + interface so MAC-less packets still slot
 * deterministically.
 */
export function mndpNeighborKey(neighbor: MndpNeighbor): string {
	if (neighbor.macAddress) {
		return neighbor.macAddress.toLowerCase();
	}
	return `noaddr:${neighbor.identity ?? ""}:${neighbor.interfaceName ?? ""}`;
}
