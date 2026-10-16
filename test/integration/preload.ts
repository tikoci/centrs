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
 */

import { prefetch } from "../../scripts/chr-prefetch.ts";
import { isChrIntegrationEnabled } from "./chr.ts";

if (isChrIntegrationEnabled()) {
	try {
		console.error(await prefetch());
	} catch (error) {
		console.error(
			`CHR prefetch failed; the first CHR boot will retry it: ${String(error)}`,
		);
	}
}
