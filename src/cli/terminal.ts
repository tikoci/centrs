/**
 * `centrs terminal` CLI surface: open an interactive RouterOS console over
 * mac-telnet. Device output streams to **stdout**; a pre-stream failure renders
 * the standard error envelope to **stderr** and exits 1. Mirrors the shape of
 * `./transfer.ts`. The process-backed {@link TerminalIo} lives here (it touches
 * `process.*`); the core relay in `../terminal.ts` stays io-agnostic.
 */

import { toYaml } from "../core/yaml.ts";
import {
	asCentrsError,
	CentrsError,
	formatCentrsErrorText,
} from "../errors.ts";
import {
	buildTerminalErrorEnvelope,
	describeCentrs,
	runTerminal,
	type TerminalIo,
	type TerminalRequest,
} from "../index.ts";
import {
	type CliCommandMetadata,
	expandEqualsArgs,
	expectValue,
	helpRequested,
	inferCliFormat,
	renderCommandHelp,
	unknownFlagError,
} from "./common.ts";
import {
	buildTargetSelectionTips,
	cdbFileFromArgs,
	formatTipsText,
	isMissingTargetError,
	missingTargetError,
	withTips,
} from "./missing-target.ts";
import { selectionFlagTokens } from "./selection.ts";

export const terminalCommand: CliCommandMetadata = {
	name: "terminal",
	usage:
		"centrs terminal <router> [flags] | centrs terminal --host <host> [flags] | centrs terminal --quickchr <name> [flags]",
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
				"ssh: the host to dial (the target when no <router> is given; no CDB lookup). mac-telnet: the UDP delivery host (default L2 broadcast).",
		},
		{
			flag: "--port",
			valueName: "<port>",
			description:
				"Override the port: ssh default 22, mac-telnet default 20561.",
		},
		{
			flag: "--quickchr",
			valueName: "<name>",
			description:
				"Open an ssh console to one running quickchr machine; host/port/user/key come from its descriptor. Once only; not with <router>, --host, --port, --username, --password, --ssh-key or --match.",
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
			flag: "--match",
			valueName: "<user=name|target=addr|record-type>",
			description:
				"Pick one of several CDB records saved for <router> (as `devices show --match`); single target only.",
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
		const tips = isMissingTargetError(error)
			? await buildTargetSelectionTips({
					cdbFile:
						request?.cdbFile ?? cdbFileFromArgs(args, terminalCommand.options),
					env: Bun.env,
				})
			: [];
		if (format === "json" || format === "yaml") {
			const envelope = withTips(buildTerminalErrorEnvelope(error), tips);
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
				) + formatTipsText(tips),
			);
		}
		return 1;
	}
}

interface ParsedTerminal {
	help?: boolean;
	request: TerminalRequest;
}

export function parseTerminalCliArgs(args: readonly string[]): ParsedTerminal {
	if (helpRequested(args)) {
		return { help: true, request: {} };
	}
	args = expandEqualsArgs(args, terminalCommand.options);
	const flags: TerminalRequest = {};
	const positional: string[] = [];
	const quickchr: string[] = [];
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
				flags.via = expectValue(args, ++index, arg, terminalCommand.options);
				break;
			case "--host":
				flags.host = expectValue(args, ++index, arg, terminalCommand.options);
				break;
			case "--port":
				flags.port = Number.parseInt(
					expectValue(args, ++index, arg, terminalCommand.options),
					10,
				);
				break;
			case "--user":
			case "-u":
			case "--username":
				flags.username = expectValue(
					args,
					++index,
					arg,
					terminalCommand.options,
				);
				break;
			case "--password":
				flags.password = expectValue(
					args,
					++index,
					arg,
					terminalCommand.options,
				);
				break;
			case "--source-mac":
				flags.sourceMac = expectValue(
					args,
					++index,
					arg,
					terminalCommand.options,
				);
				break;
			case "--ssh-key":
				flags.sshKey = expectValue(args, ++index, arg, terminalCommand.options);
				break;
			case "--insecure":
				flags.insecure = true;
				break;
			case "--cdb-file":
				flags.cdbFile = expectValue(
					args,
					++index,
					arg,
					terminalCommand.options,
				);
				break;
			case "--cdb-password":
				flags.cdbPassword = expectValue(
					args,
					++index,
					arg,
					terminalCommand.options,
				);
				break;
			case "--match":
				flags.match = expectValue(args, ++index, arg, terminalCommand.options);
				break;
			case "--resolve":
				flags.resolve = expectValue(
					args,
					++index,
					arg,
					terminalCommand.options,
				);
				break;
			case "--format":
				flags.format = expectValue(args, ++index, arg, terminalCommand.options);
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
			case "--quickchr":
				// One machine is a single-target session (#610); a repeat is fan-out,
				// rejected after the loop with the full list in context.
				quickchr.push(expectValue(args, ++index, arg, terminalCommand.options));
				break;
			default:
				// A single interactive session cannot fan out: reject a target-selection
				// flag with the shared `usage/fanout-not-supported` (mirrors `api --stream`).
				if ((selectionFlagTokens as readonly string[]).includes(arg)) {
					throw new CentrsError({
						code: "usage/fanout-not-supported",
						summary:
							"`centrs terminal` is a single interactive session and cannot fan out across a multi-target selection.",
						remediation:
							"Open a terminal to one router at a time; use `execute` / `api` for multi-target commands.",
						context: { flag: arg, capability: "terminal" },
					});
				}
				if (arg.startsWith("-")) {
					throw unknownFlagError("terminal", arg, terminalCommand.options);
				}
				positional.push(arg);
				break;
		}
	}

	if (help) {
		return { help: true, request: {} };
	}
	if (quickchr.length > 1) {
		throw new CentrsError({
			code: "usage/fanout-not-supported",
			summary:
				"`centrs terminal` is a single interactive session and cannot open several quickchr machines at once.",
			remediation:
				"Pass `--quickchr <name>` once; use `execute` / `api` with repeated `--quickchr` for multi-machine commands.",
			context: {
				flag: "--quickchr",
				capability: "terminal",
				machines: quickchr,
			},
		});
	}
	if (quickchr.length === 1) {
		// A named-live-provider is exclusive (constitution, Resolution providers):
		// a <router> positional is a second target source.
		if (positional.length > 0) {
			throw new CentrsError({
				code: "usage/conflicting-flags",
				summary:
					"`--quickchr` is exclusive: a command targets quickchr machines or CDB/literal targets, not both.",
				remediation:
					"Drop the positional target (or the `--quickchr` flag) so the terminal has one target source.",
				context: { quickchr: [...quickchr], positionals: positional.length },
			});
		}
		flags.quickchr = quickchr[0];
		return { request: flags };
	}
	// The `--host` flag stands in for a missing `<router>` (#428), with no CDB
	// lookup; `CENTRS_HOST` never counts.
	const targetInput = positional[0];
	if (!targetInput && flags.host === undefined) {
		throw missingTargetError({
			command: "terminal",
			summary: "`centrs terminal` requires a <router> target.",
			remediation:
				"Pass the device MAC (or a CDB identity/ip) as the first argument, name an ssh host with `--host <host>`, or a running quickchr machine with `--quickchr <name>`; run `centrs terminal --help` for the shape.",
		});
	}
	if (targetInput) {
		flags.targetInput = targetInput;
	}
	return { request: flags };
}

function inferRequestedFormat(
	args: readonly string[],
	requestFormat?: string,
): "text" | "json" | "yaml" {
	if (requestFormat !== undefined) {
		return requestFormat === "json" ||
			requestFormat === "yaml" ||
			requestFormat === "text"
			? requestFormat
			: "text";
	}
	return inferCliFormat(
		args,
		terminalCommand.options,
		["text", "json", "yaml"] as const,
		"text",
		process.env["CENTRS_FORMAT"],
	);
}
