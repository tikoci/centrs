/**
 * Transport-agnostic fan-out engine.
 *
 * `retrieve` group fan-out (`src/retrieve-fanout.ts`) grew the reusable
 * machinery: a bounded worker pool, transport-aware concurrency defaults, a
 * retry allowlist with jittered backoff, and the ok/failed summary. `api` — and
 * any later fan-out command — needs the identical behavior, so it lives here as
 * one vocabulary. The command-specific orchestration (CDB group expansion,
 * per-target resolve, envelope shaping, text rendering) stays in each command's
 * fan-out module; this core only knows about generic items, concurrency, retry,
 * and counting.
 */

import { CentrsError } from "../errors.ts";
import type { RouterOsProtocol } from "../protocols/index.ts";
import type { FanoutSummary } from "./envelope.ts";

/** Transport-aware default worker-pool size (REST drops parallel POSTs above ~8). */
export const FANOUT_CONCURRENCY_DEFAULTS: Record<
	"rest-api" | "native-api",
	number
> = {
	"rest-api": 8,
	"native-api": 4,
};

/** Extra attempts after the first try (jittered backoff between them). */
export const FANOUT_MAX_RETRIES = 2;

/** Base backoff in milliseconds; doubled per attempt with up to +base jitter. */
export const FANOUT_BACKOFF_BASE_MS = 200;

/** RouterOS-style codes that are safe to retry under fan-out. */
export const FANOUT_RETRYABLE_CODES = [
	"transport/network",
	"transport/connection-closed",
] as const;

/** Resolve and validate the worker-pool size. */
export function resolveFanoutConcurrency(
	requested: number | undefined,
	via: RouterOsProtocol,
): number {
	if (requested !== undefined) {
		if (!Number.isInteger(requested) || requested < 1) {
			throw new CentrsError({
				code: "usage/invalid-concurrency",
				summary: `--concurrency must be an integer >= 1. Received: ${requested}`,
				remediation: "Pass a positive integer, e.g. `--concurrency 4`.",
				context: { concurrency: requested },
			});
		}
		return requested;
	}
	if (via === "native-api") {
		return FANOUT_CONCURRENCY_DEFAULTS["native-api"];
	}
	return FANOUT_CONCURRENCY_DEFAULTS["rest-api"];
}

/**
 * Classify a per-target failure as retryable. Only the locked allowlist retries:
 * generic transport/network failures and dropped/closed connections (including
 * REST 5xx mapped to `transport/connection-closed`). Router-side (`routeros/*`),
 * validation, auth, cdb, target, input, usage, timeout, TLS, connection-refused,
 * and DNS failures are deterministic and never retried.
 */
export function isRetryableFanoutError(error: unknown): boolean {
	if (!(error instanceof CentrsError)) {
		return false;
	}
	return (FANOUT_RETRYABLE_CODES as readonly string[]).includes(error.code);
}

/** Count inner `ok`/`failed` across a completed target set. */
export function summarizeFanout(
	targets: readonly { ok: boolean }[],
): FanoutSummary {
	let ok = 0;
	let failed = 0;
	for (const target of targets) {
		if (target.ok) {
			ok += 1;
		} else {
			failed += 1;
		}
	}
	return { total: targets.length, ok, failed };
}

/**
 * Ordered bounded worker pool. Runs `worker` over `items` with at most
 * `concurrency` in flight, returning results in INPUT order regardless of
 * completion order.
 */
export async function runBoundedPool<I, O>(
	items: readonly I[],
	concurrency: number,
	worker: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
	const results = new Array<O>(items.length);
	let next = 0;
	const width = Math.max(1, Math.min(concurrency, items.length));

	async function drain(): Promise<void> {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) {
				return;
			}
			results[index] = await worker(items[index] as I, index);
		}
	}

	await Promise.all(Array.from({ length: width }, () => drain()));
	return results;
}

/**
 * Run `run`, retrying only {@link isRetryableFanoutError} failures up to
 * `maxRetries` times with jittered backoff. A non-retryable error, or the final
 * exhausted attempt, is converted to a value via `recover` (so a fan-out target
 * yields an inner error envelope instead of throwing out of the batch).
 */
export async function runWithRetry<T>(
	run: () => Promise<T>,
	recover: (error: unknown) => T,
	options: {
		sleep?: (ms: number) => Promise<void>;
		maxRetries?: number;
	} = {},
): Promise<T> {
	const sleep = options.sleep ?? defaultFanoutSleep;
	const maxRetries = options.maxRetries ?? FANOUT_MAX_RETRIES;
	let attempt = 0;
	for (;;) {
		try {
			return await run();
		} catch (error) {
			if (attempt < maxRetries && isRetryableFanoutError(error)) {
				attempt += 1;
				await sleep(fanoutBackoffMs(attempt));
				continue;
			}
			return recover(error);
		}
	}
}

/** Backoff for attempt N: base·2^(N-1) plus up to +base jitter. */
export function fanoutBackoffMs(attempt: number): number {
	const base = FANOUT_BACKOFF_BASE_MS * 2 ** (attempt - 1);
	return base + Math.floor(Math.random() * FANOUT_BACKOFF_BASE_MS);
}

/** Real timer sleep; tests inject a no-op. */
export function defaultFanoutSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
