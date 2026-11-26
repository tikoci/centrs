/**
 * Keep a working directory's `.env` out of centrs (#666).
 *
 * Bun loads `.env` files from the current working directory into
 * `process.env` for any script it runs, so the installed `centrs` (a
 * `#!/usr/bin/env bun` script) run inside a cloned repo would take that repo's
 * settings as if the caller had exported them. Removing the keys in-process
 * is not enough, as measured on Bun 1.4.4:
 *
 * - Bun reads some of its own settings at startup, before any script runs. A
 *   repo's `BUN_CONFIG_VERBOSE_FETCH=curl` makes every `fetch` print its
 *   headers, a REST Basic credential included, and deleting the key later
 *   does not turn that off.
 * - Keys outside `CENTRS_*` steer centrs too: `XDG_CONFIG_HOME` picks which
 *   `centrs.env` is read.
 * - A file's `NODE_ENV` changes which other files a later scan would check,
 *   though Bun had already chosen them; and Bun accepts `KEY: value` and
 *   CR-only lines.
 *
 * So the CLI and MCP entries re-launch themselves once with
 * `bun --no-env-file`, giving the child the environment centrs was started
 * with. `process.execArgv` shows the flag, so the child does not re-launch,
 * and a `.env` file cannot fake it. On Linux, `/proc/self/environ` holds the
 * exec-time environment, which Bun's load does not touch: the child gets
 * exactly that, and the re-launch happens only when the two differ.
 * Elsewhere, every key that a `.env` file Bun may load names is dropped,
 * except the Windows system variables, which Windows always sets (so the
 * shell's value beats the file's). A named `PATH` is reset to the system
 * default search path rather than dropped. Keys are matched by name, never
 * by parsing values, so no `.env` parser here can drift from Bun's.
 *
 * A changed shebang (`env -S bun --no-env-file`) would do this without a
 * second process, but BusyBox `env` has no `-S` (Alpine, `oven/bun:alpine`),
 * and Windows bin shims pick the interpreter from the shebang.
 */

import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

const NO_ENV_FILE = "--no-env-file";

/**
 * Every `.env` file name Bun 1.4.4 may auto-load from the working directory:
 * `.env`, `.env.<mode>`, `.env.<mode>.local` and `.env.local`, for every
 * mode. All of them, whatever `NODE_ENV` says now: a file can change
 * `NODE_ENV` after Bun has picked the set.
 */
export const BUN_DOTENV_FILE_NAMES: readonly string[] = [
	".env",
	".env.local",
	".env.development",
	".env.development.local",
	".env.production",
	".env.production.local",
	".env.test",
	".env.test.local",
];

/**
 * Variables a `.env` may name that the fallback still keeps: Windows always
 * sets them (so the shell's value wins over the file's), and a Windows child
 * may not start without them. Nothing else is kept, not even `HOME`,
 * `USERPROFILE` or `APPDATA`: without `/proc` there is no telling a
 * launch-time value from a file's, a Windows shell often has no `HOME`, and
 * `HOME` picks which `centrs.env` is read. A dropped one falls back to the
 * account's home directory (`os.homedir()`).
 */
const KEPT_OS_KEYS: ReadonlySet<string> = new Set([
	"PATHEXT",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
]);

/**
 * `PATH` is not kept: a service can start Bun by absolute path with no
 * `PATH`, and then a repo's `.env` would pick which `ssh` or `sftp` centrs
 * runs. Dropping it outright would break those lookups, so a named `PATH` is
 * reset to the system default, which has the OS's own `ssh`.
 */
function systemDefaultPath(
	platform: NodeJS.Platform,
	env: Record<string, string>,
): string {
	if (platform !== "win32") return "/usr/bin:/bin:/usr/sbin:/sbin";
	const root = envValue(env, "SYSTEMROOT", platform) ?? "C:\\Windows";
	return [
		`${root}\\System32`,
		root,
		`${root}\\System32\\Wbem`,
		`${root}\\System32\\WindowsPowerShell\\v1.0\\`,
		`${root}\\System32\\OpenSSH\\`,
	].join(";");
}

/** Environment names compare case-insensitively on Windows only. */
function sameKey(a: string, b: string, platform: NodeJS.Platform): boolean {
	return platform === "win32" ? a.toUpperCase() === b.toUpperCase() : a === b;
}

function envValue(
	env: Record<string, string>,
	key: string,
	platform: NodeJS.Platform,
): string | undefined {
	const found = Object.keys(env).find((name) => sameKey(name, key, platform));
	return found === undefined ? undefined : env[found];
}

/**
 * A key at the start of a line, then its `=` or `:`. Bun allows any
 * whitespace before the separator, line breaks and blank lines included
 * (`KEY` on one line, `= value` on the next), so the gap may span lines.
 * Over-matching (a value line that looks like an assignment) only drops a
 * key, which fails safe.
 */
const KEY_ASSIGNMENT =
	/(?:^|[\r\n])\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]/g;

/** Key names assigned in a dotenv text (`=` or `:`; LF, CRLF or CR lines). */
export function dotenvKeyNames(text: string): Set<string> {
	const keys = new Set<string>();
	for (const match of text.matchAll(KEY_ASSIGNMENT)) {
		if (match[1]) keys.add(match[1]);
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
	/** Default: `process.env`. */
	env?: Record<string, string | undefined>;
	/** Default: `process.cwd()`. */
	cwd?: string;
	/** Default: `process.execArgv`. */
	execArgv?: readonly string[];
	/** The exec-time environment; `null` means unknown. Default: `/proc`. */
	initialEnviron?: Map<string, string> | null;
	/** Default: `process.platform`. */
	platform?: NodeJS.Platform;
}

export interface DotenvRelaunchPlan {
	/** The environment to give the `--no-env-file` child. */
	env: Record<string, string>;
	/** Keys removed or reset, sorted. Never their values. */
	dropped: string[];
}

/**
 * Decide whether Bun's `.env` auto-load changed the environment, and if so,
 * what the re-launched child gets. `undefined`: run in this process.
 */
export function planDotenvRelaunch(
	options: DotenvGuardOptions = {},
): DotenvRelaunchPlan | undefined {
	const env = options.env ?? process.env;
	const execArgv = options.execArgv ?? process.execArgv;
	if (execArgv.includes(NO_ENV_FILE)) return undefined;
	const initial =
		options.initialEnviron === undefined
			? readInitialEnviron()
			: (options.initialEnviron ?? undefined);

	if (initial !== undefined) {
		const dropped = Object.keys(env).filter(
			(key) => env[key] !== undefined && initial.get(key) !== env[key],
		);
		if (dropped.length === 0) return undefined;
		return { env: Object.fromEntries(initial), dropped: dropped.sort() };
	}

	const cwd = options.cwd ?? process.cwd();
	const platform = options.platform ?? process.platform;
	const named = new Set<string>();
	for (const name of BUN_DOTENV_FILE_NAMES) {
		let text: string;
		try {
			text = readFileSync(join(cwd, name), "utf8");
		} catch {
			continue;
		}
		for (const key of dotenvKeyNames(text)) {
			named.add(platform === "win32" ? key.toUpperCase() : key);
		}
	}
	const isNamed = (key: string): boolean =>
		named.has(platform === "win32" ? key.toUpperCase() : key);
	const dropped = Object.keys(env).filter(
		(key) =>
			env[key] !== undefined &&
			isNamed(key) &&
			!KEPT_OS_KEYS.has(key.toUpperCase()),
	);
	if (dropped.length === 0) return undefined;
	const childEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && !dropped.includes(key)) childEnv[key] = value;
	}
	if (dropped.some((key) => sameKey(key, "PATH", platform))) {
		childEnv["PATH"] = systemDefaultPath(platform, childEnv);
	}
	return { env: childEnv, dropped: dropped.sort() };
}

/**
 * The stderr warning for a plan, naming the `CENTRS_*` keys ignored, and
 * `PATH` when the fallback reset it. A repo's other keys are normal and not
 * centrs's business, so they go unnamed.
 */
export function dotenvGuardWarning(
	plan: DotenvRelaunchPlan,
): string | undefined {
	const centrs = plan.dropped.filter((key) => key.startsWith("CENTRS_"));
	const path = plan.dropped.some((key) => key.toUpperCase() === "PATH");
	if (centrs.length === 0 && !path) return undefined;
	const ignored =
		centrs.length === 0
			? ""
			: `ignored ${centrs.join(", ")} from the working directory's .env files (Bun loads them; centrs does not read them). Export the key in the shell, pass the flag, or use \`centrs settings\`.`;
	const reset = path
		? "PATH is named in the working directory's .env files, so this run uses the system default PATH."
		: "";
	return `warning [settings/dotenv-ignored]: ${[ignored, reset].filter(Boolean).join(" ")}`;
}

/** The message a re-launched child sends when SIGINT reaches it. */
const SIGINT_SEEN = "centrs:dotenv-guard:sigint";

/**
 * How long the launcher waits for the child to report a SIGINT before
 * passing one on. A terminal's Ctrl-C reaches both processes at once; a
 * `kill -INT <pid>` reaches only the launcher.
 */
const SIGINT_RELAY_MS = 150;

/**
 * Re-run this script under `bun --no-env-file` with the plan's environment,
 * stdio inherited, and return the child's exit code. SIGTERM and SIGHUP are
 * passed on. SIGINT is passed on only when the child did not get it too:
 * centrs treats a second Ctrl-C as "exit now", so a doubled one would skip
 * a graceful cancel. The child reports its own SIGINT over an IPC channel.
 */
export async function relaunchWithoutDotenv(
	plan: DotenvRelaunchPlan,
): Promise<number> {
	let childSawSigintAt = Number.NEGATIVE_INFINITY;
	const child = Bun.spawn(
		[
			process.execPath,
			NO_ENV_FILE,
			...process.execArgv,
			Bun.main,
			...Bun.argv.slice(2),
		],
		{
			env: plan.env,
			stdio: ["inherit", "inherit", "inherit"],
			ipc(message) {
				if (message === SIGINT_SEEN) childSawSigintAt = performance.now();
			},
		},
	);
	const relaySigint = (): void => {
		const at = performance.now();
		setTimeout(() => {
			const running = child.exitCode === null && child.signalCode === null;
			if (running && childSawSigintAt < at - SIGINT_RELAY_MS) {
				child.kill("SIGINT");
			}
		}, SIGINT_RELAY_MS);
	};
	const handlers: [NodeJS.Signals, () => void][] = [
		["SIGINT", relaySigint],
		["SIGTERM", () => child.kill("SIGTERM")],
		["SIGHUP", () => child.kill("SIGHUP")],
	];
	for (const [signal, handler] of handlers) process.on(signal, handler);
	try {
		const code = await child.exited;
		const signal = child.signalCode;
		if (signal !== null && signal !== undefined) {
			const number =
				typeof signal === "number"
					? signal
					: constants.signals[signal as NodeJS.Signals];
			return number === undefined ? 1 : 128 + number;
		}
		return code;
	} finally {
		for (const [signal, handler] of handlers) process.off(signal, handler);
	}
}

/**
 * In a re-launched child: tell the launcher about each SIGINT, so it does not
 * pass on a second one. When no other listener handles it, re-raise it so
 * the default action (exit by signal) still applies.
 */
function reportSigintToLauncher(): void {
	if (typeof process.send !== "function") return;
	// The channel must not keep a finished command alive.
	(process.channel as { unref?: () => void } | undefined)?.unref?.();
	const onSigint = (): void => {
		process.send?.(SIGINT_SEEN);
		if (process.listenerCount("SIGINT") === 1) {
			process.off("SIGINT", onSigint);
			process.kill(process.pid, "SIGINT");
		}
	};
	process.on("SIGINT", onSigint);
}

/**
 * The CLI/MCP entry wrapper: re-launch without `.env` when Bun loaded one,
 * else run `main` here.
 */
export async function runWithoutDotenv(
	main: () => Promise<number>,
): Promise<number> {
	if (process.execArgv.includes(NO_ENV_FILE)) reportSigintToLauncher();
	const plan = planDotenvRelaunch();
	if (plan === undefined) return main();
	const warning = dotenvGuardWarning(plan);
	if (warning) console.error(warning);
	return relaunchWithoutDotenv(plan);
}
