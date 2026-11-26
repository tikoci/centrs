/**
 * #666 / PR #674 review: SIGINT through the `.env` re-launch.
 *
 * Network-free, so it runs in the fast `bun test` gate like the CLI smoke
 * tier. A `.env` in the cwd makes the entry re-launch under
 * `bun --no-env-file`. A SIGINT sent to the launcher's PID must reach the
 * child; one sent to the whole process group (a terminal's Ctrl-C) must reach
 * it exactly once, since centrs treats a second Ctrl-C as "exit now". POSIX
 * only: Windows has no process groups or SIGINT delivery by `kill`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(
	import.meta.dir,
	"..",
	"..",
	"src",
	"resolver",
	"dotenv-guard.ts",
);

const FIXTURE = `
import { runWithoutDotenv } from ${JSON.stringify(GUARD)};
process.exitCode = await runWithoutDotenv(async () => {
	if (process.argv[2] === "count") {
		let count = 0;
		process.on("SIGINT", () => { count += 1; });
		console.log("ready");
		await Bun.sleep(1500);
		console.log("sigint=" + count);
		return 0;
	}
	console.log("ready");
	await Bun.sleep(10_000);
	console.log("not interrupted");
	return 0;
});
`;

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

interface Run {
	child: ChildProcess;
	ready: Promise<void>;
	done: Promise<{ code: number | null; stdout: string }>;
}

async function launch(mode: "count" | "wait"): Promise<Run> {
	const dir = await mkdtemp(join(tmpdir(), "centrs-dotenv-signals-"));
	dirs.push(dir);
	await writeFile(join(dir, "fixture.ts"), FIXTURE);
	await writeFile(join(dir, ".env"), "CENTRS_DOTENV_SIGNAL_TEST=1\n");
	// detached: the launcher leads its own process group, as a shell job does.
	const child = spawn(process.execPath, [join(dir, "fixture.ts"), mode], {
		cwd: dir,
		detached: true,
		env: { PATH: process.env["PATH"] ?? "", HOME: dir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let markReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		markReady = resolve;
	});
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
		if (stdout.includes("ready")) markReady();
	});
	const done = new Promise<{ code: number | null; stdout: string }>(
		(resolve) => {
			child.on("exit", (code, signal) =>
				resolve({ code: signal === null ? code : -1, stdout }),
			);
		},
	);
	return { child, ready, done };
}

describe.skipIf(process.platform === "win32")(
	"SIGINT through the .env re-launch",
	() => {
		test("a SIGINT sent to the launcher's PID stops the child (130)", async () => {
			const run = await launch("wait");
			await run.ready;
			process.kill(run.child.pid as number, "SIGINT");
			const { code, stdout } = await run.done;
			expect(stdout).not.toContain("not interrupted");
			expect(code).toBe(130);
		}, 15_000);

		test("a PID SIGINT reaches a handling child once", async () => {
			const run = await launch("count");
			await run.ready;
			process.kill(run.child.pid as number, "SIGINT");
			const { code, stdout } = await run.done;
			expect(stdout).toContain("sigint=1");
			expect(code).toBe(0);
		}, 15_000);

		test("a process-group SIGINT (terminal Ctrl-C) reaches the child once", async () => {
			const run = await launch("count");
			await run.ready;
			process.kill(-(run.child.pid as number), "SIGINT");
			const { code, stdout } = await run.done;
			expect(stdout).toContain("sigint=1");
			expect(code).toBe(0);
		}, 15_000);
	},
);
