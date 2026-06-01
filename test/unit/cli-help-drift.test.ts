import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CliCommandMetadata,
	renderCommandHelp,
} from "../../src/cli/common.ts";
import { devicesCommand } from "../../src/cli/devices.ts";
import { discoverCommand } from "../../src/cli/discover.ts";
import { executeCommand } from "../../src/cli/execute.ts";
import { mcpCommand } from "../../src/cli/mcp.ts";
import { retrieveCommand } from "../../src/cli/retrieve.ts";
import { describeCentrs } from "../../src/index.ts";

const COMMANDS_DIR = join(import.meta.dir, "..", "..", "commands");

/**
 * Universal CLI conventions documented at the top-level README rather than in
 * every per-command spec, plus compound partners of a flag already documented.
 */
const EXEMPT_FLAGS = new Set([
	"--help",
	"--json",
	"--yaml",
	"--verbose",
	"--format",
	"--no-validate",
]);

const commands: ReadonlyArray<{ dir: string; command: CliCommandMetadata }> = [
	{ dir: "retrieve", command: retrieveCommand },
	{ dir: "execute", command: executeCommand },
	{ dir: "devices", command: devicesCommand },
	{ dir: "discover", command: discoverCommand },
	{ dir: "mcp", command: mcpCommand },
];

function readmeFor(dir: string): string {
	return readFileSync(join(COMMANDS_DIR, dir, "README.md"), "utf8");
}

/** Split a metadata flag like "--validate / --no-validate" into its tokens. */
function flagTokens(flag: string): string[] {
	return flag
		.split("/")
		.map((part) => part.trim())
		.filter((part) => part.startsWith("--"));
}

describe("CLI help does not drift from the command README", () => {
	for (const { dir, command } of commands) {
		test(`${dir}: every command-specific flag is documented in the README`, () => {
			const readme = readmeFor(dir);
			const undocumented: string[] = [];
			for (const option of command.options) {
				for (const token of flagTokens(option.flag)) {
					if (EXEMPT_FLAGS.has(token)) {
						continue;
					}
					if (!readme.includes(token)) {
						undocumented.push(token);
					}
				}
			}
			expect(undocumented).toEqual([]);
		});

		test(`${dir}: renderCommandHelp produces a usage line and options`, () => {
			const help = renderCommandHelp(describeCentrs(), command);
			expect(help).toContain(`Usage: ${command.usage}`);
			expect(help).toContain("Options:");
			expect(help.length).toBeGreaterThan(0);
		});
	}
});
