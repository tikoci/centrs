/**
 * CHR image-cache key component — the RouterOS version a channel will boot.
 *
 * `actions/cache` only *writes* an entry when its exact `key` missed. A static
 * key (`chr-cache-Linux-stable-v1`) therefore freezes the first image it ever
 * saw: when MikroTik ships a point release, the restore still hits the stale
 * key, the new image is downloaded from download.mikrotik.com on **every** job,
 * and the fresh download is never persisted. That is what turned the 2026-09-15
 * `stable` bump (7.24.2 → 7.24.3) into a 186 s in-test download and timed out
 * `chr-smoke.test.ts` (run 34997014684, GH#352).
 *
 * Putting the resolved version in the key makes the cache self-rotating: a new
 * point release misses, downloads once, and saves; every later run hits.
 *
 * Resolution reuses the same quickchr channel→version map the QA matrix axis
 * reads (`resolveChannelPlan`), so the key names the build the job actually
 * boots. It degrades the same way, too: a network failure prints `unresolved`
 * rather than failing the job — the key then behaves like the static one it
 * replaces (a stale-but-valid restore, no save), which is never worse than a
 * red job over a cache miss.
 *
 * CLI (used by `.github/workflows/ci.yaml` and `qa.yaml`):
 *   bun run scripts/chr-cache-key.ts --channel <stable|long-term|testing|development>
 *     [--version <version>]
 *
 * An explicit `--version` pins the leg (qa.yaml's `routeros_version` dispatch
 * input), so it is the key with no resolve at all. Both forms go through the
 * same {@link cacheSafe} filter, because the printed value lands in a cache key
 * and in `$GITHUB_OUTPUT` — a workflow input must not be able to write either.
 *
 * Prints the version to stdout and, when `$GITHUB_OUTPUT` is set, appends it
 * there as `version=<value>`.
 */

import { appendFile } from "node:fs/promises";
import {
	isConcreteChannel,
	type QuickChrVersionApi,
	resolveChannelPlan,
} from "./qa-active-channels.ts";

/** Printed when the channel→version map cannot be resolved (see the module doc). */
export const UNRESOLVED = "unresolved";

/**
 * A RouterOS version is `7.25beta4`-shaped; anything past this is not one, and
 * a cache key has a 512-character ceiling that a long `routeros_version`
 * dispatch input could otherwise blow (which fails the cache step outright).
 */
const MAX_VERSION_LENGTH = 32;

/**
 * Reduce a version to the characters a cache key may carry, so a suffixed build
 * (`7.25beta4`) stays readable and nothing else — a comma, a newline, an
 * `$GITHUB_OUTPUT` directive — can reach the key. Over-long input is truncated
 * to {@link MAX_VERSION_LENGTH}; an empty result degrades to {@link UNRESOLVED}
 * rather than an empty key component.
 */
export function cacheSafe(version: string): string {
	const safe = version.replace(/[^0-9A-Za-z.-]/g, "");
	return safe.length > 0 ? safe.slice(0, MAX_VERSION_LENGTH) : UNRESOLVED;
}

/** The version `channel` currently resolves to, or {@link UNRESOLVED}. */
export async function channelCacheVersion(
	channel: string,
	load?: () => Promise<QuickChrVersionApi>,
): Promise<string> {
	if (!isConcreteChannel(channel)) return UNRESOLVED;
	const plan = await resolveChannelPlan(load);
	const version = plan?.statuses.find((s) => s.channel === channel)?.version;
	return version ? cacheSafe(version) : UNRESOLVED;
}

function flag(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

export async function main(args: readonly string[]): Promise<number> {
	const pinned = (flag(args, "--version") ?? "").trim();
	const version = pinned
		? cacheSafe(pinned)
		: await channelCacheVersion((flag(args, "--channel") ?? "").trim());
	const outputPath = Bun.env["GITHUB_OUTPUT"];
	if (outputPath) {
		await appendFile(outputPath, `version=${version}\n`);
	}
	console.log(version);
	return 0;
}

if (import.meta.main) {
	main(Bun.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(`::error title=CHR cache key::${String(error)}`);
			process.exit(1);
		});
}
