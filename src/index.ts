export const centrsVersion = "0.1.0";

export {
	type AnalyzeEncryptedWinBoxCdbOptions,
	analyzeEncryptedWinBoxCdb,
	type BuildWinBoxCdbEntryInput,
	buildWinBoxCdbEntryRecord,
	decodeWinBoxCdbEntries,
	decodeWinBoxCdbEntry,
	type EncryptedWinBoxCdbFile,
	encodeOpenWinBoxCdb,
	encodeWinBoxCdbField,
	encodeWinBoxCdbRecord,
	isWinBoxCdbEncrypted,
	isWinBoxCdbOpen,
	type OpenWinBoxCdbFile,
	parseWinBoxCdb,
	parseWinBoxCdbRecord,
	WINBOX_CDB_SAVED_PASSWORD_FLAG,
	type WinBoxCdbEncryptedAnalysis,
	type WinBoxCdbEncryptedBlockAlignment,
	type WinBoxCdbEntry,
	type WinBoxCdbField,
	type WinBoxCdbFieldValue,
	type WinBoxCdbFile,
	type WinBoxCdbRecord,
	winBoxCdbFieldTag,
	winBoxCdbRecordType,
} from "./data/winbox-cdb.ts";
export {
	getProtocolPlan,
	type ProtocolCapability,
	type ProtocolPlan,
	plannedProtocols,
	protocolPlans,
	protocolsWithCapability,
	type RouterOsProtocol,
} from "./protocols/index.ts";

import { plannedProtocols, type RouterOsProtocol } from "./protocols/index.ts";

export const plannedSurfaces = ["api", "cli", "tui", "mcp", "proxy"] as const;
export const plannedDeviceSources = [
	"explicit-input",
	"environment",
	"sqlite-cache",
	"winbox-cdb",
	"dude-db",
	"mndp",
] as const;

export type CentrsSurface = (typeof plannedSurfaces)[number];
export type DeviceSource = (typeof plannedDeviceSources)[number];

export interface ProjectSummary {
	name: "centrs";
	version: string;
	description: string;
	surfaces: readonly CentrsSurface[];
	protocols: readonly RouterOsProtocol[];
	deviceSources: readonly DeviceSource[];
}

export const projectSummary: ProjectSummary = {
	name: "centrs",
	version: centrsVersion,
	description:
		"RouterOS interaction hub for typed APIs, CLI, TUI, MCP, and proxy frontends.",
	surfaces: plannedSurfaces,
	protocols: plannedProtocols,
	deviceSources: plannedDeviceSources,
};

export function describeCentrs(
	summary: ProjectSummary = projectSummary,
): string {
	return `${summary.name} ${summary.version}: ${summary.description}`;
}
