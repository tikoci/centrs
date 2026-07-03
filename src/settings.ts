/**
 * `settings` — read/write centrs's own global preferences (`centrs.env`) and
 * probe the `__default__` CDB record. Transport-less, like `devices`: no
 * RouterOS device is ever touched, `meta.via` is always `null`, and the
 * matrix row stays `—`. See `commands/settings/README.md` for the full
 * product spec this module implements.
 *
 * `centrs.env` holds one `CENTRS_KEY=value` line per managed setting.
 * `settings` always reads/writes the REAL file regardless of
 * `--skip-env-file`/`CENTRS_SKIP_ENV_FILE` — that flag only controls whether
 * *other* commands' resolvers see the file (`resolver/config-file.ts`'s
 * `loadEnvFileDefaults`); inspecting/editing the file is this command's job.
 */

import { copyFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
	CentrsEnvelope,
	CentrsErrorEnvelope,
	CentrsSuccessEnvelope,
	EnvelopeMeta,
	SettingSource,
	Tip,
	Warning,
} from "./core/envelope.ts";
import { buildTip } from "./core/envelope.ts";
import { loadCdb, resolveDevicesSettings } from "./devices.ts";
import { CentrsError, serializeCentrsError } from "./errors.ts";
import { plannedProtocols, type RouterOsProtocol } from "./protocols/index.ts";
import {
	DEFAULT_RECORD_TARGET,
	defaultSettingsPath,
	parseBoolean,
	parseDuration,
	parseEnvFileDefaults,
	parseResolvePolicy,
	readSettingsFileRaw,
	resolveOptionalIntegerSetting,
} from "./resolver/index.ts";
import { retrieveOutputFormats, toYaml } from "./retrieve.ts";

// ── Envelope shape ───────────────────────────────────────────────────────────

export type SettingsCommand = "print" | "get" | "set" | "reset";

export interface SettingsOperationMeta {
	command: SettingsCommand;
	settingsFile: string;
}

export type SettingsEnvelope<Data> = CentrsEnvelope<
	Data,
	SettingsOperationMeta
>;
export type SettingsSuccessEnvelope<Data> = CentrsSuccessEnvelope<
	Data,
	SettingsOperationMeta
>;
export type SettingsErrorEnvelope = CentrsErrorEnvelope<SettingsOperationMeta>;

function settingsMeta(
	command: SettingsCommand,
	settingsFile: string,
): EnvelopeMeta<SettingsOperationMeta> {
	return {
		target: {},
		via: null,
		settings: {},
		operation: { command, settingsFile },
	};
}

export function buildSettingsErrorEnvelope(
	command: SettingsCommand,
	settingsFile: string,
	warnings: readonly Warning[],
	error: unknown,
): SettingsErrorEnvelope {
	const centrsError =
		error instanceof CentrsError
			? error
			: new CentrsError({
					code: "internal/settings-failed",
					summary: error instanceof Error ? error.message : String(error),
					cause: error,
				});
	return {
		ok: false,
		error: serializeCentrsError(centrsError),
		warnings,
		tips: [],
		meta: settingsMeta(command, settingsFile),
	};
}

// ── Managed key registry ─────────────────────────────────────────────────────

/** A managed key's typed value, as reported by `get`/`print`. */
export type SettingsValue = string | number | boolean;

interface ParsedSetting {
	value: SettingsValue;
	/** Canonical on-disk form. Differs from `value` only for booleans (1/0). */
	write: string;
}

export interface SettingsKeyDef {
	/** Kebab-case CLI-facing name, e.g. "max-results". */
	attr: string;
	/** `CENTRS_*` env var name. */
	envKey: string;
	/** Per-device CDB comment-kv counterpart, if one exists (informational only). */
	commentKvKey?: string;
	/** Only true for `format`: the built-in default genuinely varies by command. */
	hasPerCommandDefault?: boolean;
	/** Parse + validate raw input. Throws a `settings/invalid-*` CentrsError on bad input. */
	parse: (raw: string, envKey: string) => ParsedSetting;
	/** A one-line reminder to surface as a warning when `set` accepts this value. */
	warn?: (value: SettingsValue) => string | undefined;
}

function parseBooleanSetting(raw: string, envKey: string): ParsedSetting {
	const value = parseBoolean(raw, envKey);
	return { value, write: value ? "1" : "0" };
}

function parseIntegerSetting(raw: string, envKey: string): ParsedSetting {
	const resolved = resolveOptionalIntegerSetting(
		undefined,
		{ [envKey]: raw },
		envKey,
		envKey,
	);
	// resolveOptionalIntegerSetting only returns undefined when the env var is
	// absent, which cannot happen here — we always supply it.
	const value = resolved?.value as number;
	return { value, write: String(value) };
}

function parsePassthroughString(raw: string): ParsedSetting {
	const value = raw.trim();
	return { value, write: value };
}

const TRANSFER_VIA_VALUES = [
	"auto",
	"rest",
	"rest-api",
	"native",
	"native-api",
	"sftp",
	"scp",
	"fetch",
	"ftp",
] as const;

/**
 * The 13 `CENTRS_*` keys `settings` fully manages (validated get/set/print/
 * reset). `commands/settings/README.md` ("Not yet wired — exclude from v1")
 * deliberately excludes `CENTRS_CONCURRENCY`/`CENTRS_DISCOVER_TIMEOUT`/
 * `CENTRS_CHECK_IGNORE` — no shipped command reads them yet.
 */
export const settingsManagedKeys: readonly SettingsKeyDef[] = [
	{
		attr: "format",
		envKey: "CENTRS_FORMAT",
		hasPerCommandDefault: true,
		parse: (raw) => {
			const value = raw.trim();
			if (
				!retrieveOutputFormats.includes(
					value as (typeof retrieveOutputFormats)[number],
				)
			) {
				throw new CentrsError({
					code: "settings/invalid-format",
					summary: `Unsupported output format: ${value}`,
					remediation: `Choose one of ${retrieveOutputFormats.join(", ")}.`,
				});
			}
			return { value, write: value };
		},
	},
	{
		attr: "cdb-file",
		envKey: "CENTRS_CDB_FILE",
		parse: parsePassthroughString,
	},
	{
		attr: "max-results",
		envKey: "CENTRS_MAX_RESULTS",
		parse: parseIntegerSetting,
	},
	{
		attr: "resolve",
		envKey: "CENTRS_RESOLVE",
		parse: (raw, envKey) => {
			const value = parseResolvePolicy(raw);
			// parseResolvePolicy uses `validation/option`, not a `settings/*` code —
			// intentional: `settings set resolve <bad>` should fail identically to
			// setting the raw CENTRS_RESOLVE env var, since both funnel through the
			// same validator.
			void envKey;
			return { value, write: value };
		},
	},
	{
		attr: "mcp-allow-adhoc",
		envKey: "CENTRS_MCP_ALLOW_ADHOC",
		parse: parseBooleanSetting,
	},
	{
		attr: "via",
		envKey: "CENTRS_VIA",
		commentKvKey: "via",
		parse: (raw) => {
			const value = raw.trim();
			if (!plannedProtocols.includes(value as RouterOsProtocol)) {
				throw new CentrsError({
					code: "settings/invalid-via",
					summary: `Unsupported protocol identifier: ${value}`,
					remediation: `Choose one of ${plannedProtocols.join(", ")}.`,
					context: { via: value },
				});
			}
			return { value, write: value };
		},
	},
	{
		attr: "validate",
		envKey: "CENTRS_VALIDATE",
		commentKvKey: "validate",
		parse: parseBooleanSetting,
	},
	{
		attr: "timeout",
		envKey: "CENTRS_TIMEOUT",
		commentKvKey: "timeout",
		parse: (raw) => {
			const value = parseDuration(raw);
			if (value <= 0) {
				throw new CentrsError({
					code: "settings/invalid-timeout",
					summary: `Timeout must be greater than zero. Received: ${raw}`,
					remediation:
						"Use a positive integer in milliseconds or a suffix like `5s` / `500ms`.",
				});
			}
			return { value, write: String(value) };
		},
	},
	{
		attr: "port",
		envKey: "CENTRS_PORT",
		commentKvKey: "port",
		parse: parseIntegerSetting,
	},
	{
		attr: "ssh-key",
		envKey: "CENTRS_SSH_KEY",
		commentKvKey: "ssh-key",
		parse: parsePassthroughString,
	},
	{
		attr: "insecure",
		envKey: "CENTRS_INSECURE",
		commentKvKey: "insecure",
		parse: parseBooleanSetting,
		warn: (value) =>
			value === true
				? "Accepting RouterOS's self-signed TLS cert / unknown SSH host key globally. Every command run without an explicit --insecure/--no-insecure override will trust an unverified peer."
				: undefined,
	},
	{
		attr: "transfer-via",
		envKey: "CENTRS_TRANSFER_VIA",
		parse: (raw) => {
			const value = raw.trim().toLowerCase();
			if (!(TRANSFER_VIA_VALUES as readonly string[]).includes(value)) {
				throw new CentrsError({
					code: "settings/invalid-via",
					summary: `Unsupported transfer method: ${value}`,
					remediation: `Choose one of ${TRANSFER_VIA_VALUES.join(", ")}.`,
					context: { via: value },
				});
			}
			return { value, write: value };
		},
		warn: (value) =>
			value === "ftp"
				? "`transfer` currently rejects `ftp` at call time unless ALLOW_UNSAFE_PROTOCOLS includes it (settings/unsafe-protocol-blocked) — this value will not work until that opt-in is also set."
				: undefined,
	},
	{
		attr: "host",
		envKey: "CENTRS_HOST",
		parse: parsePassthroughString,
	},
];

interface RefusedKeyDef {
	attr: string;
	envKey: string;
	/** Secret-shaped: always redacted on read, regardless of source. */
	secret: boolean;
	remediation: string;
}

/**
 * Credential-shaped or self-referential keys `set`/`reset` must refuse.
 * `get`/`print` still work as read-only inspection (README: Scope boundary).
 */
export const settingsRefusedKeys: readonly RefusedKeyDef[] = [
	{
		attr: "password",
		envKey: "CENTRS_PASSWORD",
		secret: true,
		remediation:
			"Use `centrs devices add __default__ --user … --password …` — default credentials belong on the __default__ CDB record, not a plaintext file.",
	},
	{
		attr: "username",
		envKey: "CENTRS_USERNAME",
		secret: false,
		remediation:
			"Use `centrs devices add __default__ --user …` — default credentials belong on the __default__ CDB record.",
	},
	{
		attr: "cdb-password",
		envKey: "CENTRS_CDB_PASSWORD",
		secret: true,
		remediation:
			"Pass --cdb-password per invocation, export CENTRS_CDB_PASSWORD in the calling shell, or use Bun.secret() once available — never persist a CDB decrypt password to centrs.env.",
	},
	{
		attr: "skip-env-file",
		envKey: "CENTRS_SKIP_ENV_FILE",
		secret: false,
		remediation:
			"Export CENTRS_SKIP_ENV_FILE in the shell or pass --skip-env-file per call — writing it into the file it tells centrs to ignore is a no-op by construction.",
	},
	{
		attr: "run-fast-integration",
		envKey: "CENTRS_RUN_FAST_INTEGRATION",
		secret: false,
		remediation:
			"This is a CI/test signal set by `bun run test:integration`, never by a human.",
	},
];

/** Normalize `CENTRS_MAX_RESULTS` / `max-results` / `centrs_format` / `FORMAT` to one kebab-case form. */
function normalizeAttrName(input: string): string {
	let name = input.trim();
	if (/^centrs[_-]/i.test(name)) {
		name = name.replace(/^centrs[_-]/i, "");
	}
	return name.toLowerCase().replace(/_/g, "-");
}

type AttrLookup =
	| { kind: "managed"; def: SettingsKeyDef }
	| { kind: "refused"; def: RefusedKeyDef }
	| { kind: "unknown" };

function lookupAttr(input: string): AttrLookup {
	const normalized = normalizeAttrName(input);
	const managed = settingsManagedKeys.find((def) => def.attr === normalized);
	if (managed) {
		return { kind: "managed", def: managed };
	}
	const refused = settingsRefusedKeys.find((def) => def.attr === normalized);
	if (refused) {
		return { kind: "refused", def: refused };
	}
	return { kind: "unknown" };
}

function unknownKeyError(input: string): CentrsError {
	return new CentrsError({
		code: "settings/unknown-key",
		summary: `"${input}" is not a recognized centrs setting.`,
		remediation:
			"Run `centrs settings print --all` to see recognized keys plus any unrecognized CENTRS_* lines already in the file.",
		context: { attr: input },
	});
}

function reservedKeyError(def: RefusedKeyDef): CentrsError {
	return new CentrsError({
		code: "settings/reserved-key",
		summary: `"${def.attr}" (${def.envKey}) cannot be written by settings.`,
		remediation: def.remediation,
		context: { attr: def.attr, envKey: def.envKey },
	});
}

/** `format`'s built-in default genuinely varies per command — the only key this applies to. */
const FORMAT_PER_COMMAND_DEFAULT: Record<string, string> = {
	retrieve: "text",
	execute: "text",
	transfer: "text",
	api: "json",
};

// ── Shared file I/O ──────────────────────────────────────────────────────────

async function readRawLines(path: string): Promise<string[]> {
	const { lines } = await readSettingsFileRaw(path);
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		return lines.slice(0, -1);
	}
	return [...lines];
}

function findLineIndex(lines: readonly string[], envKey: string): number {
	return lines.findIndex((line) => {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) {
			return false;
		}
		const eq = trimmed.indexOf("=");
		if (eq <= 0) {
			return false;
		}
		return trimmed.slice(0, eq).trim() === envKey;
	});
}

function rawValueAtLine(lines: readonly string[], index: number): string {
	const line = (lines[index] ?? "").trim();
	return line.slice(line.indexOf("=") + 1).trim();
}

/**
 * Atomic write, scaled down from `data/winbox-cdb-write.ts`'s pattern: a
 * single `.bak` copy (this file has no multi-KB record set or retention
 * policy to manage), temp file + fsync + rename.
 */
async function writeSettingsFileLines(
	path: string,
	lines: readonly string[],
): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	if (await Bun.file(path).exists()) {
		await copyFile(path, `${path}.bak`);
	}
	const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
	const tempPath = join(
		dir,
		`${basename(path)}.tmp.${process.pid}.${Date.now().toString(36)}`,
	);
	const handle = await open(tempPath, "w");
	try {
		await handle.write(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(tempPath, path);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
	await syncDirectory(dir);
}

/** Best-effort directory fsync so the rename is durable across a crash. */
async function syncDirectory(dir: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(dir, "r");
		await handle.sync();
	} catch {
		// Directory fsync is unsupported on some platforms; the rename itself is
		// still atomic, so this is best-effort durability only.
	} finally {
		await handle?.close();
	}
}

// ── print ────────────────────────────────────────────────────────────────────

export interface SettingsKeyEntry {
	value: SettingsValue | null;
	source: SettingSource;
	perCommandDefault?: Record<string, string>;
	isSet?: boolean;
}

export interface SettingsUnrecognizedEntry {
	key: string;
	value: string;
}

export interface SettingsDefaultDeviceSummary {
	configured: boolean;
	user?: string;
	passwordSet?: boolean;
}

export interface SettingsPrintData {
	[attr: string]:
		| SettingsKeyEntry
		| readonly SettingsUnrecognizedEntry[]
		| SettingsDefaultDeviceSummary
		| undefined;
	unrecognized?: readonly SettingsUnrecognizedEntry[];
	defaultDevice?: SettingsDefaultDeviceSummary;
}

export interface SettingsPrintArgs {
	/** Print only this key, instead of every managed key. */
	attr?: string;
	/** Additionally list unrecognized `CENTRS_*` lines present in the file. */
	all?: boolean;
	env: Record<string, string | undefined>;
	/** True when the invocation passed `--skip-env-file` (informational only — see module docs). */
	skipEnvFile?: boolean;
	cdbFile?: string;
	cdbPassword?: string;
}

function redactIfSecret(
	def: RefusedKeyDef,
	rawValue: string,
	source: SettingSource,
): SettingsKeyEntry {
	if (def.secret) {
		return { value: "(redacted)", isSet: true, source };
	}
	return { value: rawValue, isSet: true, source };
}

/**
 * Resolve one managed key for display: env > config (raw file) > default.
 * Never `cli`/`comment-kv` — `settings` has no call context to produce them.
 * Tolerant of a malformed value (a hand-edited file should not break
 * inspecting every OTHER key) — falls back to the raw string with the
 * correct source rather than throwing, unlike {@link resolveGetEntry}.
 */
function resolvePrintEntry(
	def: SettingsKeyDef,
	env: Record<string, string | undefined>,
	config: Record<string, string>,
): SettingsKeyEntry {
	const envValue = env[def.envKey];
	if (envValue !== undefined) {
		return buildPrintEntryTolerant(def, envValue, {
			kind: "env",
			key: def.envKey,
		});
	}
	const configValue = config[def.envKey];
	if (configValue !== undefined) {
		return buildPrintEntryTolerant(def, configValue, {
			kind: "config",
			key: def.envKey,
		});
	}
	if (def.hasPerCommandDefault) {
		return {
			value: null,
			source: { kind: "default", key: def.attr },
			perCommandDefault: FORMAT_PER_COMMAND_DEFAULT,
		};
	}
	return { value: null, source: { kind: "default", key: def.attr } };
}

function buildPrintEntryTolerant(
	def: SettingsKeyDef,
	raw: string,
	source: SettingSource,
): SettingsKeyEntry {
	try {
		return { value: def.parse(raw, def.envKey).value, source };
	} catch {
		// Malformed value in a hand-edited file/env: report it as-is rather than
		// failing the whole `print` call. `get` on this same key still throws.
		return { value: raw, source };
	}
}

/**
 * Parse a raw on-disk value for reporting as `set`'s `previous`, tolerating a
 * malformed value rather than throwing — a hand-edited file with garbage in
 * it (e.g. `CENTRS_PORT=abc`) must not block `set` from overwriting it with a
 * valid one. Mirrors {@link buildPrintEntryTolerant}'s tolerance.
 */
function parsePreviousTolerant(
	def: SettingsKeyDef,
	raw: string,
): SettingsValue {
	try {
		return def.parse(raw, def.envKey).value;
	} catch {
		return raw;
	}
}

function collectUnrecognized(
	lines: readonly string[],
): readonly SettingsUnrecognizedEntry[] {
	// Only managed keys are "known" here — refused keys (e.g. a hand-added
	// CENTRS_PASSWORD line) deliberately fall through to this listing so
	// `print --all` still surfaces them (redacted via secretKeys below)
	// instead of silently hiding them because they're recognized-but-refused.
	const knownKeys = new Set<string>(
		settingsManagedKeys.map((def) => def.envKey),
	);
	const secretKeys = new Set(
		settingsRefusedKeys.filter((def) => def.secret).map((def) => def.envKey),
	);
	const entries: SettingsUnrecognizedEntry[] = [];
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) {
			continue;
		}
		const eq = line.indexOf("=");
		if (eq <= 0) {
			continue;
		}
		const key = line.slice(0, eq).trim();
		if (!key.startsWith("CENTRS_") || knownKeys.has(key)) {
			continue;
		}
		const value = line.slice(eq + 1).trim();
		entries.push({
			key,
			value: secretKeys.has(key) ? "(redacted)" : value,
		});
	}
	return entries;
}

/**
 * Probe the `__default__` CDB record for `print`'s summary. Deliberately
 * never consults the `centrs.env` config tier for the CDB path (README
 * Surface: "never centrs.env") — only cli/env, matching `resolveDevicesSettings`
 * called with no `config`. A missing CDB is `{configured: false}`, not an
 * error, unlike `devices list` — settings should never require a CDB to exist.
 */
async function probeDefaultDevice(
	args: Pick<SettingsPrintArgs, "cdbFile" | "cdbPassword" | "env">,
): Promise<SettingsDefaultDeviceSummary> {
	const settings = resolveDevicesSettings({
		cdbFile: args.cdbFile,
		cdbPassword: args.cdbPassword,
		env: args.env,
	});
	if (!(await Bun.file(settings.cdbFile.value).exists())) {
		return { configured: false };
	}
	const cdb = await loadCdb({
		cdbFile: settings.cdbFile.value,
		cdbPassword: args.cdbPassword,
		env: args.env,
	});
	const entry = cdb.entries.find(
		(candidate) => candidate.target === DEFAULT_RECORD_TARGET,
	);
	if (!entry) {
		return { configured: false };
	}
	return {
		configured: true,
		...(entry.user ? { user: entry.user } : {}),
		passwordSet: entry.password.length > 0,
	};
}

export async function settingsPrint(
	args: SettingsPrintArgs,
): Promise<SettingsSuccessEnvelope<SettingsPrintData>> {
	const settingsFile = defaultSettingsPath(args.env);
	const lines = await readRawLines(settingsFile);
	const config = parseEnvFileDefaults(lines);
	const warnings: Warning[] = [];

	if (args.attr !== undefined) {
		const lookup = lookupAttr(args.attr);
		if (lookup.kind === "unknown") {
			throw unknownKeyError(args.attr);
		}
		const data: SettingsPrintData = {};
		if (lookup.kind === "managed") {
			data[lookup.def.attr] = resolvePrintEntry(lookup.def, args.env, config);
		} else {
			data[lookup.def.attr] = resolveRefusedEntry(lookup.def, args.env, config);
		}
		return {
			ok: true,
			data,
			warnings,
			tips: [],
			meta: settingsMeta("print", settingsFile),
		};
	}

	const data: SettingsPrintData = {};
	for (const def of settingsManagedKeys) {
		data[def.attr] = resolvePrintEntry(def, args.env, config);
	}
	if (args.all) {
		data.unrecognized = collectUnrecognized(lines);
	}
	data.defaultDevice = await probeDefaultDevice(args);

	if (args.skipEnvFile) {
		warnings.push({
			code: "settings/skip-env-file-active",
			message:
				"--skip-env-file is active for this invocation: other commands run in this same environment would not see these centrs.env values. `settings` itself always reads the real file.",
		});
	}

	return {
		ok: true,
		data,
		warnings,
		tips: [],
		meta: settingsMeta("print", settingsFile),
	};
}

// ── get ──────────────────────────────────────────────────────────────────────

export type SettingsGetData = SettingsKeyEntry;

export interface SettingsGetArgs {
	attr: string;
	env: Record<string, string | undefined>;
}

/** Strict counterpart of {@link resolvePrintEntry}: throws on a malformed value. */
function resolveGetEntry(
	def: SettingsKeyDef,
	env: Record<string, string | undefined>,
	config: Record<string, string>,
): SettingsKeyEntry {
	const envValue = env[def.envKey];
	if (envValue !== undefined) {
		return {
			value: def.parse(envValue, def.envKey).value,
			source: { kind: "env", key: def.envKey },
		};
	}
	const configValue = config[def.envKey];
	if (configValue !== undefined) {
		return {
			value: def.parse(configValue, def.envKey).value,
			source: { kind: "config", key: def.envKey },
		};
	}
	if (def.hasPerCommandDefault) {
		return {
			value: null,
			source: { kind: "default", key: def.attr },
			perCommandDefault: FORMAT_PER_COMMAND_DEFAULT,
		};
	}
	return { value: null, source: { kind: "default", key: def.attr } };
}

function resolveRefusedEntry(
	def: RefusedKeyDef,
	env: Record<string, string | undefined>,
	config: Record<string, string>,
): SettingsKeyEntry {
	const envValue = env[def.envKey];
	if (envValue !== undefined) {
		return redactIfSecret(def, envValue, { kind: "env", key: def.envKey });
	}
	const configValue = config[def.envKey];
	if (configValue !== undefined) {
		return redactIfSecret(def, configValue, {
			kind: "config",
			key: def.envKey,
		});
	}
	return {
		value: null,
		isSet: false,
		source: { kind: "default", key: def.attr },
	};
}

function viaCommentKvTip(def: SettingsKeyDef): Tip[] {
	if (def.commentKvKey === undefined) {
		return [];
	}
	return [
		buildTip(
			"tip/comment-kv-may-override",
			`A device's own \`${def.commentKvKey}=\` comment-kv override, if set, takes precedence over this global default.`,
			`Check a specific device with \`centrs devices show <target>\`.`,
		),
	];
}

export async function settingsGet(
	args: SettingsGetArgs,
): Promise<SettingsSuccessEnvelope<SettingsGetData>> {
	const settingsFile = defaultSettingsPath(args.env);
	const lines = await readRawLines(settingsFile);
	const config = parseEnvFileDefaults(lines);
	const lookup = lookupAttr(args.attr);
	if (lookup.kind === "unknown") {
		throw unknownKeyError(args.attr);
	}
	const data =
		lookup.kind === "managed"
			? resolveGetEntry(lookup.def, args.env, config)
			: resolveRefusedEntry(lookup.def, args.env, config);
	const tips = lookup.kind === "managed" ? viaCommentKvTip(lookup.def) : [];
	return {
		ok: true,
		data,
		warnings: [],
		tips,
		meta: settingsMeta("get", settingsFile),
	};
}

// ── set ──────────────────────────────────────────────────────────────────────

export interface SettingsSetData {
	key: string;
	previous: SettingsValue | null;
	value: SettingsValue;
}

export interface SettingsSetArgs {
	attr: string;
	value: string;
	env: Record<string, string | undefined>;
}

export async function settingsSet(
	args: SettingsSetArgs,
): Promise<SettingsSuccessEnvelope<SettingsSetData>> {
	const settingsFile = defaultSettingsPath(args.env);
	const lookup = lookupAttr(args.attr);
	if (lookup.kind === "unknown") {
		throw unknownKeyError(args.attr);
	}
	if (lookup.kind === "refused") {
		throw reservedKeyError(lookup.def);
	}
	const def = lookup.def;
	const parsed = def.parse(args.value, def.envKey);

	const lines = await readRawLines(settingsFile);
	const index = findLineIndex(lines, def.envKey);
	const previousRaw = index >= 0 ? rawValueAtLine(lines, index) : undefined;
	const previous =
		previousRaw !== undefined ? parsePreviousTolerant(def, previousRaw) : null;

	const newLine = `${def.envKey}=${parsed.write}`;
	if (index >= 0) {
		lines[index] = newLine;
	} else {
		lines.push(newLine);
	}
	await writeSettingsFileLines(settingsFile, lines);

	const warnings: Warning[] = [];
	const warning = def.warn?.(parsed.value);
	if (warning !== undefined) {
		warnings.push({ code: "settings/consequential-value", message: warning });
	}

	return {
		ok: true,
		data: { key: def.attr, previous, value: parsed.value },
		warnings,
		tips: [],
		meta: settingsMeta("set", settingsFile),
	};
}

// ── reset ────────────────────────────────────────────────────────────────────

export interface SettingsResetData {
	key?: string;
	wasSet?: boolean;
	cleared?: readonly string[];
}

export interface SettingsResetArgs {
	attr?: string;
	env: Record<string, string | undefined>;
}

export async function settingsReset(
	args: SettingsResetArgs,
): Promise<SettingsSuccessEnvelope<SettingsResetData>> {
	const settingsFile = defaultSettingsPath(args.env);

	if (args.attr !== undefined) {
		const lookup = lookupAttr(args.attr);
		if (lookup.kind === "unknown") {
			throw unknownKeyError(args.attr);
		}
		if (lookup.kind === "refused") {
			throw reservedKeyError(lookup.def);
		}
		const lines = await readRawLines(settingsFile);
		const index = findLineIndex(lines, lookup.def.envKey);
		const wasSet = index >= 0;
		if (wasSet) {
			lines.splice(index, 1);
			await writeSettingsFileLines(settingsFile, lines);
		}
		return {
			ok: true,
			data: { key: lookup.def.attr, wasSet },
			warnings: [],
			tips: [],
			meta: settingsMeta("reset", settingsFile),
		};
	}

	const lines = await readRawLines(settingsFile);
	const managedEnvKeys = new Map(
		settingsManagedKeys.map((def) => [def.envKey, def.attr]),
	);
	const cleared: string[] = [];
	const kept = lines.filter((line) => {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) {
			return true;
		}
		const eq = trimmed.indexOf("=");
		if (eq <= 0) {
			return true;
		}
		const key = trimmed.slice(0, eq).trim();
		const attr = managedEnvKeys.get(key);
		if (attr === undefined) {
			return true;
		}
		cleared.push(attr);
		return false;
	});
	if (cleared.length > 0) {
		await writeSettingsFileLines(settingsFile, kept);
	}

	return {
		ok: true,
		data: { cleared },
		warnings: [],
		tips: [],
		meta: settingsMeta("reset", settingsFile),
	};
}

// ── Rendering ────────────────────────────────────────────────────────────────

export type SettingsOutputFormat = "text" | "json" | "yaml";
export const settingsOutputFormats: readonly SettingsOutputFormat[] = [
	"text",
	"json",
	"yaml",
];

export function renderSettingsEnvelope(
	envelope: SettingsEnvelope<unknown>,
	format: SettingsOutputFormat,
): string {
	if (format === "json") {
		return JSON.stringify(envelope, null, 2);
	}
	if (format === "yaml") {
		return toYaml(envelope);
	}
	return envelope.ok
		? renderSettingsSuccessText(envelope)
		: renderSettingsErrorText(envelope);
}

function formatValue(value: SettingsValue | null): string {
	if (value === null) {
		return "(unset)";
	}
	return String(value);
}

function renderSettingsSuccessText(
	envelope: SettingsSuccessEnvelope<unknown>,
): string {
	const lines: string[] = [];
	const command = envelope.meta.operation?.command;
	const data = envelope.data as Record<string, unknown>;

	if (command === "print" || command === "get") {
		for (const [key, entry] of Object.entries(data)) {
			if (key === "unrecognized" || key === "defaultDevice") {
				continue;
			}
			const typed = entry as SettingsKeyEntry;
			const sourceKey = typed.source.key ? ` (${typed.source.key})` : "";
			lines.push(
				`${key}: ${formatValue(typed.value)} [source: ${typed.source.kind}${sourceKey}]`,
			);
		}
		const unrecognized = data["unrecognized"] as
			| readonly SettingsUnrecognizedEntry[]
			| undefined;
		if (unrecognized && unrecognized.length > 0) {
			lines.push("");
			lines.push("Unrecognized CENTRS_* lines:");
			for (const item of unrecognized) {
				lines.push(`  ${item.key}=${item.value} (unrecognized)`);
			}
		}
		const defaultDevice = data["defaultDevice"] as
			| SettingsDefaultDeviceSummary
			| undefined;
		if (defaultDevice) {
			lines.push("");
			lines.push(
				defaultDevice.configured
					? `__default__: configured (user=${defaultDevice.user ?? "(none)"}, passwordSet=${defaultDevice.passwordSet ?? false})`
					: "__default__: not configured",
			);
		}
	} else if (command === "set") {
		const set = data as unknown as SettingsSetData;
		lines.push(
			`${set.key}: ${formatValue(set.previous)} -> ${formatValue(set.value)}`,
		);
	} else if (command === "reset") {
		const reset = data as unknown as SettingsResetData;
		if (reset.cleared !== undefined) {
			lines.push(
				reset.cleared.length > 0
					? `Cleared: ${reset.cleared.join(", ")}`
					: "Nothing to clear.",
			);
		} else {
			lines.push(
				reset.wasSet
					? `${reset.key}: reset to built-in default.`
					: `${reset.key}: was not set.`,
			);
		}
	}

	if (envelope.warnings.length > 0) {
		lines.push("");
		for (const warning of envelope.warnings) {
			lines.push(`warning [${warning.code}]: ${warning.message}`);
		}
	}
	if (envelope.tips.length > 0) {
		lines.push("");
		lines.push("Tips:");
		for (const item of envelope.tips) {
			lines.push(`  - [${item.code}] ${item.message}`);
		}
	}

	return lines.join("\n");
}

function renderSettingsErrorText(envelope: SettingsErrorEnvelope): string {
	const error = envelope.error;
	const lines = [`[${error.code}] ${error.summary}`];
	if (error.remediation) {
		lines.push(`Fix: ${error.remediation}`);
	}
	return lines.join("\n");
}
