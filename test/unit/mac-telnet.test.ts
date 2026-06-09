import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	buildPacket,
	decodeHeader,
	directedBroadcast,
	encodeControlBlock,
	encodeHeader,
	encodeTerminalDimension,
	formatMac,
	listBroadcastInterfaces,
	MAC_TELNET_CONTROL_MAGIC,
	MAC_TELNET_HEADER_LEN,
	MAC_TELNET_KEEPALIVE_IDLE_MS,
	MAC_TELNET_RETRANSMIT_SCHEDULE_MS,
	MacTelnetControlType,
	type MacTelnetDatagramSink,
	MacTelnetPacketType,
	MacTelnetSession,
	macTelnetPasswordHash,
	parseControlBlocks,
	parseMac,
} from "../../src/protocols/mac-telnet.ts";
import { mtweiKeygen } from "../../src/protocols/mtwei.ts";

function hex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CLIENT_MAC = parseMac("aa:bb:cc:dd:ee:ff");
const SERVER_MAC = parseMac("11:22:33:44:55:66");

describe("mac-telnet MAC parsing", () => {
	test("parses and formats colon-separated MACs", () => {
		expect(formatMac(parseMac("aa:bb:cc:dd:ee:ff"))).toBe("aa:bb:cc:dd:ee:ff");
	});

	test("accepts dash and dot separators", () => {
		expect(formatMac(parseMac("AA-BB-CC-DD-EE-FF"))).toBe("aa:bb:cc:dd:ee:ff");
	});

	test("rejects wrong octet counts", () => {
		expect(() => parseMac("aa:bb:cc")).toThrow();
	});

	test("rejects out-of-range octets", () => {
		expect(() => parseMac("aa:bb:cc:dd:ee:zz")).toThrow();
	});
});

describe("mac-telnet header framing", () => {
	test("encodes a 22-byte client SESSIONSTART header", () => {
		const header = encodeHeader({
			type: MacTelnetPacketType.sessionStart,
			sourceMac: CLIENT_MAC,
			destinationMac: SERVER_MAC,
			sessionKey: 0x1234,
			counter: 0,
		});
		expect(header.length).toBe(MAC_TELNET_HEADER_LEN);
		// version, ptype, src, dst, seskey@14(BE), clienttype@16, counter@18
		expect(hex(header)).toBe(
			"0100aabbccddeeff112233445566123400150000000000".slice(0, 44),
		);
		expect(header[0]).toBe(1);
		expect(header[1]).toBe(0);
		// session key at offset 14 for client direction
		expect(header[14]).toBe(0x12);
		expect(header[15]).toBe(0x34);
		// client type 00 15 at offset 16
		expect(header[16]).toBe(0x00);
		expect(header[17]).toBe(0x15);
	});

	test("places the session key at offset 16 for server direction", () => {
		const header = encodeHeader({
			type: MacTelnetPacketType.ack,
			sourceMac: SERVER_MAC,
			destinationMac: CLIENT_MAC,
			sessionKey: 0xbeef,
			counter: 0,
			fromServer: true,
		});
		expect(header[16]).toBe(0xbe);
		expect(header[17]).toBe(0xef);
		expect(header[14]).toBe(0x00);
		expect(header[15]).toBe(0x15);
	});

	test("round-trips a header (client encode / server decode)", () => {
		const header = encodeHeader({
			type: MacTelnetPacketType.data,
			sourceMac: SERVER_MAC,
			destinationMac: CLIENT_MAC,
			sessionKey: 0x0a0b,
			counter: 25,
			fromServer: true,
		});
		const decoded = decodeHeader(header, { fromServer: true });
		expect(decoded.type).toBe(MacTelnetPacketType.data);
		expect(formatMac(decoded.sourceMac)).toBe(formatMac(SERVER_MAC));
		expect(formatMac(decoded.destinationMac)).toBe(formatMac(CLIENT_MAC));
		expect(decoded.sessionKey).toBe(0x0a0b);
		expect(decoded.counter).toBe(25);
	});

	test("encodes the counter as a big-endian uint32", () => {
		const header = encodeHeader({
			type: MacTelnetPacketType.data,
			sourceMac: CLIENT_MAC,
			destinationMac: SERVER_MAC,
			sessionKey: 0,
			counter: 0x01020304,
		});
		expect([header[18], header[19], header[20], header[21]]).toEqual([
			0x01, 0x02, 0x03, 0x04,
		]);
	});

	test("rejects short packets on decode", () => {
		expect(() => decodeHeader(new Uint8Array(10))).toThrow();
	});
});

describe("mac-telnet control blocks", () => {
	test("encodes magic + type + big-endian length + value", () => {
		const block = encodeControlBlock(
			MacTelnetControlType.beginAuth,
			new Uint8Array(0),
		);
		expect(block.length).toBe(9);
		expect([block[0], block[1], block[2], block[3]]).toEqual([
			...MAC_TELNET_CONTROL_MAGIC,
		]);
		expect(block[4]).toBe(0); // beginAuth
		expect([block[5], block[6], block[7], block[8]]).toEqual([0, 0, 0, 0]);
	});

	test("encodes a value-carrying control block", () => {
		const value = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
		const block = encodeControlBlock(MacTelnetControlType.passwordSalt, value);
		expect(block.length).toBe(9 + 4);
		// length field = 4
		expect([block[5], block[6], block[7], block[8]]).toEqual([0, 0, 0, 4]);
		expect([...block.slice(9)]).toEqual([...value]);
	});

	test("parses concatenated control blocks", () => {
		const a = encodeControlBlock(MacTelnetControlType.beginAuth);
		const salt = new Uint8Array(16).fill(0xab);
		const b = encodeControlBlock(MacTelnetControlType.passwordSalt, salt);
		const merged = new Uint8Array(a.length + b.length);
		merged.set(a, 0);
		merged.set(b, a.length);
		const blocks = parseControlBlocks(merged);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.type).toBe(MacTelnetControlType.beginAuth);
		expect(blocks[1]?.type).toBe(MacTelnetControlType.passwordSalt);
		expect(blocks[1]?.value).toHaveLength(16);
	});

	test("treats non-magic payload as plaindata", () => {
		const payload = new TextEncoder().encode("login: ");
		const blocks = parseControlBlocks(payload);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.type).toBe("plaindata");
		expect(new TextDecoder().decode(blocks[0]?.value)).toBe("login: ");
	});

	test("throws on a control block longer than the buffer", () => {
		const bad = new Uint8Array(9);
		bad.set(MAC_TELNET_CONTROL_MAGIC, 0);
		bad[4] = MacTelnetControlType.username;
		new DataView(bad.buffer).setUint32(5, 100, false); // claims 100 bytes
		expect(() => parseControlBlocks(bad)).toThrow();
	});
});

describe("mac-telnet password hashing", () => {
	test("is 0x00 || md5(0x00 || password || salt), 17 bytes", () => {
		const password = "secret";
		const salt = new Uint8Array(16).map((_, i) => i + 1);
		const expectedDigest = createHash("md5")
			.update(Buffer.from([0]))
			.update(Buffer.from(password, "utf8"))
			.update(salt)
			.digest();
		const value = macTelnetPasswordHash(password, salt);
		expect(value.length).toBe(17);
		expect(value[0]).toBe(0x00);
		expect(hex(value.slice(1))).toBe(hex(new Uint8Array(expectedDigest)));
	});
});

describe("mac-telnet directed broadcast", () => {
	test("computes the subnet broadcast from address + netmask", () => {
		expect(directedBroadcast("172.29.8.123", "255.255.255.0")).toBe(
			"172.29.8.255",
		);
		expect(directedBroadcast("192.168.163.152", "255.255.255.0")).toBe(
			"192.168.163.255",
		);
		expect(directedBroadcast("10.87.100.222", "255.255.0.0")).toBe(
			"10.87.255.255",
		);
		// /25 — broadcast is mid-octet, the case a naive `.255` would get wrong.
		expect(directedBroadcast("192.0.2.10", "255.255.255.128")).toBe(
			"192.0.2.127",
		);
		expect(directedBroadcast("192.0.2.200", "255.255.255.128")).toBe(
			"192.0.2.255",
		);
	});

	test("returns undefined for malformed input", () => {
		expect(directedBroadcast("not.an.ip", "255.255.255.0")).toBeUndefined();
		expect(directedBroadcast("192.0.2.1", "999.0.0.0")).toBeUndefined();
		expect(directedBroadcast("192.0.2.1.5", "255.255.255.0")).toBeUndefined();
	});
});

describe("mac-telnet broadcast interfaces", () => {
	test("each entry has a real 6-octet MAC and a valid directed broadcast", () => {
		for (const ifc of listBroadcastInterfaces()) {
			expect(ifc.mac.length).toBe(6);
			expect(ifc.mac.some((octet) => octet !== 0)).toBe(true);
			expect(ifc.broadcast).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
			expect(typeof ifc.name).toBe("string");
		}
	});
});

describe("mac-telnet terminal dimension", () => {
	test("encodes width/height as little-endian uint16", () => {
		expect([...encodeTerminalDimension(80)]).toEqual([80, 0]);
		expect([...encodeTerminalDimension(0x0123)]).toEqual([0x23, 0x01]);
	});
});

describe("mac-telnet buildPacket", () => {
	test("returns header only when there is no payload", () => {
		const packet = buildPacket({
			type: MacTelnetPacketType.sessionStart,
			sourceMac: CLIENT_MAC,
			destinationMac: SERVER_MAC,
			sessionKey: 1,
			counter: 0,
		});
		expect(packet.length).toBe(MAC_TELNET_HEADER_LEN);
	});

	test("appends the payload after the header", () => {
		const payload = encodeControlBlock(MacTelnetControlType.beginAuth);
		const packet = buildPacket({
			type: MacTelnetPacketType.data,
			sourceMac: CLIENT_MAC,
			destinationMac: SERVER_MAC,
			sessionKey: 1,
			counter: 0,
			payload,
		});
		expect(packet.length).toBe(MAC_TELNET_HEADER_LEN + payload.length);
	});
});

/** In-memory datagram peer that records sent packets and decodes them. */
class FakeMacTelnetTransport implements MacTelnetDatagramSink {
	readonly sent: Uint8Array[] = [];
	closed = false;

	send(bytes: Uint8Array): void {
		this.sent.push(bytes.slice());
	}

	close(): void {
		this.closed = true;
	}

	lastType(): number {
		const last = this.sent.at(-1);
		return last ? (last[1] as number) : -1;
	}

	last(): Uint8Array {
		return this.sent.at(-1) ?? new Uint8Array(0);
	}

	clear(): void {
		this.sent.length = 0;
	}
}

/** Build a server→client packet for driving the session in tests. */
function serverPacket(
	type: number,
	sessionKey: number,
	counter: number,
	payload?: Uint8Array,
): Uint8Array {
	const header = encodeHeader({
		type,
		sourceMac: SERVER_MAC,
		destinationMac: CLIENT_MAC,
		sessionKey,
		counter,
		fromServer: true,
	});
	if (!payload) {
		return header;
	}
	const out = new Uint8Array(header.length + payload.length);
	out.set(header, 0);
	out.set(payload, header.length);
	return out;
}

describe("mac-telnet session handshake", () => {
	function setup() {
		const transport = new FakeMacTelnetTransport();
		const events: string[] = [];
		const output: Uint8Array[] = [];
		const session = new MacTelnetSession({
			sink: transport,
			sourceMac: CLIENT_MAC,
			destinationMac: SERVER_MAC,
			username: "admin",
			password: "secret",
			sessionKey: 0x1234,
			offerMtwei: false, // classic flow: BEGINAUTH only → 16-byte MD5 salt
			onReady: () => events.push("ready"),
			onData: (bytes) => output.push(bytes),
			onClose: (error) => events.push(error ? `close:${error.code}` : "close"),
		});
		return { transport, session, events, output };
	}

	test("sends SESSIONSTART on start()", () => {
		const { transport, session } = setup();
		session.start();
		expect(transport.lastType()).toBe(MacTelnetPacketType.sessionStart);
		expect(transport.last().length).toBe(MAC_TELNET_HEADER_LEN);
	});

	test("sends BEGINAUTH after the SESSIONSTART ack", () => {
		const { transport, session } = setup();
		session.start();
		transport.clear();
		session.handlePacket(serverPacket(MacTelnetPacketType.ack, 0x1234, 0));
		expect(transport.lastType()).toBe(MacTelnetPacketType.data);
		const blocks = parseControlBlocks(
			transport.last().subarray(MAC_TELNET_HEADER_LEN),
		);
		expect(blocks[0]?.type).toBe(MacTelnetControlType.beginAuth);
	});

	test("replies to PASSSALT with password/username/terminal controls", () => {
		const { transport, session } = setup();
		session.start();
		session.handlePacket(serverPacket(MacTelnetPacketType.ack, 0x1234, 0));
		transport.clear();

		const salt = new Uint8Array(16).map((_, i) => i + 1);
		const passsalt = encodeControlBlock(
			MacTelnetControlType.passwordSalt,
			salt,
		);
		session.handlePacket(
			serverPacket(MacTelnetPacketType.data, 0x1234, 0, passsalt),
		);

		// Should send an ACK and an auth DATA packet.
		const types = transport.sent.map((packet) => packet[1]);
		expect(types).toContain(MacTelnetPacketType.ack);
		expect(types).toContain(MacTelnetPacketType.data);

		const dataPacket = transport.sent.find(
			(packet) => packet[1] === MacTelnetPacketType.data,
		);
		const blocks = parseControlBlocks(
			(dataPacket as Uint8Array).subarray(MAC_TELNET_HEADER_LEN),
		);
		const types2 = blocks.map((block) => block.type);
		expect(types2).toEqual([
			MacTelnetControlType.password,
			MacTelnetControlType.username,
			MacTelnetControlType.terminalType,
			MacTelnetControlType.terminalWidth,
			MacTelnetControlType.terminalHeight,
		]);
		const passwordBlock = blocks[0];
		expect(passwordBlock?.value).toEqual(macTelnetPasswordHash("secret", salt));
		expect(new TextDecoder().decode(blocks[1]?.value)).toBe("admin");
	});

	test("acks PASSSALT with counter = received counter + payload length", () => {
		const { transport, session } = setup();
		session.start();
		session.handlePacket(serverPacket(MacTelnetPacketType.ack, 0x1234, 0));
		transport.clear();

		const salt = new Uint8Array(16).fill(0xaa);
		const passsalt = encodeControlBlock(
			MacTelnetControlType.passwordSalt,
			salt,
		);
		session.handlePacket(
			serverPacket(MacTelnetPacketType.data, 0x1234, 0, passsalt),
		);
		const ack = transport.sent.find(
			(packet) => packet[1] === MacTelnetPacketType.ack,
		) as Uint8Array;
		const decoded = decodeHeader(ack, { fromServer: false });
		// passsalt payload is 9 (header) + 16 (salt) = 25; received counter 0.
		expect(decoded.counter).toBe(25);
	});

	test("becomes ready only on terminal output after END_AUTH (not on END_AUTH)", () => {
		const { session, events, output } = setup();
		session.start();
		session.handlePacket(serverPacket(MacTelnetPacketType.ack, 0x1234, 0));
		const salt = new Uint8Array(16).fill(1);
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				0,
				encodeControlBlock(MacTelnetControlType.passwordSalt, salt),
			),
		);
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				25,
				encodeControlBlock(MacTelnetControlType.endAuth),
			),
		);
		// END_AUTH alone is not success — a failed login also sends END_AUTH.
		expect(events).not.toContain("ready");
		// The first real terminal output confirms the login and flows through.
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				34,
				new TextEncoder().encode("[admin@router] > "),
			),
		);
		expect(events).toContain("ready");
		expect(output).toHaveLength(1);
		expect(new TextDecoder().decode(output[0])).toBe("[admin@router] > ");
	});

	test("rejects a 49-byte (MTWEI) salt when MTWEI was not offered", () => {
		const { session, events } = setup(); // offerMtwei: false → no client key
		session.start();
		session.handlePacket(serverPacket(MacTelnetPacketType.ack, 0x1234, 0));
		const ecSalt = new Uint8Array(49).fill(7);
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				0,
				encodeControlBlock(MacTelnetControlType.passwordSalt, ecSalt),
			),
		);
		expect(events).toContain("close:routeros/mac-telnet-unsupported-auth");
	});

	test("uses exact outbound counters through the handshake", () => {
		const { transport, session } = setup();
		session.start();
		// SESSIONSTART counter 0.
		expect(decodeHeader(transport.last(), { fromServer: false }).counter).toBe(
			0,
		);
		session.handlePacket(serverPacket(MacTelnetPacketType.ack, 0x1234, 0));
		// BEGINAUTH DATA counter 0 (no prior payload).
		expect(decodeHeader(transport.last(), { fromServer: false }).counter).toBe(
			0,
		);
		transport.clear();
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				0,
				encodeControlBlock(
					MacTelnetControlType.passwordSalt,
					new Uint8Array(16).fill(1),
				),
			),
		);
		// Auth DATA counter = 9 (BEGINAUTH contributed 9 bytes).
		const authData = transport.sent.find(
			(packet) => packet[1] === MacTelnetPacketType.data,
		) as Uint8Array;
		expect(decodeHeader(authData, { fromServer: false }).counter).toBe(9);
	});

	test("ignores packets with a mismatched session key", () => {
		const { transport, session } = setup();
		session.start();
		transport.clear();
		session.handlePacket(serverPacket(MacTelnetPacketType.ack, 0x9999, 0));
		expect(transport.sent).toHaveLength(0);
	});

	test("ignores packets from an unrelated source MAC", () => {
		const { transport, session } = setup();
		session.start();
		transport.clear();
		const stray = encodeHeader({
			type: MacTelnetPacketType.ack,
			sourceMac: parseMac("99:99:99:99:99:99"),
			destinationMac: CLIENT_MAC,
			sessionKey: 0x1234,
			counter: 0,
			fromServer: true,
		});
		session.handlePacket(stray);
		expect(transport.sent).toHaveLength(0);
	});

	test("ignores packets with the wrong protocol version", () => {
		const { transport, session } = setup();
		session.start();
		transport.clear();
		const packet = serverPacket(MacTelnetPacketType.ack, 0x1234, 0);
		packet[0] = 2; // bad version
		session.handlePacket(packet);
		expect(transport.sent).toHaveLength(0);
	});

	test("replies to PING with PONG", () => {
		const { transport, session } = setup();
		session.start();
		transport.clear();
		session.handlePacket(serverPacket(MacTelnetPacketType.ping, 0x1234, 0));
		expect(transport.lastType()).toBe(MacTelnetPacketType.pong);
	});

	test("fails on a packetError control block", () => {
		const { session, events } = setup();
		session.start();
		session.handlePacket(serverPacket(MacTelnetPacketType.ack, 0x1234, 0));
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				0,
				encodeControlBlock(
					MacTelnetControlType.packetError,
					new TextEncoder().encode("bad"),
				),
			),
		);
		expect(events).toContain("close:routeros/mac-telnet-error");
	});
});

describe("mac-telnet session terminal + lifecycle", () => {
	function ready() {
		const transport = new FakeMacTelnetTransport();
		const output: Uint8Array[] = [];
		const session = new MacTelnetSession({
			sink: transport,
			sourceMac: CLIENT_MAC,
			destinationMac: SERVER_MAC,
			username: "admin",
			password: "secret",
			sessionKey: 0x1234,
			offerMtwei: false,
			onData: (bytes) => output.push(bytes),
		});
		session.start();
		session.handlePacket(serverPacket(MacTelnetPacketType.ack, 0x1234, 0));
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				0,
				encodeControlBlock(
					MacTelnetControlType.passwordSalt,
					new Uint8Array(16).fill(1),
				),
			),
		);
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				25,
				encodeControlBlock(MacTelnetControlType.endAuth),
			),
		);
		// END_AUTH only begins terminal mode; the first output confirms readiness.
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				34,
				new TextEncoder().encode("> "),
			),
		);
		output.length = 0;
		transport.clear();
		return { transport, session, output };
	}

	test("emits terminal output as plaindata", () => {
		const { session, output } = ready();
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				50,
				new TextEncoder().encode("hello"),
			),
		);
		expect(output).toHaveLength(1);
		expect(new TextDecoder().decode(output[0])).toBe("hello");
	});

	test("ignores duplicate (non-advancing) counters", () => {
		const { session, output } = ready();
		const packet = serverPacket(
			MacTelnetPacketType.data,
			0x1234,
			50,
			new TextEncoder().encode("x"),
		);
		session.handlePacket(packet);
		session.handlePacket(packet); // duplicate counter
		expect(output).toHaveLength(1);
	});

	test("sendInput wraps keystrokes as a DATA packet", () => {
		const { transport, session } = ready();
		session.sendInput(new TextEncoder().encode("ls\n"));
		expect(transport.lastType()).toBe(MacTelnetPacketType.data);
		const payload = transport.last().subarray(MAC_TELNET_HEADER_LEN);
		expect(new TextDecoder().decode(payload)).toBe("ls\n");
	});

	test("sendInput before ready throws", () => {
		const transport = new FakeMacTelnetTransport();
		const session = new MacTelnetSession({
			sink: transport,
			sourceMac: CLIENT_MAC,
			destinationMac: SERVER_MAC,
			username: "admin",
			password: "secret",
		});
		expect(() => session.sendInput(Uint8Array.of(1))).toThrow();
	});

	test("end() sends END and closes the transport", () => {
		const { transport, session } = ready();
		session.end();
		expect(transport.lastType()).toBe(MacTelnetPacketType.end);
		expect(transport.closed).toBe(true);
	});

	test("server END closes the session and echoes END", () => {
		const { transport, session } = ready();
		session.handlePacket(serverPacket(MacTelnetPacketType.end, 0x1234, 0));
		expect(transport.lastType()).toBe(MacTelnetPacketType.end);
		expect(transport.closed).toBe(true);
	});
});

describe("mac-telnet MTWEI offer + auth-failure detection", () => {
	function mtweiSetup() {
		const transport = new FakeMacTelnetTransport();
		const events: string[] = [];
		const output: Uint8Array[] = [];
		const session = new MacTelnetSession({
			sink: transport,
			sourceMac: CLIENT_MAC,
			destinationMac: SERVER_MAC,
			username: "admin",
			password: "secret",
			sessionKey: 0x1234,
			// offerMtwei defaults to true (the modern default)
			onReady: () => events.push("ready"),
			onData: (bytes) => output.push(bytes),
			onClose: (error) => events.push(error ? `close:${error.code}` : "close"),
		});
		return { transport, session, events, output };
	}

	function driveToAuthComplete(session: MacTelnetSession): void {
		session.start();
		session.handlePacket(serverPacket(MacTelnetPacketType.ack, 0x1234, 0));
		// A 16-byte salt drives MD5; the post-END_AUTH failure handling is the
		// same regardless of auth mode.
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				0,
				encodeControlBlock(
					MacTelnetControlType.passwordSalt,
					new Uint8Array(16).fill(1),
				),
			),
		);
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				25,
				encodeControlBlock(MacTelnetControlType.endAuth),
			),
		);
	}

	test("BEGINAUTH advertises an MTWEI offer (username + 0x00 + 33-byte pubkey)", () => {
		const { transport, session } = mtweiSetup();
		session.start();
		transport.clear();
		session.handlePacket(serverPacket(MacTelnetPacketType.ack, 0x1234, 0));
		const blocks = parseControlBlocks(
			transport.last().subarray(MAC_TELNET_HEADER_LEN),
		);
		expect(blocks[0]?.type).toBe(MacTelnetControlType.beginAuth);
		expect(blocks[1]?.type).toBe(MacTelnetControlType.passwordSalt);
		expect(blocks[1]?.value.length).toBe("admin".length + 1 + 33);
		expect(blocks[1]?.value[5]).toBe(0); // NUL after "admin"
	});

	test("a 49-byte PASSSALT yields a 32-byte EC-SRP proof (not a 17-byte MD5 hash)", () => {
		const { transport, session } = mtweiSetup();
		session.start();
		session.handlePacket(serverPacket(MacTelnetPacketType.ack, 0x1234, 0));
		const server = mtweiKeygen(new Uint8Array(32).fill(9));
		const salt49 = new Uint8Array(49);
		salt49.set(server.publicKey, 0);
		salt49.set(new Uint8Array(16).fill(0x5a), 33);
		transport.clear();
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				0,
				encodeControlBlock(MacTelnetControlType.passwordSalt, salt49),
			),
		);
		const dataPacket = transport.sent.find(
			(p) => p[1] === MacTelnetPacketType.data,
		) as Uint8Array;
		const blocks = parseControlBlocks(
			dataPacket.subarray(MAC_TELNET_HEADER_LEN),
		);
		expect(blocks[0]?.type).toBe(MacTelnetControlType.password);
		expect(blocks[0]?.value.length).toBe(32);
	});

	test("a 'Login failed' message after END_AUTH → transport/auth-failed (not ready)", () => {
		const { session, events } = mtweiSetup();
		driveToAuthComplete(session);
		expect(events).not.toContain("ready");
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				34,
				new TextEncoder().encode(
					"Login failed, incorrect username or password\r\n",
				),
			),
		);
		expect(events).toContain("close:transport/auth-failed");
		expect(events).not.toContain("ready");
	});

	test("END right after END_AUTH (no prompt) → transport/auth-failed", () => {
		const { session, events } = mtweiSetup();
		driveToAuthComplete(session);
		session.handlePacket(serverPacket(MacTelnetPacketType.end, 0x1234, 0));
		expect(events).toContain("close:transport/auth-failed");
		expect(events).not.toContain("ready");
	});
});

describe("mac-telnet retransmit + keepalive (tick)", () => {
	function setup() {
		const transport = new FakeMacTelnetTransport();
		const session = new MacTelnetSession({
			sink: transport,
			sourceMac: CLIENT_MAC,
			destinationMac: SERVER_MAC,
			username: "admin",
			password: "secret",
			sessionKey: 0x1234,
			offerMtwei: false,
		});
		return { transport, session };
	}

	/** Drive the MD5 handshake to a ready terminal, clearing any pending frame. */
	function driveReady(
		session: MacTelnetSession,
		transport: FakeMacTelnetTransport,
	) {
		session.start();
		session.handlePacket(serverPacket(MacTelnetPacketType.ack, 0x1234, 0));
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				0,
				encodeControlBlock(
					MacTelnetControlType.passwordSalt,
					new Uint8Array(16).fill(1),
				),
			),
		);
		session.handlePacket(
			serverPacket(
				MacTelnetPacketType.data,
				0x1234,
				25,
				encodeControlBlock(MacTelnetControlType.endAuth),
			),
		);
		session.handlePacket(
			serverPacket(MacTelnetPacketType.data, 0x1234, 34, Uint8Array.of(0x3e)),
		);
		// A high-counter ACK clears any unacked auth/input frame.
		session.handlePacket(
			serverPacket(MacTelnetPacketType.ack, 0x1234, 0xffffff),
		);
		transport.clear();
	}

	test("a tick does nothing on its first call (delta baseline)", () => {
		const { transport, session } = setup();
		session.start(); // SESSIONSTART pending
		transport.clear();
		session.tick(1000);
		expect(transport.sent).toHaveLength(0);
	});

	test("retransmits an unacked SESSIONSTART on the backoff schedule", () => {
		const { transport, session } = setup();
		session.start();
		transport.clear();
		session.tick(1000); // baseline
		session.tick(1000 + (MAC_TELNET_RETRANSMIT_SCHEDULE_MS[0] as number));
		expect(transport.lastType()).toBe(MacTelnetPacketType.sessionStart);
		expect(transport.sent).toHaveLength(1);
		// Second retransmit after the next (longer) interval.
		session.tick(
			1000 +
				(MAC_TELNET_RETRANSMIT_SCHEDULE_MS[0] as number) +
				(MAC_TELNET_RETRANSMIT_SCHEDULE_MS[1] as number),
		);
		expect(transport.sent).toHaveLength(2);
	});

	test("an ACK covering the frame stops retransmission", () => {
		const { transport, session } = setup();
		driveReady(session, transport);
		session.sendInput(new TextEncoder().encode("x"));
		transport.clear();
		session.tick(1000); // baseline
		session.tick(1000 + (MAC_TELNET_RETRANSMIT_SCHEDULE_MS[0] as number));
		expect(transport.sent.length).toBeGreaterThan(0); // retransmitted
		transport.clear();
		// Device acknowledges everything → pending cleared → no more retransmits.
		session.handlePacket(
			serverPacket(MacTelnetPacketType.ack, 0x1234, 0xffffff),
		);
		transport.clear();
		session.tick(5000);
		session.tick(9000);
		expect(transport.sent).toHaveLength(0);
	});

	test("gives up after the schedule is exhausted", () => {
		const { transport, session } = setup();
		session.start();
		transport.clear();
		let now = 0;
		session.tick(now); // baseline
		for (const interval of MAC_TELNET_RETRANSMIT_SCHEDULE_MS) {
			now += interval;
			session.tick(now);
		}
		const retransmits = () =>
			transport.sent.filter((p) => p[1] === MacTelnetPacketType.sessionStart);
		expect(retransmits()).toHaveLength(
			MAC_TELNET_RETRANSMIT_SCHEDULE_MS.length,
		);
		// A much later tick may emit a keepalive, but no further SESSIONSTART
		// retransmit once the schedule is exhausted.
		session.tick(now + 100_000);
		expect(retransmits()).toHaveLength(
			MAC_TELNET_RETRANSMIT_SCHEDULE_MS.length,
		);
	});

	test("sends an empty-ACK keepalive after the idle window", () => {
		const { transport, session } = setup();
		driveReady(session, transport); // pending cleared, ready
		session.tick(1000); // consume the drive's activity → idle clock at 0
		expect(transport.sent).toHaveLength(0);
		session.tick(1000 + MAC_TELNET_KEEPALIVE_IDLE_MS + 1);
		expect(transport.lastType()).toBe(MacTelnetPacketType.ack);
		expect(transport.last().length).toBe(MAC_TELNET_HEADER_LEN); // header-only ACK
	});

	test("inbound activity defers the keepalive", () => {
		const { transport, session } = setup();
		driveReady(session, transport);
		session.tick(1000);
		// Inbound data just before the idle window elapses resets the clock.
		session.handlePacket(
			serverPacket(MacTelnetPacketType.data, 0x1234, 100, Uint8Array.of(0x79)),
		);
		transport.clear();
		session.tick(1000 + MAC_TELNET_KEEPALIVE_IDLE_MS + 1);
		// The only thing sent is the ACK for that inbound data — not a keepalive.
		// (Activity reset the idle clock, so no keepalive this window.)
		const keepalives = transport.sent.filter(
			(p) => p[1] === MacTelnetPacketType.ack,
		);
		expect(keepalives).toHaveLength(0);
	});

	test("tick is a no-op once closed", () => {
		const { transport, session } = setup();
		session.start();
		session.end();
		transport.clear();
		session.tick(1_000_000);
		expect(transport.sent).toHaveLength(0);
	});
});
