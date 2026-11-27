/**
 * `bunfig.toml` `[test] preload`: cache the selected CHR image before any test
 * starts, so a cold-cache download never counts against a test's timeout
 * (#468). One shared hook covers direct `bun test test/integration/<file>.ts`
 * runs, which skip the package scripts.
 *
 * No-op unless CHR integration is enabled. Best-effort: a failure here prints a
 * warning and the run goes on, because a file that never boots a CHR must not
 * fail over a download it doesn't need. A test that does boot one then reports
 * the real error from `QuickCHR.start`. `bun run chr:prefetch` is the strict
 * twin that CI runs as its own step.
 *
 * It also registers the one global `afterAll` that removes the process's
 * shared CHR (#612, `chr-reuse.ts`). A hook defined in a preload runs once,
 * after the last file of the `bun test` process, whether that process runs one
 * file (the QA loop) or the whole directory (`bun run test:integration`).
 *
 * And it gives the tier a hermetic HOME (#654), the integration twin of
 * `test/unit/preload.ts`: an encrypted CDB or a `centrs.env` in the
 * developer's real `~/.config/tikoci`, or one exported as `CENTRS_CDB_FILE`,
 * must not reach a test. quickchr keeps its
 * image cache and machine state under HOME, so its data dir is pinned to the
 * real path first; otherwise every run would download a fresh image into the
 * sandbox, and its sockets would outgrow the 108-byte Unix path limit.
 * `Bun.env`, `runCli` and child processes (`cli-process.ts` passes
 * `process.env` down) all see the sandbox. Bun fixes `os.homedir()` at
 * startup, so a test that hands centrs its own env map must still include a
 * HOME — use `HERMETIC_ENV` (`../unit/hermetic-env.ts`), never a bare `{}`.
 */

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prefetch } from "../../scripts/chr-prefetch.ts";
import { disposeProcessChrReuse, isChrIntegrationEnabled } from "./chr.ts";

if (isChrIntegrationEnabled()) {
	// quickchr's own rule (`getDataDir` in its `state.ts`, not exported):
	// QUICKCHR_DATA_DIR, else the local app-data dir on Windows, else
	// HOME || USERPROFILE.
	if (!process.env["QUICKCHR_DATA_DIR"] && process.platform !== "win32") {
		process.env["QUICKCHR_DATA_DIR"] = join(
			process.env["HOME"] || process.env["USERPROFILE"] || "",
			".local",
			"share",
			"quickchr",
		);
	}
	const sandbox = mkdtempSync(join(tmpdir(), "centrs-int-home-"));
	process.env["HOME"] = sandbox;
	process.env["XDG_CONFIG_HOME"] = join(sandbox, ".config");
	// A shell-exported CDB choice would reach the developer's CDB past the
	// sandbox. Tests that need a CDB pass `--cdb-file` / `cdbFile` themselves.
	for (const key of [
		"CENTRS_CDB_FILE",
		"CENTRS_CDB_PASSWORD",
		"CENTRS_CDB_PASSWORD_FILE",
	])
		delete process.env[key];

	try {
		console.error(await prefetch());
	} catch (error) {
		console.error(
			`CHR prefetch failed; the first CHR boot will retry it: ${String(error)}`,
		);
	}

	afterAll(async () => {
		await disposeProcessChrReuse();
		rmSync(sandbox, { recursive: true, force: true });
	}, 120_000);
}
