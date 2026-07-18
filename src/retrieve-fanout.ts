/**
 * Multi-target fan-out for `retrieve`.
 *
 * A target selection (`--group` / `--where` / `--all` / `--default` / multiple
 * positionals) expands to N members and runs each through the single-target
 * retrieve tail (`buildResolvedRetrieve` → `runResolvedRetrieve`), collecting a
 * per-target inner `CentrsEnvelope` into the LOCKED `FanoutData` shape from
 * `src/core/envelope.ts`. The outer envelope's `ok` means the orchestration
 * produced a complete per-target result set; a per-target failure is an INNER
 * `ok: false` envelope, never an outer failure and never a thrown error out of
 * the batch.
 *
 * Boundaries (see `commands/retrieve/README.md`, `docs/CONSTITUTION.md`), shared
 * with `api-fanout.ts`:
 *   - The CDB is loaded + decrypted ONCE (`expandSelection`); a cdb member is
 *     resolved with its pre-resolved record, so `resolveCdb`'s `__default__`
 *     synthetic fallback never collides ad-hoc literals.
 *   - A `--default` / `__default__` member is guarded from being dialed as the
 *     literal hostname `"__default__"` — it fails that one target deterministically
 *     with `target/unresolved`.
 *   - Each target is resolved + validated independently (validation is per-target
 *     via live `/console/inspect`; schemas differ by version).
 *   - Concurrency is a bounded worker pool; defaults are transport-aware
 *     (REST 8, native-api 4) and overridable with `--concurrency`.
 *   - `data.targets[]` is ordered by CDB `recordIndex` (literals appended in
 *     positional order); `summary` counts are derived from inner `ok`.
 *
 * Outer `ok: false` is reserved for fan-out failing BEFORE reliable per-target
 * results exist (bad request shape, CDB decrypt failure); those throw out of
 * {@link retrieveFanout} and the CLI renders them with
 * {@link buildRetrieveFanoutErrorEnvelope}.
 */

import type {
	CentrsErrorEnvelope,
	CentrsSuccessEnvelope,
	FanoutData,
	FanoutSummary,
} from "./core/envelope.ts";
import {
	buildFanoutEnvelope,
	buildFanoutResolveFailure,
	commonVia,
	defaultFanoutSleep,
	resolveFanoutConcurrency,
	runFanout,
	summarizeFanout,
} from "./core/fanout.ts";
import { CentrsError, serializeCentrsError } from "./errors.ts";
import { plannedProtocols, type RouterOsProtocol } from "./protocols/index.ts";
import {
	expandSelection,
	isDefaultRecordTarget,
	loadEnvFileDefaults,
	type SelectionExpansion,
	type SelectionMember,
	type SelectionResolveInput,
	type TargetSelection,
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
	resolveRetrieveRequest,
	runResolvedRetrieve,
	toYaml,
	validateRetrieveRequestShape,
} from "./retrieve.ts";

/** Compact description of the selector that produced the fan-out. */
export interface RetrieveSelectionSummary {
	groups: readonly string[];
	where: readonly string[];
	all: boolean;
	default: boolean;
	positionals: readonly string[];
	/** quickchr machine names (`--quickchr`, repeatable; exclusive of the rest). */
	quickchr?: readonly string[];
}

export interface RetrieveFanoutOperationMeta {
	kind: "fanout";
	concurrency: number;
	summary: FanoutSummary;
	request: RetrieveRequestSummary;
	selection: RetrieveSelectionSummary;
}

export type RetrieveFanoutData = FanoutData<unknown, RetrieveOperationMeta>;
export type RetrieveFanoutEnvelope = CentrsSuccessEnvelope<
	RetrieveFanoutData,
	RetrieveFanoutOperationMeta
>;
export type RetrieveFanoutErrorEnvelope =
	CentrsErrorEnvelope<RetrieveFanoutOperationMeta>;

/** Test/override seams; production callers pass nothing. */
export interface RetrieveFanoutInternals {
	/** Per-target executor (attempts; throws on failure). Defaults to the live tail. */
	execute?: (
		resolved: ResolvedRetrieveRequest,
	) => Promise<RetrieveSuccessEnvelope>;
	/** Selection expansion. Defaults to the real CDB-backed expansion. */
	expand?: (
		selection: TargetSelection,
		input: SelectionResolveInput,
		env: Record<string, string | undefined>,
		config?: Record<string, string | undefined>,
	) => Promise<SelectionExpansion>;
	/** Backoff sleeper. Defaults to a real timer; tests pass a no-op. */
	sleep?: (ms: number) => Promise<void>;
}

export interface RetrieveFanoutOptions {
	concurrency?: number;
	/** CLI: true (literal positionals allowed). MCP: false (CDB is the allowlist). */
	allowAdhoc?: boolean;
}

function summarizeSelection(
	selection: TargetSelection,
): RetrieveSelectionSummary {
	return {
		groups: selection.groups,
		where: selection.where.map((clause) => `${clause.key}=${clause.value}`),
		all: selection.all,
		default: selection.default,
		positionals: selection.positionals,
		quickchr: selection.quickchr,
	};
}

function memberTargetMeta(member: SelectionMember): {
	input?: string;
	identity?: string;
	recordIndex?: number;
} {
	if (member.kind === "cdb") {
		return {
			input: member.resolution.identity,
			identity: member.resolution.identity,
			recordIndex: member.recordIndex,
		};
	}
	if (member.kind === "quickchr") {
		return { input: member.name, identity: member.name };
	}
	return { input: member.input };
}

/**
 * Ad-hoc literal targets have no CDB record. `resolveRetrieveRequest` may borrow
 * the `__default__` record's index when filling fallback creds, so the inner
 * envelope would carry that borrowed `recordIndex` — making distinct literals
 * collide on one index. Drop it for literal members and stamp the caller's `input`
 * so the target stays identifiable in renderers (mirrors `api-fanout.ts`).
 */
function relabelAdhocMember(
	envelope: RetrieveEnvelope,
	member: SelectionMember,
): RetrieveEnvelope {
	if (member.kind !== "literal") {
		return envelope;
	}
	const { recordIndex: _borrowed, ...target } = envelope.meta.target;
	return {
		...envelope,
		meta: { ...envelope.meta, target: { ...target, input: member.input } },
	};
}

/**
 * Run a `retrieve` fan-out. Always returns a success envelope when the
 * orchestration completes (even if every target failed); throws only for
 * pre-flight failures (bad request shape, CDB decrypt) the caller renders as an
 * outer error.
 */
export async function retrieveFanout(
	request: RetrieveRequest,
	selection: TargetSelection,
	env: Record<string, string | undefined> = Bun.env,
	internals: RetrieveFanoutInternals = {},
	options: RetrieveFanoutOptions = {},
): Promise<RetrieveFanoutEnvelope> {
	const attributeSelections = validateRetrieveRequestShape(request);
	const config = await loadEnvFileDefaults(env);
	const global = resolveRetrieveGlobalContext(
		request,
		env,
		attributeSelections,
		config,
	);
	const selectionSummary = summarizeSelection(selection);

	const expand = internals.expand ?? expandSelection;
	const expansion = await expand(
		selection,
		{
			cdbFile: request.cdbFile,
			cdbPassword: request.cdbPassword,
			allowAdhoc: options.allowAdhoc ?? true,
		},
		env,
		config,
	);

	const concurrencyVia = resolveFanoutConcurrencyProtocol(
		request,
		env,
		global.via,
		expansion,
	);
	const concurrency = resolveFanoutConcurrency(
		options.concurrency ?? request.concurrency,
		concurrencyVia,
	);

	if (expansion.empty) {
		return retrieveFanoutEnvelope({
			selection: selectionSummary,
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
	const sleep = internals.sleep ?? defaultFanoutSleep;

	const targets = await runFanout<
		SelectionMember,
		ResolvedRetrieveRequest,
		RetrieveEnvelope
	>({
		members: expansion.targets,
		concurrency,
		resolve: async (member) => {
			if (member.kind === "cdb") {
				if (isDefaultRecordTarget(member.resolution.target)) {
					throw new CentrsError({
						code: "target/unresolved",
						summary:
							"The `__default__` record is a credential fallback, not a connectable router.",
						remediation:
							"Select real devices with `--group` / `--where` / `--all` or a positional; `--default` cannot be a RouterOS target.",
						context: { target: member.resolution.target },
					});
				}
				const macResolution = await resolveMacForRetrieve(
					request,
					env,
					member.resolution,
					config,
				);
				return buildResolvedRetrieve(
					request,
					env,
					member.resolution,
					attributeSelections,
					macResolution,
					config,
				);
			}
			if (member.kind === "quickchr") {
				// The live descriptor resolves here, per member — a stopped/unknown
				// machine is an inner per-target failure, not an expansion error.
				return resolveRetrieveRequest(
					{ ...request, targetInput: undefined, quickchr: member.name },
					env,
				);
			}
			// Ad-hoc literal: full single-target resolution (CDB load → `__default__`
			// fallback creds), mirroring single-target `retrieve`.
			return resolveRetrieveRequest(
				{ ...request, targetInput: member.input },
				env,
			);
		},
		onResolveError: (member, error) =>
			buildFanoutResolveFailure<RetrieveOperationMeta>({
				error,
				target: memberTargetMeta(member),
				warnings: member.kind === "cdb" ? [...member.resolution.warnings] : [],
				summary: "Failed to resolve a fanout target.",
			}),
		execute: async (resolved, member) =>
			relabelAdhocMember(await execute(resolved), member),
		onExecuteError: (resolved, member, error) =>
			relabelAdhocMember(
				buildRetrieveErrorEnvelopeFromResolved(resolved, error),
				member,
			),
		sleep,
	});

	return retrieveFanoutEnvelope({
		selection: selectionSummary,
		concurrency,
		summary: summarizeFanout(targets),
		requestSummary: global.summary,
		settings: global.settings,
		via: commonVia(targets),
		warnings: expansion.warnings,
		targets,
	});
}

/**
 * Back-compat shim for the `--group`-only fan-out: builds a single-group
 * {@link TargetSelection} and delegates to {@link retrieveFanout}. Kept for the
 * MCP `centrs_retrieve` tool, whose surface exposes only `group`.
 */
export async function retrieveGroup(
	request: RetrieveRequest,
	env: Record<string, string | undefined> = Bun.env,
	internals: RetrieveFanoutInternals = {},
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
	const selection: TargetSelection = {
		positionals: [],
		groups: [group],
		all: false,
		default: false,
		where: [],
	};
	return retrieveFanout(request, selection, env, internals, {
		concurrency: request.concurrency,
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
					summary: "retrieve fan-out failed with an unexpected error.",
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
		tips: [],
		meta: {
			target: {},
			via: requestedVia,
			settings: {},
		},
	};
}

function resolveFanoutConcurrencyProtocol(
	request: RetrieveRequest,
	env: Record<string, string | undefined>,
	globalVia: RouterOsProtocol,
	expansion: SelectionExpansion,
): RouterOsProtocol {
	// Deliberately CLI/env only, not `config` — a `centrs.env` default is the
	// weakest precedence tier and must not be treated as a hard pin the way an
	// explicit `--via`/`CENTRS_VIA` is; doing so would defeat per-target CDB
	// `via=` overrides for members that disagree with the global default.
	if (request.via !== undefined || env["CENTRS_VIA"] !== undefined) {
		return globalVia;
	}
	if (
		expansion.targets.some(
			(member) =>
				member.kind === "cdb" &&
				member.resolution.overrides.via?.value === "native-api",
		)
	) {
		return "native-api";
	}
	return globalVia;
}

interface FanoutEnvelopeInput {
	selection: RetrieveSelectionSummary;
	concurrency: number;
	summary: FanoutSummary;
	requestSummary: RetrieveRequestSummary;
	settings: RetrieveFanoutEnvelope["meta"]["settings"];
	via: RouterOsProtocol | null;
	warnings: RetrieveFanoutEnvelope["warnings"];
	targets: readonly RetrieveEnvelope[];
}

/** retrieve's outer fan-out success envelope (delegates to the shared core). */
function retrieveFanoutEnvelope(
	input: FanoutEnvelopeInput,
): RetrieveFanoutEnvelope {
	return buildFanoutEnvelope<
		unknown,
		RetrieveOperationMeta,
		RetrieveFanoutOperationMeta
	>({
		summary: input.summary,
		targets: input.targets,
		warnings: input.warnings,
		settings: input.settings,
		via: input.via,
		operation: {
			kind: "fanout",
			concurrency: input.concurrency,
			summary: input.summary,
			request: input.requestSummary,
			selection: input.selection,
		},
	});
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
		`retrieve ${operation?.request.path ?? "?"}: ${ok}/${total} ok, ${failed} failed (concurrency ${operation?.concurrency ?? "?"})`,
	];

	for (const target of envelope.data.targets) {
		const meta = target.meta;
		const label =
			meta.target.identity ??
			meta.target.host ??
			meta.target.input ??
			"(unknown)";
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
