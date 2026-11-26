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
import {
	CDB_PASSWORD_SECRET,
	chooseSecret,
} from "../resolver/secret-source.ts";

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

export interface CentrsMcpConfig {
	/** Absolute path to the CDB that is the device allowlist. */
	cdbFile: string;
	/** True when `--cdb-file`/`CENTRS_CDB_FILE` set the path explicitly. */
	cdbFileExplicit: boolean;
	/** CDB decrypt password, when the CDB on disk is encrypted. */
	cdbPassword?: string;
	/**
	 * A file holding the CDB password (`--cdb-password-file` or
	 * `CENTRS_CDB_PASSWORD_FILE`). Only the path is kept: every CDB load reads
	 * it again, so rotating or deleting the file takes effect at the next call
	 * (#672). Set at most one of this and `cdbPassword`.
	 */
	cdbPasswordFile?: string;
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
	cdbPasswordFile?: string;
	allowAdhocTargets?: boolean;
	env?: Record<string, string | undefined>;
	/**
	 * The `centrs.env` config tier (`src/resolver/config-file.ts`), loaded by
	 * the caller — `resolveMcpConfig` itself stays synchronous so it can keep
	 * serving as a default-parameter value (`server.ts`). `CENTRS_CDB_PASSWORD`
	 * and `CENTRS_CDB_PASSWORD_FILE` deliberately never read it, same as
	 * `resolveAuth`'s credential fields.
	 */
	config?: Record<string, string | undefined>;
}

export function resolveMcpConfig(
	args: ResolveMcpConfigArgs = {},
): CentrsMcpConfig {
	const env = args.env ?? Bun.env;
	const config = args.config ?? {};
	const explicitPath =
		args.cdbFile ?? env[ENV_CDB_FILE] ?? config[ENV_CDB_FILE] ?? undefined;
	const cdbFile = explicitPath ?? defaultCdbPath(env);
	const allowAdhocTargets =
		args.allowAdhocTargets ??
		(env[ENV_ALLOW_ADHOC] ?? config[ENV_ALLOW_ADHOC]) === "1";
	// Choose the key's source once, so a value-and-file conflict fails at
	// startup; a file is only named here and read on each CDB load.
	const key = chooseSecret(
		CDB_PASSWORD_SECRET,
		{ value: args.cdbPassword, file: args.cdbPasswordFile },
		env,
	);
	return {
		cdbFile,
		cdbFileExplicit: explicitPath !== undefined,
		...(key?.kind === "value" ? { cdbPassword: key.value } : {}),
		...(key?.kind === "file" ? { cdbPasswordFile: key.path } : {}),
		allowAdhocTargets,
		env,
	};
}
