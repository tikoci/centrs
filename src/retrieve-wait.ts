/** Bounded readiness/condition reads; the router evaluates the shared predicate. */
import { parseQueries, queryErrorForFlag } from "./core/query.ts";
import { CentrsError } from "./errors.ts";
import {
	createProtocolAdapter,
	type ProtocolAdapter,
} from "./protocols/adapter.ts";
import {
	applyMaxResultsBudget,
	buildRetrieveErrorEnvelope,
	buildRetrieveErrorEnvelopeFromResolved,
	buildSuccessEnvelope,
	executeRetrieve,
	isKnownSingletonPath,
	type ResolvedRetrieveRequest,
	type RetrieveEnvelope,
	type RetrieveRequest,
	type RetrieveWaitMeta,
	resolveRetrieveRequest,
	validateRetrieveRead,
} from "./retrieve.ts";

export interface RetrieveWaitOptions {
	signal?: AbortSignal;
}

/** One final envelope, including attempts/observations on failure. No watch frames. */
export async function retrieveWait(
	request: RetrieveRequest,
	env: Record<string, string | undefined> = Bun.env,
	options: RetrieveWaitOptions = {},
): Promise<RetrieveEnvelope> {
	let resolved: ResolvedRetrieveRequest;
	try {
		resolved = await resolveRetrieveRequest(request, env);
		if (!resolved.wait)
			throw new CentrsError({
				code: "usage/conflicting-flags",
				summary: "`retrieveWait()` needs a `wait` deadline.",
				remediation:
					"Set `wait` to an overall duration, e.g. `{ path: '/system/resource', wait: '30s' }`.",
			});
	} catch (error) {
		return buildRetrieveErrorEnvelope(request, error);
	}
	const settings = resolved.wait;
	const startedAt = performance.now();
	const deadline = startedAt + settings.deadlineMs;
	const controller = new AbortController();
	let stopped: "deadline-elapsed" | "interrupted" | undefined;
	const stop = (reason: typeof stopped) => {
		stopped ??= reason;
		controller.abort();
	};
	const onAbort = () => stop("interrupted");
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });
	// Long waits avoid setTimeout's 32-bit overflow; the loop also checks time
	// before dispatch and after each completed observation.
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const armDeadline = () => {
		const remaining = deadline - performance.now();
		if (remaining <= 0) stop("deadline-elapsed");
		else
			deadlineTimer = setTimeout(
				armDeadline,
				Math.min(remaining, 2_147_483_647),
			);
	};
	armDeadline();
	let attempts = 0;
	let observations = 0;
	let backend: ProtocolAdapter | undefined;
	let prepared: Awaited<ReturnType<typeof validateRetrieveRead>> | undefined;
	let lastError: unknown;
	const meta = (
		stopReason: RetrieveWaitMeta["stopReason"],
	): RetrieveWaitMeta => ({
		stopReason,
		elapsedMs: Math.round(performance.now() - startedAt),
		attempts,
		observations,
	});
	const failure = (
		error: unknown,
		reason: RetrieveWaitMeta["stopReason"],
	): RetrieveEnvelope => {
		// The combined device predicate retains selection semantics, but a
		// diagnostic must identify the option that supplied the bad property.
		if (
			error instanceof CentrsError &&
			(error.context?.["flag"] === "--query" ||
				(error.code === "input/invalid-query" &&
					Array.isArray(error.context?.["bareNames"]))) &&
			settings.until.length > 0 &&
			(!resolved.query ||
				(error.context?.["parameter"] !== undefined &&
					!resolved.query.parsed.names.includes(
						String(error.context["parameter"]),
					)) ||
				(Array.isArray(error.context?.["bareNames"]) &&
					error.context["bareNames"].every(
						(name) => !resolved.query?.parsed.bareNames.includes(String(name)),
					)))
		)
			error = queryErrorForFlag(error, "--until");
		const envelope = buildRetrieveErrorEnvelopeFromResolved(resolved, error);
		if (prepared) envelope.meta.validation = prepared.validation;
		else if (attempts === 0)
			envelope.meta.validation = {
				enabled: resolved.validate.value,
				result: "skipped",
			};
		if (envelope.meta.operation) envelope.meta.operation.wait = meta(reason);
		return envelope;
	};
	const condition = settings.until.length > 0 || settings.untilEmpty;
	const expressions = [
		...(resolved.query?.expressions ?? []),
		...settings.until,
	];
	const observationRequest =
		settings.until.length > 0
			? {
					...resolved,
					query: { expressions, parsed: parseQueries(expressions) },
				}
			: resolved;
	try {
		while (!stopped) {
			if (performance.now() >= deadline) {
				stop("deadline-elapsed");
				break;
			}
			const sentAt = performance.now();
			attempts++;
			try {
				backend ??= createProtocolAdapter({
					protocol: resolved.via.value,
					host: resolved.target.host,
					port: resolved.target.port,
					tls: resolved.target.tls,
					baseUrl: resolved.target.baseUrl,
					username: resolved.auth.username,
					password: resolved.auth.password,
					timeoutMs: Math.max(
						1,
						Math.min(resolved.timeoutMs.value, Math.ceil(deadline - sentAt)),
					),
					insecure: resolved.insecure?.value,
					signal: controller.signal,
				});
				prepared ??= await validateRetrieveRead(observationRequest, backend);
				if (
					settings.untilEmpty &&
					(prepared.inspection?.singleton ??
						isKnownSingletonPath(observationRequest.path))
				)
					throw new CentrsError({
						code: "usage/conflicting-flags",
						summary: "`--until-empty` needs a list menu, not a singleton.",
						remediation:
							"Use `--wait` alone for singleton readiness, or select a list menu for a zero-row condition.",
					});
				if (stopped) break;
				const data = await executeRetrieve(
					observationRequest,
					backend,
					prepared,
					controller.signal,
				);
				if (performance.now() >= deadline) stop("deadline-elapsed");
				if (stopped) break;
				observations++;
				lastError = undefined;
				const met =
					!condition ||
					(Array.isArray(data) &&
						(settings.untilEmpty ? data.length === 0 : data.length > 0));
				if (met) {
					const envelope = buildSuccessEnvelope(
						resolved,
						{ kind: "data", data },
						prepared.validation,
						resolved.warnings,
					);
					if (envelope.meta.operation)
						envelope.meta.operation.wait = meta(
							condition ? "condition-met" : "ready",
						);
					return applyMaxResultsBudget(envelope);
				}
			} catch (error) {
				if (stopped) break;
				if (!isRetryableWaitError(error)) return failure(error, "failed");
				lastError = error;
				await backend?.close();
				backend = undefined;
				prepared = undefined;
			}
			await delay(
				Math.max(0, sentAt + settings.intervalMs - performance.now()),
				controller.signal,
			);
		}
		if (stopped === "interrupted")
			return failure(
				new CentrsError({
					code: "wait/interrupted",
					summary:
						"The wait was cancelled before readiness or its condition was established.",
					remediation:
						"Run the wait again when you want to continue; cancellation is not evidence that the condition holds.",
				}),
				"interrupted",
			);
		return failure(
			lastError ??
				new CentrsError({
					code: "wait/deadline-exceeded",
					summary: condition
						? "The wait deadline passed without a completed observation satisfying the condition."
						: "The wait deadline passed before a read completed successfully.",
					remediation:
						"Check the router's current state and the predicate, or choose a longer `--wait` deadline.",
					context: { deadlineMs: settings.deadlineMs },
				}),
			"deadline-elapsed",
		);
	} finally {
		controller.abort();
		clearTimeout(deadlineTimer);
		options.signal?.removeEventListener("abort", onAbort);
		await backend?.close();
	}
}

const TRANSIENT_CAUSES = new Set([
	"ECONNRESET",
	"ConnectionReset",
	"EHOSTDOWN",
	"EHOSTUNREACH",
	"ENETDOWN",
	"ENETUNREACH",
	"FailedToOpenSocket",
]);

/** Narrow transient taxonomy; authentication, DNS, TLS and validation fail fast. */
export function isRetryableWaitError(error: unknown): boolean {
	if (!(error instanceof CentrsError)) return false;
	if (
		[
			"transport/connection-refused",
			"transport/connection-closed",
			"transport/timeout",
		].includes(error.code)
	)
		return true;
	// Both adapters retain the OS cause when a reset or an absent host maps to
	// the generic network code. Retry those causes, never all network failures.
	// A router rebooting on the local LAN fails ARP, and macOS then answers
	// later connects with "host down": Bun fetch reports that `FailedToOpenSocket`.
	if (error.code !== "transport/network") return false;
	const seen = new Set<unknown>();
	let cause: unknown = error.cause;
	while (cause && typeof cause === "object" && !seen.has(cause)) {
		seen.add(cause);
		if ("code" in cause && TRANSIENT_CAUSES.has(String(cause.code)))
			return true;
		cause = "cause" in cause ? cause.cause : undefined;
	}
	return false;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted || ms <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}
