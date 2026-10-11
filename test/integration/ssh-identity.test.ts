import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
} from "./chr.ts";
import { runCliProcess } from "./cli-process.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

async function runTool(args: string[], env = process.env): Promise<void> {
	const proc = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
	const [, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, `${args[0]}: ${stderr}`).toBe(0);
}

describeFast("SSH identity selection", () => {
	test("execute, sftp and terminal reject a selected wrong key despite a trusted agent key", async () => {
		const tools = new Map(
			["ssh", "sftp", "ssh-agent", "ssh-add", "ssh-keygen"].map((name) => {
				const binary = Bun.which(name);
				if (!binary) {
					throw new Error(
						`SSH identity integration requires ${name}; install an OpenSSH client.`,
					);
				}
				return [name, binary];
			}),
		);
		const started = await startIntegrationChr();
		const chr = started.chr;
		let tmp: string | undefined;
		let agent: Bun.Subprocess | undefined;
		try {
			tmp = await mkdtemp(join(tmpdir(), "centrs-ssh-"));
			expect(await chr.waitForBoot(180_000)).toBe(true);
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			const trustedKey = join(tmp, "trusted");
			const rejectedKey = join(tmp, "rejected");
			for (const key of [trustedKey, rejectedKey]) {
				await runTool(["ssh-keygen", "-t", "ed25519", "-N", "", "-f", key]);
			}
			const upload = await runCliProcess({
				args: [
					"transfer",
					chr.restUrl,
					"--username",
					auth.username,
					"--password",
					auth.password,
					"upload",
					`${trustedKey}.pub`,
					"centrs-identity.pub",
					"--json",
				],
			});
			expect(upload.exitCode, upload.stderrText).toBe(0);
			await chr.exec(
				`/user ssh-keys import public-key-file=centrs-identity.pub user=${auth.username}`,
			);

			const socket = join(tmp, "agent");
			agent = Bun.spawn(["ssh-agent", "-D", "-a", socket], {
				stdout: "ignore",
				stderr: "ignore",
			});
			const deadline = Date.now() + 5000;
			while (
				!(await access(socket).then(
					() => true,
					() => false,
				))
			) {
				if (Date.now() >= deadline || agent.exitCode !== null) {
					throw new Error("The test SSH agent did not create its socket.");
				}
				await Bun.sleep(25);
			}
			const env = { ...process.env, SSH_AUTH_SOCK: socket };
			await runTool(["ssh-add", trustedKey], env);

			// Real OpenSSH, with an empty config and our private agent, so neither
			// the developer's keys nor host-specific settings can affect the controls.
			// BatchMode on this test relay prevents terminal from prompting on failure.
			const config = join(tmp, "config");
			await writeFile(config, "", { mode: 0o600 });
			for (const name of ["ssh", "sftp"]) {
				await writeFile(
					join(tmp, name),
					`#!/usr/bin/env bun\nconst proc = Bun.spawnSync([${JSON.stringify(tools.get(name))}, "-F", ${JSON.stringify(config)}, "-o", ${JSON.stringify(`IdentityAgent=${socket}`)}, "-o", "BatchMode=yes", ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });\nprocess.exit(proc.exitCode);\n`,
					{ mode: 0o700 },
				);
			}
			const cliEnv = {
				SSH_AUTH_SOCK: socket,
				PATH: `${tmp}:${process.env["PATH"]}`,
				CENTRS_SSH_KEY: "",
			};
			const base = [
				"127.0.0.1",
				"--port",
				String(chr.sshPort),
				"--username",
				auth.username,
				"--insecure",
			];
			const identity =
				((await chr.rest("/system/identity")) as Record<string, string>)[
					"name"
				] ?? "";
			expect(identity.length).toBeGreaterThan(0);

			// Selecting the public half also proves the agent may sign for a selected
			// identity: IdentitiesOnly restricts identities, not their signing source.
			for (const key of [
				undefined,
				trustedKey,
				`${trustedKey}.pub`,
				rejectedKey,
			] as const) {
				const keyArgs = key ? ["--ssh-key", key] : [];
				for (const command of ["execute", "transfer", "terminal"]) {
					const args =
						command === "execute"
							? [
									command,
									...base,
									":put [/system/identity/get name]",
									"--via",
									"ssh",
									...keyArgs,
									"--json",
								]
							: command === "transfer"
								? [
										command,
										...base,
										"list",
										"--via",
										"sftp",
										...keyArgs,
										"--json",
									]
								: [command, ...base, "--via", "ssh", ...keyArgs];
					const result = await runCliProcess({
						args,
						env: cliEnv,
						stdin:
							command === "terminal"
								? ':put ("centrs-identity:" . [/system/identity/get name])\n/quit\n'
								: undefined,
						killAfterMs: 30_000,
					});
					const label = `${command}, ${key ?? "agent default"}: ${result.stderrText}`;
					if (key === rejectedKey) {
						expect(result.exitCode, label).not.toBe(0);
						if (command === "terminal") {
							expect(result.stderrText, label).toContain("Permission denied");
						} else {
							expect(JSON.parse(result.stderrText).error.code, label).toBe(
								"auth/failed",
							);
						}
					} else {
						if (command === "terminal") {
							// RouterOS's no-PTY console can exit nonzero after /quit/EOF.
							// Require the command's result, not just its identity in a prompt.
							expect(result.stdoutText, label).toContain(
								`centrs-identity:${identity}`,
							);
						} else {
							expect(result.exitCode, label).toBe(0);
							const envelope = JSON.parse(result.stdoutText);
							expect(envelope.ok, label).toBe(true);
							if (command === "execute")
								expect(envelope.data.ret).toContain(identity);
							else expect(Array.isArray(envelope.data)).toBe(true);
						}
					}
				}
			}
			const resource = (await chr.rest("/system/resource")) as Record<
				string,
				string
			>;
			for (const [command, example] of [
				["execute", "S5"],
				["transfer", "S6"],
				["terminal", "TS4"],
			] as const) {
				await recordIntegrationEvidence({
					suite: "SSH identity selection",
					command,
					protocol: "ssh",
					routerosVersion: resource["version"] ?? chr.state.version,
					boardName: resource["board-name"],
					quickChrName: chr.name,
					requestedChannel: started.requestedChannel,
					requestedVersion: started.requestedVersion,
					exampleIds: [example],
				});
			}
		} finally {
			if (agent) {
				agent.kill();
				await agent.exited;
			}
			try {
				await chr.destroy();
			} finally {
				if (tmp) await rm(tmp, { recursive: true, force: true });
			}
		}
	}, 300_000);
});
