/**
 * `centrs terminal` CLI surface: open an interactive RouterOS console over
 * mac-telnet. Device output streams to **stdout**; a pre-stream failure renders
 * the standard error envelope to **stderr** and exits 1. Mirrors the shape of
 * `./transfer.ts`. The process-backed {@link TerminalIo} lives here (it touches
 * `process.*`); the core relay in `../terminal.ts` stays io-agnostic.
 */

import { asCentrsError, formatCentrsErrorText } from "../errors.ts";
import {
	buildTerminalErrorEnvelope,
	describeCentrs,
	runTerminal,
	type TerminalIo,
	type TerminalRequest,
} from "../index.ts";
import { toYaml } from "../retrieve.ts";
import {
	type CliCommandMetadata,
	expectValue,
	renderCommandHelp,
} from "./common.ts";

export const terminalCommand: CliCommandMetadata = {
	name: "terminal",
	usage: "centrs terminal <router> [flags]",
	summary: "Open an interactive RouterOS console (ssh or mac-telnet).",
	options: [
		{
			flag: "--via",
			valueName: "<method>",
			description:
				"Transport: `ssh` (host target, default) or `mac-telnet` (MAC target, default for a MAC). rest/native have no terminal capability.",
		},
		{
			flag: "--host",
			valueName: "<host>",
			description:
				"Override the target host (ssh) / UDP delivery host (mac-telnet, default L2 broadcast).",
		},
		{
			flag: "--port",
			valueName: "<port>",
			description:
				"Override the port: ssh default 22, mac-telnet default 20561.",
		},
		{
			flag: "--username / --user / -u",
			valueName: "<name>",
			description:
				"RouterOS username (aliases --user, -u). Falls back to CENTRS_USERNAME.",
		},
		{
			flag: "--password",
			valueName: "<secret>",
			description: "RouterOS password. Falls back to CENTRS_PASSWORD.",
		},
		{
			flag: "--source-mac",
			valueName: "<mac>",
			description:
				"mac-telnet: explicit in-packet source MAC (overrides egress resolution).",
		},
		{
			flag: "--ssh-key",
			valueName: "<path>",
			description:
				"`--via ssh`: explicit private-key path. Falls back to `CENTRS_SSH_KEY` / the `ssh-agent`.",
		},
		{
			flag: "--insecure",
			description:
				"`--via ssh`: disable host-key verification (accepts changed/impersonated keys). Default verifies.",
		},
		{
			flag: "--cdb-file",
			valueName: "<path>",
			description: "Read target credentials from a WinBox CDB file.",
		},
		{
			flag: "--cdb-password",
			valueName: "<password>",
			description: "Decrypt an encrypted WinBox CDB file.",
		},
		{
			flag: "--resolve",
			valueName: "<none|arp>",
			description:
				"`--via ssh` only: turn a MAC target into an IP. CDB-first; `arp` opts into the host ARP cache (default none). The mac-telnet default ignores it.",
		},
		{
			flag: "--format",
			valueName: "<text|json|yaml>",
			description:
				"Error-envelope format on failure. --json / --yaml shortcuts.",
		},
		{ flag: "--json", description: "Shortcut for --format json." },
		{ flag: "--yaml", description: "Shortcut for --format yaml." },
		{ flag: "--verbose", description: "Verbose error output." },
	],
};

/** A `TerminalIo` backed by the real process stdin/stdout/SIGWINCH. */
function processTerminalIo(): TerminalIo {
	const stdin = process.stdin;
	const stdout = process.stdout;
	const isInteractive = Boolean(stdin.isTTY && stdout.isTTY);
	let dataListener: ((chunk: Buffer) => void) | undefined;
	let endListener: (() => void) | undefined;
	let resizeListener: (() => void) | undefined;
	return {
		isInteractive,
		size() {
			return { rows: stdout.rows ?? 9999, cols: stdout.columns ?? 512 };
		},
		writeOutput(bytes) {
			stdout.write(bytes);
		},
		readInput(onChunk, onEnd) {
			if (isInteractive && typeof stdin.setRawMode === "function") {
				stdin.setRawMode(true);
			}
			dataListener = (chunk: Buffer) => onChunk(new Uint8Array(chunk));
			endListener = onEnd;
			stdin.on("data", dataListener);
			stdin.on("end", endListener);
			stdin.resume();
		},
		onResize(listener) {
			resizeListener = listener;
			process.on("SIGWINCH", listener);
		},
		cleanup() {
			if (dataListener) stdin.off("data", dataListener);
			if (endListener) stdin.off("end", endListener);
			if (resizeListener) process.off("SIGWINCH", resizeListener);
			if (isInteractive && typeof stdin.setRawMode === "function") {
				try {
					stdin.setRawMode(false);
				} catch {
					/* tty already restored / detached */
				}
			}
			stdin.pause();
		},
	};
}

export async function runTerminalCli(args: readonly string[]): Promise<number> {
	let request: TerminalRequest | undefined;
	try {
		const parsed = parseTerminalCliArgs(args);
		if (parsed.help) {
			console.log(renderCommandHelp(describeCentrs(), terminalCommand));
			return 0;
		}
		request = parsed.request;
		return await runTerminal(request, processTerminalIo());
	} catch (error) {
		// Render errors from `args` and the (credential-free) error only — never the
		// parsed `request`, which holds the raw password for auth. CodeQL still
		// reports js/clear-text-logging on any CLI error render (it follows the
		// password parsed earlier in this function); the password reaches neither the
		// error nor these renderers, so the alert is dismissed as a false positive
		// repo-wide — see the matching dismissals on src/cli/{transfer,execute}.ts.
		const format = inferRequestedFormat(args);
		if (format === "json" || format === "yaml") {
			const envelope = buildTerminalErrorEnvelope(error);
			console.error(
				format === "yaml" ? toYaml(envelope) : JSON.stringify(envelope),
			);
		} else {
			console.error(
				formatCentrsErrorText(
					asCentrsError(error, {
						code: "input/invalid-command",
						summary: error instanceof Error ? error.message : String(error),
						remediation:
							"Use `centrs terminal --help` for the supported command shape and flags.",
					}),
					{ verbose: args.includes("--verbose") },
				),
			);
		}
		return 1;
	}
}

interface ParsedTerminal {
	help?: boolean;
	request: TerminalRequest;
}

function parseTerminalCliArgs(args: readonly string[]): ParsedTerminal {
	const flags: TerminalRequest = {};
	const positional: string[] = [];
	let help = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) {
			continue;
		}
		switch (arg) {
			case "--help":
			case "-h":
				help = true;
				break;
			case "--via":
				flags.via = expectValue(args, ++index, arg);
				break;
			case "--host":
				flags.host = expectValue(args, ++index, arg);
				break;
			case "--port":
				flags.port = Number.parseInt(expectValue(args, ++index, arg), 10);
				break;
			case "--user":
			case "-u":
			case "--username":
				flags.username = expectValue(args, ++index, arg);
				break;
			case "--password":
				flags.password = expectValue(args, ++index, arg);
				break;
			case "--source-mac":
				flags.sourceMac = expectValue(args, ++index, arg);
				break;
			case "--ssh-key":
				flags.sshKey = expectValue(args, ++index, arg);
				break;
			case "--insecure":
				flags.insecure = true;
				break;
			case "--cdb-file":
				flags.cdbFile = expectValue(args, ++index, arg);
				break;
			case "--cdb-password":
				flags.cdbPassword = expectValue(args, ++index, arg);
				break;
			case "--resolve":
				flags.resolve = expectValue(args, ++index, arg);
				break;
			case "--format":
				flags.format = expectValue(args, ++index, arg);
				break;
			case "--json":
				flags.format = "json";
				break;
			case "--yaml":
				flags.format = "yaml";
				break;
			case "--verbose":
				flags.verbose = true;
				break;
			default:
				if (arg.startsWith("-")) {
					throw asCentrsError(new Error(`Unknown terminal flag: ${arg}`), {
						code: "input/invalid-command",
						summary: `Unknown terminal flag: ${arg}`,
						remediation:
							"Remove the flag or run `centrs terminal --help` for the supported options.",
					});
				}
				positional.push(arg);
				break;
		}
	}

	if (help) {
		return { help: true, request: {} };
	}
	const targetInput = positional[0];
	if (!targetInput) {
		throw asCentrsError(new Error("terminal requires a <router> target."), {
			code: "input/invalid-command",
			summary: "`centrs terminal` requires a <router> target.",
			remediation:
				"Pass the device MAC (or a CDB identity/ip) as the first argument; run `centrs terminal --help` for the shape.",
		});
	}
	flags.targetInput = targetInput;
	return { request: flags };
}

function inferRequestedFormat(
	args: readonly string[],
	requestFormat?: string,
): "text" | "json" | "yaml" {
	const candidate =
		requestFormat ?? formatFromArgs(args) ?? process.env["CENTRS_FORMAT"];
	if (candidate === "json" || candidate === "yaml" || candidate === "text") {
		return candidate;
	}
	return "text";
}

function formatFromArgs(args: readonly string[]): string | undefined {
	if (args.includes("--json")) return "json";
	if (args.includes("--yaml")) return "yaml";
	const index = args.indexOf("--format");
	return index !== -1 ? args[index + 1] : undefined;
}
