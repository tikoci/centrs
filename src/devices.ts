import { homedir } from "node:os";
import { join } from "node:path";
import {
	decodeWinBoxCdbEntries,
	decryptWinBoxCdb,
	type EncryptedWinBoxCdbFile,
	parseWinBoxCdb,
	type WinBoxCdbEntry,
	type WinBoxCdbField,
	type WinBoxCdbRecord,
	WinBoxCdbWrongPasswordError,
	winBoxCdbRecordType,
} from "./data/winbox-cdb.ts";
import { CentrsError, serializeCentrsError } from "./errors.ts";

export type SettingSourceKind = "default" | "env" | "cli";

export interface SettingSource {
	kind: SettingSourceKind;
	key: string;
}

export interface DevicesSettings {
	cdbFile: { value: string; source: SettingSource };
	cdbPassword: { value: string; source: SettingSource; provided: boolean };
}

export interface DevicesWarning {
	code: string;
	message: string;
	context?: Record<string, unknown>;
}

export interface DevicesEnvelopeMeta {
	settings: DevicesSettings;
}

export interface DevicesListItem {
	target: string;
	recordType: number;
	recordTypeName: string;
	group: string;
	user: string;
	cdbRecordIndex: number;
}

export interface DevicesShowItem extends DevicesListItem {
	password: string;
	comment: string;
	commentMirror: string;
	profile: string;
	session: string;
	romonAgent: string;
	savedPassword: boolean;
	flags: number;
}

export interface DevicesGroupSummary {
	group: string;
	members: number;
	memberEntries?: readonly { target: string; recordType: number }[];
}

export type DevicesCommand = "list" | "show" | "groups";

export interface DevicesSuccessEnvelope<Data> {
	ok: true;
	command: DevicesCommand;
	data: Data;
	warnings: readonly DevicesWarning[];
	meta: DevicesEnvelopeMeta;
}

export interface DevicesErrorEnvelope {
	ok: false;
	command: DevicesCommand;
	error: ReturnType<typeof serializeCentrsError>;
	warnings: readonly DevicesWarning[];
	meta: DevicesEnvelopeMeta;
}

export type DevicesEnvelope<Data> =
	| DevicesSuccessEnvelope<Data>
	| DevicesErrorEnvelope;

export interface LoadCdbOptions {
	cdbFile?: string;
	cdbPassword?: string;
	env?: Record<string, string | undefined>;
}

export interface LoadedCdb {
	entries: readonly WinBoxCdbEntry[];
	settings: DevicesSettings;
	warnings: readonly DevicesWarning[];
}

const DEFAULT_CDB_RELATIVE = ".config/tikoci/winbox.cdb";
const ENV_HOME = "HOME";
const ENV_CDB_FILE = "CENTRS_CDB_FILE";
const ENV_CDB_PASSWORD = "CENTRS_CDB_PASSWORD";

export function defaultCdbPath(
	env?: Record<string, string | undefined>,
): string {
	const home = env?.[ENV_HOME] ?? homedir();
	return join(home, DEFAULT_CDB_RELATIVE);
}

export function resolveDevicesSettings(
	options: LoadCdbOptions,
): DevicesSettings {
	const env = options.env ?? {};
	let cdbFileSource: SettingSource = { kind: "default", key: "default" };
	let cdbFile = defaultCdbPath(env);
	const envCdbFile = env[ENV_CDB_FILE];
	if (envCdbFile) {
		cdbFile = envCdbFile;
		cdbFileSource = { kind: "env", key: ENV_CDB_FILE };
	}
	if (options.cdbFile !== undefined) {
		cdbFile = options.cdbFile;
		cdbFileSource = { kind: "cli", key: "--cdb-file" };
	}

	let cdbPassword = "";
	let provided = false;
	let cdbPasswordSource: SettingSource = { kind: "default", key: "default" };
	const envCdbPassword = env[ENV_CDB_PASSWORD];
	if (envCdbPassword !== undefined) {
		cdbPassword = envCdbPassword;
		provided = true;
		cdbPasswordSource = { kind: "env", key: ENV_CDB_PASSWORD };
	}
	if (options.cdbPassword !== undefined) {
		cdbPassword = options.cdbPassword;
		provided = true;
		cdbPasswordSource = { kind: "cli", key: "--cdb-password" };
	}

	return {
		cdbFile: { value: cdbFile, source: cdbFileSource },
		cdbPassword: { value: cdbPassword, source: cdbPasswordSource, provided },
	};
}

export async function loadCdb(options: LoadCdbOptions): Promise<LoadedCdb> {
	const settings = resolveDevicesSettings(options);
	const warnings: DevicesWarning[] = [];

	const file = Bun.file(settings.cdbFile.value);
	if (!(await file.exists())) {
		throw new CentrsError({
			code: "cdb/not-found",
			summary: `CDB file not found: ${settings.cdbFile.value}`,
			remediation:
				"Pass --cdb-file PATH, set CENTRS_CDB_FILE, or place a CDB at ~/.config/tikoci/winbox.cdb.",
			context: { cdbFile: settings.cdbFile.value },
		});
	}

	const bytes = new Uint8Array(await file.arrayBuffer());
	let parsed: ReturnType<typeof parseWinBoxCdb>;
	try {
		parsed = parseWinBoxCdb(bytes);
	} catch (cause) {
		throw new CentrsError({
			code: "cdb/parse-failed",
			summary:
				cause instanceof Error ? cause.message : "Failed to parse CDB file.",
			remediation:
				"Verify the file is a WinBox CDB and not truncated; restore from a backup if necessary.",
			context: { cdbFile: settings.cdbFile.value },
			cause,
		});
	}

	let openBytes: Uint8Array;
	if (parsed.mode === "open") {
		if (settings.cdbPassword.provided) {
			warnings.push({
				code: "cdb/password-not-needed",
				message:
					"--cdb-password was provided but the CDB is not encrypted; the password was ignored.",
			});
		}
		openBytes = bytes;
	} else {
		if (!settings.cdbPassword.provided) {
			throw new CentrsError({
				code: "cdb/password-required",
				summary: "CDB is encrypted; --cdb-password is required.",
				remediation:
					"Pass --cdb-password or set CENTRS_CDB_PASSWORD to the CDB password.",
				context: { cdbFile: settings.cdbFile.value },
			});
		}
		try {
			openBytes = decryptCdb(parsed, settings.cdbPassword.value);
		} catch (cause) {
			if (cause instanceof WinBoxCdbWrongPasswordError) {
				throw new CentrsError({
					code: "cdb/decrypt-failed",
					summary:
						"CDB decryption produced an invalid open-CDB magic; the password is likely wrong.",
					remediation:
						"Re-check --cdb-password or CENTRS_CDB_PASSWORD against the value used when the CDB was saved.",
					context: { cdbFile: settings.cdbFile.value },
					cause,
					causeData: { reason: "open-magic-mismatch" },
				});
			}
			throw new CentrsError({
				code: "cdb/decrypt-failed",
				summary:
					cause instanceof Error
						? cause.message
						: "Failed to decrypt CDB file.",
				remediation:
					"Verify --cdb-password is correct and the file is a WinBox-encrypted CDB.",
				context: { cdbFile: settings.cdbFile.value },
				cause,
			});
		}
	}

	const openFile = parseWinBoxCdb(openBytes);
	if (openFile.mode !== "open") {
		throw new CentrsError({
			code: "cdb/parse-failed",
			summary: "Decrypted CDB did not parse as an open file.",
			remediation:
				"Re-check --cdb-password; the bytes after decryption are malformed.",
			context: { cdbFile: settings.cdbFile.value },
		});
	}

	const entries = decodeWinBoxCdbEntries(openFile);
	for (const entry of entries) {
		const tags = unknownTcodeTags(entry.record);
		if (tags.length > 0) {
			warnings.push({
				code: "cdb/unknown-field",
				message: `Entry ${entry.target || "(unnamed)"} contains ${tags.length} field(s) with unknown tcodes; preserved verbatim.`,
				context: { target: entry.target, tags },
			});
		}
	}

	return { entries, settings, warnings };
}

function decryptCdb(
	encrypted: EncryptedWinBoxCdbFile,
	password: string,
): Uint8Array {
	return decryptWinBoxCdb(encrypted, password);
}

function unknownTcodeTags(record: WinBoxCdbRecord): readonly number[] {
	const tags: number[] = [];
	for (const field of record.fields) {
		if (field.rawTail) {
			tags.push(field.tag);
		}
	}
	return tags;
}

export function recordTypeName(recordType: number): string {
	for (const [name, value] of Object.entries(winBoxCdbRecordType)) {
		if (value === recordType) {
			return name;
		}
	}
	return `unknown(${recordType})`;
}

export interface ListDevicesArgs {
	cdb: LoadedCdb;
	group?: string;
}

export function listDevices(
	args: ListDevicesArgs,
): DevicesSuccessEnvelope<readonly DevicesListItem[]> {
	const warnings = [...args.cdb.warnings];
	let entries = args.cdb.entries;
	let indices = entries.map((_, index) => index);

	if (args.group !== undefined) {
		const wanted = args.group;
		const filtered: { entry: WinBoxCdbEntry; index: number }[] = [];
		for (let index = 0; index < entries.length; index += 1) {
			const entry = entries[index];
			if (entry && entry.group === wanted) {
				filtered.push({ entry, index });
			}
		}
		entries = filtered.map((item) => item.entry);
		indices = filtered.map((item) => item.index);
		if (filtered.length === 0) {
			warnings.push({
				code: "cdb/empty-group",
				message: `No entries matched group "${wanted}".`,
				context: { group: wanted },
			});
		}
	}

	const data: DevicesListItem[] = entries.map((entry, position) => ({
		target: entry.target,
		recordType: entry.recordType,
		recordTypeName: recordTypeName(entry.recordType),
		group: entry.group,
		user: entry.user,
		cdbRecordIndex: indices[position] ?? -1,
	}));

	return {
		ok: true,
		command: "list",
		data,
		warnings,
		meta: { settings: args.cdb.settings },
	};
}

export interface ShowDeviceArgs {
	cdb: LoadedCdb;
	target: string;
	explain?: boolean;
}

export interface DevicesShowEnvelopeData {
	entry: DevicesShowItem;
	record?: WinBoxCdbRecord;
}

export function showDevice(
	args: ShowDeviceArgs,
): DevicesSuccessEnvelope<DevicesShowEnvelopeData> {
	const matches: { entry: WinBoxCdbEntry; index: number }[] = [];
	for (let index = 0; index < args.cdb.entries.length; index += 1) {
		const entry = args.cdb.entries[index];
		if (entry && entry.target === args.target) {
			matches.push({ entry, index });
		}
	}

	if (matches.length === 0) {
		throw new CentrsError({
			code: "cdb/not-found-target",
			summary: `No CDB entry with target "${args.target}".`,
			remediation:
				"Run `centrs devices list` to see the available targets; check spelling and address family.",
			context: { target: args.target },
		});
	}

	if (matches.length > 1) {
		throw new CentrsError({
			code: "identity/ambiguous",
			summary: `Target "${args.target}" matches ${matches.length} CDB entries.`,
			remediation:
				"Re-run with --match=<exact-target> once the resolver supports it, or remove the duplicate entry.",
			context: {
				target: args.target,
				matches: matches.map(({ entry, index }) => ({
					cdbRecordIndex: index,
					target: entry.target,
					recordType: entry.recordType,
				})),
			},
		});
	}

	const match = matches[0];
	if (!match) {
		throw new CentrsError({
			code: "internal/unreachable",
			summary: "Match list collapsed unexpectedly.",
		});
	}
	const data: DevicesShowEnvelopeData = {
		entry: entryToShowItem(match.entry, match.index),
	};
	if (args.explain) {
		data.record = match.entry.record;
	}

	return {
		ok: true,
		command: "show",
		data,
		warnings: args.cdb.warnings,
		meta: { settings: args.cdb.settings },
	};
}

function entryToShowItem(
	entry: WinBoxCdbEntry,
	cdbRecordIndex: number,
): DevicesShowItem {
	return {
		target: entry.target,
		recordType: entry.recordType,
		recordTypeName: recordTypeName(entry.recordType),
		group: entry.group,
		user: entry.user,
		password: entry.password,
		session: entry.session,
		comment: entry.comment,
		commentMirror: entry.commentMirror,
		profile: entry.profile,
		romonAgent: entry.romonAgent,
		savedPassword: entry.savedPassword,
		flags: entry.flags,
		cdbRecordIndex,
	};
}

export interface ListGroupsArgs {
	cdb: LoadedCdb;
	withMembers?: boolean;
}

export function listGroups(
	args: ListGroupsArgs,
): DevicesSuccessEnvelope<readonly DevicesGroupSummary[]> {
	const buckets = new Map<string, { entry: WinBoxCdbEntry; index: number }[]>();
	for (let index = 0; index < args.cdb.entries.length; index += 1) {
		const entry = args.cdb.entries[index];
		if (!entry || entry.group === "") {
			continue;
		}
		const bucket = buckets.get(entry.group) ?? [];
		bucket.push({ entry, index });
		buckets.set(entry.group, bucket);
	}

	const sorted = [...buckets.entries()].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	const data: DevicesGroupSummary[] = sorted.map(([group, members]) => {
		const summary: DevicesGroupSummary = {
			group,
			members: members.length,
		};
		if (args.withMembers) {
			summary.memberEntries = members.map(({ entry }) => ({
				target: entry.target,
				recordType: entry.recordType,
			}));
		}
		return summary;
	});

	return {
		ok: true,
		command: "groups",
		data,
		warnings: args.cdb.warnings,
		meta: { settings: args.cdb.settings },
	};
}

export function buildDevicesErrorEnvelope(
	command: DevicesCommand,
	settings: DevicesSettings,
	warnings: readonly DevicesWarning[],
	error: unknown,
): DevicesErrorEnvelope {
	const centrsError =
		error instanceof CentrsError
			? error
			: new CentrsError({
					code: "internal/devices-failed",
					summary: error instanceof Error ? error.message : String(error),
					cause: error,
				});
	return {
		ok: false,
		command,
		error: serializeCentrsError(centrsError),
		warnings,
		meta: { settings },
	};
}

export type DevicesOutputFormat = "text" | "json" | "yaml";
export const devicesOutputFormats: readonly DevicesOutputFormat[] = [
	"text",
	"json",
	"yaml",
];

export function renderDevicesEnvelope(
	envelope: DevicesEnvelope<unknown>,
	format: DevicesOutputFormat,
): string {
	if (format === "json") {
		return JSON.stringify(envelope, jsonReplacer, 2);
	}
	if (format === "yaml") {
		return renderYaml(envelope);
	}
	return renderText(envelope);
}

function jsonReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Uint8Array) {
		return { $bytes: Array.from(value) };
	}
	return value;
}

function renderYaml(value: unknown, indent = ""): string {
	if (value === null || value === undefined) {
		return `${indent}null`;
	}
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (value instanceof Uint8Array) {
		return `[${Array.from(value).join(", ")}]`;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return "[]";
		}
		return value
			.map((item) => `${indent}- ${renderYamlInline(item, `${indent}  `)}`)
			.join("\n");
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) {
			return "{}";
		}
		return entries
			.map(([k, v]) => {
				const inline = renderYamlInline(v, `${indent}  `);
				if (inline.includes("\n")) {
					return `${indent}${k}:\n${inline}`;
				}
				return `${indent}${k}: ${inline}`;
			})
			.join("\n");
	}
	return String(value);
}

function renderYamlInline(value: unknown, indent: string): string {
	if (Array.isArray(value) || (value !== null && typeof value === "object")) {
		return `\n${renderYaml(value, indent)}`;
	}
	return renderYaml(value, indent);
}

function renderText(envelope: DevicesEnvelope<unknown>): string {
	const lines: string[] = [];
	if (!envelope.ok) {
		const error = envelope.error;
		lines.push(`[${error.code}] ${error.summary}`);
		if (error.remediation) {
			lines.push(`Fix: ${error.remediation}`);
		}
		if (error.detailsUrl) {
			lines.push(`Details: ${error.detailsUrl}`);
		}
		appendWarnings(lines, envelope.warnings);
		return lines.join("\n");
	}

	switch (envelope.command) {
		case "list":
			renderListText(lines, envelope.data as readonly DevicesListItem[]);
			break;
		case "show":
			renderShowText(lines, envelope.data as DevicesShowEnvelopeData);
			break;
		case "groups":
			renderGroupsText(lines, envelope.data as readonly DevicesGroupSummary[]);
			break;
	}

	appendWarnings(lines, envelope.warnings);
	return lines.join("\n");
}

function appendWarnings(
	lines: string[],
	warnings: readonly DevicesWarning[],
): void {
	for (const warning of warnings) {
		lines.push(`warning: [${warning.code}] ${warning.message}`);
	}
}

function renderListText(
	lines: string[],
	items: readonly DevicesListItem[],
): void {
	if (items.length === 0) {
		lines.push("(no entries)");
		return;
	}
	lines.push(["INDEX", "TARGET", "TYPE", "USER", "GROUP"].join("\t"));
	for (const item of items) {
		lines.push(
			[
				String(item.cdbRecordIndex),
				item.target,
				item.recordTypeName,
				item.user || "-",
				item.group || "-",
			].join("\t"),
		);
	}
}

function renderShowText(lines: string[], data: DevicesShowEnvelopeData): void {
	const entry = data.entry;
	lines.push(`target:        ${entry.target}`);
	lines.push(`record-type:   ${entry.recordTypeName} (${entry.recordType})`);
	lines.push(`cdb-index:     ${entry.cdbRecordIndex}`);
	lines.push(`user:          ${entry.user || "-"}`);
	lines.push(`saved-password: ${entry.savedPassword ? "yes" : "no"}`);
	lines.push(`group:         ${entry.group || "-"}`);
	lines.push(`profile:       ${entry.profile || "-"}`);
	lines.push(`session:       ${entry.session || "-"}`);
	lines.push(`comment:       ${entry.comment || "-"}`);
	if (entry.romonAgent) {
		lines.push(`romon-agent:   ${entry.romonAgent}`);
	}
	if (data.record) {
		lines.push("");
		lines.push("record:");
		for (const field of data.record.fields) {
			lines.push(`  - ${describeField(field)}`);
		}
	}
}

function describeField(field: WinBoxCdbField): string {
	const head = `tag=${field.tag} marker=0x${field.marker.toString(16).padStart(2, "0")} tcode=0x${field.tcode.toString(16).padStart(2, "0")}`;
	if (field.rawTail) {
		const bytes = field.value instanceof Uint8Array ? field.value : null;
		const preview = bytes
			? Array.from(bytes.subarray(0, 16))
					.map((b) => b.toString(16).padStart(2, "0"))
					.join(" ")
			: "<non-bytes>";
		const len = bytes ? bytes.length : 0;
		return `${head} rawTail bytes=${len} preview=${preview}`;
	}
	return `${head} value=${JSON.stringify(field.value)}`;
}

function renderGroupsText(
	lines: string[],
	items: readonly DevicesGroupSummary[],
): void {
	if (items.length === 0) {
		lines.push("(no groups)");
		return;
	}
	for (const item of items) {
		lines.push(`${item.group}\t${item.members}`);
		if (item.memberEntries) {
			for (const member of item.memberEntries) {
				lines.push(
					`  - ${member.target} (${recordTypeName(member.recordType)})`,
				);
			}
		}
	}
}
