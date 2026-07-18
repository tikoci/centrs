/**
 * `centrs api` — a structured RouterOS API passthrough, modeled on `gh api`.
 *
 * The structured middle of the verb trichotomy (see `commands/api/README.md`):
 * one command per operation (no code blocks), structured input **and** output,
 * validated through `/console/inspect`, runnable over REST or the native API. The
 * orchestrator is transport-agnostic — it normalizes the endpoint, resolves the
 * method→verb map, runs the inspect gate and the write-confirmation gate, then
 * hands a normalized {@link ProtocolApiRequest} to the adapter. REST vs native
 * mechanics (id-in-URL vs `=.id=`, `.query` vs `?`-words) live in the adapter.
 *
 * Grounded RouterOS facts this depends on live in `commands/api/AGENTS.md`
 * (CHR 7.23.1). The `--listen` streaming path and multi-target fan-out are later
 * phases; this file is the single-target rest-api + native-api surface.
 */

import type {
	CentrsEnvelope,
	CentrsErrorEnvelope,
	CentrsSuccessEnvelope,
	CommonSettingsMeta,
	SettingSource as CoreSettingSource,
	EnvelopeValidationMeta,
	Tip,
	Warning,
} from "./core/envelope.ts";
import { buildTip } from "./core/envelope.ts";
import {
	extractCompletionNames,
	inspectChildren,
	inspectChildrenOrEmpty,
	inspectCompletions,
	isArgumentNode,
	isCommandNode,
	pathTokens,
} from "./core/inspect.ts";
import { CentrsError, serializeCentrsError } from "./errors.ts";
import { promptForWriteConfirmation } from "./execute.ts";
import {
	type ApiVerb,
	createProtocolAdapter,
	type ProtocolAdapter,
	type ProtocolApiRequest,
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
	quickchrConnection,
	type ResolvedAuth,
	type ResolvedSetting,
	type ResolvedTarget,
	resolveAuth,
	resolveBooleanSetting,
	resolveCdb,
	resolveMacTarget,
	resolveQuickchrTarget,
	resolveStringSetting,
	resolveTarget,
	toCoreSource,
} from "./resolver/index.ts";
import { toYaml } from "./retrieve.ts";

export const apiOutputFormats = ["json", "yaml", "text"] as const;
export type ApiOutputFormat = (typeof apiOutputFormats)[number];

/** HTTP methods `api` honors literally against RouterOS's REST verb map. */
export const apiMethods = ["GET", "PUT", "PATCH", "DELETE", "POST"] as const;
export type ApiMethod = (typeof apiMethods)[number];

export interface ApiRequest {
	targetInput?: string;
	/**
	 * quickchr machine name (`--quickchr <name>`): resolve host/port/auth from
	 * the live VM descriptor instead of CDB/env (`docs/CONSTITUTION.md` →
	 * Resolution providers). Conflicts with host/port/username/password.
	 */
	quickchr?: string;
	/** REST-style endpoint path, leniently normalized (`ip/address`, `/rest/ip/address`, `"ip address"`, `ip/address/*1`, `ip/address/listen`). */
	endpoint: string;
	/** HTTP method (`-X`), default `GET`, case-insensitive. */
	method?: string;
	/** `-f key=value` fields, merged into the JSON body (verbatim string values). */
	fields?: Record<string, string>;
	/** `-d` raw JSON body. Mutually exclusive with `fields` / `inputBody`. */
	data?: string;
	/** `--input` raw JSON body (file/stdin content already read). Mutually exclusive with `fields` / `data`. */
	inputBody?: string;
	/** `--query` / `--filter` expressions (`name=value`, `name!=value`, `name>value`, `name`). */
	query?: readonly string[];
	/** `--raw-query` verbatim RouterOS query words (no leading `?`). */
	rawQuery?: readonly string[];
	/** `--proplist` / `--attribute` property projection. */
	proplist?: readonly string[];
	/** `--raw`: bare RouterOS body passthrough; implies `--validate=false`. */
	raw?: boolean;
	/** `--listen`: native-api-only open-ended follow (later phase; rejected here). */
	listen?: boolean;
	/** `--duration`: bound a `--listen` stream (later phase). */
	duration?: string;
	/** `--count`: bound a `--listen` stream to N frames (later phase). */
	count?: number;
	via?: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	insecure?: boolean;
	timeout?: string | number;
	format?: string;
	validate?: boolean;
	yes?: boolean;
	verbose?: boolean;
	cdbFile?: string;
	cdbPassword?: string;
	/** Opt-in host ARP resolution for a MAC target (`none` default, or `arp`). */
	resolve?: string;
	stdinIsTty?: boolean;
	confirm?: (prompt: string) => Promise<boolean>;
}

export interface NormalizedApiEndpoint {
	/** Canonical slash path with the leading `/rest` and any trailing id/`listen` removed. */
	path: string;
	/** Trailing `*id` segment, when the endpoint addressed one row. */
	id?: string;
	/** True when the endpoint's terminal segment was `listen` (infers `--listen`). */
	listen: boolean;
}

export interface ApiRequestSummary {
	endpoint: string;
	path: string;
	id?: string;
	/** The method reported back: a valid {@link ApiMethod}, or the raw string when an invalid `-X` could not be parsed (error path). */
	method: ApiMethod | string;
	/** `null` when the method was invalid and no verb could be mapped (error path). */
	verb: ApiVerb | null;
	write: boolean;
	listen: boolean;
	yes: boolean;
	validate: boolean;
	raw: boolean;
	format: ApiOutputFormat;
	query?: readonly string[];
	proplist?: readonly string[];
}

/** Why a `--stream` follow ended. */
export type ApiStreamStopReason =
	| "count-reached"
	| "duration-elapsed"
	| "interrupted"
	| "transport-error";

/** Per-line marker on `--stream` NDJSON output: a change frame, or the terminating summary. */
export type ApiStreamMeta =
	| { kind: "frame"; index: number }
	| {
			kind: "summary";
			stopReason: ApiStreamStopReason;
			frames: number;
			durationMs: number;
	  };

/** The `data` payload of the terminating summary envelope on a `--stream`. */
export interface ApiStreamSummary {
	stopReason: ApiStreamStopReason;
	frames: number;
	durationMs: number;
}

export interface ApiOperationMeta {
	kind: "api";
	objectCount: number;
	request: ApiRequestSummary;
	auth: {
		username?: string;
		passwordProvided: boolean;
	};
	/** Present only on `--stream` output: the per-frame index or the final summary. */
	stream?: ApiStreamMeta;
}

export type ApiEnvelope = CentrsEnvelope<unknown, ApiOperationMeta>;
export type ApiSuccessEnvelope = CentrsSuccessEnvelope<
	unknown,
	ApiOperationMeta
>;
export type ApiErrorEnvelope = CentrsErrorEnvelope<ApiOperationMeta>;

export interface ResolvedApiRequest {
	endpoint: string;
	path: string;
	id?: string;
	method: ApiMethod;
	verb: ApiVerb;
	/** A `/execute` script-run (CLI string, not a path) — inspect gate is not-applicable. */
	scriptMode: boolean;
	listen: boolean;
	/** Resolved JSON body (from `-f` / `-d` / `--input`). */
	body: Record<string, string>;
	/** REST `.query` words (no `?` prefix), structured then raw, in order. */
	query: readonly string[];
	proplist: readonly string[];
	raw: boolean;
	/** `--count`: stop a `--stream` after N frames. */
	count?: number;
	/** `--duration` parsed to ms: stop a `--stream` after this wall-clock window. */
	durationMs?: number;
	via: ResolvedSetting<RouterOsProtocol>;
	target: ResolvedTarget;
	auth: ResolvedAuth;
	timeoutMs: ResolvedSetting<number>;
	format: ResolvedSetting<ApiOutputFormat>;
	validate: ResolvedSetting<boolean>;
	insecure: ResolvedSetting<boolean>;
	yes: boolean;
	verbose: boolean;
	warnings: readonly Warning[];
}

export async function api(
	request: ApiRequest,
	env: Record<string, string | undefined> = Bun.env,
): Promise<ApiSuccessEnvelope> {
	const envelope = await apiEnvelope(request, env);
	if (!envelope.ok) {
		throw new CentrsError({
			code: envelope.error.code,
			summary: envelope.error.summary,
			remediation: envelope.error.remediation,
			context: envelope.error.context,
			causeData: envelope.error.cause,
		});
	}
	return envelope;
}

export async function apiEnvelope(
	request: ApiRequest,
	env: Record<string, string | undefined> = Bun.env,
): Promise<ApiEnvelope> {
	let resolved: ResolvedApiRequest | undefined;
	try {
		resolved = await resolveApiRequest(request, env);
		await assertApiWriteConfirmed(request, resolved);
		return await runResolvedApi(resolved);
	} catch (error) {
		return resolved
			? buildApiErrorEnvelopeFromResolved(resolved, error)
			: buildApiErrorEnvelope(request, error, env);
	}
}

export async function runResolvedApi(
	resolved: ResolvedApiRequest,
): Promise<ApiSuccessEnvelope> {
	assertListenCapability(resolved);
	const backend = createProtocolAdapter({
		protocol: resolved.via.value,
		host: resolved.target.host,
		port: resolved.target.port,
		tls: resolved.target.tls,
		baseUrl: resolved.target.baseUrl,
		username: resolved.auth.username,
		password: resolved.auth.password,
		timeoutMs: resolved.timeoutMs.value,
		mac: resolved.target.mac,
		insecure: resolved.insecure.value,
	});

	let validation: EnvelopeValidationMeta;
	let tips: Tip[] = [];
	try {
		if (resolved.validate.value) {
			const result = await validateApiRequest(resolved, backend);
			validation = result.validation;
			tips = result.tips;
		} else {
			validation = {
				enabled: false,
				source: "disabled",
				result: "skipped",
				syntax: false,
				semantic: false,
			};
		}

		const result = await backend.apiRequest(buildProtocolApiRequest(resolved));
		return {
			ok: true,
			data: result.data,
			warnings: [...resolved.warnings],
			tips,
			meta: metaFromResolved(resolved, validation, result.data),
		};
	} finally {
		await backend.close();
	}
}

/**
 * The open-ended `--stream` follow path: an async generator yielding one
 * {@link ApiEnvelope} per `/listen` change frame, then a terminating summary
 * envelope (`data` = {@link ApiStreamSummary}). Open-ended follow is native-api
 * only — a `rest-api` (or otherwise unresolved) transport yields a single error
 * envelope. `--count`/`--duration` and `externalSignal` (Ctrl-C) bound it.
 * Errors before the first frame (resolution, validation, confirmation,
 * capability) yield one error envelope and stop — the CLI keys its exit code on
 * that first envelope. `onListening` fires once the follow is established on the
 * wire (a real barrier for callers that must act only after that point).
 */
export async function* apiListen(
	request: ApiRequest,
	env: Record<string, string | undefined> = Bun.env,
	externalSignal?: AbortSignal,
	onListening?: () => void,
): AsyncGenerator<ApiEnvelope, void, void> {
	// `apiListen` is inherently the streaming surface, so force `listen` on the
	// request: otherwise a caller that omits it (and the `/listen` endpoint form)
	// would resolve `via` to the rest-api default and be rejected. An explicit
	// `--via rest-api` still surfaces capability-unsupported below.
	const streamRequest: ApiRequest = { ...request, listen: true };
	let resolved: ResolvedApiRequest | undefined;
	try {
		resolved = await resolveApiRequest(streamRequest, env);
		await assertApiWriteConfirmed(streamRequest, resolved);
		if (resolved.via.value !== "native-api") {
			throw new CentrsError({
				code: "transport/capability-unsupported",
				summary: "REST cannot follow an open-ended `--stream` (60s cap).",
				remediation:
					"Open-ended follow is native-api only: use `--via native-api`, or drop `--stream` for a bounded one-shot.",
				context: { via: resolved.via.value, capability: "listen" },
			});
		}
	} catch (error) {
		yield resolved
			? buildApiErrorEnvelopeFromResolved(resolved, error)
			: buildApiErrorEnvelope(streamRequest, error, env);
		return;
	}
	yield* streamResolvedApi(resolved, externalSignal, onListening);
}

async function* streamResolvedApi(
	resolved: ResolvedApiRequest,
	externalSignal?: AbortSignal,
	onListening?: () => void,
): AsyncGenerator<ApiEnvelope, void, void> {
	const backend = adapterForResolved(resolved);

	let validation: EnvelopeValidationMeta;
	try {
		validation = resolved.validate.value
			? (await validateApiRequest(resolved, backend)).validation
			: disabledValidationMeta();
	} catch (error) {
		await backend.close();
		yield buildApiErrorEnvelopeFromResolved(resolved, error);
		return;
	}

	const controller = new AbortController();
	const startedAt = Date.now();
	let frames = 0;
	let stopReason: ApiStreamStopReason | undefined;
	let durationTimer: ReturnType<typeof setTimeout> | undefined;
	const onExternalAbort = (): void => {
		stopReason ??= "interrupted";
		controller.abort();
	};
	if (resolved.durationMs !== undefined) {
		durationTimer = setTimeout(() => {
			stopReason = "duration-elapsed";
			controller.abort();
		}, resolved.durationMs);
	}
	if (externalSignal) {
		if (externalSignal.aborted) {
			onExternalAbort();
		} else {
			externalSignal.addEventListener("abort", onExternalAbort, { once: true });
		}
	}

	try {
		const protocolRequest = buildProtocolApiRequest(resolved);
		for await (const record of backend.listen(protocolRequest, {
			signal: controller.signal,
			onListening,
		})) {
			frames += 1;
			yield streamFrameEnvelope(resolved, validation, record, frames);
			if (resolved.count !== undefined && frames >= resolved.count) {
				stopReason = "count-reached";
				break;
			}
		}
		yield streamSummaryEnvelope(
			resolved,
			validation,
			stopReason ?? "interrupted",
			frames,
			Date.now() - startedAt,
		);
	} catch (error) {
		// A mid-stream failure is itself a frame, tagged `stream.kind="frame"` so
		// consumers that key off `meta.operation.stream` still see it in the stream
		// (not as a stray non-stream envelope); the summary then closes with
		// `transport-error` (the CLI's exit code keys on whether it *started*
		// cleanly).
		yield streamErrorFrameEnvelope(resolved, error, frames + 1);
		yield streamSummaryEnvelope(
			resolved,
			validation,
			"transport-error",
			frames,
			Date.now() - startedAt,
		);
	} finally {
		if (durationTimer !== undefined) {
			clearTimeout(durationTimer);
		}
		externalSignal?.removeEventListener("abort", onExternalAbort);
		await backend.close();
	}
}

function streamFrameEnvelope(
	resolved: ResolvedApiRequest,
	validation: EnvelopeValidationMeta,
	record: Record<string, unknown>,
	index: number,
): ApiSuccessEnvelope {
	const meta = metaFromResolved(resolved, validation, record);
	meta.operation.stream = { kind: "frame", index };
	return { ok: true, data: record, warnings: [], tips: [], meta };
}

/**
 * A mid-stream failure rendered as a stream frame: the error envelope carries
 * `meta.operation.stream.kind="frame"` (index after the last good frame) so
 * stream consumers can place it on the timeline rather than mistaking it for a
 * non-stream envelope.
 */
function streamErrorFrameEnvelope(
	resolved: ResolvedApiRequest,
	error: unknown,
	index: number,
): ApiErrorEnvelope {
	const envelope = buildApiErrorEnvelopeFromResolved(resolved, error);
	if (envelope.meta.operation) {
		envelope.meta.operation.stream = { kind: "frame", index };
	}
	return envelope;
}

function streamSummaryEnvelope(
	resolved: ResolvedApiRequest,
	validation: EnvelopeValidationMeta,
	stopReason: ApiStreamStopReason,
	frames: number,
	durationMs: number,
): ApiSuccessEnvelope {
	const summary: ApiStreamSummary = { stopReason, frames, durationMs };
	const meta = metaFromResolved(resolved, validation, summary);
	meta.operation.objectCount = frames;
	meta.operation.stream = { kind: "summary", stopReason, frames, durationMs };
	return {
		ok: true,
		data: summary,
		warnings: [...resolved.warnings],
		tips: [],
		meta,
	};
}

function adapterForResolved(resolved: ResolvedApiRequest): ProtocolAdapter {
	return createProtocolAdapter({
		protocol: resolved.via.value,
		host: resolved.target.host,
		port: resolved.target.port,
		tls: resolved.target.tls,
		baseUrl: resolved.target.baseUrl,
		username: resolved.auth.username,
		password: resolved.auth.password,
		timeoutMs: resolved.timeoutMs.value,
		mac: resolved.target.mac,
		insecure: resolved.insecure.value,
	});
}

function disabledValidationMeta(): EnvelopeValidationMeta {
	return {
		enabled: false,
		source: "disabled",
		result: "skipped",
		syntax: false,
		semantic: false,
	};
}

export async function resolveApiRequest(
	request: ApiRequest,
	env: Record<string, string | undefined>,
	override?: {
		/**
		 * A pre-resolved CDB record, supplied by fan-out so the CDB is loaded ONCE
		 * (not per member) and a `--default`/literal member is never re-resolved
		 * through `resolveCdb`'s `__default__` synthetic-target fallback.
		 */
		cdbResolution?: CdbResolution;
		/** A pre-loaded `centrs.env` config tier, supplied by fan-out so the file
		 * is read ONCE (not per member). */
		config?: Record<string, string | undefined>;
	},
): Promise<ResolvedApiRequest> {
	validateApiRequestShape(request);
	const config = override?.config ?? (await loadEnvFileDefaults(env));
	const normalized = normalizeApiEndpoint(request.endpoint);
	const method = parseApiMethod(request.method);
	const verb = mapMethodToVerb(method);
	const listen = (request.listen ?? false) || normalized.listen;
	// `/execute` (root, single token) run via POST is the script surface — a CLI
	// string, not a menu path. A GET, a nested path, or any other menu that merely
	// ends in `execute` stays a normal path request validated through inspect.
	const tokens = pathTokens(normalized.path);
	const scriptMode =
		method === "POST" && tokens.length === 1 && tokens[0] === "execute";
	// PATCH/DELETE (set/remove) address one row; without an id the REST URL would
	// carry a `/undefined` segment and native would send an empty `=.id=`. Reject
	// it here with an actionable error instead of issuing a malformed request.
	if ((verb === "set" || verb === "remove") && normalized.id === undefined) {
		throw new CentrsError({
			code: "input/invalid-path",
			summary: `A ${method} request must address one row by id (e.g. ${normalized.path}/*1).`,
			remediation:
				"Append the row's `.id` to the endpoint, such as `ip/address/*1`; find ids with a GET of the collection.",
			context: { method, path: normalized.path },
		});
	}
	const raw = request.raw ?? false;
	const body = buildApiBody(request);
	const query = buildApiQuery(request);
	const proplist = buildApiProplist(request);

	// A quickchr target is a named-live-provider: host/port/auth come from the
	// live descriptor, bypassing CDB, `__default__`, and MAC resolution.
	let quickchrResolution: Awaited<
		ReturnType<typeof resolveQuickchrTarget>
	> | null = null;
	if (request.quickchr !== undefined) {
		assertNoQuickchrOverrideConflict(request, request.quickchr);
		quickchrResolution = await resolveQuickchrTarget(request.quickchr);
	}
	const cdbResolution = quickchrResolution
		? undefined
		: (override?.cdbResolution ??
			(await resolveCdb(
				{
					targetInput: request.targetInput,
					cdbFile: request.cdbFile,
					cdbPassword: request.cdbPassword,
				},
				env,
				config,
			)));
	const via = resolveApiProtocol(request, env, listen, cdbResolution, config);
	const format = resolveApiFormat(request, env, config);
	// `--raw` forces validation off (constitution: --raw waiver); otherwise the
	// inspect gate is on by default.
	const validate: ResolvedSetting<boolean> = raw
		? { value: false, source: { kind: "cli", key: "--raw" } }
		: resolveBooleanSetting(
				request.validate,
				env,
				"CENTRS_VALIDATE",
				true,
				"validate",
				cdbResolution?.overrides.validate,
				config,
			);
	const timeoutMs = resolveApiTimeout(
		request.timeout,
		env,
		via.value,
		cdbResolution?.overrides.timeoutMs,
		config,
	);
	const macResolution =
		quickchrResolution === null && isIpTransport(via.value)
			? await resolveMacTarget({
					host: request.host,
					targetInput: request.targetInput,
					cdbTarget: cdbResolution?.target,
					env,
					config,
					policy: parseResolvePolicy(
						request.resolve ??
							env["CENTRS_RESOLVE"] ??
							config["CENTRS_RESOLVE"],
					),
					// api has no Layer-2 transport (rest-api/native-api only), so MAC
					// remediation matches retrieve's (no mac-telnet suggestion).
					operation: "retrieve",
				})
			: undefined;
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
				config,
			);
	const auth = connection
		? connection.auth
		: resolveAuth(
				{ username: request.username, password: request.password },
				env,
				cdbResolution,
				config,
			);
	// A quickchr TLS endpoint is trusted by provenance (self-signed VM cert) —
	// `insecure` is forced with provider provenance and the provider-trust
	// warning rides the envelope (see QuickchrConnection.insecure).
	const insecure =
		connection?.insecure === true
			? {
					value: true,
					source: {
						kind: "provider" as const,
						key: `quickchr:${request.quickchr}`,
					},
				}
			: resolveBooleanSetting(
					request.insecure,
					env,
					"CENTRS_INSECURE",
					false,
					"insecure",
					cdbResolution?.overrides.insecure,
					config,
				);

	return {
		endpoint: request.endpoint,
		path: normalized.path,
		id: normalized.id,
		method,
		verb,
		scriptMode,
		listen,
		body,
		query,
		proplist,
		raw,
		count: request.count,
		durationMs:
			request.duration !== undefined
				? parseDuration(request.duration)
				: undefined,
		via,
		target,
		auth,
		timeoutMs,
		format,
		validate,
		insecure,
		yes: request.yes ?? false,
		verbose: request.verbose ?? false,
		warnings: connection
			? [...connection.warnings]
			: (cdbResolution?.warnings ?? []),
	};
}

/**
 * Leniently canonicalize an endpoint. Drops a leading `/rest`, splits on slashes
 * **and** whitespace (so `"ip address"` works), strips a trailing `*id` and a
 * trailing `listen` segment. See `commands/api/README.md`.
 */
export function normalizeApiEndpoint(endpoint: string): NormalizedApiEndpoint {
	const segments = endpoint
		.trim()
		.split(/[/\s]+/)
		.filter(Boolean);
	if (segments[0]?.toLowerCase() === "rest") {
		segments.shift();
	}
	let listen = false;
	if (segments.at(-1)?.toLowerCase() === "listen") {
		listen = true;
		segments.pop();
	}
	let id: string | undefined;
	const last = segments.at(-1);
	if (last !== undefined && /^\*[0-9A-F]+$/i.test(last)) {
		id = last;
		segments.pop();
	}
	return { path: `/${segments.join("/")}`, id, listen };
}

/** The gh-api `-X` map. `print` covers list / get-singleton / get-one (by id). */
export function mapMethodToVerb(method: ApiMethod): ApiVerb {
	switch (method) {
		case "GET":
			return "print";
		case "PUT":
			return "add";
		case "PATCH":
			return "set";
		case "DELETE":
			return "remove";
		case "POST":
			return "run";
		default:
			return exhaustiveMethod(method);
	}
}

/**
 * Read-only **iff** the method is `GET`, or the terminal path verb is
 * `print`/`get`/`listen`. Everything else is a write needing confirmation. Keyed
 * on the verb/method, not the wire HTTP method — a `POST …/print` paged read does
 * not prompt; `--listen` never relaxes the gate (a streaming-but-mutating
 * `/system/license/renew` still confirms). See `commands/api/README.md`.
 */
export function isApiMutating(method: ApiMethod, path: string): boolean {
	if (method === "GET") {
		return false;
	}
	const terminal = pathTokens(path).at(-1);
	if (terminal === "print" || terminal === "get" || terminal === "listen") {
		return false;
	}
	return true;
}

/** Merge `-f` / `-d` / `--input` into one JSON body; reject combining them. */
export function buildApiBody(request: ApiRequest): Record<string, string> {
	const hasFields =
		request.fields !== undefined && Object.keys(request.fields).length > 0;
	const hasData = request.data !== undefined;
	const hasInput = request.inputBody !== undefined;
	const sources = [hasFields, hasData, hasInput].filter(Boolean).length;
	if (sources > 1) {
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary:
				"`api` accepts only one body source: `-f` fields, `-d <json>`, or `--input`.",
			remediation:
				"Pass body fields with repeated `-f key=value`, or one raw JSON body via `-d` or `--input` — not a mix.",
		});
	}
	if (hasData) {
		return parseJsonBody(request.data ?? "", "-d");
	}
	if (hasInput) {
		return parseJsonBody(request.inputBody ?? "", "--input");
	}
	return { ...(request.fields ?? {}) };
}

function parseJsonBody(raw: string, flag: string): Record<string, string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary: `The ${flag} body is not valid JSON.`,
			remediation:
				'Pass a JSON object such as `{"address":"198.51.100.1/32"}`.',
			cause: error,
		});
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary: `The ${flag} body must be a JSON object.`,
			remediation: "Wrap the fields in a single `{ ... }` object.",
		});
	}
	const body: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		body[key] = typeof value === "string" ? value : JSON.stringify(value);
	}
	return body;
}

/**
 * Build REST `.query` words (no `?` prefix). Structured `--query` words first, in
 * order, then verbatim `--raw-query` words. Mapping is CHR-grounded
 * (`commands/api/AGENTS.md`): `name=value` (eq), `name!=value` → `name=value`,
 * `#!` (eq then NOT-top), `name>value`/`name<value` → `>name=value`/`<name=value`,
 * bare `name` (has-property).
 */
export function buildApiQuery(request: ApiRequest): string[] {
	const words: string[] = [];
	for (const expression of request.query ?? []) {
		words.push(...queryExpressionToWords(expression));
	}
	for (const raw of request.rawQuery ?? []) {
		words.push(raw);
	}
	return words;
}

function queryExpressionToWords(expression: string): string[] {
	const ne = expression.indexOf("!=");
	if (ne >= 0) {
		return [`${expression.slice(0, ne)}=${expression.slice(ne + 2)}`, "#!"];
	}
	const gt = expression.indexOf(">");
	if (gt >= 0) {
		return [`>${expression.slice(0, gt)}=${expression.slice(gt + 1)}`];
	}
	const lt = expression.indexOf("<");
	if (lt >= 0) {
		return [`<${expression.slice(0, lt)}=${expression.slice(lt + 1)}`];
	}
	// `name=value` (eq) or bare `name` (has-property) pass through verbatim.
	return [expression];
}

function buildApiProplist(request: ApiRequest): string[] {
	const props: string[] = [];
	for (const entry of request.proplist ?? []) {
		for (const part of entry.split(",")) {
			const trimmed = part.trim();
			if (trimmed.length > 0) {
				props.push(trimmed);
			}
		}
	}
	return props;
}

export function buildProtocolApiRequest(
	resolved: ResolvedApiRequest,
): ProtocolApiRequest {
	const request: ProtocolApiRequest = {
		verb: resolved.verb,
		path: resolved.path,
	};
	if (resolved.id) {
		request.id = resolved.id;
	}
	if (resolved.scriptMode) {
		const { script, ...extra } = resolved.body;
		if (typeof script !== "string" || script.trim().length === 0) {
			throw new CentrsError({
				code: "input/invalid-command",
				summary: "`/execute` requires a non-empty `script` field.",
				remediation:
					"Pass the script with `-f script='...'`, `-d '{\"script\":\"...\"}'`, or `--input`.",
			});
		}
		if (Object.keys(extra).length > 0) {
			throw new CentrsError({
				code: "usage/conflicting-flags",
				summary: "`/execute` accepts only the `script` body field.",
				remediation:
					"Remove the extra fields, or target a concrete RouterOS command path instead of `/execute`.",
				context: { extraFields: Object.keys(extra) },
			});
		}
		request.script = script;
		return request;
	}
	if (
		resolved.verb === "add" ||
		resolved.verb === "set" ||
		resolved.verb === "run"
	) {
		if (Object.keys(resolved.body).length > 0) {
			request.attributes = resolved.body;
		}
	}
	if (resolved.verb === "print") {
		if (resolved.query.length > 0) {
			request.query = resolved.query;
		}
		if (resolved.proplist.length > 0) {
			request.proplist = resolved.proplist;
		}
	}
	return request;
}

interface ApiValidationResult {
	validation: EnvelopeValidationMeta;
	tips: Tip[];
}

/**
 * The structured-input gate. Because the input is a path (not a CLI string) the
 * validator is `/console/inspect`, never `:put [:parse]`. Path existence via
 * `request=child`; add/set attribute validity via `request=child`+`completion`. A
 * `/execute` script is a CLI string → `semantic: not-applicable`.
 */
async function validateApiRequest(
	resolved: ResolvedApiRequest,
	backend: ProtocolAdapter,
): Promise<ApiValidationResult> {
	if (resolved.scriptMode) {
		return {
			validation: {
				enabled: true,
				source: "/console/inspect (script, not-applicable)",
				result: "passed",
				syntax: false,
				semantic: "not-applicable",
			},
			tips: [],
		};
	}

	const tokens = pathTokens(resolved.path);
	const tips: Tip[] = [];

	if (resolved.verb === "run") {
		// The path already carries the command verb (`/interface/monitor-traffic`);
		// verify it exists as a child of its parent menu.
		const parent = tokens.slice(0, -1);
		const terminal = tokens.at(-1) ?? "";
		const parentChildren = await inspectChildrenOrEmpty(backend, parent);
		if (!parentChildren.some((child) => child.name === terminal)) {
			throw unknownPathError(resolved);
		}
		const isCommand = parentChildren.some((child) =>
			isCommandNode(child, terminal),
		);
		// A bare-collection POST carrying fields (terminal is a menu, not a command)
		// likely meant PUT (RouterOS create). Advise, never rewrite the method.
		if (
			resolved.method === "POST" &&
			!isCommand &&
			resolved.id === undefined &&
			Object.keys(resolved.body).length > 0
		) {
			tips.push(
				buildTip(
					"tip/rest-verb-mapping",
					`POST ${resolved.path} carries fields but its terminal segment is a menu, not a command.`,
					"RouterOS creates with PUT (`-X PUT`), not POST. Use PUT to add a row; centrs never rewrites your method.",
				),
			);
		}
		// When the terminal is a real command carrying arguments, validate them the
		// same way add/set do — so a mistyped command argument is caught preflight.
		// Only reject when inspect actually surfaced the command's arguments; if it
		// returns none, skip rather than false-reject a valid command.
		if (isCommand && Object.keys(resolved.body).length > 0) {
			const available = await inspectApiAttributes(backend, tokens);
			if (available.length > 0) {
				const requested = Object.keys(resolved.body);
				const missing = requested.filter(
					(attribute) => attribute !== ".id" && !available.includes(attribute),
				);
				if (missing.length > 0) {
					throw new CentrsError({
						code: "validation/unknown-attribute",
						summary: `Unknown RouterOS argument ${missing.join(", ")} for ${resolved.path}.`,
						remediation:
							"Check the command arguments against `/console/inspect`, or use `--validate=false` only when intentionally probing an undocumented RouterOS edge.",
						context: {
							path: resolved.path,
							verb: resolved.verb,
							attribute: missing[0],
							requestedAttributes: requested,
							availableAttributes: available,
							validationSource: "/console/inspect request=child+completion",
						},
					});
				}
			}
		}
		return {
			validation: {
				enabled: true,
				source: "/console/inspect request=child",
				result: "passed",
				syntax: false,
				semantic: true,
			},
			tips,
		};
	}

	// print / add / set / remove: the path is the menu itself.
	const children = await inspectChildrenOrEmpty(backend, tokens);
	if (children.length === 0) {
		throw unknownPathError(resolved);
	}

	if (resolved.verb === "add" || resolved.verb === "set") {
		const available = await inspectApiAttributes(backend, [
			...tokens,
			resolved.verb,
		]);
		const requested = Object.keys(resolved.body);
		const missing = requested.filter(
			(attribute) => attribute !== ".id" && !available.includes(attribute),
		);
		if (missing.length > 0) {
			throw new CentrsError({
				code: "validation/unknown-attribute",
				summary: `Unknown RouterOS attribute ${missing.join(", ")} for ${resolved.path}/${resolved.verb}.`,
				remediation:
					"Check the attribute name against `/console/inspect`, or use `--validate=false` only when intentionally probing an undocumented RouterOS edge.",
				context: {
					path: resolved.path,
					verb: resolved.verb,
					attribute: missing[0],
					requestedAttributes: requested,
					availableAttributes: available,
					validationSource: "/console/inspect request=child+completion",
				},
			});
		}
		return {
			validation: {
				enabled: true,
				source: "/console/inspect request=child+completion",
				result: "passed",
				syntax: false,
				semantic: true,
				availableAttributes: available,
			},
			tips,
		};
	}

	return {
		validation: {
			enabled: true,
			source: "/console/inspect request=child",
			result: "passed",
			syntax: false,
			semantic: true,
		},
		tips,
	};
}

function unknownPathError(resolved: ResolvedApiRequest): CentrsError {
	return new CentrsError({
		code: "validation/unknown-path",
		summary: `RouterOS has no menu at ${resolved.path}.`,
		remediation:
			"Check the endpoint path against `/console/inspect`, or use `--validate=false` to bypass the preflight (RouterOS still validates the request).",
		context: {
			path: resolved.path,
			endpoint: resolved.endpoint,
			validationSource: "/console/inspect request=child",
		},
	});
}

async function inspectApiAttributes(
	backend: ProtocolAdapter,
	commandTokens: readonly string[],
): Promise<string[]> {
	const children = await inspectChildren(backend, commandTokens);
	const childAttributes = children
		.filter(isArgumentNode)
		.map((child) => child.name)
		.filter(
			(name): name is string => typeof name === "string" && name.length > 0,
		);
	const completionRows = await inspectCompletions(backend, commandTokens);
	return [
		...new Set([...childAttributes, ...extractCompletionNames(completionRows)]),
	].sort();
}

async function assertApiWriteConfirmed(
	request: ApiRequest,
	resolved: ResolvedApiRequest,
): Promise<void> {
	if (!isApiMutating(resolved.method, resolved.path) || resolved.yes) {
		return;
	}
	if (request.stdinIsTty ?? process.stdin.isTTY) {
		const confirmed = await (request.confirm ?? promptForWriteConfirmation)(
			`Run mutating ${resolved.method} ${resolved.path} over ${resolved.via.value}? Type yes to continue: `,
		);
		if (confirmed) {
			return;
		}
	}
	throw new CentrsError({
		code: "usage/confirmation-required",
		summary: `A mutating ${resolved.method} ${resolved.path} request requires explicit confirmation.`,
		remediation:
			"Pass `--yes` in non-interactive automation, or answer `yes` at the TTY prompt after reviewing the request.",
		context: {
			endpoint: resolved.endpoint,
			path: resolved.path,
			method: resolved.method,
			via: resolved.via.value,
		},
	});
}

function assertListenCapability(resolved: ResolvedApiRequest): void {
	if (!resolved.listen) {
		return;
	}
	if (resolved.via.value === "rest-api") {
		throw new CentrsError({
			code: "transport/capability-unsupported",
			summary: "REST cannot follow an open-ended `--stream` (60s cap).",
			remediation:
				"Open-ended follow is native-api only: use `--via native-api`, or drop `--stream` for a bounded one-shot.",
			context: { via: resolved.via.value, capability: "listen" },
		});
	}
	throw new CentrsError({
		code: "input/invalid-command",
		summary: "`--stream` is an open-ended follow, not a one-shot `api` call.",
		remediation:
			"Consume the stream via `apiListen()` (library) or `centrs api … --stream` (CLI); both yield an NDJSON envelope per change frame plus a final summary.",
		context: { via: resolved.via.value, capability: "listen" },
	});
}

function resolveApiProtocol(
	request: ApiRequest,
	env: Record<string, string | undefined>,
	listen: boolean,
	cdb?: CdbResolution,
	config: Record<string, string | undefined> = {},
): ResolvedSetting<RouterOsProtocol> {
	// A `/listen` endpoint (or `--listen`) infers native-api when `--via` is unset;
	// REST stays the default for one-shot calls.
	const defaultVia: RouterOsProtocol = listen ? "native-api" : "rest-api";
	const via = resolveStringSetting(
		request.via,
		env,
		"CENTRS_VIA",
		defaultVia,
		"via",
		undefined,
		cdb?.overrides.via,
		config,
	);
	if (!via) {
		throw new CentrsError({
			code: "internal/unhandled",
			summary: "Failed to resolve the api protocol.",
			remediation: "Report this bug; api should default to rest-api.",
		});
	}
	assertApiProtocolSupported(via.value);
	return via as ResolvedSetting<RouterOsProtocol>;
}

/**
 * Reject a protocol identifier `api` cannot run over. Throws `settings/invalid-via`
 * for an unknown protocol and `routeros/protocol-not-implemented` for a known
 * transport (e.g. ssh / mac-telnet) that `api` does not support. Shared so a
 * globally-pinned `--via` / `CENTRS_VIA` can be rejected as an orchestration
 * pre-flight error in fan-out (`api-fanout.ts`) rather than degrading into N
 * identical per-target resolve failures.
 */
export function assertApiProtocolSupported(via: string): void {
	if (!plannedProtocols.includes(via as RouterOsProtocol)) {
		throw new CentrsError({
			code: "settings/invalid-via",
			summary: `Unsupported protocol identifier: ${via}`,
			remediation: "`api` runs over `rest-api` (default) or `native-api`.",
			context: { via },
		});
	}
	if (via !== "rest-api" && via !== "native-api") {
		throw new CentrsError({
			code: "routeros/protocol-not-implemented",
			summary: `api over ${via} is not supported.`,
			remediation:
				"Use `--via rest-api` (default) or `--via native-api`. Console transports (ssh/mac-telnet) run through `execute`/`terminal`.",
			context: { via, capability: "execute" },
		});
	}
}

function resolveApiFormat(
	request: ApiRequest,
	env: Record<string, string | undefined>,
	config: Record<string, string | undefined> = {},
): ResolvedSetting<ApiOutputFormat> {
	return resolveStringSetting(
		request.format,
		env,
		"CENTRS_FORMAT",
		"json",
		"format",
		parseApiOutputFormat,
		undefined,
		config,
	) as ResolvedSetting<ApiOutputFormat>;
}

function resolveApiTimeout(
	timeout: ApiRequest["timeout"],
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
			summary: `REST timeout ${resolved.value}ms exceeds the RouterOS REST ceiling.`,
			remediation: "Use `--timeout 60s` or less for the REST api path.",
			context: { via, timeoutMs: resolved.value, ceilingMs: 60_000 },
		});
	}
	return resolved;
}

export function buildApiErrorEnvelope(
	request: ApiRequest,
	error: unknown,
	env: Record<string, string | undefined> = Bun.env,
): ApiErrorEnvelope {
	const centrsError = asApiError(error);
	const requestedVia = plannedProtocols.includes(
		request.via as RouterOsProtocol,
	)
		? (request.via as RouterOsProtocol)
		: null;
	// Preserve the caller's raw method on the error path rather than fabricating a
	// valid GET/print: an invalid `-X` should report what was actually asked.
	const parsedMethod = tryParseApiMethod(request.method);
	const reportedPath = safeNormalizePath(request.endpoint);
	return {
		ok: false,
		error: serializeCentrsError(centrsError),
		warnings: [],
		tips: [],
		meta: {
			target: { input: request.targetInput },
			via: requestedVia,
			settings: {},
			operation: {
				kind: "api",
				objectCount: 0,
				request: {
					endpoint: request.endpoint,
					path: reportedPath,
					method: parsedMethod ?? request.method ?? "GET",
					verb: parsedMethod ? mapMethodToVerb(parsedMethod) : null,
					write: parsedMethod
						? isApiMutating(parsedMethod, reportedPath)
						: false,
					listen: request.listen ?? false,
					yes: request.yes ?? false,
					validate: request.raw ? false : (request.validate ?? true),
					raw: request.raw ?? false,
					format: resolveErrorFormat(request, env),
				},
				auth: {
					username: request.username,
					passwordProvided: request.password !== undefined,
				},
			},
		},
	};
}

export function buildApiErrorEnvelopeFromResolved(
	resolved: ResolvedApiRequest,
	error: unknown,
): ApiErrorEnvelope {
	const centrsError = asApiError(error);
	return {
		ok: false,
		error: serializeCentrsError(centrsError),
		warnings: [...resolved.warnings],
		tips: [],
		meta: metaFromResolved(resolved, {
			enabled: resolved.validate.value,
			source: resolved.validate.value ? "/console/inspect" : "disabled",
			result: resolved.validate.value ? "failed" : "skipped",
			syntax: false,
			semantic: resolved.validate.value
				? resolved.scriptMode
					? "not-applicable"
					: false
				: false,
		}),
	};
}

function asApiError(error: unknown): CentrsError {
	return error instanceof CentrsError
		? error
		: new CentrsError({
				code: "internal/unhandled",
				summary: "api failed with an unexpected internal error.",
				remediation:
					"Re-run with `--format json` to capture the structured error details for debugging.",
				cause: error,
			});
}

export function renderApiEnvelope(
	envelope: ApiEnvelope,
	format: ApiOutputFormat,
	options: { raw?: boolean; verbose?: boolean } = {},
): string {
	if (options.raw) {
		// `--raw` waives the envelope-lossless rule: success is the bare RouterOS
		// body; an error is a compact RouterOS/centrs error payload (the CLI routes
		// it to stderr with a nonzero exit).
		return envelope.ok
			? JSON.stringify(envelope.data, null, 2)
			: JSON.stringify(rawErrorPayload(envelope.error), null, 2);
	}
	switch (format) {
		case "json":
			return JSON.stringify(envelope, null, 2);
		case "yaml":
			return toYaml(envelope);
		case "text":
			return envelope.ok
				? renderApiSuccessText(envelope, options)
				: renderApiErrorText(envelope, options);
		default:
			return exhaustiveFormat(format);
	}
}

/**
 * Render one `--stream` envelope as a **single line**: compact NDJSON (one JSON
 * object per line) for both `json` and `yaml`, and a concise human row for
 * `text`. `yaml` deliberately falls back to NDJSON here — YAML's multi-line
 * document form is incompatible with line-delimited streaming. Unlike
 * {@link renderApiEnvelope} this never pretty-prints — every frame and the
 * summary are one line each, so a consumer can read the stream line by line.
 */
export function renderApiStreamLine(
	envelope: ApiEnvelope,
	format: ApiOutputFormat,
	options: { raw?: boolean; verbose?: boolean } = {},
): string {
	if (options.raw) {
		return envelope.ok
			? JSON.stringify(envelope.data)
			: JSON.stringify(rawErrorPayload(envelope.error));
	}
	if (format === "text") {
		if (envelope.ok) {
			return renderApiStreamFrameText(envelope);
		}
		// A streamed error must stay one line too — never the verbose blank-line +
		// pretty-printed context block that `renderApiErrorText` emits.
		const error = envelope.error;
		return error.remediation
			? `[${error.code}] ${error.summary} — Fix: ${error.remediation}`
			: `[${error.code}] ${error.summary}`;
	}
	// json and yaml both stream as NDJSON: one compact envelope object per line.
	// (yaml falls back to JSON — a multi-line YAML doc can't be one stream line.)
	return JSON.stringify(envelope);
}

function renderApiStreamFrameText(envelope: ApiSuccessEnvelope): string {
	const stream = envelope.meta.operation?.stream;
	if (stream?.kind === "summary") {
		return `— ${stream.stopReason}: ${stream.frames} frame(s) in ${stream.durationMs}ms`;
	}
	const index = stream?.kind === "frame" ? stream.index : 0;
	return `${index}\t${JSON.stringify(envelope.data)}`;
}

function rawErrorPayload(
	error: ApiErrorEnvelope["error"],
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		code: error.code,
		message: error.summary,
	};
	if (error.cause !== undefined) {
		payload["cause"] = error.cause;
	}
	if (error.context !== undefined) {
		payload["context"] = error.context;
	}
	return payload;
}

function renderApiSuccessText(
	envelope: ApiSuccessEnvelope,
	options: { verbose?: boolean },
): string {
	const lines: string[] = [];
	if (options.verbose) {
		lines.push(`via: ${envelope.meta.via}`);
		if (envelope.meta.validation?.source) {
			lines.push(`validation: ${envelope.meta.validation.source}`);
		}
		lines.push("");
	}
	lines.push(
		typeof envelope.data === "string"
			? envelope.data
			: JSON.stringify(envelope.data, null, 2),
	);
	return lines.join("\n");
}

function renderApiErrorText(
	envelope: ApiErrorEnvelope,
	options: { verbose?: boolean },
): string {
	const lines = [`[${envelope.error.code}] ${envelope.error.summary}`];
	if (envelope.error.remediation) {
		lines.push(`Fix: ${envelope.error.remediation}`);
	}
	if (options.verbose && envelope.error.context) {
		lines.push("", JSON.stringify(envelope.error.context, null, 2));
	}
	return lines.join("\n");
}

export function validateApiRequestShape(request: ApiRequest): void {
	if (!request.endpoint || request.endpoint.trim().length === 0) {
		throw new CentrsError({
			code: "input/invalid-command",
			summary: "`centrs api` requires an <endpoint> path.",
			remediation:
				"Pass a REST-style endpoint such as `ip/address` or `system/resource`.",
		});
	}
	const normalized = normalizeApiEndpoint(request.endpoint);
	if (pathTokens(normalized.path).length === 0) {
		throw new CentrsError({
			code: "input/invalid-path",
			summary: `The endpoint "${request.endpoint}" has no RouterOS path.`,
			remediation:
				"Pass a path with at least one menu segment, such as `ip/address`.",
		});
	}
}

export function parseApiMethod(method: string | undefined): ApiMethod {
	if (method === undefined) {
		return "GET";
	}
	const upper = method.toUpperCase();
	if ((apiMethods as readonly string[]).includes(upper)) {
		return upper as ApiMethod;
	}
	throw new CentrsError({
		code: "usage/invalid-method",
		summary: `Unsupported HTTP method: ${method}`,
		remediation: `Choose one of ${apiMethods.join(", ")}.`,
		context: { method },
	});
}

/**
 * Build the request-level summary (no target) for the fan-out outer meta and
 * for an empty selection where no per-target inner envelope exists. Mirrors the
 * summary `buildApiErrorEnvelope` assembles from a bare request.
 */
export function apiRequestSummaryFromRequest(
	request: ApiRequest,
	env: Record<string, string | undefined> = Bun.env,
): ApiRequestSummary {
	const normalized = normalizeApiEndpoint(request.endpoint);
	const parsed = tryParseApiMethod(request.method);
	const listen = (request.listen ?? false) || normalized.listen;
	return {
		endpoint: request.endpoint,
		path: normalized.path,
		id: normalized.id,
		method: parsed ?? request.method ?? "GET",
		verb: parsed ? mapMethodToVerb(parsed) : null,
		write: parsed ? isApiMutating(parsed, normalized.path) : false,
		listen,
		yes: request.yes ?? false,
		validate: request.raw ? false : (request.validate ?? true),
		raw: request.raw ?? false,
		format: resolveErrorFormat(request, env),
		query: buildApiQuery(request),
		proplist: buildApiProplist(request),
	};
}

/** Parse a method without throwing: a valid {@link ApiMethod}, or `undefined` when invalid. */
function tryParseApiMethod(method: string | undefined): ApiMethod | undefined {
	if (method === undefined) {
		return "GET";
	}
	const upper = method.toUpperCase();
	return (apiMethods as readonly string[]).includes(upper)
		? (upper as ApiMethod)
		: undefined;
}

function safeNormalizePath(endpoint: string): string {
	try {
		return normalizeApiEndpoint(endpoint).path;
	} catch {
		return endpoint;
	}
}

function parseApiOutputFormat(value: string): ApiOutputFormat {
	if ((apiOutputFormats as readonly string[]).includes(value)) {
		return value as ApiOutputFormat;
	}
	throw new CentrsError({
		code: "settings/invalid-format",
		summary: `Unsupported output format: ${value}`,
		remediation: `Choose one of ${apiOutputFormats.join(", ")}.`,
	});
}

function resolveErrorFormat(
	request: ApiRequest,
	env: Record<string, string | undefined>,
): ApiOutputFormat {
	try {
		return resolveApiFormat(request, env).value;
	} catch {
		return "json";
	}
}

function metaFromResolved(
	resolved: ResolvedApiRequest,
	validation: EnvelopeValidationMeta,
	data?: unknown,
): ApiEnvelope["meta"] & { operation: ApiOperationMeta } {
	const target = resolved.target;
	const targetSources: Record<string, CoreSettingSource> = {};
	for (const [field, source] of Object.entries(target.sources)) {
		targetSources[field] = toCoreSource(source);
	}
	const operation: ApiOperationMeta = {
		kind: "api",
		objectCount: countResultObjects(data),
		request: apiRequestSummary(resolved),
		auth: {
			username: resolved.auth.username,
			passwordProvided: resolved.auth.passwordProvided,
		},
	};
	return {
		target: {
			input: target.input,
			host: target.host,
			port: target.port,
			baseUrl: target.baseUrl,
			mac: target.mac,
			identity: target.identity,
			recordIndex: target.recordIndex,
			source: toCoreSource(target.source),
			sources: targetSources,
		},
		via: resolved.via.value,
		settings: settingsMeta(resolved),
		validation,
		operation,
	};
}

function settingsMeta(resolved: ResolvedApiRequest): CommonSettingsMeta {
	return {
		via: toCoreSource(resolved.via.source),
		host: toCoreSource(resolved.target.hostSource),
		port: toCoreSource(resolved.target.portSource),
		timeoutMs: toCoreSource(resolved.timeoutMs.source),
		format: toCoreSource(resolved.format.source),
		validate: toCoreSource(resolved.validate.source),
		insecure: toCoreSource(resolved.insecure.source),
		username: resolved.auth.usernameSource
			? toCoreSource(resolved.auth.usernameSource)
			: undefined,
		password: resolved.auth.passwordSource
			? toCoreSource(resolved.auth.passwordSource)
			: undefined,
	};
}

function apiRequestSummary(resolved: ResolvedApiRequest): ApiRequestSummary {
	return {
		endpoint: resolved.endpoint,
		path: resolved.path,
		id: resolved.id,
		method: resolved.method,
		verb: resolved.verb,
		write: isApiMutating(resolved.method, resolved.path),
		listen: resolved.listen,
		yes: resolved.yes,
		validate: resolved.validate.value,
		raw: resolved.raw,
		format: resolved.format.value,
		query: resolved.query.length > 0 ? resolved.query : undefined,
		proplist: resolved.proplist.length > 0 ? resolved.proplist : undefined,
	};
}

function countResultObjects(data: unknown): number {
	if (Array.isArray(data)) {
		return data.length;
	}
	if (data === null || data === undefined) {
		return 0;
	}
	if (typeof data === "object" && Object.keys(data).length === 0) {
		return 0;
	}
	return 1;
}

function exhaustiveMethod(value: never): never {
	throw new Error(`Unhandled api method: ${String(value)}`);
}

function exhaustiveFormat(value: never): never {
	throw new Error(`Unhandled api output format: ${String(value)}`);
}
