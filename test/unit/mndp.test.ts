import { describe, expect, test } from "bun:test";
import {
	encodeMndpPacket,
	type MndpNeighbor,
	mndpNeighborKey,
	mndpRefreshPacket,
	mndpTlvType,
	parseMndpPacket,
} from "../../src/data/mndp.ts";
import { CentrsError } from "../../src/errors.ts";

function tlv(type: number, value: Uint8Array): Uint8Array {
	const out = new Uint8Array(4 + value.length);
	const view = new DataView(out.buffer);
	view.setUint16(0, type, true);
	view.setUint16(2, value.length, true);
	out.set(value, 4);
	return out;
}

function header(sequence: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint16(2, sequence, false);
	return out;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("parseMndpPacket", () => {
	test("decodes a full RouterOS announcement", () => {
		const uptime = new Uint8Array(4);
		new DataView(uptime.buffer).setUint32(0, 123_456, true);
		const packet = concat(
			header(7),
			tlv(
				mndpTlvType.macAddress,
				Uint8Array.from([0xe4, 0x8d, 0x8c, 0x11, 0x22, 0x33]),
			),
			tlv(mndpTlvType.identity, utf8("edge-router")),
			tlv(mndpTlvType.version, utf8("7.18 (stable)")),
			tlv(mndpTlvType.platform, utf8("MikroTik")),
			tlv(mndpTlvType.board, utf8("RB4011iGS+5HacQ2HnD")),
			tlv(mndpTlvType.uptime, uptime),
			tlv(mndpTlvType.softwareId, utf8("ABCD-1234")),
			tlv(mndpTlvType.interfaceName, utf8("ether1")),
			tlv(mndpTlvType.ipv4, Uint8Array.from([192, 0, 2, 5])),
		);

		const neighbor = parseMndpPacket(packet);
		expect(neighbor.sequence).toBe(7);
		expect(neighbor.macAddress).toBe("e4:8d:8c:11:22:33");
		expect(neighbor.identity).toBe("edge-router");
		expect(neighbor.version).toBe("7.18 (stable)");
		expect(neighbor.platform).toBe("MikroTik");
		expect(neighbor.board).toBe("RB4011iGS+5HacQ2HnD");
		expect(neighbor.uptimeSeconds).toBe(123_456);
		expect(neighbor.softwareId).toBe("ABCD-1234");
		expect(neighbor.interfaceName).toBe("ether1");
		expect(neighbor.ipv4).toBe("192.0.2.5");
		expect(neighbor.unknownTlvs).toHaveLength(0);
	});

	test("prefers board type 10 over the type 13 alternate", () => {
		const packet = concat(
			header(1),
			tlv(mndpTlvType.boardAlt, utf8("alt-board")),
			tlv(mndpTlvType.board, utf8("primary-board")),
		);
		expect(parseMndpPacket(packet).board).toBe("primary-board");
	});

	test("falls back to board type 13 when type 10 is absent", () => {
		const packet = concat(
			header(1),
			tlv(mndpTlvType.boardAlt, utf8("only-alt")),
		);
		expect(parseMndpPacket(packet).board).toBe("only-alt");
	});

	test("preserves an unknown TLV type without throwing", () => {
		const packet = concat(
			header(2),
			tlv(mndpTlvType.macAddress, Uint8Array.from([0, 1, 2, 3, 4, 5])),
			tlv(0x00ff, Uint8Array.from([0xde, 0xad, 0xbe, 0xef])),
			tlv(mndpTlvType.identity, utf8("keep-going")),
		);
		const neighbor = parseMndpPacket(packet);
		expect(neighbor.identity).toBe("keep-going");
		expect(neighbor.unknownTlvs).toHaveLength(1);
		expect(neighbor.unknownTlvs[0]?.type).toBe(0x00ff);
		expect(Array.from(neighbor.unknownTlvs[0]?.value ?? [])).toEqual([
			0xde, 0xad, 0xbe, 0xef,
		]);
	});

	test("throws mndp/malformed on a too-short header", () => {
		let caught: unknown;
		try {
			parseMndpPacket(Uint8Array.from([0, 0]));
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CentrsError);
		expect((caught as CentrsError).code).toBe("mndp/malformed");
	});

	test("throws mndp/malformed on a TLV length that overruns the buffer", () => {
		// Declares a 10-byte value but supplies only 2 bytes.
		const truncated = concat(
			header(1),
			Uint8Array.from([0x05, 0x00, 0x0a, 0x00, 0x41, 0x42]),
		);
		let caught: unknown;
		try {
			parseMndpPacket(truncated);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CentrsError);
		expect((caught as CentrsError).code).toBe("mndp/malformed");
	});

	test("treats the 9-byte refresh packet as a MAC-less neighbor", () => {
		const neighbor = parseMndpPacket(mndpRefreshPacket());
		expect(neighbor.macAddress).toBeUndefined();
		expect(neighbor.sequence).toBe(0);
	});
});

describe("encodeMndpPacket", () => {
	test("round-trips a neighbor through decode", () => {
		const original: Partial<MndpNeighbor> = {
			sequence: 9,
			macAddress: "aa:bb:cc:dd:ee:ff",
			identity: "rt-1",
			version: "7.15.3",
			platform: "MikroTik",
			board: "CHR",
			uptimeSeconds: 4242,
			softwareId: "ABCD-9999",
			interfaceName: "ether2",
			ipv4: "10.0.0.1",
		};
		const decoded = parseMndpPacket(encodeMndpPacket(original));
		expect(decoded.macAddress).toBe("aa:bb:cc:dd:ee:ff");
		expect(decoded.identity).toBe("rt-1");
		expect(decoded.version).toBe("7.15.3");
		expect(decoded.board).toBe("CHR");
		expect(decoded.uptimeSeconds).toBe(4242);
		expect(decoded.softwareId).toBe("ABCD-9999");
		expect(decoded.interfaceName).toBe("ether2");
		expect(decoded.ipv4).toBe("10.0.0.1");
		expect(decoded.sequence).toBe(9);
	});

	test("appends extra raw TLVs that survive as unknown TLVs", () => {
		const packet = encodeMndpPacket(
			{ sequence: 0, macAddress: "00:11:22:33:44:55" },
			[{ type: 0x4242, value: Uint8Array.from([1, 2, 3]) }],
		);
		const decoded = parseMndpPacket(packet);
		expect(decoded.unknownTlvs[0]?.type).toBe(0x4242);
	});
});

describe("mndpNeighborKey", () => {
	test("keys on the lower-cased MAC when present", () => {
		expect(
			mndpNeighborKey({
				sequence: 0,
				macAddress: "AA:BB:CC:DD:EE:FF",
				unknownTlvs: [],
			}),
		).toBe("aa:bb:cc:dd:ee:ff");
	});

	test("falls back to identity + interface when MAC is absent", () => {
		expect(
			mndpNeighborKey({
				sequence: 0,
				identity: "rt",
				interfaceName: "ether1",
				unknownTlvs: [],
			}),
		).toBe("noaddr:rt:ether1");
	});
});
