export const centrsVersion = "0.1.0";

export {
	type AnalyzeEncryptedWinBoxCdbOptions,
	analyzeEncryptedWinBoxCdb,
	type BuildWinBoxCdbEntryInput,
	buildWinBoxCdbEntryRecord,
	decodeWinBoxCdbEntries,
	decodeWinBoxCdbEntry,
	decryptWinBoxCdb,
	type EncryptedWinBoxCdbFile,
	type EncryptWinBoxCdbOptions,
	encodeOpenWinBoxCdb,
	encodeWinBoxCdbField,
	encodeWinBoxCdbRecord,
	encryptWinBoxCdb,
	isWinBoxCdbEncrypted,
	isWinBoxCdbOpen,
	type OpenWinBoxCdbFile,
	parseWinBoxCdb,
	parseWinBoxCdbRecord,
	WINBOX_CDB_ENCRYPTED_SALT_LENGTH,
	WINBOX_CDB_RC4_DROP_BYTES,
	WINBOX_CDB_SAVED_PASSWORD_FLAG,
	type WinBoxCdbEncryptedAnalysis,
	type WinBoxCdbEncryptedBlockAlignment,
	type WinBoxCdbEntry,
	type WinBoxCdbField,
	type WinBoxCdbFieldValue,
	type WinBoxCdbFile,
	type WinBoxCdbRecord,
	WinBoxCdbWrongPasswordError,
	winBoxCdbFieldTag,
	winBoxCdbRecordType,
} from "./data/winbox-cdb.ts";
export {
	buildDevicesErrorEnvelope,
	type DevicesCommand,
	type DevicesEnvelope,
	type DevicesErrorEnvelope,
	type DevicesGroupSummary,
	type DevicesListItem,
	type DevicesOutputFormat,
	type DevicesShowEnvelopeData,
	type DevicesShowItem,
	type DevicesSuccessEnvelope,
	type DevicesWarning,
	defaultCdbPath,
	devicesOutputFormats,
	type LoadCdbOptions,
	type LoadedCdb,
	listDevices,
	listGroups,
	loadCdb,
	recordTypeName,
	renderDevicesEnvelope,
	resolveDevicesSettings,
	type SettingSource,
	type SettingSourceKind,
	showDevice,
} from "./devices.ts";
export {
	asCentrsError,
	CentrsError,
	type CentrsErrorCode,
	type SerializedCentrsError,
	serializeCentrsError,
} from "./errors.ts";
export {
	getProtocolPlan,
	type ProtocolCapability,
	type ProtocolPlan,
	plannedProtocols,
	protocolPlans,
	protocolsWithCapability,
	type RouterOsProtocol,
} from "./protocols/index.ts";
export {
	buildRetrieveErrorEnvelope,
	type RetrieveEnvelope,
	type RetrieveErrorEnvelope,
	type RetrieveOutputFormat,
	type RetrieveRequest,
	type RetrieveRequestSummary,
	type RetrieveResultSummary,
	type RetrieveSuccessEnvelope,
	type RetrieveValidationSummary,
	type RetrieveWarning,
	renderRetrieveEnvelope,
	retrieve,
	retrieveOutputFormats,
} from "./retrieve.ts";

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
