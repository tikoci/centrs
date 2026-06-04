/**
 * CDB identity + comment-kv override resolution.
 *
 * This is the transport-agnostic seam every command (`retrieve`, and later
 * `execute` / `devices`) shares for turning a `<router>` argument into a
 * concrete target plus per-device option overrides. It reuses the devices CDB
 * primitives (`loadCdb` / `showDevice`) so decode/decrypt logic lives in one
 * place, then layers the comment kv-soup contract on top.
 *
 * Comment-kv values arrive as RAW strings from {@link parseCommentKv}. This
 * module is where they are COERCED to typed settings and given `comment-kv`
 * provenance:
 *
 *   - `port`     → integer in 1..65535
 *   - `timeout`  → milliseconds (duration suffixes allowed)
 *   - `validate` → boolean
 *   - `via`      → a known `RouterOsProtocol`
 *   - `source`   → raw string (identity hint; not consumed yet — WP-2c seam)
 *
 * A malformed value is non-fatal: it emits a `cdb/invalid-option` warning
 * (carrying the offending key + raw value) and the override is dropped, so the
 * resolver falls through to the next precedence layer. The parser's own
 * `cdb/reserved-option` / `cdb/unknown-option` warnings are surfaced verbatim.
 *
 * ARP / MNDP identity fallback and group fanout are out of scope here
 * (WP-2c / WP-1b); the shape below leaves a clean seam for them.
 */

import type { WinBoxCdbEntry } from "../data/winbox-cdb.ts";
import {
	type DevicesWarning,
	type LoadedCdb,
	loadCdb,
	resolveDevicesSettings,
	showDevice,
} from "../devices.ts";
import { CentrsError } from "../errors.ts";
import { plannedProtocols, type RouterOsProtocol } from "../protocols/index.ts";
import { parseCommentKv } from "./comment-kv.ts";
import {
	parseBoolean,
	parseDuration,
	type ResolvedSetting,
} from "./settings.ts";

const ENV_CDB_FILE = "CENTRS_CDB_FILE";
const ENV_CDB_PASSWORD = "CENTRS_CDB_PASSWORD";

export interface ResolverWarning {
	code: string;
	message: string;
	context?: Record<string, unknown>;
}

/** Comment-kv overrides, coerced and tagged with `comment-kv` provenance. */
export interface CommentKvOverrides {
	via?: ResolvedSetting<RouterOsProtocol>;
	port?: ResolvedSetting<number>;
	timeoutMs?: ResolvedSetting<number>;
	validate?: ResolvedSetting<boolean>;
	/** Identity-source hint (e.g. `arp`); parsed but not consumed yet. */
	source?: ResolvedSetting<string>;
}

export interface CdbResolution {
	/** Resolved target string from the CDB record (host / IP / base URL). */
	target: string;
	/**
	 * Human-facing device handle: the `identity=` comment lookup key (mirroring
	 * RouterOS `/system/identity`), falling back to the matched record's target
	 * when the comment carries no `identity=`. Deliberately may repeat across
	 * records.
	 */
	identity: string;
	username: string;
	password: string;
	recordIndex: number;
	overrides: CommentKvOverrides;
	warnings: readonly ResolverWarning[];
}

export interface CdbResolveInput {
	targetInput?: string;
	cdbFile?: string;
	cdbPassword?: string;
}

function warningFromDevices(warning: DevicesWarning): ResolverWarning {
	return {
		code: warning.code,
		message: warning.message,
		context: warning.context,
	};
}

/**
 * Resolve a `<router>` argument against the CDB.
 *
 * Returns `undefined` when no CDB is in play (no explicit CDB inputs and the
 * default file is absent, or the default CDB has no matching record) — the
 * caller then treats `<router>` as a literal host. When an explicit CDB is
 * provided, a missing file/record surfaces as the underlying CDB error so the
 * "name not found without credentials" contract stays intact upstream.
 */
export async function resolveCdb(
	input: CdbResolveInput,
	env: Record<string, string | undefined>,
): Promise<CdbResolution | undefined> {
	if (!input.targetInput) {
		return undefined;
	}

	const settings = resolveDevicesSettings({
		cdbFile: input.cdbFile,
		cdbPassword: input.cdbPassword,
		env,
	});
	const explicitCdb =
		input.cdbFile !== undefined ||
		input.cdbPassword !== undefined ||
		env[ENV_CDB_FILE] !== undefined ||
		env[ENV_CDB_PASSWORD] !== undefined;
	if (!explicitCdb && !(await Bun.file(settings.cdbFile.value).exists())) {
		return undefined;
	}

	let cdb: LoadedCdb;
	try {
		cdb = await loadCdb({
			cdbFile: input.cdbFile,
			cdbPassword: input.cdbPassword,
			env,
		});
	} catch (error) {
		if (
			!explicitCdb &&
			error instanceof CentrsError &&
			error.code === "cdb/not-found"
		) {
			return undefined;
		}
		throw error;
	}

	try {
		const envelope = showDevice({ cdb, target: input.targetInput });
		const entry = envelope.data.entry;
		const warnings: ResolverWarning[] =
			envelope.warnings.map(warningFromDevices);
		const overrides = coerceCommentKv(
			entry.comment,
			entry.cdbRecordIndex,
			warnings,
		);
		return {
			target: entry.target,
			identity: identityFromComment(entry.comment, entry.target),
			username: entry.user,
			password: entry.password,
			recordIndex: entry.cdbRecordIndex,
			overrides,
			warnings,
		};
	} catch (error) {
		if (
			!explicitCdb &&
			error instanceof CentrsError &&
			error.code === "cdb/not-found-target"
		) {
			return undefined;
		}
		throw error;
	}
}

/** A single CDB group member resolved for fanout. */
export interface CdbGroupTarget {
	resolution: CdbResolution;
	recordIndex: number;
}

export interface CdbGroupExpansion {
	/** Group members ordered by CDB record index, de-duped. */
	targets: readonly CdbGroupTarget[];
	/** CDB load warnings plus a `cdb/empty-group` warning when empty. */
	warnings: readonly ResolverWarning[];
	/** True when no entry matched the group (unknown and empty are the same). */
	empty: boolean;
}

export interface CdbGroupResolveInput {
	group: string;
	cdbFile?: string;
	cdbPassword?: string;
}

/**
 * Expand a `--group` selector into N resolved CDB members for fanout. The CDB
 * is loaded + decrypted ONCE; every matching entry is turned into a
 * {@link CdbResolution} (identity + comment-kv overrides) ordered by record
 * index and de-duped by index. CDB groups are derived from entries, so an
 * unknown group is indistinguishable from an empty one — both return
 * `empty: true` with a `cdb/empty-group` warning rather than an error. A decrypt
 * or parse failure throws (the fanout's outer envelope reports it).
 */
export async function expandCdbGroup(
	input: CdbGroupResolveInput,
	env: Record<string, string | undefined>,
): Promise<CdbGroupExpansion> {
	const cdb: LoadedCdb = await loadCdb({
		cdbFile: input.cdbFile,
		cdbPassword: input.cdbPassword,
		env,
	});

	const warnings: ResolverWarning[] = cdb.warnings.map(warningFromDevices);
	const targets: CdbGroupTarget[] = [];
	const seen = new Set<number>();

	for (let index = 0; index < cdb.entries.length; index += 1) {
		const entry = cdb.entries[index];
		if (!entry || entry.group !== input.group || seen.has(index)) {
			continue;
		}
		seen.add(index);
		targets.push({
			recordIndex: index,
			resolution: resolutionFromEntry(entry, index),
		});
	}

	targets.sort((a, b) => a.recordIndex - b.recordIndex);

	if (targets.length === 0) {
		warnings.push({
			code: "cdb/empty-group",
			message: `No CDB entries matched group "${input.group}".`,
			context: { group: input.group },
		});
		return { targets: [], warnings, empty: true };
	}

	return { targets, warnings, empty: false };
}

function resolutionFromEntry(
	entry: WinBoxCdbEntry,
	recordIndex: number,
): CdbResolution {
	const recordWarnings: ResolverWarning[] = [];
	const overrides = coerceCommentKv(entry.comment, recordIndex, recordWarnings);
	return {
		target: entry.target,
		identity: identityFromComment(entry.comment, entry.target),
		username: entry.user,
		password: entry.password,
		recordIndex,
		overrides,
		warnings: recordWarnings,
	};
}

/**
 * The human-facing device handle for a record: the `identity=` comment lookup
 * key when present, else the record's `target`. Mirrors RouterOS
 * `/system/identity`; deliberately non-unique (collisions resolve through the
 * ambiguity path). See `commands/devices/README.md` (Identity model).
 */
export function identityFromComment(comment: string, target: string): string {
	return parseCommentKv(comment).lookups.identity ?? target;
}

/**
 * Parse + coerce the comment kv-soup of a single CDB record. Mutates
 * `warnings` with parser warnings and any `cdb/invalid-option` coercion
 * failures.
 */
export function coerceCommentKv(
	comment: string,
	recordIndex: number,
	warnings: ResolverWarning[],
): CommentKvOverrides {
	const parsed = parseCommentKv(comment);
	for (const warning of parsed.warnings) {
		warnings.push({
			code: warning.code,
			message: warning.message,
			context: warning.context,
		});
	}

	const overrides: CommentKvOverrides = {};
	const keyFor = (key: string): string => `record:${recordIndex}:${key}`;

	const via = coerceVia(parsed.values.via, recordIndex, warnings);
	if (via !== undefined) {
		overrides.via = {
			value: via,
			source: { kind: "comment-kv", key: keyFor("via") },
		};
	}

	const port = coercePort(parsed.values.port, recordIndex, warnings);
	if (port !== undefined) {
		overrides.port = {
			value: port,
			source: { kind: "comment-kv", key: keyFor("port") },
		};
	}

	const timeoutMs = coerceTimeout(parsed.values.timeout, recordIndex, warnings);
	if (timeoutMs !== undefined) {
		overrides.timeoutMs = {
			value: timeoutMs,
			source: { kind: "comment-kv", key: keyFor("timeout") },
		};
	}

	const validate = coerceValidate(
		parsed.values.validate,
		recordIndex,
		warnings,
	);
	if (validate !== undefined) {
		overrides.validate = {
			value: validate,
			source: { kind: "comment-kv", key: keyFor("validate") },
		};
	}

	if (parsed.values.source !== undefined) {
		overrides.source = {
			value: parsed.values.source,
			source: { kind: "comment-kv", key: keyFor("source") },
		};
	}

	return overrides;
}

function invalidOption(
	key: string,
	value: string,
	recordIndex: number,
	detail: string,
	warnings: ResolverWarning[],
): undefined {
	warnings.push({
		code: "cdb/invalid-option",
		message: `Comment option "${key}=${value}" is invalid (${detail}); it is ignored.`,
		context: { key, value, recordIndex },
	});
	return undefined;
}

function coerceVia(
	raw: string | undefined,
	recordIndex: number,
	warnings: ResolverWarning[],
): RouterOsProtocol | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (plannedProtocols.includes(raw as RouterOsProtocol)) {
		return raw as RouterOsProtocol;
	}
	return invalidOption(
		"via",
		raw,
		recordIndex,
		`unknown protocol; expected one of ${plannedProtocols.join(", ")}`,
		warnings,
	);
}

function coercePort(
	raw: string | undefined,
	recordIndex: number,
	warnings: ResolverWarning[],
): number | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (!/^\d+$/.test(raw.trim())) {
		return invalidOption(
			"port",
			raw,
			recordIndex,
			"expected an integer 1-65535",
			warnings,
		);
	}
	const parsed = Number.parseInt(raw.trim(), 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
		return invalidOption(
			"port",
			raw,
			recordIndex,
			"out of range 1-65535",
			warnings,
		);
	}
	return parsed;
}

function coerceTimeout(
	raw: string | undefined,
	recordIndex: number,
	warnings: ResolverWarning[],
): number | undefined {
	if (raw === undefined) {
		return undefined;
	}
	let parsed: number;
	try {
		parsed = parseDuration(raw);
	} catch {
		return invalidOption(
			"timeout",
			raw,
			recordIndex,
			"expected ms or a suffix like 5s / 500ms",
			warnings,
		);
	}
	if (parsed <= 0) {
		return invalidOption(
			"timeout",
			raw,
			recordIndex,
			"must be greater than zero",
			warnings,
		);
	}
	return parsed;
}

function coerceValidate(
	raw: string | undefined,
	recordIndex: number,
	warnings: ResolverWarning[],
): boolean | undefined {
	if (raw === undefined) {
		return undefined;
	}
	try {
		return parseBoolean(raw, "validate");
	} catch {
		return invalidOption(
			"validate",
			raw,
			recordIndex,
			"expected a boolean (true/false, yes/no, on/off, 1/0)",
			warnings,
		);
	}
}
