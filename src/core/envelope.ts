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
 * resolution rather than settings precedence, and `provider` marks a field a
 * named-live-provider supplied (e.g. `--quickchr`), which bypasses the ladder
 * entirely (`docs/CONSTITUTION.md` → Resolution providers).
 */
export type SettingSourceKind =
	| "default"
	| "config"
	| "comment-kv"
	| "env"
	| "cli"
	| "cdb"
	| "arp"
	| "provider";

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

/**
 * Advice that is explicitly *not* an error or anomaly — a pointer the caller may
 * act on (no username set, no CDB found, consider a `__default__` record). Tips
 * ride their own envelope channel so "this is not a problem, just a suggestion"
 * never has to masquerade as a warning. See `docs/CONSTITUTION.md` (Result
 * envelope). Same shape as {@link Warning} plus an optional `fix`/`detailsUrl`.
 */
export interface Tip {
	/** Slash-namespaced `tip/*` code. Example: `tip/credentials-missing`. */
	code: string;
	message: string;
	/** One human sentence describing the suggested next step. */
	fix?: string;
	detailsUrl?: string;
}

/** Base URL for the human-readable tip pages (mirrors the error catalog scheme). */
export const TIPS_BASE_URL = "https://tikoci.github.io/centrs/tips/";

/** Build a {@link Tip} with a `tip/*` code and its generated `detailsUrl`. */
export function buildTip(code: string, message: string, fix: string): Tip {
	return { code, message, fix, detailsUrl: `${TIPS_BASE_URL}${code}` };
}

/** Resolved target identity plus per-field provenance. */
export interface EnvelopeTargetMeta {
	/** Raw `<router>` argument as supplied by the caller. */
	input?: string;
	/** CDB-facing target identity, when a command exposes registry metadata. */
	target?: string;
	/** Concrete resolved target, after CDB / match selection. */
	resolvedTarget?: string;
	host?: string;
	port?: number;
	baseUrl?: string;
	mac?: string;
	/**
	 * Human-facing device handle: the `identity=` comment lookup key (mirroring
	 * RouterOS `/system/identity`), falling back to the matched record's target.
	 * Deliberately may repeat across records; not a unique key.
	 */
	identity?: string;
	recordIndex?: number;
	/** Alias used by devices, where the CDB record index is user-facing. */
	cdbRecordIndex?: number;
	user?: string;
	group?: string;
	via?: RouterOsProtocol;
	validate?: boolean;
	/** Provenance marker parsed from comment kv-soup (for example `mndp`). */
	discoverySource?: string;
	/** Provenance of the target identity as a whole. */
	source?: SettingSource;
	/** Provenance per resolved field once the resolver is wired (WP-0c). */
	sources?: Record<string, SettingSource>;
}

/**
 * One stage of the two-stage validation gate (GH#354).
 *
 * `offline` is the corpus-gated analyzer (`src/offline-gate.ts`): it opens no
 * connection, so a `failed` offline stage means the device was never contacted.
 * `device` is the RouterOS-side preflight — `:put [:parse …]` and/or
 * `/console/inspect request=child`, depending on the command and transport.
 *
 * Stages appear in the order they run, and a stage that did not run is still
 * listed with `result: "skipped"`. That is the point of the array: a reader must
 * be able to tell "the device accepted it" from "the device was never asked".
 */
export interface EnvelopeValidationStage {
	stage: "offline" | "device";
	/** Validator identity, e.g. `offline explain (canonicalizer)` or `:put [:parse]`. */
	source: string;
	result: "passed" | "failed" | "skipped";
	/** Why a stage was skipped, when the reason is not simply `validate=false`. */
	reason?: string;
}

/**
 * Mutable sink that lets an error path report the validation that ACTUALLY ran.
 *
 * `runResolvedExecute` / `runResolvedApi` finish the gate and then do the real
 * work, and the error envelope is built by a *different* function after the
 * throw unwinds past them. Without this, a `routeros/*` fault on the run — which
 * happens with both gate stages already green — got a reconstructed
 * `result: "failed"` that erased the real outcome. The runner writes
 * {@link ValidationTrace.validation} the moment the gate returns; the error
 * builder prefers it over anything it could guess (GH#354, PR #356 review).
 */
export interface ValidationTrace {
	/** The completed gate result, set once validation finishes. */
	validation?: EnvelopeValidationMeta;
	/**
	 * The stage-1 verdict, recorded as soon as stage 1 returns — before stage 2
	 * can throw. `warn` is an abstention, and an error envelope that reported it
	 * as `passed` would be telling a consumer the analyzer read bytes it declined
	 * to judge.
	 */
	offlineVerdict?: "pass" | "warn";
}

export interface EnvelopeValidationMeta {
	enabled: boolean;
	/** Validator identity, e.g. `/console/inspect` or `:put [:parse]`. */
	source?: string;
	result?: "passed" | "failed" | "skipped";
	/** Syntax gate status for commands that use RouterOS `:parse`. */
	syntax?: boolean;
	/** Semantic `/console/inspect` gate status, or not-applicable for script mode. */
	semantic?: boolean | "not-applicable";
	availableAttributes?: readonly string[];
	/**
	 * Per-stage detail for the gate described in
	 * `docs/CONSTITUTION.md` → "Validation is the product".
	 *
	 * The flat `source` / `syntax` / `semantic` fields above stay the summary
	 * view and keep their meaning; this is the breakdown behind them. Absent on
	 * surfaces that have no RouterOS-command gate at all (`btest`).
	 */
	stages?: readonly EnvelopeValidationStage[];
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
			tips: readonly Tip[];
			meta: EnvelopeMeta<Operation>;
	  }
	| {
			ok: false;
			error: SerializedCentrsError;
			warnings: readonly Warning[];
			tips: readonly Tip[];
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

/** Normalize an optional tips list to a readonly array. */
export function normalizeTips(
	tips: readonly Tip[] | undefined,
): readonly Tip[] {
	return tips ?? [];
}
