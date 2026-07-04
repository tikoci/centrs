import { createSocket } from "node:dgram";

/**
 * Probe whether this host can bind a udp4 socket to `127.0.0.1` with the
 * requested listener options.
 *
 * Windows has no `SO_REUSEPORT`, so a bind with `reusePort: true` throws
 * `bind ENOTSUP 127.0.0.1`. MNDP uses SO_REUSEPORT where the platform supports
 * it; btest's UDP data engine does not. Keep those probes separate so Windows
 * can still run plain UDP loopback tests instead of over-skipping them (#69).
 *
 * Callers MUST mirror the real bind options for the path being tested. A bare
 * UDP bind can succeed on Windows while a `reusePort:true` bind fails.
 *
 * Skip only for the *known-unsupported* bind errors — Windows lacks
 * `SO_REUSEPORT` → `ENOTSUP`; a runner with no IPv4 stack → `EAFNOSUPPORT`. Any
 * other bind error is treated as supported (resolve `true`) so the real test
 * still runs and surfaces the genuine regression instead of silently skipping it.
 *
 * Probed once per file at import time: bind a throwaway socket to an ephemeral
 * loopback port and report whether it succeeds.
 */
const UNSUPPORTED_BIND_CODES = new Set(["ENOTSUP", "EAFNOSUPPORT"]);

export interface UdpLoopbackProbeOptions {
	reusePort?: boolean;
}

export async function udpLoopbackSupported(
	options: UdpLoopbackProbeOptions = {},
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const socket = createSocket({
			type: "udp4",
			reuseAddr: true,
			...(options.reusePort !== undefined
				? { reusePort: options.reusePort }
				: {}),
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
		const onError = (error: unknown) => {
			const code = (error as { code?: string }).code ?? "";
			// Unknown error ⇒ assume supported, let the real test fail loudly.
			finish(!UNSUPPORTED_BIND_CODES.has(code));
		};
		socket.once("error", onError);
		try {
			socket.bind(0, "127.0.0.1", () => finish(true));
		} catch (error) {
			onError(error);
		}
	});
}
