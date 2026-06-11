import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.ts";
import {
	exampleIds,
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
} from "./chr.ts";

/**
 * CHR integration for `transfer` over rest-api + native-api + ssh/sftp. Maps
 * `commands/transfer/examples.md`: the REST round-trip, list + filters,
 * validate-before-write, device file management, error contract, the native
 * mirror (N1–N4), the sftp key-auth round-trip incl. the >60 KB gap REST cannot
 * write (S1–S6, which also closes example 17), and the residual gating (scp/fetch
 * not-implemented, ftp gated).
 *
 * Deferred to a follow-up (need a different harness than `runCli` console
 * capture): the stdin/stdout/cwd-default forms (examples 8–10).
 */

const runFastIntegration = isChrIntegrationEnabled();
const describeFast = runFastIntegration ? describe : describe.skip;

interface SuccessEnvelope {
	ok: true;
	data: unknown;
	meta: { via: string };
	warnings: Array<{ code?: string }>;
}
interface FailureEnvelope {
	ok: false;
	error: { code?: string; details_url?: string };
}

/** Generate an ed25519 keypair (no passphrase) at `keyPath` / `keyPath.pub`. */
function spawnKeygen(keyPath: string) {
	try {
		return Bun.spawn(
			[
				"ssh-keygen",
				"-t",
				"ed25519",
				"-N",
				"",
				"-C",
				"centrs-it",
				"-f",
				keyPath,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
	} catch (cause) {
		// `ssh-keygen` not on PATH — Bun.spawn throws synchronously.
		throw new Error(
			"SFTP integration needs a local `ssh-keygen` to mint a test keypair. Install an OpenSSH client (macOS/Linux package: openssh-client) or unset CENTRS_RUN_FAST_INTEGRATION to skip this suite.",
			{ cause },
		);
	}
}

async function generateKeyPair(keyPath: string): Promise<void> {
	const proc = spawnKeygen(keyPath);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(
			`ssh-keygen failed to generate the SFTP test keypair (exit ${exitCode}): ${stderr}`,
			{ cause: { tool: "ssh-keygen", exitCode, stderr, keyPath } },
		);
	}
}

function captureConsole() {
	const originalLog = console.log;
	const originalError = console.error;
	const logs: string[] = [];
	const errors: string[] = [];
	console.log = ((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	}) as typeof console.log;
	console.error = ((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	}) as typeof console.error;
	return {
		logs,
		errors,
		restore() {
			console.log = originalLog;
			console.error = originalError;
		},
	};
}

describeFast("transfer against CHR", () => {
	test("runs transfer rest + native examples against CHR", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		const capture = captureConsole();
		const tmp = await mkdtemp(join(tmpdir(), "centrs-transfer-it-"));

		try {
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			const rest = [
				chr.restUrl,
				"--username",
				auth.username,
				"--password",
				auth.password,
			];
			const apiPort = String(chr.ports.api);
			const native = [
				chr.restUrl,
				"--via",
				"native-api",
				"--port",
				apiPort,
				"--username",
				auth.username,
				"--password",
				auth.password,
			];

			async function ok(args: readonly string[]): Promise<SuccessEnvelope> {
				const logStart = capture.logs.length;
				const errStart = capture.errors.length;
				const exitCode = await runCli([...args, "--json"]);
				const stdout = capture.logs.slice(logStart);
				const stderr = capture.errors.slice(errStart);
				if (stderr.length > 0) {
					throw new Error(
						`unexpected stderr for [${args.join(" ")}]: ${stderr.join("\n")}`,
					);
				}
				expect(exitCode).toBe(0);
				const envelope = JSON.parse(stdout[0] ?? "") as SuccessEnvelope;
				expect(envelope.ok).toBe(true);
				return envelope;
			}

			async function fail(
				args: readonly string[],
				code: string,
			): Promise<FailureEnvelope> {
				const errStart = capture.errors.length;
				const exitCode = await runCli([...args, "--json"]);
				const stderr = capture.errors.slice(errStart);
				expect(exitCode).toBe(1);
				const envelope = JSON.parse(stderr[0] ?? "") as FailureEnvelope;
				expect(envelope.ok).toBe(false);
				expect(envelope.error.code).toBe(code);
				return envelope;
			}

			const src = join(tmp, "src.txt");
			const payload = "hello-centrs round-trip\n";
			await writeFile(src, payload);

			// 1. upload small (auto → rest)
			const up = await ok([
				"transfer",
				...rest,
				"upload",
				src,
				"centrs-up.txt",
			]);
			expect(up.meta.via).toBe("rest-api");
			expect(up.data).toMatchObject({
				op: "upload",
				remote: "centrs-up.txt",
				bytes: Buffer.byteLength(payload),
				verified: "size",
			});

			// 2. download it back (round-trip)
			const out = join(tmp, "down.txt");
			await ok(["transfer", ...rest, "download", "centrs-up.txt", out]);
			expect(await readFile(out, "utf8")).toBe(payload);

			// 3-5. list + filters
			const listed = await ok(["transfer", ...rest, "list"]);
			const names = (listed.data as Array<Record<string, unknown>>).map(
				(r) => r["name"],
			);
			expect(names).toContain("centrs-up.txt");
			const filesOnly = await ok([
				"transfer",
				...rest,
				"list",
				"--type",
				"file",
			]);
			for (const row of filesOnly.data as Array<Record<string, unknown>>) {
				expect(String(row["type"])).toContain("file");
			}
			const globbed = await ok([
				"transfer",
				...rest,
				"list",
				"--name",
				"centrs-*",
			]);
			for (const row of globbed.data as Array<Record<string, unknown>>) {
				expect(String(row["name"]).startsWith("centrs-")).toBe(true);
			}

			// 6. refuse overwrite; 7. --force overwrites
			await fail(
				["transfer", ...rest, "upload", src, "centrs-up.txt"],
				"usage/target-exists",
			);
			await ok([
				"transfer",
				...rest,
				"upload",
				src,
				"centrs-up.txt",
				"--force",
			]);

			// 11-14. device file management: mkdir, upload into dir, copy, remove
			await ok(["transfer", ...rest, "mkdir", "centrs-dir"]);
			await ok(["transfer", ...rest, "upload", src, "centrs-dir/nested.txt"]);
			await ok([
				"transfer",
				...rest,
				"copy",
				"centrs-dir/nested.txt",
				"centrs-dir/copy.txt",
			]);
			const afterCopy = await ok([
				"transfer",
				...rest,
				"list",
				"--name",
				"centrs-dir/*",
			]);
			const copyNames = (afterCopy.data as Array<Record<string, unknown>>).map(
				(r) => r["name"],
			);
			expect(copyNames).toContain("centrs-dir/nested.txt");
			expect(copyNames).toContain("centrs-dir/copy.txt");
			await ok(["transfer", ...rest, "remove", "centrs-dir/copy.txt"]);

			// 15. leading-slash normalization (download "/centrs-up.txt" === "centrs-up.txt")
			const slashOut = join(tmp, "slash.txt");
			const slashEnvelope = await ok([
				"transfer",
				...rest,
				"download",
				"/centrs-up.txt",
				slashOut,
			]);
			expect(slashEnvelope.data).toMatchObject({ remote: "centrs-up.txt" });
			expect(await readFile(slashOut, "utf8")).toBe(payload);

			// 16. --no-verify
			const noVerify = await ok([
				"transfer",
				...rest,
				"upload",
				src,
				"centrs-no-verify.txt",
				"--no-verify",
			]);
			expect(noVerify.data).toMatchObject({ verified: "off" });

			// 18. --via rest upload over 60 KB → rejected up front
			const big = join(tmp, "big.bin");
			await writeFile(big, Buffer.alloc(70_000, 7));
			await fail(
				[
					"transfer",
					...rest,
					"upload",
					big,
					"centrs-too-big.txt",
					"--via",
					"rest",
				],
				"transport/unsupported-operation",
			);

			// 19. download a missing remote file
			await fail(
				["transfer", ...rest, "download", "centrs-missing.txt", join(tmp, "x")],
				"routeros/command-failed",
			);

			// 20. bad credentials
			await fail(
				[
					"transfer",
					chr.restUrl,
					"list",
					"--username",
					"wrong",
					"--password",
					"wrong",
				],
				"transport/auth-failed",
			);

			// 21. conflicting flags
			await fail(
				[
					"transfer",
					...rest,
					"upload",
					src,
					"centrs-up.txt",
					"--verify",
					"size",
					"--no-verify",
				],
				"usage/conflicting-flags",
			);

			// N1-N3. native-api round-trip + list
			const nvUp = await ok([
				"transfer",
				...native,
				"upload",
				src,
				"centrs-nv.txt",
			]);
			expect(nvUp.meta.via).toBe("native-api");
			const nvOut = join(tmp, "nv.txt");
			await ok(["transfer", ...native, "download", "centrs-nv.txt", nvOut]);
			expect(await readFile(nvOut, "utf8")).toBe(payload);
			const nvList = await ok(["transfer", ...native, "list"]);
			expect(
				(nvList.data as Array<Record<string, unknown>>).map((r) => r["name"]),
			).toContain("centrs-nv.txt");

			// N4. native-api upload over 60 KB → rejected
			await fail(
				["transfer", ...native, "upload", big, "centrs-too-big.txt"],
				"transport/unsupported-operation",
			);

			// ── sftp (ssh): key-auth round-trip, the >60 KB gap, list/mkdir/remove ──
			// RouterOS refuses password login once a user has an SSH key, and centrs's
			// sftp client runs BatchMode=yes (no password prompts), so the faithful
			// path is key auth: generate a keypair, import the public half to the CHR
			// user, then drive `--via sftp --ssh-key`. The CHR forwards guest TCP/22 to
			// chr.sshPort over SLIRP. `--insecure` accepts the ephemeral host key.
			const keyPath = join(tmp, "id_centrs");
			await generateKeyPair(keyPath);
			await ok([
				"transfer",
				...rest,
				"upload",
				`${keyPath}.pub`,
				"centrs_it.pub",
			]);
			await chr.exec(
				`/user ssh-keys import public-key-file=centrs_it.pub user=${auth.username}`,
			);

			const sftp = [
				"127.0.0.1",
				"--via",
				"sftp",
				"--port",
				String(chr.sshPort),
				"--username",
				auth.username,
				"--ssh-key",
				keyPath,
				"--insecure",
			];

			// S1-S2. sftp upload + download round-trip (meta.via === ssh)
			const sUp = await ok([
				"transfer",
				...sftp,
				"upload",
				src,
				"centrs-sftp.txt",
			]);
			expect(sUp.meta.via).toBe("ssh");
			expect(sUp.data).toMatchObject({
				op: "upload",
				remote: "centrs-sftp.txt",
			});
			const sOut = join(tmp, "sftp-down.txt");
			await ok(["transfer", ...sftp, "download", "centrs-sftp.txt", sOut]);
			expect(await readFile(sOut, "utf8")).toBe(payload);

			// S3. the >60 KB gap REST cannot write — sftp streams it up, sftp reads back
			const bigOut = join(tmp, "sftp-big.bin");
			await ok(["transfer", ...sftp, "upload", big, "centrs-big.bin"]);
			await ok(["transfer", ...sftp, "download", "centrs-big.bin", bigOut]);
			expect((await readFile(bigOut)).byteLength).toBe(70_000);

			// 17. the same sftp-seeded >60 KB file reads back over REST via chunked
			// /file/read (no fetch-seed hack needed now that sftp can place it).
			const restBigOut = join(tmp, "rest-big.bin");
			const restBig = await ok([
				"transfer",
				...rest,
				"download",
				"centrs-big.bin",
				restBigOut,
			]);
			expect(restBig.meta.via).toBe("rest-api");
			expect((await readFile(restBigOut)).byteLength).toBe(70_000);

			// S4. list over sftp surfaces the uploaded file
			const sList = await ok(["transfer", ...sftp, "list"]);
			expect(
				(sList.data as Array<Record<string, unknown>>).map((r) => r["name"]),
			).toContain("centrs-sftp.txt");

			// S5. mkdir + remove over sftp
			await ok(["transfer", ...sftp, "mkdir", "centrs-sftp-dir"]);
			await ok(["transfer", ...sftp, "remove", "centrs-big.bin"]);

			// Residual gating: scp / fetch not-implemented, ftp gated.
			await fail(
				["transfer", ...rest, "upload", src, "centrs-up.txt", "--via", "scp"],
				"usage/not-implemented",
			);
			await fail(
				["transfer", ...rest, "upload", big, "centrs-up.bin", "--via", "fetch"],
				"usage/not-implemented",
			);
			await fail(
				["transfer", ...rest, "upload", src, "centrs-up.txt", "--via", "ftp"],
				"settings/unsafe-protocol-blocked",
			);

			// cleanup device files we created
			for (const name of [
				"centrs-up.txt",
				"centrs-no-verify.txt",
				"centrs-nv.txt",
				"centrs-sftp.txt",
				"centrs_it.pub",
				"centrs-sftp-dir",
				"centrs-dir/nested.txt",
				"centrs-dir",
			]) {
				await runCli(["transfer", ...rest, "remove", name, "--json"]);
			}

			await recordIntegrationEvidence({
				suite: "transfer against CHR",
				command: "transfer",
				protocol: "rest-api+native-api+ssh",
				routerosVersion: chr.state.version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(27),
			});
		} finally {
			capture.restore();
			await chr.destroy();
		}
	}, 300_000);
});
