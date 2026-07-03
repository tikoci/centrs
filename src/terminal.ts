/**
 * `terminal` — open an interactive RouterOS console (v1: mac-telnet only).
 *
 * Unlike `execute`, which runs one command and captures its output, `terminal`
 * is a **raw passthrough**: after the shared `MacTelnetConsole` logs in and primes
 * the prompt, input bytes are forwarded to the device and device output streams
 * straight back out. The connection (resolver → route → UDP transport → console)
 * is the exact path `execute / mac-telnet` proved; only the relay on top is new.
 *
 * Two input modes, chosen by whether stdin is a TTY (see {@link TerminalIo}):
 *   - interactive: raw-mode keystrokes, real terminal size, `SIGWINCH` resizes;
 *   - batch (piped stdin): forward bytes, then close on EOF after an output drain.
 *
 * The stream/exit contract: device bytes go to stdout, errors/summary to stderr,
 * exit 0 on a clean close. A pre-stream failure (no terminal capability, auth,
 * unresolved route) throws before any byte is emitted, so the CLI can render a
 * clean error envelope. See `commands/terminal/README.md` / `examples.md`.
 */

import { CentrsError, serializeCentrsError } from "./errors.ts";
import {
	createUdpMacTelnetTransport,
	isBroadcastHost,
	type MacTelnetTransport,
	parseMac,
	resolveMacTelnetRoute,
} from "./protocols/mac-telnet.ts";
import { MacTelnetConsole } from "./protocols/mac-telnet-console.ts";
import { sshCommonOptions, sshUserHost } from "./protocols/ssh.ts";
import {
	type CdbResolution,
	isIpTransport,
	isMacAddress,
	loadEnvFileDefaults,
	parseResolvePolicy,
	type ResolvedAuth,
	type ResolvedTarget,
	resolveAuth,
	resolveBooleanSetting,
	resolveCdb,
	resolveMacTarget,
	resolveStringSetting,
	resolveTarget,
} from "./resolver/index.ts";

/** Prime budget (login + license + the ~10s mac-telnet negotiation stall). */
const PRIME_TIMEOUT_MS = 30_000;
/** Per-session command/idle budget. */
const COMMAND_TIMEOUT_MS = 15_000;
/** Batch mode: close after this much output quiescence following stdin EOF. */
const DRAIN_IDLE_MS = 500;

export interface TerminalRequest {
	/**
	 * Device handle: a MAC (resolves to the L2 console over mac-telnet), or a
	 * host / IP / CDB identity (the IP-level console over ssh).
	 */
	targetInput?: string;
	/**
	 * Transport. Defaults to `mac-telnet` for a MAC target and `ssh` for any other
	 * (host / IP / CDB identity); rest/native have no terminal capability.
	 */
	via?: string;
	/** UDP delivery host override (defaults to the L2 broadcast route discovery). */
	host?: string;
	/** UDP delivery port override (defaults to 20561). */
	port?: number;
	/**
	 * MAC→IP resolution policy for the IP transport (`--via ssh`): `none`
	 * (default; CDB-first, then error) or `arp` (opt into host ARP). Ignored by
	 * the L2 default (`mac-telnet`), which addresses the MAC directly.
	 */
	resolve?: string;
	username?: string;
	password?: string;
	/** Explicit in-packet source MAC (overrides egress-MAC resolution; mac-telnet). */
	sourceMac?: string;
	/** `--via ssh`: private-key path (path only; agent / ~/.ssh used if unset). */
	sshKey?: string;
	/** `--via ssh`: disable SSH host-key verification (accepts changed keys). */
	insecure?: boolean;
	cdbFile?: string;
	cdbPassword?: string;
	format?: string;
	verbose?: boolean;
}

/**
 * The stdio/terminal seam `terminal` drives, injectable so the relay is testable
 * without a real TTY. The CLI wires `process.*`; a test can pass scripted streams.
 */
export interface TerminalIo {
	/** True when both stdin and stdout are TTYs (raw-mode interactive relay). */
	isInteractive: boolean;
	/** Current terminal size reported to the device. */
	size(): { rows: number; cols: number };
	/** Write raw device output bytes to the user's terminal. */
	writeOutput(bytes: Uint8Array): void;
	/** Start reading input; `onChunk` per chunk, `onEnd` once at EOF. */
	readInput(onChunk: (bytes: Uint8Array) => void, onEnd: () => void): void;
	/** Register a window-resize listener (interactive only). */
	onResize?(listener: () => void): void;
	/** Restore terminal state (raw mode off, listeners removed). */
	cleanup(): void;
}

interface ResolvedTerminal {
	via: string;
	target: ResolvedTarget;
	auth: ResolvedAuth;
	sourceMac?: string;
	insecure: boolean;
	warnings: CdbResolution["warnings"];
}

/** Reject any transport without a terminal capability (mac-telnet + ssh). */
function gateTerminalVia(via: string): void {
	if (via === "mac-telnet" || via === "ssh") {
		return;
	}
	if (via === "rest-api" || via === "native-api") {
		throw new CentrsError({
			code: "transport/capability-unsupported",
			summary: `${via} has no terminal capability.`,
			remediation:
				"terminal is a console transport: use `--via ssh` (host target) or `--via mac-telnet` (MAC target). For structured reads use `retrieve --via rest-api`/`native-api`.",
			context: { via, command: "terminal" },
		});
	}
	throw new CentrsError({
		code: "settings/invalid-via",
		summary: `Unsupported terminal transport: ${via}.`,
		remediation: "terminal supports `--via mac-telnet` or `--via ssh`.",
		context: { via },
	});
}

/** Resolve a terminal request to a mac-telnet route; reject other transports. */
export async function resolveTerminalRequest(
	request: TerminalRequest,
	env: Record<string, string | undefined> = Bun.env,
): Promise<ResolvedTerminal> {
	// Gate the transport BEFORE any CDB load: an explicit unsupported `--via`
	// should fail fast and hermetically, without a device-registry lookup for a
	// request we will reject anyway (an unmatched target would otherwise throw a
	// `cdb/not-found-target` that masks the real "no terminal capability" reason).
	const preliminaryVia = request.via ?? env["CENTRS_VIA"];
	if (preliminaryVia !== undefined) {
		gateTerminalVia(preliminaryVia);
	}
	const config = await loadEnvFileDefaults(env);
	const cdb = await resolveCdb(
		{
			targetInput: request.targetInput,
			cdbFile: request.cdbFile,
			cdbPassword: request.cdbPassword,
		},
		env,
		config,
	);
	// A MAC target defaults to the L2 console (mac-telnet); any other target
	// (host / IP / CDB identity) defaults to ssh — the IP-level terminal transport.
	const defaultVia = isMacAddress(request.targetInput ?? "")
		? "mac-telnet"
		: "ssh";
	const via = resolveStringSetting(
		request.via,
		env,
		"CENTRS_VIA",
		defaultVia,
		"via",
		undefined,
		cdb?.overrides.via,
		config,
	);
	const viaValue = via?.value ?? defaultVia;
	// Re-gate on the fully resolved value to catch a CDB comment-kv `via=` override.
	gateTerminalVia(viaValue);
	// A MAC target over the IP transport (`--via ssh`) needs an IP. Resolve it
	// CDB-first (the matched record's `target` already wins below); only when no
	// record matches does this throw `target/mac-unresolved` — unless the caller
	// opted into host ARP with `--resolve arp`. The L2 default (mac-telnet)
	// addresses the MAC directly, so it never resolves (NO silent ARP).
	const macResolution = isIpTransport(viaValue)
		? await resolveMacTarget({
				host: request.host,
				targetInput: request.targetInput,
				cdbTarget: cdb?.target,
				env,
				config,
				policy: parseResolvePolicy(
					request.resolve ?? env["CENTRS_RESOLVE"] ?? config["CENTRS_RESOLVE"],
				),
				operation: "terminal",
			})
		: undefined;
	const target = resolveTarget(
		{
			targetInput: request.targetInput,
			host: request.host,
			port: request.port,
			macResolution,
		},
		env,
		viaValue === "ssh" ? "ssh" : "mac-telnet",
		cdb,
		config,
	);
	const auth = resolveAuth(
		{
			username: request.username,
			password: request.password,
			sshKey: request.sshKey,
		},
		env,
		cdb,
		config,
	);
	const insecure = resolveBooleanSetting(
		request.insecure,
		env,
		"CENTRS_INSECURE",
		false,
		"insecure",
		cdb?.overrides.insecure,
		config,
	);
	return {
		via: viaValue,
		target,
		auth,
		sourceMac: request.sourceMac,
		insecure: insecure.value,
		warnings: cdb?.warnings ?? [],
	};
}

/** Build the UDP transport + console for a resolved mac-telnet terminal and open it. */
async function connectTerminalConsole(
	resolved: ResolvedTerminal,
	io: TerminalIo,
): Promise<{ console: MacTelnetConsole; transport: MacTelnetTransport }> {
	if (!resolved.target.mac) {
		throw new CentrsError({
			code: "target/mac-required",
			summary: "terminal over mac-telnet needs a MAC address target.",
			remediation: "Pass the device MAC (aa:bb:cc:dd:ee:ff).",
		});
	}
	const destinationMac = parseMac(resolved.target.mac);
	const { sourceMac, host } = await resolveMacTelnetRoute({
		destinationMac,
		host: resolved.target.host,
		port: resolved.target.port,
		timeoutMs: COMMAND_TIMEOUT_MS,
		explicitSourceMac: resolved.sourceMac
			? parseMac(resolved.sourceMac)
			: undefined,
	});
	const transport = createUdpMacTelnetTransport({
		host,
		port: resolved.target.port,
		broadcast: isBroadcastHost(host),
	});
	await transport.ready();
	// Interactive: report the real terminal size so the device neither wraps nor
	// paginates. Batch: keep the console's wide capture defaults (no TTY size).
	const size = io.isInteractive ? io.size() : undefined;
	const console = new MacTelnetConsole({
		sink: transport,
		sourceMac,
		destinationMac,
		username: resolved.auth.username ?? "",
		password: resolved.auth.password,
		primeTimeoutMs: PRIME_TIMEOUT_MS,
		commandTimeoutMs: COMMAND_TIMEOUT_MS,
		...(size ? { rows: size.rows, cols: size.cols } : {}),
	});
	transport.onMessage((bytes) => console.handlePacket(bytes));
	await console.open();
	return { console, transport };
}

/**
 * Run an interactive terminal session and resolve with the exit code. mac-telnet
 * drives the in-process console relay over {@link TerminalIo} (returns 0 on a
 * clean close; throws before any output on a pre-stream failure). ssh delegates to
 * the host `ssh` client with inherited stdio and returns its exit code. A
 * non-terminal transport throws `transport/capability-unsupported` from the gate.
 */
export async function runTerminal(
	request: TerminalRequest,
	io: TerminalIo,
	env: Record<string, string | undefined> = Bun.env,
): Promise<number> {
	const resolved = await resolveTerminalRequest(request, env);
	if (resolved.via === "ssh") {
		return runTerminalSsh(resolved);
	}
	const { console: cons, transport } = await connectTerminalConsole(
		resolved,
		io,
	);

	await new Promise<void>((resolve, reject) => {
		let settled = false;
		let lastOutputAt = Date.now();
		let sawOutput = false;
		let drainTimer: ReturnType<typeof setInterval> | undefined;
		let drainCap: ReturnType<typeof setTimeout> | undefined;

		const finish = (error?: CentrsError): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (drainTimer) clearInterval(drainTimer);
			if (drainCap) clearTimeout(drainCap);
			cons.close();
			transport.close();
			io.cleanup();
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};

		cons.onClosed((error) => finish(error));
		cons.attachInteractive(
			(bytes) => {
				lastOutputAt = Date.now();
				sawOutput = true;
				io.writeOutput(bytes);
			},
			{ answerProbe: !io.isInteractive },
		);
		io.onResize?.(() => {
			const { rows, cols } = io.size();
			cons.reportSize(rows, cols);
		});

		const onEnd = (): void => {
			if (io.isInteractive) {
				// A TTY EOF (the stream closing) ends the session.
				finish();
				return;
			}
			// Batch: stdin is exhausted, but the device may still be answering the
			// last line — and stdin EOF typically beats the first response byte. Only
			// close once we have seen the response *and* it has been quiet for
			// DRAIN_IDLE_MS; `sawOutput` keeps the stale prime-prompt timestamp from
			// closing us early. A hard cap covers a command that prints nothing.
			drainTimer = setInterval(() => {
				if (sawOutput && Date.now() - lastOutputAt >= DRAIN_IDLE_MS) {
					finish();
				}
			}, 50);
			drainTimer.unref?.();
			drainCap = setTimeout(() => finish(), COMMAND_TIMEOUT_MS);
			drainCap.unref?.();
		};

		io.readInput((bytes) => cons.write(bytes), onEnd);
	});
	return 0;
}

/**
 * Build the `ssh` argv for an interactive RouterOS terminal: `ssh -p <port>
 * <key/trust options> user@host` with **no** command (so it opens the console)
 * and **no** `-t` (RouterOS grants no PTY; forcing one with `-tt` hangs, and a
 * real TTY makes the host `ssh` request a PTY on its own). `interactive: true`
 * drops `BatchMode=yes` (unlike the batch sftp/execute clients), so the host
 * `ssh` may prompt on the inherited TTY for an encrypted key's passphrase or a
 * password — centrs does not forward `--password`, as OpenSSH takes no password
 * on the argv. Exported for tests.
 */
export function buildSshTerminalArgv(resolved: ResolvedTerminal): string[] {
	const conn = {
		host: resolved.target.host,
		port: resolved.target.port,
		username: resolved.auth.username,
		sshKey: resolved.auth.sshKey,
		insecure: resolved.insecure,
		interactive: true,
		timeoutMs: PRIME_TIMEOUT_MS,
	};
	return [
		"ssh",
		"-p",
		String(resolved.target.port),
		...sshCommonOptions(conn),
		sshUserHost(conn),
	];
}

/**
 * Terminal over SSH: exec the host `ssh` with inherited stdio, so the OS relays
 * the (already clean, no-PTY) RouterOS console — no screen emulation needed. The
 * interactive TTY, raw mode, and signals are the inherited terminal's; centrs's
 * value is resolving the target/key/trust and building the argv. Returns ssh's
 * exit code (a no-PTY console closed by EOF can exit non-zero — that is the
 * device/ssh's result, not a centrs failure).
 */
async function runTerminalSsh(resolved: ResolvedTerminal): Promise<number> {
	const argv = buildSshTerminalArgv(resolved);
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(argv, {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
	} catch (cause) {
		throw new CentrsError({
			code: "transport/local-tool-missing",
			summary: "Cannot launch the host `ssh` client for the terminal.",
			remediation:
				"Install an OpenSSH client so `ssh` is on PATH (macOS ships it; Debian/Ubuntu: `openssh-client`).",
			context: { binary: "ssh", via: "ssh" },
			cause,
		});
	}
	return await proc.exited;
}

export interface TerminalErrorEnvelope {
	ok: false;
	error: ReturnType<typeof serializeCentrsError>;
	warnings: [];
	tips: [];
}

/** Wrap a pre-stream failure as the standard error envelope (rendered to stderr). */
export function buildTerminalErrorEnvelope(
	error: unknown,
): TerminalErrorEnvelope {
	const centrs =
		error instanceof CentrsError
			? error
			: new CentrsError({
					code: "internal/unhandled",
					summary: error instanceof Error ? error.message : String(error),
					remediation:
						"This is a centrs bug; re-run with --verbose and file an issue with the printed code.",
				});
	return {
		ok: false,
		error: serializeCentrsError(centrs),
		warnings: [],
		tips: [],
	};
}
