import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveMcpConfig } from "../../src/mcp/config.ts";
import { createCentrsMcpServer } from "../../src/mcp/server.ts";
import { makeMcpTestCdb } from "./mcp-cdb-fixture.ts";

/**
 * Drive the real server through an MCP client, so the assertions read the
 * tool result a host receives rather than the handler's envelope (#605).
 */
async function connectedClient(cdbFile: string): Promise<{
	client: Client;
	close: () => Promise<void>;
}> {
	const server = createCentrsMcpServer(resolveMcpConfig({ cdbFile, env: {} }));
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: "centrs-test", version: "0.0.0" });
	await client.connect(clientSide);
	return {
		client,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

function envelopeOf(result: Record<string, unknown>): { ok: boolean } {
	const content = result["content"] as { type: string; text: string }[];
	return JSON.parse(content[0]?.text ?? "null");
}

describe("MCP tool results signal failure with isError (#605)", () => {
	test("a successful call leaves isError unset", async () => {
		const { path, cleanup } = await makeMcpTestCdb([{ target: "known" }]);
		const { client, close } = await connectedClient(path);
		try {
			const result = await client.callTool({
				name: "centrs_explain",
				arguments: { command: "/interface/print" },
			});
			expect(envelopeOf(result).ok).toBe(true);
			expect(result.isError).toBeUndefined();
		} finally {
			await close();
			await cleanup();
		}
	});

	for (const [name, args] of [
		["centrs_validate", { target: "stranger", command: "/interface/print" }],
		["centrs_retrieve", { target: "stranger", path: "/system/identity" }],
		[
			"centrs_execute",
			{ target: "stranger", command: "/system/identity/print" },
		],
	] as const) {
		test(`${name}: an unregistered target sets isError`, async () => {
			const { path, cleanup } = await makeMcpTestCdb([{ target: "known" }]);
			const { client, close } = await connectedClient(path);
			try {
				const result = await client.callTool({ name, arguments: args });
				const envelope = envelopeOf(result) as {
					ok: boolean;
					error?: { code: string };
				};
				expect(envelope.ok).toBe(false);
				expect(envelope.error?.code).toBe("cdb/target-not-registered");
				expect(result.isError).toBe(true);
			} finally {
				await close();
				await cleanup();
			}
		});
	}
});
