/**
 * `centrs.env` — the user-global config-file precedence tier (constitution:
 * "Settings precedence", `default < config < comment-kv < env < cli`).
 *
 * Two read paths, deliberately kept separate:
 *
 * - {@link loadEnvFileDefaults} is what every *other* command calls to pick
 *   up the `config` tier. It honors `CENTRS_SKIP_ENV_FILE` (returns `{}` when
 *   set) and is safe to call unconditionally once per invocation.
 * - {@link readSettingsFileRaw} is what the `settings` command itself calls.
 *   `settings` always inspects/edits the real file regardless of
 *   `--skip-env-file` — that flag controls whether *other* commands see the
 *   file's values, not whether `settings` can see the file.
 *
 * The path resolver takes an injectable `env` map (mirroring
 * `defaultCdbPath` in `src/devices.ts`) so tests can point
 * `XDG_CONFIG_HOME` at a per-test temp directory instead of touching a real
 * user's `~/.config`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { parseBoolean, REFUSED_CONFIG_ENV_KEYS } from "./settings.ts";

const ENV_XDG_CONFIG_HOME = "XDG_CONFIG_HOME";
const ENV_HOME = "HOME";
const ENV_SKIP_ENV_FILE = "CENTRS_SKIP_ENV_FILE";
const CONFIG_RELATIVE_DIR = "tikoci";
const CONFIG_FILE_NAME = "centrs.env";

/**
 * Resolve `${XDG_CONFIG_HOME:-~/.config}/tikoci/centrs.env`. This is a
 * deliberately different base-path convention from `defaultCdbPath`'s
 * `$HOME`-only scheme — the constitution and the settings spec already
 * commit to XDG for this file specifically.
 */
export function defaultSettingsPath(
	env?: Record<string, string | undefined>,
): string {
	const xdgConfigHome = env?.[ENV_XDG_CONFIG_HOME];
	const configHome =
		xdgConfigHome && xdgConfigHome.length > 0
			? xdgConfigHome
			: join(env?.[ENV_HOME] ?? homedir(), ".config");
	return join(configHome, CONFIG_RELATIVE_DIR, CONFIG_FILE_NAME);
}

function isSkippingEnvFile(env: Record<string, string | undefined>): boolean {
	const raw = env[ENV_SKIP_ENV_FILE];
	if (raw === undefined) {
		return false;
	}
	try {
		return parseBoolean(raw, ENV_SKIP_ENV_FILE);
	} catch {
		return false;
	}
}

export interface SettingsFileContents {
	readonly exists: boolean;
	/** Every non-blank, non-comment line verbatim, in file order. */
	readonly lines: readonly string[];
}

/**
 * Raw line-level read, no `CENTRS_SKIP_ENV_FILE` short-circuit. Used by
 * `settings` itself, which must always see the real file.
 */
export async function readSettingsFileRaw(
	path: string,
): Promise<SettingsFileContents> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return { exists: false, lines: [] };
	}
	const text = await file.text();
	return { exists: true, lines: text.split("\n") };
}

/**
 * Parse `CENTRS_*=value` lines into a flat map. Blank lines and `#`
 * comments are ignored; a later duplicate key wins. Malformed lines
 * (no `=`, or a key that isn't a bare identifier) are silently skipped —
 * a hand-edited file with foreign content should not fail every other
 * command's settings resolution.
 */
export function parseEnvFileDefaults(
	lines: readonly string[],
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) {
			continue;
		}
		const separatorIndex = line.indexOf("=");
		if (separatorIndex <= 0) {
			continue;
		}
		const key = line.slice(0, separatorIndex).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			continue;
		}
		result[key] = line.slice(separatorIndex + 1).trim();
	}
	return result;
}

/**
 * The `config` tier every command resolver call should pass through. Empty
 * (`{}`) when the file is absent or `CENTRS_SKIP_ENV_FILE` is active — never
 * throws, since a missing or foreign-content file is not an error for
 * anything but `settings` itself.
 *
 * Credential/self-referential keys ({@link REFUSED_CONFIG_ENV_KEYS}) are
 * stripped even if a hand-edited file contains them: most resolvers already
 * never consult `config` for these, but dropping them here means the shared
 * `config` map itself never carries a secret, rather than relying on every
 * call site to keep excluding it. `parseEnvFileDefaults` is left unfiltered
 * so `settings print --all` can still inspect/redact a hand-added line.
 */
export async function loadEnvFileDefaults(
	env: Record<string, string | undefined> = Bun.env,
): Promise<Record<string, string>> {
	if (isSkippingEnvFile(env)) {
		return {};
	}
	const path = defaultSettingsPath(env);
	const { lines } = await readSettingsFileRaw(path);
	const parsed = parseEnvFileDefaults(lines);
	for (const key of REFUSED_CONFIG_ENV_KEYS) {
		delete parsed[key];
	}
	return parsed;
}
