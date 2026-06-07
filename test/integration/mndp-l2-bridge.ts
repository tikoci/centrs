/**
 * Host-side L2 bridge for the MNDP integration test.
 *
 * `centrs discover` is, by design, a plain UDP/5678 listener: in a real
 * deployment it sits on a host NIC that already carries the layer-2 broadcast
 * segment. A `user`/SLIRP CHR cannot deliver that segment to the host, so the
 * integration harness gives the CHR a second `socket-connect` NIC. QEMU then
 * streams every guest Ethernet frame to a host TCP server, length-prefixed
 * (4-byte big-endian length + raw frame), and a frame written back is injected
 * into the guest. See `@tikoci/quickchr` `docs/mndp.md` and `examples/mndp/`.
 *
 * This bridge is the thin shim the `discover` README's "L2 validation policy"
 * describes: it de-frames the TCP stream, lifts the UDP/5678 payload out of each
 * Ethernet+IPv4+UDP frame, and re-delivers it as a genuine UDP datagram to
 * centrs's listener on loopback — so the code under test (`listenMndp` →
 * `parseMndpPacket` → cache → envelope) runs unmodified against real RouterOS
 * announcements. It also injects MNDP refresh frames back over the same TCP
 * connection (the L2 injection primitive MAC-Telnet will reuse) so a reply
 * arrives within a round-trip instead of waiting for RouterOS's ~30s cycle.
 *
 * It is deliberately framing-faithful (the same parse the quickchr example
 * uses) rather than reusing centrs's codec, so a wire-format regression on
 * either side cannot hide behind a shared helper.
 */

import { createSocket, type Socket as UdpSocket } from "node:dgram";
import net from "node:net";

const MNDP_PORT = 5678;
/** QEMU's legacy `-netdev socket` stream caps a frame well under this. */
const MAX_FRAME = 0xffff;

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
 * Wrap an MNDP payload in a broadcast Ethernet/IPv4/UDP frame and length-prefix
 * it for QEMU's stream socket. Writing this back over the TCP connection makes
 * RouterOS answer immediately. Mirrors the quickchr example's refresh frame.
 */
export function buildRefreshStreamFrame(payload: Uint8Array): Buffer {
	const body = Buffer.from(payload);
	const udp = Buffer.alloc(8 + body.length);
	udp.writeUInt16BE(MNDP_PORT, 0);
	udp.writeUInt16BE(MNDP_PORT, 2);
	udp.writeUInt16BE(udp.length, 4);
	body.copy(udp, 8);

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
	Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).copy(eth, 0); // dst broadcast
	Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]).copy(eth, 6); // host MAC
	eth.writeUInt16BE(0x0800, 12); // IPv4

	const frame = Buffer.concat([eth, ip, udp]);
	const lengthPrefix = Buffer.alloc(4);
	lengthPrefix.writeUInt32BE(frame.length, 0);
	return Buffer.concat([lengthPrefix, frame]);
}

export interface MndpL2BridgeStats {
	connected: boolean;
	frames: number;
	mndpFrames: number;
	forwarded: number;
}

export interface MndpL2Bridge {
	/** TCP port to hand quickchr as `{ type: "socket-connect", port }`. */
	readonly tcpPort: number;
	/** Point the UDP forwarder at centrs's listener once its port is bound. */
	setUdpTarget(port: number, host?: string): void;
	/** Inject one MNDP refresh frame into the guest (no-op until connected). */
	injectRefresh(): void;
	stats(): MndpL2BridgeStats;
	close(): Promise<void>;
}

export interface MndpL2BridgeOptions {
	/** MNDP refresh payload to inject (defaults to the 9-byte zero refresh). */
	refreshPayload?: Uint8Array;
	/** Auto-inject a refresh every N ms while connected. `0` disables. */
	autoRefreshMs?: number;
	/** Log frame/forward counts to the console (debugging only). */
	debug?: boolean;
}

/**
 * Start the bridge: a loopback TCP server QEMU's `socket-connect` NIC dials.
 * The server must be listening before `QuickCHR.start`, because QEMU is the
 * connecting side.
 */
export async function startMndpL2Bridge(
	options: MndpL2BridgeOptions = {},
): Promise<MndpL2Bridge> {
	const refreshPayload = options.refreshPayload ?? new Uint8Array(9);
	const autoRefreshMs = options.autoRefreshMs ?? 0;

	let conn: net.Socket | undefined;
	let udpSock: UdpSocket | undefined;
	let udpTarget: { port: number; host: string } | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	const stats: MndpL2BridgeStats = {
		connected: false,
		frames: 0,
		mndpFrames: 0,
		forwarded: 0,
	};

	const injectRefresh = (): void => {
		if (!conn || conn.destroyed) return;
		conn.write(buildRefreshStreamFrame(refreshPayload));
	};

	const server = net.createServer((socket) => {
		conn = socket;
		stats.connected = true;
		let buf = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			while (buf.length >= 4) {
				const len = buf.readUInt32BE(0);
				if (len > MAX_FRAME || buf.length < 4 + len) break;
				const frame = buf.subarray(4, 4 + len);
				buf = buf.subarray(4 + len);
				stats.frames += 1;
				const payload = ethernetToUdpPayload(frame, MNDP_PORT);
				if (!payload) continue;
				stats.mndpFrames += 1;
				if (udpSock && udpTarget) {
					udpSock.send(payload, udpTarget.port, udpTarget.host, () => {
						stats.forwarded += 1;
						if (options.debug) {
							console.log(
								`  bridge → centrs udp/${udpTarget?.port} (${payload.length}B mndp), forwarded=${stats.forwarded}`,
							);
						}
					});
				}
			}
		});
		const stop = (): void => {
			stats.connected = false;
		};
		socket.on("close", stop);
		socket.on("error", stop);
		if (autoRefreshMs > 0) {
			injectRefresh();
			refreshTimer = setInterval(injectRefresh, autoRefreshMs);
		}
	});

	const tcpPort: number = await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			resolve((server.address() as net.AddressInfo).port);
		});
	});

	return {
		tcpPort,
		setUdpTarget(port, host = "127.0.0.1") {
			udpTarget = { port, host };
			if (!udpSock) udpSock = createSocket("udp4");
		},
		injectRefresh,
		stats: () => ({ ...stats }),
		async close() {
			if (refreshTimer) clearInterval(refreshTimer);
			try {
				conn?.destroy();
			} catch {
				/* ignore */
			}
			await new Promise<void>((resolve) => {
				if (udpSock) udpSock.close(() => resolve());
				else resolve();
			});
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
