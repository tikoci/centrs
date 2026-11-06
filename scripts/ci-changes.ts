/**
 * Change classification for `.github/workflows/ci.yaml`: does this event need
 * the unit, build, corpus and CHR smoke jobs, or only the repo checks?
 *
 * Those jobs skip with a job-level `if:` — never a workflow-level `paths:`. A
 * required check whose workflow never starts stays pending forever; a job
 * skipped by `if:` reports success. That is also why a skip must be earned: a
 * skipped required check is indistinguishable from a green one.
 *
 * **Docs-only** is defined conservatively by {@link isDocsOnlyPath}: a path is
 * docs-only when no unit test, build input, corpus census or CHR smoke can read
 * it. Prose that a test parses (`docs/MATRIX.md`, `commands/explain/README.md`),
 * generated docs (`docs/CLI.md`, `docs/errors/`) and the executable specs
 * (`commands/<name>/examples.md`) are code for this purpose.
 * `test/unit/ci-changes.test.ts` fails when a test, script or source file
 * starts reading a path this module calls docs-only.
 *
 * Decisions ({@link classify}):
 *   - pull_request: the PR's own diff against its base is docs-only → skip.
 *   - pull_request (synchronize) and push to main: the diff since the previous
 *     head is docs-only, the previous head is an ancestor, and CI on it
 *     concluded success → skip; the heavy results carry over unchanged.
 *   - anything else (dispatch, an unknown event, a lookup error) → run.
 *
 * Repo checks (`lint:ci`) always run, so spelling and markdown lint still gate a
 * docs-only change.
 *
 * CLI (used by ci.yaml's `changes` job):
 *   bun run scripts/ci-changes.ts
 *     env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH
 *     appends heavy=true|false to $GITHUB_OUTPUT and a reason to
 *     $GITHUB_STEP_SUMMARY. Never exits non-zero: any failure prints a warning
 *     and answers heavy=true.
 */

// cspell:ignore vnd
import { appendFile } from "node:fs/promises";

/** Root-level prose read by people and agents only. */
const ROOT_PROSE = new Set([
	"AGENTS.md",
	"CLAUDE.md",
	"CHANGELOG.md",
	"SECURITY.md",
	"README.md",
	"GLOSSARY.txt",
]);

/** Markdown that a unit test parses, so editing it can change a test result. */
export const PROSE_READ_BY_TESTS: ReadonlySet<string> = new Set([
	"docs/MATRIX.md", // test/unit/protocol-registry.test.ts
	"commands/explain/README.md", // the explain census README tests
]);

/** Directories whose markdown is generated, a fixture, or next to code. */
const CODE_DIRS = ["src/", "test/", "scripts/", "docs/errors/"];

/**
 * Whether changing `path` can never change the result of unit, build, corpus or
 * CHR smoke. Unknown means no: only the listed prose shapes qualify.
 */
export function isDocsOnlyPath(path: string): boolean {
	if (ROOT_PROSE.has(path)) return true;
	const base = path.slice(path.lastIndexOf("/") + 1);
	// Directory agent guides are prose wherever they live (src/AGENTS.md too).
	if (base === "AGENTS.md" || base === "CLAUDE.md") return true;
	if (!path.endsWith(".md")) return false;
	if (PROSE_READ_BY_TESTS.has(path)) return false;
	if (CODE_DIRS.some((dir) => path.startsWith(dir))) return false;
	if (path === "docs/CLI.md") return false; // generated, drift-tested
	if (path.startsWith(".github/instructions/")) return true;
	if (
		path === ".github/copilot-instructions.md" ||
		path === ".github/pull_request_template.md"
	) {
		return true;
	}
	if (path === "docs/CONSTITUTION.md") return true;
	// commands/<name>/README.md and AGENTS.md; examples.md is the executable spec.
	return /^commands\/[^/]+\/README\.md$/.test(path);
}

/** The first path that is not docs-only, or null when every one is. */
export function firstCodePath(paths: readonly string[]): string | null {
	return paths.find((path) => !isDocsOnlyPath(path)) ?? null;
}

export interface Classification {
	heavy: boolean;
	reason: string;
}

/** A diff, or why it could not be trusted as complete. */
export type FileList = { files: readonly string[] } | { incomplete: string };

export interface ClassifyInput {
	event: string;
	/** pull_request: the PR's files against its base. */
	prFiles?: FileList;
	/**
	 * Push, or a pull_request synchronize: the files since the previous head,
	 * plus whether that head is an ancestor and whether CI on it passed.
	 */
	sinceBefore?: {
		files: FileList;
		ancestor: boolean;
		previousCi: "success" | "other" | "none";
	};
}

function describeDiff(list: FileList, label: string): Classification | null {
	if ("incomplete" in list) {
		return { heavy: true, reason: `${label}: ${list.incomplete}` };
	}
	if (list.files.length === 0) {
		return { heavy: true, reason: `${label} lists no files` };
	}
	const code = firstCodePath(list.files);
	if (code) {
		return {
			heavy: true,
			reason: `${label} touches \`${code}\`, which is not docs-only`,
		};
	}
	return null;
}

export function classify(input: ClassifyInput): Classification {
	if (input.event !== "pull_request" && input.event !== "push") {
		return { heavy: true, reason: `\`${input.event}\` always runs every job` };
	}
	let prReason: string | null = null;
	if (input.event === "pull_request") {
		if (!input.prFiles) {
			prReason = "the PR file list was not read";
		} else {
			const verdict = describeDiff(input.prFiles, "The PR");
			if (!verdict) {
				return { heavy: false, reason: "The PR changes docs only." };
			}
			prReason = verdict.reason;
		}
	}
	const since = input.sinceBefore;
	if (!since) {
		return { heavy: true, reason: prReason ?? "no previous head to compare" };
	}
	const prefix = prReason ? `${prReason}; ` : "";
	if (!since.ancestor) {
		return {
			heavy: true,
			reason: `${prefix}the previous head is not an ancestor (force push or rebase)`,
		};
	}
	const verdict = describeDiff(since.files, "The diff since the previous head");
	if (verdict) return { heavy: true, reason: `${prefix}${verdict.reason}` };
	if (since.previousCi !== "success") {
		return {
			heavy: true,
			reason: `${prefix}only docs changed since the previous head, but CI on it did not pass, so there is nothing to carry over`,
		};
	}
	return {
		heavy: false,
		reason: `${prefix}only docs changed since the previous head, and CI passed on it; its results carry over.`,
	};
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/** GitHub caps both listings; a full page at the cap may be truncated. */
const PR_FILES_CAP = 3000;
const COMPARE_FILES_CAP = 300;

function env(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

async function github<T>(path: string): Promise<T> {
	const response = await fetch(
		`https://api.github.com/repos/${env("GITHUB_REPOSITORY")}/${path}`,
		{
			headers: {
				authorization: `Bearer ${env("GH_TOKEN")}`,
				accept: "application/vnd.github+json",
				"x-github-api-version": "2022-11-28",
			},
		},
	);
	if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
	return (await response.json()) as T;
}

interface ChangedFile {
	filename: string;
	previous_filename?: string;
}

/** A rename touches both names; either may be code. */
function names(files: readonly ChangedFile[]): string[] {
	return files.flatMap((file) =>
		file.previous_filename
			? [file.filename, file.previous_filename]
			: [file.filename],
	);
}

async function prFiles(pr: number): Promise<FileList> {
	const files: ChangedFile[] = [];
	for (let page = 1; page <= PR_FILES_CAP / 100; page++) {
		const batch = await github<ChangedFile[]>(
			`pulls/${pr}/files?per_page=100&page=${page}`,
		);
		files.push(...batch);
		if (batch.length < 100) return { files: names(files) };
	}
	return { incomplete: `the PR has ${PR_FILES_CAP}+ files` };
}

const SHA = /^[0-9a-f]{40}$/;

async function sinceBefore(
	before: string,
	after: string,
	event: string,
): Promise<ClassifyInput["sinceBefore"]> {
	const compare = await github<{ status: string; files?: ChangedFile[] }>(
		`compare/${before}...${after}`,
	);
	const files = compare.files ?? [];
	const list: FileList =
		files.length >= COMPARE_FILES_CAP
			? { incomplete: `${COMPARE_FILES_CAP}+ files since the previous head` }
			: { files: names(files) };
	const runs = await github<{
		workflow_runs: { status: string; conclusion: string | null }[];
	}>(`actions/workflows/ci.yaml/runs?head_sha=${before}&event=${event}`);
	// Newest first. Only the latest run on that head speaks for it.
	const latest = runs.workflow_runs[0];
	const previousCi = !latest
		? "none"
		: latest.status === "completed" && latest.conclusion === "success"
			? "success"
			: "other";
	return { files: list, ancestor: compare.status === "ahead", previousCi };
}

async function gather(): Promise<ClassifyInput> {
	const event = env("GITHUB_EVENT_NAME");
	const payload = (await Bun.file(env("GITHUB_EVENT_PATH")).json()) as {
		action?: string;
		before?: string;
		after?: string;
		number?: number;
		pull_request?: { head: { sha: string } };
	};
	const input: ClassifyInput = { event };
	if (event === "pull_request" && payload.number !== undefined) {
		input.prFiles = await prFiles(payload.number);
		if (input.prFiles && "files" in input.prFiles) {
			if (firstCodePath(input.prFiles.files) === null) return input;
		}
		const after = payload.after ?? payload.pull_request?.head.sha;
		if (
			payload.action === "synchronize" &&
			payload.before &&
			after &&
			SHA.test(payload.before) &&
			SHA.test(after)
		) {
			input.sinceBefore = await sinceBefore(payload.before, after, event);
		}
	}
	if (
		event === "push" &&
		payload.before &&
		payload.after &&
		SHA.test(payload.before) &&
		SHA.test(payload.after) &&
		!/^0+$/.test(payload.before)
	) {
		input.sinceBefore = await sinceBefore(payload.before, payload.after, event);
	}
	return input;
}

async function main(): Promise<number> {
	let result: Classification;
	try {
		result = classify(await gather());
	} catch (error) {
		console.log(
			`::warning title=Change classification::${String(error)}; running every job`,
		);
		result = {
			heavy: true,
			reason: "classification failed; running every job",
		};
	}
	const output = process.env["GITHUB_OUTPUT"];
	if (output) await appendFile(output, `heavy=${result.heavy}\n`);
	const summary = process.env["GITHUB_STEP_SUMMARY"];
	if (summary) {
		await appendFile(
			summary,
			`## Change classification\n\n${result.heavy ? "Unit, build, corpus and CHR smoke **run**" : "Unit, build, corpus and CHR smoke **skip**"}: ${result.reason}\n`,
		);
	}
	console.log(`heavy=${result.heavy}: ${result.reason}`);
	return 0;
}

if (import.meta.main) process.exit(await main());
