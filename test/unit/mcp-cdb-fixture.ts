import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	type WinBoxCdbRecord,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";

export interface McpTestEntry {
	target: string;
	user?: string;
	password?: string;
	group?: string;
	comment?: string;
}

/**
 * Build a throwaway, unencrypted CDB on disk for MCP allowlist tests. Each entry
 * is an ipAdmin record whose `target` doubles as the CDB name an MCP tool
 * resolves against. The `mcp=rw`/`mcp=ro` write policy rides the comment kv.
 */
export async function makeMcpTestCdb(
	entries: readonly McpTestEntry[],
): Promise<{
	path: string;
	cleanup: () => Promise<void>;
}> {
	const records: WinBoxCdbRecord[] = entries.map((entry) =>
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: entry.target,
			user: entry.user ?? "admin",
			password: entry.password ?? "secret",
			group: entry.group ?? "",
			comment: entry.comment ?? "",
		}),
	);
	const dir = await mkdtemp(join(tmpdir(), "centrs-mcp-"));
	const path = join(dir, "winbox.cdb");
	await writeFile(path, encodeOpenWinBoxCdb(records));
	return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
