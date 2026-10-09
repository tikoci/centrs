/**
 * `retrieve --wait` over native-api against a loopback peer that accepts TCP
 * but never completes TLS, run as a real CLI process. The contract is that the
 * PROCESS exits once the deadline passes, which only a subprocess can observe
 * (the in-process `cli-capture` tier cannot see an exit).
 *
 * Network-free, so like `cli-smoke` and `api-stream-cancel` it is not CHR-gated
 * and runs in the fast `bun test` gate.
 */

import { expect, test } from "bun:test";
import { runCliProcess } from "./cli-process.ts";

const ENV = { CENTRS_SKIP_ENV_FILE: "1" };

test("native TLS handshake deadline closes the socket and lets the CLI exit", async () => {
	let closed = false;
	const listener = Bun.listen<undefined>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			// Accept TCP without completing TLS, so the connection remains pending.
			data() {},
			close() {
				closed = true;
			},
		},
	});
	try {
		const result = await runCliProcess({
			args: [
				"retrieve",
				"https://127.0.0.1",
				"--port",
				String(listener.port),
				"/system/resource",
				"--via",
				"native-api",
				"--username",
				"admin",
				"--password",
				"",
				"--wait",
				"80ms",
				"--timeout",
				"5s",
				"--json",
			],
			env: ENV,
			killAfterMs: 2_000,
		});
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdoutText)).toMatchObject({
			ok: false,
			error: { code: "wait/deadline-exceeded" },
			meta: {
				operation: {
					wait: { stopReason: "deadline-elapsed", observations: 0 },
				},
			},
		});
		await Bun.sleep(20);
		expect(closed).toBe(true);
	} finally {
		listener.stop(true);
	}
});
