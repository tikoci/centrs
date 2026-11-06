/**
 * The nightly CHR sweep's two decisions (`.github/workflows/qa.yaml`,
 * `.github/workflows/ci.yaml`).
 *
 * **Pre-flight** ({@link nightlyDecision}): the nightly boots every active
 * RouterOS channel only when something it tests moved since the last completed
 * nightly — main's HEAD, or the version any channel resolves to. The
 * fingerprint of that comparison ({@link Fingerprint}) is committed to the
 * `qa-history` branch as `nightly-fingerprint.json` by the run that swept. A
 * run that cannot resolve the versions, or find the previous fingerprint,
 * sweeps: an unneeded sweep costs runner minutes, a missed one hides a
 * regression.
 *
 * **Main health** ({@link mainHealth}): a PR cannot merge while the latest
 * nightly that swept failed on a must-pass (released) channel. A nightly the
 * pre-flight skipped tested nothing, so it is passed over, as is one that was
 * cancelled. A PR labelled {@link FIXES_MAIN_LABEL} passes, so a repair merges
 * on its own green CI.
 *
 * CLI:
 *   bun run scripts/qa-nightly.ts preflight [--summary FILE]
 *     env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA
 *     appends run=true|false and fingerprint=<json> to $GITHUB_OUTPUT.
 *   bun run scripts/qa-nightly.ts main-health --pr <number> [--summary FILE]
 *     env: GH_TOKEN, GITHUB_REPOSITORY. Exits 1 while main is unhealthy.
 */

// cspell:ignore vnd
import { appendFile } from "node:fs/promises";
import { resolveChannelPlan } from "./qa-active-channels.ts";
import { MUST_PASS_CHANNELS } from "./qa-results-db.ts";

export const FIXES_MAIN_LABEL = "fixes-main";
export const FINGERPRINT_FILE = "nightly-fingerprint.json";
export const QA_HISTORY_BRANCH = "qa-history";
/** `qa.yaml` job names this module reads back through the jobs API. */
export const CHR_JOB_PREFIX = "CHR • ";
export const GATE_JOB = "Accumulate + must-pass gate";

export interface Fingerprint {
	sha: string;
	/** Channel → resolved RouterOS version, sorted by channel. */
	versions: Record<string, string>;
}

export function fingerprint(
	sha: string,
	versions: Record<string, string>,
): Fingerprint {
	const sorted: Record<string, string> = {};
	for (const channel of Object.keys(versions).sort()) {
		sorted[channel] = versions[channel] ?? "";
	}
	return { sha, versions: sorted };
}

/** Parse a stored fingerprint; anything malformed reads as absent. */
export function parseFingerprint(text: string): Fingerprint | null {
	try {
		const value = JSON.parse(text) as Partial<Fingerprint>;
		if (typeof value.sha !== "string" || !value.versions) return null;
		const versions = value.versions as Record<string, unknown>;
		if (Object.values(versions).some((v) => typeof v !== "string")) return null;
		return fingerprint(value.sha, versions as Record<string, string>);
	} catch {
		return null;
	}
}

export interface NightlyDecision {
	run: boolean;
	reason: string;
}

export function nightlyDecision(
	current: { sha: string; versions: Record<string, string> | null },
	previous: Fingerprint | null,
): NightlyDecision {
	if (!current.versions) {
		return {
			run: true,
			reason: "RouterOS channel versions could not be resolved, so it sweeps.",
		};
	}
	if (!previous) {
		return {
			run: true,
			reason: "No previous nightly fingerprint on `qa-history`, so it sweeps.",
		};
	}
	const changed: string[] = [];
	if (previous.sha !== current.sha) {
		changed.push(
			`main moved \`${previous.sha.slice(0, 7)}\` → \`${current.sha.slice(0, 7)}\``,
		);
	}
	const channels = new Set([
		...Object.keys(previous.versions),
		...Object.keys(current.versions),
	]);
	for (const channel of [...channels].sort()) {
		const before = previous.versions[channel] ?? "none";
		const after = current.versions[channel] ?? "none";
		if (before !== after) changed.push(`${channel} ${before} → ${after}`);
	}
	if (changed.length === 0) {
		return {
			run: false,
			reason: `Nothing changed since the last nightly (main \`${current.sha.slice(0, 7)}\`, same channel versions); skipping the sweep.`,
		};
	}
	return {
		run: true,
		reason: `Changed since the last nightly: ${changed.join("; ")}.`,
	};
}

export interface Job {
	name: string;
	status: string;
	conclusion: string | null;
}

/** Whether a QA run booted any CHR leg (a skipped nightly boots none). */
export function swept(jobs: readonly Job[]): boolean {
	return jobs.some(
		(job) =>
			job.name.startsWith(CHR_JOB_PREFIX) &&
			job.conclusion !== null &&
			job.conclusion !== "skipped",
	);
}

const FAILED = new Set(["failure", "timed_out"]);

/** The must-pass channels whose leg, or the gate over them, failed. */
export function mustPassFailures(jobs: readonly Job[]): string[] {
	const failed = new Set<string>();
	for (const job of jobs) {
		if (!job.name.startsWith(CHR_JOB_PREFIX)) continue;
		const channel = job.name.slice(CHR_JOB_PREFIX.length).split(" • ")[0] ?? "";
		if (
			MUST_PASS_CHANNELS.includes(channel) &&
			FAILED.has(job.conclusion ?? "")
		) {
			failed.add(channel);
		}
	}
	const gate = jobs.find((job) => job.name === GATE_JOB);
	if (failed.size === 0 && gate && FAILED.has(gate.conclusion ?? "")) {
		failed.add("must-pass gate");
	}
	return [...failed];
}

export interface NightlyRun {
	id: number;
	html_url: string;
	head_sha: string;
	conclusion: string | null;
	jobs: readonly Job[];
}

export interface Health {
	ok: boolean;
	message: string;
}

/**
 * Main health from completed scheduled runs, newest first. The first run that
 * swept and was not cancelled decides.
 */
export function mainHealth(
	runs: readonly NightlyRun[],
	labels: readonly string[],
): Health {
	const deciding = runs.find(
		(run) => run.conclusion !== "cancelled" && swept(run.jobs),
	);
	if (!deciding) {
		return {
			ok: true,
			message: "No completed nightly sweep yet; main is presumed healthy.",
		};
	}
	const failures = mustPassFailures(deciding.jobs);
	const at = `[nightly ${deciding.id}](${deciding.html_url}) on \`${deciding.head_sha.slice(0, 7)}\``;
	if (failures.length === 0) {
		return {
			ok: true,
			message: `Main is healthy: ${at} passed its must-pass channels.`,
		};
	}
	const red = `${at} failed on ${failures.map((f) => `\`${f}\``).join(", ")}`;
	if (labels.includes(FIXES_MAIN_LABEL)) {
		return {
			ok: true,
			message: `${red}. This PR carries \`${FIXES_MAIN_LABEL}\`, so it may merge on its own green CI.`,
		};
	}
	return {
		ok: false,
		message: `${red}. Ordinary PRs wait until main is green again. A PR that repairs it gets the \`${FIXES_MAIN_LABEL}\` label, then re-runs this job.`,
	};
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function env(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

export async function github(path: string, accept?: string): Promise<Response> {
	return fetch(
		`https://api.github.com/repos/${env("GITHUB_REPOSITORY")}/${path}`,
		{
			headers: {
				authorization: `Bearer ${env("GH_TOKEN")}`,
				accept: accept ?? "application/vnd.github+json",
				"x-github-api-version": "2022-11-28",
			},
		},
	);
}

async function json<T>(path: string): Promise<T> {
	const response = await github(path);
	if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
	return (await response.json()) as T;
}

/** The latest attempt's jobs for a run. */
export async function runJobs(id: number): Promise<Job[]> {
	return (
		await json<{ jobs: Job[] }>(
			`actions/runs/${id}/jobs?filter=latest&per_page=100`,
		)
	).jobs;
}

function flag(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

async function previousFingerprint(): Promise<Fingerprint | null> {
	const response = await github(
		`contents/${FINGERPRINT_FILE}?ref=${QA_HISTORY_BRANCH}`,
		"application/vnd.github.raw+json",
	);
	if (response.status === 404) return null;
	if (!response.ok) {
		throw new Error(`previous fingerprint: HTTP ${response.status}`);
	}
	return parseFingerprint(await response.text());
}

async function preflight(args: readonly string[]): Promise<number> {
	const sha = env("GITHUB_SHA");
	const plan = await resolveChannelPlan();
	const versions = plan
		? Object.fromEntries(plan.statuses.map((s) => [s.channel, s.version]))
		: null;
	let previous: Fingerprint | null = null;
	let lookupError = "";
	try {
		previous = await previousFingerprint();
	} catch (error) {
		lookupError = String(error);
		console.log(`::warning title=Nightly pre-flight::${lookupError}; sweeping`);
	}
	const decision = nightlyDecision({ sha, versions }, previous);
	const current = fingerprint(sha, versions ?? {});
	const output = process.env["GITHUB_OUTPUT"];
	if (output) {
		await appendFile(
			output,
			`run=${decision.run}\nfingerprint=${JSON.stringify(current)}\n`,
		);
	}
	const summary = flag(args, "--summary");
	if (summary) {
		const rows = Object.entries(current.versions).map(
			([channel, version]) =>
				`| ${channel} | ${previous?.versions[channel] ?? "—"} | ${version} |`,
		);
		await appendFile(
			summary,
			[
				"## Nightly pre-flight",
				"",
				`${decision.run ? "**Sweep.**" : "**Skip.**"} ${decision.reason}`,
				"",
				`Previous fingerprint: ${previous ? `main \`${previous.sha.slice(0, 7)}\`` : lookupError ? "lookup failed" : "none"}`,
				"",
				"| Channel | Last nightly | Now |",
				"| --- | --- | --- |",
				...rows,
				"",
			].join("\n"),
		);
	}
	console.log(`run=${decision.run}: ${decision.reason}`);
	return 0;
}

async function health(args: readonly string[]): Promise<number> {
	const pr = flag(args, "--pr");
	if (!pr || !/^\d+$/.test(pr)) throw new Error("--pr <number> is required");
	// Read live, not from the event payload, so adding the label and re-running
	// this job is enough; no `labeled` trigger re-runs all of CI.
	const labels = (await json<{ name: string }[]>(`issues/${pr}/labels`)).map(
		(label) => label.name,
	);
	const listed = await json<{
		workflow_runs: Omit<NightlyRun, "jobs">[];
	}>(
		"actions/workflows/qa.yaml/runs?event=schedule&branch=main&status=completed&per_page=10",
	);
	const runs: NightlyRun[] = [];
	for (const run of listed.workflow_runs) {
		const jobs = await runJobs(run.id);
		runs.push({ ...run, jobs });
		if (run.conclusion !== "cancelled" && swept(jobs)) break;
	}
	const verdict = mainHealth(runs, labels);
	const summary = flag(args, "--summary");
	if (summary) {
		await appendFile(
			summary,
			`## Main health (nightly QA)\n\n${verdict.ok ? "✅" : "❌"} ${verdict.message}\n`,
		);
	}
	if (!verdict.ok) {
		console.log(`::error title=Main health::${verdict.message}`);
		return 1;
	}
	console.log(verdict.message);
	return 0;
}

if (import.meta.main) {
	const [command, ...args] = process.argv.slice(2);
	if (command === "preflight") process.exit(await preflight(args));
	if (command === "main-health") process.exit(await health(args));
	throw new Error("usage: qa-nightly.ts preflight | main-health --pr <n>");
}
