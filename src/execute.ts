import type {
	CentrsEnvelope,
	CentrsErrorEnvelope,
	CentrsSuccessEnvelope,
	CommonSettingsMeta,
	SettingSource as CoreSettingSource,
	EnvelopeValidationMeta,
	Warning,
} from "./core/envelope.ts";
import { mapRouterOsError } from "./core/routeros-errors.ts";
import { CentrsError, serializeCentrsError } from "./errors.ts";
import {
	createProtocolAdapter,
	getProtocolPlan,
	type ProtocolAdapter,
	type ProtocolExecuteResult,
	plannedProtocols,
	type RouterOsProtocol,
} from "./protocols/index.ts";
import {
	type CdbResolution,
	effectiveHostCandidate,
	isIpTransport,
	isMacAddress,
	parseDuration,
	parseResolvePolicy,
	type ResolvedAuth,
	type ResolvedSetting,
	type ResolvedTarget,
	resolveAuth,
	resolveBooleanSetting,
	resolveCdb,
	resolveMacTarget,
	resolveOptionalIntegerSetting,
	resolveStringSetting,
	resolveTarget,
	toCoreSource,
} from "./resolver/index.ts";
import { toYaml } from "./retrieve.ts";

export const executeOutputFormats = ["text", "json", "yaml"] as const;
export type ExecuteOutputFormat = (typeof executeOutputFormats)[number];

export interface ExecuteRequest {
	targetInput?: string;
	command: string;
	via?: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	timeout?: string | number;
	format?: string;
	validate?: boolean;
	verbose?: boolean;
	yes?: boolean;
	maxResultsBytes?: number;
	cdbFile?: string;
	cdbPassword?: string;
	/** Opt-in host ARP resolution for a MAC target (`none` default, or `arp`). */
	resolve?: string;
	stdinIsTty?: boolean;
	confirm?: (prompt: string) => Promise<boolean>;
}

export interface ExecuteRequestSummary {
	command: string;
	canonical?: CanonicalExecuteCommand;
	write: boolean;
	yes: boolean;
	validate: boolean;
	verbose: boolean;
	timeoutMs: number;
	format: ExecuteOutputFormat;
	maxResultsBytes?: number;
}

export interface ExecuteOperationMeta {
	kind: "execute";
	objectCount: number;
	request: ExecuteRequestSummary;
	auth: {
		username?: string;
		passwordProvided: boolean;
	};
}

export type ExecuteEnvelope = CentrsEnvelope<unknown, ExecuteOperationMeta>;
export type ExecuteSuccessEnvelope = CentrsSuccessEnvelope<
	unknown,
	ExecuteOperationMeta
>;
export type ExecuteErrorEnvelope = CentrsErrorEnvelope<ExecuteOperationMeta>;

export interface CanonicalExecuteCommand {
	mode: "structured" | "script";
	input: string;
	path: string;
	verb: string;
	attributes: Record<string, string>;
	queries: string[];
}

export interface ResolvedExecuteRequest {
	command: string;
	canonical: CanonicalExecuteCommand;
	via: ResolvedSetting<RouterOsProtocol>;
	target: ResolvedTarget;
	auth: ResolvedAuth;
	timeoutMs: ResolvedSetting<number>;
	format: ResolvedSetting<ExecuteOutputFormat>;
	validate: ResolvedSetting<boolean>;
	maxResultsBytes?: ResolvedSetting<number>;
	yes: boolean;
	verbose: boolean;
	warnings: readonly Warning[];
}

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

export async function execute(
	request: ExecuteRequest,
	env: Record<string, string | undefined> = Bun.env,
): Promise<ExecuteSuccessEnvelope> {
	const envelope = await executeEnvelope(request, env);
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

export async function executeEnvelope(
	request: ExecuteRequest,
	env: Record<string, string | undefined> = Bun.env,
): Promise<ExecuteEnvelope> {
	let resolved: ResolvedExecuteRequest | undefined;
	try {
		resolved = await resolveExecuteRequest(request, env);
		await assertWriteConfirmed(request, resolved);
		return await runResolvedExecute(resolved);
	} catch (error) {
		return resolved
			? buildExecuteErrorEnvelopeFromResolved(resolved, error)
			: buildExecuteErrorEnvelope(request, error, env);
	}
}

/**
 * Dry-run a command through validation only (`:parse` + `/console/inspect`)
 * without ever running it. Used by the MCP `centrs_validate` tool: it shares the
 * exact validation path `executeEnvelope` uses so a dry-run and a real run agree
 * on what is acceptable, but it never reaches the mutate/read step. Validation is
 * forced on regardless of any `validate=false` setting — a validate tool that can
 * be told not to validate is pointless.
 */
export async function validateExecuteEnvelope(
	request: ExecuteRequest,
	env: Record<string, string | undefined> = Bun.env,
): Promise<ExecuteEnvelope> {
	let resolved: ResolvedExecuteRequest | undefined;
	try {
		resolved = await resolveExecuteRequest({ ...request, validate: true }, env);
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
			const validation = await validateExecuteCommand(resolved, backend);
			return {
				ok: true,
				data: null,
				warnings: [...resolved.warnings],
				tips: [],
				meta: metaFromResolved(resolved, validation),
			};
		} finally {
			await backend.close();
		}
	} catch (error) {
		return resolved
			? buildExecuteErrorEnvelopeFromResolved(resolved, error)
			: buildExecuteErrorEnvelope(request, error, env);
	}
}

export async function runResolvedExecute(
	resolved: ResolvedExecuteRequest,
): Promise<ExecuteSuccessEnvelope> {
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

	let validation: EnvelopeValidationMeta = {
		enabled: resolved.validate.value,
		source: resolved.validate.value
			? ":put [:parse] + /console/inspect"
			: "disabled",
		result: resolved.validate.value ? "passed" : "skipped",
	};

	try {
		if (resolved.validate.value) {
			validation = await validateExecuteCommand(resolved, backend);
		} else {
			validation = {
				enabled: false,
				source: "disabled",
				result: "skipped",
				syntax: false,
				semantic: false,
			};
		}

		const result = await runCommand(resolved, backend);
		const routerOsFailure = routerOsFailureFromResult(
			result,
			resolved.via.value,
		);
		if (routerOsFailure) {
			throw routerOsFailure;
		}
		const data = dataFromResult(result);
		return applyMaxResultsBudget({
			ok: true,
			data,
			warnings: [...resolved.warnings],
			tips: [],
			meta: metaFromResolved(resolved, validation, data),
		});
	} finally {
		await backend.close();
	}
}

export async function resolveExecuteRequest(
	request: ExecuteRequest,
	env: Record<string, string | undefined>,
): Promise<ResolvedExecuteRequest> {
	validateExecuteRequestShape(request);
	const canonical = canonicalizeExecuteCommand(request.command);
	const cdbResolution = await resolveCdb(
		{
			targetInput: request.targetInput,
			cdbFile: request.cdbFile,
			cdbPassword: request.cdbPassword,
		},
		env,
	);
	const via = resolveExecuteProtocol(request, env, cdbResolution);
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
	const macResolution = isIpTransport(via.value)
		? await resolveMacTarget({
				host: request.host,
				targetInput: request.targetInput,
				cdbTarget: cdbResolution?.target,
				env,
				policy: parseResolvePolicy(request.resolve ?? env["CENTRS_RESOLVE"]),
				operation: "execute",
			})
		: undefined;
	const target = resolveTarget(
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
	const auth = resolveAuth(
		{ username: request.username, password: request.password },
		env,
		cdbResolution,
	);

	return {
		command: request.command,
		canonical,
		via,
		target,
		auth,
		timeoutMs,
		format,
		validate,
		maxResultsBytes,
		yes: request.yes ?? false,
		verbose: request.verbose ?? false,
		warnings: cdbResolution?.warnings ?? [],
	};
}

export function buildExecuteErrorEnvelope(
	request: ExecuteRequest,
	error: unknown,
	env: Record<string, string | undefined> = Bun.env,
): ExecuteErrorEnvelope {
	const centrsError =
		error instanceof CentrsError
			? error
			: new CentrsError({
					code: "internal/unhandled",
					summary: "execute failed with an unexpected internal error.",
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
			operation: {
				kind: "execute",
				objectCount: 0,
				request: {
					command: request.command,
					write: false,
					yes: request.yes ?? false,
					validate: request.validate ?? true,
					verbose: request.verbose ?? false,
					timeoutMs: 10_000,
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

export function buildExecuteErrorEnvelopeFromResolved(
	resolved: ResolvedExecuteRequest,
	error: unknown,
	validation?: EnvelopeValidationMeta,
): ExecuteErrorEnvelope {
	const centrsError =
		error instanceof CentrsError
			? error
			: new CentrsError({
					code: "internal/unhandled",
					summary: "execute failed with an unexpected internal error.",
					remediation:
						"Re-run with `--format json` to capture the structured error details for debugging.",
					cause: error,
				});
	return {
		ok: false,
		error: serializeCentrsError(centrsError),
		warnings: [...resolved.warnings],
		tips: [],
		meta: metaFromResolved(
			resolved,
			validation ?? {
				enabled: resolved.validate.value,
				source: resolved.validate.value
					? ":put [:parse] + /console/inspect"
					: "disabled",
				result: resolved.validate.value ? "failed" : "skipped",
				syntax: resolved.validate.value,
				semantic: resolved.validate.value
					? resolved.canonical.mode === "structured"
						? false
						: "not-applicable"
					: false,
			},
		),
	};
}

export function renderExecuteEnvelope(
	envelope: ExecuteEnvelope,
	format: ExecuteOutputFormat,
	options: { verbose?: boolean } = {},
): string {
	switch (format) {
		case "json":
			return JSON.stringify(envelope, null, 2);
		case "yaml":
			return toYaml(envelope);
		case "text":
			return envelope.ok
				? renderExecuteSuccessText(envelope, options)
				: renderExecuteErrorText(envelope, options);
		default:
			return exhaustiveOutputFormat(format);
	}
}

export function canonicalizeExecuteCommand(
	input: string,
): CanonicalExecuteCommand {
	const asScript = (): CanonicalExecuteCommand => ({
		mode: "script",
		input,
		path: "",
		verb: "",
		attributes: {},
		queries: [],
	});

	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) {
		return asScript();
	}

	const tokens = tokenizeRouterOsCli(trimmed);
	const pathToken = tokens[0] ?? "";
	const pathParts = pathToken.split("/").filter(Boolean);
	if (pathParts.length < 2) {
		return asScript();
	}

	const verb = pathParts.at(-1) ?? "";
	const path = `/${pathParts.slice(0, -1).join("/")}`;
	const attributes: Record<string, string> = {};
	const queries: string[] = [];
	for (const token of tokens.slice(1)) {
		// `[...]` subshell selectors (e.g. `numbers=[find ...]`) cannot be
		// represented as a structured attribute map: the inner command contains
		// spaces this tokenizer splits on, which would mangle a write-shaped
		// command into corrupt key=value pairs. Fall back to the raw-script path
		// so RouterOS evaluates the subshell with its real semantics.
		if (token.includes("[") || token.includes("]")) {
			return asScript();
		}
		if (token.startsWith("?")) {
			queries.push(token);
			continue;
		}
		const separator = token.indexOf("=");
		if (separator <= 0) {
			return asScript();
		}
		attributes[token.slice(0, separator)] = token.slice(separator + 1);
	}

	return {
		mode: "structured",
		input,
		path,
		verb,
		attributes,
		queries,
	};
}

export function isWriteShaped(command: CanonicalExecuteCommand): boolean {
	return (
		command.mode === "structured" &&
		["add", "set", "remove"].includes(command.verb)
	);
}

export function validateExecuteRequestShape(request: ExecuteRequest): void {
	if (!request.command || request.command.trim().length === 0) {
		throw new CentrsError({
			code: "input/invalid-command",
			summary: "`centrs execute` requires a RouterOS command string.",
			remediation:
				"Pass a RouterOS CLI command such as `/ip/address/add address=198.51.100.1/32 interface=ether1`.",
		});
	}
}

async function validateExecuteCommand(
	resolved: ResolvedExecuteRequest,
	backend: ProtocolAdapter,
): Promise<EnvelopeValidationMeta> {
	await runSyntaxGate(resolved, backend);

	if (resolved.canonical.mode !== "structured") {
		return {
			enabled: true,
			source: ":put [:parse]",
			result: "passed",
			syntax: true,
			semantic: "not-applicable",
		};
	}

	const availableAttributes = await inspectExecuteAttributes(resolved, backend);
	const requested = Object.keys(resolved.canonical.attributes);
	const missing = requested.filter(
		(attribute) => !availableAttributes.includes(attribute),
	);
	if (missing.length > 0) {
		throw new CentrsError({
			code: "validation/unknown-attribute",
			summary: `Unknown RouterOS attribute ${missing.join(", ")} for ${resolved.canonical.path}/${resolved.canonical.verb}.`,
			remediation:
				"Check the attribute name against `/console/inspect`, or use `--validate=false` only when intentionally probing an undocumented RouterOS edge.",
			context: {
				path: resolved.canonical.path,
				verb: resolved.canonical.verb,
				attribute: missing[0],
				requestedAttributes: requested,
				availableAttributes,
				validationSource: "/console/inspect request=child+completion",
			},
		});
	}

	return {
		enabled: true,
		source: ":put [:parse] + /console/inspect",
		result: "passed",
		syntax: true,
		semantic: true,
		availableAttributes,
	};
}

async function runSyntaxGate(
	resolved: ResolvedExecuteRequest,
	backend: ProtocolAdapter,
): Promise<void> {
	if (hasUnbalancedQuotes(resolved.command)) {
		throw new CentrsError({
			code: "validation/syntax",
			summary:
				"RouterOS rejected the command syntax during local quote preflight.",
			remediation:
				"Close the RouterOS string quote, then retry. The command was not executed.",
			context: {
				command: resolved.command,
				validationSource: "local quote preflight before :put [:parse ...]",
				via: resolved.via.value,
			},
			causeData: "unterminated string literal",
		});
	}
	const script = `:put [:parse ${routerOsStringLiteral(resolved.command)}]`;
	try {
		await backend.execute({ path: "", command: "", script });
	} catch (error) {
		// The preflight is a syntax gate, but `backend.execute` also surfaces
		// connection and authentication failures (login happens lazily here).
		// Those are not syntax problems — rethrow them unchanged so the caller
		// sees the real `transport/*` cause instead of a misleading
		// `validation/syntax`. Only genuine RouterOS parse rejections (mapped to
		// `routeros/*`) are relabeled as a syntax failure below.
		if (error instanceof CentrsError && isPreflightTransportError(error)) {
			throw error;
		}
		throw new CentrsError({
			code: "validation/syntax",
			summary:
				"RouterOS rejected the command syntax during `:parse` preflight.",
			remediation:
				"Fix the RouterOS CLI syntax, especially quotes and bracketed expressions, then retry.",
			context: {
				command: resolved.command,
				validationSource: ":put [:parse ...]",
				via: resolved.via.value,
			},
			cause: error,
			causeData: syntaxCause(error),
		});
	}
}

/**
 * True when a `:parse` preflight error is actually a transport/auth/connection
 * failure rather than a RouterOS syntax rejection. These must not be relabeled
 * as `validation/syntax`.
 */
function isPreflightTransportError(error: CentrsError): boolean {
	return error.code.startsWith("transport/") || error.code.startsWith("auth/");
}

async function inspectExecuteAttributes(
	resolved: ResolvedExecuteRequest,
	backend: ProtocolAdapter,
): Promise<string[]> {
	const commandPath = inspectPath([
		...pathTokens(resolved.canonical.path),
		resolved.canonical.verb,
	]);
	const children = (await backend.inspect(
		"child",
		commandPath,
	)) as InspectChildItem[];
	const childAttributes = children
		.filter(isArgumentNode)
		.map((child) => child.name)
		.filter(
			(name): name is string => typeof name === "string" && name.length > 0,
		);
	const completionRows = (await backend.inspect(
		"completion",
		commandPath,
	)) as InspectCompletionItem[];
	return [
		...new Set([...childAttributes, ...extractCompletionNames(completionRows)]),
	].sort();
}

async function runCommand(
	resolved: ResolvedExecuteRequest,
	backend: ProtocolAdapter,
): Promise<ProtocolExecuteResult> {
	if (resolved.canonical.mode === "script") {
		if (resolved.via.value === "native-api") {
			throw new CentrsError({
				code: "transport/unsupported-operation",
				summary:
					"The native API execute path requires a slash-prefixed RouterOS command.",
				remediation:
					"Use a path-shaped command such as `/system/identity/set name=x`, or pin `--via rest-api` for `/rest/execute` script mode.",
				context: { via: resolved.via.value, command: resolved.command },
			});
		}
		return backend.execute({ path: "", command: "", script: resolved.command });
	}
	return backend.execute({
		path: resolved.canonical.path,
		command: resolved.canonical.verb,
		attributes: resolved.canonical.attributes,
		queries: resolved.canonical.queries,
	});
}

async function assertWriteConfirmed(
	request: ExecuteRequest,
	resolved: ResolvedExecuteRequest,
): Promise<void> {
	if (!isWriteShaped(resolved.canonical) || resolved.yes) {
		return;
	}
	if (request.stdinIsTty ?? process.stdin.isTTY) {
		const confirmed = await (request.confirm ?? promptForWriteConfirmation)(
			`Run write-shaped RouterOS command over ${resolved.via.value}? Type yes to continue: `,
		);
		if (confirmed) {
			return;
		}
	}
	throw new CentrsError({
		code: "usage/confirmation-required",
		summary:
			"Write-shaped RouterOS execute commands require explicit confirmation.",
		remediation:
			"Pass `--yes` in non-interactive automation, or answer `yes` at the TTY prompt after reviewing the command.",
		context: {
			command: resolved.command,
			path: resolved.canonical.path,
			verb: resolved.canonical.verb,
			via: resolved.via.value,
		},
	});
}

async function promptForWriteConfirmation(prompt: string): Promise<boolean> {
	process.stderr.write(prompt);
	for await (const chunk of Bun.stdin.stream()) {
		const answer = new TextDecoder().decode(chunk).trim().toLowerCase();
		return answer === "yes" || answer === "y";
	}
	return false;
}

function resolveExecuteProtocol(
	request: ExecuteRequest,
	env: Record<string, string | undefined>,
	cdb?: CdbResolution,
): ResolvedSetting<RouterOsProtocol> {
	const defaultVia = isUnresolvedMacTarget(request, env, cdb)
		? "mac-telnet"
		: "native-api";
	const via = resolveStringSetting(
		request.via,
		env,
		"CENTRS_VIA",
		defaultVia,
		"via",
		undefined,
		cdb?.overrides.via,
	);
	if (!via) {
		throw new CentrsError({
			code: "internal/unhandled",
			summary: "Failed to resolve the default execute protocol.",
			remediation:
				"Report this bug; execute should default to native-api or mac-telnet.",
		});
	}
	if (!plannedProtocols.includes(via.value as RouterOsProtocol)) {
		throw new CentrsError({
			code: "settings/invalid-via",
			summary: `Unsupported protocol identifier: ${via.value}`,
			remediation:
				"Choose one of the known `via` values, such as `native-api` or `rest-api` for execute.",
			context: { via: via.value },
		});
	}
	const plan = getProtocolPlan(via.value as RouterOsProtocol);
	if (!plan.capabilities.includes("execute")) {
		throw new CentrsError({
			code: "routeros/unsupported-capability",
			summary: `Protocol ${via.value} does not support the execute capability.`,
			remediation:
				"Choose an execute-capable protocol such as `native-api`, `rest-api`, or `mac-telnet`.",
			context: { via: via.value, capability: "execute" },
		});
	}
	if (!["native-api", "rest-api"].includes(via.value)) {
		throw new CentrsError({
			code: "routeros/protocol-not-implemented",
			summary: `Execute over ${via.value} is planned but not wired through the shared execute orchestrator yet.`,
			remediation:
				"Use `--via native-api` or `--via rest-api`. For a MAC target, add `--resolve arp` to reach it via the host ARP cache.",
			context: { via: via.value, capability: "execute" },
		});
	}
	return via as ResolvedSetting<RouterOsProtocol>;
}

function isUnresolvedMacTarget(
	request: ExecuteRequest,
	env: Record<string, string | undefined>,
	cdb?: CdbResolution,
): boolean {
	if (request.via !== undefined || env["CENTRS_VIA"] !== undefined) {
		return false;
	}
	// Decide the default transport from the *effective* target (host >
	// CENTRS_HOST > CDB target > positional), not the positional alone — an IP
	// supplied via --host/CENTRS_HOST must default to native-api even when the
	// positional was a MAC.
	const candidate = effectiveHostCandidate({
		host: request.host,
		targetInput: request.targetInput,
		cdbTarget: cdb?.target,
		env,
	});
	return candidate ? isMacAddress(candidate) : false;
}

function resolveFormat(
	request: ExecuteRequest,
	env: Record<string, string | undefined>,
): ResolvedSetting<ExecuteOutputFormat> {
	return resolveStringSetting(
		request.format,
		env,
		"CENTRS_FORMAT",
		"text",
		"format",
		parseOutputFormat,
	) as ResolvedSetting<ExecuteOutputFormat>;
}

/**
 * Resolve the render format for an error envelope built before settings were
 * resolved. Honors `--format`/`CENTRS_FORMAT` like {@link resolveFormat} but
 * never throws on a bad value (the original error must surface), defaulting to
 * the human-readable `text` form.
 */
function resolveErrorFormat(
	request: ExecuteRequest,
	env: Record<string, string | undefined>,
): ExecuteOutputFormat {
	try {
		return resolveFormat(request, env).value;
	} catch {
		return "text";
	}
}

function resolveTimeoutSetting(
	timeout: ExecuteRequest["timeout"],
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
				"Use `--timeout 60s` or less for the current REST execute path.",
			context: { via, timeoutMs: resolved.value, ceilingMs: 60_000 },
		});
	}
	return resolved;
}

function metaFromResolved(
	resolved: ResolvedExecuteRequest,
	validation: EnvelopeValidationMeta,
	data?: unknown,
): ExecuteEnvelope["meta"] {
	const target = resolved.target;
	const targetSources: Record<string, CoreSettingSource> = {};
	for (const [field, source] of Object.entries(target.sources)) {
		targetSources[field] = toCoreSource(source);
	}
	const operation: ExecuteOperationMeta = {
		kind: "execute",
		objectCount: countResultObjects(data),
		request: executeRequestSummary(resolved),
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

function settingsMeta(resolved: ResolvedExecuteRequest): CommonSettingsMeta {
	return {
		via: toCoreSource(resolved.via.source),
		host: toCoreSource(resolved.target.hostSource),
		port: toCoreSource(resolved.target.portSource),
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
	};
}

function executeRequestSummary(
	resolved: ResolvedExecuteRequest,
): ExecuteRequestSummary {
	return {
		command: resolved.command,
		canonical: resolved.canonical,
		write: isWriteShaped(resolved.canonical),
		yes: resolved.yes,
		validate: resolved.validate.value,
		verbose: resolved.verbose,
		timeoutMs: resolved.timeoutMs.value,
		format: resolved.format.value,
		maxResultsBytes: resolved.maxResultsBytes?.value,
	};
}

function dataFromResult(result: ProtocolExecuteResult): unknown {
	if (result.ret !== undefined) {
		const data: Record<string, string> = { ret: result.ret };
		if (/^\*[0-9A-F]+$/i.test(result.ret)) {
			data[".id"] = result.ret;
		}
		return data;
	}
	if (result.records.length === 0) {
		return {};
	}
	if (result.records.length === 1) {
		const record = result.records[0] ?? {};
		const ret = record["ret"];
		if (typeof ret === "string" && /^\*[0-9A-F]+$/i.test(ret)) {
			return { ...record, ".id": ret };
		}
		return record;
	}
	return result.records;
}

function routerOsFailureFromResult(
	result: ProtocolExecuteResult,
	via: RouterOsProtocol,
): CentrsError | undefined {
	const candidates = [
		result.ret,
		...result.records.flatMap((record) => [
			record["detail"],
			record["message"],
			record["failure"],
			record["error"],
			record["ret"],
		]),
	].filter((value): value is string => typeof value === "string");
	const failure = candidates.find((candidate) =>
		isRouterOsFailureString(candidate),
	);
	return failure
		? mapRouterOsError(failure, {
				transport: via === "rest-api" ? "rest-api" : "native-api",
				context: { via },
			})
		: undefined;
}

function isRouterOsFailureString(value: string): boolean {
	return /^(failure:|error:)|unknown parameter|invalid value|session closed|\(:error; line \d+\)/i.test(
		value.trim(),
	);
}

function applyMaxResultsBudget(
	envelope: ExecuteSuccessEnvelope,
): ExecuteSuccessEnvelope {
	const request = envelope.meta.operation?.request;
	if (!request?.maxResultsBytes) {
		return envelope;
	}
	const rendered = renderExecuteEnvelope(envelope, request.format, {
		verbose: request.format === "text" && request.verbose,
	});
	const serializedBytes = new TextEncoder().encode(rendered).length;
	if (serializedBytes > request.maxResultsBytes) {
		throw new CentrsError({
			code: "input/max-results-exceeded",
			summary: `execute output exceeded the requested ${request.maxResultsBytes}-byte budget.`,
			remediation:
				"Increase `--max-results`, reduce command output, or switch to a narrower command.",
			context: {
				requiredBytes: serializedBytes,
				maxResultsBytes: request.maxResultsBytes,
				command: request.command,
			},
		});
	}
	return envelope;
}

function renderExecuteSuccessText(
	envelope: ExecuteSuccessEnvelope,
	options: { verbose?: boolean },
): string {
	const lines: string[] = [];
	if (options.verbose) {
		lines.push(
			`target: ${envelope.meta.target.input ?? envelope.meta.target.host}`,
		);
		lines.push(`via: ${envelope.meta.via}`);
		if (envelope.meta.validation?.source) {
			lines.push(`validation: ${envelope.meta.validation.source}`);
		}
		lines.push("");
	}
	if (typeof envelope.data === "string") {
		lines.push(envelope.data);
	} else {
		lines.push(JSON.stringify(envelope.data, null, 2));
	}
	return lines.join("\n");
}

function renderExecuteErrorText(
	envelope: ExecuteErrorEnvelope,
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

function hasUnbalancedQuotes(input: string): boolean {
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const char of input) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
		}
	}
	return quote !== undefined;
}

function tokenizeRouterOsCli(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const char of input) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (escaped) {
		current += "\\";
	}
	if (current.length > 0) {
		tokens.push(current);
	}
	return tokens;
}

function routerOsStringLiteral(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function syntaxCause(error: unknown): unknown {
	if (error instanceof CentrsError) {
		return error.causeData ?? error.context ?? error.toJSON();
	}
	return error;
}

function pathTokens(path: string): string[] {
	return path.split("/").filter(Boolean);
}

function inspectPath(tokens: readonly string[]): string {
	return tokens.join(",");
}

function isArgumentNode(child: InspectChildItem): boolean {
	return child.type === "arg" || child["node-type"] === "arg";
}

function extractCompletionNames(
	rows: readonly InspectCompletionItem[],
): string[] {
	return rows
		.flatMap((row) => [row.completion, row.name, row.value, row.text])
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.replace(/=.*$/, "").trim())
		.filter((value) => value.length > 0);
}

function parseOutputFormat(value: string): ExecuteOutputFormat {
	if (executeOutputFormats.includes(value as ExecuteOutputFormat)) {
		return value as ExecuteOutputFormat;
	}
	throw new CentrsError({
		code: "settings/invalid-format",
		summary: `Unsupported output format: ${value}`,
		remediation: `Choose one of ${executeOutputFormats.join(", ")}.`,
	});
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

function exhaustiveOutputFormat(value: never): never {
	throw new Error(`Unhandled execute output format: ${String(value)}`);
}
