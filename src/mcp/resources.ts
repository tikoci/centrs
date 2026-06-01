/**
 * MCP resources for centrs.
 *
 * Two read-only resources back the server's `instructions` so an agent can see
 * the allowlist and the error contract without trial and error:
 *
 * - `centrs://devices` — the active CDB's registered devices (the allowlist),
 *   including each record's resolved MCP write policy. Never includes passwords.
 * - `centrs://errors` — the centrs error-code catalog: each known `family/code`
 *   with its stable details URL.
 *
 * The builders are pure (return plain JSON-able objects) so they are unit
 * testable; `./server.ts` registers them as MCP resources and serializes the
 * payload as JSON text.
 */

import type { CentrsMcpConfig } from "./config.ts";
import { loadAllowlistCdb, readWritePolicy } from "./safety.ts";

export const DEVICES_RESOURCE_URI = "centrs://devices";
export const ERRORS_RESOURCE_URI = "centrs://errors";

const ERROR_DETAILS_BASE_URL = "https://tikoci.github.io/centrs/errors/";

export interface DeviceResourceItem {
	target: string;
	group: string;
	user: string;
	recordType: number;
	writePolicy: "ro" | "rw";
}

export interface DevicesResource {
	cdbFile: string;
	count: number;
	devices: readonly DeviceResourceItem[];
}

/**
 * Snapshot the CDB allowlist for the `centrs://devices` resource. Reads the
 * per-device `mcp` write policy from each record's comment. No passwords.
 */
export async function buildDevicesResource(
	config: CentrsMcpConfig,
): Promise<DevicesResource> {
	const cdb = await loadAllowlistCdb(config);
	const devices: DeviceResourceItem[] = [];
	for (const entry of cdb.entries) {
		if (!entry) {
			continue;
		}
		devices.push({
			target: entry.target,
			group: entry.group,
			user: entry.user,
			recordType: entry.recordType,
			writePolicy: readWritePolicy(entry.comment),
		});
	}
	return {
		cdbFile: cdb.settings.cdbFile.value,
		count: devices.length,
		devices,
	};
}

export interface ErrorCatalogItem {
	code: string;
	summary: string;
	detailsUrl: string;
}

export interface ErrorsResource {
	detailsBaseUrl: string;
	count: number;
	errors: readonly ErrorCatalogItem[];
}

/**
 * The curated centrs error-code catalog. Codes are an open template-literal
 * type in `src/errors.ts`; this catalog enumerates the families and the
 * MCP-relevant codes most useful for an agent to resolve from an envelope,
 * including the MCP-specific `cdb/target-not-registered` and
 * `cdb/write-not-permitted`.
 */
const ERROR_CATALOG: ReadonlyArray<{ code: string; summary: string }> = [
	{
		code: "cdb/target-not-registered",
		summary:
			"The target is not on the CDB allowlist. Register it with centrs_devices (op add) first.",
	},
	{
		code: "cdb/write-not-permitted",
		summary:
			"The device's CDB record is mcp=ro. Set mcp=rw to permit MCP writes, then retry with confirm:true.",
	},
	{
		code: "cdb/not-found-target",
		summary: "No CDB entry matched the requested target string.",
	},
	{ code: "cdb/not-found", summary: "The CDB file could not be found." },
	{ code: "cdb/parse-failed", summary: "The CDB file could not be parsed." },
	{
		code: "usage/confirmation-required",
		summary:
			"A write-shaped command needs explicit confirmation. Pass confirm:true after review.",
	},
	{
		code: "validation/syntax",
		summary: "RouterOS rejected the command syntax during the :parse gate.",
	},
	{
		code: "validation/unknown-attribute",
		summary:
			"An attribute is not valid for the path/verb per /console/inspect.",
	},
	{
		code: "input/invalid-command",
		summary: "The request shape was invalid (bad or missing arguments).",
	},
	{
		code: "auth/failed",
		summary: "RouterOS rejected the stored credentials for the device.",
	},
	{
		code: "transport/unreachable",
		summary: "The device could not be reached over the chosen transport.",
	},
	{
		code: "routeros/error",
		summary: "RouterOS returned an error executing the command.",
	},
];

/** Build the `centrs://errors` resource payload. */
export function buildErrorsResource(): ErrorsResource {
	const errors: ErrorCatalogItem[] = ERROR_CATALOG.map((item) => ({
		code: item.code,
		summary: item.summary,
		detailsUrl: `${ERROR_DETAILS_BASE_URL}${item.code}`,
	}));
	return {
		detailsBaseUrl: ERROR_DETAILS_BASE_URL,
		count: errors.length,
		errors,
	};
}
