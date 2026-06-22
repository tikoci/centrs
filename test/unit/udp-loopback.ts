import { createSocket } from "node:dgram";

/**
 * Probe whether this host can bind a udp4 socket to `127.0.0.1`.
 *
 * Some CI runners — notably certain GitHub `windows-latest` instances — reject a
 * UDP loopback bind with `ENOTSUP`/`EAFNOSUPPORT`, so unit tests that need a real
 * UDP loopback socket (the MNDP listener, the btest UDP data engine) would
 * hard-fail there. That loopback data path is also covered by the gated CHR
 * integration tests, so those unit tests skip gracefully on such a runner via
 * `describe.skipIf` / `test.skipIf` rather than failing (issue #69). TCP loopback
 * is unaffected, so TCP-based tests are not gated.
 *
 * Probed once per file at import time: bind a throwaway socket to an ephemeral
 * loopback port and report whether it succeeds.
 */
export async function udpLoopbackSupported(): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const socket = createSocket("udp4");
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			try {
				socket.close();
			} catch {
				// Already closed (or never bound after an error) — nothing to do.
			}
			resolve(ok);
		};
		socket.once("error", () => finish(false));
		try {
			socket.bind(0, "127.0.0.1", () => finish(true));
		} catch {
			finish(false);
		}
	});
}
