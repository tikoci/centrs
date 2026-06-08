/**
 * Host-side L2 bridge for the MAC-Telnet integration spike.
 *
 * MAC-Telnet (UDP/20561) is a stateful, bidirectional Layer-2 session: unlike
 * MNDP's one-shot broadcast, the client and the device exchange SESSIONSTART /
 * DATA / ACK / END packets addressed by an in-packet 6+6 byte MAC pair. A
 * `user`/SLIRP CHR terminates L2 in userspace, so — exactly as the MNDP test
 * does — the harness gives the CHR a second `socket-connect` NIC. QEMU streams
 * every guest Ethernet frame to a host TCP server, length-prefixed (4-byte
 * big-endian length + raw frame), and a frame written back is injected into the
 * guest. See `@tikoci/quickchr` `src/lib/network.ts` (`socket,connect=`) and the
 * sibling `mndp-l2-bridge.ts`.
 *
 * This bridge is the full-duplex relay the `discover` README's "L2 validation
 * policy" anticipated for MAC-Telnet:
 *
 *   guest → host : de-frame the TCP stream, lift the UDP/20561 payload out of
 *                  each Ethernet+IPv4+UDP frame, hand it to {@link onPacket} —
 *                  which the spike wires straight to the *unmodified*
 *                  `MacTelnetSession.handlePacket`.
 *   host → guest : {@link inject} wraps a MAC-Telnet datagram in a broadcast
 *                  Ethernet/IPv4/UDP(20561) frame, length-prefixes it, and
 *                  writes it back over the same TCP connection (the L2 injection
 *                  primitive proven by the MNDP refresh path).
 *
 * It is deliberately framing-faithful rather than reusing centrs's codec, so a
 * wire-format regression on either side cannot hide behind a shared helper.
 *
 * Addressing note: real MAC-Telnet clients broadcast at L2 and rely on the
 * *in-packet* destination MAC for the device to claim the session, so the outer
 * Ethernet frame defaults to a broadcast destination from a synthetic host MAC.
 * The in-packet addressing (which the device's mac-server actually matches
 * against its interface MAC) is the session's job, not the bridge's.
 */

import net from "node:net";

/** UDP port MAC-Telnet listens on. */
export const MAC_TELNET_PORT = 20561;
/** QEMU's legacy `-netdev socket` stream caps a frame well under this. */
const MAX_FRAME = 0xffff;
/** Synthetic, locally-administered host MAC used as the L2/in-packet source. */
export const HOST_MAC = Uint8Array.of(0x02, 0x00, 0x00, 0x00, 0x00, 0x01);
const BROADCAST_MAC = Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff);

/** Lift the UDP payload out of a raw Ethernet frame (IPv4/UDP, given dst port). */
export function ethernetToUdpPayload(
	frame: Buffer,
	wantDstPort: number,
): Buffer | null {
	if (frame.length < 14 + 20 + 8) return null; // eth + min IPv4 + UDP
	if (frame.readUInt16BE(12) !== 0x0800) return null; // not IPv4 ethertype
	const ip = 14;
	const versionIhl = frame.readUInt8(ip);
	if (versionIhl >> 4 !== 4) return null; // not IPv4
	const ihl = (versionIhl & 0x0f) * 4;
	if (frame[ip + 9] !== 17) return null; // not UDP
	const udp = ip + ihl;
	if (udp + 8 > frame.length) return null;
	if (frame.readUInt16BE(udp + 2) !== wantDstPort) return null; // dst port
	const udpLen = frame.readUInt16BE(udp + 4);
	return frame.subarray(udp + 8, Math.min(udp + udpLen, frame.length));
}

/**
 * Wrap a MAC-Telnet payload in an Ethernet/IPv4/UDP(20561) frame and
 * length-prefix it for QEMU's stream socket. Defaults to a broadcast L2
 * destination from {@link HOST_MAC}, mirroring a real MAC-Telnet client.
 */
export function buildMacTelnetStreamFrame(
	payload: Uint8Array,
	opts: { dstMac?: Uint8Array; srcMac?: Uint8Array } = {},
): Buffer {
	const body = Buffer.from(payload);
	const udp = Buffer.alloc(8 + body.length);
	udp.writeUInt16BE(MAC_TELNET_PORT, 0); // src port
	udp.writeUInt16BE(MAC_TELNET_PORT, 2); // dst port
	udp.writeUInt16BE(udp.length, 4); // length
	body.copy(udp, 8);
	// UDP checksum left 0 (valid "no checksum" for IPv4; matches MNDP refresh).

	const ip = Buffer.alloc(20);
	ip[0] = 0x45; // version 4, IHL 5
	ip.writeUInt16BE(20 + udp.length, 2);
	ip[8] = 1; // TTL
	ip[9] = 17; // UDP
	ip.writeUInt32BE(0, 12); // src 0.0.0.0
	ip.writeUInt32BE(0xffffffff, 16); // dst 255.255.255.255
	let sum = 0;
	for (let i = 0; i < 20; i += 2) sum += ip.readUInt16BE(i);
	while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
	ip.writeUInt16BE(~sum & 0xffff, 10);

	const eth = Buffer.alloc(14);
	Buffer.from(opts.dstMac ?? BROADCAST_MAC).copy(eth, 0);
	Buffer.from(opts.srcMac ?? HOST_MAC).copy(eth, 6);
	eth.writeUInt16BE(0x0800, 12); // IPv4

	const frame = Buffer.concat([eth, ip, udp]);
	const lengthPrefix = Buffer.alloc(4);
	lengthPrefix.writeUInt32BE(frame.length, 0);
	return Buffer.concat([lengthPrefix, frame]);
}

export interface MacTelnetL2BridgeStats {
	connected: boolean;
	frames: number;
	macTelnetFrames: number;
	injected: number;
}

export interface MacTelnetL2Bridge {
	/** TCP port to hand quickchr as `{ type: "socket-connect", port }`. */
	readonly tcpPort: number;
	/** Register the handler for inbound (guest→host) UDP/20561 payloads. */
	onPacket(handler: (payload: Buffer) => void): void;
	/** Inject one MAC-Telnet datagram into the guest (no-op until connected). */
	inject(payload: Uint8Array, opts?: { dstMac?: Uint8Array }): void;
	/** Resolve once QEMU has dialed in, or false on timeout. */
	waitForConnection(timeoutMs: number): Promise<boolean>;
	stats(): MacTelnetL2BridgeStats;
	close(): Promise<void>;
}

export interface MacTelnetL2BridgeOptions {
	/** Log frame/inject counts to the console (debugging only). */
	debug?: boolean;
}

/**
 * Start the bridge: a loopback TCP server QEMU's `socket-connect` NIC dials.
 * The server must be listening before `QuickCHR.start`, because QEMU is the
 * connecting side.
 */
export async function startMacTelnetL2Bridge(
	options: MacTelnetL2BridgeOptions = {},
): Promise<MacTelnetL2Bridge> {
	let conn: net.Socket | undefined;
	let handler: ((payload: Buffer) => void) | undefined;
	let resolveConnected: (() => void) | undefined;
	const connectedPromise = new Promise<void>((resolve) => {
		resolveConnected = resolve;
	});
	const stats: MacTelnetL2BridgeStats = {
		connected: false,
		frames: 0,
		macTelnetFrames: 0,
		injected: 0,
	};

	const server = net.createServer((socket) => {
		conn = socket;
		stats.connected = true;
		resolveConnected?.();
		let buf = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			while (buf.length >= 4) {
				const len = buf.readUInt32BE(0);
				if (len > MAX_FRAME || buf.length < 4 + len) break;
				const frame = buf.subarray(4, 4 + len);
				buf = buf.subarray(4 + len);
				stats.frames += 1;
				const payload = ethernetToUdpPayload(frame, MAC_TELNET_PORT);
				if (!payload) continue;
				stats.macTelnetFrames += 1;
				if (options.debug) {
					console.log(
						`  bridge ← guest udp/${MAC_TELNET_PORT} (${payload.length}B), type=${payload[1]}`,
					);
				}
				handler?.(payload);
			}
		});
		const stop = (): void => {
			stats.connected = false;
		};
		socket.on("close", stop);
		socket.on("error", stop);
	});

	const tcpPort: number = await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			resolve((server.address() as net.AddressInfo).port);
		});
	});

	return {
		tcpPort,
		onPacket(next) {
			handler = next;
		},
		inject(payload, injectOpts = {}) {
			if (!conn || conn.destroyed) return;
			conn.write(buildMacTelnetStreamFrame(payload, injectOpts));
			stats.injected += 1;
			if (options.debug) {
				console.log(
					`  bridge → guest udp/${MAC_TELNET_PORT} (${payload.length}B), type=${payload[1]}`,
				);
			}
		},
		async waitForConnection(timeoutMs) {
			if (stats.connected) return true;
			const timer = new Promise<false>((resolve) =>
				setTimeout(() => resolve(false), timeoutMs),
			);
			return Promise.race([connectedPromise.then(() => true), timer]);
		},
		stats: () => ({ ...stats }),
		async close() {
			try {
				conn?.destroy();
			} catch {
				/* ignore */
			}
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
