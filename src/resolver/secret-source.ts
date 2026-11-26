/**
 * One resolver for "a secret given as a value or as a file" (#672), shared by
 * the CDB key and the target password, on the CLI, MCP and the library.
 *
 * Each secret has one source per tier. Flags outrank the environment, as for
 * every setting. Within one tier the value and the file form are one choice:
 * setting both (`--password` with `--password-file`, or `CENTRS_PASSWORD`
 * with `CENTRS_PASSWORD_FILE`) is `usage/conflicting-flags`, never a silent
 * precedence. The later password-command form becomes one more case here.
 *
 * A `*_FILE` path comes only from a flag or the process environment, never
 * `centrs.env` (its loader drops the keys) or a workspace file; the CLI also
 * strips a working-directory `.env`'s keys first (#666). An empty env value
 * counts as unset, so an image-wide default can be blanked per run.
 *
 * The file is read when the secret is needed, not when it is chosen, so a
 * rotated or deleted file takes effect on the next CDB load. Errors name the
 * path, never the contents. No permission check: `/run/secrets` modes vary,
 * and on RouterOS they mean nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import type { SettingSource } from "../core/envelope.ts";
import {
	decodePasswordBytes,
	passwordBytesReason,
} from "../core/password-bytes.ts";
import { CentrsError, type CentrsErrorCode } from "../errors.ts";

export interface SecretSpec {
	/** Words for messages: "CDB password", "password". */
	label: string;
	valueFlag: string;
	fileFlag: string;
	envKey: string;
	fileEnvKey: string;
	/** The error when a chosen file cannot give a password. */
	unavailableCode: CentrsErrorCode;
}

export const CDB_PASSWORD_SECRET: SecretSpec = {
	label: "CDB password",
	valueFlag: "--cdb-password",
	fileFlag: "--cdb-password-file",
	envKey: "CENTRS_CDB_PASSWORD",
	fileEnvKey: "CENTRS_CDB_PASSWORD_FILE",
	unavailableCode: "cdb/password-unavailable",
};

export const TARGET_PASSWORD_SECRET: SecretSpec = {
	label: "password",
	valueFlag: "--password",
	fileFlag: "--password-file",
	envKey: "CENTRS_PASSWORD",
	fileEnvKey: "CENTRS_PASSWORD_FILE",
	unavailableCode: "auth/password-unavailable",
};

export type SecretChoice =
	| { kind: "value"; value: string; source: SettingSource }
	| { kind: "file"; path: string; source: SettingSource };

/**
 * Pick the secret's source: flags, then the environment. Throws
 * `usage/conflicting-flags` when one tier sets both forms.
 */
export function chooseSecret(
	spec: SecretSpec,
	explicit: { value?: string; file?: string },
	env: Record<string, string | undefined>,
): SecretChoice | undefined {
	if (explicit.value !== undefined && explicit.file !== undefined) {
		throw conflict(spec, [spec.valueFlag, spec.fileFlag]);
	}
	if (explicit.file !== undefined) {
		return {
			kind: "file",
			path: explicit.file,
			source: { kind: "file", key: spec.fileFlag },
		};
	}
	if (explicit.value !== undefined) {
		return {
			kind: "value",
			value: explicit.value,
			source: { kind: "cli", key: spec.valueFlag },
		};
	}
	const envValue = env[spec.envKey];
	const envFile = env[spec.fileEnvKey];
	const hasEnvFile = envFile !== undefined && envFile !== "";
	if (envValue !== undefined && hasEnvFile) {
		throw conflict(spec, [spec.envKey, spec.fileEnvKey]);
	}
	if (hasEnvFile) {
		return {
			kind: "file",
			path: envFile,
			source: { kind: "file", key: spec.fileEnvKey },
		};
	}
	if (envValue !== undefined) {
		return {
			kind: "value",
			value: envValue,
			source: { kind: "env", key: spec.envKey },
		};
	}
	return undefined;
}

function conflict(spec: SecretSpec, names: [string, string]): CentrsError {
	return new CentrsError({
		code: "usage/conflicting-flags",
		summary: `${names[0]} and ${names[1]} both set the ${spec.label}; give one.`,
		remediation: `Keep one source for the ${spec.label}: the value (${names[0]}) or a file holding it (${names[1]}).`,
		context: { flags: names },
	});
}

/** True when the path names an existing file (never reads it). */
export function secretFileExists(path: string): boolean {
	return existsSync(path);
}

/**
 * Read a password from the chosen file. Strips one trailing newline, as
 * `--password-stdin` does. A missing, unreadable, empty or non-UTF-8 file
 * throws the spec's `unavailableCode`, naming the path and never the bytes.
 */
export function readSecretFile(
	spec: SecretSpec,
	choice: Extract<SecretChoice, { kind: "file" }>,
): string {
	const where = choice.source.key ?? spec.fileFlag;
	let raw: Uint8Array;
	try {
		raw = readFileSync(choice.path);
	} catch (cause) {
		const errno =
			typeof cause === "object" && cause !== null && "code" in cause
				? String((cause as { code: unknown }).code)
				: undefined;
		throw unavailable(
			spec,
			choice,
			where,
			errno === "ENOENT" ? "does not exist" : "could not be read",
			{ ...(errno ? { errno } : {}) },
		);
	}
	const decoded = decodePasswordBytes(raw);
	if (decoded.ok) return decoded.value;
	throw unavailable(
		spec,
		choice,
		where,
		`holds ${passwordBytesReason(decoded.reason)}`,
		{ byteLength: decoded.byteLength },
	);
}

function unavailable(
	spec: SecretSpec,
	choice: Extract<SecretChoice, { kind: "file" }>,
	where: string,
	what: string,
	extra: Record<string, unknown>,
): CentrsError {
	return new CentrsError({
		code: spec.unavailableCode,
		summary: `The ${spec.label} file ${choice.path} (from ${where}) ${what}.`,
		remediation: `Whoever launched centrs set ${where}: check that ${choice.path} exists, is readable by this process and holds the ${spec.label} as UTF-8 (one trailing newline is ignored), or unset ${where}. On a container, check that the secret is mounted.`,
		context: { path: choice.path, source: where, ...extra },
	});
}
