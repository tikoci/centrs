import { asCentrsError, formatCentrsErrorText } from "../errors.ts";
import {
	buildExecuteErrorEnvelope,
	type ExecuteOutputFormat,
	type ExecuteRequest,
	executeEnvelope,
	executeOutputFormats,
	renderExecuteEnvelope,
} from "../execute.ts";
import { describeCentrs } from "../index.ts";
import {
	type CliCommandMetadata,
	expectValue,
	renderCommandHelp,
} from "./common.ts";
import {
	buildTargetSelectionTips,
	cdbFileFromArgs,
	formatTipsText,
	isMissingTargetError,
	missingTargetError,
	withTips,
} from "./missing-target.ts";

export const executeCommand: CliCommandMetadata = {
	name: "execute",
	usage: "centrs execute <target> <command> [flags]",
	summary:
		"Run a RouterOS read or write command via native API, REST, or mac-telnet.",
	options: [
		{
			flag: "--via",
			valueName: "<native-api|rest-api|mac-telnet>",
			description:
				"Pin the protocol selector; no silent downgrade when set. A bare MAC target defaults to mac-telnet.",
		},
		{
			flag: "--host",
			valueName: "<host|url>",
			description: "Override the resolved host or base URL for the target.",
		},
		{
			flag: "--port",
			valueName: "<port>",
			description: "Override the resolved management port.",
		},
		{
			flag: "--username / --user / -u",
			valueName: "<name>",
			description:
				"RouterOS username (aliases `--user`, `-u`). Falls back to `CENTRS_USERNAME`.",
		},
		{
			flag: "--password",
			valueName: "<secret>",
			description: "RouterOS password. Falls back to `CENTRS_PASSWORD`.",
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
				"Disable SSH host-key verification (`--via ssh`: accepts changed/impersonated keys, not just new) or accept a self-signed `api-ssl` TLS cert. Default verifies.",
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
				"Resolve a MAC-address target to an IP via the host ARP cache (default none).",
		},
		{
			flag: "--timeout",
			valueName: "<duration>",
			description: "Per-request timeout (for REST, max 60s).",
		},
		{
			flag: "--validate[=false]",
			description:
				"Run RouterOS :parse and /console/inspect validation before execution (default true).",
		},
		{
			flag: "--yes",
			description:
				"Confirm write-shaped add/set/remove commands in non-interactive runs.",
		},
		{
			flag: "--max-results",
			valueName: "<bytes>",
			description: "Fail if the rendered envelope exceeds this byte budget.",
		},
		{
			flag: "--format",
			valueName: "<text|json|yaml>",
			description:
				"Output format for the CLI response. Defaults to text; use --json or --format json for the structured envelope.",
		},
		{
			flag: "--json",
			description: "Shortcut for `--format json`.",
		},
		{
			flag: "--verbose",
			description: "Include additional context in text output.",
		},
		{
			flag: "--",
			description:
				"End centrs option parsing: every following token is the literal RouterOS command, even flag-shaped ones (e.g. `-- /interface print where disabled=yes`).",
		},
	],
};

interface ExecuteCliArgs extends ExecuteRequest {
	help?: boolean;
	format?: ExecuteOutputFormat;
}

export function parseExecuteCliArgs(args: readonly string[]): ExecuteCliArgs {
	const parsed: ExecuteCliArgs = { command: "" };
	const positional: string[] = [];
	let endOfOptions = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) {
			continue;
		}
		// A bare `--` ends centrs option parsing: every later token is part of the
		// literal RouterOS command, even flag-shaped ones. Lets a command carry
		// tokens like `--` / `-foo` (or a value that looks like a flag) without the
		// parser claiming them. `--` itself is consumed, not added to the command.
		if (endOfOptions) {
			positional.push(arg);
			continue;
		}
		if (arg === "--") {
			endOfOptions = true;
			continue;
		}
		if (arg.startsWith("--validate=")) {
			parsed.validate = parseBooleanFlag(arg.slice("--validate=".length), arg);
			continue;
		}
		switch (arg) {
			case "--help":
			case "-h":
				parsed.help = true;
				break;
			case "--json":
				parsed.format = "json";
				break;
			case "--verbose":
				parsed.verbose = true;
				break;
			case "--yes":
				parsed.yes = true;
				break;
			case "--validate":
				parsed.validate = true;
				break;
			case "--no-validate":
				parsed.validate = false;
				break;
			case "--via":
				parsed.via = expectValue(args, ++index, arg);
				break;
			case "--host":
				parsed.host = expectValue(args, ++index, arg);
				break;
			case "--port":
				parsed.port = parseIntegerFlag(expectValue(args, ++index, arg), arg);
				break;
			case "--user":
			case "-u":
			case "--username":
				parsed.username = expectValue(args, ++index, arg);
				break;
			case "--password":
				parsed.password = expectValue(args, ++index, arg);
				break;
			case "--ssh-key":
				parsed.sshKey = expectValue(args, ++index, arg);
				break;
			case "--insecure":
				parsed.insecure = true;
				break;
			case "--cdb-file":
				parsed.cdbFile = expectValue(args, ++index, arg);
				break;
			case "--cdb-password":
				parsed.cdbPassword = expectValue(args, ++index, arg);
				break;
			case "--resolve":
				parsed.resolve = expectValue(args, ++index, arg);
				break;
			case "--timeout":
				parsed.timeout = expectValue(args, ++index, arg);
				break;
			case "--max-results":
				parsed.maxResultsBytes = parseIntegerFlag(
					expectValue(args, ++index, arg),
					arg,
				);
				break;
			case "--format": {
				const value = expectValue(args, ++index, arg);
				if (!executeOutputFormats.includes(value as ExecuteOutputFormat)) {
					throw new Error(
						`--format must be one of ${executeOutputFormats.join(", ")}; got ${value}.`,
					);
				}
				parsed.format = value as ExecuteOutputFormat;
				break;
			}
			default:
				if (arg.startsWith("-")) {
					throw new Error(`Unknown execute flag: ${arg}`);
				}
				positional.push(arg);
				break;
		}
	}

	parsed.targetInput = positional[0];
	parsed.command = positional.slice(1).join(" ");
	parsed.stdinIsTty = process.stdin.isTTY;
	return parsed;
}

export async function runExecuteCli(args: readonly string[]): Promise<number> {
	let parsed: ExecuteCliArgs | undefined;
	try {
		parsed = parseExecuteCliArgs(args);
		if (parsed.help) {
			console.log(renderCommandHelp(describeCentrs(), executeCommand));
			return 0;
		}
		// No positional at all: lead with the missing-target guidance (CDB picker /
		// discover) rather than the missing-command error — there is nothing to run
		// without a device. A lone positional is treated as the target, so the
		// "requires a command" path still fires for `execute <target>`.
		if (!parsed.targetInput) {
			throw missingTargetError({
				command: "execute",
				summary: "`centrs execute` requires a <target> and a RouterOS command.",
				remediation:
					'Pass the router host/identity then the command, e.g. `centrs execute 192.0.2.10 "/system/resource/print"`.',
			});
		}

		const envelope = await executeEnvelope(parsed);
		const resolvedFormat =
			(
				envelope.meta.operation as {
					request?: { format?: ExecuteOutputFormat };
				}
			)?.request?.format ??
			parsed.format ??
			"text";
		const rendered = renderExecuteEnvelope(envelope, resolvedFormat, {
			verbose: parsed.verbose,
		});
		if (envelope.ok) {
			console.log(rendered);
			return 0;
		}
		console.error(rendered);
		return 1;
	} catch (error) {
		// Parse/usage errors land here too: surface them through the same typed
		// envelope as every other runner (no raw message, no exit code 2).
		const format = inferExecuteFormat(args, parsed);
		const tips = isMissingTargetError(error)
			? await buildTargetSelectionTips({
					cdbFile: parsed?.cdbFile ?? cdbFileFromArgs(args),
					env: Bun.env,
				})
			: [];
		if (format === "json" || format === "yaml") {
			const envelope = withTips(
				buildExecuteErrorEnvelope(parsed ?? { command: "" }, error),
				tips,
			);
			console.error(
				renderExecuteEnvelope(envelope, format, {
					verbose: parsed?.verbose ?? false,
				}),
			);
		} else {
			console.error(
				formatCentrsErrorText(
					asCentrsError(error, {
						code: "input/invalid-command",
						summary: error instanceof Error ? error.message : String(error),
						remediation:
							"Use `centrs execute --help` to inspect the supported command shape and flags.",
					}),
					{ verbose: parsed?.verbose ?? args.includes("--verbose") },
				) + formatTipsText(tips),
			);
		}
		return 1;
	}
}

function inferExecuteFormat(
	args: readonly string[],
	parsed?: ExecuteCliArgs,
): ExecuteOutputFormat {
	if (parsed?.format) {
		return parsed.format;
	}
	if (args.includes("--json")) {
		return "json";
	}
	const index = args.indexOf("--format");
	if (index >= 0) {
		const value = args[index + 1];
		if (
			value !== undefined &&
			executeOutputFormats.includes(value as ExecuteOutputFormat)
		) {
			return value as ExecuteOutputFormat;
		}
	}
	return "text";
}

function parseIntegerFlag(value: string, flag: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed)) {
		throw new Error(`${flag} must be an integer; got ${value}.`);
	}
	return parsed;
}

function parseBooleanFlag(value: string, flag: string): boolean {
	if (["true", "1", "yes", "on"].includes(value.toLowerCase())) {
		return true;
	}
	if (["false", "0", "no", "off"].includes(value.toLowerCase())) {
		return false;
	}
	throw new Error(`${flag} must be true or false; got ${value}.`);
}
