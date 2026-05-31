/**
 * Canonical result envelope.
 *
 * Every centrs API/CLI call returns this shape regardless of transport. The
 * load-bearing rules live in `docs/CONSTITUTION.md` (Result envelope); this
 * file is the typed contract those rules describe.
 *
 * Invariants (do not break without amending the constitution):
 * - `ok` discriminates success from failure. Success always carries `data`;
 *   failure always carries `error`. There is no "ok with error" or
 *   "not-ok with data" state.
 * - `warnings` is always present (`[]` when empty) so consumers never branch on
 *   its existence. `ok: true` may still carry warnings ("success with
 *   footnotes").
 * - `meta` is invariant across commands. Only `data` and `meta.operation` vary
 *   per command. Do not add command-specific keys beside `target`/`via`/
 *   `settings`/`validation`/`timing`/`truncated`; put them in `meta.operation`.
 * - CLI render must be lossless against the JSON envelope; `--format json|yaml`
 *   select serialization, not different shapes. Omit `undefined`; use `null`
 *   only where absence is meaningful and must round-trip (e.g. `via: null` when
 *   protocol resolution failed before a transport was chosen).
 */

import type { SerializedCentrsError } from "../errors.ts";
import type { RouterOsProtocol } from "../protocols/index.ts";

/**
 * Where a resolved setting/identity field came from. Precedence (low → high)
 * is config < comment-kv < env < cli; `cdb` and `arp` describe identity
 * resolution rather than settings precedence.
 */
export type SettingSourceKind =
	| "default"
	| "config"
	| "comment-kv"
	| "env"
	| "cli"
	| "cdb"
	| "arp";

export interface SettingSource {
	kind: SettingSourceKind;
	/** Human-facing detail: env var name, cli flag, cdb field, etc. */
	key?: string;
}

export interface Warning {
	/** Slash-namespaced, RouterOS-style. Example: `cdb/password-not-needed`. */
	code: string;
	message: string;
	context?: Record<string, unknown>;
}

/** Resolved target identity plus per-field provenance. */
export interface EnvelopeTargetMeta {
	/** Raw `<router>` argument as supplied by the caller. */
	input?: string;
	host?: string;
	port?: number;
	baseUrl?: string;
	mac?: string;
	name?: string;
	recordIndex?: number;
	/** Provenance of the target identity as a whole. */
	source?: SettingSource;
	/** Provenance per resolved field once the resolver is wired (WP-0c). */
	sources?: Record<string, SettingSource>;
}

export interface EnvelopeValidationMeta {
	enabled: boolean;
	/** Validator identity, e.g. `/console/inspect` or `:put [:parse]`. */
	source?: string;
	result?: "passed" | "failed" | "skipped";
	availableAttributes?: readonly string[];
}

export interface EnvelopeTimingMeta {
	startedAt?: string;
	durationMs?: number;
}

export interface EnvelopeTruncationMeta {
	truncated: boolean;
	reason?: string;
	limitBytes?: number;
	serializedBytes?: number;
}

/**
 * Provenance for the settings every command shares. The index signature allows
 * command-specific settings without losing discoverability of the common ones.
 */
export interface CommonSettingsMeta {
	via?: SettingSource;
	host?: SettingSource;
	port?: SettingSource;
	username?: SettingSource;
	password?: SettingSource;
	timeoutMs?: SettingSource;
	format?: SettingSource;
	validate?: SettingSource;
	maxResultsBytes?: SettingSource;
	[key: string]: SettingSource | undefined;
}

export interface EnvelopeMeta<Operation = unknown> {
	target: EnvelopeTargetMeta;
	/** Chosen protocol, or `null` when resolution failed before a transport. */
	via: RouterOsProtocol | null;
	settings: CommonSettingsMeta;
	validation?: EnvelopeValidationMeta;
	timing?: EnvelopeTimingMeta;
	truncated?: EnvelopeTruncationMeta;
	/** Command-specific metadata. The only meta field that varies by command. */
	operation?: Operation;
}

export type CentrsEnvelope<Data = unknown, Operation = unknown> =
	| {
			ok: true;
			data: Data;
			warnings: readonly Warning[];
			meta: EnvelopeMeta<Operation>;
	  }
	| {
			ok: false;
			error: SerializedCentrsError;
			warnings: readonly Warning[];
			meta: EnvelopeMeta<Operation>;
	  };

export type CentrsSuccessEnvelope<
	Data = unknown,
	Operation = unknown,
> = Extract<CentrsEnvelope<Data, Operation>, { ok: true }>;

export type CentrsErrorEnvelope<Operation = unknown> = Extract<
	CentrsEnvelope<unknown, Operation>,
	{ ok: false }
>;

/**
 * Multi-target (group / fanout) contract, locked here so WP-1b does not repaint
 * it. The outer envelope's `ok` means the fanout *orchestration* succeeded and
 * produced a complete per-target result set — it is `false` only when fanout
 * fails before reliable per-target results exist (bad group selector, CDB
 * decrypt failure, global validation failure). Per-target success/failure lives
 * in `data.targets[]`; failed targets are output, not metadata.
 */
export interface FanoutSummary {
	total: number;
	ok: number;
	failed: number;
}

export interface FanoutData<Data = unknown, Operation = unknown> {
	summary: FanoutSummary;
	targets: readonly CentrsEnvelope<Data, Operation>[];
}

/** Normalize an optional warnings list to a readonly array. */
export function normalizeWarnings(
	warnings: readonly Warning[] | undefined,
): readonly Warning[] {
	return warnings ?? [];
}
