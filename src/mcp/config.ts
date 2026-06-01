/**
 * Runtime configuration for the centrs MCP server.
 *
 * The MCP surface is an adapter over the same validated core the CLI/API use;
 * its authorization boundary is the CDB (the device allowlist). This module
 * resolves where that CDB lives and the two global toggles the server honors,
 * with the usual centrs precedence: explicit args → environment → built-in
 * default.
 */

import { defaultCdbPath } from "../devices.ts";

/**
 * Reserved CDB record name (future work, not yet honored) that will supply
 * fallback metadata + credentials for a resolved device that has none of its
 * own. Precedence once implemented: per-call args → ENV → matched device
 * record → this `__default__` record → built-in default. Tracked in
 * `commands/mcp/README.md` (Future work) and `docs/MATRIX.md`.
 */
export const DEFAULT_DEVICE_NAME = "__default__";

/** Environment variable reserved for future inline host+credential targets. */
export const ENV_ALLOW_ADHOC = "CENTRS_MCP_ALLOW_ADHOC";

const ENV_CDB_FILE = "CENTRS_CDB_FILE";
const ENV_CDB_PASSWORD = "CENTRS_CDB_PASSWORD";

export interface CentrsMcpConfig {
	/** Absolute path to the CDB that is the device allowlist. */
	cdbFile: string;
	/** True when `--cdb-file`/`CENTRS_CDB_FILE` set the path explicitly. */
	cdbFileExplicit: boolean;
	/** CDB decrypt password, when the CDB on disk is encrypted. */
	cdbPassword?: string;
	/**
	 * Off-by-default escape hatch reserved for future MCP schemas that accept
	 * inline host+credentials. Phase 1 tools expose only CDB target strings.
	 */
	allowAdhocTargets: boolean;
	/** Environment snapshot the core resolvers read (defaults to `Bun.env`). */
	env: Record<string, string | undefined>;
}

export interface ResolveMcpConfigArgs {
	cdbFile?: string;
	cdbPassword?: string;
	allowAdhocTargets?: boolean;
	env?: Record<string, string | undefined>;
}

export function resolveMcpConfig(
	args: ResolveMcpConfigArgs = {},
): CentrsMcpConfig {
	const env = args.env ?? Bun.env;
	const explicitPath = args.cdbFile ?? env[ENV_CDB_FILE] ?? undefined;
	const cdbFile = explicitPath ?? defaultCdbPath(env);
	const allowAdhocTargets =
		args.allowAdhocTargets ?? env[ENV_ALLOW_ADHOC] === "1";
	return {
		cdbFile,
		cdbFileExplicit: explicitPath !== undefined,
		cdbPassword: args.cdbPassword ?? env[ENV_CDB_PASSWORD] ?? undefined,
		allowAdhocTargets,
		env,
	};
}
