#!/usr/bin/env bun

import { describeCentrs, plannedProtocols, plannedSurfaces } from "./index.ts";

export function renderCliHelp(): string {
	return [
		describeCentrs(),
		"",
		`Planned surfaces: ${plannedSurfaces.join(", ")}`,
		`Planned protocols: ${plannedProtocols.join(", ")}`,
		"",
		"The CLI command model is specified in README.md and docs/specs/S004-cli-settings-and-precedence.md.",
	].join("\n");
}

export async function runCli(
	args: readonly string[] = Bun.argv.slice(2),
): Promise<number> {
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		console.log(renderCliHelp());
		return 0;
	}

	console.error(
		`centrs CLI commands are not implemented yet. See README.md for the planned command surface. Received: ${args.join(" ")}`,
	);
	return 1;
}

if (import.meta.main) {
	process.exitCode = await runCli();
}
