import { describe, expect, test } from "bun:test";
import {
	channelStatuses,
	openQaResultsDb,
	type QaRunInput,
	recordQaRun,
	summarizeIntegrationReport,
} from "../../scripts/qa-results-db.ts";

function memoryDb() {
	return openQaResultsDb(":memory:");
}

describe("recordQaRun / schema", () => {
	test("records a run and returns the stored row", () => {
		const db = memoryDb();
		const input: QaRunInput = {
			channel: "stable",
			resolvedVersion: "7.23.1 (stable)",
			outcome: "pass",
			suites: 4,
			examples: 21,
			commitSha: "abc1234",
			runDate: "2026-06-16T00:00:00.000Z",
		};
		const row = recordQaRun(db, input);
		expect(row.id).toBeGreaterThan(0);
		expect(row.channel).toBe("stable");
		expect(row.resolved_version).toBe("7.23.1 (stable)");
		expect(row.outcome).toBe("pass");
		expect(row.examples).toBe(21);
		expect(row.commit_sha).toBe("abc1234");
		db.close();
	});

	test("defaults run_date and leaves optional columns null", () => {
		const db = memoryDb();
		const row = recordQaRun(db, { channel: "long-term", outcome: "fail" });
		expect(row.run_date).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(row.resolved_version).toBeNull();
		expect(row.commit_sha).toBeNull();
		expect(row.suites).toBe(0);
		db.close();
	});

	test("rejects an outcome outside the pass/fail check constraint", () => {
		const db = memoryDb();
		expect(() =>
			recordQaRun(db, { channel: "stable", outcome: "maybe" as never }),
		).toThrow();
		db.close();
	});
});

describe("summarizeIntegrationReport", () => {
	const toJsonLine = (o: Record<string, unknown>) => JSON.stringify(o);
	const jsonl = [
		toJsonLine({
			suite: "execute",
			protocol: "rest-api",
			routerosVersion: "7.23.1 (stable)",
			requestedChannel: "stable",
			exampleIds: [1, 2, 3],
		}),
		"", // blank line is skipped
		"{ not json", // malformed line is skipped
		toJsonLine({
			suite: "transfer",
			protocol: "native-api",
			routerosVersion: "7.23.1 (stable)",
			requestedChannel: "stable",
			exampleIds: [8, 9],
		}),
	].join("\n");

	test("folds evidence into a per-run summary", () => {
		const summary = summarizeIntegrationReport(jsonl);
		expect(summary.resolvedVersion).toBe("7.23.1 (stable)");
		expect(summary.channel).toBe("stable");
		expect(summary.suites).toBe(2); // two valid lines
		expect(summary.examples).toBe(5); // 3 + 2
	});

	test("an empty report yields a zeroed summary", () => {
		expect(summarizeIntegrationReport("")).toEqual({
			channel: undefined,
			requestedVersion: undefined,
			resolvedVersion: undefined,
			suites: 0,
			examples: 0,
		});
	});

	test("carries an explicit requested version through", () => {
		const summary = summarizeIntegrationReport(
			toJsonLine({
				suite: "execute",
				routerosVersion: "7.21.4 (long-term)",
				requestedVersion: "7.21.4",
				exampleIds: [1],
			}),
		);
		expect(summary.requestedVersion).toBe("7.21.4");
		expect(summary.resolvedVersion).toBe("7.21.4 (long-term)");
	});
});

describe("channelStatuses", () => {
	test("reports the latest result per channel with run counts", () => {
		const db = memoryDb();
		recordQaRun(db, {
			channel: "stable",
			resolvedVersion: "7.23.0",
			outcome: "pass",
			runDate: "2026-06-01T00:00:00.000Z",
		});
		recordQaRun(db, {
			channel: "stable",
			resolvedVersion: "7.23.1",
			outcome: "pass",
			runDate: "2026-06-15T00:00:00.000Z",
		});
		recordQaRun(db, {
			channel: "long-term",
			resolvedVersion: "7.21.4",
			outcome: "fail",
			runDate: "2026-06-15T00:00:00.000Z",
		});

		const statuses = channelStatuses(db);
		const byChannel = Object.fromEntries(statuses.map((status) => [status.channel, status]));
		expect(byChannel["stable"]?.runs).toBe(2);
		expect(byChannel["stable"]?.latestResolvedVersion).toBe("7.23.1");
		expect(byChannel["stable"]?.latestOutcome).toBe("pass");
		expect(byChannel["long-term"]?.runs).toBe(1);
		expect(byChannel["long-term"]?.latestOutcome).toBe("fail");
		db.close();
	});
});
