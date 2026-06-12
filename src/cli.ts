#!/usr/bin/env bun

import { btestCommand, runBtestCli } from "./cli/btest.ts";
import { devicesCommand, runDevicesCli } from "./cli/devices.ts";
import { discoverCommand, runDiscoverCli } from "./cli/discover.ts";
import { executeCommand, runExecuteCli } from "./cli/execute.ts";
import { mcpCommand, runMcpCli } from "./cli/mcp.ts";
import { retrieveCommand, runRetrieveCli } from "./cli/retrieve.ts";
import { runTerminalCli, terminalCommand } from "./cli/terminal.ts";
import { runTransferCli, transferCommand } from "./cli/transfer.ts";
import { asCentrsError, formatCentrsErrorText } from "./errors.ts";
import { describeCentrs, plannedProtocols, plannedSurfaces } from "./index.ts";

const commandSummaries: ReadonlyArray<{ name: string; summary: string }> = [
	retrieveCommand,
	executeCommand,
	transferCommand,
	terminalCommand,
	devicesCommand,
	discoverCommand,
	btestCommand,
	mcpCommand,
].map((command) => ({ name: command.name, summary: command.summary }));

export function renderCliHelp(): string {
	return [
		describeCentrs(),
		"",
		`Surfaces: ${plannedSurfaces.join(", ")}`,
		`Protocols: ${plannedProtocols.join(", ")}`,
		"",
		"Commands:",
		...commandSummaries.map(
			(command) => `  ${command.name.padEnd(12)} ${command.summary}`,
		),
		"",
		"Use `centrs <command> --help` for command-specific options.",
	].join("\n");
}

export async function runCli(
	args: readonly string[] = Bun.argv.slice(2),
): Promise<number> {
	try {
		if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
			console.log(renderCliHelp());
			return 0;
		}

		const [command, ...rest] = args;
		if (command === "retrieve") {
			return await runRetrieveCli(rest);
		}
		if (command === "execute") {
			return await runExecuteCli(rest);
		}
		if (command === "transfer") {
			return await runTransferCli(rest);
		}
		if (command === "terminal") {
			return await runTerminalCli(rest);
		}
		// Top-level shortcuts for the two highest-frequency transfer verbs; they
		// forward to the transfer runner with a fixed verb (commands/transfer/README.md).
		if (command === "upload") {
			return await runTransferCli(rest, { fixedVerb: "upload" });
		}
		if (command === "download") {
			return await runTransferCli(rest, { fixedVerb: "download" });
		}
		if (command === "devices") {
			return await runDevicesCli(rest);
		}
		if (command === "discover") {
			return await runDiscoverCli(rest);
		}
		if (command === "btest") {
			return await runBtestCli(rest);
		}
		if (command === "mcp") {
			return await runMcpCli(rest);
		}

		console.error(
			formatCentrsErrorText(
				asCentrsError(new Error(`Unknown centrs command: ${command}`), {
					code: "input/invalid-command",
					summary: `Unknown centrs command: ${command}`,
					remediation: "Use `centrs --help` to see the available commands.",
				}),
			),
		);
		return 1;
	} catch (error) {
		// Last-resort safety net: a runner should already convert its own errors
		// to a structured envelope, so reaching here means an unconverted throw
		// escaped. Never let a raw stack trace reach the user.
		console.error(
			formatCentrsErrorText(
				asCentrsError(error, {
					code: "internal/unhandled",
					summary: error instanceof Error ? error.message : String(error),
					remediation:
						"This is a centrs bug; re-run with --verbose and file an issue with the printed code.",
				}),
				{ verbose: args.includes("--verbose") },
			),
		);
		return 1;
	}
}

if (import.meta.main) {
	process.exitCode = await runCli();
}
