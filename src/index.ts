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
	listWinBoxCdbBackups,
	WINBOX_CDB_DEFAULT_BACKUP_RETENTION,
	type WriteWinBoxCdbOptions,
	type WriteWinBoxCdbResult,
	writeWinBoxCdb,
} from "./data/winbox-cdb-write.ts";
export {
	type AddDeviceArgs,
	addDevice,
	buildDevicesErrorEnvelope,
	type DevicesCommand,
	type DevicesEnvelope,
	type DevicesGroupSummary,
	type DevicesListItem,
	type DevicesMutationData,
	type DevicesMutationEnvelope,
	type DevicesOperationMeta,
	type DevicesOutputFormat,
	type DevicesShowEnvelopeData,
	type DevicesShowItem,
	type DevicesWarning,
	defaultCdbPath,
	devicesOutputFormats,
	type EditDeviceArgs,
	editDevice,
	type LoadCdbOptions,
	type LoadedCdb,
	listDevices,
	listGroups,
	loadCdb,
	type RemoveDeviceArgs,
	recordTypeFromName,
	recordTypeName,
	removeDevice,
	renderDevicesEnvelope,
	resolveDevicesSettings,
	type SetDeviceCommentKvArgs,
	setDeviceCommentKv,
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
	createProtocolAdapter,
	getProtocolPlan,
	type ProtocolAdapter,
	type ProtocolAdapterCapabilities,
	type ProtocolAdapterConfig,
	type ProtocolCapability,
	type ProtocolExecuteRequest,
	type ProtocolExecuteResult,
	type ProtocolPlan,
	plannedProtocols,
	protocolPlans,
	protocolsWithCapability,
	type RetrieveListOptions,
	type RouterOsProtocol,
} from "./protocols/index.ts";
export {
	applyCommentKv,
	type CdbGroupExpansion,
	type CdbGroupResolveInput,
	type CdbGroupTarget,
	type CdbResolution,
	type CdbResolveInput,
	type CommentKvKey,
	type CommentKvLayer,
	type CommentKvOverrides,
	type CommentKvResult,
	type CommentKvUpdate,
	type CommentKvWarning,
	coerceCommentKv,
	commentKvAllowlist,
	commentKvReservedKeys,
	defaultPortForScheme,
	expandCdbGroup,
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
	renderCommentKvToken,
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
	buildResolvedRetrieve,
	buildRetrieveErrorEnvelope,
	buildRetrieveErrorEnvelopeFromResolved,
	type ResolvedRetrieveRequest,
	type RetrieveEnvelope,
	type RetrieveErrorEnvelope,
	type RetrieveGlobalContext,
	type RetrieveOperationMeta,
	type RetrieveOutputFormat,
	type RetrieveRequest,
	type RetrieveRequestSummary,
	type RetrieveSuccessEnvelope,
	type RetrieveWarning,
	renderRetrieveEnvelope,
	resolveRetrieveGlobalContext,
	resolveRetrieveRequest,
	retrieve,
	retrieveOutputFormats,
	runResolvedRetrieve,
	validateRetrieveRequestShape,
} from "./retrieve.ts";
export {
	buildRetrieveFanoutErrorEnvelope,
	isRetryableFanoutError,
	RETRIEVE_FANOUT_BACKOFF_BASE_MS,
	RETRIEVE_FANOUT_CONCURRENCY_DEFAULTS,
	RETRIEVE_FANOUT_MAX_RETRIES,
	RETRIEVE_FANOUT_RETRYABLE_CODES,
	type RetrieveFanoutData,
	type RetrieveFanoutEnvelope,
	type RetrieveFanoutErrorEnvelope,
	type RetrieveFanoutOperationMeta,
	type RetrieveGroupInternals,
	renderRetrieveFanoutEnvelope,
	resolveFanoutConcurrency,
	retrieveGroup,
	runBoundedPool,
	summarizeFanout,
} from "./retrieve-fanout.ts";

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
