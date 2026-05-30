#!/usr/bin/env bun

import {
	buildDevicesErrorEnvelope,
	type DevicesCommand,
	type DevicesEnvelope,
	type DevicesOutputFormat,
	devicesOutputFormats,
	listDevices,
	listGroups,
	loadCdb,
	renderDevicesEnvelope,
	resolveDevicesSettings,
	showDevice,
} from "./devices.ts";
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

const devicesCommand: CliCommandMetadata = {
	name: "devices",
	usage: "centrs devices <list|show|groups> [args] [flags]",
	summary:
		"Inspect the CDB-backed device registry (read-only subcommands only in this phase).",
	options: [
		{
			flag: "--cdb-file",
			valueName: "<path>",
			description:
				"Override the resolved CDB path (default `~/.config/tikoci/winbox.cdb`).",
		},
		{
			flag: "--cdb-password",
			valueName: "<secret>",
			description:
				"Decrypt an encrypted CDB. Falls back to `CENTRS_CDB_PASSWORD`.",
		},
		{
			flag: "--group",
			valueName: "<name>",
			description:
				"`list` only — filter to entries whose `group` equals <name>.",
		},
		{
			flag: "--members",
			description: "`groups` only — expand each group's membership.",
		},
		{
			flag: "--explain",
			description:
				"`show` only — include the raw `WinBoxCdbRecord` in `data.record`.",
		},
		{
			flag: "--format",
			valueName: `<${devicesOutputFormats.join("|")}>`,
			description: "Output format for the CLI response.",
		},
		{
			flag: "--json",
			description: "Shortcut for `--format json`.",
		},
	],
};

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
				"Pin the protocol selector. Defaults to `rest-api` for retrieve.",
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
			description: "Output format for the CLI response. Defaults to json.",
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
		`  ${devicesCommand.name.padEnd(12)} ${devicesCommand.summary}`,
		"",
		"Use `centrs <command> --help` for command-specific options.",
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
	if (command === "devices") {
		return runDevicesCli(rest);
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
			case "--cdb-file":
				request.cdbFile = expectValue(args, ++index, arg);
				break;
			case "--cdb-password":
				request.cdbPassword = expectValue(args, ++index, arg);
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
	return "json";
}

function fallbackRequestFromArgs(args: readonly string[]): RetrieveRequest {
	const positionals = args.filter((arg) => !arg.startsWith("-"));
	return {
		targetInput: positionals[0],
		path: positionals[1] ?? "",
		format: inferRequestedFormat(args),
	};
}

interface DevicesCliArgs {
	help?: boolean;
	subcommand?: "list" | "show" | "groups";
	cdbFile?: string;
	cdbPassword?: string;
	group?: string;
	members?: boolean;
	explain?: boolean;
	format?: DevicesOutputFormat;
	target?: string;
}

function parseDevicesCliArgs(args: readonly string[]): DevicesCliArgs {
	const parsed: DevicesCliArgs = {};
	const positional: string[] = [];

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
			case "--cdb-file":
				parsed.cdbFile = expectValue(args, ++index, arg);
				break;
			case "--cdb-password":
				parsed.cdbPassword = expectValue(args, ++index, arg);
				break;
			case "--group":
				parsed.group = expectValue(args, ++index, arg);
				break;
			case "--members":
				parsed.members = true;
				break;
			case "--explain":
				parsed.explain = true;
				break;
			case "--format": {
				const value = expectValue(args, ++index, arg);
				if (!devicesOutputFormats.includes(value as DevicesOutputFormat)) {
					throw new Error(
						`--format must be one of ${devicesOutputFormats.join(", ")}; got ${value}.`,
					);
				}
				parsed.format = value as DevicesOutputFormat;
				break;
			}
			case "--json":
				parsed.format = "json";
				break;
			default:
				if (arg.startsWith("-")) {
					throw new Error(`Unknown devices flag: ${arg}`);
				}
				positional.push(arg);
				break;
		}
	}

	if (parsed.help) {
		return parsed;
	}

	const [sub, ...rest] = positional;
	if (sub === undefined) {
		throw new Error(
			"`centrs devices` requires a subcommand: list, show, or groups.",
		);
	}
	if (sub !== "list" && sub !== "show" && sub !== "groups") {
		throw new Error(
			`Unknown devices subcommand: ${sub}. Use list, show, or groups.`,
		);
	}
	parsed.subcommand = sub;

	if (sub === "show") {
		if (rest.length !== 1) {
			throw new Error("`centrs devices show` requires exactly one <target>.");
		}
		parsed.target = rest[0];
	} else if (rest.length > 0) {
		throw new Error(
			`\`centrs devices ${sub}\` does not accept positional arguments; got: ${rest.join(", ")}.`,
		);
	}

	return parsed;
}

async function runDevicesCli(args: readonly string[]): Promise<number> {
	let parsed: DevicesCliArgs | undefined;
	let envSnapshot: Record<string, string | undefined> | undefined;
	try {
		parsed = parseDevicesCliArgs(args);
		if (parsed.help) {
			console.log(renderCommandHelp(devicesCommand));
			return 0;
		}

		envSnapshot = Bun.env;
		const cdb = await loadCdb({
			cdbFile: parsed.cdbFile,
			cdbPassword: parsed.cdbPassword,
			env: envSnapshot,
		});

		let envelope: DevicesEnvelope<unknown>;
		switch (parsed.subcommand) {
			case "list":
				envelope = listDevices({ cdb, group: parsed.group });
				break;
			case "show":
				if (!parsed.target) {
					throw new Error("Missing <target> for devices show.");
				}
				envelope = showDevice({
					cdb,
					target: parsed.target,
					explain: parsed.explain,
				});
				break;
			case "groups":
				envelope = listGroups({ cdb, withMembers: parsed.members });
				break;
			default:
				throw new Error("Unreachable devices subcommand.");
		}

		const format = parsed.format ?? "text";
		console.log(renderDevicesEnvelope(envelope, format));
		return 0;
	} catch (error) {
		const format = parsed?.format ?? inferDevicesFormat(args);
		const subcommand: DevicesCommand = parsed?.subcommand ?? "list";
		const settings = resolveDevicesSettings({
			cdbFile: parsed?.cdbFile,
			cdbPassword: parsed?.cdbPassword,
			env: envSnapshot ?? Bun.env,
		});
		const centrsError = asCentrsError(error, {
			code: "input/invalid-command",
			summary: error instanceof Error ? error.message : String(error),
			remediation:
				"Use `centrs devices --help` to inspect the supported subcommands and flags.",
		});
		const envelope = buildDevicesErrorEnvelope(
			subcommand,
			settings,
			[],
			centrsError,
		);
		if (format === "json" || format === "yaml") {
			console.error(renderDevicesEnvelope(envelope, format));
		} else {
			console.error(formatCentrsErrorText(centrsError));
		}
		return 1;
	}
}

function inferDevicesFormat(args: readonly string[]): DevicesOutputFormat {
	if (args.includes("--json")) {
		return "json";
	}
	const formatIndex = args.indexOf("--format");
	const value = formatIndex >= 0 ? args[formatIndex + 1] : undefined;
	if (value && devicesOutputFormats.includes(value as DevicesOutputFormat)) {
		return value as DevicesOutputFormat;
	}
	return "text";
}

if (import.meta.main) {
	process.exitCode = await runCli();
}
