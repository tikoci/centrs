/**
 * Host-OpenSSH plumbing shared by the SSH transports, plus the **execute** client.
 *
 * Like {@link ./sftp.ts}, this shells out to the host `ssh`/`sftp` so it inherits
 * `~/.ssh/config`, the ssh-agent, `known_hosts`, and RouterOS's algorithm set for
 * free. RouterOS's SSH server grants **no pseudo-tty**, but a single-line
 * `ssh user@host "<command>"` *does* run on the console and return clean output —
 * no prompt, no ANSI, no echo (CHR 7.23.1 grounded). So `execute / ssh` is a
 * per-command batch client (one `ssh` invocation per command), not a persistent
 * screen-emulating reader; the only post-processing is trimming the console's
 * column padding. Validation reuses the mac-telnet `:put [:parse …]` gate verbatim
 * — over SSH it returns the same `(evl …)` / `bad parameter <name>` strings.
 *
 * See `commands/execute/README.md` (ssh) and `commands/terminal/README.md`.
 */

import { CentrsError } from "../errors.ts";

export interface SshConnectionConfig {
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
}

/**
 * The `-i` / `-o` options common to the host `ssh` and `sftp` clients (the port
 * flag differs — `ssh -p` vs `sftp -P` — so it stays with each caller). Keeping
 * one builder means the key, batch-mode, connect-timeout, and host-key trust are
 * identical across every SSH transport.
 */
export function sshCommonOptions(config: SshConnectionConfig): string[] {
	const connectSeconds = Math.max(1, Math.ceil(config.timeoutMs / 1000));
	const options: string[] = [];
	if (config.sshKey) {
		options.push("-i", config.sshKey);
	}
	options.push("-o", "BatchMode=yes");
	options.push("-o", `ConnectTimeout=${connectSeconds}`);
	if (config.insecure) {
		options.push("-o", "StrictHostKeyChecking=no");
		options.push("-o", "UserKnownHostsFile=/dev/null");
	} else {
		// Trust-on-first-use: accept a new host key, refuse a *changed* one.
		options.push("-o", "StrictHostKeyChecking=accept-new");
		if (config.knownHostsFile) {
			options.push("-o", `UserKnownHostsFile=${config.knownHostsFile}`);
		}
	}
	return options;
}

/** `[user@]host` for the ssh/sftp command line. */
export function sshUserHost(config: SshConnectionConfig): string {
	return `${config.username ? `${config.username}@` : ""}${config.host}`;
}

/**
 * Map a host-`ssh` connect/auth failure (non-zero exit) to a CentrsError. Mirrors
 * the connect-level cases in {@link ./sftp.ts}'s `mapError` — both clients face
 * the same OpenSSH stderr. RouterOS *command* failures do not land here: a valid
 * SSH channel exits 0 and surfaces RouterOS errors in stdout (the execute
 * orchestrator's `routerOsFailureFromResult` classifies those).
 */
export function mapSshConnectError(
	stderr: string,
	exitCode: number,
	ctx: { host: string; port: number; op: string },
): CentrsError {
	const { host, port, op } = ctx;
	const trimmed = stderr.trim();
	const lower = trimmed.toLowerCase();
	const context = { via: "ssh", host, port, op };

	if (lower.includes("host key verification failed")) {
		return new CentrsError({
			code: "transport/host-key-mismatch",
			summary: `The SSH host key for ${host} did not match a known key.`,
			remediation:
				"The device's host key changed (or is impersonated). Remove the stale `known_hosts` entry after verifying the device, or pass `--insecure` to skip the check.",
			context,
			causeData: trimmed,
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
				"Provide a key the device trusts via `--ssh-key` / the ssh-agent, and confirm the RouterOS user has `ssh` policy. RouterOS refuses password login once an SSH key is set for the user.",
			context,
			causeData: trimmed,
		});
	}
	if (lower.includes("connection refused")) {
		return new CentrsError({
			code: "transport/connection-refused",
			summary: `SSH connection to ${host}:${port} was refused.`,
			remediation:
				"Enable the RouterOS SSH service (`/ip service enable ssh`) and confirm the port / firewall.",
			context,
			causeData: trimmed,
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
			causeData: trimmed,
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
			causeData: trimmed,
		});
	}
	return new CentrsError({
		code: "transport/network",
		summary: `SSH ${op} failed against ${host}:${port} (exit ${exitCode}).`,
		remediation:
			"Re-run with `--format json` for the structured cause, and confirm SSH access (`/ip service`) to the device.",
		context,
		causeData: trimmed || `exit ${exitCode}`,
	});
}

/**
 * Normalize RouterOS console output captured over `ssh host "cmd"`: CRLF→LF, trim
 * each line's trailing column padding, and drop leading/trailing blank lines.
 * Leading indentation (RouterOS's `print` alignment) is preserved — it is content.
 */
export function cleanConsoleOutput(stdout: string): string {
	const lines = stdout
		.split(/\r\n|\r|\n/)
		.map((line) => line.replace(/\s+$/, ""));
	while (lines.length > 0 && lines[0] === "") {
		lines.shift();
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines.join("\n");
}

export interface SshExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Injectable runner (the default spawns the host `ssh`); tests pin behavior. */
export type SshExecRunner = (
	argv: readonly string[],
	timeoutMs: number,
) => Promise<SshExecResult>;

export interface SshExecClientConfig extends SshConnectionConfig {
	/** Override the `ssh` binary path (tests). */
	binary?: string;
	/** Injected runner (tests); defaults to {@link spawnSshExec}. */
	runner?: SshExecRunner;
}

/**
 * Run single-line RouterOS commands over `ssh user@host "<command>"`. One `ssh`
 * invocation per command (a fresh login each time, like `sftp`'s batch model);
 * RouterOS returns clean console output, so the only post-processing is
 * {@link cleanConsoleOutput}.
 */
export class SshExecClient {
	private readonly run: SshExecRunner;

	constructor(private readonly config: SshExecClientConfig) {
		this.run = config.runner ?? spawnSshExec;
	}

	/** Build the `ssh` argv for one command (one place so tests can assert it). */
	argv(command: string): string[] {
		return [
			this.config.binary ?? "ssh",
			"-p",
			String(this.config.port),
			...sshCommonOptions(this.config),
			sshUserHost(this.config),
			command,
		];
	}

	/** Run one command; returns cleaned stdout. Throws on connect/auth failure. */
	async exec(command: string): Promise<string> {
		const result = await this.run(this.argv(command), this.config.timeoutMs);
		if (result.exitCode !== 0) {
			throw mapSshConnectError(result.stderr, result.exitCode, {
				host: this.config.host,
				port: this.config.port,
				op: "execute",
			});
		}
		return cleanConsoleOutput(result.stdout);
	}
}

function startSsh(argv: readonly string[]) {
	try {
		return Bun.spawn(argv as string[], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (cause) {
		throw new CentrsError({
			code: "transport/local-tool-missing",
			summary: `Cannot launch the host \`${argv[0]}\` client for SSH execute.`,
			remediation:
				"Install an OpenSSH client so `ssh` is on PATH (macOS ships it; Debian/Ubuntu: `openssh-client`), or use `--via native-api` / `--via rest-api`.",
			context: { binary: argv[0] },
			cause,
		});
	}
}

/** Default runner: spawn the host `ssh` (no shell — argv is passed directly). */
async function spawnSshExec(
	argv: readonly string[],
	timeoutMs: number,
): Promise<SshExecResult> {
	const proc = startSsh(argv);
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
