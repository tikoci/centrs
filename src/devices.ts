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
	Tip,
} from "./core/envelope.ts";
import { buildTip as tip } from "./core/envelope.ts";
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
import { parseDeviceRecord } from "./devices-schema.ts";
import { CentrsError, serializeCentrsError } from "./errors.ts";
import { plannedProtocols, type RouterOsProtocol } from "./protocols/index.ts";
import {
	applyCommentKv,
	type CommentKvUpdate,
	commentKvAllowlist,
	commentKvLookupKeys,
	commentKvReservedKeys,
	parseCommentKv,
} from "./resolver/comment-kv.ts";
import { normalizeMac } from "./resolver/mac.ts";

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
	/**
	 * The `centrs.env` config tier (`src/resolver/config-file.ts`). Only
	 * `CENTRS_CDB_FILE` reads it — `CENTRS_CDB_PASSWORD` deliberately never
	 * does, same reasoning as `CENTRS_USERNAME`/`CENTRS_PASSWORD` in
	 * `resolver/target.ts`'s `resolveAuth`.
	 */
	config?: Record<string, string | undefined>;
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
	const configCdbFile = options.config?.[ENV_CDB_FILE];
	if (configCdbFile) {
		cdbFile = configCdbFile;
		cdbFileSource = { kind: "config", key: ENV_CDB_FILE };
	}
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
 * Mode `0o600` keeps the CDB (device credentials) unreadable by other local
 * users instead of falling back to the process umask default.
 */
async function createEmptyCdbNoClobber(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const handle = await open(path, "wx", 0o600);
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

/** Reserved CDB target supplying fallback creds (mirrors the resolver constant). */
const DEFAULT_RECORD_TARGET = "__default__";

/** Tip for an empty registry — the first-run / no-records-yet pointer. */
function noDevicesTips(entries: readonly WinBoxCdbEntry[]): Tip[] {
	if (entries.length > 0) {
		return [];
	}
	return [
		tip(
			"tip/no-devices",
			"The CDB has no device records yet.",
			"Add one with `centrs devices add <target> --user … --password …`.",
		),
	];
}

/** Tip when a resolved device carries no usable stored credentials. */
function credentialsMissingTips(
	entry: WinBoxCdbEntry,
	entries: readonly WinBoxCdbEntry[],
): Tip[] {
	const hasDefault = entries.some((e) => e.target === DEFAULT_RECORD_TARGET);
	if (entry.password !== "" || entry.savedPassword || hasDefault) {
		return [];
	}
	return [
		tip(
			"tip/credentials-missing",
			`Device "${entry.target}" has no stored password.`,
			"Pass --password at call time, set it with `centrs devices set`, or add a `__default__` record for fallback credentials.",
		),
	];
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
		tips: noDevicesTips(args.cdb.entries),
		meta: devicesMeta("list", args.cdb.settings),
	};
}

export interface ShowDeviceArgs {
	cdb: LoadedCdb;
	target: string;
	explain?: boolean;
	via?: string;
	/**
	 * Disambiguator when `<router>` matches more than one CDB entry. One of:
	 * `user=<name>`, `target=<addr>`, or a record-type token (a
	 * `winBoxCdbRecordType` name, e.g. `ipAdmin`/`ipUser`/`macTarget`). It cannot
	 * select between two entries that share every selectable attribute.
	 */
	match?: string;
	env?: Record<string, string | undefined>;
}

export interface DevicesShowEnvelopeData {
	entry: DevicesShowItem;
	record?: WinBoxCdbRecord;
}

/**
 * Canonical form for `<router>` comparison: a MAC is normalized (case /
 * separator / zero-pad insensitive via {@link normalizeMac}); everything else is
 * compared verbatim after trimming. Used for both `target` and the comment
 * lookup keys so `aa-b-cc-...` and `AA:0B:CC:...` resolve the same record.
 */
function canonicalRouterKey(value: string): string {
	const trimmed = value.trim();
	return normalizeMac(trimmed) ?? trimmed;
}

/**
 * Every identifier a record answers to: its `target` plus the `identity=` /
 * `mac=` / `ip=` comment lookup keys, each canonicalized. See
 * `commands/devices/README.md` (Identity model).
 */
function entryRouterKeys(entry: WinBoxCdbEntry): string[] {
	const keys = [canonicalRouterKey(entry.target)];
	const { lookups } = parseCommentKv(entry.comment);
	for (const value of [lookups.identity, lookups.mac, lookups.ip]) {
		if (value !== undefined && value.trim().length > 0) {
			keys.push(canonicalRouterKey(value));
		}
	}
	return keys;
}

/**
 * Find every CDB entry that `<router>` resolves to — by `target` or by an
 * `identity=` / `mac=` / `ip=` comment lookup key. The candidate set feeds the
 * ambiguity / `--match` selection in {@link showDevice} and the mutation path.
 */
function matchRouter(
	entries: readonly WinBoxCdbEntry[],
	router: string,
): EntryMatch[] {
	const want = canonicalRouterKey(router);
	const matches: EntryMatch[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry && entryRouterKeys(entry).includes(want)) {
			matches.push({ entry, index });
		}
	}
	return matches;
}

interface RouterMatchSelector {
	user?: string;
	target?: string;
	recordType?: number;
}

/**
 * Parse a `--match` token into a selector. Forms: `user=<name>`,
 * `target=<addr>`, or a bare {@link winBoxCdbRecordType} name (e.g. `ipUser`).
 * An unrecognized key or bare token throws `input/invalid-match`.
 */
function parseMatchSelector(
	match: string,
	contextTarget: string,
): RouterMatchSelector {
	const eq = match.indexOf("=");
	if (eq > 0) {
		const key = match.slice(0, eq);
		const value = match.slice(eq + 1);
		if (key === "user") {
			return { user: value };
		}
		if (key === "target") {
			return { target: canonicalRouterKey(value) };
		}
		throw new CentrsError({
			code: "input/invalid-match",
			summary: `--match key "${key}" is not supported.`,
			remediation:
				"Use --match user=<name>, --match target=<addr>, or a record-type token (e.g. ipAdmin / ipUser / macTarget).",
			context: { target: contextTarget, match },
		});
	}
	const recordType = recordTypeFromName(match);
	if (recordType === undefined) {
		throw new CentrsError({
			code: "input/invalid-match",
			summary: `--match "${match}" is not a known record type.`,
			remediation: `Pass --match user=<name>, --match target=<addr>, or one of ${Object.keys(winBoxCdbRecordType).join(", ")}.`,
			context: { target: contextTarget, match },
		});
	}
	return { recordType };
}

function applyMatchSelector(
	matches: readonly EntryMatch[],
	selector: RouterMatchSelector,
): EntryMatch[] {
	return matches.filter(({ entry }) => {
		if (selector.user !== undefined && entry.user !== selector.user) {
			return false;
		}
		if (
			selector.target !== undefined &&
			canonicalRouterKey(entry.target) !== selector.target
		) {
			return false;
		}
		if (
			selector.recordType !== undefined &&
			entry.recordType !== selector.recordType
		) {
			return false;
		}
		return true;
	});
}

function describeMatches(matches: readonly EntryMatch[]): {
	cdbRecordIndex: number;
	target: string;
	user: string;
	recordType: number;
}[] {
	return matches.map(({ entry, index }) => ({
		cdbRecordIndex: index,
		target: entry.target,
		user: entry.user,
		recordType: entry.recordType,
	}));
}

export function showDevice(
	args: ShowDeviceArgs,
): CentrsSuccessEnvelope<DevicesShowEnvelopeData, DevicesOperationMeta> {
	const match = requireSingleMatch(args.cdb.entries, args.target, args.match);
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
		tips: credentialsMissingTips(match.entry, args.cdb.entries),
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
		identity: parsed.lookups.identity ?? entry.target,
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
		tips: [],
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

/**
 * Entries whose (target, user) pair matches — the natural CDB record identity
 * (WinBox keys "Save to list" on address + user, so the same address under a
 * different user is a second record, not an update). `target` is canonicalized
 * so a MAC compares case/separator-insensitively; `user` is exact (empty string
 * when unset). See `commands/devices/README.md` (Identity model) and
 * `docs/CONSTITUTION.md` (Identity and CDB).
 */
function matchTargetUser(
	entries: readonly WinBoxCdbEntry[],
	target: string,
	user: string,
): EntryMatch[] {
	const want = canonicalRouterKey(target);
	const matches: EntryMatch[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (
			entry &&
			canonicalRouterKey(entry.target) === want &&
			entry.user === user
		) {
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
		tips: [],
		meta: devicesMeta(action, cdb.settings),
	};
}

const ALLOWLIST_SET = new Set<string>(commentKvAllowlist);
const RESERVED_SET = new Set<string>(commentKvReservedKeys);
const LOOKUP_SET = new Set<string>(commentKvLookupKeys);

/**
 * The `usage/not-implemented` error raised by `devices edit`, whose interactive
 * (clack/TUI) editor is reserved for the future. Field/metadata changes go
 * through `devices set`. Shared by the CLI and MCP so both surfaces agree.
 */
export function editInteractiveOnlyError(): CentrsError {
	return new CentrsError({
		code: "usage/not-implemented",
		summary:
			"`devices edit` is the interactive editor, which is not implemented yet.",
		remediation:
			"Use `centrs devices set <target> [--user …] [--password …] [k=v …]` for non-interactive field and metadata changes.",
	});
}

/**
 * Validate the `k=v` comment positionals shared by `add` and `set`. First-class
 * CDB fields are reserved and throw `cdb/reserved-key` (use the matching flag);
 * tokens outside the recognized override + lookup keys throw `cdb/unknown-option`
 * under `strict`, else append a `cdb/unknown-option` warning. Recognized keys
 * (allowlist overrides + `identity`/`mac`/`ip` lookups) pass silently.
 */
function validateCommentKvUpdates(
	updates: readonly CommentKvUpdate[],
	target: string,
	strict: boolean | undefined,
	warnings: DevicesWarning[],
): void {
	const reserved = updates
		.map((update) => update.key)
		.filter((key) => RESERVED_SET.has(key));
	if (reserved.length > 0) {
		throw new CentrsError({
			code: "cdb/reserved-key",
			summary: `Comment kv-soup cannot carry first-class CDB field(s): ${reserved.join(", ")}.`,
			remediation: `Set ${reserved.join(", ")} with the matching --flag; the comment kv-soup is for ${commentKvAllowlist.join(", ")} plus identity/mac/ip.`,
			context: { target, reservedKeys: reserved },
		});
	}
	for (const key of updates.map((update) => update.key)) {
		if (ALLOWLIST_SET.has(key) || LOOKUP_SET.has(key)) {
			continue;
		}
		if (strict) {
			throw new CentrsError({
				code: "cdb/unknown-option",
				summary: `Unknown comment option "${key}" rejected under --strict.`,
				remediation: `Drop --strict to write it verbatim, or use an allowlisted key: ${commentKvAllowlist.join(", ")}.`,
				context: { target, key },
			});
		}
		warnings.push({
			code: "cdb/unknown-option",
			message: `Comment option "${key}" is not recognized; it is written verbatim but has no effect.`,
			context: { target, key },
		});
	}
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
	/** `k=v` comment positionals upserted on top of `comment` (symmetric with set). */
	commentKvUpdates?: readonly CommentKvUpdate[];
	savedPassword?: boolean;
	force?: boolean;
	strict?: boolean;
	writeOptions?: WriteWinBoxCdbOptions;
}

export async function addDevice(
	args: AddDeviceArgs,
): Promise<DevicesMutationEnvelope> {
	const user = args.user ?? "";
	const matches = matchTargetUser(args.cdb.entries, args.target, user);
	if (matches.length > 1) {
		throw ambiguousTargetError(args.target, matches);
	}
	const existing = matches[0];
	if (existing && !args.force) {
		throw new CentrsError({
			code: "cdb/already-exists",
			summary: `A CDB entry for target "${args.target}" under user "${user}" already exists.`,
			remediation:
				"Pass --force to overwrite it, add it under a different --user, or use `centrs devices set` to change fields.",
			context: { target: args.target, user, cdbRecordIndex: existing.index },
		});
	}

	const warnings: DevicesWarning[] = [...args.cdb.warnings];
	const updates = args.commentKvUpdates ?? [];
	validateCommentKvUpdates(updates, args.target, args.strict, warnings);
	const comment =
		updates.length > 0 || args.comment !== undefined
			? applyCommentKv(args.comment ?? "", updates)
			: undefined;

	const carried = existing ? extraFields(existing.entry.record) : [];
	// Validate the logical record against the canonical schema before rendering
	// it to CDB bytes — a blank target or wrong field type fails here for every
	// caller (CLI, MCP, direct API), not just the CLI's own guards.
	const validated = parseDeviceRecord({
		recordType: args.recordType ?? winBoxCdbRecordType.ipAdmin,
		target: args.target,
		user: args.user,
		password: args.password,
		session: args.session,
		comment,
		group: args.group,
		profile: args.profile,
		savedPassword: args.savedPassword,
	});
	const record = buildWinBoxCdbEntryRecord({
		recordType: validated.recordType,
		target: validated.target,
		user: validated.user,
		password: validated.password,
		session: validated.session,
		comment,
		group: validated.group,
		profile: validated.profile,
		savedPassword: validated.savedPassword,
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
	appendUnknownFieldWarning(warnings, args.cdb.settings, preserved);
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

export interface SetDeviceArgs {
	cdb: LoadedCdb;
	target: string;
	/** Disambiguator passed through to {@link requireSingleMatch}. */
	match?: string;
	/** `k=v` comment positionals (overrides + identity/mac/ip lookups). */
	updates?: readonly CommentKvUpdate[];
	user?: string;
	password?: string;
	group?: string;
	profile?: string;
	session?: string;
	savedPassword?: boolean;
	strict?: boolean;
	writeOptions?: WriteWinBoxCdbOptions;
}

/**
 * Modify an existing CDB record (the `set` verb). Symmetric with {@link addDevice}:
 * first-class fields change via flags, comment override/lookup keys via `k=v`
 * positionals. Resolves `<router>` (target or lookup key) to a single record via
 * {@link requireSingleMatch}; a missing target throws `cdb/not-found-target`.
 * Unchanged fields and the comment's free-form prose are preserved verbatim.
 */
export async function setDevice(
	args: SetDeviceArgs,
): Promise<DevicesMutationEnvelope> {
	const match = requireSingleMatch(args.cdb.entries, args.target, args.match);
	const updates = args.updates ?? [];
	const warnings: DevicesWarning[] = [...args.cdb.warnings];
	validateCommentKvUpdates(updates, args.target, args.strict, warnings);

	const prior = match.entry;
	const comment = applyCommentKv(prior.comment, updates);
	const carried = extraFields(prior.record);

	const newlySet: number[] = [];
	if (args.user !== undefined) newlySet.push(winBoxCdbFieldTag.user);
	if (args.password !== undefined) newlySet.push(winBoxCdbFieldTag.password);
	if (args.session !== undefined) newlySet.push(winBoxCdbFieldTag.session);
	if (args.group !== undefined) newlySet.push(winBoxCdbFieldTag.group);
	if (args.profile !== undefined) newlySet.push(winBoxCdbFieldTag.profile);
	if (updates.length > 0) {
		newlySet.push(winBoxCdbFieldTag.comment, winBoxCdbFieldTag.commentMirror);
	}

	const savedPassword = resolveSavedPassword(
		args.savedPassword,
		args.password,
		prior.savedPassword,
	);
	// Validate the merged record (prior fields + this edit) against the canonical
	// schema. recordType/target are inherited and the schema is lenient about
	// record types it does not name, so an edit never regresses on an unusual
	// existing record; it does catch a wrong field type from a non-CLI caller.
	parseDeviceRecord({
		recordType: prior.recordType,
		target: prior.target,
		user: args.user ?? prior.user,
		password: args.password ?? prior.password,
		session: args.session ?? prior.session,
		comment,
		group: args.group ?? prior.group,
		profile: args.profile ?? (prior.profile || undefined),
		savedPassword,
	});
	const record = buildWinBoxCdbEntryRecord({
		recordType: prior.recordType,
		target: prior.target,
		user: args.user ?? prior.user,
		password: args.password ?? prior.password,
		session: args.session ?? prior.session,
		comment,
		group: args.group ?? prior.group,
		profile: args.profile ?? (prior.profile || undefined),
		romonAgent: prior.romonAgent || undefined,
		savedPassword,
		fieldOrder: preservedFieldOrder(prior.record, newlySet),
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
	/** Disambiguator passed through to {@link requireSingleMatch}. */
	match?: string;
	writeOptions?: WriteWinBoxCdbOptions;
}

export async function removeDevice(
	args: RemoveDeviceArgs,
): Promise<DevicesMutationEnvelope> {
	const match = requireSingleMatch(args.cdb.entries, args.target, args.match);
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

/**
 * Resolve `<router>` to exactly one CDB entry — the shared selection used by
 * `show` and the mutating verbs (`set`/`remove`). Matches by `target` or an
 * `identity=`/`mac=`/`ip=` lookup key, then narrows duplicates with the optional
 * `--match` selector (`user=`/`target=`/record-type). Throws
 * `cdb/not-found-target`, `identity/no-match`, or `identity/ambiguous`.
 */
function requireSingleMatch(
	entries: readonly WinBoxCdbEntry[],
	router: string,
	match?: string,
): EntryMatch {
	const matches = matchRouter(entries, router);
	if (matches.length === 0) {
		throw new CentrsError({
			code: "cdb/not-found-target",
			summary: `No CDB entry matches "${router}".`,
			remediation:
				"Run `centrs devices list` to see the available targets; `<router>` resolves by target, identity=, mac=, or ip=. Check spelling and address family.",
			context: { target: router },
		});
	}

	let selected = matches;
	if (match !== undefined) {
		const selector = parseMatchSelector(match, router);
		selected = applyMatchSelector(matches, selector);
		if (selected.length === 0) {
			throw new CentrsError({
				code: "identity/no-match",
				summary: `"${router}" has no CDB entry matching --match "${match}".`,
				remediation:
					"Run `centrs devices list` to see each candidate's user and record type, then pass a --match that exists.",
				context: { target: router, match, matches: describeMatches(matches) },
			});
		}
	}

	if (selected.length > 1) {
		const recordTypeTokens = Object.keys(winBoxCdbRecordType).join(", ");
		throw new CentrsError({
			code: "identity/ambiguous",
			summary: `"${router}" matches ${selected.length} CDB entries.`,
			remediation: `Re-run with --match user=<name>, --match target=<addr>, or --match <record-type> (one of ${recordTypeTokens}) to select among the duplicates, or remove the duplicate CDB entry.`,
			context: { target: router, matches: describeMatches(selected) },
		});
	}

	const match0 = selected[0];
	if (!match0) {
		throw new CentrsError({
			code: "internal/unreachable",
			summary: "Match list collapsed unexpectedly.",
		});
	}
	return match0;
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
		tips: [],
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
		appendTips(lines, envelope.tips);
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
	appendTips(lines, envelope.tips);
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

function appendTips(lines: string[], tips: readonly Tip[]): void {
	if (tips.length === 0) {
		return;
	}
	lines.push("Tips:");
	for (const item of tips) {
		lines.push(`  - [${item.code}] ${item.message}`);
		if (item.fix) {
			lines.push(`    fix: ${item.fix}`);
		}
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
