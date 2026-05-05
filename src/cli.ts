#!/usr/bin/env bun

import { asCentrsError, formatCentrsErrorText } from "./errors.ts";
import {
	buildRetrieveErrorEnvelope,
	describeCentrs,
	plannedProtocols,
	plannedSurfaces,
	type RetrieveOutputFormat,
	type RetrieveRequest,
	renderRetrieveEnvelope,
	retrieve,
	retrieveOutputFormats,
} from "./index.ts";

interface CliCommandOption {
	flag: string;
	valueName?: string;
	description: string;
}

interface CliCommandMetadata {
	name: string;
	usage: string;
	summary: string;
	options: readonly CliCommandOption[];
}

const retrieveCommand: CliCommandMetadata = {
	name: "retrieve",
	usage: "centrs retrieve <target> <routeros-path> [flags]",
	summary:
		"Read RouterOS values through the shared core using the selected protocol.",
	options: [
		{
			flag: "--via",
			valueName: "<protocol>",
			description:
				"Required protocol selector for the alpha slice. Use `rest-api`.",
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
			flag: "--timeout",
			valueName: "<ms|5s>",
			description:
				"Operation timeout. REST currently rejects values above 60s.",
		},
		{
			flag: "--attribute",
			valueName: "<name>",
			description: "Project one attribute. May be repeated.",
		},
		{
			flag: "--attributes",
			valueName: "<a,b>",
			description: "Project a comma-separated attribute list.",
		},
		{
			flag: "--all-attributes",
			description: "Request the RouterOS detail/all-attributes shape.",
		},
		{
			flag: "--list-attributes",
			description:
				"List inspect-derived attributes without running the data call.",
		},
		{
			flag: "--format",
			valueName: `<${retrieveOutputFormats.join("|")}>`,
			description: "Output format for the CLI response.",
		},
		{
			flag: "--json",
			description: "Shortcut for `--format json`.",
		},
		{
			flag: "--max-results",
			valueName: "<bytes>",
			description:
				"Fail instead of printing output larger than the given byte budget.",
		},
		{
			flag: "--validate / --no-validate",
			description: "Enable or disable inspect-backed preflight validation.",
		},
		{
			flag: "--verbose",
			description: "Show resolved setting sources in text output.",
		},
	],
};

export function renderCliHelp(): string {
	return [
		describeCentrs(),
		"",
		`Surfaces: ${plannedSurfaces.join(", ")}`,
		`Protocols: ${plannedProtocols.join(", ")}`,
		"",
		"Commands:",
		`  ${retrieveCommand.name.padEnd(12)} ${retrieveCommand.summary}`,
		"",
		"Use `centrs retrieve --help` for command-specific options.",
	].join("\n");
}

export function renderCommandHelp(command: CliCommandMetadata): string {
	return [
		describeCentrs(),
		"",
		command.summary,
		"",
		`Usage: ${command.usage}`,
		"",
		"Options:",
		...command.options.map((option) => {
			const flag = option.valueName
				? `${option.flag} ${option.valueName}`
				: option.flag;
			return `  ${flag.padEnd(28)} ${option.description}`;
		}),
	].join("\n");
}

export async function runCli(
	args: readonly string[] = Bun.argv.slice(2),
): Promise<number> {
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		console.log(renderCliHelp());
		return 0;
	}

	const [command, ...rest] = args;
	if (command === "retrieve") {
		return runRetrieveCli(rest);
	}

	console.error(
		`Unknown centrs command: ${command}\n\nUse \`centrs --help\` to see the available commands.`,
	);
	return 1;
}

async function runRetrieveCli(args: readonly string[]): Promise<number> {
	let request: RetrieveRequest | undefined;

	try {
		request = parseRetrieveCliArgs(args);
		if ((request as { help?: boolean }).help) {
			console.log(renderCommandHelp(retrieveCommand));
			return 0;
		}

		const envelope = await retrieve(request);
		const output = renderRetrieveEnvelope(envelope, envelope.request.format, {
			verbose: request.verbose,
		});
		console.log(output);
		return 0;
	} catch (error) {
		const format = inferRequestedFormat(args, request);
		if (format === "json" || format === "yaml") {
			const envelope = buildRetrieveErrorEnvelope(
				request ?? fallbackRequestFromArgs(args),
				error,
			);
			console.error(
				renderRetrieveEnvelope(envelope, format, {
					verbose: request?.verbose ?? false,
				}),
			);
		} else {
			console.error(
				formatCentrsErrorText(
					asCentrsError(error, {
						code: "input/invalid-command",
						summary: error instanceof Error ? error.message : String(error),
						remediation:
							"Use `centrs retrieve --help` to inspect the supported command shape and flags.",
					}),
					{
						verbose: request?.verbose ?? args.includes("--verbose"),
					},
				),
			);
		}
		return 1;
	}
}

function parseRetrieveCliArgs(args: readonly string[]): RetrieveRequest & {
	help?: boolean;
} {
	const request: RetrieveRequest & { help?: boolean } = {
		path: "",
	};
	const positional: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) {
			continue;
		}
		switch (arg) {
			case "--help":
			case "-h":
				request.help = true;
				break;
			case "--via":
				request.via = expectValue(args, ++index, arg);
				break;
			case "--host":
				request.host = expectValue(args, ++index, arg);
				break;
			case "--port":
				request.port = Number.parseInt(expectValue(args, ++index, arg), 10);
				break;
			case "--username":
				request.username = expectValue(args, ++index, arg);
				break;
			case "--password":
				request.password = expectValue(args, ++index, arg);
				break;
			case "--timeout":
				request.timeout = expectValue(args, ++index, arg);
				break;
			case "--format":
				request.format = expectValue(args, ++index, arg);
				break;
			case "--json":
				request.format = "json";
				break;
			case "--attribute": {
				const value = expectValue(args, ++index, arg);
				request.attribute = [
					...(Array.isArray(request.attribute) ? request.attribute : []),
					value,
				];
				break;
			}
			case "--attributes":
				request.attributes = [
					...(Array.isArray(request.attributes) ? request.attributes : []),
					expectValue(args, ++index, arg),
				];
				break;
			case "--all-attributes":
				request.allAttributes = true;
				break;
			case "--list":
			case "--list-attributes":
				request.listAttributes = true;
				break;
			case "--filter":
				request.filter = expectValue(args, ++index, arg);
				break;
			case "--query":
				request.query = expectValue(args, ++index, arg);
				break;
			case "--max-results":
				request.maxResultsBytes = Number.parseInt(
					expectValue(args, ++index, arg),
					10,
				);
				break;
			case "--validate":
				request.validate = true;
				break;
			case "--no-validate":
				request.validate = false;
				break;
			case "--verbose":
				request.verbose = true;
				break;
			default:
				if (arg.startsWith("-")) {
					throw new Error(`Unknown retrieve flag: ${arg}`);
				}
				positional.push(arg);
				break;
		}
	}

	if (request.help) {
		return request;
	}

	if (positional.length < 2) {
		throw new Error(
			"`centrs retrieve` requires both <target> and <routeros-path>.",
		);
	}

	request.targetInput = positional[0];
	request.path = positional[1] ?? "";
	return request;
}

function expectValue(
	args: readonly string[],
	index: number,
	flag: string,
): string {
	const value = args[index];
	if (value === undefined) {
		throw new Error(`Missing value for ${flag}.`);
	}
	return value;
}

function inferRequestedFormat(
	args: readonly string[],
	request?: RetrieveRequest,
): RetrieveOutputFormat {
	if (request?.format) {
		return request.format as RetrieveOutputFormat;
	}
	if (args.includes("--json")) {
		return "json";
	}
	const formatIndex = args.indexOf("--format");
	if (formatIndex !== -1 && args[formatIndex + 1]) {
		return args[formatIndex + 1] as RetrieveOutputFormat;
	}
	return "text";
}

function fallbackRequestFromArgs(args: readonly string[]): RetrieveRequest {
	const positionals = args.filter((arg) => !arg.startsWith("-"));
	return {
		targetInput: positionals[0],
		path: positionals[1] ?? "",
		format: inferRequestedFormat(args),
	};
}

if (import.meta.main) {
	process.exitCode = await runCli();
}
