/**
 * Cache the CHR image the integration tests will boot, before any test runs
 * (#468). Reads the same env as the harness (`CENTRS_CHR_VERSION`,
 * `CENTRS_CHR_CHANNEL`, `CENTRS_CHR_ARCH`) through `integrationChrSelection`,
 * so it cannot fetch a different build from the one the tests boot.
 *
 * CLI (the `Pre-fetch CHR image` step in ci.yaml, qa.yaml, verify-extended.yaml):
 *   bun run chr:prefetch
 *
 * Fails the step on any error: a CI leg that can't get its image can't test.
 * The bunfig preload (`test/integration/preload.ts`) is the best-effort twin
 * for local `bun test` runs.
 */

import {
	integrationChrSelection,
	prefetchIntegrationChrImage,
} from "../test/integration/chr.ts";

/** One line naming what was asked for and what it resolved to. */
export function describePrefetch(
	selection: ReturnType<typeof integrationChrSelection>,
	result: { version: string; arch: string; cacheHit: boolean },
	elapsedMs: number,
): string {
	const asked = selection.version
		? `version ${selection.version}`
		: `channel ${selection.channel}`;
	const how = result.cacheHit
		? "already cached"
		: `downloaded in ${(elapsedMs / 1000).toFixed(1)}s`;
	return `CHR prefetch: ${asked} -> ${result.version} (${result.arch}), ${how}`;
}

export async function prefetch(
	env: Record<string, string | undefined> = Bun.env,
): Promise<string> {
	const started = performance.now();
	const result = await prefetchIntegrationChrImage(env);
	return describePrefetch(
		integrationChrSelection(env),
		result,
		performance.now() - started,
	);
}

if (import.meta.main) {
	prefetch()
		.then((line) => console.log(line))
		.catch((error) => {
			console.error(`::error title=CHR prefetch::${String(error)}`);
			process.exit(1);
		});
}
