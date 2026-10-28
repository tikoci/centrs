/**
 * Shared hermetic env fixture for unit suites that inject an `env` map into
 * settings/CDB resolution (#550).
 *
 * Resolution entry points take a closed-world env map: a key the map omits
 * falls back to `os.homedir()`, which Bun resolves from the startup HOME —
 * so a bare `{}` reads the developer's real `~/.config/tikoci/centrs.env`
 * and WinBox CDB. `HERMETIC_ENV` points HOME at a path that never exists
 * (starving both the config-file and CDB tiers at the source) and sets
 * `CENTRS_SKIP_ENV_FILE` so the config tier stays skipped even if a future
 * path scheme stops deriving from HOME. Extend per test with a spread
 * (`{ ...HERMETIC_ENV, CENTRS_PASSWORD: "x" }`), never by mutation.
 */
export const HERMETIC_ENV: Record<string, string | undefined> = {
	CENTRS_SKIP_ENV_FILE: "1",
	HOME: "/nonexistent-centrs-550",
};
