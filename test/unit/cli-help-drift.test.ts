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

describe("docs/CLI.md does not drift from the CLI metadata", () => {
	for (const command of cliCommands) {
		test(`${command.name}: every flag appears in docs/CLI.md`, () => {
			const missing: string[] = [];
			for (const option of command.options) {
				for (const token of flagTokens(option.flag)) {
					if (!CLI_REFERENCE.includes(token)) {
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
