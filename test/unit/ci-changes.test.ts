import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";
import {
	classify,
	isDocsOnlyPath,
	PROSE_READ_BY_TESTS,
} from "../../scripts/ci-changes.ts";

const ROOT = `${join(import.meta.dir, "..", "..")}/`;

describe("isDocsOnlyPath", () => {
	test("prose for people and agents is docs-only", () => {
		for (const path of [
			"AGENTS.md",
			"README.md",
			"CHANGELOG.md",
			"GLOSSARY.txt",
			"docs/CONSTITUTION.md",
			"commands/api/README.md",
			"commands/api/AGENTS.md",
			"docs/AGENTS.md",
			".github/instructions/linting.instructions.md",
			".github/pull_request_template.md",
		]) {
			expect(isDocsOnlyPath(path)).toBe(true);
		}
	});

	test("specs, generated docs, parsed prose and everything else are code", () => {
		for (const path of [
			"commands/api/examples.md",
			"docs/CLI.md",
			"docs/errors/README.md",
			"docs/errors/CENTRS_X.md",
			"docs/errors/AGENTS.md",
			"test/fixtures/explain/AGENTS.md",
			"src/protocols/AGENTS.md",
			"test/CLAUDE.md",
			"docs/MATRIX.md",
			"commands/explain/README.md",
			"test/fixtures/explain/README.md",
			"test/fixtures/explain/cliref/app.md",
			"scripts/probes/notes.md",
			"src/index.ts",
			".github/workflows/ci.yaml",
			".coderabbit.yaml",
			"package.json",
			"cspell.json",
			"docs/new-file.md",
			"LICENSE",
		]) {
			expect(isDocsOnlyPath(path)).toBe(false);
		}
	});
});

describe("classify", () => {
	const docs = { files: ["README.md", "AGENTS.md", "CHANGELOG.md"] };
	const code = { files: ["README.md", "src/cli.ts"] };

	test("a docs-only PR or push skips the heavy jobs", () => {
		expect(classify({ event: "pull_request", files: docs }).heavy).toBe(false);
		expect(classify({ event: "push", files: docs }).heavy).toBe(false);
	});

	test("touching any code runs them and names the file", () => {
		const verdict = classify({ event: "pull_request", files: code });
		expect(verdict.heavy).toBe(true);
		expect(verdict.reason).toContain("src/cli.ts");
	});

	test("an unread, incomplete or empty file list runs them", () => {
		expect(classify({ event: "pull_request" }).heavy).toBe(true);
		expect(
			classify({ event: "push", files: { incomplete: "not an ancestor" } })
				.heavy,
		).toBe(true);
		expect(
			classify({ event: "pull_request", files: { files: [] } }).heavy,
		).toBe(true);
	});

	test("dispatch and unknown events always run", () => {
		expect(classify({ event: "workflow_dispatch" }).heavy).toBe(true);
		expect(classify({ event: "merge_group" }).heavy).toBe(true);
	});
});

/**
 * The guard behind "docs-only": no test, script, source or build input may
 * read a path the classifier skips for. A reference is the full path, or its
 * last two segments as a path (`explain/README.md`) or as `join()` arguments
 * (`"docs", "MATRIX.md"`). A root file is referenced by `../NAME` or
 * `"..", "NAME"`. Comments count too, which errs on the side of running.
 */
/** Comment-only lines name a doc for the reader; they read nothing. */
function withoutCommentLines(text: string): string {
	return text
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
		.join("\n");
}

/** Code that names a docs-only path without reading it, with the reason. */
const MENTIONS: Record<string, string> = {
	"scripts/gen-error-pages.ts → docs/CONSTITUTION.md":
		"link text written into generated error pages",
	"test/unit/settings-registry.test.ts → commands/settings/README.md":
		"a test title; the key list is in the test itself",
};

describe("docs-only guard", () => {
	test("no code reads a docs-only path", async () => {
		const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT })
			.stdout.toString()
			.split("\n")
			.filter(Boolean);
		const docsOnly = tracked.filter(isDocsOnlyPath);
		expect(docsOnly.length).toBeGreaterThan(10);

		const sources: { path: string; text: string }[] = [];
		const self = new Set([
			"scripts/ci-changes.ts",
			"test/unit/ci-changes.test.ts",
		]);
		for (const pattern of ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"]) {
			for await (const scanned of new Glob(pattern).scan({ cwd: ROOT })) {
				const path = scanned.replaceAll("\\", "/");
				if (self.has(path)) continue;
				sources.push({
					path,
					text: withoutCommentLines(await Bun.file(`${ROOT}${path}`).text()),
				});
			}
		}
		// package.json's `files` list only shapes the npm tarball; its scripts
		// are what CI runs.
		const pkg = (await Bun.file(`${ROOT}package.json`).json()) as {
			scripts: Record<string, string>;
		};
		sources.push({
			path: "package.json#scripts",
			text: JSON.stringify(pkg.scripts),
		});
		for (const config of ["bunfig.toml", "tsconfig.json"]) {
			sources.push({
				path: config,
				text: await Bun.file(`${ROOT}${config}`).text(),
			});
		}

		const offenders: string[] = [];
		for (const doc of docsOnly) {
			const parts = doc.split("/");
			const name = parts.at(-1) ?? doc;
			const needles =
				parts.length === 1
					? [`../${name}`, `"..", "${name}"`]
					: [doc, parts.slice(-2).join("/"), `"${parts.at(-2)}", "${name}"`];
			for (const { path, text } of sources) {
				if (needles.some((needle) => text.includes(needle))) {
					offenders.push(`${path} → ${doc}`);
				}
			}
		}
		expect(offenders.filter((hit) => !(hit in MENTIONS))).toEqual([]);
	});

	test("the parsed-prose list names files that exist", async () => {
		for (const path of PROSE_READ_BY_TESTS) {
			expect(await Bun.file(`${ROOT}${path}`).exists()).toBe(true);
		}
	});
});
