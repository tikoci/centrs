/**
 * `centrs mcp` CLI surface: starts the stdio MCP server. Arg parsing here is
 * deliberately thin — the server's behavior is governed by the CDB allowlist
 * and the global toggles (`--cdb-file`/`--cdb-password`/
 * `--allow-adhoc-targets`), resolved in `../mcp/config.ts`.
 *
 * Transport is stdio only; HTTP/remote access is the proxy surface's job.
 */

import { asCentrsError, formatCentrsErrorText } from "../errors.ts";
import { describeCentrs } from "../index.ts";
import { resolveMcpConfig } from "../mcp/config.ts";
import { runMcpStdio } from "../mcp/server.ts";
import { loadEnvFileDefaults } from "../resolver/index.ts";
import {
	type CliCommandMetadata,
	expectValue,
	renderCommandHelp,
	unknownFlagError,
} from "./common.ts";

export const mcpCommand: CliCommandMetadata = {
	name: "mcp",
	usage: "centrs mcp [start] [--cdb-file <path>] [--allow-adhoc-targets]",
	summary:
		"Start the centrs MCP server (stdio) — scoped RouterOS tools gated by the CDB allowlist.",
	options: [
		{
			flag: "--cdb-file",
			valueName: "<path>",
			description:
				"CDB allowlist path (default `~/.config/tikoci/winbox.cdb`, or CENTRS_CDB_FILE).",
		},
		{
			flag: "--cdb-password",
			valueName: "<password>",
			description:
				"Decrypt password for an encrypted CDB (or CENTRS_CDB_PASSWORD).",
		},
		{
			flag: "--allow-adhoc-targets",
			description:
				"Reserved unsafe escape hatch for future inline targets; current tools still use CDB-only targets.",
		},
		{ flag: "--help", description: "Show this help." },
	],
};

interface McpCliArgs {
	help?: boolean;
	cdbFile?: string;
	cdbPassword?: string;
	allowAdhocTargets?: boolean;
}

export function parseMcpCliArgs(args: readonly string[]): McpCliArgs {
	const parsed: McpCliArgs = {};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) {
			continue;
		}
		switch (arg) {
			case "start":
				// Optional verb; `centrs mcp` and `centrs mcp start` are equivalent.
				break;
			case "--help":
			case "-h":
				parsed.help = true;
				break;
			case "--cdb-file":
				parsed.cdbFile = expectValue(args, ++index, "--cdb-file");
				break;
			case "--cdb-password":
				parsed.cdbPassword = expectValue(args, ++index, "--cdb-password");
				break;
			case "--allow-adhoc-targets":
				parsed.allowAdhocTargets = true;
				break;
			default:
				throw unknownFlagError("mcp", arg, mcpCommand.options);
		}
	}
	return parsed;
}

export async function runMcpCli(args: readonly string[]): Promise<number> {
	try {
		const parsed = parseMcpCliArgs(args);
		if (parsed.help) {
			console.log(renderCommandHelp(describeCentrs(), mcpCommand));
			return 0;
		}
		const config = resolveMcpConfig({
			cdbFile: parsed.cdbFile,
			cdbPassword: parsed.cdbPassword,
			allowAdhocTargets: parsed.allowAdhocTargets,
			config: await loadEnvFileDefaults(),
		});
		await runMcpStdio(config);
		return 0;
	} catch (error) {
		console.error(
			// codeql[js/clear-text-logging] password reaches here only as SettingSource provenance ({kind,key}), never the value — see CommonSettingsMeta.password in src/core/envelope.ts.
			formatCentrsErrorText(
				asCentrsError(error, {
					code: "internal/mcp-start",
					summary: error instanceof Error ? error.message : String(error),
					remediation:
						"Check `centrs mcp --help` for supported flags and the CDB path.",
				}),
			),
		);
		return 1;
	}
}
