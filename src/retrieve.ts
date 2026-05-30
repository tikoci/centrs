import {
	type DevicesWarning,
	type LoadedCdb,
	loadCdb,
	resolveDevicesSettings,
	showDevice,
} from "./devices.ts";
import { CentrsError, serializeCentrsError } from "./errors.ts";
import { getProtocolPlan, type RouterOsProtocol } from "./protocols/index.ts";

export const retrieveOutputFormats = ["text", "json", "yaml"] as const;
export type RetrieveOutputFormat = (typeof retrieveOutputFormats)[number];

const ENV_CDB_FILE = "CENTRS_CDB_FILE";
const ENV_CDB_PASSWORD = "CENTRS_CDB_PASSWORD";
const ENV_HOST = "CENTRS_HOST";

type SettingSourceKind =
	| "default"
	| "env"
	| "explicit"
	| "target-input"
	| "cdb";

interface SettingSource {
	kind: SettingSourceKind;
	key: string;
}

interface ResolvedSetting<T> {
	value: T;
	source: SettingSource;
}

interface ResolvedTarget {
	input?: string;
	host: string;
	port: number;
	scheme: "http" | "https";
	baseUrl: string;
	source: SettingSource;
}

interface ResolvedAuth {
	username?: string;
	usernameSource?: SettingSource;
	password: string;
	passwordProvided: boolean;
	passwordSource?: SettingSource;
}

export interface RetrieveRequest {
	targetInput?: string;
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
}

export interface RetrieveValidationSummary {
	enabled: boolean;
	source: string;
	availableAttributes?: readonly string[];
}

export interface RetrieveResultSummary {
	kind: "attributes" | "data";
	data: unknown;
	objectCount: number;
	serializedBytes?: number;
}

export interface RetrieveSuccessEnvelope {
	ok: true;
	capability: "retrieve";
	via: RouterOsProtocol;
	target: ResolvedTarget;
	auth: {
		username?: string;
		usernameSource?: SettingSource;
		passwordProvided: boolean;
		passwordSource?: SettingSource;
	};
	request: RetrieveRequestSummary;
	validation: RetrieveValidationSummary;
	result: RetrieveResultSummary;
	warnings: readonly RetrieveWarning[];
	settingSources: {
		via: SettingSource;
		host: SettingSource;
		port: SettingSource;
		timeoutMs: SettingSource;
		format: SettingSource;
		validate: SettingSource;
		maxResultsBytes?: SettingSource;
	};
}

export interface RetrieveErrorEnvelope {
	ok: false;
	capability: "retrieve";
	request: Partial<
		Pick<RetrieveRequestSummary, "path" | "format" | "maxResultsBytes">
	> & {
		targetInput?: string;
	};
	error: ReturnType<typeof serializeCentrsError>;
	warnings: readonly RetrieveWarning[];
}

export type RetrieveEnvelope = RetrieveSuccessEnvelope | RetrieveErrorEnvelope;

interface InspectChildItem {
	type?: string;
	name?: string;
	"node-type"?: string;
}

interface InspectCompletionItem {
	type?: string;
	name?: string;
	completion?: string;
	value?: string;
	text?: string;
}

interface RetrieveInspection {
	command: "get" | "print";
}

interface RestResponse {
	status: number;
	text: string;
	data: unknown;
}

interface ResolvedRetrieveRequest {
	path: string;
	via: ResolvedSetting<RouterOsProtocol>;
	target: ResolvedTarget;
	auth: ResolvedAuth;
	timeoutMs: ResolvedSetting<number>;
	format: ResolvedSetting<RetrieveOutputFormat>;
	validate: ResolvedSetting<boolean>;
	maxResultsBytes?: ResolvedSetting<number>;
	attributes: readonly string[];
	allAttributes: boolean;
	listAttributes: boolean;
	verbose: boolean;
	warnings: readonly RetrieveWarning[];
}

export async function retrieve(
	request: RetrieveRequest,
	env: Record<string, string | undefined> = Bun.env,
): Promise<RetrieveSuccessEnvelope> {
	const resolved = await resolveRetrieveRequest(request, env);
	const warnings: RetrieveWarning[] = [...resolved.warnings];
	let availableAttributes: string[] | undefined;
	let inspection: RetrieveInspection | undefined;

	if (resolved.listAttributes || resolved.validate.value) {
		inspection = await inspectRetrievePath(resolved);
	}

	if (
		resolved.listAttributes ||
		(resolved.validate.value && resolved.attributes.length > 0)
	) {
		availableAttributes = await inspectAttributes(
			resolved,
			inspection ?? (await inspectRetrievePath(resolved)),
		);
	}

	if (resolved.listAttributes) {
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

	if (
		resolved.validate.value &&
		availableAttributes &&
		resolved.attributes.length > 0
	) {
		const missing = resolved.attributes.filter(
			(attribute) => !availableAttributes?.includes(attribute),
		);
		if (missing.length > 0) {
			throw new CentrsError({
				code: "validation/unknown-attribute",
				summary: `Unknown RouterOS attribute ${missing.join(", ")} for ${resolved.path}.`,
				remediation:
					"Check the attribute name, or use `--list-attributes` to inspect the available properties first.",
				context: {
					path: resolved.path,
					requested: resolved.attributes,
					availableAttributes,
				},
			});
		}
	}

	const data = await executeRestRetrieve(resolved);
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

	return {
		ok: false,
		capability: "retrieve",
		request: {
			targetInput: request.targetInput,
			path: request.path,
			format: parseOutputFormat(request.format ?? "text"),
			maxResultsBytes: request.maxResultsBytes,
		},
		error: serializeCentrsError(centrsError),
		warnings: [],
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
		case "text":
			return envelope.ok
				? renderRetrieveSuccessText(envelope, options)
				: renderRetrieveErrorText(envelope, options);
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

	if (verbose) {
		lines.push(
			`target: ${envelope.target.input ?? envelope.target.host} -> ${envelope.target.baseUrl}`,
		);
		lines.push(`via: ${envelope.via}`);
		lines.push(
			`sources: via=${formatSource(envelope.settingSources.via)}, host=${formatSource(
				envelope.settingSources.host,
			)}, port=${formatSource(envelope.settingSources.port)}, timeout=${formatSource(
				envelope.settingSources.timeoutMs,
			)}, format=${formatSource(envelope.settingSources.format)}, validate=${formatSource(
				envelope.settingSources.validate,
			)}`,
		);
		if (envelope.validation.enabled) {
			lines.push(`validation: ${envelope.validation.source}`);
		}
		lines.push("");
	}

	if (envelope.result.kind === "attributes") {
		const attributes = Array.isArray(envelope.result.data)
			? (envelope.result.data as readonly string[])
			: [];
		lines.push(...attributes);
	} else if (typeof envelope.result.data === "string") {
		lines.push(envelope.result.data);
	} else {
		lines.push(JSON.stringify(envelope.result.data, null, 2));
	}

	if (envelope.warnings.length > 0) {
		lines.push("");
		for (const warning of envelope.warnings) {
			lines.push(`warning [${warning.code}]: ${warning.message}`);
		}
	}

	return lines.join("\n");
}

function renderRetrieveErrorText(
	envelope: RetrieveErrorEnvelope,
	options: { verbose?: boolean },
): string {
	const { error } = envelope;
	const lines = [`[${error.code}] ${error.summary}`];

	if (error.remediation) {
		lines.push(`Fix: ${error.remediation}`);
	}

	if (options.verbose && error.context) {
		lines.push("");
		lines.push(JSON.stringify(error.context, null, 2));
	}

	return lines.join("\n");
}

function buildSuccessEnvelope(
	resolved: ResolvedRetrieveRequest,
	result: Pick<RetrieveResultSummary, "kind" | "data">,
	validation: RetrieveValidationSummary,
	warnings: readonly RetrieveWarning[],
): RetrieveSuccessEnvelope {
	return {
		ok: true,
		capability: "retrieve",
		via: resolved.via.value,
		target: resolved.target,
		auth: {
			username: resolved.auth.username,
			usernameSource: resolved.auth.usernameSource,
			passwordProvided: resolved.auth.passwordProvided,
			passwordSource: resolved.auth.passwordSource,
		},
		request: {
			path: resolved.path,
			attributes: resolved.attributes,
			allAttributes: resolved.allAttributes,
			listAttributes: resolved.listAttributes,
			validate: resolved.validate.value,
			verbose: resolved.verbose,
			timeoutMs: resolved.timeoutMs.value,
			format: resolved.format.value,
			maxResultsBytes: resolved.maxResultsBytes?.value,
		},
		validation,
		result: {
			kind: result.kind,
			data: result.data,
			objectCount: countResultObjects(result.data),
		},
		warnings,
		settingSources: {
			via: resolved.via.source,
			host: resolved.target.source,
			port: {
				kind:
					resolved.target.source.kind === "target-input" &&
					resolved.target.port === defaultPortForScheme(resolved.target.scheme)
						? "default"
						: resolved.target.source.kind,
				key:
					resolved.target.source.kind === "target-input" &&
					resolved.target.port === defaultPortForScheme(resolved.target.scheme)
						? `${resolved.target.scheme} default`
						: resolved.target.source.key,
			},
			timeoutMs: resolved.timeoutMs.source,
			format: resolved.format.source,
			validate: resolved.validate.source,
			maxResultsBytes: resolved.maxResultsBytes?.source,
		},
	};
}

function applyMaxResultsBudget(
	envelope: RetrieveSuccessEnvelope,
): RetrieveSuccessEnvelope {
	const rendered = renderRetrieveEnvelope(envelope, envelope.request.format, {
		verbose: envelope.request.format === "text" && envelope.request.verbose,
	});
	const serializedBytes = byteLength(rendered);
	envelope.result.serializedBytes = serializedBytes;

	if (
		envelope.request.maxResultsBytes !== undefined &&
		serializedBytes > envelope.request.maxResultsBytes
	) {
		throw new CentrsError({
			code: "input/max-results-exceeded",
			summary: `retrieve output exceeded the requested ${envelope.request.maxResultsBytes}-byte budget.`,
			remediation:
				"Increase `--max-results`, reduce the selected attributes, or switch to a more selective path.",
			context: {
				requiredBytes: serializedBytes,
				maxResultsBytes: envelope.request.maxResultsBytes,
				objectCount: envelope.result.objectCount,
				path: envelope.request.path,
			},
		});
	}

	return envelope;
}

async function resolveRetrieveRequest(
	request: RetrieveRequest,
	env: Record<string, string | undefined>,
): Promise<ResolvedRetrieveRequest> {
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

	const via = resolveProtocol(request, env);
	const format = resolveFormat(request, env);
	const validate = resolveBooleanSetting(
		request.validate,
		env,
		"CENTRS_VALIDATE",
		true,
		"validate",
	);
	const timeoutMs = resolveTimeoutSetting(request.timeout, env, via.value);
	const maxResultsBytes = resolveOptionalIntegerSetting(
		request.maxResultsBytes,
		env,
		"CENTRS_MAX_RESULTS",
		"max-results",
	);
	const cdbResolution = await resolveRetrieveCdb(request, env);
	const target = resolveTarget(request, env, cdbResolution);
	const auth = resolveAuth(request, env, cdbResolution);

	return {
		path: request.path,
		via,
		target,
		auth,
		timeoutMs,
		format,
		validate,
		maxResultsBytes,
		attributes: attributeSelections,
		allAttributes: request.allAttributes ?? false,
		listAttributes: request.listAttributes ?? false,
		verbose: request.verbose ?? false,
		warnings: cdbResolution?.warnings ?? [],
	};
}

interface RetrieveCdbResolution {
	target: string;
	username: string;
	password: string;
	warnings: readonly RetrieveWarning[];
	recordIndex: number;
}

async function resolveRetrieveCdb(
	request: RetrieveRequest,
	env: Record<string, string | undefined>,
): Promise<RetrieveCdbResolution | undefined> {
	if (!request.targetInput) {
		return undefined;
	}

	const settings = resolveDevicesSettings({
		cdbFile: request.cdbFile,
		cdbPassword: request.cdbPassword,
		env,
	});
	const explicitCdb =
		request.cdbFile !== undefined ||
		request.cdbPassword !== undefined ||
		env[ENV_CDB_FILE] !== undefined ||
		env[ENV_CDB_PASSWORD] !== undefined;
	if (!explicitCdb && !(await Bun.file(settings.cdbFile.value).exists())) {
		return undefined;
	}

	let cdb: LoadedCdb;
	try {
		cdb = await loadCdb({
			cdbFile: request.cdbFile,
			cdbPassword: request.cdbPassword,
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
		const envelope = showDevice({ cdb, target: request.targetInput });
		const entry = envelope.data.entry;
		return {
			target: entry.target,
			username: entry.user,
			password: entry.password,
			warnings: envelope.warnings.map(retrieveWarningFromDevicesWarning),
			recordIndex: entry.cdbRecordIndex,
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

function retrieveWarningFromDevicesWarning(
	warning: DevicesWarning,
): RetrieveWarning {
	return {
		code: warning.code,
		message: warning.message,
		context: warning.context,
	};
}

function resolveProtocol(
	request: RetrieveRequest,
	env: Record<string, string | undefined>,
): ResolvedSetting<RouterOsProtocol> {
	const via = resolveStringSetting(
		request.via,
		env,
		"CENTRS_VIA",
		"rest-api",
		"via",
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
	if (!plan.implemented) {
		throw new CentrsError({
			code: "routeros/protocol-not-implemented",
			summary: `Protocol ${via.value} is planned but not implemented yet.`,
			remediation:
				"Use `--via rest-api` for the current alpha retrieve implementation.",
			context: { via: via.value, capability: "retrieve" },
		});
	}

	if (!plan.capabilities.includes("retrieve")) {
		throw new CentrsError({
			code: "routeros/unsupported-capability",
			summary: `Protocol ${via.value} does not support the retrieve capability.`,
			remediation:
				"Choose a protocol that supports retrieve, such as `rest-api` or `snmp` once implemented.",
			context: { via: via.value, capability: "retrieve" },
		});
	}

	return via as ResolvedSetting<RouterOsProtocol>;
}

function resolveFormat(
	request: RetrieveRequest,
	env: Record<string, string | undefined>,
): ResolvedSetting<RetrieveOutputFormat> {
	return resolveStringSetting(
		request.format,
		env,
		"CENTRS_FORMAT",
		"json",
		"format",
		parseOutputFormat,
	) as ResolvedSetting<RetrieveOutputFormat>;
}

function resolveTarget(
	request: RetrieveRequest,
	env: Record<string, string | undefined>,
	cdbResolution?: RetrieveCdbResolution,
): ResolvedTarget {
	const hostSetting = resolveStringSetting(
		request.host,
		env,
		"CENTRS_HOST",
		cdbResolution?.target ?? request.targetInput,
		"host",
	);

	if (!hostSetting || hostSetting.value.trim().length === 0) {
		throw new CentrsError({
			code: "target/unresolved",
			summary: "No host could be resolved for `retrieve`.",
			remediation:
				"Pass a target positional like `centrs retrieve 192.0.2.10 /system/resource --via rest-api` or set `--host` / `CENTRS_HOST`.",
			context: {
				targetInput: request.targetInput,
			},
		});
	}

	const candidate = hostSetting.value.trim();
	const parsedUrl = parseHostCandidate(candidate);
	const portSetting = resolveOptionalIntegerSetting(
		request.port,
		env,
		"CENTRS_PORT",
		"port",
	);
	const scheme = parsedUrl.protocol === "https:" ? "https" : "http";
	const port = portSetting?.value ?? readPort(parsedUrl, scheme);

	return {
		input: request.targetInput,
		host: parsedUrl.hostname,
		port,
		scheme,
		baseUrl: `${scheme}://${formatHostForUrl(parsedUrl.hostname)}:${port}/rest`,
		source:
			cdbResolution && request.host === undefined && env[ENV_HOST] === undefined
				? { kind: "cdb", key: `record:${cdbResolution.recordIndex}` }
				: hostSetting.source,
	};
}

function resolveAuth(
	request: RetrieveRequest,
	env: Record<string, string | undefined>,
	cdbResolution?: RetrieveCdbResolution,
): ResolvedAuth {
	const username = resolveStringSetting(
		request.username,
		env,
		"CENTRS_USERNAME",
		undefined,
		"username",
	);
	const password = resolveStringSetting(
		request.password,
		env,
		"CENTRS_PASSWORD",
		undefined,
		"password",
	);
	const cdbUsername =
		username === undefined && cdbResolution?.username
			? {
					value: cdbResolution.username,
					source: {
						kind: "cdb" as const,
						key: `record:${cdbResolution.recordIndex}:user`,
					},
				}
			: undefined;
	const cdbPassword =
		password === undefined && cdbResolution
			? {
					value: cdbResolution.password,
					source: {
						kind: "cdb" as const,
						key: `record:${cdbResolution.recordIndex}:password`,
					},
				}
			: undefined;
	const resolvedUsername = username ?? cdbUsername;
	const resolvedPassword = password ?? cdbPassword;

	return {
		username: resolvedUsername?.value,
		usernameSource: resolvedUsername?.source,
		password: resolvedPassword?.value ?? "",
		passwordProvided: resolvedPassword !== undefined,
		passwordSource: resolvedPassword?.source,
	};
}

async function inspectRetrievePath(
	resolved: ResolvedRetrieveRequest,
): Promise<RetrieveInspection> {
	const pathTokens = pathTokensForInspect(resolved.path);
	const rootChildren = await restPost<InspectChildItem[]>(
		resolved,
		"/console/inspect",
		{
			request: "child",
			path: pathToInspectString(pathTokens),
		},
	);

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

	const singleton = isKnownSingletonPath(resolved.path);
	return {
		command: singleton && supportsGet ? "get" : "print",
	};
}

async function inspectAttributes(
	resolved: ResolvedRetrieveRequest,
	inspection: RetrieveInspection,
): Promise<string[]> {
	const pathTokens = pathTokensForInspect(resolved.path);
	const argument = inspection.command === "get" ? "value-name" : "proplist";
	const completionRows = await restPost<InspectCompletionItem[]>(
		resolved,
		"/console/inspect",
		{
			request: "completion",
			path: pathToInspectString([...pathTokens, inspection.command, argument]),
		},
	);
	const completions = extractCompletionNames(completionRows);
	if (completions.length > 0) {
		return completions;
	}

	const commandChildren = await restPost<InspectChildItem[]>(
		resolved,
		"/console/inspect",
		{
			request: "child",
			path: pathToInspectString([...pathTokens, inspection.command]),
		},
	);
	return commandChildren
		.filter(isArgumentNode)
		.map((child) => child.name)
		.filter(
			(name): name is string => typeof name === "string" && name.length > 0,
		)
		.sort();
}

async function executeRestRetrieve(
	resolved: ResolvedRetrieveRequest,
): Promise<unknown> {
	if (isKnownSingletonPath(resolved.path)) {
		const data = await restGet(resolved, resolved.path);
		if (resolved.attributes.length > 0) {
			return projectSingletonAttributes(data, resolved.attributes);
		}
		return data;
	}

	if (resolved.attributes.length > 0 || resolved.allAttributes) {
		const body: { ".proplist"?: readonly string[]; detail?: string } = {};
		if (resolved.attributes.length > 0) {
			body[".proplist"] = resolved.attributes;
		}
		if (resolved.allAttributes) {
			body.detail = "true";
		}
		return restPost(
			resolved,
			`${resolved.path.replace(/\/$/, "")}/print`,
			body,
		);
	}

	return restGet(resolved, resolved.path);
}

async function restGet(
	resolved: ResolvedRetrieveRequest,
	path: string,
): Promise<unknown> {
	const response = await fetchRest(resolved, path, { method: "GET" });
	return response.data;
}

async function restPost<T = unknown>(
	resolved: ResolvedRetrieveRequest,
	path: string,
	body: Record<string, unknown>,
): Promise<T> {
	const response = await fetchRest(resolved, path, {
		method: "POST",
		body: JSON.stringify(body),
		headers: {
			"Content-Type": "application/json",
		},
	});
	return response.data as T;
}

async function fetchRest(
	resolved: ResolvedRetrieveRequest,
	path: string,
	init: RequestInit,
): Promise<RestResponse> {
	const url = joinRestUrl(resolved.target.baseUrl, path);
	const headers = new Headers(init.headers);
	if (resolved.auth.username) {
		headers.set(
			"Authorization",
			`Basic ${Buffer.from(`${resolved.auth.username}:${resolved.auth.password}`, "utf8").toString("base64")}`,
		);
	}

	const controller = new AbortController();
	const timeoutHandle = setTimeout(
		() => controller.abort("timeout"),
		resolved.timeoutMs.value,
	);

	try {
		const response = await fetch(url, {
			...init,
			headers,
			signal: controller.signal,
		});
		const text = await response.text();
		const data = parseResponseBody(text);
		if (!response.ok) {
			throw mapHttpFailure(response.status, text, data, resolved, path);
		}

		return {
			status: response.status,
			text,
			data,
		};
	} catch (error) {
		if (error instanceof CentrsError) {
			throw error;
		}
		throw mapTransportFailure(error, resolved, path);
	} finally {
		clearTimeout(timeoutHandle);
	}
}

function mapHttpFailure(
	status: number,
	text: string,
	data: unknown,
	resolved: ResolvedRetrieveRequest,
	path: string,
): CentrsError {
	if (status === 401 || status === 403) {
		return new CentrsError({
			code: "transport/auth-failed",
			summary: `RouterOS rejected the REST credentials for ${resolved.target.host}:${resolved.target.port}.`,
			remediation:
				"Check `--username` / `--password` or the matching `CENTRS_*` environment variables, and confirm the user has RouterOS REST access.",
			context: {
				via: resolved.via.value,
				host: resolved.target.host,
				port: resolved.target.port,
				path,
				status,
			},
			causeData: data ?? text,
		});
	}

	if (
		status === 400 &&
		isPlainObject(data) &&
		readRecordString(data, "detail") === "Session closed"
	) {
		return new CentrsError({
			code: "transport/timeout",
			summary: `RouterOS closed the REST session before ${path} completed.`,
			remediation:
				"Reduce the scope of the request, or choose a path that can complete within the current RouterOS REST timeout ceiling.",
			context: {
				via: resolved.via.value,
				host: resolved.target.host,
				port: resolved.target.port,
				path,
				timeoutMs: resolved.timeoutMs.value,
			},
			causeData: data,
		});
	}

	if (status === 404) {
		return new CentrsError({
			code: "routeros/path-not-found",
			summary: `RouterOS path ${path} was not found over REST.`,
			remediation:
				"Check the slash-prefixed RouterOS path, or use `--list-attributes` / `--no-validate` to narrow down where the mismatch is happening.",
			context: {
				via: resolved.via.value,
				host: resolved.target.host,
				port: resolved.target.port,
				path,
				status,
			},
			causeData: data ?? text,
		});
	}

	return new CentrsError({
		code: "routeros/request-failed",
		summary: `RouterOS REST request failed with HTTP ${status} for ${path}.`,
		remediation:
			"Inspect the returned RouterOS message, then adjust the path, credentials, or request shape accordingly.",
		context: {
			via: resolved.via.value,
			host: resolved.target.host,
			port: resolved.target.port,
			path,
			status,
		},
		causeData: data ?? text,
	});
}

function mapTransportFailure(
	error: unknown,
	resolved: ResolvedRetrieveRequest,
	path: string,
): CentrsError {
	const signals = collectTransportSignals(error);
	const codes = signals.codes.map((code) => code.toLowerCase());
	const messages = signals.messages.map((message) => message.toLowerCase());
	if (
		codes.includes("abort_err") ||
		messages.some((candidate) => candidate.includes("timeout"))
	) {
		return new CentrsError({
			code: "transport/timeout",
			summary: `Timed out waiting for ${resolved.via.value} to respond from ${resolved.target.host}:${resolved.target.port}.`,
			remediation:
				"Increase `--timeout` within the REST ceiling, or confirm the host and port are reachable.",
			context: {
				via: resolved.via.value,
				host: resolved.target.host,
				port: resolved.target.port,
				path,
				timeoutMs: resolved.timeoutMs.value,
			},
			cause: error,
		});
	}

	if (
		codes.some(
			(code) => code === "econnrefused" || code === "connectionrefused",
		) ||
		messages.some(
			(candidate) =>
				candidate.includes("econnrefused") ||
				candidate.includes("connection refused") ||
				candidate.includes("unable to connect"),
		)
	) {
		return new CentrsError({
			code: "transport/connection-refused",
			summary: `Connection refused by ${resolved.target.host}:${resolved.target.port} over ${resolved.via.value}.`,
			remediation:
				"Check that the RouterOS REST service is enabled on that port and that any local forwarding or firewall rules are correct.",
			context: {
				via: resolved.via.value,
				host: resolved.target.host,
				port: resolved.target.port,
				path,
			},
			cause: error,
		});
	}

	if (
		codes.some((code) => ["enotfound", "eai_again", "dns"].includes(code)) ||
		messages.some(
			(candidate) =>
				candidate.includes("enotfound") ||
				candidate.includes("eai_again") ||
				candidate.includes("dns") ||
				candidate.includes("could not resolve") ||
				candidate.includes("name lookup"),
		)
	) {
		return new CentrsError({
			code: "transport/dns",
			summary: `Could not resolve ${resolved.target.host} for ${resolved.via.value}.`,
			remediation:
				"Check the host spelling, DNS configuration, or pass a literal address with `--host`.",
			context: {
				via: resolved.via.value,
				host: resolved.target.host,
				port: resolved.target.port,
				path,
			},
			cause: error,
		});
	}

	if (messages.some((candidate) => candidate.includes("certificate"))) {
		return new CentrsError({
			code: "transport/tls-certificate",
			summary: `TLS certificate validation failed for ${resolved.target.host}:${resolved.target.port}.`,
			remediation:
				"Use an HTTP URL for this alpha slice, or install a certificate chain Bun can trust before using HTTPS.",
			context: {
				via: resolved.via.value,
				host: resolved.target.host,
				port: resolved.target.port,
				path,
			},
			cause: error,
		});
	}

	return new CentrsError({
		code: "transport/network",
		summary: `Network request to ${resolved.target.host}:${resolved.target.port} failed over ${resolved.via.value}.`,
		remediation:
			"Check the host, port, and service availability, then re-run with `--format json` if you need the structured cause data.",
		context: {
			via: resolved.via.value,
			host: resolved.target.host,
			port: resolved.target.port,
			path,
		},
		cause: error,
	});
}

function pathTokensForInspect(path: string): string[] {
	return path.split("/").filter(Boolean);
}

function isCommandNode(
	child: InspectChildItem,
	name: "get" | "print",
): boolean {
	return (
		child.name === name &&
		(child.type === "cmd" || child["node-type"] === "cmd")
	);
}

function isArgumentNode(child: InspectChildItem): boolean {
	return child.type === "arg" || child["node-type"] === "arg";
}

function extractCompletionNames(
	rows: readonly InspectCompletionItem[],
): string[] {
	const names = rows
		.flatMap((row) => [row.completion, row.name, row.value, row.text])
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.replace(/=.*$/, "").trim())
		.filter((value) => value.length > 0);
	return [...new Set(names)].sort();
}

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

interface TransportSignals {
	codes: string[];
	messages: string[];
}

function collectTransportSignals(error: unknown): TransportSignals {
	const signals: TransportSignals = { codes: [], messages: [] };
	collectTransportSignalsInto(error, signals, new Set<unknown>());
	return signals;
}

function collectTransportSignalsInto(
	error: unknown,
	signals: TransportSignals,
	seen: Set<unknown>,
): void {
	if (error === null || error === undefined || seen.has(error)) {
		return;
	}
	if (typeof error !== "object") {
		signals.messages.push(String(error));
		return;
	}
	seen.add(error);

	if (error instanceof Error && error.message.length > 0) {
		signals.messages.push(error.message);
	}
	if ("message" in error && typeof error.message === "string") {
		signals.messages.push(error.message);
	}
	if ("code" in error && typeof error.code === "string") {
		signals.codes.push(error.code);
	}
	if ("errno" in error && typeof error.errno === "string") {
		signals.codes.push(error.errno);
	}
	if ("cause" in error) {
		collectTransportSignalsInto(error.cause, signals, seen);
	}
	if ("errors" in error && Array.isArray(error.errors)) {
		for (const nested of error.errors) {
			collectTransportSignalsInto(nested, signals, seen);
		}
	}
}

function joinRestUrl(baseUrl: string, path: string): string {
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	return `${baseUrl}${normalizedPath}`;
}

function parseResponseBody(text: string): unknown {
	if (text.length === 0) {
		return null;
	}

	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function resolveTimeoutSetting(
	timeout: RetrieveRequest["timeout"],
	env: Record<string, string | undefined>,
	via: RouterOsProtocol,
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

function resolveBooleanSetting(
	explicit: boolean | undefined,
	env: Record<string, string | undefined>,
	envName: string,
	defaultValue: boolean,
	key: string,
): ResolvedSetting<boolean> {
	if (explicit !== undefined) {
		return {
			value: explicit,
			source: {
				kind: "explicit",
				key,
			},
		};
	}

	const envValue = env[envName];
	if (envValue !== undefined) {
		return {
			value: parseBoolean(envValue, envName),
			source: {
				kind: "env",
				key: envName,
			},
		};
	}

	return {
		value: defaultValue,
		source: {
			kind: "default",
			key: key,
		},
	};
}

function resolveOptionalIntegerSetting(
	explicit: number | undefined,
	env: Record<string, string | undefined>,
	envName: string,
	key: string,
): ResolvedSetting<number> | undefined {
	if (explicit !== undefined) {
		if (!Number.isInteger(explicit) || explicit <= 0) {
			throw new CentrsError({
				code: "settings/invalid-integer",
				summary: `${key} must be a positive integer. Received: ${explicit}`,
				remediation: `Pass a positive integer for ${key}.`,
			});
		}
		return {
			value: explicit,
			source: {
				kind: "explicit",
				key,
			},
		};
	}

	const envValue = env[envName];
	if (envValue === undefined) {
		return undefined;
	}

	const parsed = Number.parseInt(envValue, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new CentrsError({
			code: "settings/invalid-integer",
			summary: `${envName} must be a positive integer. Received: ${envValue}`,
			remediation: `Set ${envName} to a positive integer value.`,
		});
	}

	return {
		value: parsed,
		source: {
			kind: "env",
			key: envName,
		},
	};
}

function resolveStringSetting<T = string>(
	explicit: string | undefined,
	env: Record<string, string | undefined>,
	envName: string,
	defaultValue: string | undefined,
	key: string,
	normalize?: (value: string) => T,
): ResolvedSetting<T> | undefined {
	if (explicit !== undefined) {
		return {
			value: normalize ? normalize(explicit) : (explicit as T),
			source: {
				kind:
					key === "host" && defaultValue === undefined
						? "target-input"
						: "explicit",
				key,
			},
		};
	}

	const envValue = env[envName];
	if (envValue !== undefined) {
		return {
			value: normalize ? normalize(envValue) : (envValue as T),
			source: {
				kind: "env",
				key: envName,
			},
		};
	}

	if (defaultValue !== undefined) {
		return {
			value: normalize ? normalize(defaultValue) : (defaultValue as T),
			source: {
				kind: key === "host" ? "target-input" : "default",
				key,
			},
		};
	}

	return undefined;
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

function parseDuration(value: string): number {
	const trimmed = value.trim();
	const match = /^(\d+)(ms|s|m)?$/i.exec(trimmed);
	if (!match) {
		throw new CentrsError({
			code: "settings/invalid-timeout",
			summary: `Unsupported timeout value: ${value}`,
			remediation:
				"Use an integer number of milliseconds or a suffix like `500ms`, `5s`, or `1m`.",
		});
	}

	const numeric = Number.parseInt(match[1] ?? "0", 10);
	const unit = (match[2] ?? "ms").toLowerCase();
	switch (unit) {
		case "ms":
			return numeric;
		case "s":
			return numeric * 1000;
		case "m":
			return numeric * 60_000;
		default:
			return numeric;
	}
}

function parseBoolean(value: string, settingName: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}

	throw new CentrsError({
		code: "settings/invalid-boolean",
		summary: `${settingName} must be a boolean-like value. Received: ${value}`,
		remediation: "Use one of: true/false, yes/no, on/off, or 1/0.",
	});
}

function parseHostCandidate(value: string): URL {
	if (/^https?:\/\//i.test(value)) {
		const url = new URL(value);
		if (url.pathname !== "/" && url.pathname !== "") {
			throw new CentrsError({
				code: "input/invalid-target",
				summary: `Target URL must not include a path. Received: ${value}`,
				remediation:
					"Pass only the RouterOS host or base URL, then provide the RouterOS menu path as the second positional argument.",
			});
		}
		return url;
	}

	return new URL(`http://${value}`);
}

function pathToInspectString(path: readonly string[]): string {
	return path.join(",");
}

function readPort(parsedUrl: URL, scheme: "http" | "https"): number {
	if (parsedUrl.port.length > 0) {
		return Number.parseInt(parsedUrl.port, 10);
	}
	return defaultPortForScheme(scheme);
}

function defaultPortForScheme(scheme: "http" | "https"): number {
	return scheme === "https" ? 443 : 80;
}

function formatHostForUrl(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
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

function formatSource(source: SettingSource): string {
	return `${source.kind}:${source.key}`;
}

function exhaustiveOutputFormat(value: never): never {
	throw new Error(`Unhandled retrieve output format: ${String(value)}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecordString(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function toYaml(value: unknown, indent = 0): string {
	const prefix = " ".repeat(indent);
	if (value === null || value === undefined) {
		return "null";
	}
	if (typeof value === "string") {
		return yamlScalar(value);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return `${prefix}[]`;
		}
		return value
			.map((item) => {
				if (isScalar(item)) {
					return `${prefix}- ${toYaml(item, indent + 2)}`;
				}
				return `${prefix}-\n${toYaml(item, indent + 2)}`;
			})
			.join("\n");
	}
	if (isPlainObject(value)) {
		const entries = Object.entries(value).filter(
			([, entryValue]) => entryValue !== undefined,
		);
		if (entries.length === 0) {
			return `${prefix}{}`;
		}
		return entries
			.map(([key, entryValue]) => {
				if (isScalar(entryValue)) {
					return `${prefix}${key}: ${toYaml(entryValue, indent + 2)}`;
				}
				return `${prefix}${key}:\n${toYaml(entryValue, indent + 2)}`;
			})
			.join("\n");
	}
	return yamlScalar(JSON.stringify(value));
}

function isScalar(value: unknown): value is boolean | number | string | null {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}

function yamlScalar(value: string): string {
	if (value.length === 0) {
		return '""';
	}
	return JSON.stringify(value);
}
