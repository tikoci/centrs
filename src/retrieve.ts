import type {
	CentrsEnvelope,
	CentrsErrorEnvelope,
	CentrsSuccessEnvelope,
	CommonSettingsMeta,
	SettingSource as CoreSettingSource,
	EnvelopeValidationMeta,
} from "./core/envelope.ts";
import {
	extractCompletionNames,
	inspectArgumentNames,
	inspectChildren,
	inspectChildrenOrEmpty,
	inspectCompletions,
	isArgumentNode,
	isCommandNode,
	pathTokens,
} from "./core/inspect.ts";
import { toYaml } from "./core/yaml.ts";
import {
	CentrsError,
	formatCentrsErrorText,
	serializeCentrsError,
} from "./errors.ts";
import {
	createProtocolAdapter,
	type ProtocolAdapter,
} from "./protocols/adapter.ts";
import {
	getProtocolPlan,
	plannedProtocols,
	type RouterOsProtocol,
} from "./protocols/index.ts";
import {
	assertNoQuickchrOverrideConflict,
	type CdbResolution,
	isIpTransport,
	loadEnvFileDefaults,
	parseDuration,
	parseResolvePolicy,
	type QuickchrResolution,
	quickchrConnection,
	type ResolvedAuth,
	type ResolvedSetting,
	type ResolvedTarget,
	resolveAuth,
	resolveBooleanSetting,
	resolveCdb,
	resolveMacTarget,
	resolveOptionalIntegerSetting,
	resolveQuickchrTarget,
	resolveStringSetting,
	resolveTarget,
	toCoreSource,
} from "./resolver/index.ts";

export const retrieveOutputFormats = [
	"text",
	"json",
	"yaml",
	"ndjson",
] as const;
export type RetrieveOutputFormat = (typeof retrieveOutputFormats)[number];

export interface RetrieveRequest {
	targetInput?: string;
	/**
	 * quickchr machine name (`--quickchr <name>`): resolve host/port/auth from
	 * the live VM descriptor instead of CDB/env (`docs/CONSTITUTION.md` →
	 * Resolution providers). Conflicts with host/port/username/password.
	 */
	quickchr?: string;
	path: string;
	via?: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	timeout?: string | number;
	format?: string;
	validate?: boolean;
	verbose?: boolean;
	attribute?: string | readonly string[];
	attributes?: string | readonly string[];
	allAttributes?: boolean;
	listAttributes?: boolean;
	filter?: string;
	query?: string;
	maxResultsBytes?: number;
	cdbFile?: string;
	cdbPassword?: string;
	/** Opt-in host ARP resolution for a MAC target (`none` default, or `arp`). */
	resolve?: string;
	/** CDB group selector — expands to a fanout over all matching records. */
	group?: string;
	/** Bounded worker-pool size for group fanout (defaults are transport-aware). */
	concurrency?: number;
	/** Keep the menu's rows current over native-api `listen` (`retrieveFollow`). */
	follow?: boolean;
	/** `--follow` only: `.id` sweep period (`10s` default; `0` turns it off). */
	sweep?: string | number;
	/** `--follow` only: stop after this many `live` frames. */
	count?: number;
	/** `--follow` only: wall-clock bound, bootstrap included (e.g. `30s`). */
	duration?: string | number;
}

export interface RetrieveWarning {
	code: string;
	message: string;
	context?: Record<string, unknown>;
}

export interface RetrieveRequestSummary {
	path: string;
	attributes: readonly string[];
	allAttributes: boolean;
	listAttributes: boolean;
	validate: boolean;
	verbose: boolean;
	timeoutMs: number;
	format: RetrieveOutputFormat;
	maxResultsBytes?: number;
	/** Present when the request is a `--follow`. */
	follow?: RetrieveFollowSettings;
}

/** The resolved bounds of a `--follow`. */
export interface RetrieveFollowSettings {
	/** `.id` sweep period; `0` = off. */
	sweepMs: number;
	count?: number;
	durationMs?: number;
}

/** Why a `--follow` ended. */
export type RetrieveFollowStopReason =
	| "completed"
	| "routeros-error"
	| "count-reached"
	| "duration-elapsed"
	| "interrupted"
	| "transport-error";

/** Counts carried by a `--follow` summary (also its `data`). */
export interface RetrieveFollowCounts {
	/** Every frame line, snapshot and live. */
	frames: number;
	/** Frames before `synced`. */
	snapshot: number;
	/** `live` frames after `synced`; `--count` counts these. */
	changes: number;
	/** Completed `.id` sweeps. */
	sweeps: number;
	/** Whether the bootstrap finished before the follow ended. */
	synced: boolean;
}

export interface RetrieveFollowSummary extends RetrieveFollowCounts {
	stopReason: RetrieveFollowStopReason;
	durationMs: number;
}

/**
 * Per-line marker on `--follow` output (`commands/retrieve/README.md` →
 * Follow). A `frame` is one row change: `upsert` carries the latest full row,
 * `removed` carries `data: null`; `id` is the row identity even when the
 * projection leaves `.id` out of `data`.
 */
export type RetrieveStreamMeta =
	| { kind: "notice" }
	| {
			kind: "frame";
			index: number;
			phase: "snapshot" | "live";
			change: "upsert" | "removed";
			id: string;
			source: "print" | "listen" | "sweep";
	  }
	| { kind: "synced"; rows: number }
	| ({ kind: "summary" } & RetrieveFollowSummary);

export interface RetrieveOperationMeta {
	kind: "attributes" | "data";
	objectCount: number;
	request: RetrieveRequestSummary;
	auth: {
		username?: string;
		passwordProvided: boolean;
	};
	/** Present only on `--follow` output. */
	stream?: RetrieveStreamMeta;
}

export type RetrieveEnvelope = CentrsEnvelope<unknown, RetrieveOperationMeta>;
export type RetrieveSuccessEnvelope = CentrsSuccessEnvelope<
	unknown,
	RetrieveOperationMeta
>;
export type RetrieveErrorEnvelope = CentrsErrorEnvelope<RetrieveOperationMeta>;

export interface RetrieveInspection {
	command: "get" | "print";
	singleton: boolean;
}

export interface ResolvedRetrieveRequest {
	path: string;
	via: ResolvedSetting<RouterOsProtocol>;
	target: ResolvedTarget;
	auth: ResolvedAuth;
	timeoutMs: ResolvedSetting<number>;
	format: ResolvedSetting<RetrieveOutputFormat>;
	validate: ResolvedSetting<boolean>;
	/**
	 * Relax TLS peer verification. retrieve has no `--insecure` flag; this is set
	 * only by the quickchr provider (trust-by-provenance for the VM's self-signed
	 * TLS forward — see `src/resolver/quickchr-provider.ts`), so when present its
	 * source is always `provider` and it is surfaced as `meta.settings.insecure`
	 * for auditability.
	 */
	insecure?: ResolvedSetting<boolean>;
	maxResultsBytes?: ResolvedSetting<number>;
	attributes: readonly string[];
	allAttributes: boolean;
	listAttributes: boolean;
	verbose: boolean;
	follow?: RetrieveFollowSettings;
	warnings: readonly RetrieveWarning[];
}

export async function retrieve(
	request: RetrieveRequest,
	env: Record<string, string | undefined> = Bun.env,
): Promise<RetrieveSuccessEnvelope> {
	if (request.follow) {
		throw new CentrsError({
			code: "input/invalid-command",
			summary:
				"`follow` yields a stream of envelopes instead of one `retrieve` result.",
			remediation:
				"Consume it with `retrieveFollow()` (library) or `centrs retrieve … --follow` (CLI): snapshot frames, `synced`, live frames, then a summary.",
			context: { capability: "follow" },
		});
	}
	const resolved = await resolveRetrieveRequest(request, env);
	return runResolvedRetrieve(resolved);
}

/**
 * The inspect → fetch → envelope tail shared by single-target `retrieve()` and
 * group fanout. Takes an already-resolved request (one CDB record's identity +
 * overrides) so fanout does not re-resolve or re-load the CDB per target. On
 * success returns a `RetrieveSuccessEnvelope`; failures throw a `CentrsError`
 * the caller maps with {@link buildRetrieveErrorEnvelopeFromResolved}.
 */
export async function runResolvedRetrieve(
	resolved: ResolvedRetrieveRequest,
): Promise<RetrieveSuccessEnvelope> {
	const warnings: RetrieveWarning[] = [...resolved.warnings];
	let availableAttributes: string[] | undefined;
	let inspection: RetrieveInspection | undefined;
	const backend = createProtocolAdapter({
		protocol: resolved.via.value,
		host: resolved.target.host,
		port: resolved.target.port,
		tls: resolved.target.tls,
		baseUrl: resolved.target.baseUrl,
		username: resolved.auth.username,
		password: resolved.auth.password,
		timeoutMs: resolved.timeoutMs.value,
		insecure: resolved.insecure?.value,
	});

	try {
		if (resolved.listAttributes || resolved.validate.value) {
			inspection = await inspectRetrievePath(resolved, backend);
		}

		if (resolved.listAttributes) {
			availableAttributes = await inspectAttributes(
				resolved,
				inspection ?? (await inspectRetrievePath(resolved, backend)),
				backend,
			);
			const envelope = buildSuccessEnvelope(
				resolved,
				{
					kind: "attributes",
					data: availableAttributes ?? [],
				},
				{
					enabled: true,
					source: "live /console/inspect request=child+completion",
					availableAttributes: availableAttributes ?? [],
				},
				warnings,
			);
			return applyMaxResultsBudget(envelope);
		}

		if (resolved.validate.value && resolved.attributes.length > 0) {
			availableAttributes = await assertKnownAttributes(
				resolved,
				inspection ?? (await inspectRetrievePath(resolved, backend)),
				backend,
			);
		}

		const data = await executeRetrieve(resolved, backend, inspection);
		const envelope = buildSuccessEnvelope(
			resolved,
			{
				kind: "data",
				data,
			},
			{
				enabled: resolved.validate.value,
				source: resolved.validate.value
					? availableAttributes
						? "live /console/inspect request=child+completion"
						: "live /console/inspect request=child"
					: "disabled",
				availableAttributes,
			},
			warnings,
		);
		return applyMaxResultsBudget(envelope);
	} finally {
		await backend.close();
	}
}

export function buildRetrieveErrorEnvelope(
	request: RetrieveRequest,
	error: unknown,
): RetrieveErrorEnvelope {
	const centrsError =
		error instanceof CentrsError
			? error
			: new CentrsError({
					code: "internal/unhandled",
					summary: "retrieve failed with an unexpected internal error.",
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
			target: { input: request.targetInput },
			via: requestedVia,
			settings: {},
		},
	};
}

/**
 * Error envelope for a single fanout target. Unlike
 * {@link buildRetrieveErrorEnvelope} (which only knows the raw request and so
 * loses `recordIndex` / `baseUrl` / `name` / per-field sources), this preserves
 * the resolved per-target identity, auth, settings, and operation meta so a
 * failed inner envelope carries the same provenance as a successful one.
 */
export function buildRetrieveErrorEnvelopeFromResolved(
	resolved: ResolvedRetrieveRequest,
	error: unknown,
): RetrieveErrorEnvelope {
	const centrsError =
		error instanceof CentrsError
			? error
			: new CentrsError({
					code: "internal/unhandled",
					summary: "retrieve failed with an unexpected internal error.",
					remediation:
						"Re-run with `--format json` to capture the structured error details for debugging.",
					cause: error,
				});

	const meta = metaFromResolved(resolved, {
		enabled: resolved.validate.value,
		source: resolved.validate.value ? "live /console/inspect" : "disabled",
		result: "failed",
	});

	return {
		ok: false,
		error: serializeCentrsError(centrsError),
		warnings: [...resolved.warnings],
		tips: [],
		meta,
	};
}

export function renderRetrieveEnvelope(
	envelope: RetrieveEnvelope,
	format: RetrieveOutputFormat,
	options: { verbose?: boolean } = {},
): string {
	switch (format) {
		case "json":
			return JSON.stringify(envelope, null, 2);
		case "yaml":
			return toYaml(envelope);
		case "ndjson":
			return JSON.stringify(envelope);
		case "text":
			return envelope.ok
				? renderRetrieveSuccessText(envelope, options)
				: formatCentrsErrorText(envelope.error, options);
		default:
			return exhaustiveOutputFormat(format);
	}
}

function renderRetrieveSuccessText(
	envelope: RetrieveSuccessEnvelope,
	options: { verbose?: boolean },
): string {
	const lines: string[] = [];
	const verbose = options.verbose ?? false;
	const meta = envelope.meta;
	const operation = meta.operation;

	if (verbose) {
		const target = meta.target;
		lines.push(`target: ${target.input ?? target.host} -> ${target.baseUrl}`);
		lines.push(`via: ${meta.via}`);
		lines.push(
			`sources: via=${formatCoreSource(meta.settings.via)}, host=${formatCoreSource(
				meta.settings.host,
			)}, port=${formatCoreSource(meta.settings.port)}, timeout=${formatCoreSource(
				meta.settings.timeoutMs,
			)}, format=${formatCoreSource(meta.settings.format)}, validate=${formatCoreSource(
				meta.settings.validate,
			)}`,
		);
		if (meta.validation?.enabled) {
			lines.push(`validation: ${meta.validation.source}`);
		}
		lines.push("");
	}

	if (operation?.kind === "attributes") {
		const attributes = Array.isArray(envelope.data)
			? (envelope.data as readonly string[])
			: [];
		lines.push(...attributes);
	} else if (typeof envelope.data === "string") {
		lines.push(envelope.data);
	} else {
		lines.push(JSON.stringify(envelope.data, null, 2));
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
			if (item.fix) {
				lines.push(`    fix: ${item.fix}`);
			}
		}
	}

	return lines.join("\n");
}

export function retrieveRequestSummary(
	resolved: ResolvedRetrieveRequest,
): RetrieveRequestSummary {
	return {
		path: resolved.path,
		attributes: resolved.attributes,
		allAttributes: resolved.allAttributes,
		listAttributes: resolved.listAttributes,
		validate: resolved.validate.value,
		verbose: resolved.verbose,
		timeoutMs: resolved.timeoutMs.value,
		format: resolved.format.value,
		maxResultsBytes: resolved.maxResultsBytes?.value,
		...(resolved.follow ? { follow: resolved.follow } : {}),
	};
}

/**
 * Common `target` / `via` / `settings` meta for a resolved target. Shared by
 * success and per-target error envelopes so both carry identical provenance.
 */
export function metaFromResolved(
	resolved: ResolvedRetrieveRequest,
	validation: EnvelopeValidationMeta,
	operation?: RetrieveOperationMeta,
): RetrieveEnvelope["meta"] {
	const target = resolved.target;
	const targetSources: Record<string, CoreSettingSource> = {};
	for (const [field, source] of Object.entries(target.sources)) {
		targetSources[field] = toCoreSource(source);
	}

	return {
		target: {
			input: target.input,
			host: target.host,
			port: target.port,
			baseUrl: target.baseUrl,
			identity: target.identity,
			recordIndex: target.recordIndex,
			source: toCoreSource(target.source),
			sources: targetSources,
		},
		via: resolved.via.value,
		settings: {
			via: toCoreSource(resolved.via.source),
			host: toCoreSource(target.hostSource),
			port: toCoreSource(target.portSource),
			timeoutMs: toCoreSource(resolved.timeoutMs.source),
			format: toCoreSource(resolved.format.source),
			validate: toCoreSource(resolved.validate.source),
			insecure: resolved.insecure
				? toCoreSource(resolved.insecure.source)
				: undefined,
			maxResultsBytes: resolved.maxResultsBytes
				? toCoreSource(resolved.maxResultsBytes.source)
				: undefined,
			username: resolved.auth.usernameSource
				? toCoreSource(resolved.auth.usernameSource)
				: undefined,
			password: resolved.auth.passwordSource
				? toCoreSource(resolved.auth.passwordSource)
				: undefined,
		},
		validation,
		operation:
			operation ??
			({
				kind: resolved.listAttributes ? "attributes" : "data",
				objectCount: 0,
				request: retrieveRequestSummary(resolved),
				auth: {
					username: resolved.auth.username,
					passwordProvided: resolved.auth.passwordProvided,
				},
			} satisfies RetrieveOperationMeta),
	};
}

function buildSuccessEnvelope(
	resolved: ResolvedRetrieveRequest,
	result: { kind: "attributes" | "data"; data: unknown },
	validation: EnvelopeValidationMeta,
	warnings: readonly RetrieveWarning[],
): RetrieveSuccessEnvelope {
	const operation: RetrieveOperationMeta = {
		kind: result.kind,
		objectCount: countResultObjects(result.data),
		request: retrieveRequestSummary(resolved),
		auth: {
			username: resolved.auth.username,
			passwordProvided: resolved.auth.passwordProvided,
		},
	};

	return {
		ok: true,
		data: result.data,
		warnings,
		tips: [],
		meta: metaFromResolved(resolved, validation, operation),
	};
}

function applyMaxResultsBudget(
	envelope: RetrieveSuccessEnvelope,
): RetrieveSuccessEnvelope {
	const operation = envelope.meta.operation;
	if (!operation) {
		return envelope;
	}
	const requestSummary = operation.request;
	const rendered = renderRetrieveEnvelope(envelope, requestSummary.format, {
		verbose: requestSummary.format === "text" && requestSummary.verbose,
	});
	const serializedBytes = byteLength(rendered);

	if (
		requestSummary.maxResultsBytes !== undefined &&
		serializedBytes > requestSummary.maxResultsBytes
	) {
		throw new CentrsError({
			code: "input/max-results-exceeded",
			summary: `retrieve output exceeded the requested ${requestSummary.maxResultsBytes}-byte budget.`,
			remediation:
				"Increase `--max-results`, reduce the selected attributes, or switch to a more selective path.",
			context: {
				requiredBytes: serializedBytes,
				maxResultsBytes: requestSummary.maxResultsBytes,
				objectCount: operation.objectCount,
				path: requestSummary.path,
			},
		});
	}

	return envelope;
}

/**
 * Validate the request-shape concerns that do not depend on a target (path
 * form, unimplemented flags, mutually-exclusive output flags). Shared by
 * single-target resolution and group fanout so both reject the same shapes
 * before any network or CDB work. Returns the normalized attribute selection.
 */
export function validateRetrieveRequestShape(
	request: RetrieveRequest,
): readonly string[] {
	if (!request.path.startsWith("/")) {
		throw new CentrsError({
			code: "input/invalid-routeros-path",
			summary: `RouterOS path must be slash-prefixed. Received: ${request.path}`,
			remediation:
				"Pass a RouterOS menu path such as `/system/resource` or `/ip/address`.",
			context: { path: request.path },
		});
	}

	if (request.filter !== undefined || request.query !== undefined) {
		throw new CentrsError({
			code: "validation/not-implemented",
			summary:
				"`--filter` and `--query` are not implemented yet for `retrieve`.",
			remediation:
				"Remove the flag for now, or narrow the request with `--attribute` and `--max-results` instead.",
			context: {
				filter: request.filter,
				query: request.query,
			},
		});
	}

	assertFollowShape(request);

	const attributeSelections = normalizeAttributeSelection(request);
	if (request.allAttributes && attributeSelections.length > 0) {
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary:
				"`--all-attributes` cannot be combined with `--attribute` or `--attributes`.",
			remediation:
				"Choose either an explicit projection (`--attribute`) or the full detail/all-attributes shape (`--all-attributes`).",
		});
	}

	if (
		request.listAttributes &&
		(request.allAttributes || attributeSelections.length > 0)
	) {
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary:
				"`--list-attributes` cannot be combined with output-shaping flags such as `--attribute` or `--all-attributes`.",
			remediation:
				"Run `--list-attributes` by itself, then make a second call with the attributes you want to retrieve.",
		});
	}

	return attributeSelections;
}

/**
 * `--follow` flag pairings, checked before any network work: its bounds need
 * it, and a byte budget or an attribute listing has no meaning on a follow.
 */
function assertFollowShape(request: RetrieveRequest): void {
	if (!request.follow) {
		const orphan = (
			[
				["--sweep", request.sweep],
				["--count", request.count],
				["--duration", request.duration],
			] as const
		).find(([, value]) => value !== undefined);
		if (orphan) {
			throw new CentrsError({
				code: "usage/conflicting-flags",
				summary: `\`${orphan[0]}\` only applies to \`--follow\`.`,
				remediation: `Add \`--follow\` to follow the menu, or drop \`${orphan[0]}\` for a one-shot read.`,
				context: { flag: orphan[0] },
			});
		}
		return;
	}
	const conflict = request.listAttributes
		? "--list-attributes"
		: request.maxResultsBytes !== undefined
			? "--max-results"
			: undefined;
	if (conflict) {
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary: `\`--follow\` cannot be combined with \`${conflict}\`.`,
			remediation: `Run \`${conflict}\` as a one-shot read, then follow with \`--follow\` alone.`,
			context: { flag: conflict },
		});
	}
	if (
		request.count !== undefined &&
		(!Number.isInteger(request.count) || request.count < 1)
	) {
		throw new CentrsError({
			code: "settings/invalid-integer",
			summary: `\`--count\` must be a positive integer. Received: ${request.count}`,
			remediation:
				"Pass how many live changes to wait for, e.g. `--count 1` for the next change.",
			context: { flag: "--count", count: request.count },
		});
	}
}

function resolveFollowSettings(
	request: RetrieveRequest,
): RetrieveFollowSettings | undefined {
	if (!request.follow) return undefined;
	const durationMs =
		request.duration === undefined
			? undefined
			: parseDuration(String(request.duration));
	return {
		sweepMs:
			request.sweep === undefined
				? FOLLOW_SWEEP_DEFAULT_MS
				: parseDuration(String(request.sweep)),
		...(request.count !== undefined ? { count: request.count } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
	};
}

/** `--sweep` default (#396 slice decisions, 2026-10-08). */
export const FOLLOW_SWEEP_DEFAULT_MS = 10_000;

/**
 * Build a {@link ResolvedRetrieveRequest} from the static request plus an
 * already-resolved CDB record (or `undefined` for a literal target). Fanout
 * reuses this per group member after loading + decrypting the CDB once, so the
 * resolver settings ladder (env / cli / comment-kv) applies identically to a
 * single target and to every target in a group.
 */
export function buildResolvedRetrieve(
	request: RetrieveRequest,
	env: Record<string, string | undefined>,
	cdbResolution: CdbResolution | undefined,
	attributeSelections: readonly string[],
	macResolution?: { mac: string; ip: string },
	config: Record<string, string | undefined> = {},
	quickchrResolution?: QuickchrResolution,
): ResolvedRetrieveRequest {
	const via = resolveProtocol(request, env, cdbResolution, config);
	const format = resolveFormat(request, env, config);
	const validate = resolveBooleanSetting(
		request.validate,
		env,
		"CENTRS_VALIDATE",
		true,
		"validate",
		cdbResolution?.overrides.validate,
		config,
	);
	const timeoutMs = resolveTimeoutSetting(
		request.timeout,
		env,
		via.value,
		cdbResolution?.overrides.timeoutMs,
		config,
	);
	const maxResultsBytes = resolveOptionalIntegerSetting(
		request.maxResultsBytes,
		env,
		"CENTRS_MAX_RESULTS",
		"max-results",
		undefined,
		config,
	);
	// A quickchr member substitutes the live descriptor's per-`--via` endpoint
	// for the CDB/env target+auth path (`docs/CONSTITUTION.md` → Resolution
	// providers); everything else (via/format/validate/timeout) resolved above
	// stays on the normal ladder.
	const connection = quickchrResolution
		? quickchrConnection(quickchrResolution, via.value)
		: null;
	const target = connection
		? connection.target
		: resolveTarget(
				{
					targetInput: request.targetInput,
					host: request.host,
					port: request.port,
					macResolution,
				},
				env,
				via.value,
				cdbResolution,
			);
	const auth = connection
		? connection.auth
		: resolveAuth(
				{ username: request.username, password: request.password },
				env,
				cdbResolution,
			);

	return {
		path: request.path,
		via,
		target,
		auth,
		timeoutMs,
		format,
		validate,
		insecure:
			connection?.insecure === true && quickchrResolution
				? {
						value: true,
						source: {
							kind: "provider" as const,
							key: `quickchr:${quickchrResolution.name}`,
						},
					}
				: undefined,
		maxResultsBytes,
		attributes: attributeSelections,
		allAttributes: request.allAttributes ?? false,
		listAttributes: request.listAttributes ?? false,
		verbose: request.verbose ?? false,
		follow: resolveFollowSettings(request),
		warnings: connection
			? [...connection.warnings]
			: (cdbResolution?.warnings ?? []),
	};
}

export interface RetrieveGlobalContext {
	via: RouterOsProtocol;
	summary: RetrieveRequestSummary;
	settings: CommonSettingsMeta;
}

/**
 * Resolve the target-independent settings (protocol, format, validate, timeout,
 * max-results) used for a group fanout's outer `meta.operation.request` summary
 * and its transport-aware concurrency default. No CDB record is consulted; the
 * global `--via` (default `rest-api`) decides the summary and concurrency base.
 */
export function resolveRetrieveGlobalContext(
	request: RetrieveRequest,
	env: Record<string, string | undefined>,
	attributeSelections: readonly string[],
	config: Record<string, string | undefined> = {},
): RetrieveGlobalContext {
	const via = resolveProtocol(request, env, undefined, config);
	const format = resolveFormat(request, env, config);
	const validate = resolveBooleanSetting(
		request.validate,
		env,
		"CENTRS_VALIDATE",
		true,
		"validate",
		undefined,
		config,
	);
	const timeoutMs = resolveTimeoutSetting(
		request.timeout,
		env,
		via.value,
		undefined,
		config,
	);
	const maxResultsBytes = resolveOptionalIntegerSetting(
		request.maxResultsBytes,
		env,
		"CENTRS_MAX_RESULTS",
		"max-results",
		undefined,
		config,
	);

	return {
		via: via.value,
		summary: {
			path: request.path,
			attributes: attributeSelections,
			allAttributes: request.allAttributes ?? false,
			listAttributes: request.listAttributes ?? false,
			validate: validate.value,
			verbose: request.verbose ?? false,
			timeoutMs: timeoutMs.value,
			format: format.value,
			maxResultsBytes: maxResultsBytes?.value,
		},
		settings: {
			via: toCoreSource(via.source),
			timeoutMs: toCoreSource(timeoutMs.source),
			format: toCoreSource(format.source),
			validate: toCoreSource(validate.source),
			maxResultsBytes: maxResultsBytes
				? toCoreSource(maxResultsBytes.source)
				: undefined,
		},
	};
}

export async function resolveRetrieveRequest(
	request: RetrieveRequest,
	env: Record<string, string | undefined>,
): Promise<ResolvedRetrieveRequest> {
	const attributeSelections = validateRetrieveRequestShape(request);
	const config = await loadEnvFileDefaults(env);

	// A quickchr target bypasses CDB and MAC resolution entirely — the live
	// descriptor is the only connection-fact source for those fields.
	if (request.quickchr !== undefined) {
		assertNoQuickchrOverrideConflict(request, request.quickchr);
		const quickchrResolution = await resolveQuickchrTarget(request.quickchr);
		return buildResolvedRetrieve(
			request,
			env,
			undefined,
			attributeSelections,
			undefined,
			config,
			quickchrResolution,
		);
	}

	const cdbResolution = await resolveCdb(
		{
			targetInput: request.targetInput,
			cdbFile: request.cdbFile,
			cdbPassword: request.cdbPassword,
		},
		env,
		config,
	);

	const macResolution = await resolveMacForRetrieve(
		request,
		env,
		cdbResolution,
		config,
	);

	return buildResolvedRetrieve(
		request,
		env,
		cdbResolution,
		attributeSelections,
		macResolution,
		config,
	);
}

/**
 * Resolve a MAC target to an IP for IP-based transports, honoring the resolve
 * policy. Returns `undefined` for L2 transports (mac-telnet/romon) or when the
 * target is not a MAC. Shared by single-target and group-fanout paths so
 * `--resolve arp` works for CDB group members too.
 */
export async function resolveMacForRetrieve(
	request: RetrieveRequest,
	env: Record<string, string | undefined>,
	cdb?: CdbResolution,
	config: Record<string, string | undefined> = {},
): Promise<{ mac: string; ip: string } | undefined> {
	if (!isIpTransport(resolveProtocol(request, env, cdb, config).value)) {
		return undefined;
	}
	return resolveMacTarget({
		host: request.host,
		targetInput: request.targetInput,
		cdbTarget: cdb?.target,
		env,
		config,
		policy: parseResolvePolicy(
			request.resolve ?? env["CENTRS_RESOLVE"] ?? config["CENTRS_RESOLVE"],
		),
		operation: "retrieve",
	});
}

function resolveProtocol(
	request: RetrieveRequest,
	env: Record<string, string | undefined>,
	cdb?: CdbResolution,
	config: Record<string, string | undefined> = {},
): ResolvedSetting<RouterOsProtocol> {
	// A follow infers native-api when `via` is unset (REST cannot follow); a
	// `via` from any source still wins, and `retrieveFollow` rejects non-native.
	const via = resolveStringSetting(
		request.via,
		env,
		"CENTRS_VIA",
		request.follow ? "native-api" : "rest-api",
		"via",
		undefined,
		cdb?.overrides.via,
		config,
	);
	if (!via) {
		throw new CentrsError({
			code: "internal/unhandled",
			summary: "Failed to resolve the default retrieve protocol.",
			remediation:
				"Report this bug; retrieve should default to `rest-api` when no protocol is pinned.",
		});
	}

	if (
		![
			"rest-api",
			"native-api",
			"ssh",
			"snmp",
			"mndp",
			"mac-telnet",
			"romon",
			"winbox-terminal",
		].includes(via.value)
	) {
		throw new CentrsError({
			code: "settings/invalid-via",
			summary: `Unsupported protocol identifier: ${via.value}`,
			remediation:
				"Choose one of the known `via` values, such as `rest-api` for the current alpha retrieve loop.",
			context: { via: via.value },
		});
	}

	const plan = getProtocolPlan(via.value as RouterOsProtocol);
	if (!plan.capabilities.includes("retrieve")) {
		throw new CentrsError({
			code: "routeros/unsupported-capability",
			summary: `Protocol ${via.value} does not support the retrieve capability.`,
			remediation:
				"Choose a retrieve-capable protocol such as `rest-api`, `native-api`, or `snmp`.",
			context: { via: via.value, capability: "retrieve" },
		});
	}

	if (!plan.implemented) {
		throw new CentrsError({
			code: "routeros/protocol-not-implemented",
			summary: `Protocol ${via.value} is planned but not implemented yet.`,
			remediation:
				"Use `--via rest-api` for the current alpha retrieve implementation.",
			context: { via: via.value, capability: "retrieve" },
		});
	}

	return via as ResolvedSetting<RouterOsProtocol>;
}

function resolveFormat(
	request: RetrieveRequest,
	env: Record<string, string | undefined>,
	config: Record<string, string | undefined> = {},
): ResolvedSetting<RetrieveOutputFormat> {
	return resolveStringSetting(
		request.format,
		env,
		"CENTRS_FORMAT",
		"text",
		"format",
		parseOutputFormat,
		undefined,
		config,
	) as ResolvedSetting<RetrieveOutputFormat>;
}

/**
 * Resolve the read command (`print` vs `get`) for a path via a `request=child`
 * existence probe. Uses {@link inspectChildrenOrEmpty} so an invalid path (a
 * native trap, or REST's empty child list) flattens to no children and surfaces
 * as a single `validation/unknown-path` here rather than leaking a transport
 * trap. Attribute/completion discovery does NOT use the swallowing probe — traps
 * there surface as-is.
 */
export async function inspectRetrievePath(
	resolved: ResolvedRetrieveRequest,
	backend: ProtocolAdapter,
): Promise<RetrieveInspection> {
	const tokens = pathTokens(resolved.path);
	const rootChildren = await inspectChildrenOrEmpty(backend, tokens);

	const supportsPrint = rootChildren.some((child) =>
		isCommandNode(child, "print"),
	);
	const supportsGet = rootChildren.some((child) => isCommandNode(child, "get"));
	if (!supportsPrint && !supportsGet) {
		throw new CentrsError({
			code: "validation/unknown-path",
			summary: `RouterOS path ${resolved.path} does not expose a retrieve command.`,
			remediation:
				"Check the slash-prefixed RouterOS path, or use a known readable path such as `/system/resource`, `/system/identity`, `/ip/address`, or `/interface`.",
			context: {
				path: resolved.path,
				validationSource: "/console/inspect request=child",
				availableChildren: rootChildren
					.map((child) => child.name)
					.filter((name): name is string => typeof name === "string"),
			},
		});
	}

	// A singleton's `get` takes only `value-name`; a list menu's also takes
	// `number` (CHR 7.23.7: /tool/romon, /ip/dns, /system/identity vs
	// /ip/address). A hardcoded path list missed every other singleton and
	// validated its properties against `print`'s flags (issue #377).
	const singleton =
		supportsGet &&
		!(await inspectArgumentNames(backend, [...tokens, "get"])).includes(
			"number",
		);
	return {
		command: singleton ? "get" : "print",
		singleton,
	};
}

/**
 * Inspect the menu's attribute names and reject requested ones it lacks with
 * `validation/unknown-attribute`. Shared by one-shot retrieve and `--follow`.
 */
export async function assertKnownAttributes(
	resolved: ResolvedRetrieveRequest,
	inspection: RetrieveInspection,
	backend: ProtocolAdapter,
): Promise<string[]> {
	const availableAttributes = await inspectAttributes(
		resolved,
		inspection,
		backend,
	);
	const missing = resolved.attributes.filter(
		(attribute) => !availableAttributes.includes(attribute),
	);
	if (missing.length > 0) {
		throw new CentrsError({
			code: "validation/unknown-attribute",
			summary: `Unknown RouterOS attribute ${missing.join(", ")} for ${resolved.path}.`,
			remediation:
				"Check the attribute name, or use `--list-attributes` to inspect the available properties first.",
			context: {
				path: resolved.path,
				parameter: missing[0],
				requestedAttributes: resolved.attributes,
				availableAttributes,
			},
		});
	}
	return availableAttributes;
}

async function inspectAttributes(
	resolved: ResolvedRetrieveRequest,
	inspection: RetrieveInspection,
	backend: ProtocolAdapter,
): Promise<string[]> {
	const tokens = pathTokens(resolved.path);
	const argument = inspection.command === "get" ? "value-name" : "proplist";
	const completionRows = await inspectCompletions(backend, [
		...tokens,
		inspection.command,
		argument,
	]);
	const completions = [
		...new Set(extractCompletionNames(completionRows)),
	].sort();
	if (completions.length > 0) {
		return completions;
	}

	const commandChildren = await inspectChildren(backend, [
		...tokens,
		inspection.command,
	]);
	return commandChildren
		.filter(isArgumentNode)
		.map((child) => child.name)
		.filter(
			(name): name is string => typeof name === "string" && name.length > 0,
		)
		.sort();
}

async function executeRetrieve(
	resolved: ResolvedRetrieveRequest,
	backend: ProtocolAdapter,
	inspection: RetrieveInspection | undefined,
): Promise<unknown> {
	if (inspection?.singleton ?? isKnownSingletonPath(resolved.path)) {
		const data = await backend.getSingleton(resolved.path);
		if (resolved.attributes.length > 0) {
			return projectSingletonAttributes(data, resolved.attributes);
		}
		return data;
	}

	return backend.list(resolved.path, {
		proplist: resolved.attributes.length > 0 ? resolved.attributes : undefined,
		detail: resolved.allAttributes,
	});
}

/** Fallback for `--validate=false`, which skips the inspect that detects singletons. */
function isKnownSingletonPath(path: string): boolean {
	return ["/system/resource", "/system/identity"].includes(
		path.replace(/\/$/, ""),
	);
}

function projectSingletonAttributes(
	data: unknown,
	attributes: readonly string[],
): unknown {
	if (!isPlainObject(data)) {
		return data;
	}
	if (attributes.length === 1) {
		return data[attributes[0] ?? ""];
	}

	const projected: Record<string, unknown> = {};
	for (const attribute of attributes) {
		projected[attribute] = data[attribute];
	}
	return projected;
}

function resolveTimeoutSetting(
	timeout: RetrieveRequest["timeout"],
	env: Record<string, string | undefined>,
	via: RouterOsProtocol,
	commentKv?: ResolvedSetting<number>,
	config: Record<string, string | undefined> = {},
): ResolvedSetting<number> {
	const resolved = resolveStringSetting(
		timeout === undefined ? undefined : String(timeout),
		env,
		"CENTRS_TIMEOUT",
		"10000",
		"timeout",
		(value) => {
			const parsed = parseDuration(value);
			if (parsed <= 0) {
				throw new CentrsError({
					code: "settings/invalid-timeout",
					summary: `Timeout must be greater than zero. Received: ${value}`,
					remediation:
						"Use a positive integer in milliseconds or a suffix like `5s` / `500ms`.",
				});
			}
			return parsed;
		},
		commentKv,
		config,
	);
	if (!resolved) {
		throw new Error("timeout resolution produced no value");
	}

	if (via === "rest-api" && resolved.value > 60_000) {
		throw new CentrsError({
			code: "usage/timeout-out-of-range",
			summary: `REST timeout ${resolved.value}ms exceeds the current RouterOS REST ceiling.`,
			remediation:
				"Use `--timeout 60s` or less for the current REST retrieve path.",
			context: {
				via,
				timeoutMs: resolved.value,
				ceilingMs: 60_000,
			},
		});
	}

	return resolved;
}

function normalizeAttributeSelection(request: RetrieveRequest): string[] {
	const selections = [
		...normalizeAttributes(request.attribute),
		...normalizeAttributes(request.attributes),
	];
	return [...new Set(selections)];
}

function normalizeAttributes(
	input: string | readonly string[] | undefined,
): string[] {
	if (input === undefined) {
		return [];
	}

	if (Array.isArray(input)) {
		return input.flatMap((value) => normalizeAttributes(value));
	}

	return String(input)
		.split(",")
		.map((value: string) => value.trim())
		.filter((value: string) => value.length > 0);
}

function parseOutputFormat(value: string): RetrieveOutputFormat {
	if (retrieveOutputFormats.includes(value as RetrieveOutputFormat)) {
		return value as RetrieveOutputFormat;
	}

	throw new CentrsError({
		code: "settings/invalid-format",
		summary: `Unsupported output format: ${value}`,
		remediation: `Choose one of ${retrieveOutputFormats.join(", ")}.`,
	});
}

function countResultObjects(data: unknown): number {
	if (Array.isArray(data)) {
		return data.length;
	}
	if (data === null || data === undefined) {
		return 0;
	}
	return 1;
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

function formatCoreSource(source: CoreSettingSource | undefined): string {
	if (!source) {
		return "unset";
	}
	return source.key ? `${source.kind}:${source.key}` : source.kind;
}

function exhaustiveOutputFormat(value: never): never {
	throw new Error(`Unhandled retrieve output format: ${String(value)}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
