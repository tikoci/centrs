/**
 * `centrs execute` CLI stub.
 *
 * Parses positionals/flags and `--help`, then reports a structured
 * `validation/not-implemented` envelope (JSON/YAML) or text error. The full
 * execute loop — protocol selection, write confirmation, and per-protocol
 * wiring — lands in WP-1c. This stub keeps the command discoverable and the
 * CLI dispatch surface complete without pretending to run anything.
 */

import { CentrsError, formatCentrsErrorText } from "../errors.ts";
import { describeCentrs } from "../index.ts";
import {
	type CliCommandMetadata,
	expectValue,
	renderCommandHelp,
} from "./common.ts";

export const executeCommand: CliCommandMetadata = {
	name: "execute",
	usage: "centrs execute <target> <command> [flags]",
	summary:
		"Run a RouterOS command through the shared core (not implemented yet — WP-1c).",
	options: [
		{
			flag: "--via",
			valueName: "<protocol>",
			description: "Pin the protocol selector for the execute path.",
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
			flag: "--format",
			valueName: "<text|json|yaml>",
			description: "Output format for the CLI response.",
		},
		{
			flag: "--json",
			description: "Shortcut for `--format json`.",
		},
	],
};

interface ExecuteCliArgs {
	help?: boolean;
	format?: "text" | "json" | "yaml";
	positional: string[];
}

function parseExecuteCliArgs(args: readonly string[]): ExecuteCliArgs {
	const parsed: ExecuteCliArgs = { positional: [] };

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) {
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
			case "--format": {
				const value = expectValue(args, ++index, arg);
				if (value !== "text" && value !== "json" && value !== "yaml") {
					throw new Error(
						`--format must be one of text, json, yaml; got ${value}.`,
					);
				}
				parsed.format = value;
				break;
			}
			default:
				// The stub does not interpret execute-specific flags yet; collect
				// positionals and skip any flag values so parsing stays forgiving.
				if (arg.startsWith("-")) {
					if (
						args[index + 1] !== undefined &&
						!args[index + 1]?.startsWith("-")
					) {
						index += 1;
					}
					break;
				}
				parsed.positional.push(arg);
				break;
		}
	}

	return parsed;
}

export async function runExecuteCli(args: readonly string[]): Promise<number> {
	const parsed = parseExecuteCliArgs(args);
	if (parsed.help) {
		console.log(renderCommandHelp(describeCentrs(), executeCommand));
		return 0;
	}

	const error = new CentrsError({
		code: "validation/not-implemented",
		summary: "`centrs execute` is not implemented yet.",
		remediation:
			"Use `centrs retrieve` for read paths today; execute lands in a later work package (WP-1c).",
		context: { target: parsed.positional[0], command: parsed.positional[1] },
	});

	if (parsed.format === "json") {
		console.error(JSON.stringify(serializeStubError(error), null, 2));
	} else if (parsed.format === "yaml") {
		console.error(toStubYaml(serializeStubError(error)));
	} else {
		console.error(formatCentrsErrorText(error));
	}
	return 1;
}

function serializeStubError(error: CentrsError): {
	ok: false;
	error: ReturnType<CentrsError["toJSON"]>;
	warnings: never[];
} {
	return { ok: false, error: error.toJSON(), warnings: [] };
}

function toStubYaml(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
