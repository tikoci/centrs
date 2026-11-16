// Fragments of a lab software-id and IPv6 hex in the fixtures below.
// cspell:ignore Vmu fedd
import { describe, expect, test } from "bun:test";
import {
	encodeMndpPacket,
	type MndpNeighbor,
	mndpNeighborKey,
	mndpRefreshPacket,
	mndpRunningBit,
	mndpRunningNames,
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

/**
 * Hex of a real MNDP announcement captured from the `bigdude` test router
 * (7.24beta1, RB1100Dx4/ARM, so a little-endian header counter).
 */
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

/** A 4-byte header carrying `counter` as a little-endian u32 (x86/ARM order). */
function header(counter: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, counter, true);
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

/**
 * Disposable-CHR payloads (7.26beta5, x86_64) lifted verbatim from the
 * tikoci/m2ir MNDP grounding lab: `work/2026-11-mndp-grounding/evidence/`,
 * IPv4 copy of the subject's announcement for the named step. See
 * tikoci/m2ir#4 and centrs#668.
 */
const LAB = {
	/** probe-7.26beta5.json `baseline-default` (default settings). */
	baseline:
		"0800000000010006027ed12a671c0005000d6d6e64702d6f627365727665720007001d372e3236626574613520323032362d31302d33302031313a31333a3535000800084d696b726f54696b000a0004cc000000000b000b6c4457696c566d7549614a000c0003434852000e000101001000066574686572320012000100001300017900110004c0000201000f0010fe80000000000000007ed1fffe2a671c",
	/** probe-7.26beta5.json `packing:simple`. */
	packingSimple:
		"0c0000000001000602aa13dd4f2c0002000000090004dc0500000005000c6d6e64702d7375626a6563740007001d372e3236626574613520323032362d31302d33302031313a31333a3535000800084d696b726f54696b000a0004fc000000000b000b54747a6467727348716d4f000c0003434852000e000101001000066574686572320012000100001300017900110004c0000202000f0010fe8000000000000000aa13fffedd4f2c",
	/** probe-7.26beta5.json `packing:compress-headers`. */
	packingHeaders:
		"0d0000000001000602aa13dd4f2c000200000003000000090004dc0500000005000c6d6e64702d7375626a6563740007001d372e3236626574613520323032362d31302d33302031313a31333a3535000800084d696b726f54696b000a000404010000000b000b54747a6467727348716d4f000c0003434852000e000101001000066574686572320012000100001300017900110004c0000202000f0010fe8000000000000000aa13fffedd4f2c",
	/** probe-7.26beta5.json `packing:compress-all`. */
	packingAll:
		"0e0000000001000602aa13dd4f2c00020000000300000004000000090004dc0500000005000c6d6e64702d7375626a6563740007001d372e3236626574613520323032362d31302d33302031313a31333a3535000800084d696b726f54696b000a00040c010000000b000b54747a6467727348716d4f000c0003434852000e000101001000066574686572320012000100001300017900110004c0000202000f0010fe8000000000000000aa13fffedd4f2c",
	/** probe-7.26beta5.json `ipv6:on` (`/ipv6/settings disable-ipv6=yes`). */
	ipv6Disabled:
		"1b0000000001000602aa13dd4f2c0005000c6d6e64702d7375626a6563740007001d372e3236626574613520323032362d31302d33302031313a31333a3535000800084d696b726f54696b000a000407020000000b000b54747a6467727348716d4f000c0003434852000e000100001000066574686572320012000100001300017900110004c0000202",
	/** probe-7.26beta5.json `capsman:on`. */
	capsman:
		"130000000001000602aa13dd4f2c0005000c6d6e64702d7375626a6563740007001d372e3236626574613520323032362d31302d33302031313a31333a3535000800084d696b726f54696b000a000434010000000b000b54747a6467727348716d4f000c0003434852000e000101001000066574686572320012000101001300017900110004c0000202000f0010fe8000000000000000aa13fffedd4f2c",
	/** dying-gasp-7.26beta5.json `dg-reboot`. */
	dyingGasp:
		"c10000000001000602aa13dd4f2c001300010000110004c0000202000f0010fe8000000000000000aa13fffedd4f2c",
	/** ttl-7.26beta5.json `interval-5s`. */
	ttl5s:
		"a20000000001000602aa13dd4f2c0005000c6d6e64702d7375626a6563740007001d372e3236626574613520323032362d31302d33302031313a31333a3535000800084d696b726f54696b000a000404050000000b000b54747a6467727348716d4f000c0003434852000e000101001000066574686572320012000100001300011500110004c0000202000f0010fe8000000000000000aa13fffedd4f2c",
	/** ttl-7.26beta5.json `interval-9h`. */
	ttl9h:
		"aa0000000001000602aa13dd4f2c0005000c6d6e64702d7375626a6563740007001d372e3236626574613520323032362d31302d33302031313a31333a3535000800084d696b726f54696b000a000425050000000b000b54747a6467727348716d4f000c0003434852000e00010100100006657468657232001200010000130001ff00110004c0000202000f0010fe8000000000000000aa13fffedd4f2c",
} as const;

function u32le(value: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value, true);
	return out;
}

describe("parseMndpPacket", () => {
	test("decodes a full RouterOS announcement", () => {
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
			tlv(mndpTlvType.uptime, u32le(123_456)),
			tlv(mndpTlvType.softwareId, utf8("ABCD-1234")),
			tlv(mndpTlvType.interfaceName, utf8("ether1")),
			tlv(mndpTlvType.ipv4, Uint8Array.from([192, 0, 2, 5])),
		);

		const neighbor = parseMndpPacket(packet);
		expect(neighbor.headerHex).toBe("07000000");
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
		// type 10=uptime, 11=software-id, 12=board. TLV order is 7.24beta1's
		// (1, 5, 7, 8, 10, 11, 12, 14, 16, 18, 17); later versions differ.
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
		expect(neighbor.ipv6Enabled).toBe(false);
		expect(neighbor.running).toBe(0);
		expect(neighbor.ttlSeconds).toBeUndefined();
		// `ef 65 00 00` is 26,095 little-endian (ARM): uptime ÷ counter ≈ 10 s, the
		// router's discover-interval. The old big-endian u16 at bytes 2–3 read 0.
		expect(neighbor.headerHex).toBe("ef650000");
		expect(neighbor.unknownTlvs).toHaveLength(0);
	});

	test("decodes a 7.26beta5 default announcement (m2ir lab baseline)", () => {
		const neighbor = parseMndpPacket(fromHex(LAB.baseline));
		expect(neighbor).toEqual({
			headerHex: "08000000",
			macAddress: "02:7e:d1:2a:67:1c",
			identity: "mndp-observer",
			version: "7.26beta5 2026-10-30 11:13:55",
			platform: "MikroTik",
			uptimeSeconds: 204,
			softwareId: "lDWilVmuIaJ",
			board: "CHR",
			ipv6Enabled: true,
			interfaceName: "ether2",
			running: 0,
			ttlSeconds: 121,
			ipv4: "192.0.2.1",
			ipv6Addresses: ["fe80::7e:d1ff:fe2a:671c"],
			unknownTlvs: [],
		});
	});

	test("derives unpack from the TLV 2/3/4 flags and reads TLV 9 aggregated-size", () => {
		const simple = parseMndpPacket(fromHex(LAB.packingSimple));
		expect(simple.unpack).toBe("simple");
		expect(simple.aggregatedSize).toBe(1500);
		expect(parseMndpPacket(fromHex(LAB.packingHeaders)).unpack).toBe(
			"uncompress-headers",
		);
		const all = parseMndpPacket(fromHex(LAB.packingAll));
		expect(all.unpack).toBe("uncompress-all");
		expect(all.aggregatedSize).toBe(1500);
		expect(all.identity).toBe("mndp-subject");
		expect(all.unknownTlvs).toHaveLength(0);
		// No packing entry: no TLVs 2–4/9 and no unpack field.
		const none = parseMndpPacket(fromHex(LAB.baseline));
		expect(none.unpack).toBeUndefined();
		expect(none.aggregatedSize).toBeUndefined();
	});

	test("reads TLV 14 as the IPv6-enabled flag, not unpack", () => {
		const neighbor = parseMndpPacket(fromHex(LAB.ipv6Disabled));
		expect(neighbor.ipv6Enabled).toBe(false);
		expect(neighbor.unpack).toBeUndefined();
		expect(neighbor.ipv6Addresses).toBeUndefined();
	});

	test("reads TLV 18 running: CAPsMAN sets bit 0x01", () => {
		const neighbor = parseMndpPacket(fromHex(LAB.capsman));
		expect(neighbor.running).toBe(mndpRunningBit.capsman);
		expect(mndpRunningNames(neighbor.running ?? 0)).toEqual(["capsman"]);
	});

	test("reads TLV 19 TTL seconds", () => {
		// discover-interval 5s → 5 × 4 + 1 = 21; 9h saturates at 255.
		expect(parseMndpPacket(fromHex(LAB.ttl5s)).ttlSeconds).toBe(21);
		expect(parseMndpPacket(fromHex(LAB.ttl9h)).ttlSeconds).toBe(255);
	});

	test("decodes a dying gasp (TLVs 1, 19 = 0, 17, 15)", () => {
		const neighbor = parseMndpPacket(fromHex(LAB.dyingGasp));
		expect(neighbor).toEqual({
			headerHex: "c1000000",
			macAddress: "02:aa:13:dd:4f:2c",
			ttlSeconds: 0,
			ipv4: "192.0.2.2",
			ipv6Addresses: ["fe80::aa:13ff:fedd:4f2c"],
			unknownTlvs: [],
		});
	});

	test("keeps every repeated TLV 15 address in arrival order", () => {
		const global = Uint8Array.from([
			0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
		]);
		const linkLocal = Uint8Array.from([
			0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
		]);
		const neighbor = parseMndpPacket(
			concat(
				header(1),
				tlv(mndpTlvType.ipv6Address, global),
				tlv(mndpTlvType.ipv6Address, linkLocal),
			),
		);
		expect(neighbor.ipv6Addresses).toEqual(["2001:db8::1", "fe80::1"]);
	});

	test("keeps the header raw in either CPU byte order", () => {
		// m2ir field capture: a MIPSBE RB912R sent `00 00 23 58` (9,048
		// big-endian) and an ARM RB1100Dx4 sent `20 7c 01 00` (97,312
		// little-endian). The packet does not say which order it uses.
		expect(
			parseMndpPacket(Uint8Array.from([0x00, 0x00, 0x23, 0x58])).headerHex,
		).toBe("00002358");
		expect(
			parseMndpPacket(Uint8Array.from([0x20, 0x7c, 0x01, 0x00])).headerHex,
		).toBe("207c0100");
	});

	test("does not guess a counter from uptime", () => {
		// 65,536 little-endian announcements in 60,000 s (sustained triggered
		// announcements) reads as a plausible 256 big-endian; no uptime bound
		// separates the two, so the codec exposes neither (PR #669 review).
		const neighbor = parseMndpPacket(
			concat(
				Uint8Array.from([0x00, 0x00, 0x01, 0x00]),
				tlv(mndpTlvType.uptime, u32le(60_000)),
			),
		);
		expect(neighbor.headerHex).toBe("00000100");
		expect(neighbor).not.toHaveProperty("counter");
	});

	test("preserves type 13 as an unknown TLV (never seen on the wire)", () => {
		const neighbor = parseMndpPacket(
			concat(header(1), tlv(13, utf8("not-a-board"))),
		);
		expect(neighbor.board).toBeUndefined();
		expect(neighbor.unknownTlvs.map((item) => item.type)).toEqual([13]);
	});

	test("preserves a known TLV with an unexpected length as unknown", () => {
		const neighbor = parseMndpPacket(
			concat(
				header(1),
				tlv(mndpTlvType.ttl, Uint8Array.from([0, 1])),
				tlv(mndpTlvType.unpackSimple, Uint8Array.from([1])),
				tlv(mndpTlvType.request, Uint8Array.from([1])),
			),
		);
		expect(neighbor.ttlSeconds).toBeUndefined();
		expect(neighbor.unpack).toBeUndefined();
		expect(neighbor.request).toBeUndefined();
		expect(neighbor.unknownTlvs.map((item) => item.type)).toEqual([19, 2, 6]);
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

	test("the refresh packet is header 0 plus an empty TLV 6, with no trailing bytes", () => {
		// m2ir#5: RouterOS drops a request whose TLVs do not end exactly at the
		// end of the datagram (9 zero bytes: 0 replies in 11 sends).
		const packet = mndpRefreshPacket();
		expect(Array.from(packet)).toEqual([0, 0, 0, 0, 0, 6, 0, 0]);
		const neighbor = parseMndpPacket(packet);
		expect(neighbor).toEqual({
			headerHex: "00000000",
			request: true,
			unknownTlvs: [],
		});
		expect(encodeMndpPacket({ request: true })).toEqual(packet);
	});
});

describe("mndpRunningNames", () => {
	test("names the grounded bits and keeps unknown bits visible", () => {
		expect(mndpRunningNames(0)).toEqual([]);
		expect(mndpRunningNames(0x02)).toEqual(["cmr"]);
		// m2ir#5: `03` prints as `running=capsman,cmr`.
		expect(mndpRunningNames(0x03)).toEqual(["capsman", "cmr"]);
		expect(mndpRunningNames(0x07)).toEqual(["capsman", "cmr", "bit2"]);
	});
});

describe("encodeMndpPacket", () => {
	test("round-trips a neighbor through decode", () => {
		const original: Partial<MndpNeighbor> = {
			headerHex: "09000000",
			macAddress: "aa:bb:cc:dd:ee:ff",
			unpack: "uncompress-headers",
			aggregatedSize: 1000,
			identity: "rt-1",
			version: "7.15.3",
			platform: "MikroTik",
			board: "CHR",
			uptimeSeconds: 4242,
			softwareId: "ABCD-9999",
			ipv6Enabled: false,
			interfaceName: "ether2",
			running: mndpRunningBit.cmrController,
			ttlSeconds: 121,
			ipv4: "10.0.0.1",
		};
		const decoded = parseMndpPacket(encodeMndpPacket(original));
		expect(decoded).toEqual({
			...original,
			unknownTlvs: [],
		} as MndpNeighbor);
	});

	test("writes headerHex verbatim and rejects a malformed one", () => {
		const packet = encodeMndpPacket({ headerHex: "00002358" });
		expect(Array.from(packet.subarray(0, 4))).toEqual([0x00, 0x00, 0x23, 0x58]);
		let caught: unknown;
		try {
			encodeMndpPacket({ headerHex: "2358" });
		} catch (error) {
			caught = error;
		}
		expect((caught as CentrsError).code).toBe("mndp/encode-failed");
	});

	test("appends extra raw TLVs that survive as unknown TLVs", () => {
		const packet = encodeMndpPacket({ macAddress: "00:11:22:33:44:55" }, [
			{ type: 0x4242, value: Uint8Array.from([1, 2, 3]) },
		]);
		const decoded = parseMndpPacket(packet);
		expect(decoded.unknownTlvs[0]?.type).toBe(0x4242);
	});
});

describe("mndpNeighborKey", () => {
	test("keys on the lower-cased MAC when present", () => {
		expect(
			mndpNeighborKey({
				headerHex: "00000000",
				macAddress: "AA:BB:CC:DD:EE:FF",
				unknownTlvs: [],
			}),
		).toBe("aa:bb:cc:dd:ee:ff");
	});

	test("falls back to identity + interface when MAC is absent", () => {
		expect(
			mndpNeighborKey({
				headerHex: "00000000",
				identity: "rt",
				interfaceName: "ether1",
				unknownTlvs: [],
			}),
		).toBe("noaddr:rt:ether1");
	});
});
