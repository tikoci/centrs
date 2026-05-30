/**
 * MikroTik MAC-Telnet protocol (Layer-2 execute/terminal path).
 *
 * Transport-side base for the `mac-telnet` protocol id. Like the native API
 * module, this is split into a pure **codec** and a **session** state machine
 * driven over an injectable datagram sink, so the wire format and handshake
 * can be unit-tested without an L2 network.
 *
 * Wire format grounded against Håkon Nessjøen's reference `mactelnet`
 * implementation (`haakonnessjoen/MAC-Telnet`: `protocol.c/.h`, `mactelnet.c`,
 * `mactelnetd.c`). Transport is UDP port 20561, but the protocol carries its
 * own 6+6 byte source/destination MAC addressing inside every packet header
 * (independent of the outer L2/UDP delivery).
 *
 * Only the classic MD5 auth path is implemented here. The newer MTWEI
 * (EC-SRP) handshake is detected and reported as unsupported rather than
 * mishandled. L2-in-CI is an open question in `docs/MATRIX.md`; correctness
 * here is anchored by scripted-peer unit tests.
 */

import { createHash } from "node:crypto";
import { CentrsError } from "../errors.ts";

/** UDP port MAC-Telnet listens on. */
export const MAC_TELNET_PORT = 20561;
/** Fixed MT header length for SESSIONSTART/DATA/ACK/END packets. */
export const MAC_TELNET_HEADER_LEN = 22;
/** Control-block header length: 4-byte magic + 1-byte type + 4-byte length. */
export const MAC_TELNET_CONTROL_HEADER_LEN = 9;
/** Control-block magic bytes: `56 34 12 FF`. */
export const MAC_TELNET_CONTROL_MAGIC = Uint8Array.of(0x56, 0x34, 0x12, 0xff);
/** Client type identifier sent in every header (`00 15`). */
export const MAC_TELNET_CLIENT_TYPE = Uint8Array.of(0x00, 0x15);

/** MT packet types (`enum mt_ptype`). */
export const MacTelnetPacketType = {
	sessionStart: 0,
	data: 1,
	ack: 2,
	ping: 4,
	pong: 5,
	end: 255,
} as const;
export type MacTelnetPacketType =
	(typeof MacTelnetPacketType)[keyof typeof MacTelnetPacketType];

/** MT control-packet types (`enum mt_cptype`). */
export const MacTelnetControlType = {
	beginAuth: 0,
	passwordSalt: 1,
	password: 2,
	username: 3,
	terminalType: 4,
	terminalWidth: 5,
	terminalHeight: 6,
	packetError: 7,
	endAuth: 9,
} as const;
export type MacTelnetControlType =
	(typeof MacTelnetControlType)[keyof typeof MacTelnetControlType];

/** A MAC address as six octets. */
export type MacAddress = Uint8Array;

/** Parse `aa:bb:cc:dd:ee:ff` (or `-`/`.` separated) into six octets. */
export function parseMac(value: string): MacAddress {
	const parts = value.trim().split(/[:\-.]/);
	if (parts.length !== 6) {
		throw new CentrsError({
			code: "input/mac-address",
			summary: `"${value}" is not a 6-octet MAC address.`,
			remediation: "Provide a MAC like aa:bb:cc:dd:ee:ff.",
		});
	}
	const octets = new Uint8Array(6);
	for (let index = 0; index < 6; index += 1) {
		const octet = Number.parseInt(parts[index] as string, 16);
		if (!Number.isInteger(octet) || octet < 0 || octet > 0xff) {
			throw new CentrsError({
				code: "input/mac-address",
				summary: `"${value}" has an invalid octet "${parts[index]}".`,
				remediation: "Each octet must be a two-digit hex value (00–ff).",
			});
		}
		octets[index] = octet;
	}
	return octets;
}

/** Format six octets as `aa:bb:cc:dd:ee:ff`. */
export function formatMac(mac: MacAddress): string {
	return [...mac].map((octet) => octet.toString(16).padStart(2, "0")).join(":");
}

function macEquals(a: MacAddress, b: MacAddress): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let index = 0; index < a.length; index += 1) {
		if (a[index] !== b[index]) {
			return false;
		}
	}
	return true;
}

export interface MacTelnetHeader {
	version: number;
	type: number;
	sourceMac: MacAddress;
	destinationMac: MacAddress;
	sessionKey: number;
	counter: number;
}

export interface EncodeHeaderOptions {
	type: number;
	sourceMac: MacAddress;
	destinationMac: MacAddress;
	sessionKey: number;
	counter: number;
	/** Direction flag. Client→server (default) puts the session key at offset 14. */
	fromServer?: boolean;
}

/**
 * Encode a 22-byte MT header. The session-key and client-type fields swap
 * positions by direction, mirroring `init_packet`'s `mt_direction_fromserver`.
 */
export function encodeHeader(options: EncodeHeaderOptions): Uint8Array {
	const data = new Uint8Array(MAC_TELNET_HEADER_LEN);
	const view = new DataView(data.buffer);
	data[0] = 1;
	data[1] = options.type;
	data.set(options.sourceMac, 2);
	data.set(options.destinationMac, 8);
	const sessionKeyOffset = options.fromServer ? 16 : 14;
	const clientTypeOffset = options.fromServer ? 14 : 16;
	view.setUint16(sessionKeyOffset, options.sessionKey & 0xffff, false);
	data.set(MAC_TELNET_CLIENT_TYPE, clientTypeOffset);
	view.setUint32(18, options.counter >>> 0, false);
	return data;
}

/** Decode a 22-byte MT header. Defaults to decoding a server→client packet. */
export function decodeHeader(
	bytes: Uint8Array,
	options: { fromServer?: boolean } = {},
): MacTelnetHeader {
	if (bytes.length < MAC_TELNET_HEADER_LEN) {
		throw new CentrsError({
			code: "routeros/mac-telnet-protocol",
			summary: `MAC-Telnet packet is too short (${bytes.length} bytes, need at least ${MAC_TELNET_HEADER_LEN}).`,
			remediation:
				"The datagram is truncated or not MAC-Telnet; confirm the source.",
		});
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const fromServer = options.fromServer ?? true;
	const sessionKeyOffset = fromServer ? 16 : 14;
	return {
		version: bytes[0] as number,
		type: bytes[1] as number,
		sourceMac: bytes.slice(2, 8),
		destinationMac: bytes.slice(8, 14),
		sessionKey: view.getUint16(sessionKeyOffset, false),
		counter: view.getUint32(18, false),
	};
}

/** Encode one control block: magic + type + big-endian length + value. */
export function encodeControlBlock(
	type: MacTelnetControlType,
	value: Uint8Array = new Uint8Array(0),
): Uint8Array {
	const block = new Uint8Array(MAC_TELNET_CONTROL_HEADER_LEN + value.length);
	block.set(MAC_TELNET_CONTROL_MAGIC, 0);
	block[4] = type;
	new DataView(block.buffer).setUint32(5, value.length >>> 0, false);
	block.set(value, MAC_TELNET_CONTROL_HEADER_LEN);
	return block;
}

export interface ParsedControlBlock {
	type: MacTelnetControlType | "plaindata";
	value: Uint8Array;
}

/**
 * Parse the payload of a DATA packet into control blocks. Bytes that do not
 * start with the control magic are returned as a single `plaindata` block,
 * matching the reference `parse_control_packet` fallback.
 */
export function parseControlBlocks(payload: Uint8Array): ParsedControlBlock[] {
	const blocks: ParsedControlBlock[] = [];
	let offset = 0;
	while (offset < payload.length) {
		const remaining = payload.length - offset;
		const hasMagic =
			remaining >= MAC_TELNET_CONTROL_HEADER_LEN &&
			payload[offset] === MAC_TELNET_CONTROL_MAGIC[0] &&
			payload[offset + 1] === MAC_TELNET_CONTROL_MAGIC[1] &&
			payload[offset + 2] === MAC_TELNET_CONTROL_MAGIC[2] &&
			payload[offset + 3] === MAC_TELNET_CONTROL_MAGIC[3];
		if (!hasMagic) {
			blocks.push({ type: "plaindata", value: payload.slice(offset) });
			break;
		}
		const type = payload[offset + 4] as MacTelnetControlType;
		const length = new DataView(
			payload.buffer,
			payload.byteOffset + offset + 5,
			4,
		).getUint32(0, false);
		const valueStart = offset + MAC_TELNET_CONTROL_HEADER_LEN;
		const valueEnd = valueStart + length;
		if (valueEnd > payload.length) {
			throw new CentrsError({
				code: "routeros/mac-telnet-protocol",
				summary: `MAC-Telnet control block claims ${length} bytes but only ${payload.length - valueStart} remain.`,
				remediation:
					"The datagram is corrupt or truncated; confirm the source.",
			});
		}
		blocks.push({ type, value: payload.slice(valueStart, valueEnd) });
		offset = valueEnd;
	}
	return blocks;
}

/**
 * Compute the 17-byte MAC-Telnet password value:
 * `0x00 || MD5(0x00 || password || salt)`.
 */
export function macTelnetPasswordHash(
	password: string,
	salt: Uint8Array,
): Uint8Array {
	const digest = createHash("md5")
		.update(Buffer.from([0]))
		.update(Buffer.from(password, "utf8"))
		.update(salt)
		.digest();
	const out = new Uint8Array(17);
	out[0] = 0x00;
	out.set(digest, 1);
	return out;
}

/** Encode a 2-byte little-endian terminal dimension (width/height). */
export function encodeTerminalDimension(value: number): Uint8Array {
	const out = new Uint8Array(2);
	new DataView(out.buffer).setUint16(0, value & 0xffff, true);
	return out;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let cursor = 0;
	for (const part of parts) {
		out.set(part, cursor);
		cursor += part.length;
	}
	return out;
}

export interface BuildPacketOptions {
	type: number;
	sourceMac: MacAddress;
	destinationMac: MacAddress;
	sessionKey: number;
	counter: number;
	payload?: Uint8Array;
}

/** Build a complete client→server packet (header + optional payload). */
export function buildPacket(options: BuildPacketOptions): Uint8Array {
	const header = encodeHeader({
		type: options.type,
		sourceMac: options.sourceMac,
		destinationMac: options.destinationMac,
		sessionKey: options.sessionKey,
		counter: options.counter,
	});
	if (!options.payload || options.payload.length === 0) {
		return header;
	}
	return concatBytes([header, options.payload]);
}

/** Datagram sink the session writes encoded packets to. */
export interface MacTelnetDatagramSink {
	/** Send a UDP datagram. */
	send(bytes: Uint8Array): void;
	/** Close the underlying socket. */
	close(): void;
}

export interface MacTelnetSessionOptions {
	sink: MacTelnetDatagramSink;
	/** Client MAC (the in-payload source address). */
	sourceMac: MacAddress;
	/** Target device MAC (the in-payload destination address). */
	destinationMac: MacAddress;
	username: string;
	password: string;
	/** 16-bit session key. Random when omitted. */
	sessionKey?: number;
	terminalType?: string;
	terminalWidth?: number;
	terminalHeight?: number;
	/** Called with terminal output bytes. */
	onData?: (bytes: Uint8Array) => void;
	/** Called once the auth handshake completes and the terminal is ready. */
	onReady?: () => void;
	/** Called when the session ends or fails. */
	onClose?: (error?: CentrsError) => void;
}

type SessionState =
	| "init"
	| "session-start-sent"
	| "auth-begin-sent"
	| "auth-sent"
	| "ready"
	| "closed";

/**
 * MAC-Telnet client session state machine over an injectable datagram sink.
 *
 * Drives the classic MD5 handshake: SESSIONSTART → BEGINAUTH →
 * (server PASSSALT) → PASSWORD/USERNAME/terminal → (server END_AUTH) → ready.
 * Feed inbound datagrams via {@link handlePacket}.
 */
export class MacTelnetSession {
	private readonly options: MacTelnetSessionOptions;
	private readonly sessionKey: number;
	private state: SessionState = "init";
	private outCounter = 0;
	private lastInCounter: number | null = null;

	constructor(options: MacTelnetSessionOptions) {
		this.options = options;
		this.sessionKey = options.sessionKey ?? Math.floor(Math.random() * 0x10000);
	}

	/** Current session key. */
	get key(): number {
		return this.sessionKey;
	}

	/** Begin the handshake by sending SESSIONSTART. */
	start(): void {
		if (this.state !== "init") {
			return;
		}
		this.sendPacket(MacTelnetPacketType.sessionStart);
		this.state = "session-start-sent";
	}

	/** Feed an inbound datagram (a full UDP payload) into the state machine. */
	handlePacket(bytes: Uint8Array): void {
		if (this.state === "closed") {
			return;
		}
		let header: MacTelnetHeader;
		try {
			header = decodeHeader(bytes, { fromServer: true });
		} catch (error) {
			this.fail(
				error instanceof CentrsError
					? error
					: new CentrsError({
							code: "routeros/mac-telnet-protocol",
							summary: "Failed to decode a MAC-Telnet packet.",
							remediation: "Confirm the datagram source is MAC-Telnet.",
							cause: error,
						}),
			);
			return;
		}

		switch (header.type) {
			case MacTelnetPacketType.ack:
				if (!this.matchesSession(header)) {
					return;
				}
				this.onAck();
				return;
			case MacTelnetPacketType.data:
				if (!this.matchesSession(header)) {
					return;
				}
				this.onData(header, bytes);
				return;
			case MacTelnetPacketType.end:
				if (!this.matchesSession(header)) {
					return;
				}
				this.onEnd(header);
				return;
			case MacTelnetPacketType.ping:
				this.onPing(header);
				return;
			default:
				return; // pong/unknown: ignore for the client base
		}
	}

	/**
	 * Accept a packet only when it belongs to this session: protocol version 1,
	 * matching session key, and MAC addresses that mirror our own (server src =
	 * our destination, server dst = our source). Stray or spoofed datagrams on
	 * the shared UDP/L2 segment are ignored.
	 */
	private matchesSession(header: MacTelnetHeader): boolean {
		return (
			header.version === 1 &&
			header.sessionKey === this.sessionKey &&
			macEquals(header.sourceMac, this.options.destinationMac) &&
			macEquals(header.destinationMac, this.options.sourceMac)
		);
	}

	private onPing(header: MacTelnetHeader): void {
		// Answer keepalive pings so long-lived sessions are not dropped.
		this.options.sink.send(
			encodeHeader({
				type: MacTelnetPacketType.pong,
				sourceMac: this.options.sourceMac,
				destinationMac: this.options.destinationMac,
				sessionKey: header.sessionKey,
				counter: header.counter,
			}),
		);
	}

	private onAck(): void {
		if (this.state === "session-start-sent") {
			this.sendData([encodeControlBlock(MacTelnetControlType.beginAuth)]);
			this.state = "auth-begin-sent";
		}
	}

	private onData(header: MacTelnetHeader, bytes: Uint8Array): void {
		const payload = bytes.subarray(MAC_TELNET_HEADER_LEN);
		// Always ACK, even for retransmitted/non-advancing frames, so the peer
		// stops retransmitting; only deliver the payload when it advances.
		this.acknowledge(header.counter, payload.length);
		if (!this.acceptCounter(header.counter)) {
			return; // duplicate / out-of-window
		}

		let blocks: ParsedControlBlock[];
		try {
			blocks = parseControlBlocks(payload);
		} catch (error) {
			this.fail(error as CentrsError);
			return;
		}

		for (const block of blocks) {
			this.handleControlBlock(block);
		}
	}

	private handleControlBlock(block: ParsedControlBlock): void {
		switch (block.type) {
			case MacTelnetControlType.passwordSalt:
				this.handlePasswordSalt(block.value);
				return;
			case MacTelnetControlType.endAuth:
				if (this.state === "auth-sent") {
					this.state = "ready";
					this.options.onReady?.();
				}
				return;
			case "plaindata":
				if (this.state === "ready" && block.value.length > 0) {
					this.options.onData?.(block.value);
				}
				return;
			case MacTelnetControlType.packetError:
				this.fail(
					new CentrsError({
						code: "routeros/mac-telnet-error",
						summary: `The device reported a MAC-Telnet error: ${new TextDecoder().decode(block.value)}`,
						remediation:
							"Check the credentials and that MAC-Telnet is enabled on the device.",
					}),
				);
				return;
			default:
				return;
		}
	}

	private handlePasswordSalt(salt: Uint8Array): void {
		if (this.state !== "auth-begin-sent") {
			return;
		}
		if (salt.length !== 16) {
			this.fail(
				new CentrsError({
					code: "routeros/mac-telnet-unsupported-auth",
					summary: `The device requested an unsupported MAC-Telnet auth mode (salt length ${salt.length}).`,
					remediation:
						"This device requires MTWEI (EC-SRP) auth, which centrs does not yet implement; use ssh or the API instead.",
				}),
			);
			return;
		}

		const passwordValue = macTelnetPasswordHash(this.options.password, salt);
		const username = new TextEncoder().encode(this.options.username);
		const terminalType = new TextEncoder().encode(
			this.options.terminalType ?? "vt102",
		);
		const blocks = [
			encodeControlBlock(MacTelnetControlType.password, passwordValue),
			encodeControlBlock(MacTelnetControlType.username, username),
			encodeControlBlock(MacTelnetControlType.terminalType, terminalType),
			encodeControlBlock(
				MacTelnetControlType.terminalWidth,
				encodeTerminalDimension(this.options.terminalWidth ?? 80),
			),
			encodeControlBlock(
				MacTelnetControlType.terminalHeight,
				encodeTerminalDimension(this.options.terminalHeight ?? 24),
			),
		];
		this.sendData(blocks);
		this.state = "auth-sent";
	}

	private onEnd(header: MacTelnetHeader): void {
		// Echo END to acknowledge, then close.
		this.options.sink.send(
			encodeHeader({
				type: MacTelnetPacketType.end,
				sourceMac: this.options.sourceMac,
				destinationMac: this.options.destinationMac,
				sessionKey: header.sessionKey,
				counter: 0,
			}),
		);
		this.close();
	}

	/** Send terminal input bytes (only valid once ready). */
	sendInput(bytes: Uint8Array): void {
		if (this.state !== "ready") {
			throw new CentrsError({
				code: "routeros/mac-telnet-not-ready",
				summary: "Cannot send input before the MAC-Telnet session is ready.",
				remediation: "Wait for the onReady callback before sending input.",
			});
		}
		// Terminal data is raw PLAINDATA (no control header).
		this.sendData([bytes]);
	}

	/** Send END and close the session. */
	end(): void {
		if (this.state === "closed") {
			return;
		}
		this.options.sink.send(
			encodeHeader({
				type: MacTelnetPacketType.end,
				sourceMac: this.options.sourceMac,
				destinationMac: this.options.destinationMac,
				sessionKey: this.sessionKey,
				counter: this.outCounter,
			}),
		);
		this.close();
	}

	private close(error?: CentrsError): void {
		if (this.state === "closed") {
			return;
		}
		this.state = "closed";
		this.options.sink.close();
		this.options.onClose?.(error);
	}

	private fail(error: CentrsError): void {
		this.close(error);
	}

	private acceptCounter(counter: number): boolean {
		if (this.lastInCounter === null) {
			this.lastInCounter = counter;
			return true;
		}
		if (counter > this.lastInCounter) {
			this.lastInCounter = counter;
			return true;
		}
		return false;
	}

	private acknowledge(counter: number, payloadLength: number): void {
		this.options.sink.send(
			encodeHeader({
				type: MacTelnetPacketType.ack,
				sourceMac: this.options.sourceMac,
				destinationMac: this.options.destinationMac,
				sessionKey: this.sessionKey,
				counter: (counter + payloadLength) >>> 0,
			}),
		);
	}

	private sendPacket(type: number, payload?: Uint8Array): void {
		this.options.sink.send(
			buildPacket({
				type,
				sourceMac: this.options.sourceMac,
				destinationMac: this.options.destinationMac,
				sessionKey: this.sessionKey,
				counter: this.outCounter,
				payload,
			}),
		);
	}

	private sendData(parts: readonly Uint8Array[]): void {
		const payload = concatBytes(parts);
		this.sendPacket(MacTelnetPacketType.data, payload);
		// Control blocks include their 9-byte headers in `payload.length`;
		// PLAINDATA contributes its raw bytes. Both advance the counter by the
		// number of payload bytes actually sent.
		this.outCounter = (this.outCounter + payload.length) >>> 0;
	}
}
