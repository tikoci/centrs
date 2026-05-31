#!/usr/bin/env bun

import { devicesCommand, runDevicesCli } from "./cli/devices.ts";
import { discoverCommand, runDiscoverCli } from "./cli/discover.ts";
import { executeCommand, runExecuteCli } from "./cli/execute.ts";
import { retrieveCommand, runRetrieveCli } from "./cli/retrieve.ts";
import { describeCentrs, plannedProtocols, plannedSurfaces } from "./index.ts";

const commandSummaries: ReadonlyArray<{ name: string; summary: string }> = [
	retrieveCommand,
	executeCommand,
	devicesCommand,
	discoverCommand,
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
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		console.log(renderCliHelp());
		return 0;
	}

	const [command, ...rest] = args;
	if (command === "retrieve") {
		return runRetrieveCli(rest);
	}
	if (command === "execute") {
		return runExecuteCli(rest);
	}
	if (command === "devices") {
		return runDevicesCli(rest);
	}
	if (command === "discover") {
		return runDiscoverCli(rest);
	}

	console.error(
		`Unknown centrs command: ${command}\n\nUse \`centrs --help\` to see the available commands.`,
	);
	return 1;
}

if (import.meta.main) {
	process.exitCode = await runCli();
}
