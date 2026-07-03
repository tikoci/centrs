/**
 * Multi-target fan-out for `transfer`.
 *
 * A target selection (`--group` / `--where` / `--all` / `--default` / multiple
 * positionals before the verb) runs the SAME transfer verb on each member through
 * the single-target tail (`transfer`), collecting per-target inner
 * `TransferEnvelope`s into the locked `FanoutData` shape (`src/core/envelope.ts`).
 *
 * Boundaries (see `commands/transfer/README.md`, `docs/CONSTITUTION.md`), shared
 * with `api`/`retrieve`/`execute` fan-out:
 *   - The CDB is loaded ONCE (`expandCdbSelection`); a cdb member is resolved with
 *     its pre-resolved record, so `resolveCdb`'s `__default__` synthetic fallback
 *     never collides ad-hoc literals.
 *   - A `--default` / `__default__` member fails that one target deterministically
 *     with `target/unresolved`.
 *   - A **mutating** verb (`upload`/`remove`/`mkdir`/`copy`) is confirmed ONCE up
 *     front (`--yes`), never per target; without `--yes` the error names the blast
 *     radius. `download`/`list` only read the device.
 *   - **`download` fan-out requires `--out-dir`**: N devices cannot share one local
 *     path, so each target writes a collision-safe file named by its CDB
 *     target/identity into the directory.
 */

import { basename, extname, join } from "node:path";
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
import { promptForWriteConfirmation } from "./execute.ts";
import { plannedProtocols, type RouterOsProtocol } from "./protocols/index.ts";
import {
	type CdbSelectionExpansion,
	type CdbSelectionMember,
	type CdbSelectionResolveInput,
	expandCdbSelection,
	isDefaultRecordTarget,
	loadEnvFileDefaults,
	type TargetSelection,
} from "./resolver/index.ts";
import { toYaml } from "./retrieve.ts";
import {
	buildTransferErrorEnvelope,
	isTransferWriteVerb,
	type TransferEnvelope,
	type TransferOperationMeta,
	type TransferOutputFormat,
	type TransferRequest,
	type TransferSuccessEnvelope,
	type TransferVerb,
	transfer,
	validateTransferRequestShape,
} from "./transfer.ts";

/** Compact description of the selector that produced the fan-out. */
export interface TransferSelectionSummary {
	groups: readonly string[];
	where: readonly string[];
	all: boolean;
	default: boolean;
	positionals: readonly string[];
}

export interface TransferFanoutRequestSummary {
	verb: TransferVerb;
	remote: string | null;
	force: boolean;
	validate: boolean;
	outDir: string | null;
}

export interface TransferFanoutOperationMeta {
	kind: "fanout";
	concurrency: number;
	summary: FanoutSummary;
	request: TransferFanoutRequestSummary;
	selection: TransferSelectionSummary;
}

export type TransferFanoutData = FanoutData<unknown, TransferOperationMeta>;
export type TransferFanoutEnvelope = CentrsSuccessEnvelope<
	TransferFanoutData,
	TransferFanoutOperationMeta
>;
export type TransferFanoutErrorEnvelope =
	CentrsErrorEnvelope<TransferFanoutOperationMeta>;

/** Test/override seams; production callers pass nothing. */
export interface TransferFanoutInternals {
	expand?: (
		selection: TargetSelection,
		input: CdbSelectionResolveInput,
		env: Record<string, string | undefined>,
		config?: Record<string, string | undefined>,
	) => Promise<CdbSelectionExpansion>;
	execute?: (
		request: TransferRequest,
		member: CdbSelectionMember,
	) => Promise<TransferSuccessEnvelope>;
	sleep?: (ms: number) => Promise<void>;
}

export interface TransferFanoutOptions {
	concurrency?: number;
	/** CLI: true (literal positionals allowed). MCP: false (CDB is the allowlist). */
	allowAdhoc?: boolean;
}

function summarizeSelection(
	selection: TargetSelection,
): TransferSelectionSummary {
	return {
		groups: selection.groups,
		where: selection.where.map((clause) => `${clause.key}=${clause.value}`),
		all: selection.all,
		default: selection.default,
		positionals: selection.positionals,
	};
}

function memberLabel(member: CdbSelectionMember): string {
	return member.kind === "cdb" ? member.resolution.identity : member.input;
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

/** Sanitize a device label into a single safe filename segment. */
function sanitizeFilename(label: string): string {
	// Character-class replaces (no backtracking); strip leading dots so a label
	// cannot produce a hidden / traversal-looking name.
	const cleaned = label.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
	return cleaned.length > 0 ? cleaned : "target";
}

/**
 * Pre-compute one collision-safe local path per member for a `download` fan-out.
 * Files are named by the device label (CDB identity / literal input) and keep the
 * remote file's extension; same-label collisions are disambiguated deterministically.
 */
function planDownloadPaths(
	outDir: string,
	remote: string,
	members: readonly CdbSelectionMember[],
): Map<CdbSelectionMember, string> {
	const ext = extname(basename(remote));
	const used = new Set<string>();
	const paths = new Map<CdbSelectionMember, string>();
	members.forEach((member, index) => {
		const label = sanitizeFilename(memberLabel(member));
		let name = `${label}${ext}`;
		if (used.has(name)) {
			const disambiguator =
				member.kind === "cdb" ? `-${member.recordIndex}` : `-${index}`;
			name = `${label}${disambiguator}${ext}`;
			let bump = 1;
			while (used.has(name)) {
				name = `${label}${disambiguator}-${bump}${ext}`;
				bump += 1;
			}
		}
		used.add(name);
		paths.set(member, join(outDir, name));
	});
	return paths;
}

/**
 * Ad-hoc literal targets have no CDB record. The resolver may borrow the
 * `__default__` record's index for fallback creds, so the inner envelope would
 * carry that borrowed `recordIndex` — making distinct literals collide on one
 * index. Drop it for literal members and stamp the caller's `input`.
 */
function relabelAdhocMember(
	envelope: TransferEnvelope,
	member: CdbSelectionMember,
): TransferEnvelope {
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
 * Stamp the member's identity onto a per-target ENVELOPE. `buildTransferErrorEnvelope`
 * only knows `request.targetInput`, so a failed cdb member would otherwise lose its
 * `recordIndex`/`identity` (breaking record-index ordering). Literals are relabeled
 * to drop a borrowed `__default__` index; cdb members get their record meta restored.
 */
function applyMemberMeta(
	envelope: TransferEnvelope,
	member: CdbSelectionMember,
): TransferEnvelope {
	if (member.kind === "literal") {
		return relabelAdhocMember(envelope, member);
	}
	return {
		...envelope,
		meta: {
			...envelope.meta,
			target: { ...envelope.meta.target, ...memberTargetMeta(member) },
		},
	};
}

/**
 * Run a `transfer` fan-out. Returns a success envelope when the orchestration
 * completes (even if every target failed); throws only for pre-flight failures
 * (bad request shape, missing `--out-dir`, CDB decrypt, unconfirmed write) the
 * caller renders as an outer error via {@link buildTransferFanoutErrorEnvelope}.
 */
export async function transferFanout(
	request: TransferRequest,
	selection: TargetSelection,
	env: Record<string, string | undefined> = Bun.env,
	internals: TransferFanoutInternals = {},
	options: TransferFanoutOptions = {},
): Promise<TransferFanoutEnvelope> {
	validateTransferRequestShape(request);
	const config = await loadEnvFileDefaults(env);
	const selectionSummary = summarizeSelection(selection);
	const requestSummary: TransferFanoutRequestSummary = {
		verb: request.verb,
		remote: request.remote ?? request.path ?? null,
		force: request.force ?? false,
		validate: request.validate ?? true,
		outDir: request.outDir ?? null,
	};

	// `download` fan-out needs a per-target local path: `--out-dir` is mandatory
	// (N devices cannot share one local path).
	if (request.verb === "download" && request.outDir === undefined) {
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary:
				"`download` fan-out writes one file per target and requires `--out-dir <dir>`.",
			remediation:
				"Pass `--out-dir <dir>`; each target's file is written there, named by its CDB identity.",
			context: { verb: "download" },
		});
	}

	const expand = internals.expand ?? expandCdbSelection;
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

	const concurrency = resolveFanoutConcurrency(options.concurrency, "rest-api");

	if (expansion.empty) {
		return transferFanoutEnvelope({
			selection: selectionSummary,
			concurrency,
			summary: { total: 0, ok: 0, failed: 0 },
			requestSummary,
			via: null,
			warnings: expansion.warnings,
			targets: [],
		});
	}

	// Mutating verbs (upload/remove/mkdir/copy): confirm ONCE up front.
	if (isTransferWriteVerb(request.verb)) {
		await assertFanoutWriteConfirmed(request, expansion);
	}

	const downloadPaths =
		request.verb === "download"
			? planDownloadPaths(
					request.outDir ?? ".",
					request.remote ?? "",
					expansion.targets,
				)
			: undefined;

	const execute =
		internals.execute ??
		((req: TransferRequest, member: CdbSelectionMember) =>
			transfer(req, env, {
				// cdb members carry their pre-resolved record (CDB loaded once);
				// literals fall through to single-target resolution.
				cdbResolution: member.kind === "cdb" ? member.resolution : undefined,
			}));
	const sleep = internals.sleep ?? defaultFanoutSleep;

	const targets = await runFanout<
		CdbSelectionMember,
		{ request: TransferRequest; member: CdbSelectionMember },
		TransferEnvelope
	>({
		members: expansion.targets,
		concurrency,
		resolve: (member) => {
			if (
				member.kind === "cdb" &&
				isDefaultRecordTarget(member.resolution.target)
			) {
				throw new CentrsError({
					code: "target/unresolved",
					summary:
						"The `__default__` record is a credential fallback, not a connectable router.",
					remediation:
						"Select real devices with `--group` / `--where` / `--all` or a positional; `--default` cannot be a RouterOS target.",
					context: { target: member.resolution.target },
				});
			}
			const targetInput =
				member.kind === "cdb" ? member.resolution.target : member.input;
			const perRequest: TransferRequest = { ...request, targetInput };
			if (downloadPaths !== undefined) {
				perRequest.local = downloadPaths.get(member);
			}
			return { request: perRequest, member };
		},
		onResolveError: (member, error) =>
			buildFanoutResolveFailure<TransferOperationMeta>({
				error,
				target: memberTargetMeta(member),
				warnings: member.kind === "cdb" ? [...member.resolution.warnings] : [],
				summary: "Failed to resolve a fanout target.",
			}),
		execute: async (resolved, member) =>
			relabelAdhocMember(await execute(resolved.request, member), member),
		onExecuteError: (resolved, member, error) =>
			applyMemberMeta(
				buildTransferErrorEnvelope(resolved.request, error),
				member,
			),
		sleep,
	});

	return transferFanoutEnvelope({
		selection: selectionSummary,
		concurrency,
		summary: summarizeFanout(targets),
		requestSummary,
		via: commonVia(targets),
		warnings: expansion.warnings,
		targets,
	});
}

async function assertFanoutWriteConfirmed(
	request: TransferRequest,
	expansion: CdbSelectionExpansion,
): Promise<void> {
	if (request.yes) {
		return;
	}
	const count = expansion.targets.length;
	const prompt = `Run mutating \`${request.verb}\` across ${count} router(s)? Type yes to continue: `;
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
		summary: `A mutating \`${request.verb}\` would run across ${count} router(s) and needs explicit confirmation.`,
		remediation:
			"Pass `--yes` to fan the write out to every selected router, or answer `yes` at the TTY prompt after reviewing the blast radius.",
		context: { verb: request.verb, routers: count },
	});
}

interface TransferFanoutEnvelopeInput {
	selection: TransferSelectionSummary;
	concurrency: number;
	summary: FanoutSummary;
	requestSummary: TransferFanoutRequestSummary;
	via: RouterOsProtocol | string | null;
	warnings: CdbSelectionExpansion["warnings"];
	targets: readonly TransferEnvelope[];
}

function transferFanoutEnvelope(
	input: TransferFanoutEnvelopeInput,
): TransferFanoutEnvelope {
	const settings: CommonSettingsMeta = {};
	return buildFanoutEnvelope<
		unknown,
		TransferOperationMeta,
		TransferFanoutOperationMeta
	>({
		summary: input.summary,
		targets: input.targets,
		warnings: input.warnings,
		settings,
		via: (input.via as RouterOsProtocol | null) ?? null,
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
export function buildTransferFanoutErrorEnvelope(
	request: TransferRequest,
	error: unknown,
): TransferFanoutErrorEnvelope {
	const centrsError =
		error instanceof CentrsError
			? error
			: new CentrsError({
					code: "internal/unhandled",
					summary: "transfer fan-out failed with an unexpected error.",
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
 * Render a transfer fan-out envelope. `json`/`yaml` serialize the whole envelope;
 * `text` renders a summary line plus one line per target in record-index order.
 */
export function renderTransferFanoutEnvelope(
	envelope: TransferFanoutEnvelope | TransferFanoutErrorEnvelope,
	format: TransferOutputFormat,
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
	const remote = operation?.request.remote ?? "";
	const lines: string[] = [
		`transfer ${operation?.request.verb ?? "?"} ${remote}: ${ok}/${total} ok, ${failed} failed (concurrency ${operation?.concurrency ?? "?"})`,
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
			const data = Array.isArray(target.data) ? undefined : target.data;
			const detail =
				data && typeof data === "object" && "local" in data && data.local
					? ` → ${String((data as { local?: string }).local)}`
					: "";
			lines.push(`  [${index}] ok    ${label}${detail}`);
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
