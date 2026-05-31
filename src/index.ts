export const centrsVersion = "0.1.0";

export {
	type CentrsEnvelope,
	type CentrsErrorEnvelope,
	type CentrsSuccessEnvelope,
	type CommonSettingsMeta,
	type EnvelopeMeta,
	type EnvelopeTargetMeta,
	type EnvelopeValidationMeta,
	type FanoutData,
	type FanoutSummary,
	normalizeWarnings,
	type SettingSource,
	type SettingSourceKind,
	type Warning,
} from "./core/envelope.ts";
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
	type DevicesGroupSummary,
	type DevicesListItem,
	type DevicesOperationMeta,
	type DevicesOutputFormat,
	type DevicesShowEnvelopeData,
	type DevicesShowItem,
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
	type CdbResolution,
	type CdbResolveInput,
	type CommentKvKey,
	type CommentKvLayer,
	type CommentKvOverrides,
	type CommentKvResult,
	type CommentKvWarning,
	coerceCommentKv,
	commentKvAllowlist,
	commentKvReservedKeys,
	defaultPortForScheme,
	parseBoolean,
	parseCommentKv,
	parseDuration,
	parseHostCandidate,
	type ResolvedAuth,
	type ResolvedSetting,
	type ResolvedTarget,
	type ResolverSettingSource,
	type ResolverSettingSourceKind,
	type ResolverWarning,
	resolveAuth,
	resolveBooleanSetting,
	resolveCdb,
	resolveOptionalIntegerSetting,
	resolveStringSetting,
	resolveTarget,
	type TargetResolveInput,
	toCoreSource,
} from "./resolver/index.ts";
export {
	buildRetrieveErrorEnvelope,
	type RetrieveEnvelope,
	type RetrieveErrorEnvelope,
	type RetrieveOperationMeta,
	type RetrieveOutputFormat,
	type RetrieveRequest,
	type RetrieveRequestSummary,
	type RetrieveSuccessEnvelope,
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
