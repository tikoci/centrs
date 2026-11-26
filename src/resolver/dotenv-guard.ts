/**
 * Undo Bun's working-directory `.env` auto-load for `CENTRS_*` keys (#666).
 *
 * Bun loads `.env` files from the current working directory into
 * `process.env` for any script it runs, so the installed `centrs` (a
 * `#!/usr/bin/env bun` script) run inside a cloned repo would take that repo's
 * `CENTRS_INSECURE`, `CENTRS_CDB_FILE`, `CENTRS_*_FILE` and so on as if the
 * caller had exported them. centrs reads settings only from flags, the process
 * environment, `centrs.env` and the CDB, so the CLI entry strips those keys
 * before any setting is resolved.
 *
 * Bun 1.4.4 loads, from the working directory only (no walk up): `.env`,
 * `.env.<mode>`, `.env.<mode>.local` and, except when `NODE_ENV=test`,
 * `.env.local`. `<mode>` is `production` or `test` when `NODE_ENV` says so,
 * else `development`. The shell's own value always wins over a file's.
 *
 * Which keys are dropped: a `CENTRS_*` key that one of those files names and
 * that the process did not start with. On Linux, `/proc/self/environ` holds
 * the environment the process was exec'd with, which Bun's load does not
 * touch, so a key exported by the shell with the same value is kept. Where it
 * cannot be read (macOS, Windows, a locked-down `/proc`), any `CENTRS_*` key a
 * loaded file names is dropped: a shell export of the same key is then lost
 * too, which fails safe (unset, never a value the repo chose), and the warning
 * names it. Keys are matched by name only, so no `.env` value parser can drift
 * from Bun's (quotes, `$VAR` expansion, multi-line values).
 *
 * A changed shebang (`env -S bun --no-env-file`) would do this without code,
 * but BusyBox `env` has no `-S` (Alpine, `oven/bun:alpine`), and Windows bin
 * shims pick the interpreter from the shebang.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const CENTRS_PREFIX = "CENTRS_";
const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/;

/** The `.env` file names Bun auto-loads from the working directory. */
export function bunDotenvFileNames(nodeEnv: string | undefined): string[] {
	const mode =
		nodeEnv === "production" || nodeEnv === "test" ? nodeEnv : "development";
	const names = [".env", `.env.${mode}`, `.env.${mode}.local`];
	if (mode !== "test") names.push(".env.local");
	return names;
}

/** Key names assigned in a dotenv text (values are never parsed). */
export function dotenvKeyNames(text: string): Set<string> {
	const keys = new Set<string>();
	for (const line of text.split(/\r?\n/)) {
		const match = KEY_LINE.exec(line);
		if (match?.[1]) keys.add(match[1]);
	}
	return keys;
}

/** The exec-time environment from `/proc/self/environ`, or `undefined`. */
export function readInitialEnviron(
	path = "/proc/self/environ",
): Map<string, string> | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const environ = new Map<string, string>();
	for (const entry of raw.split("\0")) {
		const separator = entry.indexOf("=");
		if (separator > 0) {
			environ.set(entry.slice(0, separator), entry.slice(separator + 1));
		}
	}
	return environ;
}

export interface DotenvGuardOptions {
	/** The map to strip in place. Default: `process.env`. */
	env?: Record<string, string | undefined>;
	/** Directory Bun loaded `.env` files from. Default: `process.cwd()`. */
	cwd?: string;
	/**
	 * The exec-time environment; `null` means unknown. Default: read
	 * `/proc/self/environ`.
	 */
	initialEnviron?: Map<string, string> | null;
}

export interface DotenvGuardResult {
	/** `CENTRS_*` keys removed from `env`, sorted. Never their values. */
	ignored: string[];
	/** The `.env` file names that named a removed key. */
	files: string[];
}

/**
 * Remove from `env` every `CENTRS_*` key that Bun's working-directory `.env`
 * auto-load supplied. Never throws; an unreadable file is skipped.
 */
export function stripBunDotenvKeys(
	options: DotenvGuardOptions = {},
): DotenvGuardResult {
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const initial =
		options.initialEnviron === undefined
			? readInitialEnviron()
			: (options.initialEnviron ?? undefined);
	const ignored = new Set<string>();
	const files: string[] = [];
	for (const name of bunDotenvFileNames(env["NODE_ENV"])) {
		let text: string;
		try {
			text = readFileSync(join(cwd, name), "utf8");
		} catch {
			continue;
		}
		let named = false;
		for (const key of dotenvKeyNames(text)) {
			if (!key.startsWith(CENTRS_PREFIX)) continue;
			const value = env[key];
			if (value === undefined) continue;
			if (initial !== undefined && initial.get(key) === value) continue;
			delete env[key];
			ignored.add(key);
			named = true;
		}
		if (named) files.push(name);
	}
	return { ignored: [...ignored].sort(), files };
}

/** The one-line stderr warning for a non-empty {@link DotenvGuardResult}. */
export function dotenvGuardWarning(result: DotenvGuardResult): string {
	return `warning [settings/dotenv-ignored]: ignored ${result.ignored.join(", ")} from the working directory's ${result.files.join(", ")} (Bun loads it; centrs does not read it). Export the key in the shell, pass the flag, or use \`centrs settings\`.`;
}
