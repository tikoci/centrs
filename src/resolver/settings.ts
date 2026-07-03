/**
 * Settings precedence primitives shared by every command resolver.
 *
 * The constitution (`docs/CONSTITUTION.md`, "Settings precedence") locks the
 * order, lowest → highest:
 *
 *   default < config < comment-kv < env < cli
 *
 * Each primitive picks the highest-precedence layer that supplied a value and
 * records the winning {@link ResolverSettingSource}. `comment-kv` overrides come
 * from the matched CDB entry's comment (see `./cdb.ts`); they are already
 * coerced to the target type by the time they reach these helpers, so the
 * `normalize` step never runs against them.
 *
 * The resolver tracks two extra source kinds beyond the core union —
 * `explicit` and `target-input` — so callers can tell a `--host` flag apart
 * from a bare `<router>` positional while resolving. {@link toCoreSource}
 * collapses both to the canonical core `cli` kind for the envelope, because a
 * positional argument is, precedence-wise, a CLI input.
 */

import type {
	SettingSource as CoreSettingSource,
	SettingSourceKind as CoreSettingSourceKind,
} from "../core/envelope.ts";
import { CentrsError } from "../errors.ts";

/**
 * Internal source kinds. A superset of the core union: `explicit` (an API/CLI
 * value passed directly) and `target-input` (the bare `<router>` positional)
 * both collapse to core `cli` via {@link toCoreSource}.
 */
export type ResolverSettingSourceKind =
	| CoreSettingSourceKind
	| "explicit"
	| "target-input";

export interface ResolverSettingSource {
	kind: ResolverSettingSourceKind;
	key: string;
}

export interface ResolvedSetting<T> {
	value: T;
	source: ResolverSettingSource;
}

/** A pre-coerced comment-kv override layer (sits below env, above config). */
export type CommentKvLayer<T> = ResolvedSetting<T> | undefined;

export function toCoreSource(source: ResolverSettingSource): CoreSettingSource {
	switch (source.kind) {
		case "explicit":
		case "target-input":
			return { kind: "cli", key: source.key };
		default:
			return { kind: source.kind, key: source.key };
	}
}

/**
 * Resolve a string-valued setting across the precedence ladder.
 *
 * Order checked (highest first): explicit/cli → env → comment-kv → config →
 * default. `normalize` runs against explicit/env/config/default raw strings;
 * the comment-kv layer is already coerced to `T`.
 */
export function resolveStringSetting<T = string>(
	explicit: string | undefined,
	env: Record<string, string | undefined>,
	envName: string,
	defaultValue: string | undefined,
	key: string,
	normalize?: (value: string) => T,
	commentKv?: CommentKvLayer<T>,
	config?: Record<string, string | undefined>,
): ResolvedSetting<T> | undefined {
	if (explicit !== undefined) {
		return {
			value: normalize ? normalize(explicit) : (explicit as T),
			source: {
				kind:
					key === "host" && defaultValue === undefined
						? "target-input"
						: "explicit",
				key,
			},
		};
	}

	const envValue = env[envName];
	if (envValue !== undefined) {
		return {
			value: normalize ? normalize(envValue) : (envValue as T),
			source: { kind: "env", key: envName },
		};
	}

	if (commentKv !== undefined) {
		return commentKv;
	}

	const configValue = config?.[envName];
	if (configValue !== undefined) {
		return {
			value: normalize ? normalize(configValue) : (configValue as T),
			source: { kind: "config", key: envName },
		};
	}

	if (defaultValue !== undefined) {
		return {
			value: normalize ? normalize(defaultValue) : (defaultValue as T),
			source: {
				kind: key === "host" ? "target-input" : "default",
				key,
			},
		};
	}

	return undefined;
}

/**
 * Resolve a boolean-valued setting. Order: explicit → env → comment-kv →
 * config → default.
 */
export function resolveBooleanSetting(
	explicit: boolean | undefined,
	env: Record<string, string | undefined>,
	envName: string,
	defaultValue: boolean,
	key: string,
	commentKv?: CommentKvLayer<boolean>,
	config?: Record<string, string | undefined>,
): ResolvedSetting<boolean> {
	if (explicit !== undefined) {
		return { value: explicit, source: { kind: "explicit", key } };
	}

	const envValue = env[envName];
	if (envValue !== undefined) {
		return {
			value: parseBoolean(envValue, envName),
			source: { kind: "env", key: envName },
		};
	}

	if (commentKv !== undefined) {
		return commentKv;
	}

	const configValue = config?.[envName];
	if (configValue !== undefined) {
		return {
			value: parseBoolean(configValue, envName),
			source: { kind: "config", key: envName },
		};
	}

	return { value: defaultValue, source: { kind: "default", key } };
}

/**
 * Resolve an optional positive-integer setting (no built-in default). Order:
 * explicit → env → comment-kv → config → unset.
 */
export function resolveOptionalIntegerSetting(
	explicit: number | undefined,
	env: Record<string, string | undefined>,
	envName: string,
	key: string,
	commentKv?: CommentKvLayer<number>,
	config?: Record<string, string | undefined>,
): ResolvedSetting<number> | undefined {
	if (explicit !== undefined) {
		if (!Number.isInteger(explicit) || explicit <= 0) {
			throw new CentrsError({
				code: "settings/invalid-integer",
				summary: `${key} must be a positive integer. Received: ${explicit}`,
				remediation: `Pass a positive integer for ${key}.`,
			});
		}
		return { value: explicit, source: { kind: "explicit", key } };
	}

	const envValue = env[envName];
	if (envValue !== undefined) {
		const parsed = Number.parseInt(envValue, 10);
		if (!Number.isInteger(parsed) || parsed <= 0) {
			throw new CentrsError({
				code: "settings/invalid-integer",
				summary: `${envName} must be a positive integer. Received: ${envValue}`,
				remediation: `Set ${envName} to a positive integer value.`,
			});
		}
		return { value: parsed, source: { kind: "env", key: envName } };
	}

	if (commentKv !== undefined) {
		return commentKv;
	}

	const configValue = config?.[envName];
	if (configValue !== undefined) {
		const parsed = Number.parseInt(configValue, 10);
		if (!Number.isInteger(parsed) || parsed <= 0) {
			throw new CentrsError({
				code: "settings/invalid-integer",
				summary: `${envName} must be a positive integer. Received: ${configValue}`,
				remediation: `Set ${envName} to a positive integer value in centrs.env.`,
			});
		}
		return { value: parsed, source: { kind: "config", key: envName } };
	}

	return undefined;
}

export function parseBoolean(value: string, settingName: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}

	throw new CentrsError({
		code: "settings/invalid-boolean",
		summary: `${settingName} must be a boolean-like value. Received: ${value}`,
		remediation: "Use one of: true/false, yes/no, on/off, or 1/0.",
	});
}

export function parseDuration(value: string): number {
	const trimmed = value.trim();
	const match = /^(\d+)(ms|s|m)?$/i.exec(trimmed);
	if (!match) {
		throw new CentrsError({
			code: "settings/invalid-timeout",
			summary: `Unsupported timeout value: ${value}`,
			remediation:
				"Use an integer number of milliseconds or a suffix like `500ms`, `5s`, or `1m`.",
		});
	}

	const numeric = Number.parseInt(match[1] ?? "0", 10);
	const unit = (match[2] ?? "ms").toLowerCase();
	switch (unit) {
		case "ms":
			return numeric;
		case "s":
			return numeric * 1000;
		case "m":
			return numeric * 60_000;
		default:
			return numeric;
	}
}
