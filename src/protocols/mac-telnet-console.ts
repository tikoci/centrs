/**
 * RouterOS interactive-console reader over a MAC-Telnet session.
 *
 * MAC-Telnet (see `mac-telnet.ts`) gives a raw, bidirectional terminal stream —
 * not a request/response API. To run a command and capture clean output, this
 * layer drives the RouterOS console the way a terminal would and reconstructs
 * the "screen", then strips the echoed command and the trailing prompt.
 *
 * Everything here is grounded on stock CHR 7.23.1 (probes in `.scratch/`,
 * captured while wiring `execute / mac-telnet`):
 *
 *   - **Terminal-size probe at login.** The console emits a multi-step ANSI
 *     cursor probe: `ESC[9999B`/`ESC[9999C` (move to find the edges), `ESC[H`,
 *     `ESC Z` (DECID), mode sets, and repeated `ESC[6n` (DSR cursor-position
 *     report). Answering each `ESC[6n` with `ESC[<rows>;<cols>R` makes the
 *     console use that width (otherwise it falls back to 80 cols and *wraps* the
 *     echo, which breaks output extraction). We report a tall/wide screen so the
 *     console neither paginates nor wraps in capture mode.
 *   - **~10s login stall.** The MOTD/prompt does not appear until ~10s after
 *     login, on *every* login (not just the first). Answering the probe does not
 *     remove it — the multi-step probe seems to want a real terminal's clamped
 *     cursor tracking, which a fixed DSR answer does not satisfy, so the console
 *     waits out a negotiation timeout. This is a latency cost, not a correctness
 *     problem; `primeTimeoutMs` budgets for it. (Killing it would need a cursor
 *     emulator that answers each DSR with the real clamped position.)
 *   - **First-login license gate.** A fresh device prints the banner and
 *     `Do you want to see the software license? [Y/n]:` and blocks until
 *     answered. mac-telnet's whole point is reaching fresh/unconfigured gear, so
 *     `open()` auto-answers it (`n`). Later logins skip it.
 *   - **Prompt.** `[user@identity] > ` (root) or `[user@identity] /path> `,
 *     redrawn with CR + space-padding + CR. {@link ROUTEROS_PROMPT_RE}.
 *   - **Response shape** (after CR/LF terminal-emulation): line 0 is the echoed
 *     `[prompt] > <command>`, the middle lines are the output, and the last line
 *     is the trailing prompt. No ANSI appears in command responses — only in the
 *     login probe. A successful **write** (add/set/remove) prints nothing — no
 *     `.id`, no confirmation — so the middle is empty and only the bracketing
 *     prompt frames it (the same silent-write behavior `execute / ssh` sees).
 *   - **`:put [:parse "<cmd>"]`** returns a human string the console can be
 *     scraped for: `(evl …)` = ok, `syntax error (line …)` = malformed, and
 *     `bad parameter <name> (line …)` = unknown attribute. A single console
 *     `:parse` therefore covers both the syntax and the unknown-attribute
 *     (semantic) gate — no `/console/inspect` table parsing needed.
 */

import { parseRouterOsPosition } from "../core/routeros-errors.ts";
import { CentrsError } from "../errors.ts";
import {
	type MacAddress,
	type MacTelnetDatagramSink,
	MacTelnetSession,
} from "./mac-telnet.ts";

const ESC = "\x1b";
const enc = new TextEncoder();

// ANSI strippers, built from the ESC constant so no literal control char sits in
// a regex source (which the linter forbids). CSI: `ESC [ <params> <inter> final`;
// ESC2: a two-byte escape `ESC <0x40-0x5f>` (e.g. `ESC Z`, `ESC D`).
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const ANSI_ESC2 = new RegExp(`${ESC}[@-_]`, "g");

/** RouterOS readline prompt: `[user@identity] > ` / `[user@identity] /ip/address> `. */
export const ROUTEROS_PROMPT_RE = /\[[^\]@\r\n]+@[^\]\r\n]*\][^\r\n]*>\s*$/;

/** How often the console drives {@link MacTelnetSession.tick} (retransmit/keepalive). */
const TICK_INTERVAL_MS = 15;

/** The first-login one-time license question. */
const LICENSE_RE = /do you want to see the software license/i;

export interface MacTelnetConsoleOptions {
	/** Datagram sink the underlying session writes to (UDP socket, or a test bridge). */
	sink: MacTelnetDatagramSink;
	sourceMac: MacAddress;
	destinationMac: MacAddress;
	username: string;
	password: string;
	sessionKey?: number;
	/**
	 * Rows/cols reported to the console's DSR probe. Defaults are deliberately
	 * huge so the console never paginates (rows) or wraps the echo (cols) in
	 * capture mode. An interactive `terminal` would pass the real PTY size.
	 */
	rows?: number;
	cols?: number;
	/** Budget to reach the first prompt (covers banner/license + the ~10s stall). */
	primeTimeoutMs?: number;
	/** Per-command response budget. */
	commandTimeoutMs?: number;
	/** Quiescence after a prompt is seen before a response is considered complete. */
	settleMs?: number;
	/** Auto-answer the first-login software-license prompt with `n`. Default true. */
	acceptLicense?: boolean;
}

export interface ConsoleCommandResult {
	/** Clean output: echoed command and trailing prompt stripped, CRLF→\n. */
	output: string;
	/** The raw console bytes captured for this command (debugging). */
	raw: string;
}

type Waiter = {
	predicate: (buffer: string) => boolean;
	resolve: () => void;
	reject: (error: CentrsError) => void;
	timeout: ReturnType<typeof setTimeout>;
	settle?: ReturnType<typeof setTimeout>;
};

/**
 * Emulate a CR/LF terminal: CR → column 0 (overwrite), LF → next line,
 * BS → back one column, printable → write at the cursor. ANSI/CSI escapes are
 * stripped (they appear only in the login probe). Returns the displayed lines,
 * right-trimmed. This collapses the console's CR-based prompt redraws and
 * space-padding into the single line a user would see.
 */
export function emulateScreen(text: string): string[] {
	const clean = text.replace(ANSI_CSI, "").replace(ANSI_ESC2, "");
	const lines: string[][] = [[]];
	let row = 0;
	let col = 0;
	for (const ch of clean) {
		const code = ch.charCodeAt(0);
		if (ch === "\n") {
			row += 1;
			if (!lines[row]) lines[row] = [];
			col = 0;
		} else if (ch === "\r") {
			col = 0;
		} else if (code === 8) {
			col = Math.max(0, col - 1);
		} else if (code >= 32 && code !== 0x7f) {
			const line = lines[row] as string[];
			line[col] = ch;
			col += 1;
		}
	}
	return lines.map((line) =>
		Array.from(line, (c) => c ?? " ")
			.join("")
			.replace(/\s+$/, ""),
	);
}

/**
 * Extract the command's clean output from its raw console response: drop the
 * echoed-command line(s) and any trailing prompt / blank lines.
 *
 * The echo is `[prompt] > <command>`. With a normal-length command it is one
 * line, but a command longer than the terminal width wraps onto further lines.
 * When `command` is supplied, consume exactly as many echoed lines as the command
 * spans (so a wrapped echo — e.g. a long `:put [:parse "…"]` — does not leak into
 * the output); otherwise fall back to dropping the single first line.
 */
export function extractCommandOutput(raw: string, command?: string): string {
	const lines = emulateScreen(raw);
	let start = 1;
	if (command !== undefined && lines.length > 0) {
		const first = lines[0] ?? "";
		const promptMatch = first.match(/^\[[^\]\r\n]*\][^\r\n]*?>\s?/);
		const echoedOnFirst = promptMatch
			? first.slice(promptMatch[0].length)
			: first;
		let consumed = echoedOnFirst.length;
		while (consumed < command.length && start < lines.length) {
			consumed += (lines[start] ?? "").length;
			start += 1;
		}
	}
	const body = lines.slice(start);
	while (body.length > 0) {
		const last = body[body.length - 1] as string;
		if (last.length === 0 || ROUTEROS_PROMPT_RE.test(last)) {
			body.pop();
			continue;
		}
		break;
	}
	return body.join("\n");
}

/**
 * Drives one MAC-Telnet console session: login, terminal-probe negotiation,
 * license, prompt sync, and command run/capture. The owner feeds inbound
 * datagrams via {@link handlePacket} and provides the outbound {@link sink}.
 */
export class MacTelnetConsole {
	private readonly options: Required<
		Omit<MacTelnetConsoleOptions, "sink" | "sessionKey">
	> &
		Pick<MacTelnetConsoleOptions, "sink" | "sessionKey">;
	private readonly session: MacTelnetSession;
	private buffer = "";
	private ready = false;
	private closed = false;
	private closeError?: CentrsError;
	private waiter?: Waiter;
	private tickTimer?: ReturnType<typeof setInterval>;
	private readyWaiters: Array<{
		resolve: () => void;
		reject: (e: CentrsError) => void;
	}> = [];
	private readonly decoder = new TextDecoder();
	/** Rolling tail across chunks so a terminal probe split across packets is still matched. */
	private probeTail = "";
	/** Interactive relay: when set, raw device bytes are forwarded here verbatim. */
	private outputSink?: (bytes: Uint8Array) => void;
	/** In an interactive TTY relay the downstream terminal answers the size probe. */
	private suppressProbeAnswer = false;
	/** Listeners notified once the session closes (drives a terminal relay's exit). */
	private closeListeners: Array<(error?: CentrsError) => void> = [];

	constructor(options: MacTelnetConsoleOptions) {
		this.options = {
			rows: 9999,
			cols: 512,
			primeTimeoutMs: 30_000,
			commandTimeoutMs: 15_000,
			settleMs: 150,
			acceptLicense: true,
			...options,
		};
		this.session = new MacTelnetSession({
			sink: options.sink,
			sourceMac: options.sourceMac,
			destinationMac: options.destinationMac,
			username: options.username,
			password: options.password,
			sessionKey: options.sessionKey,
			terminalType: "vt102",
			terminalWidth: this.options.cols,
			terminalHeight: this.options.rows,
			onReady: () => this.onReady(),
			onData: (bytes) => this.onData(bytes),
			onClose: (error) => this.onClose(error),
		});
	}

	/** Feed an inbound datagram into the session. */
	handlePacket(bytes: Uint8Array): void {
		// This is called from a socket `data`/`message` event — it must never throw
		// back to the emitter. Outbound sends are already fault-tolerant; an
		// unexpected processing error here closes the console (rejecting waiters)
		// rather than crashing the caller's event loop.
		try {
			this.session.handlePacket(bytes);
		} catch (error) {
			this.onClose(
				error instanceof CentrsError
					? error
					: new CentrsError({
							code: "routeros/mac-telnet-protocol",
							summary: "Failed to process a MAC-Telnet datagram.",
							remediation: "Re-open the session and retry.",
							cause: error,
						}),
			);
		}
	}

	/**
	 * Log in, negotiate the terminal, clear the license, and synchronize on the
	 * first prompt. Resolves once the console is ready to take commands.
	 */
	async open(): Promise<void> {
		// Drive the session's retransmit + keepalive timers. The tick interval is
		// small enough to honor the reference retransmit backoff (15ms first step) —
		// a coarse tick would collapse the early 15/20/30ms steps and delay recovery
		// from packet loss during session start/auth. `unref` so a dangling console
		// never keeps the process alive.
		this.tickTimer = setInterval(() => {
			try {
				this.session.tick(Date.now());
			} catch {
				/* timer callback must not throw to the event loop */
			}
		}, TICK_INTERVAL_MS);
		this.tickTimer.unref?.();
		this.session.start();
		await this.waitReady(this.options.primeTimeoutMs);
		// Wait for the banner / license / first prompt (covers the ~10s stall).
		await this.waitFor(
			(buffer) => this.endsWithPrompt(buffer) || LICENSE_RE.test(buffer),
			this.options.primeTimeoutMs,
			"waiting for the RouterOS console prompt",
		);
		if (this.options.acceptLicense && LICENSE_RE.test(this.buffer)) {
			this.buffer = "";
			this.session.sendInput(enc.encode("n\r"));
			await this.waitFor(
				(buffer) => this.endsWithPrompt(buffer),
				this.options.primeTimeoutMs,
				"waiting for the prompt after the license screen",
			);
		}
		// Land on a clean, empty prompt and discard the banner.
		this.buffer = "";
		this.session.sendInput(enc.encode("\r"));
		await this.waitFor(
			(buffer) => this.endsWithPrompt(buffer),
			this.options.commandTimeoutMs,
			"waiting for a clean prompt",
		);
		this.buffer = "";
	}

	/** Run one CLI command and return its clean output. */
	async run(cli: string): Promise<ConsoleCommandResult> {
		this.assertOpen();
		this.buffer = "";
		this.session.sendInput(enc.encode(`${cli}\r`));
		await this.waitFor(
			(buffer) => this.endsWithPrompt(buffer),
			this.options.commandTimeoutMs,
			`running over mac-telnet: ${cli}`,
		);
		const raw = this.buffer;
		return { output: extractCommandOutput(raw, cli), raw };
	}

	/**
	 * Validate a command without running it, using a single console `:parse`.
	 * Throws `validation/syntax` for malformed CLI and
	 * `validation/unknown-attribute` for a rejected parameter; returns the parsed
	 * form on success. One gate covers both because the console's `:parse`
	 * reports `bad parameter <name>` as well as `syntax error`.
	 */
	async parseGate(cli: string): Promise<string> {
		const { output } = await this.run(parseScriptFor(cli));
		classifyParseResult(output, cli);
		return output;
	}

	/**
	 * Switch the (already-open) console into interactive raw passthrough: device
	 * bytes are forwarded verbatim to `sink` instead of being captured, and the
	 * capture buffer is dropped. Call after {@link open} resolves.
	 *
	 * `answerProbe` defaults true (batch relay: no downstream terminal, so the
	 * console still auto-answers the size probe). An interactive TTY relay passes
	 * `false` so the user's real terminal answers it instead of double-replying.
	 */
	attachInteractive(
		sink: (bytes: Uint8Array) => void,
		options: { answerProbe?: boolean } = {},
	): void {
		this.outputSink = sink;
		this.suppressProbeAnswer = options.answerProbe === false;
		// Cancel any pending capture waiter; interactive mode never resolves one.
		if (this.waiter) {
			clearTimeout(this.waiter.timeout);
			if (this.waiter.settle) clearTimeout(this.waiter.settle);
			this.waiter = undefined;
		}
		this.buffer = "";
	}

	/** Forward raw input bytes (keystrokes / piped commands) to the device. */
	write(bytes: Uint8Array): void {
		if (this.closed) {
			return;
		}
		this.session.sendInput(bytes);
	}

	/**
	 * Update the reported terminal size (e.g. on `SIGWINCH`). Best-effort: the new
	 * size is used for any subsequent device size probe; RouterOS does not renegotiate
	 * mac-telnet terminal dimensions mid-session, so a live resize is advisory.
	 */
	reportSize(rows: number, cols: number): void {
		this.options.rows = rows;
		this.options.cols = cols;
	}

	/** Register a listener fired once the session closes (drives a relay's exit). */
	onClosed(listener: (error?: CentrsError) => void): void {
		if (this.closed) {
			listener(this.closeError);
			return;
		}
		this.closeListeners.push(listener);
	}

	/** Send END and close the session. */
	close(): void {
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = undefined;
		}
		if (!this.closed) {
			this.session.end();
		}
	}

	/** True once login + prime completed and the console accepts commands. */
	get isReady(): boolean {
		return this.ready && !this.closed;
	}

	// ── internals ──────────────────────────────────────────────────────────

	private onReady(): void {
		this.ready = true;
		for (const w of this.readyWaiters.splice(0)) {
			w.resolve();
		}
	}

	private onData(bytes: Uint8Array): void {
		// Stream-decode so a multi-byte char split across datagrams is not corrupted.
		const chunk = this.decoder.decode(bytes, { stream: true });
		// Match the size probe against `(carry || prev tail) + chunk` so an `ESC[6n`
		// straddling a packet boundary is still answered. The carry is exactly the
		// longest probe (`ESC[6n`, 4 bytes) minus one, so a full probe never fits in
		// the carry alone — i.e. a match always includes a fresh byte and is answered
		// once, never re-answered as the tail slides.
		const combined = `${this.probeTail}${chunk}`;
		this.answerSizeProbe(combined);
		this.probeTail = combined.slice(-3);
		if (this.outputSink) {
			// Interactive relay: forward raw device bytes verbatim and do not grow a
			// capture buffer (a held-open terminal would accumulate without bound).
			this.outputSink(bytes);
			return;
		}
		this.buffer += chunk;
		this.checkWaiter();
	}

	private onClose(error?: CentrsError): void {
		this.closed = true;
		this.closeError = error;
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = undefined;
		}
		for (const listener of this.closeListeners.splice(0)) {
			listener(error);
		}
		const failure =
			error ??
			new CentrsError({
				code: "transport/connection-closed",
				summary: "The MAC-Telnet console session closed.",
				remediation: "Re-open the session and retry.",
			});
		for (const w of this.readyWaiters.splice(0)) {
			w.reject(failure);
		}
		if (this.waiter) {
			const waiter = this.waiter;
			this.waiter = undefined;
			clearTimeout(waiter.timeout);
			if (waiter.settle) clearTimeout(waiter.settle);
			waiter.reject(failure);
		}
	}

	/**
	 * Answer the console's terminal-size probe. The operative query is DSR
	 * (`ESC[6n`); replying with our reported rows/cols stops the console wrapping
	 * at 80. We also answer DECID (`ESC Z`) / primary DA (`ESC[c`) with a VT102
	 * identification. (This does not remove the ~10s negotiation stall.)
	 */
	private answerSizeProbe(chunk: string): void {
		// In an interactive TTY relay the user's real terminal answers the probe;
		// answering it ourselves too would double-reply. Batch mode (no TTY) keeps
		// answering so the console still gets a wide screen.
		if (this.suppressProbeAnswer) {
			return;
		}
		if (chunk.includes(`${ESC}[6n`)) {
			// The console probes height and width with several DSR queries; answer
			// every one (a fixed reply still sets the width and avoids 80-col wrap).
			this.session.sendInput(
				enc.encode(`${ESC}[${this.options.rows};${this.options.cols}R`),
			);
		}
		if (chunk.includes(`${ESC}Z`) || chunk.includes(`${ESC}[c`)) {
			this.session.sendInput(enc.encode(`${ESC}[?6c`));
		}
	}

	private endsWithPrompt(buffer: string): boolean {
		const lines = emulateScreen(buffer).filter((line) => line.length > 0);
		return ROUTEROS_PROMPT_RE.test(lines[lines.length - 1] ?? "");
	}

	private waitReady(timeoutMs: number): Promise<void> {
		if (this.ready) return Promise.resolve();
		if (this.closed) {
			return Promise.reject(
				this.closeError ??
					new CentrsError({
						code: "transport/connection-closed",
						summary: "The MAC-Telnet session closed before login completed.",
						remediation: "Confirm the device and credentials, then retry.",
					}),
			);
		}
		// Bound the wait: if the device never responds (or auth never completes
		// without closing), open() would otherwise hang forever, ignoring --timeout.
		return new Promise((resolve, reject) => {
			const entry = {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error: CentrsError) => {
					clearTimeout(timer);
					reject(error);
				},
			};
			const timer = setTimeout(() => {
				this.readyWaiters = this.readyWaiters.filter((w) => w !== entry);
				reject(
					new CentrsError({
						code: "transport/timeout",
						summary:
							"MAC-Telnet login did not complete — no console response from the device.",
						remediation:
							"Confirm the device is reachable over mac-telnet (mac-server interface list) and the credentials are correct.",
						context: { timeoutMs },
					}),
				);
			}, timeoutMs);
			this.readyWaiters.push(entry);
		});
	}

	/**
	 * Resolve once `predicate(buffer)` holds and the stream has been quiet for
	 * `settleMs` (so a prompt seen mid-redraw captures the full final prompt).
	 */
	private waitFor(
		predicate: (buffer: string) => boolean,
		timeoutMs: number,
		label: string,
	): Promise<void> {
		if (this.closed) {
			return Promise.reject(
				this.closeError ??
					new CentrsError({
						code: "transport/connection-closed",
						summary: `MAC-Telnet session closed while ${label}.`,
						remediation: "Re-open the session and retry.",
					}),
			);
		}
		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.waiter = undefined;
				reject(
					new CentrsError({
						code: "transport/timeout",
						summary: `Timed out ${label}.`,
						remediation:
							"The RouterOS console did not return a prompt in time; raise the timeout or confirm the device is responsive over mac-telnet.",
						context: { label, timeoutMs },
					}),
				);
			}, timeoutMs);
			this.waiter = { predicate, resolve, reject, timeout };
			this.checkWaiter();
		});
	}

	private checkWaiter(): void {
		const waiter = this.waiter;
		if (!waiter) return;
		if (!waiter.predicate(this.buffer)) {
			// New data invalidated a pending settle (still mid-response).
			if (waiter.settle) {
				clearTimeout(waiter.settle);
				waiter.settle = undefined;
			}
			return;
		}
		// Predicate holds; (re)start the settle timer so trailing redraw lands.
		if (waiter.settle) clearTimeout(waiter.settle);
		waiter.settle = setTimeout(() => {
			if (this.waiter !== waiter) return;
			this.waiter = undefined;
			clearTimeout(waiter.timeout);
			waiter.resolve();
		}, this.options.settleMs);
	}

	private assertOpen(): void {
		if (!this.ready || this.closed) {
			throw new CentrsError({
				code: "routeros/mac-telnet-not-ready",
				summary: "The MAC-Telnet console is not open.",
				remediation: "Call open() and await it before running commands.",
			});
		}
	}
}

/** The `:put [:parse "<cli>"]` script that validates `cli` over the console. */
export function parseScriptFor(cli: string): string {
	return `:put [:parse ${routerOsStringLiteral(cli)}]`;
}

/**
 * Classify the output of a console `:put [:parse "<cli>"]`. A single console
 * `:parse` reports both forms (grounded on CHR 7.23.1): `bad parameter <name>`
 * for an unknown attribute and `syntax error` / `bad command name` for malformed
 * CLI. Throws the matching `validation/*` error; returns on a clean parse.
 */
export function classifyParseResult(output: string, cli: string): void {
	// The console `:parse` rejection carries RouterOS's authoritative byte offset
	// (`… (line N column M)`); surface it as the structured `error.position`.
	const position = parseRouterOsPosition(output);
	const unknown = output.match(/bad parameter\s+(\S+)/i);
	if (unknown) {
		throw new CentrsError({
			code: "validation/unknown-attribute",
			summary: `RouterOS rejected the parameter "${cleanToken(unknown[1] ?? "")}" while parsing the command.`,
			remediation:
				"Remove or rename the attribute; check it against the RouterOS path's parameters.",
			context: {
				command: cli,
				parameter: cleanToken(unknown[1] ?? ""),
				validationSource: ":put [:parse ...] over mac-telnet",
				detail: output,
			},
			...(position ? { position } : {}),
		});
	}
	if (/syntax error|bad command name|expected\b/i.test(output)) {
		throw new CentrsError({
			code: "validation/syntax",
			summary: "RouterOS rejected the command syntax while parsing it.",
			remediation:
				"Fix the RouterOS CLI syntax (quotes, brackets, attribute form), then retry.",
			context: {
				command: cli,
				validationSource: ":put [:parse ...] over mac-telnet",
				detail: output,
			},
			...(position ? { position } : {}),
		});
	}
}

function routerOsStringLiteral(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function cleanToken(token: string): string {
	return token.replace(/^["'`]+|["'`.,;:)]+$/g, "");
}
