/**
 * Subprocess harness for the centrs CLI.
 *
 * The in-process integration path (`runCli` + a `console.log`/`console.error`
 * swap) cannot reach the three things real stdio behaviour depends on: bytes
 * piped to **stdin** (`transfer upload -`, which reads fd 0), raw bytes written
 * to **stdout** (`transfer download -`, which calls `process.stdout.write`), and
 * the **current directory** (a `download` with no local path writes the remote
 * basename into cwd). Those are exactly the transfer examples (8–10) that were
 * deferred against "a subprocess-capture harness". This module is that harness:
 * it spawns the real `src/cli.ts` entry as a child process and hands a test the
 * child's exit code plus its stdout/stderr as raw bytes, with controllable stdin
 * and cwd.
 *
 * It is deliberately the *general* CLI-as-subprocess seam, not a transfer-only
 * helper: the next consumer is the interactive `terminal` relay, whose test needs
 * a child driven over a real PTY (raw-mode stdin, reported rows/cols, SIGWINCH) —
 * something an in-process harness fundamentally cannot provide. When that lands,
 * add a `runCliPty()` sibling here (a pseudo-terminal spawn with scripted
 * keystrokes + expect-style output matching); `runCliProcess` below is the
 * pipe-based form that covers non-interactive stdio.
 */

import { join } from "node:path";

/** Absolute path to the CLI entry, resolved relative to this test module. */
const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "cli.ts");

export interface CliProcessOptions {
	/** Argv passed after the entry (e.g. `["transfer", url, "download", "-"]`). */
	args: readonly string[];
	/** Bytes piped to the child's stdin; omit for no stdin (`transfer upload -`). */
	stdin?: Buffer | string;
	/** Working directory for the child (a default-local `download` writes here). */
	cwd?: string;
	/** Extra env layered on top of the parent's `process.env`. */
	env?: Record<string, string>;
}

export interface CliProcessResult {
	exitCode: number;
	/** Raw stdout bytes — the payload channel for `download -`. */
	stdout: Buffer;
	/** Raw stderr bytes — where the human/JSON summary goes for `download -`. */
	stderr: Buffer;
	/** stdout decoded as UTF-8, for JSON/text envelope assertions. */
	stdoutText: string;
	/** stderr decoded as UTF-8. */
	stderrText: string;
}

/**
 * Run the real centrs CLI as a child process and collect its stdio. Unlike the
 * in-process `runCli` capture, this exercises the actual `readFileSync(0)` stdin
 * read, the `process.stdout.write` payload path, and cwd-relative output.
 */
export async function runCliProcess(
	options: CliProcessOptions,
): Promise<CliProcessResult> {
	const stdin =
		options.stdin === undefined
			? "ignore"
			: typeof options.stdin === "string"
				? Buffer.from(options.stdin)
				: options.stdin;

	const proc = Bun.spawn(["bun", CLI_ENTRY, ...options.args], {
		stdin,
		stdout: "pipe",
		stderr: "pipe",
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).arrayBuffer(),
		proc.exited,
	]);

	const stdoutBuf = Buffer.from(stdout);
	const stderrBuf = Buffer.from(stderr);
	return {
		exitCode,
		stdout: stdoutBuf,
		stderr: stderrBuf,
		stdoutText: stdoutBuf.toString("utf8"),
		stderrText: stderrBuf.toString("utf8"),
	};
}
