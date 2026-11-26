/**
 * RouterOS interactive-console reader over a MAC-Telnet session.
 *
 * MAC-Telnet (see `mac-telnet.ts`) gives a raw, bidirectional terminal stream —
 * not a request/response API. To run a command and capture clean output, this
 * layer drives the RouterOS console the way a terminal would and reconstructs
 * the "screen", then strips the echoed command and the trailing prompt.
 *
 * Everything here is grounded on stock CHR 7.23.1 (lab probes, history —
 * captured while wiring `execute / mac-telnet` in PR #15, a9f1cbf):
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
 *     (name-level) gate — no `/console/inspect` table parsing needed.
 */

import { absentMenuError } from "../absent-menu.ts";
import { parseRouterOsPosition } from "../core/routeros-errors.ts";
import { routerOsStringLiteral } from "../core/routeros-string.ts";
import { CentrsError, SYNTAX_REJECTED_REMEDIATION } from "../errors.ts";
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
export function emulateScreen(text: string, trim = true): string[] {
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
	return lines.map((line) => {
		const row = Array.from(line, (c) => c ?? " ").join("");
		return trim ? row.replace(/\s+$/, "") : row;
	});
}

/**
 * Extract the command's clean output from its raw console response: drop the
 * echoed command and any trailing prompt / blank lines.
 *
 * The console frames its reply (CHR 7.24.5, #575). Each submitted line is
 * echoed (typed text, then a highlighted redraw, wrapped with bare CRLFs at the
 * terminal width), and the echo ends with CRLF + CR; the line's output follows.
 * Each new prompt is drawn after `ESC[9999B`: `ESC[9999B ESC[K` once a line has
 * run, and `ESC[9999B` alone when the console redraws the same input after a
 * TAB completion list. So the reply splits into one segment per prompt, a
 * segment that ends in a redraw is a completion list and is dropped, and each
 * other segment's output is whatever follows its first CRLF + CR. The command
 * text is not compared: the echo differs from the bytes sent (non-ASCII,
 * trailing spaces, backspace, TAB completion), and printed text can look like
 * an echo or a prompt.
 *
 * A reply without that framing falls back to the screen: the first line is the
 * echo, or, with `command`, as many screen columns as the command is long.
 */
export function extractCommandOutput(
	raw: string,
	command?: string,
	cols = 512,
): string {
	const framed = framedOutput(raw, cols);
	if (framed !== undefined) return framed.join("\n");
	const lines = emulateScreen(raw);
	const body =
		command === undefined ? lines.slice(1) : countedEcho(lines, command);
	return trimTrailingPrompts(body).join("\n");
}

/** `ESC[9999B` (cursor to the last row) starts every prompt the console draws. */
const PROMPT_MARK = `${ESC}[9999B`;
/** After a line has run, the prompt is drawn on a cleared row. */
const CLEAR_ROW = `${ESC}[K`;
/** An echo ends with CRLF + CR; a wrap inside it is a bare CRLF. */
const ECHO_END = "\r\n\r";

type PromptMark = { at: number; fresh: boolean };

/**
 * A drawn prompt, once colors are stripped: `[user@host] > `, a menu prompt
 * such as `[user@host] /ip/address> `, or a `{... ` continuation.
 */
const DRAWN_PROMPT_RE =
	/^(?:\[[^\]\r\n]*@[^\]\r\n]*\][^>\r\n]*>|[{(["]+\.\.\.)/;

/**
 * The next prompt the console drew. A real one follows a CR and is followed
 * by a drawn prompt ({@link DRAWN_PROMPT_RE}), after `ESC[K` when the prompt is
 * fresh. The framing is in-band and has no escaping: printed text keeps its
 * place unless it reproduces CR + `ESC[9999B` + a whole drawn prompt
 * (`:put "\1B[9999B"` and `[not-a-prompt` stay output).
 */
function nextPromptMark(raw: string, from: number): PromptMark | undefined {
	let at = raw.indexOf(PROMPT_MARK, from);
	while (at !== -1) {
		let after = at + PROMPT_MARK.length;
		const fresh = raw.startsWith(CLEAR_ROW, after);
		if (fresh) after += CLEAR_ROW.length;
		if (at > 0 && raw[at - 1] === "\r" && isDrawnPrompt(raw, after))
			return { at, fresh };
		at = raw.indexOf(PROMPT_MARK, at + 1);
	}
	return undefined;
}

function isDrawnPrompt(raw: string, at: number): boolean {
	const lineEnd = raw.slice(at).search(/[\r\n]/);
	const drawn = raw.slice(at, lineEnd === -1 ? undefined : at + lineEnd);
	return DRAWN_PROMPT_RE.test(
		drawn.replace(ANSI_CSI, "").replace(ANSI_ESC2, ""),
	);
}

function framedOutput(raw: string, cols: number): string[] | undefined {
	if (!raw.includes(ECHO_END)) return undefined;
	const out: string[] = [];
	let from = 0;
	while (from < raw.length) {
		const mark = nextPromptMark(raw, from);
		const segment = raw.slice(from, mark?.at ?? raw.length);
		// A redraw without `ESC[K` follows a TAB completion list: same input.
		if (mark === undefined || mark.fresh) {
			const echoEnd = segment.indexOf(ECHO_END);
			if (echoEnd !== -1) {
				// Every output line ends with CRLF, so the last row is the
				// leftover before the next prompt; a blank line before it is output
				// (`:put ""`). A reply cut off before its next prompt keeps the old
				// trailing-prompt trim.
				const rows = outputLines(
					segment.slice(echoEnd + ECHO_END.length),
					cols,
				);
				if (mark === undefined) out.push(...trimTrailingPrompts(rows));
				else {
					if (rows[rows.length - 1] === "") rows.pop();
					out.push(...rows);
				}
			}
		}
		if (mark === undefined) break;
		from = mark.at + PROMPT_MARK.length;
	}
	return out;
}

/**
 * The output lines of one segment, with the console's width wraps rejoined.
 *
 * The console keeps one position per printed record. It resets at the
 * record's CRLF and at any CR; a newline inside the printed value (a bare LF)
 * ends the line but keeps the position. The console sends a wrap (always CRLF)
 * when the position reaches `cols + 1`, then every `cols` after that, so a
 * record that ends exactly on a wrap point leaves an empty row. Every
 * character, UTF-8 included, and 0x01 take one position; TAB moves to the next
 * multiple of 8 unless it is within 2 of the next wrap point; BS takes one
 * back; BEL, VT, FF, DEL and ESC sequences take none. Measured on CHR 7.24.5
 * and 7.23.8 at 512, 200 and 80 columns (#575). The last row is the leftover
 * before the next prompt.
 */
function outputLines(text: string, cols: number): string[] {
	const parts = text.split(/(\r?\n)/);
	const lines: string[] = [];
	const at: ConsolePosition = { position: 0, nextWrap: cols + 1, cols };
	let continuing = false;
	for (let i = 0; i < parts.length; i += 2) {
		const brk = parts[i + 1];
		const row = screenRow(parts[i] ?? "", at);
		if (continuing) lines[lines.length - 1] += row;
		else lines.push(row);
		if (continuing && row.length === 0 && brk === undefined) lines.push("");
		if (brk === "\r\n" && at.position >= at.nextWrap) {
			continuing = true;
			at.nextWrap += cols;
		} else {
			continuing = false;
			if (brk === "\r\n") {
				at.position = 0;
				at.nextWrap = cols + 1;
			}
		}
	}
	// Trailing ASCII spaces are trimmed, whether the console padded them or the
	// value printed them; a trailing TAB, VT or FF is kept.
	return lines.map((line) => line.replace(/ +$/, ""));
}

/** The console's position in the printed value, as `outputLines` describes. */
type ConsolePosition = { position: number; nextWrap: number; cols: number };

/**
 * One output row as text, advancing the console position `at` over it.
 * Colors and ESC sequences are removed, CR and BS are applied as the screen
 * would, and every other character (TAB and C0 controls included) is kept,
 * since it is the command's output. Cells are placed by the same position
 * that decides the wraps, so a later BS or CR lands where the console's did.
 */
function screenRow(raw: string, at: ConsolePosition): string {
	const plain = raw.replace(ANSI_CSI, "");
	let rowStart = at.position;
	const cells: string[] = [];
	// Zero-width controls (BEL, VT, FF, DEL, the unmeasured C0 bytes and a TAB
	// at the wrap edge) are kept at the cell they were printed at, without
	// taking it.
	const zeroWidth: string[] = [];
	// A TAB keeps its byte and owns the blank cells it skips up to its stop.
	// Those cells print nothing while the TAB is still on screen, and a space
	// once it has been overwritten. Cells that already hold text are left alone.
	const tabOwner: (number | undefined)[] = [];
	const put = (cell: number, ch: string, owner?: number) => {
		cells[cell] = ch;
		tabOwner[cell] = owner;
	};
	const cell = () => Math.max(0, at.position - rowStart);
	for (let j = 0; j < plain.length; j++) {
		const ch = plain[j] as string;
		const code = ch.charCodeAt(0);
		if (code === 0x0d) {
			at.position = 0;
			at.nextWrap = at.cols + 1;
			rowStart = 0;
		} else if (code === 0x1b) j++;
		else if (code === 0x08) at.position = Math.max(0, at.position - 1);
		else if (code === 0x09 && at.position < at.nextWrap - 2) {
			const from = cell();
			at.position = (Math.floor(at.position / 8) + 1) * 8;
			const stop = cell();
			let first = stop;
			while (first > from && cells[first - 1] === undefined) first--;
			if (first < stop) {
				put(first, ch);
				for (let k = first + 1; k < stop; k++) put(k, "", first);
			}
		} else if (code === 0x01 || (code >= 0x20 && code !== 0x7f)) {
			const wide = code >= 0xd800 && code <= 0xdbff;
			put(cell(), wide ? ch + (plain[j + 1] ?? "") : ch);
			if (wide) j++;
			at.position += 1;
		} else {
			const c = cell();
			zeroWidth[c] = (zeroWidth[c] ?? "") + ch;
		}
	}
	let row = "";
	for (let i = 0; i < Math.max(cells.length, zeroWidth.length); i++) {
		row += zeroWidth[i] ?? "";
		if (i >= cells.length) continue;
		const owner = tabOwner[i];
		if (owner === undefined) row += cells[i] ?? " ";
		else if (cells[owner] !== "\t" || tabOwner[owner] !== undefined) row += " ";
	}
	return row;
}

/** The pre-#575 rule: skip as many screen columns as the command is long. */
function countedEcho(lines: string[], command: string): string[] {
	let start = 1;
	const first = lines[0] ?? "";
	const prompt = first.match(/^\[[^\]\r\n]*\][^\r\n]*?>\s?/);
	let consumed = prompt ? first.length - prompt[0].length : first.length;
	while (consumed < command.length && start < lines.length) {
		consumed += (lines[start] ?? "").length;
		start += 1;
	}
	return lines.slice(start);
}

function trimTrailingPrompts(lines: string[]): string[] {
	const body = [...lines];
	while (body.length > 0) {
		const last = body[body.length - 1] as string;
		if (last.length === 0 || ROUTEROS_PROMPT_RE.test(last)) {
			body.pop();
			continue;
		}
		break;
	}
	return body;
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
		return {
			output: extractCommandOutput(raw, cli, this.options.cols),
			raw,
		};
	}

	/**
	 * Validate a command without running it, using a single console `:parse`.
	 * Throws `validation/syntax` for malformed CLI and
	 * `validation/unknown-attribute` for a rejected parameter; returns the parsed
	 * form on success. One gate covers both because the console prints the
	 * `:parse` return value, which carries `bad parameter <name>` as well as the
	 * `(<%%` / `(line N column M)` syntax diagnostics — see
	 * {@link classifyParseResult} for the full grammar and why the matcher is
	 * anchored to the diagnostic shape rather than to bare words.
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

/*
 * The `:parse` diagnostic grammar, anchored to where RouterOS actually emits
 * each shape. Anchoring is load-bearing, not cosmetic: an *accepted* return
 * echoes the script body, so `:put "bad parameter x"` comes back as
 * `(evl /putmessage=bad parameter x)`. An unanchored search reads that echoed
 * content as a verdict and refuses to run a valid command (GH#230).
 *
 * Two shapes, both corpus-verified against lsp-routeros-ts
 * `parseil_results.il_text` (2736 rows, RouterOS 7.20.8/7.22.1/7.23rc1):
 *
 *   1. WRAPPED — the diagnostic sits inside the returned value, marked by the
 *      `(evl ` / `(<%%` wrapper. It can appear mid-return, because a
 *      multi-statement script reports the offending statement in place. Every
 *      corpus `bad parameter` (8/8) follows `(evl `, and every `bad command
 *      name` (135/135) follows `(<%%`.
 *   2. BARE — the diagnostic *is* the whole return, printed on its own line
 *      with RouterOS's position suffix. All 425 corpus rows of this shape are
 *      the entire return; none appear embedded. Requiring both line-start and
 *      the `(line N column M)` suffix is what separates a real verdict from
 *      echoed body text. The pinned 7.23.5/7.24.2/7.25beta3 captures add no
 *      new heads beyond `syntax error`, `expected …` and `missing …`
 *      (`missing closing brace`, `missing value for where`; GH#375).
 */
const WRAPPED_BAD_PARAMETER = /\(evl\s+bad parameter\s+(\S+)/i;
const WRAPPED_BAD_COMMAND = /\(<%%\s*bad command name\b/i;
const BARE_BAD_PARAMETER =
	/^[ \t]*bad parameter\s+(\S+)[^\n]*\(line \d+ column \d+\)/im;
const BARE_SYNTAX =
	/^[ \t]*(?:syntax error|bad command name|(?:expected|missing) [a-z]+(?: [a-z]+)*)[^\n]*\(line \d+ column \d+\)/im;

/**
 * Whether the printed value of `:parse` carries a rejection, by the same
 * position-anchored grammar {@link classifyParseResult} throws on. For probes
 * and censuses that need the verdict as a boolean. On the schema-5 corpus it
 * agrees with the upstream `response_class` on every one of 5,640 channel and
 * legacy observations (#498).
 */
export function isParseRejection(output: string): boolean {
	return (
		WRAPPED_BAD_PARAMETER.test(output) ||
		BARE_BAD_PARAMETER.test(output) ||
		WRAPPED_BAD_COMMAND.test(output) ||
		BARE_SYNTAX.test(output)
	);
}

/**
 * Classify the printed value of `:put [:parse "<cli>"]`. Grounded on CHR 7.23.3
 * (see GH#230): `:parse` *never* throws — it returns a value whose text carries
 * the verdict. For a bare menu path the accepted form is `(evl /canonical/path)`
 * (abbreviations expanded); for script-shaped input the accepted return echoes
 * the statement body and may contain arbitrary text — including text that looks
 * like a diagnostic. Rejections are therefore matched only in the positions
 * RouterOS emits them (see the grammar note above): wrapped as
 * `(evl bad parameter <name> (line N column M) /path)` /
 * `(<%% bad command name <name> (line N column M) a;b;c)`, or bare and
 * line-initial as `expected … (line N column M)` / `missing … (line N column
 * M)` / `syntax error (line N column M)`. A single `:parse` covers both the syntax and the unknown-attribute
 * (name-level) gate on every transport — REST and native API expose the same text
 * in the `ret` value (HTTP 200 / `as-string`), the console transports print it.
 *
 * Throws the matching `validation/*` error; returns on a clean parse.
 */
export function classifyParseResult(
	output: string,
	cli: string,
	via: string = "mac-telnet",
): void {
	// The `:parse` rejection carries RouterOS's authoritative byte offset
	// (`… (line N column M)`); surface it as the structured `error.position`.
	const position = parseRouterOsPosition(output);
	const unknown =
		output.match(WRAPPED_BAD_PARAMETER) ?? output.match(BARE_BAD_PARAMETER);
	if (unknown) {
		throw new CentrsError({
			code: "validation/unknown-attribute",
			summary: `RouterOS rejected the parameter "${cleanToken(unknown[1] ?? "")}" while parsing the command.`,
			remediation:
				"Remove or rename the attribute; check it against the RouterOS path's parameters.",
			context: {
				command: cli,
				parameter: cleanToken(unknown[1] ?? ""),
				validationSource: `:put [:parse ...] over ${via}`,
				detail: output,
			},
			...(position ? { position } : {}),
		});
	}
	if (WRAPPED_BAD_COMMAND.test(output) || BARE_SYNTAX.test(output)) {
		// An absent menu reads as a syntax error; name it instead (GH#361).
		const absent = absentMenuError(cli, output, position, via);
		if (absent) throw absent;
		throw new CentrsError({
			code: "validation/syntax",
			summary: "RouterOS rejected the command syntax while parsing it.",
			remediation: SYNTAX_REJECTED_REMEDIATION,
			context: {
				command: cli,
				validationSource: `:put [:parse ...] over ${via}`,
				detail: output,
			},
			...(position ? { position } : {}),
		});
	}
}

function cleanToken(token: string): string {
	return token.replace(/^["'`]+|["'`.,;:)]+$/g, "");
}
