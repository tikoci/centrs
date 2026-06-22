import { describe, expect, test } from "bun:test";

type RetryOptions = {
	timeoutMs?: number;
	intervalMs?: number;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientBootError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const maybeCode = (err as Error & { code?: unknown }).code;
	if (maybeCode === "transport/connection-refused") return true;
	return /ECONNREFUSED/.test(err.message);
}

async function withBootReadyRetry<T>(
	fn: () => Promise<T>,
	{ timeoutMs = 1000, intervalMs = 50 }: RetryOptions = {},
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastTransient: unknown;

	for (;;) {
		try {
			return await fn();
		} catch (err) {
			if (!isTransientBootError(err)) throw err;
			lastTransient = err;
			if (Date.now() >= deadline) throw lastTransient;
			await sleep(intervalMs);
		}
	}
}

function codeError(code: string): Error & { code: string } {
	return Object.assign(new Error(code), { code });
}

describe("withBootReadyRetry", () => {
	test("returns the first success without retrying", async () => {
		let calls = 0;
		const value = await withBootReadyRetry(async () => {
			calls += 1;
			return "ok";
		});
		expect(value).toBe("ok");
		expect(calls).toBe(1);
	});

	test("retries a transient connection-refused, then succeeds", async () => {
		let calls = 0;
		const value = await withBootReadyRetry(
			async () => {
				calls += 1;
				if (calls < 3) {
					throw codeError("transport/connection-refused");
				}
				return "up";
			},
			{ intervalMs: 1 },
		);
		expect(value).toBe("up");
		expect(calls).toBe(3);
	});

	test("retries a raw ECONNREFUSED message", async () => {
		let calls = 0;
		const value = await withBootReadyRetry(
			async () => {
				calls += 1;
				if (calls < 2) {
					throw new Error("ECONNREFUSED: connection refused, recv");
				}
				return "up";
			},
			{ intervalMs: 1 },
		);
		expect(value).toBe("up");
		expect(calls).toBe(2);
	});

	test("propagates a non-transient error (e.g. auth-failed) immediately", async () => {
		let calls = 0;
		await expect(
			withBootReadyRetry(
				async () => {
					calls += 1;
					throw codeError("transport/auth-failed");
				},
				{ intervalMs: 1 },
			),
		).rejects.toMatchObject({ code: "transport/auth-failed" });
		expect(calls).toBe(1);
	});

	test("gives up after the deadline if it stays transient", async () => {
		let calls = 0;
		await expect(
			withBootReadyRetry(
				async () => {
					calls += 1;
					throw codeError("transport/connection-refused");
				},
				{ timeoutMs: 20, intervalMs: 1 },
			),
		).rejects.toMatchObject({ code: "transport/connection-refused" });
		expect(calls).toBeGreaterThanOrEqual(2);
	});
});
