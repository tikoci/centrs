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
 * except `PATH` and the Windows system variables, which the OS always sets
 * and whose shell value already beats the file's. Keys are matched by name, never by parsing
 * values, so no `.env` parser here can drift from Bun's.
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
 * Variables a `.env` may name that the fallback still keeps: the OS always
 * sets them (so the shell's value wins over the file's), and a child process
 * may not start or find `ssh` without them. Nothing else is kept, not even
 * `HOME`, `USERPROFILE` or `APPDATA`: without `/proc` there is no telling a
 * launch-time value from a file's, a Windows shell often has no `HOME`, and
 * `HOME` picks which `centrs.env` is read. A dropped one falls back to the
 * account's home directory (`os.homedir()`).
 */
const KEPT_OS_KEYS: ReadonlySet<string> = new Set([
	"PATH",
	"PATHEXT",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
]);

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]/;

/** Key names assigned in a dotenv text (`=` or `:`; LF, CRLF or CR lines). */
export function dotenvKeyNames(text: string): Set<string> {
	const keys = new Set<string>();
	for (const line of text.split(/\r\n|\r|\n/)) {
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
	/** Default: `process.env`. */
	env?: Record<string, string | undefined>;
	/** Default: `process.cwd()`. */
	cwd?: string;
	/** Default: `process.execArgv`. */
	execArgv?: readonly string[];
	/** The exec-time environment; `null` means unknown. Default: `/proc`. */
	initialEnviron?: Map<string, string> | null;
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
	const named = new Set<string>();
	for (const name of BUN_DOTENV_FILE_NAMES) {
		let text: string;
		try {
			text = readFileSync(join(cwd, name), "utf8");
		} catch {
			continue;
		}
		for (const key of dotenvKeyNames(text)) named.add(key);
	}
	const dropped = Object.keys(env).filter(
		(key) =>
			env[key] !== undefined &&
			named.has(key) &&
			!KEPT_OS_KEYS.has(key.toUpperCase()),
	);
	if (dropped.length === 0) return undefined;
	const childEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && !dropped.includes(key)) childEnv[key] = value;
	}
	return { env: childEnv, dropped: dropped.sort() };
}

/**
 * The stderr warning for a plan, naming the `CENTRS_*` keys ignored. A repo's
 * other keys are normal and not centrs's business, so they go unnamed.
 */
export function dotenvGuardWarning(
	plan: DotenvRelaunchPlan,
): string | undefined {
	const centrs = plan.dropped.filter((key) => key.startsWith("CENTRS_"));
	if (centrs.length === 0) return undefined;
	return `warning [settings/dotenv-ignored]: ignored ${centrs.join(", ")} from the working directory's .env files (Bun loads them; centrs does not read them). Export the key in the shell, pass the flag, or use \`centrs settings\`.`;
}

/**
 * Re-run this script under `bun --no-env-file` with the plan's environment,
 * stdio inherited, and return the child's exit code. A signal sent to this
 * process is passed on; a terminal's Ctrl-C already reaches both.
 */
export async function relaunchWithoutDotenv(
	plan: DotenvRelaunchPlan,
): Promise<number> {
	const child = Bun.spawn(
		[
			process.execPath,
			NO_ENV_FILE,
			...process.execArgv,
			Bun.main,
			...Bun.argv.slice(2),
		],
		{ env: plan.env, stdio: ["inherit", "inherit", "inherit"] },
	);
	const forward = (signal: NodeJS.Signals) => () => {
		// A terminal sends Ctrl-C to the whole process group; passing it on
		// would deliver it twice.
		if (signal === "SIGINT" && process.stdin.isTTY) return;
		child.kill(signal);
	};
	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
	const handlers = signals.map((signal) => {
		const handler = forward(signal);
		process.on(signal, handler);
		return [signal, handler] as const;
	});
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
 * The CLI/MCP entry wrapper: re-launch without `.env` when Bun loaded one,
 * else run `main` here.
 */
export async function runWithoutDotenv(
	main: () => Promise<number>,
): Promise<number> {
	const plan = planDotenvRelaunch();
	if (plan === undefined) return main();
	const warning = dotenvGuardWarning(plan);
	if (warning) console.error(warning);
	return relaunchWithoutDotenv(plan);
}
