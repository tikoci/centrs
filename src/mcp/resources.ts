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

import {
	detailsUrlForCode,
	ERROR_DETAILS_BASE_URL,
	errorCatalog,
} from "../core/error-catalog.ts";
import type { CentrsMcpConfig } from "./config.ts";
import { loadAllowlistCdb, readWritePolicy } from "./safety.ts";

export const DEVICES_RESOURCE_URI = "centrs://devices";
export const ERRORS_RESOURCE_URI = "centrs://errors";

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
 * Build the `centrs://errors` resource payload from the single error catalog
 * (`src/core/error-catalog.ts`), so the MCP-exposed catalog can never drift
 * from the codes the rest of centrs produces.
 */
export function buildErrorsResource(): ErrorsResource {
	const errors: ErrorCatalogItem[] = errorCatalog.map((item) => ({
		code: item.code,
		summary: item.summary,
		detailsUrl: detailsUrlForCode(item.code),
	}));
	return {
		detailsBaseUrl: ERROR_DETAILS_BASE_URL,
		count: errors.length,
		errors,
	};
}
