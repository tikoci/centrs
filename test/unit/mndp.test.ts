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
	view.setUint16(0, type, false);
	view.setUint16(2, value.length, false);
	out.set(value, 4);
	return out;
}

/** Hex of a real MNDP announcement captured from the `bigdude` test router. */
const BIGDUDE_PACKET_HEX =
	"ef65000000010006965d807dbf5900050007626967647564650007002b372e323462" +
	"657461312028646576656c6f706d656e742920323032362d30352d32362031303a34" +
	"373a35320008000c536b7946692d616c70686131000a00040df90300000b00094256" +
	"35412d35474239000c0009524231313030447834000e0001000010000b6d6163766c" +
	"616e2d6c616e001200010000110004c0a84a01";

function fromHex(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let index = 0; index < out.length; index += 1) {
		out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
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

	test("parses a real captured RouterOS announcement (big-endian TLVs)", () => {
		// Grounded fixture: bytes captured from the `bigdude` test router. Its
		// REST facts cross-check every decoded field (board RB1100Dx4, version
		// 7.24beta1, uptime ~3d), proving the TLV headers are big-endian and that
		// type 10=uptime, 11=software-id, 12=board.
		const neighbor = parseMndpPacket(fromHex(BIGDUDE_PACKET_HEX));
		expect(neighbor.macAddress).toBe("96:5d:80:7d:bf:59");
		expect(neighbor.identity).toBe("bigdude");
		expect(neighbor.version).toBe(
			"7.24beta1 (development) 2026-05-26 10:47:52",
		);
		expect(neighbor.platform).toBe("SkyFi-alpha1");
		expect(neighbor.uptimeSeconds).toBe(260_365);
		expect(neighbor.softwareId).toBe("BV5A-5GB9");
		expect(neighbor.board).toBe("RB1100Dx4");
		expect(neighbor.interfaceName).toBe("macvlan-lan");
		expect(neighbor.ipv4).toBe("192.168.74.1");
	});

	test("prefers board type 12 over the type 13 alternate", () => {
		const packet = concat(
			header(1),
			tlv(mndpTlvType.boardAlt, utf8("alt-board")),
			tlv(mndpTlvType.board, utf8("primary-board")),
		);
		expect(parseMndpPacket(packet).board).toBe("primary-board");
	});

	test("falls back to board type 13 when type 12 is absent", () => {
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
		// Declares a 10-byte value (big-endian type 5, length 10) but supplies
		// only 2 bytes.
		const truncated = concat(
			header(1),
			Uint8Array.from([0x00, 0x05, 0x00, 0x0a, 0x41, 0x42]),
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
