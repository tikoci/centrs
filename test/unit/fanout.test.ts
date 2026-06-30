import { describe, expect, test } from "bun:test";
import type { CentrsEnvelope } from "../../src/core/envelope.ts";
import {
	buildFanoutEnvelope,
	buildFanoutResolveFailure,
	commonVia,
	FANOUT_CONCURRENCY_DEFAULTS,
	FANOUT_MAX_RETRIES,
	fanoutBackoffMs,
	fanoutExitCode,
	isRetryableFanoutError,
	resolveFanoutConcurrency,
	runBoundedPool,
	runFanout,
	runWithRetry,
	summarizeFanout,
} from "../../src/core/fanout.ts";
import { CentrsError } from "../../src/errors.ts";

const noopSleep = (): Promise<void> => Promise.resolve();

/** A minimal inner success envelope for the generic-helper tests. */
function okEnvelope(via: "rest-api" | "native-api" | null): CentrsEnvelope {
	return {
		ok: true,
		data: { n: 1 },
		warnings: [],
		tips: [],
		meta: { target: {}, via, settings: {} },
	};
}

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

describe("fanoutExitCode", () => {
	const summaryEnvelope = (
		ok: number,
		failed: number,
	): {
		ok: true;
		data: { summary: { total: number; ok: number; failed: number } };
	} => ({
		ok: true,
		data: { summary: { total: ok + failed, ok, failed } },
	});

	test("0 when every target ok or the selection is empty", () => {
		expect(fanoutExitCode(summaryEnvelope(3, 0))).toBe(0);
		expect(fanoutExitCode(summaryEnvelope(0, 0))).toBe(0);
	});

	test("2 on a partial failure", () => {
		expect(fanoutExitCode(summaryEnvelope(1, 1))).toBe(2);
		expect(fanoutExitCode(summaryEnvelope(2, 5))).toBe(2);
	});

	test("1 when every target failed", () => {
		expect(fanoutExitCode(summaryEnvelope(0, 4))).toBe(1);
	});

	test("1 on an orchestration error (outer ok:false)", () => {
		expect(fanoutExitCode({ ok: false })).toBe(1);
	});
});

describe("commonVia", () => {
	test("collapses agreeing protocols, null on disagreement", () => {
		expect(commonVia([okEnvelope("rest-api"), okEnvelope("rest-api")])).toBe(
			"rest-api",
		);
		expect(commonVia([okEnvelope("rest-api"), okEnvelope("native-api")])).toBe(
			null,
		);
		expect(commonVia([])).toBe(null);
	});
});

describe("buildFanoutEnvelope", () => {
	test("wraps targets in the locked FanoutData shape", () => {
		const targets = [okEnvelope("rest-api")];
		const envelope = buildFanoutEnvelope({
			summary: { total: 1, ok: 1, failed: 0 },
			targets,
			warnings: [],
			settings: {},
			via: "rest-api",
			operation: { kind: "fanout" as const, count: 1 },
		});
		expect(envelope.ok).toBe(true);
		expect(envelope.data.summary).toEqual({ total: 1, ok: 1, failed: 0 });
		expect(envelope.data.targets).toBe(targets);
		expect(envelope.meta.operation).toEqual({ kind: "fanout", count: 1 });
		expect(envelope.meta.via).toBe("rest-api");
	});
});

describe("buildFanoutResolveFailure", () => {
	test("produces an inner ok:false envelope carrying target meta", () => {
		const envelope = buildFanoutResolveFailure({
			error: new CentrsError({ code: "target/unresolved", summary: "no host" }),
			target: { input: "r1", identity: "r1", recordIndex: 2 },
			warnings: [],
		});
		expect(envelope.ok).toBe(false);
		if (!envelope.ok) {
			expect(envelope.error.code).toBe("target/unresolved");
			expect(envelope.meta.target.recordIndex).toBe(2);
		}
	});

	test("wraps a non-CentrsError as internal/unhandled", () => {
		const envelope = buildFanoutResolveFailure({
			error: new Error("boom"),
			target: {},
		});
		expect(envelope.ok).toBe(false);
		if (!envelope.ok) {
			expect(envelope.error.code).toBe("internal/unhandled");
		}
	});
});

describe("runFanout", () => {
	test("orders results by input index and recovers per-target failures", async () => {
		const members = [
			{ id: "a", fail: false },
			{ id: "b", fail: "resolve" as const },
			{ id: "c", fail: "execute" as const },
		];
		const results = await runFanout<
			(typeof members)[number],
			{ id: string },
			{ ok: boolean; tag: string }
		>({
			members,
			concurrency: 3,
			resolve: (member) => {
				if (member.fail === "resolve") {
					throw new CentrsError({ code: "target/unresolved", summary: "x" });
				}
				return { id: member.id };
			},
			onResolveError: (member) => ({ ok: false, tag: `resolve:${member.id}` }),
			execute: (resolved) => {
				if (resolved.id === "c") {
					return Promise.reject(
						new CentrsError({ code: "routeros/unknown-path", summary: "x" }),
					);
				}
				return Promise.resolve({ ok: true, tag: `exec:${resolved.id}` });
			},
			onExecuteError: (resolved) => ({
				ok: false,
				tag: `exec-fail:${resolved.id}`,
			}),
			sleep: noopSleep,
		});
		expect(results).toEqual([
			{ ok: true, tag: "exec:a" },
			{ ok: false, tag: "resolve:b" },
			{ ok: false, tag: "exec-fail:c" },
		]);
	});

	test("retries a retryable execute failure before recovering", async () => {
		let attempts = 0;
		const results = await runFanout<number, number, { ok: boolean }>({
			members: [1],
			concurrency: 1,
			resolve: (member) => member,
			onResolveError: () => ({ ok: false }),
			execute: () => {
				attempts += 1;
				return Promise.reject(
					new CentrsError({ code: "transport/network", summary: "x" }),
				);
			},
			onExecuteError: () => ({ ok: false }),
			sleep: noopSleep,
		});
		expect(attempts).toBe(FANOUT_MAX_RETRIES + 1);
		expect(results).toEqual([{ ok: false }]);
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
