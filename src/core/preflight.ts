/**
 * Capability/version pre-flight for centrs-generated RouterOS commands (#129).
 *
 * centrs sometimes generates a command that assumes a device capability the
 * device may lack (e.g. `transfer mkdir` → `/file add type=directory`, absent
 * on older RouterOS). Without a pre-flight that surfaces as a raw protocol
 * error; with one it becomes a typed `routeros/version-unsupported` error
 * naming the versions that do support the operation. (Distinct from
 * `routeros/unsupported-capability`, which is a *protocol*-side gap — the
 * transport cannot carry the operation at all.)
 *
 * Design:
 * - A {@link CapabilityRequirement} carries the supported
 *   {@link RouterOsVersionRange} list as **data**. Ranges are inclusive-`min` /
 *   exclusive-`maxExclusive`, so a backported feature is a list of per-release-
 *   line minimums (e.g. `[{min:"7.21.4", maxExclusive:"7.22"}, {min:"7.22.2"}]`).
 *   The grounding for each requirement (CHR run, rosetta changelog/command-diff)
 *   lives at the requirement's definition site — this module only evaluates.
 * - The device version comes from a {@link DeviceVersion}: a live read
 *   ({@link probeDeviceVersion}), the CDB record's stored `version=` comment
 *   fact ({@link versionFactFromComment} — stale-but-cheap, written by
 *   `discover --save`/`devices --check`), or the caller.
 * - An **unknown** version never blocks (crash-early: the device's own error
 *   still surfaces through the RouterOS error mapping); only a version known to
 *   be outside every supported range fails, via {@link assertCapability}.
 *
 * Version ordering is suffix-aware: `7.23beta1 < 7.23beta2 < 7.23rc1 < 7.23 <
 * 7.23.1` (RouterOS version format `MAJOR.MINOR[.PATCH][beta|rc N]`). The
 * comparator tolerates trailing channel/date noise (`"7.21.4 (long-term) …"`),
 * matching what `/system/resource` reports. Promoted from the integration
 * harness's `routerOsAtLeast` (`test/integration/chr.ts`), which now delegates
 * here.
 */

import { CentrsError } from "../errors.ts";
import type { ProtocolAdapter } from "../protocols/adapter.ts";
import { parseRawCommentFacts } from "../resolver/comment-kv.ts";

/** Parsed RouterOS version, ordered by the tuple (major, minor, patch, stage, stageIteration). */
export interface RouterOsVersionParts {
	major: number;
	minor: number;
	patch: number;
	/** Prerelease stage rank: beta=0 < rc=1 < release=2. */
	stageRank: 0 | 1 | 2;
	/** Iteration within the stage (`beta2` → 2); 0 for a release. */
	stageIteration: number;
}

/**
 * Parse a RouterOS version out of a possibly-noisy string
 * (`"7.21.4 (long-term) 2026-04-21"` → 7.21.4). Returns `undefined` when no
 * `major.minor` shape is present.
 */
export function parseRouterOsVersion(
	raw: string,
): RouterOsVersionParts | undefined {
	const match = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?(?:(beta|rc)(\d+))?/i);
	if (!match) {
		return undefined;
	}
	const stage = match[4]?.toLowerCase();
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3] ?? 0),
		stageRank: stage === undefined ? 2 : stage === "rc" ? 1 : 0,
		stageIteration: Number(match[5] ?? 0),
	};
}

/**
 * Compare two RouterOS version strings: negative when `a < b`, 0 when equal,
 * positive when `a > b`. An unparseable version sorts below every parseable
 * one (and equal to another unparseable one).
 */
export function compareRouterOsVersion(a: string, b: string): number {
	const left = parseRouterOsVersion(a);
	const right = parseRouterOsVersion(b);
	if (left === undefined || right === undefined) {
		return (left === undefined ? 0 : 1) - (right === undefined ? 0 : 1);
	}
	return (
		left.major - right.major ||
		left.minor - right.minor ||
		left.patch - right.patch ||
		left.stageRank - right.stageRank ||
		left.stageIteration - right.stageIteration
	);
}

/** True when `running` ≥ `target`. Unparseable `running` is never ≥ a parseable target. */
export function routerOsVersionAtLeast(
	running: string,
	target: string,
): boolean {
	if (
		parseRouterOsVersion(running) === undefined &&
		parseRouterOsVersion(target) !== undefined
	) {
		return false;
	}
	return compareRouterOsVersion(running, target) >= 0;
}

/**
 * One contiguous supported window. `min` is inclusive; `maxExclusive` bounds a
 * backport window (omit it for "this version and everything after").
 */
export interface RouterOsVersionRange {
	min: string;
	maxExclusive?: string;
}

/** True when `version` falls inside `range`. */
export function versionInRange(
	version: string,
	range: RouterOsVersionRange,
): boolean {
	if (!routerOsVersionAtLeast(version, range.min)) {
		return false;
	}
	return (
		range.maxExclusive === undefined ||
		compareRouterOsVersion(version, range.maxExclusive) < 0
	);
}

/**
 * A capability a centrs-generated command depends on, with the version windows
 * where RouterOS provides it. Define these next to the consumer (e.g. the
 * transfer spec owns the `mkdir` requirement) and document the grounding
 * evidence there.
 */
export interface CapabilityRequirement {
	/** Stable slug for error context, e.g. `file-add-directory`. */
	capability: string;
	/** Human phrase for the operation, e.g. "create directories with `/file add type=directory`". */
	summary: string;
	/** Windows where the capability exists; supported when ANY range matches. */
	supported: readonly RouterOsVersionRange[];
	/** Extra guidance appended to the typed error's remediation. */
	remediation?: string;
}

/** Where a pre-flighted device version came from (error context + envelope provenance). */
export type DeviceVersionSource = "live" | "cdb-fact" | "caller";

/** A device version paired with its provenance. */
export interface DeviceVersion {
	version: string;
	source: DeviceVersionSource;
}

export type PreflightState = "supported" | "unsupported" | "unknown";

/** Outcome of a capability pre-flight. */
export interface PreflightVerdict {
	state: PreflightState;
	/** Echo of the checked device version, when one was available. */
	device?: DeviceVersion;
}

/**
 * Evaluate a requirement against a device version. `unknown` when no version
 * is available or it does not parse — callers proceed on `unknown` (the device
 * still reports its own error, mapped by the RouterOS error vocabulary).
 */
export function checkCapability(
	requirement: CapabilityRequirement,
	device?: DeviceVersion,
): PreflightVerdict {
	if (
		device === undefined ||
		parseRouterOsVersion(device.version) === undefined
	) {
		return { state: "unknown" };
	}
	const supported = requirement.supported.some((range) =>
		versionInRange(device.version, range),
	);
	return { state: supported ? "supported" : "unsupported", device };
}

/** Render supported windows for humans: `7.21.4–7.22 (excl.), 7.22.2+`. */
export function renderSupportedRanges(
	ranges: readonly RouterOsVersionRange[],
): string {
	return ranges
		.map((range) =>
			range.maxExclusive === undefined
				? `${range.min}+`
				: `${range.min}–${range.maxExclusive} (excl.)`,
		)
		.join(", ");
}

/**
 * Pre-flight gate: throw a typed `routeros/version-unsupported` error when
 * the device version is known and outside every supported window; otherwise
 * return the verdict (`unknown` passes — see {@link checkCapability}).
 */
export function assertCapability(
	requirement: CapabilityRequirement,
	device?: DeviceVersion,
): PreflightVerdict {
	const verdict = checkCapability(requirement, device);
	if (verdict.state !== "unsupported" || verdict.device === undefined) {
		return verdict;
	}
	const supported = renderSupportedRanges(requirement.supported);
	throw new CentrsError({
		code: "routeros/version-unsupported",
		summary: `RouterOS ${verdict.device.version} cannot ${requirement.summary}; it needs ${supported}.`,
		remediation:
			(requirement.remediation ? `${requirement.remediation} ` : "") +
			(verdict.device.source === "cdb-fact"
				? "The version came from the stored CDB `version=` fact and may be stale; upgrade RouterOS, or refresh the fact if the device was already upgraded."
				: "Upgrade RouterOS to a supported version."),
		context: {
			capability: requirement.capability,
			version: verdict.device.version,
			versionSource: verdict.device.source,
			supported: requirement.supported.map((range) => ({ ...range })),
		},
	});
}

/**
 * Read a stored device version from a CDB record's comment kv-soup (`version=`
 * — the derived fact `discover --save` and `devices --check` write). Stale by
 * nature; provenance is `cdb-fact`.
 */
export function versionFactFromComment(
	comment: string,
): DeviceVersion | undefined {
	const version = parseRawCommentFacts(comment)["version"];
	if (version === undefined || parseRouterOsVersion(version) === undefined) {
		return undefined;
	}
	return { version, source: "cdb-fact" };
}

/**
 * Live device-version probe over an already-built adapter. Structured
 * transports read `/system/resource`; console transports (ssh/mac-telnet) run
 * `:put [/system/resource/ get version]`. Transport/auth errors propagate —
 * only a well-formed reply that simply lacks a version yields `undefined`.
 */
export async function probeDeviceVersion(
	adapter: ProtocolAdapter,
): Promise<DeviceVersion | undefined> {
	if (adapter.capabilities.retrieve) {
		const resource = await adapter.getSingleton("/system/resource");
		const version =
			typeof resource === "object" && resource !== null
				? (resource as Record<string, unknown>)["version"]
				: undefined;
		if (typeof version === "string" && parseRouterOsVersion(version)) {
			return { version, source: "live" };
		}
		return undefined;
	}
	const result = await adapter.execute({
		path: "/system/resource",
		command: "print",
		script: ":put [/system/resource/ get version]",
	});
	const version = result.ret?.trim();
	if (version && parseRouterOsVersion(version)) {
		return { version, source: "live" };
	}
	return undefined;
}
