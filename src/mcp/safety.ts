/**
 * The MCP authorization boundary: the CDB is the allowlist.
 *
 * Every device-touching MCP tool resolves its `target` through this layer
 * before any core call. A target that is not a CDB record is rejected with
 * `cdb/target-not-registered` (fix → `centrs_devices add`); credentials never
 * pass through the agent because they live in the CDB. Per-device write policy
 * is CDB data: the comment-kv key `mcp` (`ro` default, `rw` to permit writes).
 * Write-shaped `centrs_execute` calls require the resolved record to be
 * `mcp=rw`, else `cdb/write-not-permitted`.
 */

import {
	type DevicesShowItem,
	type LoadedCdb,
	loadCdb,
	showDevice,
} from "../devices.ts";
import { CentrsError } from "../errors.ts";
import type { McpWritePolicy } from "../mcp.ts";
import { parseCommentKv } from "../resolver/comment-kv.ts";
import { assertNoTargetPassword } from "../resolver/target.ts";
import type { CentrsMcpConfig } from "./config.ts";

export interface RegisteredTarget {
	/** The CDB target string (host / IP / URL / MAC). */
	target: string;
	user: string;
	group: string;
	/** Index of the matched record in the loaded CDB. */
	recordIndex: number;
	/** Resolved per-device MCP write policy. */
	writePolicy: McpWritePolicy;
}

/**
 * Read the per-device MCP write policy from a CDB record comment. Defaults to
 * `ro`; only an explicit `mcp=rw` opts a device into write access.
 */
export function readWritePolicy(comment: string): McpWritePolicy {
	const parsed = parseCommentKv(comment);
	return parsed.values.mcp === "rw" ? "rw" : "ro";
}

/** Load the CDB that backs the allowlist for this server instance. */
export async function loadAllowlistCdb(
	config: CentrsMcpConfig,
): Promise<LoadedCdb> {
	return loadCdb({
		cdbFile: config.cdbFile,
		cdbPassword: config.cdbPassword,
		env: config.env,
	});
}

/**
 * Resolve a target against the CDB allowlist. Throws
 * `cdb/target-not-registered` when no record matches — the friendly,
 * MCP-specific framing of "this device is not on the allowlist", pointing at
 * `centrs_devices add` rather than leaking the CLI's `cdb/not-found-target`.
 *
 * Matches with {@link showDevice}, the matcher the core resolver dials with
 * (target, `identity=`, `mac=`, `ip=`), so the record whose write policy is
 * checked here is the record the call then runs against (#444). A name that
 * matches more than one record fails `identity/ambiguous` rather than taking
 * the first.
 */
export function resolveRegisteredTarget(
	cdb: LoadedCdb,
	target: string,
): RegisteredTarget {
	// Before the lookup, whose refusal echoes the target (#478).
	assertNoTargetPassword(target);
	let entry: DevicesShowItem;
	try {
		entry = showDevice({ cdb, target }).data.entry;
	} catch (error) {
		if (error instanceof CentrsError && error.code === "cdb/not-found-target") {
			throw new CentrsError({
				code: "cdb/target-not-registered",
				summary: `Target "${target}" is not registered in the CDB allowlist.`,
				remediation:
					"Register the device first with the `centrs_devices` tool (op `add`) or `centrs devices add`, then retry. The MCP server only acts on CDB-registered targets, by target or by its `identity=`, `mac=` or `ip=` comment key.",
				context: { target, cdbFile: cdb.settings.cdbFile.value },
			});
		}
		// The CLI remediation names `--match`, which no MCP tool takes.
		if (error instanceof CentrsError && error.code === "identity/ambiguous") {
			throw new CentrsError({
				code: error.code,
				summary: error.summary,
				remediation:
					"Retry with one candidate's address from `context.matches[].target` as `target`. If the candidates share that address too, the CDB holds duplicate records for it: remove or edit the extra one with the `centrs_devices` tool (op `remove` or `set`).",
				context: error.context,
				cause: error,
			});
		}
		throw error;
	}
	return {
		target: entry.target,
		user: entry.user,
		group: entry.group,
		recordIndex: entry.cdbRecordIndex,
		writePolicy: readWritePolicy(entry.comment),
	};
}

/**
 * Confirm at least one CDB record belongs to a group before a group fanout.
 * Throws `cdb/target-not-registered` when the group is empty so an agent gets
 * the same allowlist framing as a single-target miss.
 */
export function resolveRegisteredGroup(cdb: LoadedCdb, group: string): number {
	let members = 0;
	for (const entry of cdb.entries) {
		if (entry && entry.group === group) {
			members += 1;
		}
	}
	if (members === 0) {
		throw new CentrsError({
			code: "cdb/target-not-registered",
			summary: `No CDB records are in group "${group}".`,
			remediation:
				"Add devices to the group with `centrs devices add --group`, or pick a group that has members. The MCP server only acts on CDB-registered targets.",
			context: { group, cdbFile: cdb.settings.cdbFile.value },
		});
	}
	return members;
}

/**
 * Gate a write-shaped call on the resolved record's CDB policy. Throws
 * `cdb/write-not-permitted` when the device is `mcp=ro` (the default).
 */
export function assertWritePermitted(target: RegisteredTarget): void {
	if (target.writePolicy !== "rw") {
		throw new CentrsError({
			code: "cdb/write-not-permitted",
			summary: `Writes are not permitted for "${target.target}" (CDB policy mcp=${target.writePolicy}).`,
			remediation:
				"Opt the device into MCP writes by setting its CDB record to `mcp=rw` (e.g. `centrs devices set <target> mcp=rw`), then retry with confirm:true. The CDB policy is authoritative even when confirm is set.",
			context: { target: target.target, writePolicy: target.writePolicy },
		});
	}
}
