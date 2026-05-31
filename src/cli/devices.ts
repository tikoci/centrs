/**
 * `centrs devices` CLI surface: command metadata, subcommand parsing, dispatch,
 * and error-to-envelope rendering. Behavior, flags, exit codes, and output are
 * unchanged from the former monolithic `cli.ts`.
 */

import { asCentrsError, formatCentrsErrorText } from "../errors.ts";
import {
	buildDevicesErrorEnvelope,
	type DevicesCommand,
	type DevicesEnvelope,
	type DevicesOutputFormat,
	describeCentrs,
	devicesOutputFormats,
	listDevices,
	listGroups,
	loadCdb,
	renderDevicesEnvelope,
	resolveDevicesSettings,
	showDevice,
} from "../index.ts";
import {
	type CliCommandMetadata,
	expectValue,
	renderCommandHelp,
} from "./common.ts";

export const devicesCommand: CliCommandMetadata = {
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

export async function runDevicesCli(args: readonly string[]): Promise<number> {
	let parsed: DevicesCliArgs | undefined;
	let envSnapshot: Record<string, string | undefined> | undefined;
	try {
		parsed = parseDevicesCliArgs(args);
		if (parsed.help) {
			console.log(renderCommandHelp(describeCentrs(), devicesCommand));
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
