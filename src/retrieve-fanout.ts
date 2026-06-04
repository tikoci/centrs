/**
 * Group fanout for `retrieve`.
 *
 * A `--group <name>` selector expands a CDB group into N targets and runs each
 * through the single-target retrieve tail (`runResolvedRetrieve`), collecting a
 * per-target inner `CentrsEnvelope` into the LOCKED `FanoutData` shape from
 * `src/core/envelope.ts`. The outer envelope's `ok` means the orchestration
 * produced a complete per-target result set; a per-target failure is an INNER
 * `ok: false` envelope, never an outer failure and never a thrown error out of
 * the batch.
 *
 * Design rules implemented here (see `commands/retrieve/README.md`):
 *   - The CDB is loaded + decrypted ONCE for the whole fanout (group expansion).
 *   - Each target is resolved + validated independently (validation is
 *     per-target via live `/console/inspect`; schemas differ by version).
 *   - Concurrency is a bounded worker pool; defaults are transport-aware
 *     (REST 8, native-api 4) and overridable with `--concurrency`.
 *   - Transient drops are retried with jittered backoff on an allowlisted
 *     retryable-code set only; router-side and client-side errors are not.
 *   - `data.targets[]` is ordered by CDB `recordIndex` regardless of completion
 *     order; `summary` counts are derived from inner `ok`.
 *
 * Outer `ok: false` is reserved for fanout failing BEFORE reliable per-target
 * results exist (bad request shape, CDB decrypt failure); those throw out of
 * {@link retrieveGroup} and the CLI renders them with
 * {@link buildRetrieveFanoutErrorEnvelope}.
 */

import type {
	CentrsErrorEnvelope,
	CentrsSuccessEnvelope,
	FanoutData,
	FanoutSummary,
} from "./core/envelope.ts";
import { CentrsError, serializeCentrsError } from "./errors.ts";
import { plannedProtocols, type RouterOsProtocol } from "./protocols/index.ts";
import {
	type CdbGroupExpansion,
	type CdbGroupResolveInput,
	type CdbResolution,
	expandCdbGroup,
} from "./resolver/index.ts";
import {
	buildResolvedRetrieve,
	buildRetrieveErrorEnvelopeFromResolved,
	type ResolvedRetrieveRequest,
	type RetrieveEnvelope,
	type RetrieveOperationMeta,
	type RetrieveOutputFormat,
	type RetrieveRequest,
	type RetrieveRequestSummary,
	type RetrieveSuccessEnvelope,
	resolveMacForRetrieve,
	resolveRetrieveGlobalContext,
	runResolvedRetrieve,
	toYaml,
	validateRetrieveRequestShape,
} from "./retrieve.ts";

/** Transport-aware default worker-pool size (REST drops parallel POSTs above ~8). */
export const RETRIEVE_FANOUT_CONCURRENCY_DEFAULTS: Record<
	"rest-api" | "native-api",
	number
> = {
	"rest-api": 8,
	"native-api": 4,
};

/** Extra attempts after the first try (jittered backoff between them). */
export const RETRIEVE_FANOUT_MAX_RETRIES = 2;

/** Base backoff in milliseconds; doubled per attempt with up to +base jitter. */
export const RETRIEVE_FANOUT_BACKOFF_BASE_MS = 200;

/** RouterOS-style codes that are safe to retry under fanout. */
export const RETRIEVE_FANOUT_RETRYABLE_CODES = [
	"transport/network",
	"transport/connection-closed",
] as const;

export interface RetrieveFanoutOperationMeta {
	kind: "fanout";
	group: string;
	concurrency: number;
	summary: FanoutSummary;
	request: RetrieveRequestSummary;
}

export type RetrieveFanoutData = FanoutData<unknown, RetrieveOperationMeta>;
export type RetrieveFanoutEnvelope = CentrsSuccessEnvelope<
	RetrieveFanoutData,
	RetrieveFanoutOperationMeta
>;
export type RetrieveFanoutErrorEnvelope =
	CentrsErrorEnvelope<RetrieveFanoutOperationMeta>;

/** Test/override seams; production callers pass nothing. */
export interface RetrieveGroupInternals {
	/** Per-target executor (attempts; throws on failure). Defaults to the live tail. */
	execute?: (
		resolved: ResolvedRetrieveRequest,
		recordIndex: number,
	) => Promise<RetrieveSuccessEnvelope>;
	/** Group expansion. Defaults to the real CDB-backed expansion. */
	expand?: (
		input: CdbGroupResolveInput,
		env: Record<string, string | undefined>,
	) => Promise<CdbGroupExpansion>;
	/** Backoff sleeper. Defaults to a real timer; tests pass a no-op. */
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Run a `retrieve` group fanout. Always returns a success envelope when the
 * orchestration completes (even if every target failed); throws only for
 * pre-flight failures (bad request shape, CDB decrypt) the caller renders as an
 * outer error.
 */
export async function retrieveGroup(
	request: RetrieveRequest,
	env: Record<string, string | undefined> = Bun.env,
	internals: RetrieveGroupInternals = {},
): Promise<RetrieveFanoutEnvelope> {
	const group = request.group;
	if (group === undefined || group.length === 0) {
		throw new CentrsError({
			code: "usage/missing-group",
			summary: "retrieve group fanout requires a non-empty `--group` value.",
			remediation:
				"Pass `--group <name>` matching a CDB group, e.g. `centrs retrieve --group prod /system/resource`.",
		});
	}

	const attributeSelections = validateRetrieveRequestShape(request);
	const global = resolveRetrieveGlobalContext(
		request,
		env,
		attributeSelections,
	);
	if (request.concurrency !== undefined) {
		resolveFanoutConcurrency(request.concurrency, global.via);
	}

	const expand = internals.expand ?? expandCdbGroup;
	const expansion = await expand(
		{
			group,
			cdbFile: request.cdbFile,
			cdbPassword: request.cdbPassword,
		},
		env,
	);

	const concurrencyVia = resolveFanoutConcurrencyProtocol(
		request,
		env,
		global.via,
		expansion,
	);
	const concurrency = resolveFanoutConcurrency(
		request.concurrency,
		concurrencyVia,
	);

	if (expansion.empty) {
		return buildFanoutEnvelope({
			group,
			concurrency,
			summary: { total: 0, ok: 0, failed: 0 },
			requestSummary: global.summary,
			settings: global.settings,
			via: global.via,
			warnings: expansion.warnings,
			targets: [],
		});
	}

	const execute = internals.execute ?? runResolvedRetrieve;
	const sleep = internals.sleep ?? defaultSleep;

	const targets = await runBoundedPool(
		expansion.targets,
		concurrency,
		async (member): Promise<RetrieveEnvelope> => {
			let resolved: ResolvedRetrieveRequest;
			try {
				const macResolution = await resolveMacForRetrieve(
					request,
					env,
					member.resolution,
				);
				resolved = buildResolvedRetrieve(
					request,
					env,
					member.resolution,
					attributeSelections,
					macResolution,
				);
			} catch (error) {
				return buildResolveFailureEnvelope(member.resolution, error);
			}
			return runTargetWithRetry(resolved, member.recordIndex, execute, sleep);
		},
	);

	const summary = summarizeFanout(targets);
	return buildFanoutEnvelope({
		group,
		concurrency,
		summary,
		requestSummary: global.summary,
		settings: global.settings,
		via: commonVia(targets),
		warnings: expansion.warnings,
		targets,
	});
}

/** Outer error envelope for a fanout that failed before per-target results. */
export function buildRetrieveFanoutErrorEnvelope(
	request: RetrieveRequest,
	error: unknown,
): RetrieveFanoutErrorEnvelope {
	const centrsError =
		error instanceof CentrsError
			? error
			: new CentrsError({
					code: "internal/unhandled",
					summary: "retrieve group fanout failed with an unexpected error.",
					remediation:
						"Re-run with `--format json` to capture the structured error details for debugging.",
					cause: error,
				});

	const requestedVia = plannedProtocols.includes(
		request.via as RouterOsProtocol,
	)
		? (request.via as RouterOsProtocol)
		: null;

	return {
		ok: false,
		error: serializeCentrsError(centrsError),
		warnings: [],
		meta: {
			target: {},
			via: requestedVia,
			settings: {},
		},
	};
}

/** Resolve and validate the worker-pool size. */
export function resolveFanoutConcurrency(
	requested: number | undefined,
	via: RouterOsProtocol,
): number {
	if (requested !== undefined) {
		if (!Number.isInteger(requested) || requested < 1) {
			throw new CentrsError({
				code: "usage/invalid-concurrency",
				summary: `--concurrency must be an integer >= 1. Received: ${requested}`,
				remediation: "Pass a positive integer, e.g. `--concurrency 4`.",
				context: { concurrency: requested },
			});
		}
		return requested;
	}
	if (via === "native-api") {
		return RETRIEVE_FANOUT_CONCURRENCY_DEFAULTS["native-api"];
	}
	return RETRIEVE_FANOUT_CONCURRENCY_DEFAULTS["rest-api"];
}

function resolveFanoutConcurrencyProtocol(
	request: RetrieveRequest,
	env: Record<string, string | undefined>,
	globalVia: RouterOsProtocol,
	expansion: CdbGroupExpansion,
): RouterOsProtocol {
	if (request.via !== undefined || env["CENTRS_VIA"] !== undefined) {
		return globalVia;
	}
	if (
		expansion.targets.some(
			(target) => target.resolution.overrides.via?.value === "native-api",
		)
	) {
		return "native-api";
	}
	return globalVia;
}

/**
 * Classify a per-target failure as retryable. Only the locked allowlist
 * retries: generic transport/network failures and dropped/closed connections
 * (including REST 5xx mapped to `transport/connection-closed`). Router-side
 * (`routeros/*`), validation, auth, cdb, target, input, usage, timeout, TLS,
 * connection-refused, and DNS failures are deterministic and never retried.
 */
export function isRetryableFanoutError(error: unknown): boolean {
	if (!(error instanceof CentrsError)) {
		return false;
	}
	return (RETRIEVE_FANOUT_RETRYABLE_CODES as readonly string[]).includes(
		error.code,
	);
}

export function summarizeFanout(
	targets: readonly RetrieveEnvelope[],
): FanoutSummary {
	let ok = 0;
	let failed = 0;
	for (const target of targets) {
		if (target.ok) {
			ok += 1;
		} else {
			failed += 1;
		}
	}
	return { total: targets.length, ok, failed };
}

async function runTargetWithRetry(
	resolved: ResolvedRetrieveRequest,
	recordIndex: number,
	execute: (
		resolved: ResolvedRetrieveRequest,
		recordIndex: number,
	) => Promise<RetrieveSuccessEnvelope>,
	sleep: (ms: number) => Promise<void>,
): Promise<RetrieveEnvelope> {
	let attempt = 0;
	for (;;) {
		try {
			return await execute(resolved, recordIndex);
		} catch (error) {
			if (
				attempt < RETRIEVE_FANOUT_MAX_RETRIES &&
				isRetryableFanoutError(error)
			) {
				attempt += 1;
				await sleep(backoffMs(attempt));
				continue;
			}
			return buildRetrieveErrorEnvelopeFromResolved(resolved, error);
		}
	}
}

/**
 * Ordered bounded worker pool. Runs `worker` over `items` with at most
 * `concurrency` in flight, returning results in INPUT order regardless of
 * completion order.
 */
export async function runBoundedPool<I, O>(
	items: readonly I[],
	concurrency: number,
	worker: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
	const results = new Array<O>(items.length);
	let next = 0;
	const width = Math.max(1, Math.min(concurrency, items.length));

	async function drain(): Promise<void> {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) {
				return;
			}
			results[index] = await worker(items[index] as I, index);
		}
	}

	await Promise.all(Array.from({ length: width }, () => drain()));
	return results;
}

function buildResolveFailureEnvelope(
	resolution: CdbResolution,
	error: unknown,
): RetrieveEnvelope {
	const centrsError =
		error instanceof CentrsError
			? error
			: new CentrsError({
					code: "internal/unhandled",
					summary: "Failed to resolve a fanout target.",
					cause: error,
				});
	return {
		ok: false,
		error: serializeCentrsError(centrsError),
		warnings: [...resolution.warnings],
		meta: {
			target: {
				input: resolution.identity,
				identity: resolution.identity,
				recordIndex: resolution.recordIndex,
			},
			via: null,
			settings: {},
		},
	};
}

interface FanoutEnvelopeInput {
	group: string;
	concurrency: number;
	summary: FanoutSummary;
	requestSummary: RetrieveRequestSummary;
	settings: RetrieveFanoutEnvelope["meta"]["settings"];
	via: RouterOsProtocol | null;
	warnings: RetrieveFanoutEnvelope["warnings"];
	targets: readonly RetrieveEnvelope[];
}

function buildFanoutEnvelope(
	input: FanoutEnvelopeInput,
): RetrieveFanoutEnvelope {
	return {
		ok: true,
		data: {
			summary: input.summary,
			targets: input.targets,
		},
		warnings: input.warnings,
		meta: {
			target: {},
			via: input.via,
			settings: input.settings,
			operation: {
				kind: "fanout",
				group: input.group,
				concurrency: input.concurrency,
				summary: input.summary,
				request: input.requestSummary,
			},
		},
	};
}

function commonVia(
	targets: readonly RetrieveEnvelope[],
): RouterOsProtocol | null {
	let via: RouterOsProtocol | null | undefined;
	for (const target of targets) {
		const candidate = target.meta.via;
		if (via === undefined) {
			via = candidate;
		} else if (via !== candidate) {
			return null;
		}
	}
	return via ?? null;
}

function backoffMs(attempt: number): number {
	const base = RETRIEVE_FANOUT_BACKOFF_BASE_MS * 2 ** (attempt - 1);
	return base + Math.floor(Math.random() * RETRIEVE_FANOUT_BACKOFF_BASE_MS);
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Render a fanout envelope. `json`/`yaml` serialize the whole envelope (lossless
 * against the JSON shape); `text` renders a fanout summary line plus one line
 * per target ordered by record index.
 */
export function renderRetrieveFanoutEnvelope(
	envelope: RetrieveFanoutEnvelope | RetrieveFanoutErrorEnvelope,
	format: RetrieveOutputFormat,
	options: { verbose?: boolean } = {},
): string {
	switch (format) {
		case "json":
			return JSON.stringify(envelope, null, 2);
		case "yaml":
			return toYaml(envelope);
		default:
			return renderFanoutText(envelope, options);
	}
}

function renderFanoutText(
	envelope: RetrieveFanoutEnvelope | RetrieveFanoutErrorEnvelope,
	options: { verbose?: boolean },
): string {
	if (!envelope.ok) {
		const lines = [`[${envelope.error.code}] ${envelope.error.summary}`];
		if (envelope.error.remediation) {
			lines.push(`Fix: ${envelope.error.remediation}`);
		}
		return lines.join("\n");
	}

	const operation = envelope.meta.operation;
	const { total, ok, failed } = envelope.data.summary;
	const lines: string[] = [
		`group ${operation?.group ?? "?"}: ${ok}/${total} ok, ${failed} failed (concurrency ${operation?.concurrency ?? "?"})`,
	];

	for (const target of envelope.data.targets) {
		const meta = target.meta;
		const label = meta.target.identity ?? meta.target.host ?? "(unknown)";
		const index = meta.target.recordIndex ?? "-";
		if (target.ok) {
			lines.push(
				`  [${index}] ok    ${label} (${target.meta.operation?.objectCount ?? 0} object(s))`,
			);
		} else {
			lines.push(
				`  [${index}] FAIL  ${label} [${target.error.code}] ${target.error.summary}`,
			);
		}
		if (options.verbose && !target.ok && target.error.remediation) {
			lines.push(`        Fix: ${target.error.remediation}`);
		}
	}

	for (const warning of envelope.warnings) {
		lines.push(`warning [${warning.code}]: ${warning.message}`);
	}

	return lines.join("\n");
}
