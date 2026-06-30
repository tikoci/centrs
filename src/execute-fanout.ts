/**
 * Multi-target fan-out for `execute`.
 *
 * A target selection (`--group` / `--where` / `--all` / `--default` / multiple
 * positionals before `--`) expands to N members and runs the SAME RouterOS
 * command on each through the single-target execute tail (`resolveExecuteRequest`
 * → `runResolvedExecute`), collecting per-target inner `ExecuteEnvelope`s into the
 * locked `FanoutData` shape (`src/core/envelope.ts`).
 *
 * Boundaries (see `commands/execute/README.md`, `docs/CONSTITUTION.md`), shared
 * with `api-fanout.ts` / `retrieve-fanout.ts`:
 *   - The CDB is loaded ONCE (`expandCdbSelection`); a cdb member is resolved with
 *     its pre-resolved record, so `resolveCdb`'s `__default__` synthetic fallback
 *     never collides ad-hoc literals.
 *   - A `--default` / `__default__` member is guarded from being dialed as the
 *     literal hostname `"__default__"` — it fails that one target deterministically
 *     with `target/unresolved`.
 *   - A **write-shaped** command (add/set/remove) is confirmed ONCE up front
 *     (`--yes`), never per target; without `--yes` the error names the blast radius
 *     (how many routers). Write-ness is target-independent (`canonicalizeExecuteCommand`).
 */

import type {
	CentrsErrorEnvelope,
	CentrsSuccessEnvelope,
	CommonSettingsMeta,
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
import {
	buildExecuteErrorEnvelopeFromResolved,
	type ExecuteEnvelope,
	type ExecuteOperationMeta,
	type ExecuteRequest,
	type ExecuteRequestSummary,
	type ExecuteSuccessEnvelope,
	promptForWriteConfirmation,
	type ResolvedExecuteRequest,
	resolveExecuteGlobalContext,
	resolveExecuteRequest,
	runResolvedExecute,
} from "./execute.ts";
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
export interface ExecuteSelectionSummary {
	groups: readonly string[];
	where: readonly string[];
	all: boolean;
	default: boolean;
	positionals: readonly string[];
}

export interface ExecuteFanoutOperationMeta {
	kind: "fanout";
	concurrency: number;
	summary: FanoutSummary;
	request: ExecuteRequestSummary;
	selection: ExecuteSelectionSummary;
}

export type ExecuteFanoutData = FanoutData<unknown, ExecuteOperationMeta>;
export type ExecuteFanoutEnvelope = CentrsSuccessEnvelope<
	ExecuteFanoutData,
	ExecuteFanoutOperationMeta
>;
export type ExecuteFanoutErrorEnvelope =
	CentrsErrorEnvelope<ExecuteFanoutOperationMeta>;

/** Test/override seams; production callers pass nothing. */
export interface ExecuteFanoutInternals {
	expand?: (
		selection: TargetSelection,
		input: CdbSelectionResolveInput,
		env: Record<string, string | undefined>,
	) => Promise<CdbSelectionExpansion>;
	execute?: (
		resolved: ResolvedExecuteRequest,
	) => Promise<ExecuteSuccessEnvelope>;
	sleep?: (ms: number) => Promise<void>;
}

export interface ExecuteFanoutOptions {
	concurrency?: number;
	/** CLI: true (literal positionals allowed). MCP: false (CDB is the allowlist). */
	allowAdhoc?: boolean;
}

function summarizeSelection(
	selection: TargetSelection,
): ExecuteSelectionSummary {
	return {
		groups: selection.groups,
		where: selection.where.map((clause) => `${clause.key}=${clause.value}`),
		all: selection.all,
		default: selection.default,
		positionals: selection.positionals,
	};
}

/** Representative transport for the concurrency default (pinned > native member > global). */
function fanoutVia(
	request: ExecuteRequest,
	env: Record<string, string | undefined>,
	globalVia: RouterOsProtocol,
	expansion: CdbSelectionExpansion,
): RouterOsProtocol {
	if (request.via !== undefined || env["CENTRS_VIA"] !== undefined) {
		return globalVia;
	}
	const anyNative = expansion.targets.some(
		(member) =>
			member.kind === "cdb" &&
			member.resolution.overrides.via?.value === "native-api",
	);
	return anyNative ? "native-api" : globalVia;
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
 * Ad-hoc literal targets have no CDB record. `resolveExecuteRequest` may borrow the
 * `__default__` record's index when filling fallback creds, so the inner envelope
 * would carry that borrowed `recordIndex` — making distinct literals collide on one
 * index. Drop it for literal members and stamp the caller's `input` so the target
 * stays identifiable in renderers (mirrors `api-fanout.ts`).
 */
function relabelAdhocMember(
	envelope: ExecuteEnvelope,
	member: CdbSelectionMember,
): ExecuteEnvelope {
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
 * Run an `execute` fan-out. Returns a success envelope when the orchestration
 * completes (even if every target failed); throws only for pre-flight failures
 * (invalid command shape, CDB decrypt, unconfirmed write) the caller renders as
 * an outer error via {@link buildExecuteFanoutErrorEnvelope}.
 */
export async function executeFanout(
	request: ExecuteRequest,
	selection: TargetSelection,
	env: Record<string, string | undefined> = Bun.env,
	internals: ExecuteFanoutInternals = {},
	options: ExecuteFanoutOptions = {},
): Promise<ExecuteFanoutEnvelope> {
	// Validate + canonicalize the command ONCE, before selection expansion: a bad
	// command shape is an outer error regardless of how many targets resolve, and
	// write-ness is target-independent.
	const global = resolveExecuteGlobalContext(request, env);
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

	const via = fanoutVia(request, env, global.via, expansion);
	const concurrency = resolveFanoutConcurrency(options.concurrency, via);

	if (expansion.empty) {
		return executeFanoutEnvelope({
			selection: selectionSummary,
			concurrency,
			summary: { total: 0, ok: 0, failed: 0 },
			requestSummary: global.summary,
			settings: global.settings,
			via: null,
			warnings: expansion.warnings,
			targets: [],
		});
	}

	// Write-shaped fan-out: confirm ONCE up front, naming the blast radius.
	await assertFanoutWriteConfirmed(request, global.summary, expansion);

	const execute = internals.execute ?? runResolvedExecute;
	const sleep = internals.sleep ?? defaultFanoutSleep;

	const targets = await runFanout<
		CdbSelectionMember,
		ResolvedExecuteRequest,
		ExecuteEnvelope
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
				return resolveExecuteRequest(
					{ ...request, targetInput: member.resolution.target },
					env,
					{ cdbResolution: member.resolution },
				);
			}
			return resolveExecuteRequest(
				{ ...request, targetInput: member.input },
				env,
			);
		},
		onResolveError: (member, error) =>
			buildFanoutResolveFailure<ExecuteOperationMeta>({
				error,
				target: memberTargetMeta(member),
				warnings: member.kind === "cdb" ? [...member.resolution.warnings] : [],
				summary: "Failed to resolve a fanout target.",
			}),
		execute: async (resolved, member) =>
			relabelAdhocMember(await execute(resolved), member),
		onExecuteError: (resolved, member, error) =>
			relabelAdhocMember(
				buildExecuteErrorEnvelopeFromResolved(resolved, error),
				member,
			),
		sleep,
	});

	return executeFanoutEnvelope({
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

async function assertFanoutWriteConfirmed(
	request: ExecuteRequest,
	summary: ExecuteRequestSummary,
	expansion: CdbSelectionExpansion,
): Promise<void> {
	if (!summary.write || request.yes) {
		return;
	}
	const count = expansion.targets.length;
	const prompt = `Run write-shaped \`${summary.command}\` across ${count} router(s)? Type yes to continue: `;
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
		summary: `A write-shaped \`${summary.command}\` would run across ${count} router(s) and needs explicit confirmation.`,
		remediation:
			"Pass `--yes` to fan the write out to every selected router, or answer `yes` at the TTY prompt after reviewing the blast radius.",
		context: { command: summary.command, routers: count },
	});
}

interface ExecuteFanoutEnvelopeInput {
	selection: ExecuteSelectionSummary;
	concurrency: number;
	summary: FanoutSummary;
	requestSummary: ExecuteRequestSummary;
	settings: CommonSettingsMeta;
	via: RouterOsProtocol | null;
	warnings: CdbSelectionExpansion["warnings"];
	targets: readonly ExecuteEnvelope[];
}

function executeFanoutEnvelope(
	input: ExecuteFanoutEnvelopeInput,
): ExecuteFanoutEnvelope {
	return buildFanoutEnvelope<
		unknown,
		ExecuteOperationMeta,
		ExecuteFanoutOperationMeta
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

/** Outer error envelope for a fan-out that failed before per-target results. */
export function buildExecuteFanoutErrorEnvelope(
	request: ExecuteRequest,
	error: unknown,
): ExecuteFanoutErrorEnvelope {
	const centrsError =
		error instanceof CentrsError
			? error
			: new CentrsError({
					code: "internal/unhandled",
					summary: "execute fan-out failed with an unexpected error.",
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
		},
	};
}

/**
 * Render an execute fan-out envelope. `json`/`yaml` serialize the whole envelope;
 * `text` renders a summary line plus one line per target in record-index order.
 */
export function renderExecuteFanoutEnvelope(
	envelope: ExecuteFanoutEnvelope | ExecuteFanoutErrorEnvelope,
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
		`execute ${operation?.request.command ?? "?"}: ${ok}/${total} ok, ${failed} failed (concurrency ${operation?.concurrency ?? "?"})`,
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
