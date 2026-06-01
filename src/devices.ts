import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	CentrsEnvelope,
	CentrsSuccessEnvelope,
	EnvelopeMeta,
	EnvelopeTargetMeta,
	SettingSource,
	SettingSourceKind,
} from "./core/envelope.ts";
import {
	buildWinBoxCdbEntryRecord,
	decodeWinBoxCdbEntries,
	decodeWinBoxCdbEntry,
	decryptWinBoxCdb,
	type EncryptedWinBoxCdbFile,
	encodeOpenWinBoxCdb,
	parseWinBoxCdb,
	type WinBoxCdbEntry,
	type WinBoxCdbField,
	type WinBoxCdbRecord,
	WinBoxCdbWrongPasswordError,
	winBoxCdbFieldTag,
	winBoxCdbParseErrorContext,
	winBoxCdbRecordType,
} from "./data/winbox-cdb.ts";
import {
	type WriteWinBoxCdbOptions,
	writeWinBoxCdb,
} from "./data/winbox-cdb-write.ts";
import { CentrsError, serializeCentrsError } from "./errors.ts";
import { plannedProtocols, type RouterOsProtocol } from "./protocols/index.ts";
import {
	applyCommentKv,
	type CommentKvUpdate,
	commentKvAllowlist,
	commentKvReservedKeys,
	parseCommentKv,
} from "./resolver/comment-kv.ts";

export type { SettingSource, SettingSourceKind };

export interface DevicesSettings {
	cdbFile: { value: string; source: SettingSource };
	cdbPassword: { value: string; source: SettingSource; provided: boolean };
}

export interface DevicesWarning {
	code: string;
	message: string;
	context?: Record<string, unknown>;
}

export interface DevicesListItem {
	target: string;
	recordType: number;
	recordTypeName: string;
	group: string;
	user: string;
	cdbRecordIndex: number;
	source?: string;
	sources?: Record<string, SettingSource>;
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

export type DevicesCommand =
	| "list"
	| "show"
	| "groups"
	| "add"
	| "edit"
	| "set"
	| "remove";

export interface DevicesOperationMeta {
	command: DevicesCommand;
	cdbFile: string;
	cdbPasswordProvided: boolean;
}

export type DevicesEnvelope<Data> = CentrsEnvelope<Data, DevicesOperationMeta>;

function devicesMeta(
	command: DevicesCommand,
	settings: DevicesSettings,
	target: EnvelopeTargetMeta = {},
): EnvelopeMeta<DevicesOperationMeta> {
	return {
		target,
		via: null,
		settings: {
			cdbFile: settings.cdbFile.source,
			cdbPassword: settings.cdbPassword.source,
		},
		operation: {
			command,
			cdbFile: settings.cdbFile.value,
			cdbPasswordProvided: settings.cdbPassword.provided,
		},
	};
}

export interface LoadCdbOptions {
	cdbFile?: string;
	cdbPassword?: string;
	env?: Record<string, string | undefined>;
}

export interface LoadedCdb {
	entries: readonly WinBoxCdbEntry[];
	settings: DevicesSettings;
	warnings: readonly DevicesWarning[];
	/** True when the source file on disk was encrypted (writes are blocked). */
	encrypted: boolean;
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

function isAlreadyExistsError(cause: unknown): boolean {
	return (
		typeof cause === "object" &&
		cause !== null &&
		(cause as { code?: unknown }).code === "EEXIST"
	);
}

/**
 * Create an empty open CDB at `path` without clobbering an existing file.
 * Uses an exclusive-create open (`wx`) so a concurrent writer's CDB is never
 * overwritten; the caller treats EEXIST as "another process created it".
 */
async function createEmptyCdbNoClobber(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const handle = await open(path, "wx");
	try {
		await handle.write(encodeOpenWinBoxCdb([]));
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function loadCdb(options: LoadCdbOptions): Promise<LoadedCdb> {
	const settings = resolveDevicesSettings(options);
	const warnings: DevicesWarning[] = [];

	const file = Bun.file(settings.cdbFile.value);
	if (!(await file.exists())) {
		// At the default path with no explicit --cdb-file/env override, a missing
		// CDB is the first-run case, not an error: create an empty open CDB so
		// `devices`/identity commands work out of the box. An explicit missing
		// path stays an error (typo protection).
		if (settings.cdbFile.source.kind === "default") {
			try {
				await createEmptyCdbNoClobber(settings.cdbFile.value);
				warnings.push({
					code: "cdb/created",
					message: `No CDB found at the default path; created an empty CDB at ${settings.cdbFile.value}.`,
				});
			} catch (cause) {
				// EEXIST means another process won the race and created the CDB
				// between our existence check and the exclusive open — that file
				// is authoritative; fall through and read it instead of erroring.
				if (!isAlreadyExistsError(cause)) {
					throw new CentrsError({
						code: "cdb/not-found",
						summary: `CDB file not found and could not be created: ${settings.cdbFile.value}`,
						remediation:
							"Check directory permissions for ~/.config/tikoci, or pass --cdb-file PATH to a writable location.",
						context: { cdbFile: settings.cdbFile.value },
						cause,
					});
				}
			}
		} else {
			throw new CentrsError({
				code: "cdb/not-found",
				summary: `CDB file not found: ${settings.cdbFile.value}`,
				remediation:
					"Pass --cdb-file PATH, set CENTRS_CDB_FILE, or place a CDB at ~/.config/tikoci/winbox.cdb.",
				context: { cdbFile: settings.cdbFile.value },
			});
		}
	}

	const bytes = new Uint8Array(
		await Bun.file(settings.cdbFile.value).arrayBuffer(),
	);
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
			context: {
				cdbFile: settings.cdbFile.value,
				...winBoxCdbParseErrorContext(cause),
			},
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

	let entries: WinBoxCdbEntry[];
	try {
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
		entries = decodeWinBoxCdbEntries(openFile);
	} catch (cause) {
		if (cause instanceof CentrsError) {
			throw cause;
		}
		throw new CentrsError({
			code: "cdb/parse-failed",
			summary:
				cause instanceof Error
					? cause.message
					: "Failed to decode the decrypted CDB.",
			remediation:
				"Re-check --cdb-password; the bytes after decryption are malformed.",
			context: {
				cdbFile: settings.cdbFile.value,
				...winBoxCdbParseErrorContext(cause),
			},
			cause,
		});
	}
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

	return {
		entries,
		settings,
		warnings,
		encrypted: parsed.mode === "encrypted",
	};
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
): CentrsSuccessEnvelope<readonly DevicesListItem[], DevicesOperationMeta> {
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

	const data: DevicesListItem[] = entries.map((entry, position) =>
		entryToListItem(entry, indices[position] ?? -1),
	);

	return {
		ok: true,
		data,
		warnings,
		meta: devicesMeta("list", args.cdb.settings),
	};
}

export interface ShowDeviceArgs {
	cdb: LoadedCdb;
	target: string;
	explain?: boolean;
	via?: string;
	/**
	 * Disambiguator for duplicate `target` strings: a record-type token (one of
	 * `winBoxCdbRecordType`'s names, e.g. `ipAdmin`/`ipUser`/`macTarget`). When
	 * `show <target>` matches more than one CDB entry, `--match` selects the one
	 * whose record type matches. It cannot select between two entries that share
	 * both `target` and record type.
	 */
	match?: string;
	env?: Record<string, string | undefined>;
}

export interface DevicesShowEnvelopeData {
	entry: DevicesShowItem;
	record?: WinBoxCdbRecord;
}

export function showDevice(
	args: ShowDeviceArgs,
): CentrsSuccessEnvelope<DevicesShowEnvelopeData, DevicesOperationMeta> {
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

	const recordTypeTokens = Object.keys(winBoxCdbRecordType).join(", ");
	let selected = matches;
	if (matches.length > 1 && args.match !== undefined) {
		const wanted = recordTypeFromName(args.match);
		if (wanted === undefined) {
			throw new CentrsError({
				code: "input/invalid-match",
				summary: `--match "${args.match}" is not a known record type.`,
				remediation: `Pass one of ${recordTypeTokens} to select among duplicate targets.`,
				context: { target: args.target, match: args.match },
			});
		}
		selected = matches.filter(({ entry }) => entry.recordType === wanted);
		if (selected.length === 0) {
			throw new CentrsError({
				code: "identity/no-match",
				summary: `Target "${args.target}" has no CDB entry of record type "${args.match}".`,
				remediation:
					"Run `centrs devices list` to see each duplicate's record type, then pass a --match that exists.",
				context: {
					target: args.target,
					match: args.match,
					matches: matches.map(({ entry, index }) => ({
						cdbRecordIndex: index,
						target: entry.target,
						recordType: entry.recordType,
					})),
				},
			});
		}
	}

	if (selected.length > 1) {
		throw new CentrsError({
			code: "identity/ambiguous",
			summary: `Target "${args.target}" matches ${selected.length} CDB entries.`,
			remediation: `Re-run with --match=<record-type> (one of ${recordTypeTokens}) to select among the duplicates, or remove the duplicate CDB entry.`,
			context: {
				target: args.target,
				matches: selected.map(({ entry, index }) => ({
					cdbRecordIndex: index,
					target: entry.target,
					recordType: entry.recordType,
				})),
			},
		});
	}

	const match = selected[0];
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

	const resolved = resolveDeviceShowTargetMeta(match.entry, match.index, args);

	return {
		ok: true,
		data,
		warnings: [...args.cdb.warnings, ...resolved.warnings],
		meta: devicesMeta("show", args.cdb.settings, resolved.target),
	};
}

function entryToListItem(
	entry: WinBoxCdbEntry,
	cdbRecordIndex: number,
): DevicesListItem {
	const parsed = parseCommentKv(entry.comment);
	const sources: Record<string, SettingSource> = {
		target: { kind: "cdb", key: `record:${cdbRecordIndex}:target` },
		user: { kind: "cdb", key: `record:${cdbRecordIndex}:user` },
		group: { kind: "cdb", key: `record:${cdbRecordIndex}:group` },
	};
	const item: DevicesListItem = {
		target: entry.target,
		recordType: entry.recordType,
		recordTypeName: recordTypeName(entry.recordType),
		group: entry.group,
		user: entry.user,
		cdbRecordIndex,
		sources,
	};
	if (parsed.values.source !== undefined) {
		item.source = parsed.values.source;
		sources["source"] = {
			kind: "comment-kv",
			key: `record:${cdbRecordIndex}:source`,
		};
	}
	return item;
}

interface ResolvedDeviceTargetMeta {
	target: EnvelopeTargetMeta;
	warnings: DevicesWarning[];
}

function resolveDeviceShowTargetMeta(
	entry: WinBoxCdbEntry,
	cdbRecordIndex: number,
	args: ShowDeviceArgs,
): ResolvedDeviceTargetMeta {
	const parsed = parseCommentKv(entry.comment);
	const warnings: DevicesWarning[] = parsed.warnings.map((warning) => ({
		code: warning.code,
		message: warning.message,
		context: warning.context,
	}));
	const sources: Record<string, SettingSource> = {
		target: { kind: "cdb", key: `record:${cdbRecordIndex}:target` },
		user: { kind: "cdb", key: `record:${cdbRecordIndex}:user` },
		password: { kind: "cdb", key: `record:${cdbRecordIndex}:password` },
		group: { kind: "cdb", key: `record:${cdbRecordIndex}:group` },
	};

	const commentVia = parseProtocolOption(
		parsed.values.via,
		"via",
		cdbRecordIndex,
		warnings,
	);
	const envVia = parseProtocolOption(
		args.env?.["CENTRS_VIA"],
		"CENTRS_VIA",
		cdbRecordIndex,
		warnings,
	);
	const cliVia = parseProtocolOption(
		args.via,
		"--via",
		cdbRecordIndex,
		warnings,
	);
	const via = cliVia ?? envVia ?? commentVia;
	if (via !== undefined) {
		sources["via"] =
			cliVia !== undefined
				? { kind: "cli", key: "--via" }
				: envVia !== undefined
					? { kind: "env", key: "CENTRS_VIA" }
					: { kind: "comment-kv", key: `record:${cdbRecordIndex}:via` };
	}
	if (commentVia !== undefined && via !== commentVia) {
		warnings.push({
			code: "cdb/override-applied",
			message: `Comment option "via=${commentVia}" was overridden by ${sources["via"]?.kind ?? "a higher-precedence source"}.`,
			context: {
				target: entry.target,
				key: "via",
				commentValue: commentVia,
				winner: via,
				source: sources["via"],
			},
		});
	}
	if (parsed.values.validate !== undefined) {
		sources["validate"] = {
			kind: "comment-kv",
			key: `record:${cdbRecordIndex}:validate`,
		};
	}
	if (parsed.values.source !== undefined) {
		sources["source"] = {
			kind: "comment-kv",
			key: `record:${cdbRecordIndex}:source`,
		};
	}

	const target: EnvelopeTargetMeta = {
		input: args.target,
		target: entry.target,
		resolvedTarget: entry.target,
		host: entry.target,
		name: entry.target,
		recordIndex: cdbRecordIndex,
		cdbRecordIndex,
		user: entry.user,
		group: entry.group,
		source: { kind: "cdb", key: `record:${cdbRecordIndex}` },
		sources,
	};
	if (via !== undefined) {
		target.via = via;
	}
	if (parsed.values.validate !== undefined) {
		target.validate = parsed.values.validate !== "false";
	}
	if (parsed.values.source !== undefined) {
		target.discoverySource = parsed.values.source;
	}
	return { target, warnings };
}

function parseProtocolOption(
	value: string | undefined,
	key: string,
	recordIndex: number,
	warnings: DevicesWarning[],
): RouterOsProtocol | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (plannedProtocols.includes(value as RouterOsProtocol)) {
		return value as RouterOsProtocol;
	}
	warnings.push({
		code: "cdb/invalid-option",
		message: `Comment option "${key}=${value}" is invalid (unknown protocol); it is ignored.`,
		context: { key, value, recordIndex },
	});
	return undefined;
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
): CentrsSuccessEnvelope<readonly DevicesGroupSummary[], DevicesOperationMeta> {
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
		data,
		warnings: args.cdb.warnings,
		meta: devicesMeta("groups", args.cdb.settings),
	};
}

// ---------------------------------------------------------------------------
// Mutation (CDB write) surface
// ---------------------------------------------------------------------------

/**
 * Result payload shared by every mutating devices command. `entry` is the
 * resulting record (absent for `remove`); `preservedUnknownTags` lists any
 * unknown/`rawTail` field tags carried over verbatim from the prior record.
 */
export interface DevicesMutationData {
	action: "add" | "edit" | "set" | "remove";
	target: string;
	cdbRecordIndex: number;
	replaced: boolean;
	recordCount: number;
	backupPath?: string;
	prunedBackups: readonly string[];
	preservedUnknownTags?: readonly number[];
	entry?: DevicesShowItem;
}

export type DevicesMutationEnvelope = CentrsSuccessEnvelope<
	DevicesMutationData,
	DevicesOperationMeta
>;

const KNOWN_FIELD_TAGS = new Set<number>(Object.values(winBoxCdbFieldTag));

interface EntryMatch {
	entry: WinBoxCdbEntry;
	index: number;
}

function matchEntries(
	entries: readonly WinBoxCdbEntry[],
	target: string,
): EntryMatch[] {
	const matches: EntryMatch[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry && entry.target === target) {
			matches.push({ entry, index });
		}
	}
	return matches;
}

/** Fields the canonical builder does not emit and must be preserved verbatim. */
function extraFields(record: WinBoxCdbRecord): readonly WinBoxCdbField[] {
	return record.fields.filter(
		(field) => field.rawTail === true || !KNOWN_FIELD_TAGS.has(field.tag),
	);
}

/**
 * Field-tag order to reuse when REWRITING an existing record. The builder's
 * canonicalFieldOrder is shaped for ipAdmin records; reusing it for other record
 * types (mac/romon targets) would reshape their on-disk layout. Deriving the
 * order from the prior record keeps each type's layout intact. The numeric
 * record-type marker (tag=recordType with a non-string value) is dropped because
 * the builder re-emits it unconditionally; rawTail/unknown fields are carried
 * separately via {@link extraFields}. Any tag in `newlySet` that the prior layout
 * lacked is appended so freshly supplied values are still encoded.
 */
function preservedFieldOrder(
	record: WinBoxCdbRecord,
	newlySet: readonly number[] = [],
): readonly number[] {
	const order: number[] = [];
	const seen = new Set<number>();
	for (const field of record.fields) {
		if (field.rawTail === true || !KNOWN_FIELD_TAGS.has(field.tag)) {
			continue;
		}
		if (
			field.tag === winBoxCdbFieldTag.recordType &&
			typeof field.value !== "string"
		) {
			continue;
		}
		if (!seen.has(field.tag)) {
			seen.add(field.tag);
			order.push(field.tag);
		}
	}
	for (const tag of newlySet) {
		if (!seen.has(tag)) {
			seen.add(tag);
			order.push(tag);
		}
	}
	return order;
}

/**
 * Resolves the saved-password flag for an edit. An explicit `savedPassword`
 * argument wins; otherwise a newly supplied password re-derives the flag from
 * its length, and an unchanged password preserves the prior flag bit (so a
 * comment-only edit never flips it).
 */
function resolveSavedPassword(
	explicit: boolean | undefined,
	newPassword: string | undefined,
	prior: boolean,
): boolean {
	if (explicit !== undefined) {
		return explicit;
	}
	if (newPassword !== undefined) {
		return newPassword.length > 0;
	}
	return prior;
}

function preservedTags(
	fields: readonly WinBoxCdbField[],
): readonly number[] | undefined {
	if (fields.length === 0) {
		return undefined;
	}
	return fields.map((field) => field.tag);
}

/**
 * When the CDB was loaded from encrypted bytes, derive the `encryptWith` option
 * for {@link writeWinBoxCdb} from the password we already have in settings, so
 * the round-trip re-encrypts with the same secret. Returns `undefined` for an
 * open CDB so the writer keeps emitting open bytes.
 */
function encryptWithFor(cdb: LoadedCdb): { password: string } | undefined {
	if (!cdb.encrypted) {
		return undefined;
	}
	return { password: cdb.settings.cdbPassword.value };
}

function ambiguousTargetError(
	target: string,
	matches: readonly EntryMatch[],
): CentrsError {
	return new CentrsError({
		code: "identity/ambiguous",
		summary: `Target "${target}" matches ${matches.length} CDB entries; refusing to mutate an ambiguous target.`,
		remediation:
			"Remove the duplicate entry, or narrow the CDB so a single record owns this target.",
		context: {
			target,
			matches: matches.map(({ entry, index }) => ({
				cdbRecordIndex: index,
				target: entry.target,
				recordType: entry.recordType,
			})),
		},
	});
}

function notFoundTargetError(target: string): CentrsError {
	return new CentrsError({
		code: "cdb/not-found-target",
		summary: `No CDB entry with target "${target}".`,
		remediation:
			"Run `centrs devices list` to see the available targets; use `centrs devices add` to create a new entry.",
		context: { target },
	});
}

/** Resolve a record-type name (e.g. `ipAdmin`) to its numeric tag. */
export function recordTypeFromName(name: string): number | undefined {
	const value = (winBoxCdbRecordType as Record<string, number>)[name];
	return typeof value === "number" ? value : undefined;
}

async function persistRecords(
	cdb: LoadedCdb,
	records: readonly WinBoxCdbRecord[],
	options: WriteWinBoxCdbOptions | undefined,
	action: DevicesMutationData["action"],
	target: string,
	cdbRecordIndex: number,
	replaced: boolean,
	resultEntry: DevicesShowItem | undefined,
	preserved: readonly number[] | undefined,
	warnings: readonly DevicesWarning[],
): Promise<DevicesMutationEnvelope> {
	const encryptWith = encryptWithFor(cdb);
	const writeOptions: WriteWinBoxCdbOptions | undefined = encryptWith
		? { ...(options ?? {}), encryptWith }
		: options;
	const written = await writeWinBoxCdb(
		cdb.settings.cdbFile.value,
		records,
		writeOptions,
	);
	const data: DevicesMutationData = {
		action,
		target,
		cdbRecordIndex,
		replaced,
		recordCount: written.recordCount,
		prunedBackups: written.prunedBackups,
	};
	if (written.backupPath !== undefined) {
		data.backupPath = written.backupPath;
	}
	if (preserved !== undefined) {
		data.preservedUnknownTags = preserved;
	}
	if (resultEntry !== undefined) {
		data.entry = resultEntry;
	}
	return {
		ok: true,
		data,
		warnings,
		meta: devicesMeta(action, cdb.settings),
	};
}

export interface AddDeviceArgs {
	cdb: LoadedCdb;
	target: string;
	recordType?: number;
	user?: string;
	password?: string;
	group?: string;
	profile?: string;
	session?: string;
	comment?: string;
	savedPassword?: boolean;
	force?: boolean;
	writeOptions?: WriteWinBoxCdbOptions;
}

export async function addDevice(
	args: AddDeviceArgs,
): Promise<DevicesMutationEnvelope> {
	const matches = matchEntries(args.cdb.entries, args.target);
	if (matches.length > 1) {
		throw ambiguousTargetError(args.target, matches);
	}
	const existing = matches[0];
	if (existing && !args.force) {
		throw new CentrsError({
			code: "cdb/already-exists",
			summary: `A CDB entry with target "${args.target}" already exists.`,
			remediation:
				"Pass --force to overwrite it, or use `centrs devices edit` to change individual fields.",
			context: { target: args.target, cdbRecordIndex: existing.index },
		});
	}

	const carried = existing ? extraFields(existing.entry.record) : [];
	const record = buildWinBoxCdbEntryRecord({
		recordType: args.recordType ?? winBoxCdbRecordType.ipAdmin,
		target: args.target,
		user: args.user,
		password: args.password,
		session: args.session,
		comment: args.comment,
		group: args.group,
		profile: args.profile,
		savedPassword: args.savedPassword,
		extraFields: carried.length > 0 ? carried : undefined,
	});

	const records = args.cdb.entries.map((entry) => entry.record);
	let cdbRecordIndex: number;
	if (existing) {
		records[existing.index] = record;
		cdbRecordIndex = existing.index;
	} else {
		cdbRecordIndex = records.length;
		records.push(record);
	}

	const preserved = preservedTags(carried);
	const warnings = mutationWarnings(args.cdb, preserved);
	return persistRecords(
		args.cdb,
		records,
		args.writeOptions,
		"add",
		args.target,
		cdbRecordIndex,
		existing !== undefined,
		entryToShowItem(decodeWinBoxCdbEntry(record), cdbRecordIndex),
		preserved,
		warnings,
	);
}

export interface EditDeviceArgs {
	cdb: LoadedCdb;
	target: string;
	user?: string;
	password?: string;
	group?: string;
	profile?: string;
	session?: string;
	comment?: string;
	savedPassword?: boolean;
	writeOptions?: WriteWinBoxCdbOptions;
}

export async function editDevice(
	args: EditDeviceArgs,
): Promise<DevicesMutationEnvelope> {
	const match = requireSingleMatch(args.cdb.entries, args.target);
	const prior = match.entry;
	const carried = extraFields(prior.record);
	const newlySet: number[] = [];
	if (args.user !== undefined) newlySet.push(winBoxCdbFieldTag.user);
	if (args.password !== undefined) newlySet.push(winBoxCdbFieldTag.password);
	if (args.session !== undefined) newlySet.push(winBoxCdbFieldTag.session);
	if (args.comment !== undefined) newlySet.push(winBoxCdbFieldTag.comment);
	if (args.group !== undefined) newlySet.push(winBoxCdbFieldTag.group);
	if (args.profile !== undefined) newlySet.push(winBoxCdbFieldTag.profile);
	const record = buildWinBoxCdbEntryRecord({
		recordType: prior.recordType,
		target: prior.target,
		user: args.user ?? prior.user,
		password: args.password ?? prior.password,
		session: args.session ?? prior.session,
		comment: args.comment ?? prior.comment,
		group: args.group ?? prior.group,
		profile: args.profile ?? (prior.profile || undefined),
		romonAgent: prior.romonAgent || undefined,
		savedPassword: resolveSavedPassword(
			args.savedPassword,
			args.password,
			prior.savedPassword,
		),
		fieldOrder: preservedFieldOrder(prior.record, newlySet),
		declaredFieldCount: prior.record.declaredFieldCount,
		extraFields: carried.length > 0 ? carried : undefined,
	});

	const records = args.cdb.entries.map((entry) => entry.record);
	records[match.index] = record;

	const preserved = preservedTags(carried);
	return persistRecords(
		args.cdb,
		records,
		args.writeOptions,
		"edit",
		args.target,
		match.index,
		true,
		entryToShowItem(decodeWinBoxCdbEntry(record), match.index),
		preserved,
		mutationWarnings(args.cdb, preserved),
	);
}

export interface SetDeviceCommentKvArgs {
	cdb: LoadedCdb;
	target: string;
	updates: readonly CommentKvUpdate[];
	strict?: boolean;
	writeOptions?: WriteWinBoxCdbOptions;
}

const ALLOWLIST_SET = new Set<string>(commentKvAllowlist);
const RESERVED_SET = new Set<string>(commentKvReservedKeys);

export async function setDeviceCommentKv(
	args: SetDeviceCommentKvArgs,
): Promise<DevicesMutationEnvelope> {
	const match = requireSingleMatch(args.cdb.entries, args.target);

	const reserved = args.updates
		.map((update) => update.key)
		.filter((key) => RESERVED_SET.has(key));
	if (reserved.length > 0) {
		throw new CentrsError({
			code: "cdb/reserved-key",
			summary: `Comment kv-soup cannot carry first-class CDB field(s): ${reserved.join(", ")}.`,
			remediation: `Set ${reserved.join(", ")} through \`centrs devices edit\`; the comment kv-soup is for ${commentKvAllowlist.join(", ")}.`,
			context: { target: args.target, reservedKeys: reserved },
		});
	}

	const warnings: DevicesWarning[] = [...args.cdb.warnings];
	const unknown = args.updates
		.map((update) => update.key)
		.filter((key) => !ALLOWLIST_SET.has(key));
	for (const key of unknown) {
		if (args.strict) {
			throw new CentrsError({
				code: "cdb/unknown-option",
				summary: `Unknown comment option "${key}" rejected under --strict.`,
				remediation: `Drop --strict to write it verbatim, or use an allowlisted key: ${commentKvAllowlist.join(", ")}.`,
				context: { target: args.target, key },
			});
		}
		warnings.push({
			code: "cdb/unknown-option",
			message: `Comment option "${key}" is not recognized; it is written verbatim but has no effect.`,
			context: { target: args.target, key },
		});
	}

	const prior = match.entry;
	const comment = applyCommentKv(prior.comment, args.updates);
	const carried = extraFields(prior.record);
	const record = buildWinBoxCdbEntryRecord({
		recordType: prior.recordType,
		target: prior.target,
		user: prior.user,
		password: prior.password,
		session: prior.session,
		comment,
		group: prior.group,
		profile: prior.profile || undefined,
		romonAgent: prior.romonAgent || undefined,
		savedPassword: prior.savedPassword,
		fieldOrder: preservedFieldOrder(prior.record, [
			winBoxCdbFieldTag.comment,
			winBoxCdbFieldTag.commentMirror,
		]),
		declaredFieldCount: prior.record.declaredFieldCount,
		extraFields: carried.length > 0 ? carried : undefined,
	});

	const records = args.cdb.entries.map((entry) => entry.record);
	records[match.index] = record;

	const preserved = preservedTags(carried);
	appendUnknownFieldWarning(warnings, args.cdb.settings, preserved);
	return persistRecords(
		args.cdb,
		records,
		args.writeOptions,
		"set",
		args.target,
		match.index,
		true,
		entryToShowItem(decodeWinBoxCdbEntry(record), match.index),
		preserved,
		warnings,
	);
}

export interface RemoveDeviceArgs {
	cdb: LoadedCdb;
	target: string;
	writeOptions?: WriteWinBoxCdbOptions;
}

export async function removeDevice(
	args: RemoveDeviceArgs,
): Promise<DevicesMutationEnvelope> {
	const match = requireSingleMatch(args.cdb.entries, args.target);
	const records = args.cdb.entries
		.map((entry) => entry.record)
		.filter((_, index) => index !== match.index);

	return persistRecords(
		args.cdb,
		records,
		args.writeOptions,
		"remove",
		args.target,
		match.index,
		false,
		undefined,
		undefined,
		[...args.cdb.warnings],
	);
}

function requireSingleMatch(
	entries: readonly WinBoxCdbEntry[],
	target: string,
): EntryMatch {
	const matches = matchEntries(entries, target);
	if (matches.length === 0) {
		throw notFoundTargetError(target);
	}
	if (matches.length > 1) {
		throw ambiguousTargetError(target, matches);
	}
	const match = matches[0];
	if (!match) {
		throw new CentrsError({
			code: "internal/unreachable",
			summary: "Match list collapsed unexpectedly.",
		});
	}
	return match;
}

function mutationWarnings(
	cdb: LoadedCdb,
	preserved: readonly number[] | undefined,
): DevicesWarning[] {
	const warnings: DevicesWarning[] = [...cdb.warnings];
	appendUnknownFieldWarning(warnings, cdb.settings, preserved);
	return warnings;
}

function appendUnknownFieldWarning(
	warnings: DevicesWarning[],
	settings: DevicesSettings,
	preserved: readonly number[] | undefined,
): void {
	if (preserved && preserved.length > 0) {
		warnings.push({
			code: "cdb/unknown-field",
			message: `Preserved ${preserved.length} unknown CDB field(s) verbatim on the rewritten record.`,
			context: { cdbFile: settings.cdbFile.value, tags: preserved },
		});
	}
}

export function buildDevicesErrorEnvelope(
	command: DevicesCommand,
	settings: DevicesSettings,
	warnings: readonly DevicesWarning[],
	error: unknown,
): CentrsEnvelope<never, DevicesOperationMeta> {
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
		error: serializeCentrsError(centrsError),
		warnings,
		meta: devicesMeta(command, settings),
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

	switch (envelope.meta.operation?.command) {
		case "list":
			renderListText(lines, envelope.data as readonly DevicesListItem[]);
			break;
		case "show":
			renderShowText(lines, envelope.data as DevicesShowEnvelopeData);
			break;
		case "groups":
			renderGroupsText(lines, envelope.data as readonly DevicesGroupSummary[]);
			break;
		case "add":
		case "edit":
		case "set":
		case "remove":
			renderMutationText(lines, envelope.data as DevicesMutationData);
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

function renderMutationText(lines: string[], data: DevicesMutationData): void {
	const verb =
		data.action === "remove" ? "removed" : data.replaced ? "updated" : "added";
	lines.push(`${verb} ${data.target} (cdb-index ${data.cdbRecordIndex})`);
	lines.push(`records:       ${data.recordCount}`);
	if (data.backupPath) {
		lines.push(`backup:        ${data.backupPath}`);
	}
	if (data.prunedBackups.length > 0) {
		lines.push(`pruned-backups: ${data.prunedBackups.length}`);
	}
	if (data.preservedUnknownTags && data.preservedUnknownTags.length > 0) {
		lines.push(
			`preserved-unknown-tags: ${data.preservedUnknownTags.join(", ")}`,
		);
	}
	if (data.entry) {
		lines.push(`user:          ${data.entry.user || "-"}`);
		lines.push(`group:         ${data.entry.group || "-"}`);
		lines.push(`comment:       ${data.entry.comment || "-"}`);
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
