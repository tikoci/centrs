import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
} from "./chr.ts";
import { runCliProcess } from "./cli-process.ts";

/**
 * CHR grounding for #391: what RouterOS's SSH password policy does, and that
 * centrs's batch SFTP never takes part in it.
 *
 * The password control is plain OpenSSH forced to password auth through
 * `SSH_ASKPASS` — centrs cannot be the control, because its batch clients never
 * send a password. Controls, in order, for a fresh user with a password:
 *
 * - P1 no key installed: password login succeeds (default `yes-if-no-key`).
 * - C1 centrs `--via sftp` with that same password and no usable key:
 *   `auth/failed`, with the resolved meta and the password-not-used tip.
 * - P2 after `/user/ssh-keys import`: password login is refused.
 * - K1 centrs `--via sftp --ssh-key` with the installed key: succeeds.
 * - P3 `password-authentication=yes`: password login succeeds again, key present.
 *
 * Then group policy, each user holding the same installed key:
 *
 * - G1 no `write` (`ssh,ftp,read`): login works, upload and mkdir are refused
 *   after it — `routeros/command-failed`, not `auth/failed`, and no password tips.
 * - G2 no `ftp` (`ssh,read,write`): RouterOS closes the SFTP session with SSH
 *   disconnect reason 7 — `routeros/session-closed`.
 * - G3 no `ssh` (`ftp,read,write`): refused at login — `auth/failed`.
 */

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

const USER = "centrs391";
const PASSWORD = "Centrs-391-pw";

function requireTool(name: string): string {
	const binary = Bun.which(name);
	if (!binary) {
		throw new Error(
			`SSH auth policy integration requires ${name}; install an OpenSSH client.`,
		);
	}
	return binary;
}

async function runTool(args: string[]): Promise<void> {
	const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const [, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, `${args[0]}: ${stderr}`).toBe(0);
}

describeFast("SSH password policy vs batch SFTP (#391)", () => {
	test("RouterOS password-authentication controls, and batch SFTP never sends the password", async () => {
		const ssh = requireTool("ssh");
		const sftp = requireTool("sftp");
		requireTool("ssh-keygen");
		const started = await startIntegrationChr();
		const chr = started.chr;
		let tmp: string | undefined;
		try {
			tmp = await mkdtemp(join(tmpdir(), "centrs-391-"));
			expect(await chr.waitForBoot(180_000)).toBe(true);
			const admin = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			await chr.exec(
				`/user add name=${USER} group=full password="${PASSWORD}"`,
			);
			const sshSettings = (await chr.rest("/ip/ssh")) as Record<string, string>;
			expect(sshSettings["password-authentication"]).toBe("yes-if-no-key");

			// An empty config and no agent, so neither the developer's keys nor
			// host-specific settings can affect any control.
			const config = join(tmp, "config");
			await writeFile(config, "", { mode: 0o600 });
			const askpass = join(tmp, "askpass");
			await writeFile(askpass, `#!/bin/sh\necho '${PASSWORD}'\n`, {
				mode: 0o700,
			});
			const isolation = [
				"-F",
				config,
				"-o",
				"IdentityAgent=none",
				"-o",
				"StrictHostKeyChecking=no",
				"-o",
				"UserKnownHostsFile=/dev/null",
			];

			const passwordLogin = async (): Promise<{
				ok: boolean;
				detail: string;
			}> => {
				const proc = Bun.spawn(
					[
						ssh,
						...isolation,
						"-p",
						String(chr.sshPort),
						"-o",
						"PubkeyAuthentication=no",
						"-o",
						"PreferredAuthentications=password,keyboard-interactive",
						"-o",
						"NumberOfPasswordPrompts=1",
						`${USER}@127.0.0.1`,
						':put "centrs-391-password-ok"',
					],
					{
						env: {
							...process.env,
							SSH_ASKPASS: askpass,
							SSH_ASKPASS_REQUIRE: "force",
							DISPLAY: process.env["DISPLAY"] ?? ":0",
						},
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const [stdout, stderr] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				return {
					ok: stdout.includes("centrs-391-password-ok"),
					detail: `exit ${proc.exitCode}; stdout ${stdout}; stderr ${stderr}`,
				};
			};

			// P1. No key installed: the password control logs in.
			const p1 = await passwordLogin();
			expect(p1.ok, `P1 ${p1.detail}`).toBe(true);

			// C1. Same user and password through centrs batch SFTP: refused, and
			// the envelope says which host/user/sources were tried and that the
			// password was never sent.
			const wrapped = join(tmp, "sftp");
			await writeFile(
				wrapped,
				`#!/usr/bin/env bun\nconst proc = Bun.spawnSync([${JSON.stringify(sftp)}, ${isolation.map((arg) => JSON.stringify(arg)).join(", ")}, ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });\nprocess.exit(proc.exitCode);\n`,
				{ mode: 0o700 },
			);
			const cliEnv = {
				PATH: `${tmp}${delimiter}${process.env["PATH"]}`,
				SSH_AUTH_SOCK: "",
				CENTRS_SSH_KEY: "",
			};
			const sftpArgs = [
				"transfer",
				"127.0.0.1",
				"--via",
				"sftp",
				"--port",
				String(chr.sshPort),
				"--username",
				USER,
				"--insecure",
			];
			const c1 = await runCliProcess({
				args: [...sftpArgs, "--password", PASSWORD, "list", "--json"],
				env: cliEnv,
				killAfterMs: 30_000,
			});
			expect(c1.exitCode, c1.stderrText).toBe(1);
			expect(c1.stderrText).not.toContain(PASSWORD);
			const envelope = JSON.parse(c1.stderrText);
			expect(envelope.error.code).toBe("auth/failed");
			expect(envelope.error.context.sshKeySelected).toBe(false);
			expect(envelope.meta.via).toBe("ssh");
			expect(envelope.meta.target).toMatchObject({
				input: "127.0.0.1",
				host: "127.0.0.1",
				port: chr.sshPort,
			});
			expect(envelope.meta.settings.password).toEqual({
				kind: "cli",
				key: "password",
			});
			expect(envelope.meta.operation.auth).toEqual({
				username: USER,
				passwordProvided: true,
			});
			expect(envelope.tips.map((tip: { code: string }) => tip.code)).toEqual([
				"tip/sftp-password-not-used",
				"tip/transfer-password-transport",
			]);
			const c1Text = await runCliProcess({
				args: [...sftpArgs, "--password", PASSWORD, "list"],
				env: cliEnv,
				killAfterMs: 30_000,
			});
			expect(c1Text.exitCode).toBe(1);
			expect(c1Text.stderrText).toContain("[tip/sftp-password-not-used]");
			expect(c1Text.stderrText).not.toContain(PASSWORD);

			// Install a key for the user.
			const key = join(tmp, "key");
			await runTool(["ssh-keygen", "-t", "ed25519", "-N", "", "-f", key]);
			const upload = await runCliProcess({
				args: [
					"transfer",
					chr.restUrl,
					"--username",
					admin.username,
					"--password",
					admin.password,
					"upload",
					`${key}.pub`,
					"centrs-391.pub",
					"--json",
				],
			});
			expect(upload.exitCode, upload.stderrText).toBe(0);
			await chr.exec(
				`/user ssh-keys import public-key-file=centrs-391.pub user=${USER}`,
			);

			// P2. Key installed, default policy: the password control is refused.
			const p2 = await passwordLogin();
			expect(p2.ok, `P2 ${p2.detail}`).toBe(false);
			expect(p2.detail).toContain("Permission denied");

			// K1. The installed key authenticates batch SFTP.
			const k1 = await runCliProcess({
				args: [...sftpArgs, "--ssh-key", key, "list", "--json"],
				env: cliEnv,
				killAfterMs: 30_000,
			});
			expect(k1.exitCode, k1.stderrText).toBe(0);
			expect(JSON.parse(k1.stdoutText).ok).toBe(true);

			// P3. password-authentication=yes allows the password with a key present.
			await chr.exec("/ip ssh set password-authentication=yes");
			const p3 = await passwordLogin();
			expect(p3.ok, `P3 ${p3.detail}`).toBe(true);

			// G1–G3. Group policy decides which failure a key-authenticated user gets.
			const policyCase = async (
				name: string,
				policy: string,
				args: readonly string[],
			): Promise<{ code: string; tips: readonly unknown[] }> => {
				await chr.exec(`/user group add name=${name} policy=${policy}`);
				await chr.exec(
					`/user add name=${name} group=${name} password="${PASSWORD}"`,
				);
				const pub = await runCliProcess({
					args: [
						"transfer",
						chr.restUrl,
						"--username",
						admin.username,
						"--password",
						admin.password,
						"upload",
						`${key}.pub`,
						`${name}.pub`,
						"--json",
					],
				});
				expect(pub.exitCode, pub.stderrText).toBe(0);
				await chr.exec(
					`/user ssh-keys import public-key-file=${name}.pub user=${name}`,
				);
				const run = await runCliProcess({
					args: [
						"transfer",
						"127.0.0.1",
						"--via",
						"sftp",
						"--port",
						String(chr.sshPort),
						"--username",
						name,
						"--password",
						PASSWORD,
						"--ssh-key",
						key,
						"--insecure",
						...args,
						"--json",
					],
					env: cliEnv,
					killAfterMs: 30_000,
				});
				const label = `${name} ${args[0]}: ${run.stderrText}`;
				expect(run.exitCode, label).toBe(1);
				const failed = JSON.parse(run.stderrText);
				return { code: failed.error.code, tips: failed.tips };
			};
			const local = join(tmp, "g1.txt");
			await writeFile(local, "centrs #391\n");
			for (const args of [
				["upload", local, "centrs-391-g1.txt"],
				["mkdir", "centrs-391-g1"],
			]) {
				const g1 = await policyCase(
					`centrs391w${args[0]}`,
					"ssh,ftp,read",
					args,
				);
				expect(g1.code, `G1 ${args[0]}`).toBe("routeros/command-failed");
				expect(g1.tips).toEqual([]);
			}
			const g2 = await policyCase("centrs391-no-ftp", "ssh,read,write", [
				"list",
			]);
			expect(g2.code).toBe("routeros/session-closed");
			const g3 = await policyCase("centrs391-no-ssh", "ftp,read,write", [
				"list",
			]);
			expect(g3.code).toBe("auth/failed");

			const resource = (await chr.rest("/system/resource")) as Record<
				string,
				string
			>;
			await recordIntegrationEvidence({
				suite: "SSH password policy vs batch SFTP",
				command: "transfer",
				protocol: "ssh",
				routerosVersion: resource["version"] ?? chr.state.version,
				boardName: resource["board-name"],
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: ["S7", "S8", "S9"],
			});
		} finally {
			try {
				await chr.destroy();
			} finally {
				if (tmp) await rm(tmp, { recursive: true, force: true });
			}
		}
	}, 300_000);
});
