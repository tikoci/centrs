import { describe, expect, test } from "bun:test";
import {
	FANOUT_CONCURRENCY_DEFAULTS,
	FANOUT_MAX_RETRIES,
	fanoutBackoffMs,
	isRetryableFanoutError,
	resolveFanoutConcurrency,
	runBoundedPool,
	runWithRetry,
	summarizeFanout,
} from "../../src/core/fanout.ts";
import { CentrsError } from "../../src/errors.ts";

const noopSleep = (): Promise<void> => Promise.resolve();

describe("resolveFanoutConcurrency", () => {
	test("uses transport-aware defaults when unset", () => {
		expect(resolveFanoutConcurrency(undefined, "rest-api")).toBe(
			FANOUT_CONCURRENCY_DEFAULTS["rest-api"],
		);
		expect(resolveFanoutConcurrency(undefined, "native-api")).toBe(
			FANOUT_CONCURRENCY_DEFAULTS["native-api"],
		);
		// A non-native protocol falls back to the REST default.
		expect(resolveFanoutConcurrency(undefined, "ssh")).toBe(
			FANOUT_CONCURRENCY_DEFAULTS["rest-api"],
		);
	});

	test("passes an explicit positive integer through", () => {
		expect(resolveFanoutConcurrency(3, "rest-api")).toBe(3);
	});

	test("rejects non-integer or sub-1 values", () => {
		expect(() => resolveFanoutConcurrency(0, "rest-api")).toThrow(
			"--concurrency must be an integer",
		);
		expect(() => resolveFanoutConcurrency(-2, "rest-api")).toThrow();
		expect(() => resolveFanoutConcurrency(1.5, "rest-api")).toThrow();
	});
});

describe("isRetryableFanoutError", () => {
	test("retries only the allowlisted transport drops", () => {
		expect(
			isRetryableFanoutError(
				new CentrsError({ code: "transport/network", summary: "x" }),
			),
		).toBe(true);
		expect(
			isRetryableFanoutError(
				new CentrsError({ code: "transport/connection-closed", summary: "x" }),
			),
		).toBe(true);
	});

	test("never retries deterministic or non-CentrsError failures", () => {
		for (const code of [
			"routeros/unknown-path",
			"transport/connection-refused",
			"transport/timeout",
			"validation/unknown-attribute",
		] as const) {
			expect(
				isRetryableFanoutError(new CentrsError({ code, summary: "x" })),
			).toBe(false);
		}
		expect(isRetryableFanoutError(new Error("boom"))).toBe(false);
		expect(isRetryableFanoutError("nope")).toBe(false);
	});
});

describe("summarizeFanout", () => {
	test("counts inner ok/failed", () => {
		expect(
			summarizeFanout([{ ok: true }, { ok: false }, { ok: true }]),
		).toEqual({ total: 3, ok: 2, failed: 1 });
		expect(summarizeFanout([])).toEqual({ total: 0, ok: 0, failed: 0 });
	});
});

describe("runBoundedPool", () => {
	test("preserves input order and caps concurrency", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const items = [0, 1, 2, 3, 4, 5];
		const out = await runBoundedPool(items, 2, async (item) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, (6 - item) * 3));
			inFlight -= 1;
			return item * 10;
		});
		expect(out).toEqual([0, 10, 20, 30, 40, 50]);
		expect(maxInFlight).toBe(2);
	});

	test("passes the index to the worker", async () => {
		const out = await runBoundedPool(
			["a", "b", "c"],
			3,
			async (item, index) => `${item}${index}`,
		);
		expect(out).toEqual(["a0", "b1", "c2"]);
	});
});

describe("runWithRetry", () => {
	test("returns the first success without invoking recover", async () => {
		let attempts = 0;
		const result = await runWithRetry(
			() => {
				attempts += 1;
				return Promise.resolve("ok");
			},
			() => "recovered",
			{ sleep: noopSleep },
		);
		expect(result).toBe("ok");
		expect(attempts).toBe(1);
	});

	test("retries a retryable error up to maxRetries, then recovers", async () => {
		let attempts = 0;
		const sleeps: number[] = [];
		const result = await runWithRetry<string>(
			() => {
				attempts += 1;
				return Promise.reject(
					new CentrsError({ code: "transport/network", summary: "x" }),
				);
			},
			(error) => `recovered:${error instanceof CentrsError ? error.code : "?"}`,
			{
				sleep: (ms) => {
					sleeps.push(ms);
					return Promise.resolve();
				},
			},
		);
		// 1 initial try + FANOUT_MAX_RETRIES retries.
		expect(attempts).toBe(FANOUT_MAX_RETRIES + 1);
		expect(sleeps.length).toBe(FANOUT_MAX_RETRIES);
		expect(result).toBe("recovered:transport/network");
	});

	test("does not retry a non-retryable error", async () => {
		let attempts = 0;
		const result = await runWithRetry(
			() => {
				attempts += 1;
				return Promise.reject(
					new CentrsError({ code: "validation/unknown-path", summary: "x" }),
				);
			},
			() => "recovered",
			{ sleep: noopSleep },
		);
		expect(attempts).toBe(1);
		expect(result).toBe("recovered");
	});

	test("honors a custom maxRetries", async () => {
		let attempts = 0;
		await runWithRetry(
			() => {
				attempts += 1;
				return Promise.reject(
					new CentrsError({ code: "transport/network", summary: "x" }),
				);
			},
			() => "recovered",
			{ sleep: noopSleep, maxRetries: 0 },
		);
		expect(attempts).toBe(1);
	});
});

describe("fanoutBackoffMs", () => {
	test("grows with the attempt number", () => {
		const first = fanoutBackoffMs(1);
		const second = fanoutBackoffMs(2);
		// attempt 1: base..2*base; attempt 2: 2*base..3*base — strictly higher floor.
		expect(first).toBeGreaterThanOrEqual(200);
		expect(second).toBeGreaterThanOrEqual(400);
	});
});
