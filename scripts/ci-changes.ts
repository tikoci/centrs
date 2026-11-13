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
 * generated docs (`docs/CLI.md`), the error and tip pages (`docs/errors/`,
 * `docs/tips/`, which the Pages tests assemble) and the executable specs
 * (`commands/<name>/examples.md`) are code for this purpose.
 * `test/unit/ci-changes.test.ts` fails when a test, script or source file
 * starts reading a path this module calls docs-only.
 *
 * Decisions ({@link classify}): a pull_request whose whole diff against its
 * base is docs-only skips, and so does a push to main whose diff since the
 * previous head is. Everything else runs: a PR touching any code (a later
 * docs-only fixup does not change that), a dispatch, a force push, a lookup
 * error.
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
const CODE_DIRS = ["src/", "test/", "scripts/", "docs/errors/", "docs/tips/"];

/**
 * Whether changing `path` can never change the result of unit, build, corpus or
 * CHR smoke. Unknown means no: only the listed prose shapes qualify.
 */
export function isDocsOnlyPath(path: string): boolean {
	if (ROOT_PROSE.has(path)) return true;
	// Before any prose rule: a test may glob these directories (docs/errors/
	// is scanned for every *.md), so even an agent guide there is code.
	if (CODE_DIRS.some((dir) => path.startsWith(dir))) return false;
	const base = path.slice(path.lastIndexOf("/") + 1);
	// Directory agent guides are prose elsewhere (commands/, .github/, docs/).
	if (base === "AGENTS.md" || base === "CLAUDE.md") return true;
	if (!path.endsWith(".md")) return false;
	if (PROSE_READ_BY_TESTS.has(path)) return false;
	if (path === "docs/CLI.md") return false; // generated, drift-tested
	if (path.startsWith(".github/instructions/")) return true;
	if (
		path === ".github/copilot-instructions.md" ||
		path === ".github/pull_request_template.md"
	) {
		return true;
	}
	if (path === "docs/CONSTITUTION.md") return true;
	// commands/<name>/ and components/<name>/ READMEs; examples.md is the
	// executable spec.
	return /^(commands|components)\/[^/]+\/README\.md$/.test(path);
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
	/** pull_request: the PR's files against its base. push: since `before`. */
	files?: FileList;
}

export function classify(input: ClassifyInput): Classification {
	if (input.event !== "pull_request" && input.event !== "push") {
		return { heavy: true, reason: `\`${input.event}\` always runs every job` };
	}
	const label = input.event === "push" ? "The push" : "The PR";
	const list = input.files;
	if (!list) return { heavy: true, reason: `${label}'s files were not read` };
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
	return { heavy: false, reason: `${label} changes docs only.` };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/** GitHub caps both listings; a listing at the cap may be truncated. */
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

/** A push's files since `before`; only a fast-forward diff is trusted. */
async function pushFiles(before: string, after: string): Promise<FileList> {
	const compare = await github<{ status: string; files?: ChangedFile[] }>(
		`compare/${before}...${after}`,
	);
	if (compare.status !== "ahead") {
		return { incomplete: "the previous head is not an ancestor" };
	}
	const files = compare.files ?? [];
	return files.length >= COMPARE_FILES_CAP
		? { incomplete: `${COMPARE_FILES_CAP}+ files since the previous head` }
		: { files: names(files) };
}

async function gather(): Promise<ClassifyInput> {
	const event = env("GITHUB_EVENT_NAME");
	const payload = (await Bun.file(env("GITHUB_EVENT_PATH")).json()) as {
		before?: string;
		after?: string;
		number?: number;
	};
	if (event === "pull_request" && payload.number !== undefined) {
		return { event, files: await prFiles(payload.number) };
	}
	const { before, after } = payload;
	if (
		event === "push" &&
		before &&
		after &&
		SHA.test(before) &&
		SHA.test(after) &&
		!/^0+$/.test(before)
	) {
		return { event, files: await pushFiles(before, after) };
	}
	return { event };
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
