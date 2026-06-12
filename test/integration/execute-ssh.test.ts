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
 * (S1–S4).
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.ts";
import { executeEnvelope } from "../../src/execute.ts";
import {
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
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
			expect(retOf(read.data)).toContain(identity);

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
			expect(reject.error.code).toBe("validation/unknown-attribute");
			const after = asRecordArray(await chr.rest("/ip/address"));
			expect(
				after.some((a) => (a["address"] ?? "").startsWith("198.51.100.51")),
			).toBe(false);

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
				exampleIds: [1, 2, 3, 4],
			});
		} finally {
			await chr.destroy();
		}
	}, 300_000);
});
