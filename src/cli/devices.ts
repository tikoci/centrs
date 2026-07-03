/**
 * `centrs devices` CLI surface: command metadata, subcommand parsing, dispatch,
 * and error-to-envelope rendering. Behavior, flags, exit codes, and output are
 * unchanged from the former monolithic `cli.ts`.
 */

import { asCentrsError, formatCentrsErrorText } from "../errors.ts";
import {
	addDevice,
	buildDevicesErrorEnvelope,
	type CommentKvUpdate,
	type DevicesCommand,
	type DevicesEnvelope,
	type DevicesOutputFormat,
	describeCentrs,
	devicesOutputFormats,
	editInteractiveOnlyError,
	listDevices,
	listGroups,
	loadCdb,
	recordTypeFromName,
	removeDevice,
	renderDevicesEnvelope,
	resolveDevicesSettings,
	setDevice,
	showDevice,
	winBoxCdbRecordType,
} from "../index.ts";
import {
	type CliCommandMetadata,
	expectValue,
	renderCommandHelp,
	unknownFlagError,
} from "./common.ts";

export const devicesCommand: CliCommandMetadata = {
	name: "devices",
	usage: "centrs devices <list|show|groups|add|edit|set|remove> [args] [flags]",
	summary:
		"Inspect and mutate the CDB-backed device registry. `devices` is the only command that writes the CDB.",
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
				"Decrypt an encrypted CDB. Falls back to `CENTRS_CDB_PASSWORD`. Also used to re-encrypt on writes.",
		},
		{
			flag: "--via",
			valueName: "<protocol>",
			description:
				"Resolve and report the protocol source for provenance examples; no network IO is performed.",
		},
		{
			flag: "--group",
			valueName: "<name>",
			description:
				"`list` filter / `add`,`edit` first-class group field for the target entry.",
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
			flag: "--match",
			valueName: "<user=…|target=…|record-type>",
			description:
				"`show` — disambiguate when `<router>` matches several records: `user=<name>`, `target=<addr>`, or a record-type token.",
		},
		{
			flag: "--user",
			valueName: "<name>",
			description: "`add`,`set` — first-class CDB user field.",
		},
		{
			flag: "--password",
			valueName: "<secret>",
			description: "`add`,`set` — first-class CDB password field.",
		},
		{
			flag: "--profile",
			valueName: "<name>",
			description: "`add`,`set` — named WinBox profile (Workspace).",
		},
		{
			flag: "--profile-none",
			description: "`add`,`set` — write the WinBox `<none>` profile sentinel.",
		},
		{
			flag: "--profile-own",
			description: "`add`,`set` — write the WinBox `<own>` profile sentinel.",
		},
		{
			flag: "--session",
			valueName: "<name>",
			description: "`add`,`set` — first-class CDB session field.",
		},
		{
			flag: "--comment",
			valueName: "<text>",
			description: "`add` only — base free-form comment (may include kv-soup).",
		},
		{
			flag: "--record-type",
			valueName: `<${Object.keys(winBoxCdbRecordType).join("|")}>`,
			description: "`add` only — record type (default `ipAdmin`).",
		},
		{
			flag: "--force",
			description: "`add` only — overwrite the existing (target, user) entry.",
		},
		{
			flag: "--strict",
			description:
				"`add`,`set` — reject unknown comment kv keys instead of warning.",
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

type DevicesSubcommand =
	| "list"
	| "show"
	| "groups"
	| "add"
	| "edit"
	| "set"
	| "remove";

/**
 * RouterOS-muscle-memory aliases that resolve silently to the canonical verb
 * (see `commands/AGENTS.md`, Verb vocabulary). Canonical names still win in help
 * text and the usage line; these are a CLI input affordance only — the MCP `op`
 * enum and the API functions stay canonical-only.
 */
const SUBCOMMAND_ALIASES: Readonly<Record<string, DevicesSubcommand>> = {
	print: "list",
	get: "show",
	rm: "remove",
	delete: "remove",
};

interface DevicesCliArgs {
	help?: boolean;
	subcommand?: DevicesSubcommand;
	cdbFile?: string;
	cdbPassword?: string;
	group?: string;
	via?: string;
	members?: boolean;
	explain?: boolean;
	match?: string;
	user?: string;
	password?: string;
	profile?: string;
	profileNone?: boolean;
	profileOwn?: boolean;
	session?: string;
	comment?: string;
	recordType?: string;
	force?: boolean;
	strict?: boolean;
	format?: DevicesOutputFormat;
	target?: string;
	kvArgs?: string[];
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
			case "--via":
				parsed.via = expectValue(args, ++index, arg);
				break;
			case "--members":
				parsed.members = true;
				break;
			case "--explain":
				parsed.explain = true;
				break;
			case "--match":
				parsed.match = expectValue(args, ++index, arg);
				break;
			case "--user":
				parsed.user = expectValue(args, ++index, arg);
				break;
			case "--password":
				parsed.password = expectValue(args, ++index, arg);
				break;
			case "--profile":
				parsed.profile = expectValue(args, ++index, arg);
				break;
			case "--profile-none":
				parsed.profileNone = true;
				break;
			case "--profile-own":
				parsed.profileOwn = true;
				break;
			case "--session":
				parsed.session = expectValue(args, ++index, arg);
				break;
			case "--comment":
				parsed.comment = expectValue(args, ++index, arg);
				break;
			case "--record-type":
				parsed.recordType = expectValue(args, ++index, arg);
				break;
			case "--force":
				parsed.force = true;
				break;
			case "--strict":
				parsed.strict = true;
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
					throw unknownFlagError("devices", arg, devicesCommand.options);
				}
				positional.push(arg);
				break;
		}
	}

	if (parsed.help) {
		return parsed;
	}

	const subcommands: readonly DevicesSubcommand[] = [
		"list",
		"show",
		"groups",
		"add",
		"edit",
		"set",
		"remove",
	];
	const [rawSub, ...rest] = positional;
	if (rawSub === undefined) {
		throw new Error(
			"`centrs devices` requires a subcommand: list, show, groups, add, edit, set, or remove.",
		);
	}
	// Resolve aliases (print/get/rm/delete) to the canonical verb before validating.
	const sub = SUBCOMMAND_ALIASES[rawSub] ?? (rawSub as DevicesSubcommand);
	if (!subcommands.includes(sub)) {
		throw new Error(
			`Unknown devices subcommand: ${rawSub}. Use list, show, groups, add, edit, set, or remove (aliases: print, get, rm, delete).`,
		);
	}
	parsed.subcommand = sub;

	if (sub === "show" || sub === "edit" || sub === "remove") {
		if (rest.length !== 1) {
			throw new Error(
				`\`centrs devices ${sub}\` requires exactly one <target>.`,
			);
		}
		parsed.target = rest[0];
	} else if (sub === "add" || sub === "set") {
		// add/set are symmetric: <target> followed by optional key=value tokens.
		const [target, ...kvArgs] = rest;
		if (target === undefined) {
			throw new Error(
				`\`centrs devices ${sub}\` requires a <target>, optionally followed by key=value tokens.`,
			);
		}
		parsed.target = target;
		parsed.kvArgs = kvArgs;
	} else if (rest.length > 0) {
		throw new Error(
			`\`centrs devices ${sub}\` does not accept positional arguments; got: ${rest.join(", ")}.`,
		);
	}

	return parsed;
}

function parseKvArg(token: string): CommentKvUpdate {
	const eq = token.indexOf("=");
	if (eq <= 0) {
		throw new Error(
			`Invalid kv override "${token}"; expected key=value (use key= to clear a value).`,
		);
	}
	return { key: token.slice(0, eq), value: parseKvValue(token.slice(eq + 1)) };
}

function parseKvValue(value: string): string {
	if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
		return value;
	}
	let parsed = "";
	for (let index = 1; index < value.length - 1; index += 1) {
		const char = value[index];
		if (char === "\\" && index + 1 < value.length - 1) {
			const next = value[index + 1];
			if (next === '"' || next === "\\") {
				parsed += next;
				index += 1;
				continue;
			}
		}
		parsed += char;
	}
	return parsed;
}

/**
 * Resolve the profile field from `--profile` / `--profile-none` / `--profile-own`
 * (mutually exclusive). The sentinels map to the WinBox `<none>` / `<own>`
 * values; returns `undefined` when none was supplied so the field is left
 * unchanged on `set` and defaulted by the builder on `add`.
 */
function resolveProfile(parsed: DevicesCliArgs): string | undefined {
	const supplied = [
		parsed.profile !== undefined,
		parsed.profileNone === true,
		parsed.profileOwn === true,
	].filter(Boolean).length;
	if (supplied > 1) {
		throw new Error(
			"--profile, --profile-none, and --profile-own are mutually exclusive.",
		);
	}
	if (parsed.profileNone) {
		return "<none>";
	}
	if (parsed.profileOwn) {
		return "<own>";
	}
	return parsed.profile;
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
					match: parsed.match,
					via: parsed.via,
					env: envSnapshot,
				});
				break;
			case "groups":
				envelope = listGroups({ cdb, withMembers: parsed.members });
				break;
			case "add": {
				if (!parsed.target) {
					throw new Error("Missing <target> for devices add.");
				}
				let recordType: number | undefined;
				if (parsed.recordType !== undefined) {
					recordType = recordTypeFromName(parsed.recordType);
					if (recordType === undefined) {
						throw new Error(
							`--record-type must be one of ${Object.keys(winBoxCdbRecordType).join(", ")}; got ${parsed.recordType}.`,
						);
					}
				}
				envelope = await addDevice({
					cdb,
					target: parsed.target,
					recordType,
					user: parsed.user,
					password: parsed.password,
					group: parsed.group,
					profile: resolveProfile(parsed),
					session: parsed.session,
					comment: parsed.comment,
					commentKvUpdates: (parsed.kvArgs ?? []).map(parseKvArg),
					force: parsed.force,
					strict: parsed.strict,
				});
				break;
			}
			case "edit":
				// The interactive editor (clack/TUI) is reserved for the future; the
				// non-interactive path is `devices set`.
				throw editInteractiveOnlyError();
			case "set":
				if (!parsed.target) {
					throw new Error("Missing <target> for devices set.");
				}
				envelope = await setDevice({
					cdb,
					target: parsed.target,
					match: parsed.match,
					updates: (parsed.kvArgs ?? []).map(parseKvArg),
					user: parsed.user,
					password: parsed.password,
					group: parsed.group,
					profile: resolveProfile(parsed),
					session: parsed.session,
					strict: parsed.strict,
				});
				break;
			case "remove":
				if (!parsed.target) {
					throw new Error("Missing <target> for devices remove.");
				}
				envelope = await removeDevice({
					cdb,
					target: parsed.target,
					match: parsed.match,
				});
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
			// codeql[js/clear-text-logging] password reaches here only as SettingSource provenance ({kind,key}), never the value — see CommonSettingsMeta.password in src/core/envelope.ts.
			console.error(renderDevicesEnvelope(envelope, format));
		} else {
			// codeql[js/clear-text-logging] password reaches here only as SettingSource provenance ({kind,key}), never the value — see CommonSettingsMeta.password in src/core/envelope.ts.
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
