/**
 * Release planning for `.github/workflows/release.yaml` (#484, #485).
 *
 * A release publishes the commit the dispatch ran on (`GITHUB_SHA`). It is never
 * an older "last green" commit, because npm provenance attests `GITHUB_SHA` and
 * would otherwise sign the wrong source.
 *
 * Two channels:
 *   - next:   `<base>-next.<run_number>` → npm tag `next`. The version is written
 *             into package.json inside the runner only; no commit, no git tag.
 *   - latest: the committed plain version → npm tag `latest`, `next` moved to it,
 *             tag `v<version>` + GitHub Release from its CHANGELOG section.
 *
 * The CHR gate reuses main's QA on that exact commit instead of sweeping again
 * (see {@link qaVerdict}). Everything that decides is a pure function here and is
 * unit-tested in `test/unit/release-plan.test.ts`; the CLI below only fetches.
 *
 * CLI:
 *   bun run scripts/release-plan.ts plan --channel next|latest [--no-wait]
 *     env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_REF, GITHUB_RUN_NUMBER
 *     writes version / npm-tag / base / qa to $GITHUB_OUTPUT, a summary to
 *     $GITHUB_STEP_SUMMARY, and exits 1 with the reason on a refusal.
 *   bun run scripts/release-plan.ts notes <X.Y.Z>
 *     prints that version's CHANGELOG section body (the GitHub Release notes).
 */

// cspell:ignore vnd
import { appendFile } from "node:fs/promises";

export type Channel = "next" | "latest";

const PLAIN_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** The stable version a `next` cut is heading to. `0.1.9-next` → `0.1.9`; a plain
 * version has already been (or is about to be) cut stable, so `0.1.9` → `0.1.10`. */
export function nextBaseVersion(packageVersion: string): string {
	const dash = packageVersion.indexOf("-");
	if (dash >= 0) return packageVersion.slice(0, dash);
	const match = PLAIN_VERSION.exec(packageVersion);
	if (!match)
		throw new Error(`package.json version is not SemVer: ${packageVersion}`);
	return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function nextVersion(packageVersion: string, runNumber: number): string {
	return `${nextBaseVersion(packageVersion)}-next.${runNumber}`;
}

export interface ChangelogSection {
	version: string;
	/** `"next"` for the in-progress section, else its `YYYY-MM-DD` date. */
	label: string;
	body: string;
}

const SECTION_HEADING = /^## (\d+\.\d+\.\d+) — (next|\d{4}-\d{2}-\d{2})\s*$/;

/** The `## X.Y.Z — next` or `## X.Y.Z — YYYY-MM-DD` section for a version. */
export function changelogSection(
	changelog: string,
	version: string,
): ChangelogSection | null {
	const lines = changelog.split("\n");
	const start = lines.findIndex(
		(line) => SECTION_HEADING.exec(line)?.[1] === version,
	);
	if (start < 0) return null;
	const label = SECTION_HEADING.exec(lines[start] ?? "")?.[2] ?? "";
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => line.startsWith("## "));
	const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
	return { version, label, body };
}

export interface WorkflowRun {
	event: string;
	status: string;
	conclusion: string | null;
	head_sha: string;
}

// Run conclusions as GitHub documents them. A verdict echoes one of these
// literals, never the API's string, so nothing from the API reaches the step
// summary or $GITHUB_OUTPUT.
const CONCLUSIONS = [
	"success",
	"failure",
	"cancelled",
	"skipped",
	"timed_out",
	"action_required",
	"neutral",
	"stale",
	"startup_failure",
] as const;

export type QaAction = "reuse" | "wait" | "sweep" | "refuse";

export interface QaVerdict {
	action: QaAction;
	message: string;
}

/**
 * What to do about the CHR gate for `sha`, from `qa.yaml`'s runs on that commit.
 *
 * Only push and schedule runs count: they always fan the full active channel set,
 * while a dispatch may have pinned one channel. A green run anywhere on the commit
 * is enough; one still running is worth waiting for; a newer push cancels QA on
 * main, so a commit with only cancelled runs gets its own sweep; a real failure
 * refuses the release.
 */
export function qaVerdict(
	runs: readonly WorkflowRun[],
	sha: string,
): QaVerdict {
	const relevant = runs.filter(
		(run) =>
			run.head_sha === sha &&
			(run.event === "push" || run.event === "schedule"),
	);
	const green = relevant.find((run) => run.conclusion === "success");
	if (green) {
		return { action: "reuse", message: "QA passed on this commit." };
	}
	const running = relevant.find((run) => run.status !== "completed");
	if (running) {
		return { action: "wait", message: "QA is still running on this commit." };
	}
	const failed = relevant.find(
		(run) => run.conclusion !== "cancelled" && run.conclusion !== "skipped",
	);
	if (failed) {
		const conclusion =
			CONCLUSIONS.find((known) => known === failed.conclusion) ?? "unknown";
		return {
			action: "refuse",
			message: `QA ended ${conclusion} on this commit, so it is not released.`,
		};
	}
	return {
		action: "sweep",
		message:
			"No completed QA run on this commit (none, or every run was cancelled by a newer push); the release runs its own sweep.",
	};
}

export interface NpmState {
	versions: readonly string[];
	latest: string | undefined;
}

export interface Plan {
	channel: Channel;
	version: string;
	npmTag: Channel;
	/** The X.Y.Z whose CHANGELOG section describes this build. */
	base: string;
}

/** The version to publish, or an Error naming why the cut is refused. */
export function planRelease(input: {
	channel: Channel;
	packageVersion: string;
	runNumber: number;
	npm: NpmState;
	changelog: string;
	tagExists: boolean;
}): Plan | Error {
	const { channel, packageVersion, npm } = input;
	if (channel === "next") {
		const version = nextVersion(packageVersion, input.runNumber);
		if (npm.versions.includes(version)) {
			return new Error(`${version} is already on npm.`);
		}
		if (npm.latest && Bun.semver.order(version, npm.latest) <= 0) {
			return new Error(
				`${version} would not sort above npm's latest (see npm view @tikoci/centrs dist-tags). Set package.json to the next version with a -next suffix.`,
			);
		}
		return {
			channel,
			version,
			npmTag: "next",
			base: nextBaseVersion(packageVersion),
		};
	}
	if (!PLAIN_VERSION.test(packageVersion)) {
		return new Error(
			`A latest release needs a plain package.json version; got ${packageVersion}. Commit the version and the dated CHANGELOG heading first.`,
		);
	}
	if (npm.versions.includes(packageVersion)) {
		return new Error(`${packageVersion} is already on npm.`);
	}
	if (npm.latest && Bun.semver.order(packageVersion, npm.latest) <= 0) {
		return new Error(
			`${packageVersion} would not sort above npm's latest, so publishing it would move latest backwards (see npm view @tikoci/centrs dist-tags).`,
		);
	}
	if (input.tagExists) {
		return new Error(`Tag v${packageVersion} already exists.`);
	}
	const section = changelogSection(input.changelog, packageVersion);
	if (!section || section.label === "next" || section.body === "") {
		return new Error(
			`CHANGELOG.md needs a non-empty "## ${packageVersion} — YYYY-MM-DD" section.`,
		);
	}
	return {
		channel,
		version: packageVersion,
		npmTag: "latest",
		base: packageVersion,
	};
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const WAIT_POLL_MS = 30_000;
const WAIT_LIMIT_MS = 45 * 60_000;

function env(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

async function github(path: string): Promise<Response> {
	return fetch(
		`https://api.github.com/repos/${env("GITHUB_REPOSITORY")}/${path}`,
		{
			headers: {
				authorization: `Bearer ${env("GH_TOKEN")}`,
				accept: "application/vnd.github+json",
				"x-github-api-version": "2022-11-28",
			},
		},
	);
}

async function qaRuns(sha: string): Promise<WorkflowRun[]> {
	const response = await github(
		`actions/workflows/qa.yaml/runs?head_sha=${sha}&per_page=50`,
	);
	if (!response.ok) throw new Error(`QA run lookup: HTTP ${response.status}`);
	return ((await response.json()) as { workflow_runs: WorkflowRun[] })
		.workflow_runs;
}

async function npmState(name: string): Promise<NpmState> {
	const response = await fetch(
		`https://registry.npmjs.org/${encodeURIComponent(name)}`,
	);
	if (response.status === 404) return { versions: [], latest: undefined };
	if (!response.ok) throw new Error(`npm registry: HTTP ${response.status}`);
	const doc = (await response.json()) as {
		versions?: Record<string, unknown>;
		"dist-tags"?: Record<string, string>;
	};
	return {
		versions: Object.keys(doc.versions ?? {}),
		latest: doc["dist-tags"]?.["latest"],
	};
}

/** 404 is the only answer that means "no such tag"; any other failure stops the
 * release rather than letting a stable publish run into an existing tag. */
async function tagExists(version: string): Promise<boolean> {
	const response = await github(`git/ref/tags/v${version}`);
	if (response.status === 404) return false;
	if (!response.ok) throw new Error(`Tag lookup: HTTP ${response.status}`);
	return true;
}

async function writeLines(
	file: string | undefined,
	lines: string[],
): Promise<void> {
	if (file) await appendFile(file, `${lines.join("\n")}\n`);
}

async function plan(args: string[]): Promise<number> {
	const channel = args[args.indexOf("--channel") + 1];
	if (channel !== "next" && channel !== "latest") {
		throw new Error(`--channel must be next or latest; got ${channel}`);
	}
	const wait = !args.includes("--no-wait");
	const summary = process.env["GITHUB_STEP_SUMMARY"];
	const refuse = async (message: string) => {
		console.error(`::error::${message}`);
		await writeLines(summary, ["## Release refused", "", message]);
		return 1;
	};

	if (env("GITHUB_REF") !== "refs/heads/main") {
		return refuse(`Releases run from main only (got ${env("GITHUB_REF")}).`);
	}
	const sha = env("GITHUB_SHA");
	const pkg = (await Bun.file("package.json").json()) as {
		name: string;
		version: string;
	};
	const changelog = await Bun.file("CHANGELOG.md").text();
	const result = planRelease({
		channel,
		packageVersion: pkg.version,
		runNumber: Number(env("GITHUB_RUN_NUMBER")),
		npm: await npmState(pkg.name),
		changelog,
		tagExists: await tagExists(pkg.version),
	});
	if (result instanceof Error) return refuse(result.message);

	// Built from this run's own context, not from the API: every QA run on the
	// commit is listed there.
	const checks = `https://github.com/${env("GITHUB_REPOSITORY")}/commit/${sha}/checks`;
	const deadline = Date.now() + WAIT_LIMIT_MS;
	let verdict = qaVerdict(await qaRuns(sha), sha);
	while (verdict.action === "wait" && wait && Date.now() < deadline) {
		console.log(verdict.message);
		await Bun.sleep(WAIT_POLL_MS);
		verdict = qaVerdict(await qaRuns(sha), sha);
	}
	if (verdict.action === "refuse") {
		return refuse(`${verdict.message} ${checks}`);
	}
	if (verdict.action === "wait" && wait) {
		return refuse(`QA did not finish within 45 minutes: ${checks}`);
	}

	const section = changelogSection(changelog, result.base);
	await writeLines(process.env["GITHUB_OUTPUT"], [
		`version=${result.version}`,
		`npm-tag=${result.npmTag}`,
		`base=${result.base}`,
		`qa=${verdict.action}`,
	]);
	await writeLines(summary, [
		"## Release plan",
		"",
		`- Version: \`${result.version}\` → npm tag \`${result.npmTag}\`${result.npmTag === "latest" ? " (and `next` moved to it)" : ""}`,
		`- Commit: \`${sha}\``,
		`- CHR gate: ${verdict.message} ([checks](${checks}))${wait ? "" : " Dry run: reported as it stands, not waited on or swept."}`,
		"",
		section
			? `### CHANGELOG — ${section.version} — ${section.label}\n\n${section.body}`
			: `No \`## ${result.base} — next\` section in CHANGELOG.md.`,
	]);
	if (!section)
		console.log(
			`::notice::No "## ${result.base} — next" section in CHANGELOG.md.`,
		);
	console.log(
		`${result.version} (${result.npmTag}); CHR gate: ${verdict.action}`,
	);
	return 0;
}

async function notes(version: string | undefined): Promise<number> {
	if (!version) throw new Error("notes needs a version");
	const section = changelogSection(
		await Bun.file("CHANGELOG.md").text(),
		version,
	);
	if (!section) throw new Error(`No CHANGELOG.md section for ${version}`);
	console.log(section.body);
	return 0;
}

if (import.meta.main) {
	const [command, ...args] = process.argv.slice(2);
	if (command === "plan") process.exit(await plan(args));
	if (command === "notes") process.exit(await notes(args[0]));
	throw new Error(
		"usage: release-plan.ts plan --channel next|latest [--no-wait] | notes <X.Y.Z>",
	);
}
