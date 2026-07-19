#!/usr/bin/env bun
/**
 * Generate `docs/CLI.md` — the flag reference for every `centrs` command —
 * from the single source of truth: the `CliCommandMetadata` objects that also
 * render `--help` (`src/cli.ts` → `cliCommands`).
 *
 * Unlike `gen-error-pages.ts` (which scaffolds stubs and never overwrites),
 * this generator fully owns its output file: every run rewrites `docs/CLI.md`
 * from metadata, so the file must never be hand-edited. Command READMEs keep
 * design prose and spec-only flags; implemented flags live here only.
 *
 * Usage:
 *   bun run docs:cli            # regenerate docs/CLI.md
 *   bun run docs:cli --check    # CI drift gate: fail if the committed file differs
 */

import { join } from "node:path";
import { cliCommands } from "../src/cli.ts";

const OUTPUT_PATH = join(import.meta.dir, "..", "docs", "CLI.md");

/**
 * Make text safe inside a GFM table cell: escape `|` (GFM honors `\|` even
 * inside code spans) and wrap bare `<placeholder>` tokens in code spans so
 * markdownlint's inline-HTML rule (MD033) doesn't read them as tags. Segments
 * already inside backticks are left as-is apart from pipe escaping.
 */
function tableCell(text: string): string {
	return text
		.split("`")
		.map((segment, index) =>
			// Odd indexes are inside a code span; only even (outside) segments get
			// their <...> tokens code-spanned.
			index % 2 === 0
				? segment.replace(/<[^<>\s]+>/g, (token) => `\`${token}\``)
				: segment,
		)
		.join("`")
		.replaceAll("|", "\\|");
}

function renderCommand(command: (typeof cliCommands)[number]): string {
	const rows = command.options.map((option) => {
		const flag = tableCell(`\`${option.flag}\``);
		const value = option.valueName ? tableCell(`\`${option.valueName}\``) : "";
		return `| ${flag} | ${value} | ${tableCell(option.description)} |`;
	});
	return [
		`## ${command.name}`,
		"",
		command.summary,
		"",
		"```text",
		`Usage: ${command.usage}`,
		"```",
		"",
		"| Flag | Value | Description |",
		"| ---- | ----- | ----------- |",
		...rows,
	].join("\n");
}

function renderReference(): string {
	const index = cliCommands.map(
		(command) =>
			`| [\`${command.name}\`](#${command.name}) | ${tableCell(command.summary)} |`,
	);
	return [
		"# centrs CLI reference",
		"",
		"<!-- GENERATED FILE — do not edit. Regenerate with `bun run docs:cli`. -->",
		"<!-- Source of truth: the CliCommandMetadata objects in src/cli/*.ts -->",
		"",
		"Every flag below is generated from the same metadata that renders",
		"`centrs <command> --help`; CI fails when this file and the metadata drift",
		"(`bun run docs:cli --check`). Behavior, examples, and designed-but-not-yet",
		"implemented flags live in each command's `commands/<name>/README.md`.",
		"",
		"| Command | Summary |",
		"| ------- | ------- |",
		...index,
		"",
		cliCommands.map(renderCommand).join("\n\n"),
		"",
	].join("\n");
}

const content = renderReference();

if (process.argv.includes("--check")) {
	const existing = await Bun.file(OUTPUT_PATH)
		.text()
		.catch(() => "");
	if (existing !== content) {
		console.error(
			"docs/CLI.md is out of date with the CLI metadata.\n" +
				"Run `bun run docs:cli` and commit the result.",
		);
		process.exit(1);
	}
	console.log("docs/CLI.md matches the CLI metadata.");
} else {
	await Bun.write(OUTPUT_PATH, content);
	console.log("wrote docs/CLI.md");
}
