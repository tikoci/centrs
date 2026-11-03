/**
 * `centrs devices` CLI surface: command metadata, subcommand parsing, dispatch,
 * and error-to-envelope rendering. Behavior, flags, exit codes, and output are
 * unchanged from the former monolithic `cli.ts`.
 */

import {
	asCentrsError,
	CentrsError,
	formatCentrsErrorText,
} from "../errors.ts";
import {
	addDevice,
	type BboxPredicate,
	buildDevicesErrorEnvelope,
	type CommentKvUpdate,
	canonicalizeGeoKey,
	type DevicesCommand,
	type DevicesEnvelope,
	type DevicesOutputFormat,
	type DevicesWhereClause,
	describeCentrs,
	devicesOutputFormats,
	editInteractiveOnlyError,
	encryptCdb,
	initCdb,
	listDevices,
	listGroups,
	loadCdb,
	type NearPredicate,
	parseBbox,
	parseGpsTuple,
	parseNear,
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
	usage:
		"centrs devices <init|encrypt|list|show|groups|add|edit|set|remove> [args] [flags]",
	summary:
		"Inspect and mutate the CDB-backed device registry. `devices` is the only command that writes the CDB.",
	options: [
		{
			flag: "--encrypt",
			description:
				"`init` only — require encrypted creation with a non-empty CDB password; refuse an existing open CDB.",
		},
		{
			flag: "--no-backup",
			description:
				"`encrypt` only — skip the plaintext pre-conversion snapshot. Without that snapshot, a forgotten password cannot be recovered.",
		},
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
				"Decrypt an encrypted CDB. Falls back to `CENTRS_CDB_PASSWORD`. Also used for `init --encrypt`, `encrypt`, and to re-encrypt on writes.",
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
			flag: "--where",
			valueName: "<attr=value>",
			description:
				"`list` only — repeatable device-class filter over CDB facts (AND-combined), e.g. `--where lat=37.7749`.",
		},
		{
			flag: "--near",
			valueName: "<lat>,<lon>,<radius>",
			description:
				"`list` only — GPS filter: devices within radius (m/km/mi/ft; bare number = km). Lat-first.",
		},
		{
			flag: "--bbox",
			valueName: "<south>,<west>,<north>,<east>",
			description:
				"`list` only — GPS filter: devices inside the lat-first bounding box.",
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
			flag: "--password-stdin",
			description:
				"`add`,`set` — read the record password from stdin (one trailing newline stripped) so it never rides argv. Conflicts with `--password`.",
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
			flag: "--lat / --latitude",
			valueName: "<deg>",
			description:
				"`add`,`set` — latitude in decimal degrees (-90..90); a comment-kv fact, paired with --lon.",
		},
		{
			flag: "--lon / --lng / --longitude / --long",
			valueName: "<deg>",
			description:
				"`add`,`set` — longitude in decimal degrees (-180..180); a comment-kv fact, paired with --lat.",
		},
		{
			flag: "--altitude / --alt / --ele / --elevation",
			valueName: "<meters>",
			description:
				"`add`,`set` — altitude in meters (may be negative); a comment-kv fact.",
		},
		{
			flag: "--altitude-type / --alt-type",
			valueName: "<MSL|AGL>",
			description:
				"`add`,`set` — vertical datum for --altitude (default MSL); case-insensitive.",
		},
		{
			flag: "--gps",
			valueName: "<lat>,<lon>[,<altitude>[,<altitude-type>]]",
			description:
				"`add`,`set` — combined lat,lon[,altitude[,altitude-type]] convenience (lat-first; missing altitude-type defaults MSL).",
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
	| "init"
	| "encrypt"
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
	encrypt?: boolean;
	noBackup?: boolean;
	group?: string;
	where?: string[];
	via?: string;
	members?: boolean;
	explain?: boolean;
	match?: string;
	user?: string;
	password?: string;
	passwordStdin?: boolean;
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
	lat?: string;
	lon?: string;
	altitude?: string;
	altitudeType?: string;
	gps?: string;
	near?: NearPredicate;
	bbox?: BboxPredicate;
}

/**
 * Flags `init`/`encrypt` honor. They touch only the CDB file, never a record,
 * so record, selection, and provenance flags would be silently ignored there.
 */
const CDB_FILE_FLAGS: Readonly<Record<"init" | "encrypt", readonly string[]>> =
	{
		init: ["--cdb-file", "--cdb-password", "--format", "--json", "--encrypt"],
		encrypt: [
			"--cdb-file",
			"--cdb-password",
			"--format",
			"--json",
			"--no-backup",
		],
	};

function parseDevicesCliArgs(args: readonly string[]): DevicesCliArgs {
	const parsed: DevicesCliArgs = {};
	const positional: string[] = [];
	const suppliedFlags: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) {
			continue;
		}
		if (arg.startsWith("-")) suppliedFlags.push(arg);
		switch (arg) {
			case "--help":
			case "-h":
				parsed.help = true;
				break;
			case "--encrypt":
				parsed.encrypt = true;
				break;
			case "--no-backup":
				parsed.noBackup = true;
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
			case "--where":
				parsed.where = [
					...(parsed.where ?? []),
					expectValue(args, ++index, arg),
				];
				break;
			case "--near":
				parsed.near = parseNear(expectValue(args, ++index, arg));
				break;
			case "--bbox":
				parsed.bbox = parseBbox(expectValue(args, ++index, arg));
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
			case "--password-stdin":
				parsed.passwordStdin = true;
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
			case "--lat":
			case "--latitude":
				parsed.lat = expectValue(args, ++index, arg);
				break;
			case "--lon":
			case "--lng":
			case "--longitude":
			case "--long":
				parsed.lon = expectValue(args, ++index, arg);
				break;
			case "--altitude":
			case "--alt":
			case "--ele":
			case "--elevation":
				parsed.altitude = expectValue(args, ++index, arg);
				break;
			case "--altitude-type":
			case "--alt-type":
				parsed.altitudeType = expectValue(args, ++index, arg);
				break;
			case "--gps":
				parsed.gps = expectValue(args, ++index, arg);
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
		"init",
		"encrypt",
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
			"`centrs devices` requires a subcommand: init, encrypt, list, show, groups, add, edit, set, or remove.",
		);
	}
	// Resolve aliases (print/get/rm/delete) to the canonical verb before validating.
	const sub = SUBCOMMAND_ALIASES[rawSub] ?? (rawSub as DevicesSubcommand);
	if (!subcommands.includes(sub)) {
		throw new Error(
			`Unknown devices subcommand: ${rawSub}. Use init, encrypt, list, show, groups, add, edit, set, or remove (aliases: print, get, rm, delete).`,
		);
	}
	parsed.subcommand = sub;
	if (parsed.encrypt && sub !== "init")
		throw new Error(
			"--encrypt is supported only by devices init; use devices encrypt for conversion.",
		);
	if (parsed.noBackup && sub !== "encrypt")
		throw new Error("--no-backup is supported only by devices encrypt.");

	// Reject flags that don't apply to the resolved subcommand instead of
	// silently ignoring the user's input: `--where`/`--near`/`--bbox` select
	// records for `list`; the GPS *setter* flags write via `add`/`set`.
	const selectorFlag =
		(parsed.where?.length ?? 0) > 0
			? "--where"
			: parsed.near !== undefined
				? "--near"
				: parsed.bbox !== undefined
					? "--bbox"
					: undefined;
	if (selectorFlag !== undefined && sub !== "list") {
		throw new CentrsError({
			code: "input/invalid-command",
			summary: `\`${selectorFlag}\` is not supported by \`centrs devices ${sub}\`.`,
			remediation:
				"`--where`/`--near`/`--bbox` select records for `centrs devices list`. For `add`/`set`, name the `<target>` directly.",
			context: { subcommand: sub, flag: selectorFlag },
		});
	}
	const geoFlag =
		parsed.lat !== undefined
			? "--lat"
			: parsed.lon !== undefined
				? "--lon"
				: parsed.altitude !== undefined
					? "--altitude"
					: parsed.altitudeType !== undefined
						? "--altitude-type"
						: parsed.gps !== undefined
							? "--gps"
							: undefined;
	if (geoFlag !== undefined && sub !== "add" && sub !== "set") {
		throw new CentrsError({
			code: "input/invalid-command",
			summary: `GPS flag \`${geoFlag}\` is not supported by \`centrs devices ${sub}\`.`,
			remediation:
				"Store GPS with `centrs devices add`/`set` (e.g. `--gps <lat>,<lon>`); query it with `centrs devices list --where lat=…` / `--near`.",
			context: { subcommand: sub, flag: geoFlag },
		});
	}
	if (sub === "init" || sub === "encrypt") {
		const allowed = CDB_FILE_FLAGS[sub];
		const ignored = suppliedFlags.find((flag) => !allowed.includes(flag));
		if (ignored !== undefined) {
			throw new CentrsError({
				code: "input/invalid-command",
				summary: `\`${ignored}\` is not supported by \`centrs devices ${sub}\`.`,
				remediation: `\`centrs devices ${sub}\` accepts only ${allowed.map((flag) => `\`${flag}\``).join(", ")}. Edit records with \`centrs devices add\`/\`set\`.`,
				context: { subcommand: sub, flag: ignored },
			});
		}
	}

	if (parsed.passwordStdin && sub !== "add" && sub !== "set") {
		throw new CentrsError({
			code: "input/invalid-command",
			summary: `\`--password-stdin\` is not supported by \`centrs devices ${sub}\`.`,
			remediation:
				"`--password-stdin` writes a record password with `centrs devices add`/`set` (e.g. `printf '%s' \"$PW\" | centrs devices set <target> --password-stdin`).",
			context: { subcommand: sub, flag: "--password-stdin" },
		});
	}
	if (parsed.passwordStdin && parsed.password !== undefined) {
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary: "`--password` and `--password-stdin` cannot be used together.",
			remediation:
				"Pass the record password one way: `--password-stdin` with the value on stdin (keeps it out of argv and `ps`), or `--password <secret>`.",
			context: { subcommand: sub, flags: ["--password", "--password-stdin"] },
		});
	}

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

/**
 * Parse a `--where attr=value` token for `devices list` (constitution: target
 * selection grammar). Mirrors `src/cli/selection.ts` `parseWhereClause`: a
 * structured `input/invalid-command` (not a bare `Error`) so the surfaced error
 * keeps its remediation/context, consistent with every other CLI surface. Geo
 * alias canonicalization (`latitude=`→`lat=`) is NOT done here — it happens once,
 * centrally, in `matchesWhere` (`src/resolver/facts.ts`), so `devices list` and
 * every fan-out command's `--where` behave identically.
 */
function parseWhereClause(token: string): DevicesWhereClause {
	const eq = token.indexOf("=");
	if (eq <= 0) {
		throw new CentrsError({
			code: "input/invalid-command",
			summary: `--where must be \`<attr>=<value>\`; received: ${token}`,
			remediation:
				"Pass a device-class selector like `--where board=RB5009` (matches a CDB fact or core field).",
			context: { where: token },
		});
	}
	return {
		key: token.slice(0, eq),
		value: token.slice(eq + 1),
	};
}

function parseKvArg(token: string): CommentKvUpdate {
	const eq = token.indexOf("=");
	if (eq <= 0) {
		throw new Error(
			`Invalid kv override "${token}"; expected key=value (use key= to clear a value).`,
		);
	}
	// Alias canonicalization happens in ONE place (`canonicalizeGeoKey`) so a
	// bare `lng=…`/`latitude=…`/`elevation=…` positional lands under the same
	// canonical key a `--lon`/`--lat`/`--altitude` flag would use. A no-op for
	// every non-geo key.
	const key = canonicalizeGeoKey(token.slice(0, eq));
	const value = parseKvValue(token.slice(eq + 1));
	// An empty value removes the token (`devices set <t> via=` deletes the
	// `via` override) instead of storing a literally-empty value, per
	// `commands/devices/README.md` (Comment kv-soup). The core upsert/remove
	// model lives in `applyCommentKv` (`src/resolver/comment-kv.ts`), which
	// treats `value: null` as removal; the CLI lowers `key=` to that form
	// here. There is currently no need to store a literally-empty value.
	return { key, value: value === "" ? null : value };
}

/**
 * Lower the per-device GPS flags (`--lat`/`--lon`/`--altitude`/
 * `--altitude-type` and their aliases, plus the combined `--gps`) into
 * comment-kv updates. These are CLI conveniences only — no new first-class CDB
 * tag — so they merge into the same `CommentKvUpdate[]` as bare `k=v`
 * positionals; range/enum/pairing validation happens once, in
 * `validateCommentKvUpdates` (`src/devices.ts`), regardless of which flag
 * produced the update. `--gps` is expanded first so a discrete `--lat`/`--lon`/
 * `--altitude`/`--altitude-type` flag passed alongside it wins (applied later
 * in the array).
 */
function buildGeoUpdates(parsed: DevicesCliArgs): CommentKvUpdate[] {
	const updates: CommentKvUpdate[] = [];
	if (parsed.gps !== undefined) {
		const gps = parseGpsTuple(parsed.gps);
		updates.push({ key: "lat", value: gps.raw.lat });
		updates.push({ key: "lon", value: gps.raw.lon });
		if (gps.raw.altitude !== undefined) {
			updates.push({ key: "altitude", value: gps.raw.altitude });
		}
		if (gps.raw.altitudeType !== undefined) {
			updates.push({ key: "altitude-type", value: gps.raw.altitudeType });
		}
	}
	if (parsed.lat !== undefined) {
		updates.push({ key: "lat", value: parsed.lat });
	}
	if (parsed.lon !== undefined) {
		updates.push({ key: "lon", value: parsed.lon });
	}
	if (parsed.altitude !== undefined) {
		updates.push({ key: "altitude", value: parsed.altitude });
	}
	if (parsed.altitudeType !== undefined) {
		updates.push({ key: "altitude-type", value: parsed.altitudeType });
	}
	return updates;
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

/** Seams for {@link readPasswordStdin}; production reads the real fd 0. */
export interface PasswordStdinSource {
	/** Whether stdin is a terminal (defaults to `process.stdin.isTTY`). */
	isTty?: boolean;
	/** Read all of stdin as text (defaults to `Bun.stdin.text()`). */
	read?: () => Promise<string>;
}

/**
 * Read a record password for `devices add`/`set --password-stdin` (#582).
 *
 * Exactly one trailing `\n` or `\r\n` is stripped so `echo pw | …` works;
 * any other whitespace is part of the password. A TTY stdin is refused rather
 * than prompted (interactive prompting is #160), and empty input is refused so
 * clearing a stored password stays the deliberate `--password ""`. The value is
 * never placed in an error summary, remediation, or context.
 */
export async function readPasswordStdin(
	source: PasswordStdinSource = {},
): Promise<string> {
	const isTty = source.isTty ?? process.stdin.isTTY === true;
	if (isTty) {
		throw new CentrsError({
			code: "usage/stdin-is-tty",
			summary:
				"`--password-stdin` reads the password from stdin, but stdin is a terminal.",
			remediation:
				"Pipe the password in (e.g. `printf '%s' \"$PW\" | centrs devices set <target> --password-stdin`) or redirect it from a file with `< pw.txt`. Interactive prompting is not supported.",
			context: { flag: "--password-stdin" },
		});
	}
	const raw = await (source.read ?? (() => Bun.stdin.text()))();
	const value = raw.endsWith("\r\n")
		? raw.slice(0, -2)
		: raw.endsWith("\n")
			? raw.slice(0, -1)
			: raw;
	if (value === "") {
		throw new CentrsError({
			code: "input/empty-stdin",
			summary: "`--password-stdin` received an empty password on stdin.",
			remediation:
				'Pipe a non-empty password to stdin. To clear a stored password on purpose, use `centrs devices set <target> --password ""`.',
			context: { flag: "--password-stdin" },
		});
	}
	return value;
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
		// Read stdin before touching the CDB so a TTY or empty pipe fails fast
		// without loading (or decrypting) anything. Only add/set get here with
		// the flag; the parser refuses it on every other subcommand.
		const password = parsed.passwordStdin
			? await readPasswordStdin()
			: parsed.password;
		if (parsed.subcommand === "init" || parsed.subcommand === "encrypt") {
			const options = {
				cdbFile: parsed.cdbFile,
				cdbPassword: parsed.cdbPassword,
				env: envSnapshot,
			};
			const envelope =
				parsed.subcommand === "init"
					? await initCdb({ ...options, encrypt: parsed.encrypt })
					: await encryptCdb({ ...options, skipBackup: parsed.noBackup });
			console.log(renderDevicesEnvelope(envelope, parsed.format ?? "text"));
			return 0;
		}
		const cdb = await loadCdb({
			cdbFile: parsed.cdbFile,
			cdbPassword: parsed.cdbPassword,
			env: envSnapshot,
		});

		let envelope: DevicesEnvelope<unknown>;
		switch (parsed.subcommand) {
			case "list":
				envelope = listDevices({
					cdb,
					group: parsed.group,
					where: (parsed.where ?? []).map(parseWhereClause),
					near: parsed.near,
					bbox: parsed.bbox,
				});
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
					password,
					group: parsed.group,
					profile: resolveProfile(parsed),
					session: parsed.session,
					comment: parsed.comment,
					commentKvUpdates: [
						...buildGeoUpdates(parsed),
						...(parsed.kvArgs ?? []).map(parseKvArg),
					],
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
					updates: [
						...buildGeoUpdates(parsed),
						...(parsed.kvArgs ?? []).map(parseKvArg),
					],
					user: parsed.user,
					password,
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
