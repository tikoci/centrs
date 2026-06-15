/**
 * SFTP transfer client over the **host OpenSSH** `sftp` binary.
 *
 * Why shell out instead of an in-process SSH library: the host `sftp` (OpenSSH)
 * already inherits `~/.ssh/config`, the ssh-agent, `known_hosts`, and the full
 * algorithm negotiation RouterOS needs (rsa-sha2-256/512, ed25519,
 * `strong-crypto`) — for free, with zero new dependencies. RouterOS's SSH server
 * has **no pseudo-tty** (and a single-line `ssh host "cmd"` exec — used by
 * `execute / ssh` — is not a file channel), so the reliable SSH file path is the
 * **SFTP subsystem**; this client speaks exactly that. See
 * `commands/transfer/README.md` (SFTP vs SCP) and `commands/terminal/README.md`
 * (RouterOS SSH surface).
 *
 * Each high-level method runs one `sftp -b -` batch invocation (commands fed on
 * stdin) so errors attribute cleanly to the operation. The runner is injectable
 * so unit tests pin behavior without spawning a real `sftp`. **Backup plan:** if
 * the batch I/O / `ls -l` parsing proves brittle on a real device, the swap to
 * the `ssh2` npm library happens *behind this same interface* — nothing above
 * `SftpClient` changes.
 *
 * Grounding note: the OpenSSH `ls -l` long-name format is server-influenced, so
 * the size column is parsed **best-effort** (existence + name + type are the
 * load-bearing signals; SFTP `put`/`get` carry any size in one call and do not
 * need it). The exact RouterOS long-name shape is pinned by a CHR integration
 * finding, not assumed.
 */

import { CentrsError } from "../errors.ts";
import { sshCommonOptions, sshUserHost } from "./ssh.ts";

/** A directory entry as parsed from an `sftp` `ls -l` long-name line. */
export interface SftpFileEntry {
	name: string;
	type: "file" | "directory" | "other";
	/** Best-effort byte size from the long-name listing; may be `undefined`. */
	size?: number;
}

/** Raw result of one `sftp -b -` batch run. */
export interface SftpBatchResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Injectable batch runner (the default spawns the host `sftp`). */
export type SftpBatchRunner = (
	argv: readonly string[],
	batch: string,
	timeoutMs: number,
) => Promise<SftpBatchResult>;

export interface SftpClientConfig {
	host: string;
	port: number;
	username?: string;
	/** Private-key path (`-i`); when unset, the agent / `~/.ssh/config` is used. */
	sshKey?: string;
	/**
	 * Opt out of strict host-key checking. Default (false) is `accept-new`
	 * (trust-on-first-use into the user's `known_hosts`); `true` disables checking
	 * and uses an ephemeral hosts file.
	 */
	insecure?: boolean;
	/** Per-operation timeout (also the connect timeout, in whole seconds). */
	timeoutMs: number;
	/** Override the `known_hosts` file (tests / ephemeral runs). */
	knownHostsFile?: string;
	/** Override the `sftp` binary path (tests). */
	binary?: string;
	/** Injected batch runner (tests); defaults to {@link spawnSftpBatch}. */
	runner?: SftpBatchRunner;
}

export class SftpClient {
	private readonly run: SftpBatchRunner;

	constructor(private readonly config: SftpClientConfig) {
		this.run = config.runner ?? spawnSftpBatch;
	}

	/** Existence + best-effort size for one remote path; `undefined` if absent. */
	async stat(remote: string): Promise<SftpFileEntry | undefined> {
		const base = basename(remote);
		// `-ls` ignores the per-command error so a missing path does not abort the
		// batch with a non-zero exit (which we could not tell from auth failures).
		const result = await this.batch([`-ls -l ${quote(remote)}`]);
		this.throwIfConnectFailed(result, "stat");
		for (const entry of parseLsOutput(result.stdout)) {
			if (entry.name === base || entry.name === remote) {
				return { ...entry, name: remote };
			}
		}
		return undefined;
	}

	/** List a remote directory. */
	async readdir(remote: string): Promise<SftpFileEntry[]> {
		const target = remote.length > 0 ? remote : ".";
		const result = await this.batch([`-ls -l ${quote(target)}`]);
		this.throwIfConnectFailed(result, "readdir");
		return parseLsOutput(result.stdout).filter(
			(entry) => entry.name !== "." && entry.name !== "..",
		);
	}

	/** Upload a local file to a remote path (SFTP `put`). */
	async put(localPath: string, remote: string): Promise<void> {
		const result = await this.batch([
			`put ${quote(localPath)} ${quote(remote)}`,
		]);
		this.throwIfFailed(result, "put", remote);
	}

	/** Download a remote path to a local file (SFTP `get`). */
	async get(remote: string, localPath: string): Promise<void> {
		const result = await this.batch([
			`get ${quote(remote)} ${quote(localPath)}`,
		]);
		this.throwIfFailed(result, "get", remote);
	}

	/** Create a remote directory. */
	async mkdir(remote: string): Promise<void> {
		const result = await this.batch([`mkdir ${quote(remote)}`]);
		this.throwIfFailed(result, "mkdir", remote);
	}

	/** Remove a remote file. */
	async remove(remote: string): Promise<void> {
		const result = await this.batch([`rm ${quote(remote)}`]);
		this.throwIfFailed(result, "remove", remote);
	}

	/** Rename / move a remote path. */
	async rename(from: string, to: string): Promise<void> {
		const result = await this.batch([`rename ${quote(from)} ${quote(to)}`]);
		this.throwIfFailed(result, "rename", from);
	}

	private batch(commands: readonly string[]): Promise<SftpBatchResult> {
		return this.run(
			this.argv(),
			`${commands.join("\n")}\n`,
			this.config.timeoutMs,
		);
	}

	/** Build the `sftp` argv (one place so tests can assert it). */
	argv(): string[] {
		// `sftp` takes the port as `-P` (vs `ssh -p`); the `-i`/`-o` trust + batch
		// options are shared with the ssh execute client via `sshCommonOptions`.
		return [
			this.config.binary ?? "sftp",
			"-b",
			"-",
			"-P",
			String(this.config.port),
			...sshCommonOptions(this.config),
			sshUserHost(this.config),
		];
	}

	/** Connect/auth/host-key failures happen before the batch runs. */
	private throwIfConnectFailed(result: SftpBatchResult, op: string): void {
		if (result.exitCode !== 0) {
			throw this.mapError(result, op);
		}
	}

	private throwIfFailed(
		result: SftpBatchResult,
		op: string,
		remote: string,
	): void {
		if (result.exitCode !== 0) {
			throw this.mapError(result, op, remote);
		}
	}

	private mapError(
		result: SftpBatchResult,
		op: string,
		remote?: string,
	): CentrsError {
		const { host, port } = this.config;
		const stderr = result.stderr.trim();
		const lower = stderr.toLowerCase();
		const context = {
			via: "ssh",
			host,
			port,
			op,
			...(remote ? { remote } : {}),
		};

		if (lower.includes("host key verification failed")) {
			return new CentrsError({
				code: "transport/host-key-mismatch",
				summary: `The SSH host key for ${host} did not match a known key.`,
				remediation:
					"The device's host key changed (or is impersonated). Remove the stale `known_hosts` entry after verifying the device, or pass `--insecure` to skip the check.",
				context,
				causeData: stderr,
			});
		}
		if (
			lower.includes("permission denied") ||
			lower.includes("authentication failed") ||
			lower.includes("no such identity") ||
			lower.includes("too many authentication failures")
		) {
			return new CentrsError({
				code: "auth/failed",
				summary: `SSH authentication to ${host} failed.`,
				remediation:
					"Provide a key the device trusts via `--ssh-key` / the ssh-agent, and confirm the RouterOS user has `ftp`/`ssh` policy. RouterOS refuses password login once an SSH key is set for the user.",
				context,
				causeData: stderr,
			});
		}
		if (lower.includes("connection refused")) {
			return new CentrsError({
				code: "transport/connection-refused",
				summary: `SSH connection to ${host}:${port} was refused.`,
				remediation:
					"Enable the RouterOS SSH service (`/ip service enable ssh`) and confirm the port / firewall.",
				context,
				causeData: stderr,
			});
		}
		if (
			lower.includes("timed out") ||
			lower.includes("operation timed out") ||
			lower.includes("connection timed out")
		) {
			return new CentrsError({
				code: "transport/timeout",
				summary: `SSH connection to ${host}:${port} timed out.`,
				remediation:
					"Raise `--timeout`, or confirm the host and port are reachable.",
				context,
				causeData: stderr,
			});
		}
		if (
			lower.includes("could not resolve") ||
			lower.includes("name or service not known") ||
			lower.includes("nodename nor servname")
		) {
			return new CentrsError({
				code: "transport/dns",
				summary: `Could not resolve ${host} for SSH.`,
				remediation:
					"Check the host spelling / DNS, or pass a literal address with `--host`.",
				context,
				causeData: stderr,
			});
		}
		if (lower.includes("no such file") || lower.includes("not found")) {
			return new CentrsError({
				code: "routeros/command-failed",
				summary: `SFTP ${op} failed: ${remote ?? "path"} not found on ${host}.`,
				remediation:
					"Check the remote path (RouterOS file names have no leading slash); `transfer list` shows what is present.",
				context,
				causeData: stderr,
			});
		}
		return new CentrsError({
			code: "transport/network",
			summary: `SFTP ${op} failed against ${host}:${port} (exit ${result.exitCode}).`,
			remediation:
				"Re-run with `--format json` for the structured cause, and confirm SSH/SFTP access to the device.",
			context,
			causeData: stderr || `exit ${result.exitCode}`,
		});
	}
}

/**
 * Parse `sftp` `ls -l` output into entries. Tolerant of column variation: a
 * strict OpenSSH long-name shape is tried first, then a loose fallback (perms +
 * trailing name + largest integer as size). Lines that are not listings (the
 * `sftp>` echo, blank lines) are skipped.
 */
export function parseLsOutput(stdout: string): SftpFileEntry[] {
	const entries: SftpFileEntry[] = [];
	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const entry = parseLsLine(line);
		if (entry) {
			entries.push(entry);
		}
	}
	return entries;
}

const STRICT_LS =
	/^([-dlbcps])([-rwxsStT]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/;

function parseLsLine(line: string): SftpFileEntry | undefined {
	const trimmed = line.trimEnd();
	if (trimmed.trim().length === 0) {
		return undefined;
	}
	// Skip the interactive echo lines some sftp builds emit in batch mode.
	if (trimmed.startsWith("sftp>") || trimmed.startsWith("Connected to")) {
		return undefined;
	}
	const strict = STRICT_LS.exec(trimmed);
	if (strict) {
		const typeChar = strict[1] as string;
		const size = Number.parseInt(strict[3] as string, 10);
		return {
			name: basename((strict[4] as string).trim()),
			type: typeFromPermChar(typeChar),
			...(Number.isNaN(size) ? {} : { size }),
		};
	}
	// Loose fallback: only treat lines that *look* like a long listing (start
	// with a permission/type character followed by rwx flags). Name + type only —
	// no size guess, because the size column position is server-format-dependent
	// and a bad guess (e.g. grabbing a year out of the date) is worse than none.
	if (!/^[-dlbcps][-rwxsStT]{9}\s/.test(trimmed)) {
		return undefined;
	}
	const tokens = trimmed.split(/\s+/);
	const name = tokens[tokens.length - 1];
	if (!name) {
		return undefined;
	}
	return {
		name: basename(name),
		type: typeFromPermChar(trimmed[0] as string),
	};
}

function typeFromPermChar(char: string): SftpFileEntry["type"] {
	if (char === "d") {
		return "directory";
	}
	if (char === "-") {
		return "file";
	}
	return "other";
}

/**
 * Quote a path for an `sftp` batch command line. RouterOS file names never carry
 * a double-quote or newline; rejecting them keeps the batch un-injectable.
 */
export function quote(path: string): string {
	if (/["\n\r]/.test(path)) {
		throw new CentrsError({
			code: "input/invalid-path",
			summary: `Path contains a character SFTP cannot quote: ${path}`,
			remediation:
				"Remove embedded quotes / newlines from the path; RouterOS file names do not use them.",
			context: { path },
		});
	}
	return `"${path}"`;
}

function basename(path: string): string {
	const parts = path.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? path;
}

/**
 * Default runner: spawn the host `sftp`, feed the batch on stdin, and capture
 * stdout/stderr with a hard kill timeout. No shell — argv is passed directly, so
 * hostnames / paths from the CDB cannot inject commands.
 */
function startSftp(argv: readonly string[]) {
	try {
		return Bun.spawn(argv as string[], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (cause) {
		// `sftp` not on PATH (ENOENT) — Bun.spawn throws synchronously. Without this
		// the failure surfaces as `internal/unhandled` (or a raw stack) instead of an
		// actionable transport error.
		throw new CentrsError({
			code: "transport/local-tool-missing",
			summary: `Cannot launch the host \`${argv[0]}\` client for the SFTP transfer.`,
			remediation:
				"Install an OpenSSH client so `sftp` is on PATH (macOS ships it; Debian/Ubuntu: `openssh-client`), or use `--via rest` / `--via native` for files ≤60 KB.",
			context: { binary: argv[0] },
			cause,
		});
	}
}

async function spawnSftpBatch(
	argv: readonly string[],
	batch: string,
	timeoutMs: number,
): Promise<SftpBatchResult> {
	const proc = startSftp(argv);
	proc.stdin.write(batch);
	await proc.stdin.end();

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);

	try {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		return {
			exitCode,
			stdout,
			stderr: timedOut ? `${stderr}\nConnection timed out`.trim() : stderr,
		};
	} finally {
		clearTimeout(timer);
	}
}
