import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { encodeOpenWinBoxCdb } from "../../src/data/winbox-cdb.ts";
import { addDevice, loadCdb } from "../../src/devices.ts";
import { resolveMcpConfig } from "../../src/mcp/config.ts";
import { createCentrsMcpServer } from "../../src/mcp/server.ts";
import {
	exampleIds,
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
} from "./chr.ts";

const runFastIntegration = isChrIntegrationEnabled();
const describeFast = runFastIntegration ? describe : describe.skip;

interface Envelope {
	ok: boolean;
	data?: unknown;
	error?: { code?: string; cause?: unknown };
	meta?: { via?: string; validation?: { source?: string } };
}

interface ExplainData {
	path?: string;
	verb?: string;
	writeShaped?: boolean;
}

async function callTool(
	client: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<Envelope> {
	const result = (await client.callTool({ name, arguments: args })) as {
		content: Array<{ type: string; text: string }>;
	};
	const textPart = result.content.find((part) => part.type === "text");
	if (!textPart) {
		throw new Error(`tool ${name} returned no text content`);
	}
	return JSON.parse(textPart.text) as Envelope;
}

describeFast("centrs MCP server against CHR", () => {
	test("drives examples 1-10 over an in-process MCP client", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		const dir = await mkdtemp(join(tmpdir(), "centrs-mcp-int-"));
		const cdbFile = join(dir, "winbox.cdb");

		try {
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);

			await writeFile(cdbFile, encodeOpenWinBoxCdb([]));
			let cdb = await loadCdb({ cdbFile, env: {} });
			await addDevice({
				cdb,
				target: chr.restUrl,
				user: auth.username,
				password: auth.password,
				comment: "mcp=rw via=rest-api",
				savedPassword: true,
			});
			cdb = await loadCdb({ cdbFile, env: {} });
			await addDevice({
				cdb,
				target: "ro-only",
				user: auth.username,
				password: auth.password,
				comment: "mcp=ro",
				savedPassword: true,
			});

			const config = resolveMcpConfig({ cdbFile, env: {} });
			const server = createCentrsMcpServer(config);
			const [clientTransport, serverTransport] =
				InMemoryTransport.createLinkedPair();
			const client = new Client({ name: "centrs-int", version: "0.0.0" });
			await Promise.all([
				server.connect(serverTransport),
				client.connect(clientTransport),
			]);

			try {
				// Example 1: explain (offline canonicalization).
				const explain = await callTool(client, "centrs_explain", {
					command: "/ip/route/add dst-address=10.99.0.0/24 blackhole=yes",
				});
				expect(explain.ok).toBe(true);
				const explainData = explain.data as ExplainData;
				expect(explainData.path).toBe("/ip/route");
				expect(explainData.verb).toBe("add");
				expect(explainData.writeShaped).toBe(true);

				// Example 2: unregistered target rejected by the allowlist.
				const stranger = await callTool(client, "centrs_retrieve", {
					target: "192.0.2.1",
					path: "/system/resource",
				});
				expect(stranger.ok).toBe(false);
				expect(stranger.error?.code).toBe("cdb/target-not-registered");

				// Example 3: validate accepts the bare blackhole flag (dry-run only).
				const validBare = await callTool(client, "centrs_validate", {
					target: chr.restUrl,
					command: "/ip/route/add dst-address=10.99.0.0/24 blackhole",
				});
				expect(validBare.ok).toBe(true);
				const validation = validBare.meta?.validation ?? {};
				expect(validation.source).toContain(":parse");

				// Dry-run created no route.
				const routes = await callTool(client, "centrs_retrieve", {
					target: chr.restUrl,
					path: "/ip/route",
				});
				expect(routes.ok).toBe(true);
				const routeRows = Array.isArray(routes.data) ? routes.data : [];
				expect(
					routeRows.some(
						(row) =>
							typeof row === "object" &&
							row !== null &&
							(row as Record<string, unknown>)["dst-address"] ===
								"10.99.0.0/24",
					),
				).toBe(false);

				// Example 4: validate rejects a schema-invalid command. The dual
				// gate (`:parse` + `/console/inspect`) catches an unknown attribute
				// even though the bench's historical `blackhole=yes` parser bug no
				// longer reproduces on RouterOS 7.23 (the device parser now accepts
				// it). This asserts the gate genuinely rejects bad input without
				// mutating the router.
				const validBad = await callTool(client, "centrs_validate", {
					target: chr.restUrl,
					command: "/ip/route/add dst-address=10.99.0.0/24 nonexistentattr=1",
				});
				expect(validBad.ok).toBe(false);
				expect(validBad.error?.code).toBe("validation/unknown-attribute");

				// Example 5: retrieve returns a structured record.
				const resource = await callTool(client, "centrs_retrieve", {
					target: chr.restUrl,
					path: "/system/resource",
					attributes: ["version", "board-name"],
				});
				expect(resource.ok).toBe(true);
				expect(resource.meta?.via).toBe("rest-api");
				const resourceData = resource.data as {
					version?: unknown;
					"board-name"?: unknown;
				};
				expect(resourceData).toHaveProperty("version");
				expect(resourceData).toHaveProperty("board-name");

				// Example 6: execute runs a read-shaped command.
				const identity = await callTool(client, "centrs_execute", {
					target: chr.restUrl,
					command: "/system/identity/print",
				});
				expect(identity.ok).toBe(true);

				// Example 7: write against an mcp=ro target is refused (offline gate).
				const roWrite = await callTool(client, "centrs_execute", {
					target: "ro-only",
					command: "/ip/address/add address=198.51.100.10/32 interface=ether1",
					confirm: true,
				});
				expect(roWrite.ok).toBe(false);
				expect(roWrite.error?.code).toBe("cdb/write-not-permitted");

				// Example 9: write without confirm on an rw target fails closed.
				const noConfirm = await callTool(client, "centrs_execute", {
					target: chr.restUrl,
					command:
						"/ip/address/add address=198.51.100.10/32 interface=ether1 comment=centrs-mcp",
				});
				expect(noConfirm.ok).toBe(false);
				expect(noConfirm.error?.code).toBe("usage/confirmation-required");

				// Example 8: write against an rw target succeeds with confirm:true.
				const write = await callTool(client, "centrs_execute", {
					target: chr.restUrl,
					command:
						"/ip/address/add address=198.51.100.10/32 interface=ether1 comment=centrs-mcp",
					confirm: true,
				});
				expect(write.ok).toBe(true);

				// Cleanup the address created in example 8.
				const cleanup = await callTool(client, "centrs_execute", {
					target: chr.restUrl,
					command: "/ip/address/remove [find comment=centrs-mcp]",
					confirm: true,
				});
				expect(cleanup.ok).toBe(true);

				// Example 10: centrs_devices add grows the allowlist without
				// returning the saved password.
				const added = await callTool(client, "centrs_devices", {
					op: "add",
					target: "lab-edge",
					user: auth.username,
					password: auth.password,
					comment: "mcp=ro",
					confirm: true,
				});
				expect(added.ok).toBe(true);
				const addedData = added.data as {
					entry?: { password?: string; passwordSet?: boolean };
				};
				expect(addedData.entry?.password).toBeUndefined();
				expect(addedData.entry?.passwordSet).toBe(auth.password.length > 0);

				const shown = await callTool(client, "centrs_devices", {
					op: "show",
					target: "lab-edge",
				});
				expect(shown.ok).toBe(true);
			} finally {
				await client.close();
			}

			await recordIntegrationEvidence({
				suite: "mcp",
				command: "centrs mcp",
				protocol: "rest-api",
				routerosVersion: chr.state.version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(10),
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
			await chr.destroy();
		}
	}, 120_000);
});
