import type {
	CentrsEnvelope,
	CentrsErrorEnvelope,
	CentrsSuccessEnvelope,
	SettingSource as CoreSettingSource,
	EnvelopeValidationMeta,
} from "./core/envelope.ts";
import { CentrsError, serializeCentrsError } from "./errors.ts";
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
	type CdbResolution,
	parseDuration,
	type ResolvedAuth,
	type ResolvedSetting,
	type ResolvedTarget,
	resolveAuth,
	resolveBooleanSetting,
	resolveCdb,
	resolveOptionalIntegerSetting,
	resolveStringSetting,
	resolveTarget,
	toCoreSource,
} from "./resolver/index.ts";

export const retrieveOutputFormats = ["text", "json", "yaml"] as const;
export type RetrieveOutputFormat = (typeof retrieveOutputFormats)[number];

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

export interface RetrieveOperationMeta {
	kind: "attributes" | "data";
	objectCount: number;
	request: RetrieveRequestSummary;
	auth: {
		username?: string;
		passwordProvided: boolean;
	};
}

export type RetrieveEnvelope = CentrsEnvelope<unknown, RetrieveOperationMeta>;
export type RetrieveSuccessEnvelope = CentrsSuccessEnvelope<
	unknown,
	RetrieveOperationMeta
>;
export type RetrieveErrorEnvelope = CentrsErrorEnvelope<RetrieveOperationMeta>;

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
	const backend = createProtocolAdapter({
		protocol: resolved.via.value,
		host: resolved.target.host,
		port: resolved.target.port,
		tls: resolved.target.tls,
		baseUrl: resolved.target.baseUrl,
		username: resolved.auth.username,
		password: resolved.auth.password,
		timeoutMs: resolved.timeoutMs.value,
	});

	try {
		if (resolved.listAttributes || resolved.validate.value) {
			inspection = await inspectRetrievePath(resolved, backend);
		}

		if (
			resolved.listAttributes ||
			(resolved.validate.value && resolved.attributes.length > 0)
		) {
			availableAttributes = await inspectAttributes(
				resolved,
				inspection ?? (await inspectRetrievePath(resolved, backend)),
				backend,
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

		const data = await executeRetrieve(resolved, backend);
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
		meta: {
			target: { input: request.targetInput },
			via: requestedVia,
			settings: {},
		},
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
	result: { kind: "attributes" | "data"; data: unknown },
	validation: EnvelopeValidationMeta,
	warnings: readonly RetrieveWarning[],
): RetrieveSuccessEnvelope {
	const target = resolved.target;
	const targetSources: Record<string, CoreSettingSource> = {};
	for (const [field, source] of Object.entries(target.sources)) {
		targetSources[field] = toCoreSource(source);
	}

	return {
		ok: true,
		data: result.data,
		warnings,
		meta: {
			target: {
				input: target.input,
				host: target.host,
				port: target.port,
				baseUrl: target.baseUrl,
				name: target.name,
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
			operation: {
				kind: result.kind,
				objectCount: countResultObjects(result.data),
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
				auth: {
					username: resolved.auth.username,
					passwordProvided: resolved.auth.passwordProvided,
				},
			},
		},
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

	const cdbResolution = await resolveCdb(
		{
			targetInput: request.targetInput,
			cdbFile: request.cdbFile,
			cdbPassword: request.cdbPassword,
		},
		env,
	);

	const via = resolveProtocol(request, env, cdbResolution);
	const format = resolveFormat(request, env);
	const validate = resolveBooleanSetting(
		request.validate,
		env,
		"CENTRS_VALIDATE",
		true,
		"validate",
		cdbResolution?.overrides.validate,
	);
	const timeoutMs = resolveTimeoutSetting(
		request.timeout,
		env,
		via.value,
		cdbResolution?.overrides.timeoutMs,
	);
	const maxResultsBytes = resolveOptionalIntegerSetting(
		request.maxResultsBytes,
		env,
		"CENTRS_MAX_RESULTS",
		"max-results",
	);
	const target = resolveTarget(
		{
			targetInput: request.targetInput,
			host: request.host,
			port: request.port,
		},
		env,
		via.value,
		cdbResolution,
	);
	const auth = resolveAuth(
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
		maxResultsBytes,
		attributes: attributeSelections,
		allAttributes: request.allAttributes ?? false,
		listAttributes: request.listAttributes ?? false,
		verbose: request.verbose ?? false,
		warnings: cdbResolution?.warnings ?? [],
	};
}

function resolveProtocol(
	request: RetrieveRequest,
	env: Record<string, string | undefined>,
	cdb?: CdbResolution,
): ResolvedSetting<RouterOsProtocol> {
	const via = resolveStringSetting(
		request.via,
		env,
		"CENTRS_VIA",
		"rest-api",
		"via",
		undefined,
		cdb?.overrides.via,
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

/**
 * Path-existence probe. An invalid path raises a native `routeros/api-trap`
 * (REST instead returns an empty child list); normalize both to an empty list
 * so the orchestrator surfaces a single `validation/unknown-path`. Traps during
 * attribute/completion discovery are NOT swallowed — they surface as-is.
 */
async function inspectChildrenForProbe(
	backend: ProtocolAdapter,
	path: string,
): Promise<unknown[]> {
	try {
		return await backend.inspect("child", path);
	} catch (error) {
		if (error instanceof CentrsError && error.code === "routeros/api-trap") {
			return [];
		}
		throw error;
	}
}

async function inspectRetrievePath(
	resolved: ResolvedRetrieveRequest,
	backend: ProtocolAdapter,
): Promise<RetrieveInspection> {
	const pathTokens = pathTokensForInspect(resolved.path);
	const rootChildren = (await inspectChildrenForProbe(
		backend,
		pathToInspectString(pathTokens),
	)) as InspectChildItem[];

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
	backend: ProtocolAdapter,
): Promise<string[]> {
	const pathTokens = pathTokensForInspect(resolved.path);
	const argument = inspection.command === "get" ? "value-name" : "proplist";
	const completionRows = (await backend.inspect(
		"completion",
		pathToInspectString([...pathTokens, inspection.command, argument]),
	)) as InspectCompletionItem[];
	const completions = extractCompletionNames(completionRows);
	if (completions.length > 0) {
		return completions;
	}

	const commandChildren = (await backend.inspect(
		"child",
		pathToInspectString([...pathTokens, inspection.command]),
	)) as InspectChildItem[];
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
): Promise<unknown> {
	if (isKnownSingletonPath(resolved.path)) {
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

function resolveTimeoutSetting(
	timeout: RetrieveRequest["timeout"],
	env: Record<string, string | undefined>,
	via: RouterOsProtocol,
	commentKv?: ResolvedSetting<number>,
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

function pathToInspectString(path: readonly string[]): string {
	return path.join(",");
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
