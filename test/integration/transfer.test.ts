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
 * CHR integration for `transfer` over rest-api + native-api. Maps
 * `commands/transfer/examples.md`: the REST round-trip, list + filters,
 * validate-before-write, device file management, error contract, the native
 * mirror (N1–N4), and the pending-transport gating (P1–P4).
 *
 * Deferred to a follow-up (need a different harness than `runCli` console
 * capture): the stdin/stdout/cwd-default forms (examples 8–10) and the
 * fetch-seeded >60 KB chunked read (example 17).
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
				expect(stderr).toHaveLength(0);
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

			// P1-P4. pending transports / gated ftp
			await fail(
				["transfer", ...rest, "upload", src, "centrs-up.txt", "--via", "sftp"],
				"usage/not-implemented",
			);
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
				"centrs-dir/nested.txt",
				"centrs-dir",
			]) {
				await runCli(["transfer", ...rest, "remove", name, "--json"]);
			}

			await recordIntegrationEvidence({
				suite: "transfer against CHR",
				command: "transfer",
				protocol: "rest-api+native-api",
				routerosVersion: chr.state.version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(21),
			});
		} finally {
			capture.restore();
			await chr.destroy();
		}
	}, 300_000);
});
