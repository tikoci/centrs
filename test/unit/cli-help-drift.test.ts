import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderCommandHelp } from "../../src/cli/common.ts";
import { cliCommands } from "../../src/cli.ts";
import { describeCentrs } from "../../src/index.ts";

/**
 * Flag documentation lives in the generated `docs/CLI.md`
 * (`scripts/gen-cli-docs.ts`), not in per-command READMEs — this anchor
 * asserts the committed file covers every metadata flag, so a stale commit
 * fails the fast `bun test` gate too (CI's `docs:cli:check` diffs the full
 * content).
 */
const CLI_REFERENCE = readFileSync(
	join(import.meta.dir, "..", "..", "docs", "CLI.md"),
	"utf8",
);

/** Split a metadata flag like "--validate / --no-validate" into its tokens. */
function flagTokens(flag: string): string[] {
	return flag
		.split("/")
		.map((part) => part.trim())
		.filter((part) => part.startsWith("-"));
}

/**
 * Whether `token` appears in the reference as a standalone flag rather than a
 * substring of a longer one. A raw `includes()` false-passes short aliases —
 * `-f` occurs inside `--cdb-file` — so the token must be bounded by non-flag
 * characters (flags are `[\w-]`) on both sides.
 */
function tokenPresent(reference: string, token: string): boolean {
	const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(reference);
}

describe("docs/CLI.md does not drift from the CLI metadata", () => {
	for (const command of cliCommands) {
		test(`${command.name}: every flag appears in docs/CLI.md`, () => {
			const missing: string[] = [];
			for (const option of command.options) {
				for (const token of flagTokens(option.flag)) {
					if (!tokenPresent(CLI_REFERENCE, token)) {
						missing.push(token);
					}
				}
			}
			expect(missing).toEqual([]);
		});

		test(`${command.name}: renderCommandHelp produces a usage line and options`, () => {
			const help = renderCommandHelp(describeCentrs(), command);
			expect(help).toContain(`Usage: ${command.usage}`);
			expect(help).toContain("Options:");
			expect(help.length).toBeGreaterThan(0);
		});
	}
});
