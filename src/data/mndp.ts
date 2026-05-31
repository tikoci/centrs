/**
 * Pure MNDP (MikroTik Neighbor Discovery Protocol) wire codec.
 *
 * MNDP is the UDP/5678 broadcast protocol RouterOS (and WinBox) use to discover
 * neighbors on a layer-2 segment. A response packet is a 4-byte header
 * (`type` + `sequence`) followed by zero or more big-endian TLV records.
 * This module is intentionally pure: {@link parseMndpPacket} turns bytes into a
 * typed {@link MndpNeighbor} and {@link encodeMndpPacket} does the reverse, so
 * the codec is unit-tested without any socket. The socket/IO layer lives in
 * `src/discover.ts`.
 *
 * Wire facts (grounded on live RouterOS 7.23/7.24 packet captures — see the
 * `parses a real captured RouterOS announcement (big-endian TLVs)` fixture
 * test — and aligned with the `routeros-mndp` skill, which documents the same
 * big-endian TLV byte order and the type→field mapping for types 10/11/12. An
 * earlier revision of the skill table stated little-endian TLVs and an
 * off-by-one type mapping; the constitution requires grounding on live-router
 * evidence, and the skill has since been corrected to match this codec):
 * - Header: 4 bytes (a per-device sequence/type word then a `sequence` field).
 *   TLV records start at offset 4.
 * - Each TLV: `type` (uint16 **big-endian**), `length` (uint16 **big-endian**),
 *   then `length` value bytes whose interpretation depends on the type. (A
 *   little-endian reading turns `00 0a 00 04` into type 2560/length 1024 and
 *   overruns every buffer — which is why every real packet was being rejected.)
 * - MAC (type 1) and IPv4 (type 17) are big-endian byte sequences; uptime
 *   (type 10) is a little-endian uint32; string fields are UTF-8.
 * - Type mapping confirmed against the `bigdude` test router's REST facts:
 *   type 10 = uptime, type 11 = software-id, type 12 = board name.
 * - Board may arrive as type 12 or, on some firmware, type 13; type 12 wins.
 * - Unknown TLV types are preserved verbatim in {@link MndpNeighbor.unknownTlvs}
 *   and never cause a throw. Only a structurally malformed packet (too-short
 *   header, or a TLV whose declared length runs past the buffer) throws.
 */

import { CentrsError } from "../errors.ts";

/** MNDP transport facts, exported so the IO layer does not re-declare them. */
export const MNDP_PORT = 5678;
export const MNDP_BROADCAST_ADDRESS = "255.255.255.255";
export const MNDP_IPV6_MULTICAST_ADDRESS = "ff02::1";

/** TLV type identifiers defined by MNDP. */
export const mndpTlvType = {
	macAddress: 1,
	identity: 5,
	version: 7,
	platform: 8,
	uptime: 10,
	softwareId: 11,
	board: 12,
	boardAlt: 13,
	unpack: 14,
	ipv6: 15,
	interfaceName: 16,
	ipv4: 17,
} as const;

/** A TLV record whose `type` the codec does not interpret; preserved verbatim. */
export interface MndpUnknownTlv {
	type: number;
	value: Uint8Array;
}

/**
 * A decoded MNDP announcement. Every advertised field is optional because a
 * device only sends what it has; `sequence` and `unknownTlvs` are always set so
 * consumers never branch on their existence.
 */
export interface MndpNeighbor {
	/** Per-interface MAC, lower-case colon-separated (e.g. `e4:8d:8c:11:22:33`). */
	macAddress?: string;
	/** Hostname; shared across all interfaces of one device. */
	identity?: string;
	/** RouterOS version string, e.g. `7.18 (stable)`. */
	version?: string;
	/** Usually `MikroTik`. */
	platform?: string;
	/** Board model, e.g. `RB4011iGS+5HacQ2HnD` or `CHR`. */
	board?: string;
	/** Seconds since boot. */
	uptimeSeconds?: number;
	/** License identifier. */
	softwareId?: string;
	/** Firmware compression flag. */
	unpack?: number;
	/** Link-local or global IPv6 of the sending interface. */
	ipv6?: string;
	/** Sending interface name on the router, e.g. `ether1`. */
	interfaceName?: string;
	/** IPv4 of the sending interface, dotted-quad. */
	ipv4?: string;
	/** Per-device monotonically increasing sequence number from the header. */
	sequence: number;
	/** TLV records with an unrecognized type, preserved in arrival order. */
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

/**
 * Decode a raw MNDP datagram into a {@link MndpNeighbor}. Throws a
 * `mndp/malformed` {@link CentrsError} on a structurally invalid packet
 * (too-short header or a TLV whose length overruns the buffer). Unknown TLV
 * types are preserved, not rejected.
 */
export function parseMndpPacket(bytes: Uint8Array): MndpNeighbor {
	if (bytes.length < MNDP_HEADER_LENGTH) {
		malformed(
			`MNDP packet too short: ${bytes.length} byte(s), need at least ${MNDP_HEADER_LENGTH} for the header.`,
			{ byteLength: bytes.length },
		);
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const sequence = view.getUint16(2, false);
	const neighbor: {
		sequence: number;
		unknownTlvs: MndpUnknownTlv[];
	} & Partial<MndpNeighbor> = {
		sequence,
		unknownTlvs: [],
	};

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
		applyTlv(neighbor, type, value, view, valueStart);
		offset = valueEnd;
	}

	return neighbor as MndpNeighbor;
}

function applyTlv(
	neighbor: { unknownTlvs: MndpUnknownTlv[] } & Partial<MndpNeighbor>,
	type: number,
	value: Uint8Array,
	view: DataView,
	valueStart: number,
): void {
	const text = (): string => new TextDecoder().decode(value);
	switch (type) {
		case mndpTlvType.macAddress:
			neighbor.macAddress = formatMac(value);
			break;
		case mndpTlvType.identity:
			neighbor.identity = text();
			break;
		case mndpTlvType.version:
			neighbor.version = text();
			break;
		case mndpTlvType.platform:
			neighbor.platform = text();
			break;
		case mndpTlvType.board:
			neighbor.board = text();
			break;
		case mndpTlvType.boardAlt:
			// Some firmware uses type 13; prefer type 12 when both are present.
			if (neighbor.board === undefined) {
				neighbor.board = text();
			}
			break;
		case mndpTlvType.uptime:
			if (value.length >= 4) {
				neighbor.uptimeSeconds = view.getUint32(valueStart, true);
			}
			break;
		case mndpTlvType.softwareId:
			neighbor.softwareId = text();
			break;
		case mndpTlvType.unpack:
			if (value.length >= 1) {
				neighbor.unpack = value[0];
			}
			break;
		case mndpTlvType.ipv6:
			if (value.length === 16) {
				neighbor.ipv6 = formatIpv6(value);
			} else {
				neighbor.unknownTlvs.push({ type, value: value.slice() });
			}
			break;
		case mndpTlvType.interfaceName:
			neighbor.interfaceName = text();
			break;
		case mndpTlvType.ipv4:
			if (value.length === 4) {
				neighbor.ipv4 = formatIpv4(value);
			} else {
				neighbor.unknownTlvs.push({ type, value: value.slice() });
			}
			break;
		default:
			neighbor.unknownTlvs.push({ type, value: value.slice() });
			break;
	}
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

function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

/**
 * Encode a {@link MndpNeighbor} (plus any extra raw TLVs) back into a wire
 * packet. Primarily a round-trip aid for tests and for crafting fixtures; the
 * field order mirrors the TLV type ordering RouterOS emits.
 */
export function encodeMndpPacket(
	neighbor: Partial<MndpNeighbor> & { sequence?: number },
	extraTlvs: readonly MndpTlvInput[] = [],
): Uint8Array {
	const tlvs: MndpTlvInput[] = [];
	if (neighbor.macAddress !== undefined) {
		tlvs.push({
			type: mndpTlvType.macAddress,
			value: macToBytes(neighbor.macAddress),
		});
	}
	if (neighbor.identity !== undefined) {
		tlvs.push({ type: mndpTlvType.identity, value: utf8(neighbor.identity) });
	}
	if (neighbor.version !== undefined) {
		tlvs.push({ type: mndpTlvType.version, value: utf8(neighbor.version) });
	}
	if (neighbor.platform !== undefined) {
		tlvs.push({ type: mndpTlvType.platform, value: utf8(neighbor.platform) });
	}
	if (neighbor.board !== undefined) {
		tlvs.push({ type: mndpTlvType.board, value: utf8(neighbor.board) });
	}
	if (neighbor.uptimeSeconds !== undefined) {
		const value = new Uint8Array(4);
		new DataView(value.buffer).setUint32(0, neighbor.uptimeSeconds, true);
		tlvs.push({ type: mndpTlvType.uptime, value });
	}
	if (neighbor.softwareId !== undefined) {
		tlvs.push({
			type: mndpTlvType.softwareId,
			value: utf8(neighbor.softwareId),
		});
	}
	if (neighbor.unpack !== undefined) {
		tlvs.push({
			type: mndpTlvType.unpack,
			value: Uint8Array.from([neighbor.unpack & 0xff]),
		});
	}
	if (neighbor.interfaceName !== undefined) {
		tlvs.push({
			type: mndpTlvType.interfaceName,
			value: utf8(neighbor.interfaceName),
		});
	}
	if (neighbor.ipv4 !== undefined) {
		tlvs.push({ type: mndpTlvType.ipv4, value: ipv4ToBytes(neighbor.ipv4) });
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
	view.setUint16(0, 0, false);
	view.setUint16(2, neighbor.sequence ?? 0, false);

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
 * MNDP discovery request that prompts immediate replies. The reply trigger is
 * the leading zeroed 4-byte header (the same minimal form MAC-Telnet sends);
 * RouterOS accepts longer forms too, so this emits the 9-byte all-zero variant.
 * See the `routeros-mndp` skill "Refresh Packet" section.
 */
export function mndpRefreshPacket(): Uint8Array {
	return new Uint8Array(9);
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
