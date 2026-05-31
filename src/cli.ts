#!/usr/bin/env bun

import { runDevicesCli } from "./cli/devices.ts";
import { runDiscoverCli } from "./cli/discover.ts";
import { runExecuteCli } from "./cli/execute.ts";
import { runRetrieveCli } from "./cli/retrieve.ts";
import { describeCentrs, plannedProtocols, plannedSurfaces } from "./index.ts";

const commandSummaries: ReadonlyArray<{ name: string; summary: string }> = [
	{
		name: "retrieve",
		summary:
			"Read RouterOS values through the shared core using the selected protocol.",
	},
	{
		name: "execute",
		summary:
			"Run a RouterOS command through the shared core (not implemented yet — WP-1c).",
	},
	{
		name: "devices",
		summary:
			"Inspect the CDB-backed device registry (read-only subcommands only in this phase).",
	},
	{
		name: "discover",
		summary:
			"Discover RouterOS neighbors over MNDP and optionally save them into the CDB.",
	},
];

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
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
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
