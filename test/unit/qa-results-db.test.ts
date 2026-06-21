import { describe, expect, test } from "bun:test";
import {
	allRuns,
	channelPolicy,
	channelStatuses,
	evaluateMustPassGate,
	MUST_PASS_CHANNELS,
	openQaResultsDb,
	parseHistoryJsonl,
	type QaRunInput,
	rebuildHistoryDb,
	recordQaRun,
	serializeRun,
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
	const line = (o: Record<string, unknown>) => JSON.stringify(o);
	const jsonl = [
		line({
			suite: "execute",
			protocol: "rest-api",
			routerosVersion: "7.23.1 (stable)",
			requestedChannel: "stable",
			exampleIds: [1, 2, 3],
		}),
		"", // blank line is skipped
		"{ not json", // malformed line is skipped
		line({
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
			line({
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
		const byChannel = Object.fromEntries(statuses.map((s) => [s.channel, s]));
		expect(byChannel["stable"]?.runs).toBe(2);
		expect(byChannel["stable"]?.latestResolvedVersion).toBe("7.23.1");
		expect(byChannel["stable"]?.latestOutcome).toBe("pass");
		expect(byChannel["long-term"]?.runs).toBe(1);
		expect(byChannel["long-term"]?.latestOutcome).toBe("fail");
		db.close();
	});
});

describe("channelPolicy", () => {
	test("released channels are must-pass; everything else is best-effort", () => {
		expect(channelPolicy("stable")).toBe("must-pass");
		expect(channelPolicy("long-term")).toBe("must-pass");
		expect(channelPolicy("development")).toBe("best-effort");
		expect(channelPolicy("testing")).toBe("best-effort");
		expect(MUST_PASS_CHANNELS).toEqual(["stable", "long-term"]);
	});
});

describe("evaluateMustPassGate", () => {
	function statusesFrom(runs: QaRunInput[]) {
		const db = openQaResultsDb(":memory:");
		for (const run of runs) recordQaRun(db, run);
		const statuses = channelStatuses(db);
		db.close();
		return statuses;
	}

	test("passes when all must-pass channels are green", () => {
		const gate = evaluateMustPassGate(
			statusesFrom([
				{ channel: "stable", outcome: "pass" },
				{ channel: "long-term", outcome: "pass" },
				{ channel: "development", outcome: "fail" }, // best-effort, ignored
			]),
		);
		expect(gate.ok).toBe(true);
		expect(gate.failures).toHaveLength(0);
		expect(gate.evaluated.map((s) => s.channel).sort()).toEqual([
			"long-term",
			"stable",
		]);
	});

	test("fails when a released channel is red", () => {
		const gate = evaluateMustPassGate(
			statusesFrom([
				{ channel: "stable", outcome: "pass" },
				{ channel: "long-term", outcome: "fail" },
			]),
		);
		expect(gate.ok).toBe(false);
		expect(gate.failures.map((s) => s.channel)).toEqual(["long-term"]);
	});

	test("a beta flake never reds the gate", () => {
		const gate = evaluateMustPassGate(
			statusesFrom([{ channel: "development", outcome: "fail" }]),
		);
		expect(gate.ok).toBe(true);
	});
});

describe("history JSONL round-trip", () => {
	test("serializeRun drops id and parseHistoryJsonl restores the row", () => {
		const db = openQaResultsDb(":memory:");
		recordQaRun(db, {
			channel: "stable",
			resolvedVersion: "7.23.1 (stable)",
			requestedVersion: "7.23.1",
			outcome: "pass",
			suites: 4,
			examples: 21,
			commitSha: "abc1234",
			runDate: "2026-06-20T00:00:00.000Z",
		});
		const row = allRuns(db)[0];
		db.close();
		if (!row) throw new Error("expected a recorded run");
		const line = serializeRun(row);
		expect(JSON.parse(line)).not.toHaveProperty("id");

		const records = parseHistoryJsonl(line);
		expect(records[0]?.channel).toBe("stable");
		expect(records[0]?.resolved_version).toBe("7.23.1 (stable)");
		expect(records[0]?.outcome).toBe("pass");
		expect(records[0]?.examples).toBe(21);
		expect(records[0]?.run_date).toBe("2026-06-20T00:00:00.000Z");
	});

	test("skips blank and malformed lines and rows missing required keys", () => {
		const jsonl = [
			serializeRun({
				id: 1,
				run_date: "2026-06-20T00:00:00.000Z",
				channel: "stable",
				requested_version: null,
				resolved_version: "7.23.1",
				outcome: "pass",
				suites: 1,
				examples: 1,
				commit_sha: null,
			}),
			"",
			"{ not json",
			JSON.stringify({ channel: "stable", outcome: "maybe" }), // bad outcome
			JSON.stringify({ outcome: "pass", run_date: "x" }), // missing channel
		].join("\n");
		const records = parseHistoryJsonl(jsonl);
		expect(records).toHaveLength(1);
		expect(records[0]?.channel).toBe("stable");
	});

	test("rebuildHistoryDb reconstructs latest-per-channel statuses", () => {
		const records = parseHistoryJsonl(
			[
				{
					run_date: "2026-06-01T00:00:00.000Z",
					channel: "stable",
					requested_version: null,
					resolved_version: "7.23.0",
					outcome: "pass",
					suites: 1,
					examples: 1,
					commit_sha: null,
				},
				{
					run_date: "2026-06-15T00:00:00.000Z",
					channel: "stable",
					requested_version: null,
					resolved_version: "7.23.1",
					outcome: "fail",
					suites: 1,
					examples: 1,
					commit_sha: null,
				},
			]
				.map((r) => JSON.stringify(r))
				.join("\n"),
		);
		const db = rebuildHistoryDb(records);
		const statuses = channelStatuses(db);
		db.close();
		expect(statuses).toHaveLength(1);
		expect(statuses[0]?.runs).toBe(2);
		expect(statuses[0]?.latestResolvedVersion).toBe("7.23.1");
		expect(statuses[0]?.latestOutcome).toBe("fail");
	});
});
