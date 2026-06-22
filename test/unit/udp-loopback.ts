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
 * succeeds on Windows and would falsely report the path as supported, so the
 * skip guards never fire and the real (reusePort) binds ENOTSUP-fail instead.
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
