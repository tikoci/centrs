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
	| "transfer"
	| "terminal"
	| "discover"
	| "measure"
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
		capabilities: ["retrieve", "execute", "transfer", "proxy"],
		notes:
			"RouterOS /rest. retrieve coded; cell status tracked in docs/MATRIX.md. Other capabilities are staged.",
		implemented: true,
	},
	{
		id: "native-api",
		capabilities: ["retrieve", "execute", "proxy"],
		notes:
			"Binary API (TCP 8728 / TLS 8729). Transport base implemented in native-api.ts (word/sentence codec, login, tagged talk); command wiring tracked in docs/MATRIX.md.",
		implemented: true,
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
		capabilities: ["execute", "terminal"],
		notes:
			"Layer-2 execute path (UDP 20561). Codec + MD5/MTWEI session (mac-telnet.ts), interactive-console reader (mac-telnet-console.ts), and UDP transport + execute adapter wired into execute. terminal cell tracked in docs/MATRIX.md.",
		implemented: true,
	},
	{
		id: "romon",
		capabilities: ["execute"],
		notes:
			"Routed management overlay for execute. Lower priority than mac-telnet.",
		implemented: false,
	},
	{
		id: "winbox-terminal",
		capabilities: ["execute"],
		notes:
			"WinBox terminal protocol for execute. Lower priority than mac-telnet.",
		implemented: false,
	},
	{
		id: "btest",
		capabilities: ["measure"],
		notes:
			"MikroTik bandwidth test (peer protocol, TCP/UDP 2000). Explicit-only — never in the execute/retrieve downgrade chains. v1: client + server, EC-SRP5 + unauthenticated, TCP+UDP. Server CHR-passed; cell status in docs/MATRIX.md (Peer measurement).",
		implemented: true,
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

export * from "./adapter.ts";
export * from "./mac-telnet.ts";
export * from "./mtwei.ts";
export * from "./native-api.ts";
