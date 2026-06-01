/**
 * The runnable centrs MCP server (stdio).
 *
 * Wires the scoped-verb tool handlers (`./tools.ts`) and the read-only
 * resources (`./resources.ts`) onto an `McpServer`, with `instructions` that
 * point an agent at the allowlist and error catalog. Transport is stdio only —
 * HTTP/remote access is the proxy surface's job, not the MCP server's.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type CentrsMcpConfig, resolveMcpConfig } from "./config.ts";
import {
	buildDevicesResource,
	buildErrorsResource,
	DEVICES_RESOURCE_URI,
	ERRORS_RESOURCE_URI,
} from "./resources.ts";
import {
	devicesInputShape,
	discoverInputShape,
	executeInputShape,
	explainInputShape,
	handleDevices,
	handleDiscover,
	handleExecute,
	handleExplain,
	handleRetrieve,
	handleValidate,
	retrieveInputShape,
	validateInputShape,
} from "./tools.ts";

const SERVER_INSTRUCTIONS = [
	"centrs is a RouterOS interaction hub. These tools reach real MikroTik devices",
	"through a validated core, gated by the CDB device allowlist.",
	"",
	"Safety model:",
	"- Tools act only on devices registered in the CDB (the allowlist). An",
	"  unregistered target is rejected with `cdb/target-not-registered`; register",
	"  it via centrs_devices (op add) first. Credentials live in the CDB and are",
	"  never returned by this interface.",
	"- RouterOS writes are double-gated: the device's CDB record must be `mcp=rw`",
	"  (else `cdb/write-not-permitted`) and centrs_execute must be called with",
	"  confirm:true (else `usage/confirmation-required`). CDB mutations through",
	"  centrs_devices and centrs_discover save also require confirm:true and never",
	"  return saved passwords.",
	"",
	"Recommended flow: centrs_explain (offline canonicalize) → centrs_validate",
	"(dry-run :parse + /console/inspect, never mutates) → centrs_retrieve (read)",
	"or centrs_execute (run). Use centrs_discover to find MNDP neighbors and",
	"centrs_devices to curate the CDB allowlist. Prefer validate before any write.",
	"",
	"Resources:",
	`- ${DEVICES_RESOURCE_URI}: the known devices on the allowlist and each`,
	"  record's MCP write policy (no passwords).",
	`- ${ERRORS_RESOURCE_URI}: the error-code catalog with details URLs; consult`,
	"  it to resolve any envelope `error.code`.",
	"",
	"Every tool returns the standard centrs envelope { ok, data?|error, warnings,",
	"meta } as JSON text. On failure, read `error.code` and `error.remediation`.",
].join("\n");

function jsonContent(value: unknown): {
	content: { type: "text"; text: string }[];
} {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
	};
}

/**
 * Build a configured centrs MCP server. The returned `McpServer` is transport
 * agnostic; call `.connect(transport)` (stdio in production, an in-memory pair
 * in tests).
 */
export function createCentrsMcpServer(
	config: CentrsMcpConfig = resolveMcpConfig(),
): McpServer {
	const server = new McpServer(
		{ name: "centrs-mcp", version: "0.1.0" },
		{ instructions: SERVER_INSTRUCTIONS },
	);

	server.registerTool(
		"centrs_explain",
		{
			title: "Explain (canonicalize) a RouterOS command",
			description:
				"Offline: canonicalize a RouterOS CLI string to { path, verb, attributes, queries, mode, writeShaped }. No device or CDB needed.",
			inputSchema: explainInputShape,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(args) => jsonContent(handleExplain(args)),
	);

	server.registerTool(
		"centrs_validate",
		{
			title: "Validate a RouterOS command (dry-run)",
			description:
				"Dry-run a command through :parse + /console/inspect against a registered device. Never mutates. Catches parser/flag-shape errors schema inspection misses.",
			inputSchema: validateInputShape,
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => jsonContent(await handleValidate(args, config)),
	);

	server.registerTool(
		"centrs_retrieve",
		{
			title: "Retrieve RouterOS state",
			description:
				"Read RouterOS state over the API for a registered target or group, with attribute projection and group fanout. Read-only.",
			inputSchema: retrieveInputShape,
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => jsonContent(await handleRetrieve(args, config)),
	);

	server.registerTool(
		"centrs_execute",
		{
			title: "Execute a RouterOS command",
			description:
				"Run a read- or write-shaped command against a registered device. Writes require the CDB record to be mcp=rw and confirm:true.",
			inputSchema: executeInputShape,
			// destructiveHint is conservative: this one tool serves both read- and
			// write-shaped commands, and a static annotation can't vary per call, so
			// it advertises the worst case. Real enforcement is the canonicalizer's
			// write-shape check plus the CDB mcp=rw/confirm gates in handleExecute;
			// clients wanting a truly read-only path should use centrs_retrieve.
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				openWorldHint: true,
			},
		},
		async (args) => jsonContent(await handleExecute(args, config)),
	);

	server.registerTool(
		"centrs_devices",
		{
			title: "Inspect or mutate the CDB device registry",
			description:
				"Read or update the CDB allowlist. op=list/show/groups are read-only; op=add/edit/set/remove write the CDB and require confirm:true.",
			inputSchema: devicesInputShape,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				openWorldHint: false,
			},
		},
		async (args) => jsonContent(await handleDevices(args, config)),
	);

	server.registerTool(
		"centrs_discover",
		{
			title: "Discover MNDP neighbors",
			description:
				"Listen for MNDP neighbors and optionally save them into the active CDB. save=true writes the CDB and requires confirm:true.",
			inputSchema: discoverInputShape,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				openWorldHint: true,
			},
		},
		async (args) => jsonContent(await handleDiscover(args, config)),
	);

	server.registerResource(
		"devices",
		DEVICES_RESOURCE_URI,
		{
			title: "Known devices (CDB allowlist)",
			description:
				"The devices registered in the active CDB and each record's MCP write policy. No passwords.",
			mimeType: "application/json",
		},
		async (uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: "application/json",
					text: JSON.stringify(await buildDevicesResource(config), null, 2),
				},
			],
		}),
	);

	server.registerResource(
		"errors",
		ERRORS_RESOURCE_URI,
		{
			title: "centrs error catalog",
			description:
				"Known centrs error codes with stable details URLs, including the MCP-specific cdb/target-not-registered and cdb/write-not-permitted.",
			mimeType: "application/json",
		},
		async (uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: "application/json",
					text: JSON.stringify(buildErrorsResource(), null, 2),
				},
			],
		}),
	);

	return server;
}

/** Run the centrs MCP server over stdio until the transport closes. */
export async function runMcpStdio(
	config: CentrsMcpConfig = resolveMcpConfig(),
	transport: Transport = new StdioServerTransport(),
): Promise<void> {
	const server = createCentrsMcpServer(config);
	await server.connect(transport);
}
