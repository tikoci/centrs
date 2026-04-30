import { plannedProtocols } from "./index.ts";

export interface McpSurfacePlan {
	name: "centrs-mcp";
	purpose: string;
	protocols: readonly string[];
}

export const mcpSurfacePlan: McpSurfacePlan = {
	name: "centrs-mcp",
	purpose:
		"Future MCP surface for validated RouterOS explain, validate, retrieve, and execute workflows.",
	protocols: plannedProtocols,
};
