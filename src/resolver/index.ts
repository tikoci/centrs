/**
 * Shared, transport-agnostic resolver.
 *
 * One resolver feeds every command (`retrieve` today; `execute` / `devices`
 * next) so target identity, credentials, comment-kv overrides, and settings
 * precedence behave identically everywhere. See `docs/CONSTITUTION.md`
 * ("Settings precedence", "Identity and CDB") for the contract.
 *
 * Layers:
 *   - `./settings.ts` — precedence primitives (default < config < comment-kv <
 *     env < cli) and source coercion to the core envelope union.
 *   - `./config-file.ts` — the `config` tier itself: loads `centrs.env`
 *     (`commands/settings/README.md`) into the flat map every command passes
 *     as the `config` argument to `./settings.ts`'s resolvers.
 *   - `./cdb.ts`      — CDB identity + comment-kv parse/coerce/provenance.
 *   - `./target.ts`   — host/port/baseUrl identity + credentials + per-field
 *     provenance map.
 *   - `./comment-kv.ts` — the raw kv-soup parser (pure).
 */

export {
	type CdbGroupExpansion,
	type CdbGroupResolveInput,
	type CdbGroupTarget,
	type CdbResolution,
	type CdbResolveInput,
	type CommentKvOverrides,
	coerceCommentKv,
	DEFAULT_RECORD_TARGET,
	expandCdbGroup,
	identityFromComment,
	macFromComment,
	type ResolverWarning,
	resolutionFromEntry,
	resolveCdb,
} from "./cdb.ts";
export {
	applyCommentKv,
	type CommentKvGeoKey,
	type CommentKvKey,
	type CommentKvResult,
	type CommentKvUpdate,
	type CommentKvWarning,
	commentKvAllowlist,
	commentKvGeoKeys,
	commentKvReservedKeys,
	parseCommentKv,
	parseRawCommentFacts,
	renderCommentKvToken,
} from "./comment-kv.ts";
export {
	defaultSettingsPath,
	loadEnvFileDefaults,
	parseEnvFileDefaults,
	readSettingsFileRaw,
	type SettingsFileContents,
} from "./config-file.ts";
export {
	type AltitudeType,
	canonicalizeGeoKey,
	type DeviceLocation,
	deviceLocation,
	type ParsedGpsTuple,
	parseAltitude,
	parseAltitudeType,
	parseGpsTuple,
	parseLatLon,
} from "./geo.ts";
export {
	type ArpEntry,
	effectiveHostCandidate,
	isIpTransport,
	isMacAddress,
	normalizeMac,
	parseArpTable,
	parseResolvePolicy,
	type ResolvePolicy,
	resolveMacTarget,
	resolveMacViaArp,
	unresolvedMacError,
} from "./mac.ts";
export {
	type CdbSelectionExpansion,
	type CdbSelectionMember,
	type CdbSelectionResolveInput,
	expandCdbSelection,
	isDefaultRecordTarget,
	type SelectionWhereClause,
	type TargetSelection,
} from "./selection.ts";
export {
	type CommentKvLayer,
	parseBoolean,
	parseDuration,
	REFUSED_CONFIG_ENV_KEYS,
	type ResolvedSetting,
	type ResolverSettingSource,
	type ResolverSettingSourceKind,
	resolveBooleanSetting,
	resolveOptionalIntegerSetting,
	resolveStringSetting,
	toCoreSource,
} from "./settings.ts";
export {
	defaultPortForScheme,
	parseHostCandidate,
	type ResolvedAuth,
	type ResolvedTarget,
	resolveAuth,
	resolveTarget,
	type TargetResolveInput,
} from "./target.ts";
