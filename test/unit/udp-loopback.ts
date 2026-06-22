import { createSocket } from "node:dgram";

/**
 * Probe whether this host can bind a udp4 socket to `127.0.0.1` with the same
 * options the real listeners use — specifically `reusePort: true` (`SO_REUSEPORT`).
 *
 * Windows has no `SO_REUSEPORT`, so a bind with `reusePort: true` throws
 * `bind ENOTSUP 127.0.0.1`. The MNDP listener (`src/discover.ts`) and the btest
 * UDP data engine bind that way, so on `windows-latest` those unit tests
 * hard-fail. That loopback data path is also covered by the gated CHR
 * integration tests, so those unit tests skip gracefully on such a runner via
 * `describe.skipIf` / `test.skipIf` rather than failing (issue #69). TCP loopback
 * is unaffected, so TCP-based tests are not gated.
 *
 * The probe MUST mirror the real bind options — a bare `reusePort:false` bind
 * succeeds on Windows and would falsely report the path as supported, leaving the
 * real (reusePort) binds to ENOTSUP-fail unskipped.
 *
 * Probed once per file at import time: bind a throwaway socket to an ephemeral
 * loopback port and report whether it succeeds.
 */
export async function udpLoopbackSupported(): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const socket = createSocket({
			type: "udp4",
			reuseAddr: true,
			reusePort: true,
		});
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
