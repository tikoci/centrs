import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import type {
	CdbResolution,
	CdbSelectionExpansion,
	ResolvedRetrieveRequest,
	RetrieveRequest,
	RetrieveSuccessEnvelope,
	TargetSelection,
} from "../../src/index.ts";
import {
	isRetryableFanoutError,
	resolveFanoutConcurrency,
	retrieveFanout,
	retrieveGroup,
	runBoundedPool,
	summarizeFanout,
} from "../../src/index.ts";

function fakeResolution(recordIndex: number): CdbResolution {
	return {
		target: `10.0.0.${recordIndex + 1}`,
		identity: `router-${recordIndex}`,
		username: "admin",
		password: "",
		recordIndex,
		overrides: {},
		warnings: [],
	};
}

function fakeExpansion(count: number): CdbSelectionExpansion {
	return {
		empty: false,
		warnings: [],
		targets: Array.from({ length: count }, (_, index) => ({
			kind: "cdb",
			recordIndex: index,
			resolution: fakeResolution(index),
		})),
	};
}

function fakeSuccess(
	resolved: ResolvedRetrieveRequest,
): RetrieveSuccessEnvelope {
	const recordIndex = resolved.target.recordIndex ?? -1;
	return {
		ok: true,
		data: recordIndex,
		warnings: [],
		tips: [],
		meta: {
			target: { recordIndex, identity: resolved.target.identity },
			via: "rest-api",
			settings: {},
		},
	};
}

const baseRequest: RetrieveRequest = {
	path: "/system/resource",
	group: "prod",
};

const noSleep = async (): Promise<void> => undefined;

describe("retrieve fanout orchestration", () => {
	test("orders targets by recordIndex despite out-of-order completion", async () => {
		const completionOrder: number[] = [];
		const envelope = await retrieveGroup(
			baseRequest,
			{},
			{
				expand: async () => fakeExpansion(5),
				sleep: noSleep,
				execute: async (resolved) => {
					const recordIndex = resolved.target.recordIndex ?? -1;
					// Earlier indices finish LAST so completion order is reversed.
					await new Promise((resolve) =>
						setTimeout(resolve, (5 - recordIndex) * 5),
					);
					completionOrder.push(recordIndex);
					return fakeSuccess(resolved);
				},
			},
		);

		expect(envelope.ok).toBe(true);
		expect(envelope.data.targets.map((t) => t.meta.target.recordIndex)).toEqual(
			[0, 1, 2, 3, 4],
		);
		// Completion really was out of order, proving the sort is deterministic.
		expect(completionOrder).not.toEqual([0, 1, 2, 3, 4]);
		expect(envelope.data.summary).toEqual({ total: 5, ok: 5, failed: 0 });
	});

	test("one inner failure does not flip the outer ok", async () => {
		const envelope = await retrieveGroup(
			baseRequest,
			{},
			{
				expand: async () => fakeExpansion(2),
				sleep: noSleep,
				execute: async (resolved) => {
					if ((resolved.target.recordIndex ?? -1) === 1) {
						throw new CentrsError({
							code: "transport/connection-refused",
							summary: "refused",
						});
					}
					return fakeSuccess(resolved);
				},
			},
		);

		expect(envelope.ok).toBe(true);
		expect(envelope.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
		expect(envelope.data.targets[0]?.ok).toBe(true);
		const failed = envelope.data.targets[1];
		expect(failed?.ok).toBe(false);
		if (failed && !failed.ok) {
			expect(failed.error.code).toBe("transport/connection-refused");
			// Inner failure preserves per-target identity (recordIndex/identity).
			expect(failed.meta.target.recordIndex).toBe(1);
			expect(failed.meta.target.identity).toBe("router-1");
		}
	});

	test("empty / unknown group is ok:true with a cdb/empty-group warning", async () => {
		const envelope = await retrieveGroup(
			baseRequest,
			{},
			{
				expand: async () => ({
					empty: true,
					targets: [],
					warnings: [
						{
							code: "cdb/empty-group",
							message: 'No CDB entries matched group "prod".',
						},
					],
				}),
				sleep: noSleep,
				execute: async (resolved) => fakeSuccess(resolved),
			},
		);

		expect(envelope.ok).toBe(true);
		expect(envelope.data.summary).toEqual({ total: 0, ok: 0, failed: 0 });
		expect(envelope.data.targets).toHaveLength(0);
		expect(envelope.warnings.map((w) => w.code)).toContain("cdb/empty-group");
		expect(envelope.meta.operation?.kind).toBe("fanout");
		expect(envelope.meta.operation?.selection.groups).toEqual(["prod"]);
	});

	test("retries only retryable codes, up to the max attempt count", async () => {
		const calls = new Map<number, number>();
		const bump = (index: number): number => {
			const next = (calls.get(index) ?? 0) + 1;
			calls.set(index, next);
			return next;
		};

		const envelope = await retrieveGroup(
			baseRequest,
			{},
			{
				expand: async () => fakeExpansion(3),
				sleep: noSleep,
				execute: async (resolved) => {
					const index = resolved.target.recordIndex ?? -1;
					const attempt = bump(index);
					if (index === 0) {
						// Retryable: fails twice then succeeds on attempt 3.
						if (attempt < 3) {
							throw new CentrsError({
								code: "transport/network",
								summary: "transient",
							});
						}
						return fakeSuccess(resolved);
					}
					if (index === 1) {
						// Retryable but always fails — must stop at 1 + 2 retries.
						throw new CentrsError({
							code: "transport/connection-closed",
							summary: "dropped",
						});
					}
					// Non-retryable: a single attempt, no retry.
					throw new CentrsError({
						code: "routeros/api-trap",
						summary: "trap",
					});
				},
			},
		);

		expect(calls.get(0)).toBe(3);
		expect(calls.get(1)).toBe(3);
		expect(calls.get(2)).toBe(1);
		expect(envelope.data.summary).toEqual({ total: 3, ok: 1, failed: 2 });
		expect(envelope.data.targets[0]?.ok).toBe(true);
		expect(envelope.data.targets[1]?.ok).toBe(false);
		expect(envelope.data.targets[2]?.ok).toBe(false);
	});

	test("respects the concurrency cap (bounded in-flight)", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const concurrency = 2;

		const envelope = await retrieveGroup(
			{ ...baseRequest, concurrency },
			{},
			{
				expand: async () => fakeExpansion(8),
				sleep: noSleep,
				execute: async (resolved) => {
					inFlight += 1;
					maxInFlight = Math.max(maxInFlight, inFlight);
					await new Promise((resolve) => setTimeout(resolve, 5));
					inFlight -= 1;
					return fakeSuccess(resolved);
				},
			},
		);

		expect(envelope.data.summary.total).toBe(8);
		expect(maxInFlight).toBeLessThanOrEqual(concurrency);
		expect(maxInFlight).toBe(concurrency);
		expect(envelope.meta.operation?.concurrency).toBe(concurrency);
	});

	test("summarizes the selection (groups/where/all/default) in the operation meta", async () => {
		const selection: TargetSelection = {
			positionals: [],
			groups: ["prod", "edge"],
			all: false,
			default: false,
			where: [{ key: "board", value: "RB5009" }],
		};
		const envelope = await retrieveFanout(
			baseRequest,
			selection,
			{},
			{
				expand: async () => fakeExpansion(1),
				sleep: noSleep,
				execute: async (resolved) => fakeSuccess(resolved),
			},
		);
		expect(envelope.meta.operation?.selection).toEqual({
			groups: ["prod", "edge"],
			where: ["board=RB5009"],
			all: false,
			default: false,
			positionals: [],
		});
	});

	test("a __default__ member fails that one target deterministically", async () => {
		const defaultResolution: CdbResolution = {
			...fakeResolution(0),
			target: "__default__",
		};
		const envelope = await retrieveFanout(
			baseRequest,
			{ positionals: [], groups: [], all: false, default: true, where: [] },
			{},
			{
				expand: async () => ({
					empty: false,
					warnings: [],
					targets: [
						{ kind: "cdb", recordIndex: 0, resolution: fakeResolution(0) },
						{ kind: "cdb", recordIndex: 3, resolution: defaultResolution },
					],
				}),
				sleep: noSleep,
				execute: async (resolved) => fakeSuccess(resolved),
			},
		);
		const failed = envelope.data.targets.find(
			(t) => t.meta.target.recordIndex === 3,
		);
		expect(failed && !failed.ok && failed.error.code).toBe("target/unresolved");
		// The real target still succeeded — partial.
		expect(envelope.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
	});

	test("a literal (ad-hoc) member drops a borrowed __default__ recordIndex and keeps its input", async () => {
		const envelope = await retrieveFanout(
			{ path: "/system/resource", username: "admin", password: "pw" },
			{
				positionals: ["1.2.3.4"],
				groups: [],
				all: false,
				default: false,
				where: [],
			},
			{ HOME: "/nonexistent-centrs-home" },
			{
				expand: async () => ({
					empty: false,
					warnings: [],
					targets: [{ kind: "literal", input: "1.2.3.4" }],
				}),
				// Simulate the resolver borrowing the __default__ record's index (3).
				execute: async (resolved) => {
					const base = fakeSuccess(resolved);
					return {
						...base,
						meta: { ...base.meta, target: { host: "1.2.3.4", recordIndex: 3 } },
					};
				},
				sleep: noSleep,
			},
		);
		const target = envelope.data.targets[0];
		expect(target?.meta.target.recordIndex).toBeUndefined();
		expect(target?.meta.target.input).toBe("1.2.3.4");
	});
});

describe("retrieve fanout retry classification", () => {
	test("retries the allowlisted transport codes", () => {
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

	test("does not retry deterministic failures", () => {
		for (const code of [
			"routeros/api-trap",
			"validation/unknown-attribute",
			"auth/failed",
			"cdb/decrypt-failed",
			"target/unresolved",
			"input/invalid-routeros-path",
			"usage/conflicting-flags",
			"transport/connection-refused",
			"transport/dns",
			"transport/tls-certificate",
		] as const) {
			expect(
				isRetryableFanoutError(new CentrsError({ code, summary: "x" })),
			).toBe(false);
		}
	});

	test("does not retry transport/timeout", () => {
		expect(
			isRetryableFanoutError(
				new CentrsError({
					code: "transport/timeout",
					summary: "native timeout",
					context: { via: "native-api" },
				}),
			),
		).toBe(false);
	});

	test("non-CentrsError values are never retryable", () => {
		expect(isRetryableFanoutError(new Error("boom"))).toBe(false);
		expect(isRetryableFanoutError("nope")).toBe(false);
	});
});

describe("retrieve fanout helpers", () => {
	test("resolveFanoutConcurrency uses transport-aware defaults", () => {
		expect(resolveFanoutConcurrency(undefined, "rest-api")).toBe(8);
		expect(resolveFanoutConcurrency(undefined, "native-api")).toBe(4);
		expect(resolveFanoutConcurrency(3, "rest-api")).toBe(3);
	});

	test("retrieveGroup uses native-api default when a CDB member pins native-api", async () => {
		const resolution = fakeResolution(0);
		resolution.overrides.via = {
			value: "native-api",
			source: { kind: "comment-kv", key: "record:0:via" },
		};
		const envelope = await retrieveGroup(
			baseRequest,
			{},
			{
				expand: async () => ({
					empty: false,
					warnings: [],
					targets: [{ kind: "cdb", recordIndex: 0, resolution }],
				}),
				sleep: noSleep,
				execute: async (resolved) => fakeSuccess(resolved),
			},
		);

		expect(envelope.meta.operation?.concurrency).toBe(4);
	});

	test("resolveFanoutConcurrency rejects values below 1", () => {
		expect(() => resolveFanoutConcurrency(0, "rest-api")).toThrow(
			"--concurrency",
		);
		expect(() => resolveFanoutConcurrency(-2, "rest-api")).toThrow();
		expect(() => resolveFanoutConcurrency(1.5, "rest-api")).toThrow();
	});

	test("runBoundedPool preserves input order and caps concurrency", async () => {
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

	test("summarizeFanout counts inner ok/failed", () => {
		const summary = summarizeFanout([
			{ ok: true } as never,
			{ ok: false } as never,
			{ ok: true } as never,
		]);
		expect(summary).toEqual({ total: 3, ok: 2, failed: 1 });
	});
});
