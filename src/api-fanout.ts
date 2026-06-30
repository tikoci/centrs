/**
 * Multi-target fan-out for `api`.
 *
 * A target selection (`--group` / `--where` / `--all` / `--default` / multiple
 * positionals) expands to N members and runs each through the single-target api
 * tail (`resolveApiRequest` → `runResolvedApi`), collecting per-target inner
 * `ApiEnvelope`s into the locked `FanoutData` shape (`src/core/envelope.ts`).
 *
 * Boundaries (see `commands/api/README.md`, `docs/CONSTITUTION.md`):
 *   - The CDB is loaded ONCE (`expandCdbSelection`); a cdb member is resolved
 *     with its pre-resolved record, so `resolveCdb`'s `__default__` synthetic
 *     fallback never collides ad-hoc literals.
 *   - A `--default` / `__default__` member is guarded from being dialed as the
 *     literal hostname `"__default__"` — it fails that one target deterministically
 *     with `target/unresolved`.
 *   - A mutating fan-out is confirmed ONCE up front (`--yes`), never per target;
 *     without `--yes` the error names the blast radius (how many routers).
 *   - `--listen`/`--stream` and `--raw` are rejected in fan-out mode by the CLI
 *     before reaching here (single-session / envelope-stripping).
 */

import {
	type ApiEnvelope,
	type ApiOperationMeta,
	type ApiRequest,
	type ApiRequestSummary,
	type ApiSuccessEnvelope,
	apiRequestSummaryFromRequest,
	buildApiErrorEnvelopeFromResolved,
	parseApiMethod,
	type ResolvedApiRequest,
	resolveApiRequest,
	runResolvedApi,
	validateApiRequestShape,
} from "./api.ts";
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
import { promptForWriteConfirmation } from "./execute.ts";
import { plannedProtocols, type RouterOsProtocol } from "./protocols/index.ts";
import {
	type CdbSelectionExpansion,
	type CdbSelectionMember,
	type CdbSelectionResolveInput,
	expandCdbSelection,
	isDefaultRecordTarget,
	type TargetSelection,
} from "./resolver/index.ts";
import { toYaml } from "./retrieve.ts";

/** Compact description of the selector that produced the fan-out. */
export interface ApiSelectionSummary {
	groups: readonly string[];
	where: readonly string[];
	all: boolean;
	default: boolean;
	positionals: readonly string[];
}

export interface ApiFanoutOperationMeta {
	kind: "fanout";
	concurrency: number;
	summary: FanoutSummary;
	request: ApiRequestSummary;
	selection: ApiSelectionSummary;
}

export type ApiFanoutData = FanoutData<unknown, ApiOperationMeta>;
export type ApiFanoutEnvelope = CentrsSuccessEnvelope<
	ApiFanoutData,
	ApiFanoutOperationMeta
>;
export type ApiFanoutErrorEnvelope =
	CentrsErrorEnvelope<ApiFanoutOperationMeta>;

/** Test/override seams; production callers pass nothing. */
export interface ApiFanoutInternals {
	expand?: (
		selection: TargetSelection,
		input: CdbSelectionResolveInput,
		env: Record<string, string | undefined>,
	) => Promise<CdbSelectionExpansion>;
	execute?: (resolved: ResolvedApiRequest) => Promise<ApiSuccessEnvelope>;
	sleep?: (ms: number) => Promise<void>;
}

export interface ApiFanoutOptions {
	concurrency?: number;
	/** CLI: true (literal positionals allowed). MCP: false (CDB is the allowlist). */
	allowAdhoc?: boolean;
}

function summarizeSelection(selection: TargetSelection): ApiSelectionSummary {
	return {
		groups: selection.groups,
		where: selection.where.map((clause) => `${clause.key}=${clause.value}`),
		all: selection.all,
		default: selection.default,
		positionals: selection.positionals,
	};
}

/** Representative transport for the concurrency default (pinned > native member > rest). */
function fanoutVia(
	request: ApiRequest,
	env: Record<string, string | undefined>,
	expansion: CdbSelectionExpansion,
): RouterOsProtocol {
	const pinned = request.via ?? env["CENTRS_VIA"];
	if (
		pinned !== undefined &&
		plannedProtocols.includes(pinned as RouterOsProtocol)
	) {
		return pinned as RouterOsProtocol;
	}
	const anyNative = expansion.targets.some(
		(member) =>
			member.kind === "cdb" &&
			member.resolution.overrides.via?.value === "native-api",
	);
	return anyNative ? "native-api" : "rest-api";
}

function memberTargetMeta(member: CdbSelectionMember): {
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
	return { input: member.input };
}

/**
 * Run an `api` fan-out. Returns a success envelope when the orchestration
 * completes (even if every target failed); throws only for pre-flight failures
 * (invalid method, CDB decrypt, unconfirmed write) the caller renders as an
 * outer error via {@link buildApiFanoutErrorEnvelope}.
 */
export async function apiFanout(
	request: ApiRequest,
	selection: TargetSelection,
	env: Record<string, string | undefined> = Bun.env,
	internals: ApiFanoutInternals = {},
	options: ApiFanoutOptions = {},
): Promise<ApiFanoutEnvelope> {
	// Validate the request shape + method ONCE, before selection expansion: a
	// missing endpoint or an invalid `-X` is an outer error regardless of how many
	// targets the selection resolves to (so an empty selection cannot mask it).
	validateApiRequestShape(request);
	const method = parseApiMethod(request.method);
	const requestSummary = apiRequestSummaryFromRequest(request, env);
	const selectionSummary = summarizeSelection(selection);

	const expand = internals.expand ?? expandCdbSelection;
	const expansion = await expand(
		selection,
		{
			cdbFile: request.cdbFile,
			cdbPassword: request.cdbPassword,
			allowAdhoc: options.allowAdhoc ?? true,
		},
		env,
	);

	const via = fanoutVia(request, env, expansion);
	const concurrency = resolveFanoutConcurrency(options.concurrency, via);

	if (expansion.empty) {
		return buildApiFanoutSuccess({
			summary: { total: 0, ok: 0, failed: 0 },
			targets: [],
			warnings: expansion.warnings,
			via: null,
			concurrency,
			requestSummary,
			selectionSummary,
		});
	}

	// Mutating fan-out: confirm ONCE up front, naming the blast radius.
	await assertFanoutWriteConfirmed(request, requestSummary, method, expansion);

	const execute = internals.execute ?? runResolvedApi;
	const sleep = internals.sleep ?? defaultFanoutSleep;

	const targets = await runFanout<
		CdbSelectionMember,
		ResolvedApiRequest,
		ApiEnvelope
	>({
		members: expansion.targets,
		concurrency,
		resolve: (member) => {
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
				return resolveApiRequest(
					{ ...request, targetInput: member.resolution.target },
					env,
					{ cdbResolution: member.resolution },
				);
			}
			return resolveApiRequest({ ...request, targetInput: member.input }, env);
		},
		onResolveError: (member, error) =>
			buildFanoutResolveFailure<ApiOperationMeta>({
				error,
				target: memberTargetMeta(member),
				warnings: member.kind === "cdb" ? [...member.resolution.warnings] : [],
			}),
		execute: (resolved) => execute(resolved),
		onExecuteError: (resolved, _member, error) =>
			buildApiErrorEnvelopeFromResolved(resolved, error),
		sleep,
	});

	return buildApiFanoutSuccess({
		summary: summarizeFanout(targets),
		targets,
		warnings: expansion.warnings,
		via: commonVia(targets),
		concurrency,
		requestSummary,
		selectionSummary,
	});
}

async function assertFanoutWriteConfirmed(
	request: ApiRequest,
	summary: ApiRequestSummary,
	method: string,
	expansion: CdbSelectionExpansion,
): Promise<void> {
	if (!summary.write || request.yes) {
		return;
	}
	const count = expansion.targets.length;
	const prompt = `Run mutating ${method} ${summary.path} across ${count} router(s)? Type yes to continue: `;
	if (request.stdinIsTty ?? process.stdin.isTTY) {
		const confirmed = await (request.confirm ?? promptForWriteConfirmation)(
			prompt,
		);
		if (confirmed) {
			return;
		}
	}
	throw new CentrsError({
		code: "usage/confirmation-required",
		summary: `A mutating ${method} ${summary.path} would run across ${count} router(s) and needs explicit confirmation.`,
		remediation:
			"Pass `--yes` to fan the write out to every selected router, or answer `yes` at the TTY prompt after reviewing the blast radius.",
		context: { method, path: summary.path, routers: count },
	});
}

interface ApiFanoutSuccessInput {
	summary: FanoutSummary;
	targets: readonly ApiEnvelope[];
	warnings: CdbSelectionExpansion["warnings"];
	via: RouterOsProtocol | null;
	concurrency: number;
	requestSummary: ApiRequestSummary;
	selectionSummary: ApiSelectionSummary;
}

function buildApiFanoutSuccess(
	input: ApiFanoutSuccessInput,
): ApiFanoutEnvelope {
	return buildFanoutEnvelope<unknown, ApiOperationMeta, ApiFanoutOperationMeta>(
		{
			summary: input.summary,
			targets: input.targets,
			warnings: input.warnings,
			settings: {},
			via: input.via,
			operation: {
				kind: "fanout",
				concurrency: input.concurrency,
				summary: input.summary,
				request: input.requestSummary,
				selection: input.selectionSummary,
			},
		},
	);
}

/** Outer error envelope for a fan-out that failed before per-target results. */
export function buildApiFanoutErrorEnvelope(
	request: ApiRequest,
	selection: TargetSelection,
	error: unknown,
	env: Record<string, string | undefined> = Bun.env,
): ApiFanoutErrorEnvelope {
	const centrsError =
		error instanceof CentrsError
			? error
			: new CentrsError({
					code: "internal/unhandled",
					summary: "api fan-out failed with an unexpected error.",
					remediation:
						"Re-run with `--format json` to capture the structured error details.",
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
			operation: {
				kind: "fanout",
				concurrency: 0,
				summary: { total: 0, ok: 0, failed: 0 },
				request: apiRequestSummaryFromRequest(request, env),
				selection: summarizeSelection(selection),
			},
		},
	};
}

/**
 * Render an api fan-out envelope. `json`/`yaml` serialize the whole envelope;
 * `text` renders a summary line plus one line per target in record-index order.
 */
export function renderApiFanoutEnvelope(
	envelope: ApiFanoutEnvelope | ApiFanoutErrorEnvelope,
	format: "json" | "yaml" | "text",
	options: { verbose?: boolean } = {},
): string {
	if (format === "json") {
		return JSON.stringify(envelope, null, 2);
	}
	if (format === "yaml") {
		return toYaml(envelope);
	}
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
		`api ${operation?.request.method} ${operation?.request.path}: ${ok}/${total} ok, ${failed} failed (concurrency ${operation?.concurrency ?? "?"})`,
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
			if (options.verbose && target.error.remediation) {
				lines.push(`        Fix: ${target.error.remediation}`);
			}
		}
	}
	for (const warning of envelope.warnings) {
		lines.push(`warning [${warning.code}]: ${warning.message}`);
	}
	return lines.join("\n");
}
