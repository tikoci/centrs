import {
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

export const executeCommand: CliCommandMetadata = {
	name: "execute",
	usage: "centrs execute <target> <command> [flags]",
	summary: "Run a RouterOS read or write command via native API or REST.",
	options: [
		{
			flag: "--via",
			valueName: "<native-api|rest-api>",
			description: "Pin the protocol selector; no silent downgrade when set.",
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
			flag: "--username",
			valueName: "<name>",
			description: "RouterOS username. Falls back to `CENTRS_USERNAME`.",
		},
		{
			flag: "--password",
			valueName: "<secret>",
			description: "RouterOS password. Falls back to `CENTRS_PASSWORD`.",
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
			description: "Output format for the CLI response.",
		},
		{
			flag: "--json",
			description: "Shortcut for `--format json`.",
		},
		{
			flag: "--verbose",
			description: "Include additional context in text output.",
		},
	],
};

interface ExecuteCliArgs extends ExecuteRequest {
	help?: boolean;
	format?: ExecuteOutputFormat;
}

function parseExecuteCliArgs(args: readonly string[]): ExecuteCliArgs {
	const parsed: ExecuteCliArgs = { command: "" };
	const positional: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) {
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
			case "--username":
				parsed.username = expectValue(args, ++index, arg);
				break;
			case "--password":
				parsed.password = expectValue(args, ++index, arg);
				break;
			case "--cdb-file":
				parsed.cdbFile = expectValue(args, ++index, arg);
				break;
			case "--cdb-password":
				parsed.cdbPassword = expectValue(args, ++index, arg);
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
	let parsed: ExecuteCliArgs;
	try {
		parsed = parseExecuteCliArgs(args);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (parsed.help) {
		console.log(renderCommandHelp(describeCentrs(), executeCommand));
		return 0;
	}

	const envelope = await executeEnvelope(parsed);
	const rendered = renderExecuteEnvelope(envelope, parsed.format ?? "json", {
		verbose: parsed.verbose,
	});
	if (envelope.ok) {
		console.log(rendered);
		return 0;
	}
	console.error(rendered);
	return 1;
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
