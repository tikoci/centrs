/**
 * Planned TUI surface.
 *
 * Not implemented yet. Listed alongside `cli.ts`, `mcp.ts`, and `webproxy.ts`
 * so the planned frontends in README.md and `plannedSurfaces` in
 * src/index.ts have one file each.
 */

import { plannedProtocols } from "./index.ts";

export interface TuiSurfacePlan {
	name: "centrs-tui";
	purpose: string;
	protocols: readonly string[];
}

export const tuiSurfacePlan: TuiSurfacePlan = {
	name: "centrs-tui",
	purpose:
		"Future interactive terminal UI for device picking, validation review, and live RouterOS sessions.",
	protocols: plannedProtocols,
};
