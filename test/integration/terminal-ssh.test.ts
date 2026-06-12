/**
 * `terminal` over SSH against a real CHR SSH server.
 *
 * RouterOS grants no pseudo-tty, but `ssh user@host` opens the interactive console
 * and relays it — so `terminal / ssh` execs the host `ssh` with inherited stdio
 * (the OS relays the already-clean no-PTY console; no screen emulation). This
 * drives the **real `centrs terminal` binary** through the subprocess harness
 * (`./cli-process.ts`): the piped stdin stands in for typed keystrokes, and the
 * device's response is read off stdout. Maps `commands/terminal/examples.md`
 * (TS1–TS2). Grounded on CHR 7.23.1; REST is the source of truth.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.ts";
import {
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
} from "./chr.ts";
import { runCliProcess } from "./cli-process.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

function asRecord(value: unknown): Record<string, string> {
	return (value ?? {}) as Record<string, string>;
}

function spawnKeygen(path: string) {
	try {
		return Bun.spawn(
			["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "centrs-it", "-f", path],
			{ stdout: "pipe", stderr: "pipe" },
		);
	} catch (cause) {
		throw new Error(
			"terminal/ssh integration needs a local `ssh-keygen` to mint a test keypair. Install an OpenSSH client (macOS ships it; Debian/Ubuntu: openssh-client) or unset CENTRS_RUN_FAST_INTEGRATION to skip.",
			{ cause },
		);
	}
}

async function keygen(path: string): Promise<void> {
	const proc = spawnKeygen(path);
	if ((await proc.exited) !== 0) {
		throw new Error(
			`ssh-keygen failed to mint the terminal/ssh test key: ${await new Response(proc.stderr).text()}`,
		);
	}
}

describeFast("terminal over ssh (host ssh relay)", () => {
	test("batch relay runs a command + capability gate, over real CHR ssh", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		try {
			expect(await chr.waitForBoot(180_000)).toBe(true);
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			const tmp = await mkdtemp(join(tmpdir(), "centrs-term-ssh-"));
			const key = join(tmp, "id");
			await keygen(key);
			await runCli([
				"transfer",
				chr.restUrl,
				"--username",
				auth.username,
				"--password",
				auth.password,
				"upload",
				`${key}.pub`,
				"centrs_it.pub",
				"--json",
			]);
			await chr.exec(
				`/user ssh-keys import public-key-file=centrs_it.pub user=${auth.username}`,
			);

			const identity =
				asRecord(await chr.rest("/system/identity"))["name"] ?? "";
			const base = [
				"terminal",
				"127.0.0.1",
				"--via",
				"ssh",
				"--port",
				String(chr.sshPort),
				"--username",
				auth.username,
				"--ssh-key",
				key,
				"--insecure",
			];

			// TS1 — pipe a command + /quit; the device's response appears on stdout.
			const ts1 = await runCliProcess({
				args: base,
				stdin: "/system/identity/print\n/quit\n",
			});
			expect(
				ts1.stdoutText,
				`terminal/ssh exit ${ts1.exitCode}; stderr=${ts1.stderrText}`,
			).toContain(identity);

			// TS2 — rest-api has no terminal capability (short-circuits before connect).
			const ts2 = await runCliProcess({
				args: [
					"terminal",
					"127.0.0.1",
					"--via",
					"rest-api",
					"--username",
					auth.username,
					"--json",
				],
			});
			expect(ts2.exitCode).toBe(1);
			expect(JSON.parse(ts2.stderrText).error.code as string).toBe(
				"transport/capability-unsupported",
			);

			const resource = asRecord(await chr.rest("/system/resource"));
			await recordIntegrationEvidence({
				suite: "terminal over ssh (host ssh relay)",
				command: "terminal",
				protocol: "ssh",
				routerosVersion: resource["version"] ?? chr.state.version,
				boardName: resource["board-name"],
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [1, 2],
			});
		} finally {
			await chr.destroy();
		}
	}, 300_000);
});
