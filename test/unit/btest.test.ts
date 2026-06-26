/**
 * btest wire codec — pinned to `manawenuz/btest-rs` `src/protocol.rs` (the
 * working impl, MITM-verified vs RouterOS 7.x). These are the router-free anchor
 * tests for the pure codec; the EC-SRP5 reconciliation lives in `ec-srp5.test.ts`
 * and the live path in `test/integration/btest.test.ts`. Vectors are chosen to be
 * non-ambiguous about endianness and field offsets.
 */

import { describe, expect, test } from "bun:test";
import {
	BTEST_DIR_BOTH,
	BTEST_DIR_RX,
	BTEST_DIR_TX,
	classifyAuthResponse,
	clientUdpPort,
	decodeCommand,
	decodeStatus,
	defaultTxSize,
	encodeAuthOk,
	encodeClientHello,
	encodeCommand,
	encodeSecondaryJoin,
	encodeServerChallenge,
	encodeStatus,
	encodeUdpPacket,
	parseClientHello,
	parseServerChallenge,
	readUdpSequence,
	serverDirectionByte,
	sessionTokenFromResponse,
	sessionTokenFromSecondary,
} from "../../src/protocols/btest.ts";

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("btest command packet", () => {
	test("TCP transmit matches the captured example", () => {
		// docs/protocol.md: "TCP transmit: 01 01 01 00 00 80 00 00 00 00 00 00 00 00 00 00"
		const cmd = encodeCommand({ protocol: "tcp", direction: "transmit" });
		expect(hex(cmd)).toBe("01010100008000000000000000000000");
	});

	test("UDP receive matches the captured example", () => {
		// docs/protocol.md: "UDP receive: 00 02 01 00 DC 05 00 00 00 00 00 00 00 00 00 00"
		const cmd = encodeCommand({ protocol: "udp", direction: "receive" });
		expect(hex(cmd)).toBe("00020100dc05".padEnd(32, "0"));
	});

	test("direction inverts to the server perspective", () => {
		expect(serverDirectionByte("transmit")).toBe(BTEST_DIR_RX);
		expect(serverDirectionByte("receive")).toBe(BTEST_DIR_TX);
		expect(serverDirectionByte("both")).toBe(BTEST_DIR_BOTH);
	});

	test("default tx sizes follow the protocol", () => {
		expect(defaultTxSize("tcp")).toBe(32768);
		expect(defaultTxSize("udp")).toBe(1500);
	});

	test("decode recovers the server-perspective fields", () => {
		const cmd = encodeCommand({
			protocol: "tcp",
			direction: "both",
			tcpConnectionCount: 4,
			remoteTxSpeed: 1_000_000,
			localTxSpeed: 2_000_000,
		});
		const decoded = decodeCommand(cmd);
		expect(decoded.protocol).toBe("tcp");
		expect(decoded.serverTransmits).toBe(true);
		expect(decoded.serverReceives).toBe(true);
		expect(decoded.tcpConnectionCount).toBe(4);
		expect(decoded.txSize).toBe(32768);
		expect(decoded.remoteTxSpeed).toBe(1_000_000);
		expect(decoded.localTxSpeed).toBe(2_000_000);
		expect(decoded.randomData).toBe(false); // byte2 = 0x01 (zeros)
	});

	test("server transmit-only is server-receives=false", () => {
		const decoded = decodeCommand(
			encodeCommand({ protocol: "udp", direction: "receive" }),
		);
		expect(decoded.serverTransmits).toBe(true);
		expect(decoded.serverReceives).toBe(false);
	});
});

describe("btest auth response classification", () => {
	test("maps the four control words by their first byte", () => {
		expect(classifyAuthResponse(Uint8Array.of(1, 0, 0, 0))).toBe("none");
		expect(classifyAuthResponse(Uint8Array.of(2, 0, 0, 0))).toBe("md5");
		expect(classifyAuthResponse(Uint8Array.of(3, 0, 0, 0))).toBe("ec-srp5");
		expect(classifyAuthResponse(Uint8Array.of(0, 0, 0, 0))).toBe("failed");
		expect(classifyAuthResponse(Uint8Array.of(9, 0, 0, 0))).toBe("unknown");
	});

	test("an OK response carrying a session token is still 'none'", () => {
		// TCP multi-conn OK: 01 <tokenHi> <tokenLo> 00
		expect(classifyAuthResponse(Uint8Array.of(0x01, 0xab, 0xcd, 0))).toBe(
			"none",
		);
	});
});

describe("btest TCP multi-connection session token", () => {
	test("encodes an OK-with-token and reads it back", () => {
		const ok = encodeAuthOk(0x1234);
		expect(hex(ok)).toBe("01123400");
		expect(classifyAuthResponse(ok)).toBe("none");
		expect(sessionTokenFromResponse(ok)).toBe(0x1234);
	});

	test("plain AUTH_OK has token 0", () => {
		expect(hex(encodeAuthOk())).toBe("01000000");
		expect(sessionTokenFromResponse(Uint8Array.of(1, 0, 0, 0))).toBe(0);
	});

	test("a secondary join carries the token in bytes 0-1 + 0x02 marker", () => {
		// Grounded against RouterOS 7.23.1: secondary connections send
		// `[token:u16 BE][0x02][0x00 …]` (16 bytes), direction-independent.
		const join = encodeSecondaryJoin(0xabcd);
		expect(join.length).toBe(16);
		expect(hex(join)).toBe("abcd0200000000000000000000000000");
		expect(sessionTokenFromSecondary(join)).toBe(0xabcd);
	});
});

describe("btest status message (protocol.rs layout)", () => {
	test("encode sets the CPU high bit, with little-endian seq and bytes", () => {
		// [0x07][0x80|cpu][0][0][seq u32 LE][bytesReceived u32 LE]
		const status = encodeStatus(1, 45_362_624, 0);
		expect(hex(status)).toBe("0780000001000000c02db402");
	});

	test("decodes RouterOS's server status (CPU byte without the high bit)", () => {
		// docs capture "Server sends": 07 00 00 00 01 00 00 00 C0 2D B4 02
		const decoded = decodeStatus(
			Uint8Array.of(0x07, 0, 0, 0, 0x01, 0, 0, 0, 0xc0, 0x2d, 0xb4, 0x02),
		);
		expect(decoded).toEqual({ cpuLoad: 0, seq: 1, bytesReceived: 45_362_624 });
	});

	test("decodes a client status with the CPU high bit set (proves seq @4-7)", () => {
		// docs capture "Client sends": 07 D9 00 00 01 00 00 00 00 00 00 00 (cpu 0xD9&0x7F=89)
		const decoded = decodeStatus(
			Uint8Array.of(0x07, 0xd9, 0, 0, 0x01, 0, 0, 0, 0, 0, 0, 0),
		);
		expect(decoded).toEqual({ cpuLoad: 89, seq: 1, bytesReceived: 0 });
	});

	test("round-trips seq, bytes, and CPU load", () => {
		const decoded = decodeStatus(encodeStatus(0xdeadbeef, 123_456, 42));
		expect(decoded).toEqual({
			cpuLoad: 42,
			seq: 0xdeadbeef,
			bytesReceived: 123_456,
		});
	});
});

describe("btest EC-SRP5 auth framing", () => {
	test("client hello round-trips username + 33-byte pubkey", () => {
		const pubkey = Uint8Array.from({ length: 33 }, (_, i) => i + 1);
		const frame = encodeClientHello("antar", pubkey);
		// [len][username\0][pubkey:33] => len = 5 + 1 + 33 = 39 (0x27)
		expect(frame[0]).toBe(0x27);
		const parsed = parseClientHello(frame.subarray(1));
		expect(parsed.username).toBe("antar");
		expect(hex(parsed.publicKey)).toBe(hex(pubkey));
	});

	test("server challenge round-trips pubkey + salt and is length 0x31", () => {
		const serverKey = Uint8Array.from({ length: 33 }, (_, i) => i + 100);
		const salt = Uint8Array.from({ length: 16 }, (_, i) => i + 200);
		const frame = encodeServerChallenge(serverKey, salt);
		expect(frame[0]).toBe(0x31); // 33 + 16 = 49
		const parsed = parseServerChallenge(frame.subarray(1));
		expect(hex(parsed.serverPublicKey)).toBe(hex(serverKey));
		expect(hex(parsed.salt)).toBe(hex(salt));
	});
});

describe("btest UDP data", () => {
	test("packet carries a big-endian sequence header and target size", () => {
		const pkt = encodeUdpPacket(0x01020304, 1500);
		expect(pkt.length).toBe(1500);
		expect(readUdpSequence(pkt)).toBe(0x01020304);
		expect(hex(pkt.subarray(0, 4))).toBe("01020304");
	});

	test("client UDP port is server port + 256", () => {
		expect(clientUdpPort(2042)).toBe(2298);
		expect(clientUdpPort(2001)).toBe(2257);
	});
});

describe("btest strict decoding (hostile peer)", () => {
	test("rejects an invalid protocol byte", () => {
		const cmd = encodeCommand({ protocol: "tcp", direction: "transmit" });
		cmd[0] = 2; // proto must be 0/1
		expect(() => decodeCommand(cmd)).toThrow();
	});

	test("rejects invalid direction bytes (0 and >3)", () => {
		const cmd = encodeCommand({ protocol: "tcp", direction: "transmit" });
		cmd[1] = 0;
		expect(() => decodeCommand(cmd)).toThrow();
		cmd[1] = 4;
		expect(() => decodeCommand(cmd)).toThrow();
	});

	test("rejects a short command buffer", () => {
		expect(() => decodeCommand(new Uint8Array(15))).toThrow();
	});

	test("server challenge parse requires exactly 49 bytes", () => {
		expect(() => parseServerChallenge(new Uint8Array(48))).toThrow();
		expect(() => parseServerChallenge(new Uint8Array(50))).toThrow();
	});

	test("client hello parse rejects trailing bytes", () => {
		const payload = encodeClientHello("u", new Uint8Array(33)).subarray(1);
		expect(parseClientHello(payload).username).toBe("u");
		expect(() =>
			parseClientHello(new Uint8Array([...payload, 0x00])),
		).toThrow();
	});
});

describe("btest strict encoding (no silent coercion)", () => {
	test("rejects connection-count > 255", () => {
		expect(() =>
			encodeCommand({
				protocol: "tcp",
				direction: "transmit",
				tcpConnectionCount: 300,
			}),
		).toThrow();
	});

	test("rejects tx-size > 65535", () => {
		expect(() =>
			encodeCommand({ protocol: "udp", direction: "receive", txSize: 70_000 }),
		).toThrow();
	});

	test("rejects a speed beyond the 32-bit wire field", () => {
		expect(() =>
			encodeCommand({
				protocol: "tcp",
				direction: "both",
				localTxSpeed: 0x1_0000_0000,
			}),
		).toThrow();
	});

	test("rejects a UDP packet smaller than the 4-byte seq header", () => {
		expect(() => encodeUdpPacket(0, 2)).toThrow();
	});
});
