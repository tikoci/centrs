/**
 * QA results store — a `bun:sqlite` history of CHR integration runs (JG-18).
 *
 * The RouterOS channel → version mapping drifts as MikroTik promotes builds, so
 * one "stable" or "long-term" run means a different version over time. This
 * keeps one row per CHR run — channel, the version that actually booted,
 * pass/fail, date, commit — so the **must-pass policy** (current long-term and
 * newer must pass; older than current long-term is best-effort) is evaluated
 * against real history rather than a hard-coded version string.
 *
 * The run shape is ingested from the integration-evidence JSONL that
 * `recordIntegrationEvidence` (`test/integration/chr.ts`) appends. The store is
 * deliberately append-only and additive: recording a result never changes a
 * run's pass/fail, so it can run as an `if: always()` CI step.
 *
 * CLI (used by `.github/workflows/qa.yaml`):
 *   bun run scripts/qa-results-db.ts --db PATH --channel stable \
 *     --outcome pass --commit SHA --report report.jsonl [--requested-version V]
 */
import { Database } from "bun:sqlite";

export type QaOutcome = "pass" | "fail";

export interface QaRunInput {
	channel: string;
	requestedVersion?: string;
	resolvedVersion?: string;
	outcome: QaOutcome;
	suites?: number;
	examples?: number;
	commitSha?: string;
	/** ISO timestamp; defaults to now. */
	runDate?: string;
}

export interface QaRunRow {
	id: number;
	run_date: string;
	channel: string;
	requested_version: string | null;
	resolved_version: string | null;
	outcome: QaOutcome;
	suites: number;
	examples: number;
	commit_sha: string | null;
}

/** Open (creating if needed) the QA results DB and ensure the schema exists. */
export function openQaResultsDb(path: string): Database {
	const db = new Database(path);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec(`
		CREATE TABLE IF NOT EXISTS qa_runs (
			id INTEGER PRIMARY KEY,
			run_date TEXT NOT NULL,
			channel TEXT NOT NULL,
			requested_version TEXT,
			resolved_version TEXT,
			outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail')),
			suites INTEGER NOT NULL DEFAULT 0,
			examples INTEGER NOT NULL DEFAULT 0,
			commit_sha TEXT
		);
	`);
	db.exec(
		"CREATE INDEX IF NOT EXISTS qa_runs_channel_date ON qa_runs (channel, run_date);",
	);
	return db;
}

/** Append one CHR run result. */
export function recordQaRun(db: Database, input: QaRunInput): QaRunRow {
	const row = db
		.query<QaRunRow, (string | number | null)[]>(
			`INSERT INTO qa_runs
				(run_date, channel, requested_version, resolved_version, outcome, suites, examples, commit_sha)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 RETURNING *`,
		)
		.get(
			input.runDate ?? new Date().toISOString(),
			input.channel,
			input.requestedVersion ?? null,
			input.resolvedVersion ?? null,
			input.outcome,
			input.suites ?? 0,
			input.examples ?? 0,
			input.commitSha ?? null,
		) as QaRunRow | null;
	if (!row) {
		throw new Error(
			"Failed to record QA run: INSERT RETURNING produced no row",
		);
	}
	return row;
}

export interface IntegrationReportSummary {
	channel?: string;
	requestedVersion?: string;
	resolvedVersion?: string;
	suites: number;
	examples: number;
}

/**
 * Fold the integration-evidence JSONL into a per-run summary: the resolved
 * RouterOS version (the version that actually booted — every line in one run
 * reports the same), the requested channel/version, and how many suites and
 * examples produced evidence. Blank/malformed lines are skipped, so a partial
 * report from a failed run still summarizes what ran.
 */
export function summarizeIntegrationReport(
	jsonl: string,
): IntegrationReportSummary {
	let channel: string | undefined;
	let requestedVersion: string | undefined;
	let resolvedVersion: string | undefined;
	let suites = 0;
	let examples = 0;
	for (const line of jsonl.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		suites += 1;
		const version = record["routerosVersion"];
		if (typeof version === "string" && version.length > 0 && !resolvedVersion) {
			resolvedVersion = version;
		}
		const reqChannel = record["requestedChannel"];
		if (typeof reqChannel === "string" && !channel) {
			channel = reqChannel;
		}
		const reqVersion = record["requestedVersion"];
		if (typeof reqVersion === "string" && !requestedVersion) {
			requestedVersion = reqVersion;
		}
		const exampleIds = record["exampleIds"];
		if (Array.isArray(exampleIds)) {
			examples += exampleIds.length;
		}
	}
	return { channel, requestedVersion, resolvedVersion, suites, examples };
}

export interface ChannelStatus {
	channel: string;
	runs: number;
	latestResolvedVersion: string | null;
	latestOutcome: QaOutcome | null;
	latestRunDate: string | null;
}

/** Latest result per channel — the surface the must-pass policy reads. */
export function channelStatuses(db: Database): ChannelStatus[] {
	const channels = db
		.query<{ channel: string }, never[]>(
			"SELECT DISTINCT channel FROM qa_runs ORDER BY channel",
		)
		.all();
	return channels.map(({ channel }) => {
		const latest = db
			.query<QaRunRow, [string]>(
				"SELECT * FROM qa_runs WHERE channel = ? ORDER BY run_date DESC, id DESC LIMIT 1",
			)
			.get(channel) as QaRunRow | null;
		const runs = (
			db
				.query<{ n: number }, [string]>(
					"SELECT COUNT(*) AS n FROM qa_runs WHERE channel = ?",
				)
				.get(channel) as { n: number }
		).n;
		return {
			channel,
			runs,
			latestResolvedVersion: latest?.resolved_version ?? null,
			latestOutcome: latest?.outcome ?? null,
			latestRunDate: latest?.run_date ?? null,
		};
	});
}

/** Every recorded run, oldest first — the source for the accumulating history. */
export function allRuns(db: Database): QaRunRow[] {
	return db.query<QaRunRow, never[]>("SELECT * FROM qa_runs ORDER BY id").all();
}

/**
 * A run as it lives on the `qa-history` branch: the DB row minus the
 * per-DB `id` (which is reassigned whenever the store is rebuilt from JSONL).
 * Snake_case mirrors the table columns so the append-log reads the same as the
 * schema in a `git diff`.
 */
export type QaRunRecord = Omit<QaRunRow, "id">;

/** One JSONL line for the append-only history log. */
export function serializeRun(row: QaRunRow): string {
	const { id: _id, ...record } = row;
	return JSON.stringify(record satisfies QaRunRecord);
}

/**
 * Parse the accumulating history JSONL into rows. Blank and malformed lines are
 * skipped (tolerant, like {@link summarizeIntegrationReport}) so a half-written
 * history never breaks the gate; only lines with the required keys are kept.
 */
export function parseHistoryJsonl(jsonl: string): QaRunRecord[] {
	const rows: QaRunRecord[] = [];
	for (const line of jsonl.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		const channel = record["channel"];
		const outcome = record["outcome"];
		const runDate = record["run_date"];
		if (
			typeof channel !== "string" ||
			(outcome !== "pass" && outcome !== "fail") ||
			typeof runDate !== "string"
		) {
			continue;
		}
		rows.push({
			run_date: runDate,
			channel,
			requested_version:
				typeof record["requested_version"] === "string"
					? record["requested_version"]
					: null,
			resolved_version:
				typeof record["resolved_version"] === "string"
					? record["resolved_version"]
					: null,
			outcome,
			suites: typeof record["suites"] === "number" ? record["suites"] : 0,
			examples: typeof record["examples"] === "number" ? record["examples"] : 0,
			commit_sha:
				typeof record["commit_sha"] === "string" ? record["commit_sha"] : null,
		});
	}
	return rows;
}

/**
 * Must-pass policy: a regression on a **released** channel reds a merge; beta
 * and test channels record to history but never gate (their EC-SRP5/btest path
 * is intermittently flaky — JG-31 — and a beta flake must never red main). The
 * "active set" promotion (running `development` on push) is decoupled from this:
 * a channel can run on every push yet still be best-effort.
 */
export const MUST_PASS_CHANNELS: readonly string[] = ["stable", "long-term"];

export type GatePolicy = "must-pass" | "best-effort";

export function channelPolicy(channel: string): GatePolicy {
	return MUST_PASS_CHANNELS.includes(channel) ? "must-pass" : "best-effort";
}

export interface GateResult {
	ok: boolean;
	/** Must-pass channels whose latest result is `fail` — these red the gate. */
	failures: ChannelStatus[];
	/** Must-pass channels considered (have data). */
	evaluated: ChannelStatus[];
}

/**
 * Evaluate the must-pass gate over the current run's channel statuses. Only an
 * explicit `fail` on a must-pass channel fails the gate; a must-pass channel
 * that produced no row (e.g. an infra-absent leg) is the orchestrator's concern
 * to warn about, not a hard fail — infra absence must not red a merge the way a
 * real RouterOS regression does.
 */
export function evaluateMustPassGate(statuses: ChannelStatus[]): GateResult {
	const evaluated = statuses.filter(
		(s) => channelPolicy(s.channel) === "must-pass",
	);
	const failures = evaluated.filter((s) => s.latestOutcome === "fail");
	return { ok: failures.length === 0, failures, evaluated };
}

/** Rebuild an in-memory store from history records (ids are reassigned). */
export function rebuildHistoryDb(records: QaRunRecord[]): Database {
	const db = openQaResultsDb(":memory:");
	for (const record of records) {
		recordQaRun(db, {
			channel: record.channel,
			requestedVersion: record.requested_version ?? undefined,
			resolvedVersion: record.resolved_version ?? undefined,
			outcome: record.outcome,
			suites: record.suites,
			examples: record.examples,
			commitSha: record.commit_sha ?? undefined,
			runDate: record.run_date,
		});
	}
	return db;
}

function flag(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

async function main(args: readonly string[]): Promise<number> {
	const dbPath = flag(args, "--db");
	const channel = flag(args, "--channel");
	const outcome = flag(args, "--outcome");
	if (!dbPath || !channel || (outcome !== "pass" && outcome !== "fail")) {
		console.error(
			"usage: qa-results-db.ts --db PATH --channel CH --outcome pass|fail [--commit SHA] [--requested-version V] [--report JSONL]",
		);
		return 2;
	}
	const reportPath = flag(args, "--report");
	let summary: IntegrationReportSummary = { suites: 0, examples: 0 };
	if (reportPath) {
		const file = Bun.file(reportPath);
		if (await file.exists()) {
			summary = summarizeIntegrationReport(await file.text());
		}
	}
	const db = openQaResultsDb(dbPath);
	const row = recordQaRun(db, {
		channel,
		requestedVersion:
			flag(args, "--requested-version") || summary.requestedVersion,
		resolvedVersion: summary.resolvedVersion,
		outcome,
		suites: summary.suites,
		examples: summary.examples,
		commitSha: flag(args, "--commit"),
	});
	console.log(
		`recorded qa_run #${row.id}: ${row.channel} → ${row.resolved_version ?? "?"} = ${row.outcome} (${row.examples} examples)`,
	);
	for (const status of channelStatuses(db)) {
		console.log(
			`  ${status.channel}: latest ${status.latestResolvedVersion ?? "?"} = ${status.latestOutcome ?? "?"} (${status.runs} runs)`,
		);
	}
	db.close();
	return 0;
}

if (import.meta.main) {
	// Best-effort telemetry: surface a clear message (the CI step is
	// continue-on-error, so a crash here logs but does not fail the QA job).
	try {
		process.exit(await main(Bun.argv.slice(2)));
	} catch (error) {
		console.error(`::warning title=QA results store::${String(error)}`);
		process.exit(1);
	}
}
