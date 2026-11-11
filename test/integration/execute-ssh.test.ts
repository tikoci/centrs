/**
 * `execute` over SSH against a real CHR SSH server.
 *
 * RouterOS grants no pseudo-tty, but `ssh user@host "<command>"` runs one console
 * command and returns clean output — so `execute / ssh` is a per-command
 * `SshExecClient` (one `ssh` invocation per command, like the SFTP batch client),
 * with the `:put [:parse …]` validation gate reused verbatim from mac-telnet.
 *
 * This drives the **product** path: `executeEnvelope()` → resolver (`--via ssh`) →
 * `SshExecAdapter` → host `ssh`, against the CHR's forwarded SSH port. The harness
 * mints an ed25519 keypair, imports the public half to the CHR user, and uses key
 * auth (`--insecure` accepts the ephemeral host key). Grounded on CHR 7.23.1; REST
 * is the source of truth for the cross-checks. Maps `commands/execute/examples.md`
 * (S1–S4, S6–S7).
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.ts";
import { executeEnvelope } from "../../src/execute.ts";
import {
	collapsePrintWrapping,
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
	VALIDATION_REJECT_CODES,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

function asRecord(value: unknown): Record<string, string> {
	return (value ?? {}) as Record<string, string>;
}
function asRecordArray(value: unknown): Record<string, string>[] {
	return Array.isArray(value) ? (value as Record<string, string>[]) : [];
}
function retOf(data: unknown): string {
	return asRecord(data)["ret"] ?? "";
}

function spawnKeygen(path: string) {
	try {
		return Bun.spawn(
			["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "centrs-it", "-f", path],
			{ stdout: "pipe", stderr: "pipe" },
		);
	} catch (cause) {
		// `ssh-keygen` not on PATH — Bun.spawn throws synchronously.
		throw new Error(
			"execute/ssh integration needs a local `ssh-keygen` to mint a test keypair. Install an OpenSSH client (macOS ships it; Debian/Ubuntu: openssh-client) or unset CENTRS_RUN_FAST_INTEGRATION to skip.",
			{ cause },
		);
	}
}

async function keygen(path: string): Promise<void> {
	const proc = spawnKeygen(path);
	if ((await proc.exited) !== 0) {
		throw new Error(
			`ssh-keygen failed to mint the execute/ssh test key: ${await new Response(proc.stderr).text()}`,
		);
	}
}

describeFast("execute over ssh (per-command ssh host)", () => {
	test("read / write / validate-reject over a real CHR SSH server", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		try {
			expect(await chr.waitForBoot(180_000)).toBe(true);
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			const tmp = await mkdtemp(join(tmpdir(), "centrs-exec-ssh-"));
			const key = join(tmp, "id");
			await keygen(key);

			// Import the public key for the admin so key auth works (RouterOS refuses
			// password login once a key is set, and the sftp/ssh client runs BatchMode).
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

			const base = {
				targetInput: "127.0.0.1",
				via: "ssh" as const,
				port: chr.sshPort,
				username: auth.username,
				sshKey: key,
				insecure: true,
			};
			const identity =
				asRecord(await chr.rest("/system/identity"))["name"] ?? "";
			const version =
				asRecord(await chr.rest("/system/resource"))["version"] ?? "";

			// S1 — read a command; clean output cross-checked against REST.
			const read = await executeEnvelope({
				...base,
				command: "/system/identity/print",
			});
			expect(read.ok, read.ok ? "" : JSON.stringify(read.error)).toBe(true);
			if (!read.ok) return;
			expect(read.meta.via).toBe("ssh");
			// Asserted on the printed `name: <identity>` line, with the device's column
			// wrapping rejoined: a one-property `print`'s layout is not stable across
			// RouterOS builds (GH#352 — see collapsePrintWrapping).
			expect(collapsePrintWrapping(retOf(read.data))).toContain(
				`name: ${identity}`,
			);

			// S2 — a multi-line read returns the cleaned, column-aligned output.
			const resource = await executeEnvelope({
				...base,
				command: "/system/resource/print",
			});
			expect(resource.ok).toBe(true);
			if (!resource.ok) return;
			expect(retOf(resource.data)).toContain(version.split(" ")[0] ?? version);

			// S3 — write (add) with --yes; success prints nothing; verify via REST.
			const write = await executeEnvelope({
				...base,
				command: "/ip/address/add address=198.51.100.50/32 interface=ether1",
				yes: true,
			});
			expect(write.ok, write.ok ? "" : JSON.stringify(write.error)).toBe(true);
			const added = asRecordArray(await chr.rest("/ip/address"));
			expect(
				added.some((a) => (a["address"] ?? "").startsWith("198.51.100.50")),
				"address added over ssh missing from REST",
			).toBe(true);

			// S4 — the :parse gate over ssh rejects an unknown attribute pre-run.
			const reject = await executeEnvelope({
				...base,
				command:
					"/ip/address/add address=198.51.100.51/32 interface=ether1 bogus=x",
				yes: true,
			});
			expect(reject.ok).toBe(false);
			if (reject.ok) return;
			expect(VALIDATION_REJECT_CODES).toContain(reject.error.code);
			const after = asRecordArray(await chr.rest("/ip/address"));
			expect(
				after.some((a) => (a["address"] ?? "").startsWith("198.51.100.51")),
			).toBe(false);

			// S6 — a multi-line script runs as one unit over SSH. RouterOS ends
			// the exec prompt at every LF, so centrs sends line breaks as CR (#576):
			// menu context and `:local` carry across lines, and a failing line
			// stops the script with its diagnostic.
			await chr.exec(
				"/ip/firewall/address-list/add list=centrs-s6 address=192.0.2.66",
			);
			const menu = await executeEnvelope({
				...base,
				command: "/ip/firewall/address-list\nprint where list=centrs-s6\n",
				yes: true,
			});
			expect(menu.ok, menu.ok ? "" : JSON.stringify(menu.error)).toBe(true);
			if (!menu.ok) return;
			expect(retOf(menu.data)).toContain("192.0.2.66");

			const local = await executeEnvelope({
				...base,
				command: ":local x 17\n:put $x",
				yes: true,
			});
			expect(local.ok, local.ok ? "" : JSON.stringify(local.error)).toBe(true);
			if (!local.ok) return;
			expect(retOf(local.data)).toBe("17");

			// `:error` passes `:parse` and fails at run time, on line 2.
			const stopped = await executeEnvelope({
				...base,
				command: ":put before\n:error boom\n:put after",
				yes: true,
			});
			expect(stopped.ok).toBe(false);
			if (stopped.ok) return;
			expect(stopped.error.code).toBe("routeros/command-failed");
			expect(stopped.error.context).toMatchObject({
				via: "ssh",
				exitCode: 1,
				partialRunPossible: true,
			});
			const stoppedOutput = String(stopped.error.context?.["output"]);
			expect(stoppedOutput).toContain("before");
			expect(stoppedOutput).toContain("boom (:error; line 2)");
			expect(stoppedOutput).not.toContain("after");

			// S7 — the budget runs out mid-script: an execution timeout that names
			// the budget and keeps the output printed before the cutoff (#592).
			const cut = await executeEnvelope({
				...base,
				command: ":put begin; :delay 6s; :put end",
				timeout: "3s",
				yes: true,
			});
			expect(cut.ok).toBe(false);
			if (cut.ok) return;
			expect(cut.error.code).toBe("transport/timeout");
			expect(cut.error.summary).toContain("did not finish within 3s");
			expect(cut.error.context).toMatchObject({
				timeoutMs: 3000,
				partialOutput: "begin",
				outputComplete: false,
			});

			const res = asRecord(await chr.rest("/system/resource"));
			await recordIntegrationEvidence({
				suite: "execute over ssh (per-command ssh host)",
				command: "execute",
				protocol: "ssh",
				routerosVersion: res["version"] ?? chr.state.version,
				boardName: res["board-name"],
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [1, 2, 3, 4, "S6", "S7"],
			});
		} finally {
			await chr.destroy();
		}
	}, 300_000);
});
