/**
 * #672 / #603: `centrs mcp` over real stdio, keyed from a file.
 *
 * Network-free (no CHR), so it runs in the fast `bun test` gate like the CLI
 * smoke tier. The server gets an encrypted throwaway CDB and only the key
 * file's path: the key is never in argv or the environment. Deleting the file
 * makes the next call return `cdb/password-unavailable`, and the server keeps
 * serving.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addDevice, initCdb, loadCdb } from "../../src/devices.ts";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "cli.ts");
const KEY = "mcp-stdio-cdb-key-never-in-argv";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

interface Envelope {
	ok: boolean;
	data?: unknown;
	error?: { code?: string; context?: Record<string, unknown> };
}

async function callTool(
	client: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<{ envelope: Envelope; text: string }> {
	const result = (await client.callTool({ name, arguments: args })) as {
		content: Array<{ type: string; text: string }>;
	};
	const text = result.content.find((part) => part.type === "text")?.text;
	if (text === undefined) throw new Error(`${name} returned no text`);
	return { envelope: JSON.parse(text) as Envelope, text };
}

describe("centrs mcp keyed from a password file (stdio)", () => {
	test("no key in argv or env; a deleted file fails the next call, not the server", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-mcp-keyfile-"));
		dirs.push(dir);
		const cdbFile = join(dir, "winbox.cdb");
		const keyFile = join(dir, "cdb_key");
		await writeFile(keyFile, `${KEY}\n`);
		await initCdb({ cdbFile, encrypt: true, cdbPasswordFile: keyFile });
		await addDevice({
			cdb: await loadCdb({ cdbFile, cdbPasswordFile: keyFile }),
			target: "192.0.2.10",
			user: "ops",
			password: "router-secret",
			comment: "identity=keyfile-lab",
		});

		const args = [CLI_ENTRY, "mcp", "--cdb-file", cdbFile];
		const env: Record<string, string> = {
			PATH: process.env["PATH"] ?? "",
			HOME: dir,
			XDG_CONFIG_HOME: dir,
			CENTRS_CDB_PASSWORD_FILE: keyFile,
		};
		expect(args.join(" ")).not.toContain(KEY);
		expect(Object.values(env).join(" ")).not.toContain(KEY);

		const transport = new StdioClientTransport({
			command: "bun",
			args,
			env,
			cwd: dir,
			stderr: "pipe",
		});
		const client = new Client({ name: "password-file-test", version: "0" });
		await client.connect(transport);
		try {
			const listed = await callTool(client, "centrs_devices", { op: "list" });
			expect(listed.envelope.ok).toBe(true);
			expect(listed.text).toContain("keyfile-lab");
			expect(listed.text).not.toContain(KEY);

			await rm(keyFile);
			const after = await callTool(client, "centrs_devices", { op: "list" });
			expect(after.envelope.ok).toBe(false);
			expect(after.envelope.error?.code).toBe("cdb/password-unavailable");
			expect(after.envelope.error?.context).toMatchObject({ path: keyFile });

			// The server is still serving: restoring the file works again.
			await writeFile(keyFile, KEY);
			const restored = await callTool(client, "centrs_devices", {
				op: "list",
			});
			expect(restored.envelope.ok).toBe(true);
		} finally {
			await client.close();
		}
	}, 30_000);
});
