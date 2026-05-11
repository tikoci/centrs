/**
 * Protocol adapter registry.
 *
 * Typed seam that adapters plug into so CLI, MCP, TUI, and proxy frontends
 * can discover adapters, capabilities, and `via` identifiers from one source.
 *
 * Status per protocol is the implementation reality (`implemented` flag).
 * Per-cell status across commands is in `docs/MATRIX.md`. Selection rules
 * are in `docs/CONSTITUTION.md` (protocol selection).
 */

export type ProtocolCapability =
	| "execute"
	| "retrieve"
	| "update"
	| "transfer"
	| "terminal"
	| "discover"
	| "proxy";

export interface ProtocolPlan {
	id: string;
	capabilities: readonly ProtocolCapability[];
	notes: string;
	implemented: boolean;
}

export const protocolPlans = [
	{
		id: "rest-api",
		capabilities: ["retrieve", "update", "execute", "transfer", "proxy"],
		notes:
			"RouterOS /rest. retrieve coded; cell status tracked in docs/MATRIX.md. Other capabilities are staged.",
		implemented: true,
	},
	{
		id: "native-api",
		capabilities: ["retrieve", "update", "execute", "proxy"],
		notes: "Binary API. Not yet implemented.",
		implemented: false,
	},
	{
		id: "ssh",
		capabilities: ["execute", "terminal", "transfer"],
		notes:
			"Reuses host ssh client. Important execute/terminal path after grounding.",
		implemented: false,
	},
	{
		id: "snmp",
		capabilities: ["retrieve"],
		notes: "Read-only metrics and identification.",
		implemented: false,
	},
	{
		id: "mndp",
		capabilities: ["discover"],
		notes: "Passive hint source only; not authoritative inventory.",
		implemented: false,
	},
	{
		id: "mac-telnet",
		capabilities: ["terminal"],
		notes: "Layer-2 emergency access. Requires platform tooling.",
		implemented: false,
	},
	{
		id: "romon",
		capabilities: ["terminal"],
		notes: "Routed management overlay. Requires RouterOS-side enablement.",
		implemented: false,
	},
	{
		id: "winbox-terminal",
		capabilities: ["terminal"],
		notes: "Local WinBox tooling required.",
		implemented: false,
	},
] as const satisfies readonly ProtocolPlan[];

export type RouterOsProtocol = (typeof protocolPlans)[number]["id"];

export const plannedProtocols = protocolPlans.map(
	(protocol) => protocol.id,
) as readonly RouterOsProtocol[];

const protocolPlansById = Object.fromEntries(
	protocolPlans.map((protocol) => [protocol.id, protocol]),
) as Record<RouterOsProtocol, (typeof protocolPlans)[number]>;

export function getProtocolPlan(id: RouterOsProtocol): ProtocolPlan {
	return protocolPlansById[id];
}

export function protocolsWithCapability(
	capability: ProtocolCapability,
): readonly ProtocolPlan[] {
	return protocolPlans.filter((protocol) => {
		const capabilities: readonly ProtocolCapability[] = protocol.capabilities;
		return capabilities.includes(capability);
	});
}
