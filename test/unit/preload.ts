/**
 * `bunfig.toml` `[test]` preload: a hermetic HOME for the unit tier (#550).
 *
 * Unit tests must never see a developer's real `~/.config/tikoci/centrs.env`
 * or WinBox CDB. Resolution entry points default their `env` map to
 * `Bun.env`, so without this every CLI-shaped unit test — and every
 * `retrieve({...})` without an explicit env — resolves the real files.
 * Pointing HOME and XDG_CONFIG_HOME at a fresh empty directory keeps those
 * ambient paths hermetic (and keeps an accidental default-path write in the
 * sandbox instead of the developer's home).
 *
 * No-op when CHR integration is enabled: integration boots real CHR VMs and
 * keeps the real HOME. Suites that inject their own env map (e.g. `{}`)
 * bypass `Bun.env` entirely and fall back to `os.homedir()`, which Bun
 * resolves at startup, so this cannot redirect them; those suites use the
 * shared `HERMETIC_ENV` fixture (`./hermetic-env.ts`) with an explicit
 * nonexistent HOME instead.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isChrIntegrationEnabled } from "../integration/chr.ts";

if (!isChrIntegrationEnabled()) {
	const sandbox = mkdtempSync(join(tmpdir(), "centrs-unit-home-"));
	process.env["HOME"] = sandbox;
	process.env["XDG_CONFIG_HOME"] = join(sandbox, ".config");
}
