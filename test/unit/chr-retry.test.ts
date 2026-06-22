import { describe, expect, test } from "bun:test";
import { withBootReadyRetry } from "../integration/chr.ts";

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
