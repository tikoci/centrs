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
		) as unknown as QaRunRow;
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
	process.exit(await main(Bun.argv.slice(2)));
}
