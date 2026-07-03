/**
 * `centrs settings` CLI surface: command metadata, subcommand parsing,
 * dispatch, and error-to-envelope rendering. Core logic lives in
 * `../settings.ts`; this file only does CLI-shaped plumbing, mirroring
 * `./devices.ts`'s pattern for the other transport-less command.
 *
 * Bare `centrs settings` (no subcommand) behaves like `print` regardless of
 * TTY — the interactive first-time-setup flow (`@clack/prompts`) is an
 * explicitly deferred later slice (`commands/settings/README.md`), not built
 * here.
 */

import { asCentrsError, formatCentrsErrorText } from "../errors.ts";
import { describeCentrs } from "../index.ts";
import { defaultSettingsPath } from "../resolver/index.ts";
import {
	buildSettingsErrorEnvelope,
	renderSettingsEnvelope,
	type SettingsCommand,
	type SettingsEnvelope,
	type SettingsOutputFormat,
	settingsGet,
	settingsOutputFormats,
	settingsPrint,
	settingsReset,
	settingsSet,
} from "../settings.ts";
import {
	type CliCommandMetadata,
	expectValue,
	renderCommandHelp,
	unknownFlagError,
} from "./common.ts";

export const settingsCommand: CliCommandMetadata = {
	name: "settings",
	usage: "centrs settings [print|get|set|reset] [args] [flags]",
	summary:
		"Manage centrs's own global preferences (centrs.env) and inspect the __default__ CDB record.",
	options: [
		{
			flag: "--all",
			description:
				"`print` only — also list unrecognized CENTRS_* lines found in the file.",
		},
		{
			flag: "--cdb-file",
			valueName: "<path>",
			description:
				"`print` only — CDB to probe for the __default__ record summary (falls back to normal CDB resolution; never centrs.env).",
		},
		{
			flag: "--cdb-password",
			valueName: "<secret>",
			description: "`print` only — decrypt password for the probed CDB.",
		},
		{
			flag: "--skip-env-file",
			description:
				"`print` only — note that other commands in this environment would not see centrs.env (settings itself always reads the real file).",
		},
		{
			flag: "--format",
			valueName: `<${settingsOutputFormats.join("|")}>`,
			description: "Output format for the CLI response.",
		},
		{ flag: "--json", description: "Shortcut for `--format json`." },
		{ flag: "--help", description: "Show this help." },
	],
};

type SettingsSubcommand = SettingsCommand;

interface SettingsCliArgs {
	help?: boolean;
	subcommand: SettingsSubcommand;
	attr?: string;
	value?: string;
	all?: boolean;
	cdbFile?: string;
	cdbPassword?: string;
	skipEnvFile?: boolean;
	format?: SettingsOutputFormat;
}

function parseSettingsCliArgs(args: readonly string[]): SettingsCliArgs {
	const positional: string[] = [];
	let help = false;
	let all = false;
	let cdbFile: string | undefined;
	let cdbPassword: string | undefined;
	let skipEnvFile = false;
	let format: SettingsOutputFormat | undefined;

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
			case "--all":
				all = true;
				break;
			case "--cdb-file":
				cdbFile = expectValue(args, ++index, arg);
				break;
			case "--cdb-password":
				cdbPassword = expectValue(args, ++index, arg);
				break;
			case "--skip-env-file":
				skipEnvFile = true;
				break;
			case "--format": {
				const value = expectValue(args, ++index, arg);
				if (!settingsOutputFormats.includes(value as SettingsOutputFormat)) {
					throw new Error(
						`--format must be one of ${settingsOutputFormats.join(", ")}; got ${value}.`,
					);
				}
				format = value as SettingsOutputFormat;
				break;
			}
			case "--json":
				format = "json";
				break;
			default:
				if (arg.startsWith("-")) {
					throw unknownFlagError("settings", arg, settingsCommand.options);
				}
				positional.push(arg);
				break;
		}
	}

	const result: SettingsCliArgs = {
		help,
		subcommand: "print",
		all,
		cdbFile,
		cdbPassword,
		skipEnvFile,
		format,
	};
	if (help) {
		return result;
	}

	const [rawSub, ...rest] = positional;
	// Bare `centrs settings` (no subcommand at all) behaves like `print`.
	if (rawSub === undefined) {
		return result;
	}

	const subcommands: readonly SettingsSubcommand[] = [
		"print",
		"get",
		"set",
		"reset",
	];
	if (!subcommands.includes(rawSub as SettingsSubcommand)) {
		throw new Error(
			`Unknown settings subcommand: ${rawSub}. Use print, get, set, or reset (or omit the subcommand for print).`,
		);
	}
	result.subcommand = rawSub as SettingsSubcommand;

	if (result.subcommand === "print" || result.subcommand === "reset") {
		if (rest.length > 1) {
			throw new Error(
				`\`centrs settings ${result.subcommand}\` accepts at most one <attr>.`,
			);
		}
		result.attr = rest[0];
	} else if (result.subcommand === "get") {
		if (rest.length !== 1) {
			throw new Error("`centrs settings get` requires exactly one <attr>.");
		}
		result.attr = rest[0];
	} else if (result.subcommand === "set") {
		if (rest.length !== 2) {
			throw new Error("`centrs settings set` requires exactly <attr> <value>.");
		}
		result.attr = rest[0];
		result.value = rest[1];
	}

	return result;
}

export async function runSettingsCli(args: readonly string[]): Promise<number> {
	let parsed: SettingsCliArgs | undefined;
	let envSnapshot: Record<string, string | undefined> | undefined;
	try {
		parsed = parseSettingsCliArgs(args);
		if (parsed.help) {
			console.log(renderCommandHelp(describeCentrs(), settingsCommand));
			return 0;
		}

		envSnapshot = Bun.env;
		let envelope: SettingsEnvelope<unknown>;
		switch (parsed.subcommand) {
			case "print":
				envelope = await settingsPrint({
					attr: parsed.attr,
					all: parsed.all,
					env: envSnapshot,
					skipEnvFile: parsed.skipEnvFile,
					cdbFile: parsed.cdbFile,
					cdbPassword: parsed.cdbPassword,
				});
				break;
			case "get":
				if (!parsed.attr) {
					throw new Error("Missing <attr> for settings get.");
				}
				envelope = await settingsGet({ attr: parsed.attr, env: envSnapshot });
				break;
			case "set":
				if (!parsed.attr || parsed.value === undefined) {
					throw new Error("Missing <attr> <value> for settings set.");
				}
				envelope = await settingsSet({
					attr: parsed.attr,
					value: parsed.value,
					env: envSnapshot,
				});
				break;
			case "reset":
				envelope = await settingsReset({
					attr: parsed.attr,
					env: envSnapshot,
				});
				break;
			default:
				throw new Error("Unreachable settings subcommand.");
		}

		const format = parsed.format ?? "text";
		console.log(renderSettingsEnvelope(envelope, format));
		return 0;
	} catch (error) {
		const format = parsed?.format ?? inferSettingsFormat(args);
		const settingsFile = defaultSettingsPath(envSnapshot ?? Bun.env);
		const centrsError = asCentrsError(error, {
			code: "input/invalid-command",
			summary: error instanceof Error ? error.message : String(error),
			remediation:
				"Use `centrs settings --help` to inspect the supported subcommands and flags.",
		});
		const envelope = buildSettingsErrorEnvelope(
			parsed?.subcommand ?? "print",
			settingsFile,
			[],
			centrsError,
		);
		if (format === "json" || format === "yaml") {
			console.error(renderSettingsEnvelope(envelope, format));
		} else {
			console.error(formatCentrsErrorText(centrsError));
		}
		return 1;
	}
}

function inferSettingsFormat(args: readonly string[]): SettingsOutputFormat {
	if (args.includes("--json")) {
		return "json";
	}
	const formatIndex = args.indexOf("--format");
	const value = formatIndex >= 0 ? args[formatIndex + 1] : undefined;
	if (value && settingsOutputFormats.includes(value as SettingsOutputFormat)) {
		return value as SettingsOutputFormat;
	}
	return "text";
}
