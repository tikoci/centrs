/** Read-only device evidence for explain (#491). Kept out of the browser entry. */
import { createHash } from "node:crypto";
import {
	type ApiRequest,
	type ResolvedApiRequest,
	resolveApiRequest,
} from "./api.ts";
import {
	type InspectChildItem,
	isArgumentNode,
	pathTokens,
} from "./core/inspect.ts";
import { routerOsVersionAtLeast } from "./core/preflight.ts";
import { routerOsStringLiteral } from "./core/routeros-string.ts";
import { CentrsError } from "./errors.ts";
import { analyzeCoordinates } from "./explain/coordinates.ts";
import {
	buildExplainErrorEnvelope,
	compareExplainDiagnostics,
	type ExplainData,
	type ExplainEnvelope,
	type ExplainEnvelopeOptions,
	type ExplainErrorEnvelope,
	type ExplainEvidence,
	type ExplainSpanClass,
	type ExplainSpanRange,
	explainEnvelope,
} from "./explain.ts";
import {
	createProtocolAdapter,
	type ProtocolAdapter,
} from "./protocols/index.ts";
import { classifyParseResult } from "./protocols/mac-telnet-console.ts";
import { redactTargetInput, toCoreSource } from "./resolver/index.ts";

export interface ExplainLiveRequest
	extends Pick<
		ApiRequest,
		| "targetInput"
		| "quickchr"
		| "via"
		| "host"
		| "port"
		| "username"
		| "password"
		| "insecure"
		| "timeout"
		| "cdbFile"
		| "cdbPassword"
		| "resolve"
	> {
	input: string;
	signal?: AbortSignal;
}

/** Hard work bounds. Oversize probes are skipped, never silently truncated. */
export const EXPLAIN_LIVE_LIMITS = {
	highlightBytes: 32767,
	parseBytes: 65536,
	commandPaths: 32,
} as const;

/** Refuse competing target sources before reading input or resolving a device. */
export function assertExplainTarget(
	request: Pick<ExplainLiveRequest, "targetInput" | "quickchr">,
): void {
	if (request.quickchr !== undefined && request.targetInput !== undefined)
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary:
				"--quickchr cannot be combined with a positional or library target.",
			remediation: "Choose either one --quickchr machine or one target.",
		});
}

/** The shared resolver is used for connection settings only; no api request runs. */
export async function explainLiveEnvelope(
	request: ExplainLiveRequest,
	options: ExplainEnvelopeOptions = {},
	env: Record<string, string | undefined> = Bun.env,
): Promise<ExplainEnvelope | ExplainErrorEnvelope> {
	let resolved: ResolvedApiRequest | undefined;
	try {
		assertExplainTarget(request);
		resolved = await resolveApiRequest(
			{
				...request,
				endpoint: "/system/resource",
				format: options.format?.value,
				validate: true,
			},
			env,
		);
		const backend = createProtocolAdapter({
			protocol: resolved.via.value,
			...resolved.target,
			username: resolved.auth.username,
			password: resolved.auth.password,
			timeoutMs: resolved.timeoutMs.value,
			insecure: resolved.insecure.value,
			signal: request.signal,
		});
		try {
			const envelope = explainEnvelope(request.input, options);
			envelope.tips = envelope.tips.filter(
				(tip) => tip.code !== "tip/explain-offline-only",
			);
			await collectExplainEvidence(
				envelope.data,
				request.input,
				backend,
				request.signal,
			);
			const probes = envelope.data.evidence.filter(
				(e) => e.source === "live-inspect",
			);
			const failure = probes.find((e) =>
				["auth-error", "transport-error", "timeout", "interrupted"].includes(
					e.outcome,
				),
			);
			if (
				failure &&
				!probes.some(
					(e) =>
						e.probe !== "/system/resource" &&
						(e.outcome === "ok" || e.outcome === "empty"),
				)
			) {
				throw new CentrsError({
					code: failure.errorCode ?? "transport/connection-closed",
					summary:
						failure.reason ??
						"Live explain was interrupted before collecting device evidence.",
					remediation:
						"Check the target, credentials and timeout, then retry; omit the target for offline analysis.",
				});
			}
			envelope.warnings = [...envelope.warnings, ...resolved.warnings];
			envelope.meta = liveMeta(resolved, envelope.data, options.format);
			return envelope;
		} finally {
			await backend.close();
		}
	} catch (error) {
		const envelope = buildExplainErrorEnvelope(error, [], options.format);
		if (resolved)
			envelope.meta = {
				...liveMeta(resolved, undefined, options.format),
				operation: undefined,
			};
		else
			envelope.meta.target = { input: redactTargetInput(request.targetInput) };
		return envelope;
	}
}

function liveMeta(
	resolved: ResolvedApiRequest,
	data?: ExplainData,
	format?: ExplainEnvelopeOptions["format"],
): ExplainEnvelope["meta"] {
	const target = resolved.target;
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
			sources: Object.fromEntries(
				Object.entries(target.sources).map(([key, value]) => [
					key,
					toCoreSource(value),
				]),
			),
		},
		via: resolved.via.value,
		settings: {
			via: toCoreSource(resolved.via.source),
			host: toCoreSource(target.hostSource),
			port: toCoreSource(target.portSource),
			timeoutMs: toCoreSource(resolved.timeoutMs.source),
			format: toCoreSource(format?.source ?? resolved.format.source),
			insecure: toCoreSource(resolved.insecure.source),
			username: resolved.auth.usernameSource
				? toCoreSource(resolved.auth.usernameSource)
				: undefined,
			password: resolved.auth.passwordSource
				? toCoreSource(resolved.auth.passwordSource)
				: undefined,
		},
		...(data
			? {
					operation: {
						command: "explain" as const,
						mode: "live" as const,
						statementCount: data.structure.statementCount,
						verdict: data.verdict,
					},
				}
			: {}),
	};
}

/** Transport seam for deterministic failure controls; callers normally use explainLiveEnvelope. */
export async function collectExplainEvidence(
	data: ExplainData,
	input: string,
	backend: Pick<
		ProtocolAdapter,
		"getSingleton" | "inspect" | "execute" | "protocol"
	>,
	signal?: AbortSignal,
): Promise<void> {
	const live = { arguments: [] } as NonNullable<ExplainData["live"]>;
	data.live = live;
	let version: string | undefined;
	let stopped = false;
	let evidenceIndex = 0;
	const full = { start: 0, end: data.input.bytes };
	const sha = (text: string) => createHash("sha256").update(text).digest("hex");
	const evidence = (
		probe: string,
		fields: Partial<ExplainEvidence> = {},
	): ExplainEvidence => {
		const entry: ExplainEvidence = {
			id: `live${evidenceIndex++}`,
			source: "live-inspect",
			probe,
			basis: "direct",
			outcome: "ok",
			observedAt: new Date().toISOString(),
			...(version ? { version } : {}),
			...fields,
		};
		data.evidence.push(entry);
		return entry;
	};
	const run = async <T>(
		ev: ExplainEvidence,
		action: () => Promise<T>,
	): Promise<T | undefined> => {
		if (signal?.aborted || stopped) {
			ev.outcome = signal?.aborted ? "interrupted" : "skipped";
			ev.reason = signal?.aborted
				? "caller interrupted the analysis"
				: "a prior transport or authentication probe failed";
			delete ev.coverage;
			return undefined;
		}
		try {
			return await action();
		} catch (error) {
			const code =
				error instanceof CentrsError ? error.code : "internal/unhandled";
			ev.errorCode = code;
			ev.outcome = signal?.aborted
				? "interrupted"
				: code.startsWith("auth/") || code === "transport/auth-failed"
					? "auth-error"
					: code.includes("timeout")
						? "timeout"
						: code.startsWith("transport/")
							? "transport-error"
							: code === "routeros/unknown-path" ||
									code === "routeros/unsupported-capability"
								? "unsupported"
								: "invalid-response";
			ev.reason =
				error instanceof CentrsError
					? error.summary
					: "Probe did not return a usable response.";
			stopped = [
				"auth-error",
				"timeout",
				"transport-error",
				"interrupted",
			].includes(ev.outcome);
			delete ev.coverage;
			return undefined;
		}
	};
	const environment = evidence("/system/resource");
	const resource = await run(environment, () =>
		backend.getSingleton("/system/resource"),
	);
	if (
		resource &&
		typeof resource === "object" &&
		"version" in resource &&
		typeof resource.version === "string"
	) {
		version = resource.version;
		environment.version = version;
		const fields = resource as Record<string, unknown>;
		live.environment = {
			ev: environment.id,
			version,
			architecture:
				typeof fields["architecture-name"] === "string"
					? fields["architecture-name"]
					: undefined,
			board:
				typeof fields["board-name"] === "string"
					? fields["board-name"]
					: undefined,
		};
	} else if (environment.outcome === "ok") {
		environment.outcome = "invalid-response";
		environment.reason =
			"Device version is unavailable; unsafe probes will be skipped.";
	}

	// Both probes operate on data: the only executed script is this escaped :parse wrapper.
	const parse = evidence(":parse", {
		coverage: full,
		inputSha256: sha(input),
		normalization: "original-utf8",
	});
	if (data.input.bytes > EXPLAIN_LIVE_LIMITS.parseBytes) {
		parse.outcome = "skipped";
		parse.reason = `Input exceeds the ${EXPLAIN_LIVE_LIMITS.parseBytes}-byte parse budget.`;
		delete parse.coverage;
	} else {
		const result = await run(parse, () =>
			backend.execute({
				path: "",
				command: "",
				script: `:put [:parse ${routerOsStringLiteral(input)}]`,
			}),
		);
		if (result) {
			if (typeof result.ret !== "string" || result.ret.trim() === "") {
				parse.outcome = "empty";
				delete parse.coverage;
			} else {
				live.parse = { ev: parse.id, output: result.ret, rejected: false };
				try {
					classifyParseResult(result.ret, input, backend.protocol);
				} catch (error) {
					if (!(error instanceof CentrsError)) throw error;
					live.parse.rejected = true;
					live.parse.position = error.position;
					const span = error.position
						? positionSpan(
								input,
								error.position.line,
								error.position.column,
								data.input.bytes,
							)
						: full;
					data.diagnostics.push({
						code: "explain/live-inspect/parse-rejected",
						severity: "error",
						message: error.summary,
						span,
						ev: parse.id,
					});
				}
			}
		}
	}
	const normalized = new TextDecoder().decode(
		analyzeCoordinates(input).analyzed,
	);
	const highlight = evidence("highlight", {
		inputSha256: sha(normalized),
		normalization: "sub-per-non-ascii-byte",
	});
	if (data.input.bytes > EXPLAIN_LIVE_LIMITS.highlightBytes) {
		highlight.outcome = "skipped";
		highlight.reason =
			"Input exceeds the 32,767-byte highlight limit; no prefix was submitted.";
	} else {
		const rows = await run(highlight, () =>
			backend.inspect("highlight", "", normalized),
		);
		if (rows !== undefined) {
			const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
			if (Array.isArray(rows) && rows.length === 0) highlight.outcome = "empty";
			else if (
				!row ||
				typeof row !== "object" ||
				!("highlight" in row) ||
				typeof row.highlight !== "string"
			) {
				highlight.outcome = "invalid-response";
				highlight.reason = "Highlight response has no class stream.";
			} else {
				const classes = row.highlight.split(",");
				if (classes.length !== data.input.bytes) {
					highlight.outcome = "invalid-response";
					highlight.reason =
						"Highlight length does not match submitted bytes; spans were not published.";
				} else {
					highlight.coverage = full;
					live.highlight = { ev: highlight.id, classes };
					for (let start = 0; start < classes.length; ) {
						const raw = classes[start] ?? "none";
						const classification = highlightClass(raw);
						let end = start + 1;
						while (end < classes.length && classes[end] === raw) end++;
						data.spans.push({
							start,
							end,
							class: classification,
							ev: highlight.id,
						});
						if (raw === "error" || raw === "syntax-obsolete")
							data.diagnostics.push({
								code: `explain/live-inspect/${raw === "error" ? "highlight-error" : "obsolete-syntax"}`,
								severity: raw === "error" ? "error" : "warning",
								message:
									raw === "error"
										? "The device highlighter reports an error in the submitted input."
										: "The device marks this spelling as obsolete syntax.",
								span: { start, end },
								ev: highlight.id,
							});
						start = end;
					}
				}
			}
		}
	}
	const paths = new Map<string, string[]>();
	for (const statement of data.structure.statements) {
		if (statement.resolution !== "resolved" || statement.kind !== "command")
			continue;
		const path = `${statement.command.path.replace(/\/$/, "")}/${statement.command.verb}`;
		const ids = paths.get(path) ?? [];
		ids.push(statement.id);
		paths.set(path, ids);
	}
	let queried = 0;
	for (const [path, statementIds] of paths) {
		const ev = evidence("child", { path, statementIds });
		if (++queried > EXPLAIN_LIVE_LIMITS.commandPaths) {
			ev.outcome = "skipped";
			ev.reason = "Command-path discovery budget exhausted.";
			continue;
		}
		// No scripting-keyword path discovery on old/unknown devices. No completion calls at all.
		if (
			pathTokens(path).length === 1 &&
			(!version || !routerOsVersionAtLeast(version, "7.21.4"))
		) {
			ev.outcome = "skipped";
			ev.reason =
				"Scripting-path discovery is disabled before 7.21.4 or when version is unknown.";
			continue;
		}
		const rows = await run(ev, () =>
			backend.inspect("child", pathTokens(path).join(",")),
		);
		if (rows === undefined) continue;
		if (
			!Array.isArray(rows) ||
			rows.some((row) => row === null || typeof row !== "object")
		) {
			ev.outcome = "invalid-response";
			ev.reason = "Child response is not an array of nodes.";
			continue;
		}
		if (rows.length === 0) ev.outcome = "empty";
		const names = [
			...new Set(
				(rows as InspectChildItem[])
					.filter(isArgumentNode)
					.map((row) => row.name)
					.filter(
						(name): name is string =>
							typeof name === "string" && name.length > 0,
					),
			),
		].sort();
		live.arguments.push({ ev: ev.id, path, statementIds, names });
	}
	for (const ev of data.evidence)
		if (ev.source === "live-inspect" && ev.outcome !== "ok") {
			data.diagnostics.push({
				code: `explain/live-inspect/${ev.outcome}`,
				severity: "warning",
				message: `${ev.probe}: ${ev.reason ?? ev.outcome}`,
				span: ev.coverage ?? full,
				ev: ev.id,
			});
		}
	data.diagnostics.sort(compareExplainDiagnostics);
	data.spans.sort((a, b) => a.start - b.start || a.end - b.end);
	data.verdict = data.diagnostics.some((d) => d.severity === "error")
		? "fail"
		: data.diagnostics.some((d) => d.severity === "warning")
			? "warn"
			: "pass";
}

function positionSpan(
	input: string,
	line: number,
	column: number,
	length: number,
): ExplainSpanRange {
	const lines = input.split("\n");
	let offset = 0;
	for (let i = 0; i < Math.min(line - 1, lines.length); i++)
		offset += new TextEncoder().encode(lines[i] ?? "").length + 1;
	const start = Math.min(length, offset + Math.max(0, column - 1));
	return { start, end: Math.min(length, start + 1) };
}

function highlightClass(value: string): ExplainSpanClass {
	switch (value) {
		case "comment":
		case "dir":
		case "cmd":
		case "escaped":
		case "variable-local":
		case "variable-global":
		case "variable-auto":
		case "variable-parameter":
			return value;
		case "arg":
		case "arg-dot":
		case "arg-scope":
			return "arg";
		case "syntax-meta":
			return "unclassified";
		case "syntax-obsolete":
			return "unclassified";
		case "variable-undefined":
			return "unclassified";
		case "obj-disabled":
		case "obj-dynamic":
		case "obj-inactive":
			return "unclassified";
		default:
			return "unclassified";
	}
}
