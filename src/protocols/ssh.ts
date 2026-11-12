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

import { mapRouterOsResultError } from "../core/routeros-errors.ts";
import { CentrsError } from "../errors.ts";
import {
	countExecutableStatements,
	maskComments,
	scanQuotedString,
} from "../explain/segment.ts";
import { formatEndpoint } from "./endpoint.ts";

export interface SshConnectionConfig {
	host: string;
	port: number;
	username?: string;
	/** Private-key path (`-i`); when unset, the agent / `~/.ssh/config` is used. */
	sshKey?: string;
	/**
	 * Opt out of strict host-key checking. Default (false) is `accept-new`
	 * (trust-on-first-use into the user's `known_hosts`); `true` disables checking
	 * entirely (`StrictHostKeyChecking=no` + a null `known_hosts` sink —
	 * `/dev/null`, or `NUL` on Windows), so a *changed* / impersonated host key is
	 * accepted too.
	 */
	insecure?: boolean;
	/** Per-operation timeout (also the connect timeout, in whole seconds). */
	timeoutMs: number;
	/** Override the `known_hosts` file (tests / ephemeral runs). */
	knownHostsFile?: string;
	/**
	 * Interactive session (the `terminal` relay): **omit** `BatchMode=yes` so the
	 * host `ssh` may prompt on the inherited TTY for a key passphrase or a
	 * password. The batch clients (`sftp`, `execute`) leave this unset, keeping
	 * `BatchMode=yes` so a missing credential fails fast instead of hanging on a
	 * prompt no one can answer.
	 */
	interactive?: boolean;
}

/**
 * The `-i` / `-o` options common to the host `ssh` and `sftp` clients (the port
 * flag differs — `ssh -p` vs `sftp -P` — so it stays with each caller). Keeping
 * one builder means the key, batch-mode, connect-timeout, and host-key trust are
 * identical across every SSH transport.
 */
export function sshCommonOptions(config: SshConnectionConfig): string[] {
	// Check the raw fields before any destination formatting (including SFTP's
	// IPv6 brackets), regardless of which resolver supplied them.
	for (const field of ["host", "username"] as const) {
		if (config[field]?.startsWith("-")) {
			throw new CentrsError({
				code: "input/invalid-target",
				summary: `The SSH ${field} must not start with a hyphen.`,
				remediation:
					"Provide a host and username that do not start with `-`; correct the selected CLI, environment, CDB or provider value.",
				context: { field },
			});
		}
	}
	const connectSeconds = Math.max(1, Math.ceil(config.timeoutMs / 1000));
	const options: string[] = [];
	if (config.sshKey) {
		// Exclude unrelated agent keys; explicit IdentityFile config still applies.
		options.push("-i", config.sshKey, "-o", "IdentitiesOnly=yes");
	}
	// Batch clients (sftp/execute) keep BatchMode so a missing/encrypted credential
	// errors out rather than blocking on a prompt; the interactive terminal relay
	// (`config.interactive`) omits it so ssh can prompt on the TTY for a passphrase
	// or password.
	if (!config.interactive) {
		options.push("-o", "BatchMode=yes");
	}
	options.push("-o", `ConnectTimeout=${connectSeconds}`);
	if (config.insecure) {
		options.push("-o", "StrictHostKeyChecking=no");
		// Null `known_hosts` sink: `/dev/null` on POSIX, `NUL` on Windows OpenSSH.
		const nullSink = process.platform === "win32" ? "NUL" : "/dev/null";
		options.push("-o", `UserKnownHostsFile=${nullSink}`);
	} else {
		// Trust-on-first-use: accept a new host key, refuse a *changed* one.
		options.push("-o", "StrictHostKeyChecking=accept-new");
		if (config.knownHostsFile) {
			options.push("-o", `UserKnownHostsFile=${config.knownHostsFile}`);
		}
	}
	return options;
}

/**
 * OpenSSH's own pre-login refusals. A bare `Permission denied` is not one: sftp
 * prints it after login when RouterOS refuses an operation (`dest open "/x":
 * Permission denied` — CHR 7.24.5, a user without `write` policy), and that is
 * a policy refusal, not an authentication failure (#391).
 */
export function isSshAuthFailure(lowerStderr: string): boolean {
	return (
		/permission denied \(/.test(lowerStderr) ||
		lowerStderr.includes("authentication failed") ||
		lowerStderr.includes("no such identity") ||
		lowerStderr.includes("too many authentication failures")
	);
}

/**
 * Remediation for an `auth/failed` from a batch (`BatchMode=yes`) client —
 * `execute --via ssh` and sftp `transfer`. A batch client never sends a
 * password, so it names the key source it used and leaves RouterOS's password
 * policy as a separate fact rather than a guessed cause. A user without `ssh`
 * policy is refused at login (`Permission denied (publickey)`); CHR controls in
 * `test/integration/ssh-auth-policy.test.ts` (#391).
 */
export function batchSshAuthRemediation(sshKeySelected: boolean): string {
	const keys = sshKeySelected
		? "the selected SSH key (plus any `IdentityFile` in the host OpenSSH configuration)"
		: "keys from the host OpenSSH configuration or agent";
	return `Batch SSH never sends a password; it authenticates with ${keys}. Install the matching public key for the user on the device (\`/user/ssh-keys import\`; \`/user/ssh-keys print\` lists the user's keys) and confirm the user's group has the \`ssh\` policy. Password login is separate: on RouterOS 7.21+, \`/ip/ssh password-authentication\` (default \`yes-if-no-key\`) refuses it for a user who has a key.`;
}

/** `[user@]host` for the ssh/sftp command line. */
export function sshUserHost(config: SshConnectionConfig): string {
	return `${config.username ? `${config.username}@` : ""}${config.host}`;
}

/**
 * Map a host-`ssh` connect/auth failure (non-zero exit) to a CentrsError. Mirrors
 * the connect-level cases in {@link ./sftp.ts}'s `mapError` — both clients face
 * the same OpenSSH stderr. RouterOS *command* failures do not land here: an
 * error the channel reports with exit 0 is classified from stdout by the execute
 * orchestrator's `routerOsFailureFromResult`, and a nonzero remote exit (not
 * 255) is `SshExecClient`'s `remoteExitError` (#576).
 */
export function mapSshConnectError(
	stderr: string,
	exitCode: number,
	ctx: { host: string; port: number; op: string; sshKeySelected?: boolean },
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
	if (isSshAuthFailure(lower)) {
		const sshKeySelected = ctx.sshKeySelected ?? false;
		return new CentrsError({
			code: "auth/failed",
			summary: `SSH authentication to ${host} failed.`,
			remediation: batchSshAuthRemediation(sshKeySelected),
			context: { ...context, sshKeySelected },
			causeData: trimmed,
		});
	}
	if (lower.includes("connection refused")) {
		return new CentrsError({
			code: "transport/connection-refused",
			summary: `SSH connection to ${formatEndpoint(host, port)} was refused.`,
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
			summary: `SSH connection to ${formatEndpoint(host, port)} timed out.`,
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
		summary: `SSH ${op} failed against ${formatEndpoint(host, port)} (exit ${exitCode}).`,
		remediation:
			"Re-run with `--format json` for the structured cause, and confirm SSH access (`/ip service`) to the device.",
		context,
		causeData: trimmed || `exit ${exitCode}`,
	});
}

/**
 * Encode a script for one `ssh host "<command>"` exec. Over SSH exec, RouterOS
 * ends the prompt at every LF (and CRLF): each line runs on its own, so menu
 * context, `:local` values and `{ }` blocks do not carry across lines. A CR is
 * a line break *inside* the prompt, like Enter inside a console block: the
 * script runs as one unit, and an error stops the rest with a nonzero exit.
 * Measured on CHR 7.25.1 and 7.24.6 (#576). So line breaks outside quoted
 * strings are sent as CR, which runs the script the way `:parse` validated it
 * and the way REST and native-API `/execute` run it.
 *
 * A raw line break inside a quoted string cannot be sent faithfully (an LF
 * ends the prompt mid-string; a CR would change the string's bytes), so it is
 * refused before anything is sent. Comments and strings are found with the
 * same scanners `explain` uses (`maskComments`, `scanQuotedString`), so a
 * quote inside a comment, including one after `;` or `{`, opens no string.
 * Line breaks are read from the original text, not the mask: the mask blanks
 * the CR of a CRLF that ends a comment, and a continued statement can cross
 * that comment (`:put \` CRLF `# note` CRLF `"after"`).
 */
export function encodeSshScript(command: string): string {
	const trimmed = command.replace(/[\r\n]+$/, "");
	// Comments are blanked at the same offsets, so their quotes are not scanned.
	// A lone CR is a line break over SSH (it is what this encoder sends), but
	// the mask ends a comment only at LF, so a comment would swallow the next
	// line: mask a copy with lone CRs as LF (same length, same offsets).
	const masked = maskComments(trimmed.replace(/\r(?!\n)/g, "\n"));
	let out = "";
	for (let i = 0; i < trimmed.length; i++) {
		const ch = masked[i];
		if (ch === '"') {
			const { end } = scanQuotedString(masked, i);
			const literal = trimmed.slice(i, end);
			if (/[\r\n]/.test(literal)) {
				throw new CentrsError({
					code: "transport/capability-unsupported",
					summary:
						"A quoted string in this script contains a raw line break, which cannot be sent over SSH.",
					remediation:
						"Write the line break as an escape inside the string (`\\n`), or run the script with `--via rest-api` or `--via native-api`.",
					context: { via: "ssh", operation: "multi-line string" },
				});
			}
			out += literal;
			i = end - 1;
			continue;
		}
		const raw = trimmed[i];
		if (raw === "\r" || raw === "\n") {
			if (raw === "\r" && trimmed[i + 1] === "\n") i++;
			out += "\r";
			continue;
		}
		out += raw;
	}
	return out;
}

/** `10s`, `1.5s`, or `250ms` for a budget in milliseconds. */
function formatBudget(timeoutMs: number): string {
	return timeoutMs >= 1000 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
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
	/** The runner killed `ssh` because the budget ran out (#592). */
	timedOut?: boolean;
}

/**
 * OpenSSH exits 255 for its own failures (connect, auth, host key) and
 * otherwise passes the remote command's exit status through.
 */
const SSH_CLIENT_ERROR_EXIT = 255;

/**
 * `LogLevel=VERBOSE` makes OpenSSH log `Authenticated to <host> ([<addr>]:<port>)
 * using "<method>".` once login completes (OpenSSH 10.6 against CHR 7.25.1 and
 * 7.24.6). Each `exec` is a fresh `ssh` process and login, so this line is the
 * evidence that *this* invocation reached RouterOS; an earlier invocation's
 * success says nothing about the next handshake. `ControlPath=none` keeps it
 * a fresh login: a multiplexed `ssh` logs nothing. The level also adds the
 * `Transferred:` / `Bytes per second:` exit summary; both are progress lines
 * and are dropped before stderr is read for a failure.
 */
const SSH_VERBOSE_PROGRESS =
	/^(?:Authenticated to |Transferred: |Bytes per second: )/;

/** stderr without OpenSSH's verbose progress lines, and whether login completed. */
export function readExecStderr(stderr: string): {
	authenticated: boolean;
	stderr: string;
} {
	const lines = stderr.split(/\r?\n/);
	return {
		authenticated: lines.some((line) => line.startsWith("Authenticated to ")),
		stderr: lines.filter((line) => !SSH_VERBOSE_PROGRESS.test(line)).join("\n"),
	};
}

/** Injectable runner (the default spawns the host `ssh`); tests pin behavior. */
export type SshExecRunner = (
	argv: readonly string[],
	timeoutMs: number,
) => Promise<SshExecResult>;

/** Options for one {@link SshExecClient.exec}. */
export interface SshExecOptions {
	/**
	 * Passed only for the requested command, never for a check before it.
	 * Fires once this invocation shows it reached RouterOS (a logged login,
	 * output, or a remote exit status), and never for a connect or login
	 * failure: the adapter's `ProtocolSendOptions.onSent` contract (#448).
	 */
	onSent?: () => void;
}

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
			// Login evidence for this invocation (see SSH_VERBOSE_PROGRESS).
			"-o",
			"LogLevel=VERBOSE",
			// No connection reuse: a command sent over a `ControlMaster`
			// connection from the user's config skips login and logs nothing,
			// so a silent cut-off command would read as never sent (CHR 7.25.1).
			// A command-line option overrides the config file.
			"-o",
			"ControlPath=none",
			"--",
			sshUserHost(this.config),
			command,
		];
	}

	/**
	 * Run one command; returns cleaned stdout. Throws on a connect/auth failure,
	 * on a timeout (keeping any output captured before it, #592), and when
	 * RouterOS ends the command with a nonzero exit (#576).
	 */
	async exec(command: string, options: SshExecOptions = {}): Promise<string> {
		const ran = await this.run(this.argv(command), this.config.timeoutMs);
		const { authenticated, stderr } = readExecStderr(ran.stderr);
		const result = { ...ran, stderr };
		// Evidence from this invocation that it reached RouterOS: OpenSSH
		// logged the login, RouterOS printed something, or it exited 0.
		const reached =
			authenticated ||
			result.stdout.trim() !== "" ||
			(!result.timedOut && result.exitCode === 0);
		if (reached) options.onSent?.();
		const connect = (): CentrsError =>
			mapSshConnectError(result.stderr, result.exitCode, {
				host: this.config.host,
				port: this.config.port,
				op: "execute",
				sshKeySelected: Boolean(this.config.sshKey),
			});
		if (result.timedOut) {
			if (reached) {
				// Only the requested command (the call that tracks dispatch) may
				// still be running; a check before it was all that ran.
				throw options.onSent
					? this.timeoutError(result)
					: this.checkTimeoutError(result);
			}
			// No sign the session reached RouterOS. OpenSSH's own connect
			// failure, when it printed one first, names the cause.
			const early = connect();
			throw early.code === "transport/network"
				? this.noAnswerTimeoutError(result)
				: early;
		}
		if (result.exitCode !== 0) {
			const failure = connect();
			// stderr evidence of a connect/auth problem wins; otherwise a non-255
			// exit is the remote command's own status.
			if (
				failure.code !== "transport/network" ||
				result.exitCode === SSH_CLIENT_ERROR_EXIT
			) {
				throw failure;
			}
			// A remote exit status is RouterOS's answer, so the command ran.
			if (!reached) options.onSent?.();
			throw this.remoteExitError(command, result);
		}
		return cleanConsoleOutput(result.stdout);
	}

	/**
	 * A check before the requested command (the `:parse` gate, a version
	 * probe) logged in and then ran out of budget. Checks do not execute the
	 * command, and the command is sent only after they answer, so it was not
	 * sent.
	 */
	private checkTimeoutError(result: SshExecResult): CentrsError {
		const { host, port, timeoutMs } = this.config;
		return new CentrsError({
			code: "transport/timeout",
			summary: `SSH to ${formatEndpoint(host, port)} logged in, but the check before the command did not finish within ${formatBudget(timeoutMs)}; the command was not sent.`,
			remediation: `Raise \`--timeout\` (or \`CENTRS_TIMEOUT\`, it was ${formatBudget(timeoutMs)}); a loaded router can answer slowly. The check only parses the command, so nothing on the router changed.`,
			context: {
				via: "ssh",
				host,
				port,
				op: "execute",
				timeoutMs,
				sessionReached: true,
				commandSent: false,
			},
			causeData: result.stderr.trim() || "timed out",
		});
	}

	/**
	 * The budget ran out while the requested command ran: this invocation
	 * logged in to RouterOS, or printed output. So this is an execution
	 * timeout, and the command may still be running: on CHR 7.25.1 and 7.24.6 a
	 * script kept going after `ssh` was killed and finished its write about 10 s
	 * later (#592).
	 */
	private timeoutError(result: SshExecResult): CentrsError {
		const { host, port, timeoutMs } = this.config;
		const partial = cleanConsoleOutput(result.stdout);
		return new CentrsError({
			code: "transport/timeout",
			summary: `SSH execute on ${formatEndpoint(host, port)} did not finish within ${formatBudget(timeoutMs)}; the command may still be running on the router.`,
			remediation: `Raise \`--timeout\` (or \`CENTRS_TIMEOUT\`) above the command's run time; it was ${formatBudget(timeoutMs)}. Disconnecting does not stop a running RouterOS script, so check its effect (for example \`/system/script/job\`) before running it again.${partial ? " The output printed before the cutoff is in `context.partialOutput`; it is incomplete." : ""}`,
			context: {
				via: "ssh",
				host,
				port,
				op: "execute",
				timeoutMs,
				sessionReached: true,
				...(partial ? { partialOutput: partial, outputComplete: false } : {}),
			},
			causeData: result.stderr.trim() || "timed out",
		});
	}

	/**
	 * The budget ran out with no sign that this invocation reached RouterOS:
	 * OpenSSH logged no completed login and nothing was printed. The stall is
	 * in connect or login (an unreachable host, a router restart or connection
	 * limit between the `:parse` check and the command), so the command was
	 * most likely not sent.
	 */
	private noAnswerTimeoutError(result: SshExecResult): CentrsError {
		const { host, port, timeoutMs } = this.config;
		return new CentrsError({
			code: "transport/timeout",
			summary: `SSH to ${formatEndpoint(host, port)} got no answer within ${formatBudget(timeoutMs)}; the connection or login may not have completed.`,
			remediation: `Confirm the host and port are reachable and the RouterOS SSH service is enabled (\`/ip service\`); raise \`--timeout\` (or \`CENTRS_TIMEOUT\`, it was ${formatBudget(timeoutMs)}) for a slow link. OpenSSH reported no completed login for this attempt, so the command was most likely not sent; for a write, check its effect before running it again.`,
			context: {
				via: "ssh",
				host,
				port,
				op: "execute",
				timeoutMs,
				sessionReached: false,
			},
			causeData: result.stderr.trim() || "timed out",
		});
	}

	/**
	 * RouterOS ran the command and ended it with a nonzero exit. Its diagnostic
	 * is on stdout (CHR 7.25.1 / 7.24.6: `bad command name print (line 1
	 * column 1)`); a recognized one keeps its specific `routeros/*` code.
	 */
	private remoteExitError(command: string, result: SshExecResult): CentrsError {
		const { host, port } = this.config;
		const output = cleanConsoleOutput(result.stdout);
		const stderr = result.stderr.trim();
		// Statements, not physical lines: `/file/add …; :error boom` on one line
		// also leaves the first statement applied, and a loop's one statement
		// can apply on an earlier iteration than the one that fails. The
		// command arrives CR-encoded (`encodeSshScript`, no raw break left
		// inside a string), so CR is a line break here.
		const multiStatement =
			countExecutableStatements(command.replace(/\r\n?/g, "\n"), {
				loopsRepeat: true,
			}) > 1;
		const context = {
			via: "ssh",
			host,
			port,
			op: "execute",
			exitCode: result.exitCode,
			...(output ? { output } : {}),
			...(stderr ? { stderr } : {}),
			// RouterOS stops at the failing statement; the ones before it ran (#576).
			...(multiStatement ? { partialRunPossible: true } : {}),
		};
		const recognized = output ? diagnosticError(output, context) : undefined;
		if (recognized) {
			return recognized;
		}
		const lineNote = multiStatement
			? " RouterOS stops a script at the failing statement, so the statements (and loop iterations) before it have already run; check their effect before running the script again."
			: "";
		return new CentrsError({
			code: "routeros/command-failed",
			summary: output
				? `RouterOS ended the SSH command with exit ${result.exitCode}: ${output.split("\n")[0]}`
				: `RouterOS ended the SSH command with exit ${result.exitCode} and printed no diagnostic.`,
			remediation: `The command reached the router and RouterOS refused it; its output is in \`context.output\`.${lineNote}`,
			context,
			causeData: output || stderr || `exit ${result.exitCode}`,
		});
	}
}

/**
 * The RouterOS diagnostic in the output of a command that exited nonzero.
 * RouterOS prints it last, after whatever the statements before the failure
 * printed (`:put before` then `bad command name …`), so when the whole output
 * is not a diagnostic, its last line is tried. The full output stays in
 * `context.output`.
 */
function diagnosticError(
	output: string,
	context: Record<string, unknown>,
): CentrsError | undefined {
	const opts = { transport: "ssh" as const, context };
	const whole = mapRouterOsResultError(output, opts);
	if (whole) return whole;
	const lines = output.split("\n");
	if (lines.length < 2) return undefined;
	return mapRouterOsResultError(lines[lines.length - 1] ?? "", opts);
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
			stderr,
			timedOut,
		};
	} finally {
		clearTimeout(timer);
	}
}
