/**
 * The centrs MCP frontend barrel (`@tikoci/centrs/mcp`).
 *
 * This module re-exports the runnable, CHR-tested stdio server and its config,
 * plus the one shared type the safety layer needs (`McpWritePolicy`). The tool
 * surface, safety model, and CHR-gated examples are described in
 * `commands/mcp/` and `docs/MATRIX.md` (status: `CHR-passed`, Phase 1); the
 * registered tools in `./mcp/tools.ts` + `./mcp/server.ts` are the single source
 * of truth for the tool list — this file no longer restates them as a plan.
 *
 * Design grounding: `~/GitHub/bench-routeros-tools` (REPORT.md,
 * docs/REPORT_LIVE_CHR.md) — a scoped verb surface over canonical
 * `{ path, verb, args }`, the explain → validate → run split, and `:parse` as the
 * real-parser validation gate that schema inspection alone misses.
 */

/** Per-device write policy carried in CDB comment-kv `mcp=<value>`. */
export type McpWritePolicy = "ro" | "rw";

export { type CentrsMcpConfig, resolveMcpConfig } from "./mcp/config.ts";
export { createCentrsMcpServer, runMcpStdio } from "./mcp/server.ts";

/** Entry point for `centrs mcp` / `bunx @tikoci/centrs mcp`. */
export async function runMcp(
	args: readonly string[] = Bun.argv.slice(3),
): Promise<number> {
	const { runMcpCli } = await import("./cli/mcp.ts");
	return runMcpCli(args);
}

if (import.meta.main) {
	process.exitCode = await runMcp();
}
