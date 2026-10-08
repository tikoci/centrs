/**
 * `retrieve --sample <interval>`: read a menu again every interval, one line
 * per complete read. The contract is `commands/retrieve/README.md` → Sample.
 *
 * Each sample is an ordinary one-shot read (`print` or `get`), so its end is
 * the read's own `!done` (native) or HTTP response (REST). RouterOS's
 * `print interval=` was measured and not used: it has no end-of-tick marker,
 * so a tick is only known complete when the next one starts, and a tick
 * heavier than its interval saturates the connection (CHR 7.24.5, 2026-10-08).
 */

import type { EnvelopeValidationMeta } from "./core/envelope.ts";
import { CentrsError } from "./errors.ts";
import { createProtocolAdapter } from "./protocols/adapter.ts";
import {
	buildRetrieveErrorEnvelope,
	buildRetrieveErrorEnvelopeFromResolved,
	executeRetrieve,
	type ResolvedRetrieveRequest,
	type RetrieveEnvelope,
	type RetrieveRequest,
	type RetrieveSampleStopReason,
	type RetrieveSampleSummary,
	type RetrieveSuccessEnvelope,
	resolveRetrieveRequest,
	validateRetrieveRead,
} from "./retrieve.ts";
import { failedStreamEnvelope, streamEnvelope } from "./retrieve-stream.ts";

export interface RetrieveSampleOptions {
	/** Ctrl-C: ends the sample with `stopReason: "interrupted"`. */
	signal?: AbortSignal;
}

/**
 * Sample one menu: yields a `sample` line per complete read, then exactly one
 * summary (successful, or an error envelope carrying the partial count).
 * Errors before the first read (resolution, validation) yield one error
 * envelope without a summary.
 */
export async function* retrieveSample(
	request: RetrieveRequest,
	env: Record<string, string | undefined> = Bun.env,
	options: RetrieveSampleOptions = {},
): AsyncGenerator<RetrieveEnvelope, void, void> {
	if (request.sample === undefined) {
		yield buildRetrieveErrorEnvelope(
			request,
			new CentrsError({
				code: "input/invalid-command",
				summary: "`retrieveSample()` needs `sample`, the time between reads.",
				remediation:
					"Set `sample` on the request, e.g. `{ path: '/interface', sample: '5s' }`.",
				context: { capability: "sample" },
			}),
		);
		return;
	}
	let resolved: ResolvedRetrieveRequest;
	try {
		resolved = await resolveRetrieveRequest(request, env);
	} catch (error) {
		yield buildRetrieveErrorEnvelope(request, error);
		return;
	}
	const startedAt = Date.now();
	if (options.signal?.aborted) {
		yield summaryEnvelope(
			resolved,
			{ enabled: resolved.validate.value, result: "skipped" },
			{ stopReason: "interrupted", samples: 0 },
			startedAt,
		);
		return;
	}
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
	const sample = resolved.sample ?? { intervalMs: 0 };
	let samples = 0;
	let stopReason: RetrieveSampleStopReason | undefined;
	// Every stop source aborts this signal. It abandons the read in flight
	// (REST aborts its request; a native read ends when the session closes
	// below) and ends the wait between reads.
	const abandon = new AbortController();
	const stop = (reason: RetrieveSampleStopReason): void => {
		stopReason ??= reason;
		abandon.abort();
	};
	const onAbort = (): void => stop("interrupted");
	options.signal?.addEventListener("abort", onAbort);
	let durationTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		let prepared: Awaited<ReturnType<typeof validateRetrieveRead>>;
		try {
			prepared = await validateRetrieveRead(resolved, backend);
		} catch (error) {
			yield buildRetrieveErrorEnvelopeFromResolved(resolved, error);
			return;
		}
		const { validation, ...plan } = prepared;
		if (sample.durationMs !== undefined) {
			durationTimer = setTimeout(
				() => stop("duration-elapsed"),
				sample.durationMs,
			);
		}
		try {
			while (stopReason === undefined) {
				const sentAt = Date.now();
				const read = executeRetrieve(
					resolved,
					backend,
					plan,
					abandon.signal,
				).then((data) => ({ data }));
				// A read abandoned by a stop may still fail later; nobody awaits it.
				read.catch(() => {});
				const result = await unlessAborted(read, abandon.signal);
				// A read still in flight at the stop is not a complete sample.
				if (result === undefined) break;
				samples += 1;
				yield streamEnvelope(resolved, validation, result.data, {
					kind: "sample",
					index: samples,
					at: new Date(sentAt).toISOString(),
					readMs: Date.now() - sentAt,
				});
				if (sample.count !== undefined && samples >= sample.count) {
					stopReason ??= "count-reached";
					break;
				}
				// Start to start; a read slower than the interval delays the next
				// one instead of overlapping it or bursting to catch up.
				const waitMs = sentAt + sample.intervalMs - Date.now();
				if (waitMs > 0) {
					let timer: ReturnType<typeof setTimeout> | undefined;
					await unlessAborted(
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, waitMs);
						}),
						abandon.signal,
					);
					clearTimeout(timer);
				}
			}
		} catch (error) {
			yield failedStreamEnvelope(
				resolved,
				validation,
				error,
				(failure) => ({
					kind: "summary",
					stopReason: failure,
					samples,
					durationMs: Date.now() - startedAt,
				}),
				samples,
			);
			return;
		}
		yield summaryEnvelope(
			resolved,
			validation,
			{ stopReason: stopReason ?? "interrupted", samples },
			startedAt,
		);
	} finally {
		// A consumer that stopped reading early lands here directly.
		abandon.abort();
		clearTimeout(durationTimer);
		options.signal?.removeEventListener("abort", onAbort);
		await backend.close();
	}
}

/**
 * `work`'s value, or `undefined` as soon as `signal` aborts. The abort
 * listener is removed when `work` settles: racing every sample against one
 * long-lived promise would keep a reaction per sample for the whole run
 * (#411 review: about 5,300 retained after 3,000 samples).
 */
function unlessAborted<T>(
	work: Promise<T>,
	signal: AbortSignal,
): Promise<T | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise<T | undefined>((resolve, reject) => {
		const onAbort = (): void => resolve(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function summaryEnvelope(
	resolved: ResolvedRetrieveRequest,
	validation: EnvelopeValidationMeta,
	counts: Omit<RetrieveSampleSummary, "durationMs">,
	startedAt: number,
): RetrieveSuccessEnvelope {
	const summary: RetrieveSampleSummary = {
		...counts,
		durationMs: Date.now() - startedAt,
	};
	const envelope = streamEnvelope(resolved, validation, summary, {
		kind: "summary",
		...summary,
	});
	if (envelope.meta.operation) {
		envelope.meta.operation.objectCount = counts.samples;
	}
	envelope.warnings = [...resolved.warnings];
	return envelope;
}
