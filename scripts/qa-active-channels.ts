/**
 * QA matrix axis — the recency-aware active channel set (B-2 / quickchr#3).
 *
 * `qa.yaml`'s CHR matrix used to hard-code `["stable","long-term","development"]`.
 * That had two blind spots: `testing` was never auto-sampled, and `development`
 * was booted even on the rare occasion it sits *behind* stable. The four RouterOS
 * channels are **not** monotonically ordered — `testing` can lag stable as a stale
 * rc and then leapfrog it; `development` is usually newest but not always — so the
 * "which channels are worth booting right now" decision must be computed from the
 * live channel→version map, not hard-coded.
 *
 * That recency knowledge is RouterOS-version domain knowledge, so it lives in
 * quickchr (`resolveAllVersions` / `selectActiveChannels`, suffix-aware
 * `compareRouterOsVersion`), not here. This script is the thin CI consumer: it
 * asks quickchr for the active set and maps it onto the GitHub Actions matrix axis.
 *
 * Boundary: quickchr answers "what's worth booting" (released channels always,
 * plus any pre-release at or ahead of stable). centrs answers "what must pass" —
 * the must-pass gate (released = stable + long-term) stays in `qa-results-db.ts`
 * (`MUST_PASS_CHANNELS` / `evaluateMustPassGate`) and the matrix
 * `continue-on-error`. A pre-release leg can be booted (active) yet never gate.
 *
 * quickchr is imported through a runtime specifier (as in `test/integration/chr.ts`)
 * so its shipped `.ts` source stays out of centrs's stricter `tsc --noEmit` graph;
 * the surface we use is mirrored in {@link QuickChrVersionApi} / {@link Channel}.
 *
 * CLI (used by `.github/workflows/qa.yaml`):
 *   bun run scripts/qa-active-channels.ts --requested-channel <ch|all|''> \
 *     [--summary "$GITHUB_STEP_SUMMARY"]
 *
 * A concrete channel (stable|long-term|testing|development) pins a single leg
 * (on-demand dispatch); "all" or "" (push, schedule, the release sweep) fans the
 * recency-aware active set. The chosen array is printed to stdout and, when
 * `$GITHUB_OUTPUT` is set, appended there as `channels=<json>` for the matrix.
 */

import { appendFile } from "node:fs/promises";
import { MUST_PASS_CHANNELS } from "./qa-results-db.ts";

export type Channel = "stable" | "long-term" | "testing" | "development";

export interface ChannelStatus {
	channel: Channel;
	version: string;
	maturity: "released" | "prerelease";
	aheadOfStable: boolean;
}

const CONCRETE_CHANNELS: readonly Channel[] = [
	"stable",
	"long-term",
	"testing",
	"development",
];

export function isConcreteChannel(value: string): value is Channel {
	return (CONCRETE_CHANNELS as readonly string[]).includes(value);
}

/**
 * Map a requested channel onto the matrix axis. A concrete channel pins a single
 * leg; anything else ("all", "") fans the recency-aware active set. The must-pass
 * floor is always merged in, so a degraded resolve (or a future divergence in
 * quickchr's released set) can never drop the channels that gate a merge.
 */
export function matrixChannels(
	requestedChannel: string,
	activeSet: readonly string[],
): string[] {
	if (isConcreteChannel(requestedChannel)) return [requestedChannel];
	return [...new Set<string>([...MUST_PASS_CHANNELS, ...activeSet])];
}

/** The slice of quickchr's public version/channel API this consumer uses. */
export interface QuickChrVersionApi {
	resolveAllVersions(): Promise<Record<Channel, string>>;
	classifyChannels(versions: Record<Channel, string>): ChannelStatus[];
	selectActiveChannels(
		versions: Record<Channel, string>,
		opts?: { aheadOf?: Channel },
	): Channel[];
}

async function loadQuickChr(): Promise<QuickChrVersionApi> {
	const moduleName = "@tikoci/quickchr";
	return (await import(moduleName)) as unknown as QuickChrVersionApi;
}

export interface ChannelPlan {
	statuses: ChannelStatus[];
	active: Channel[];
}

/**
 * Resolve the live channel→version map and classify it, degrading safely. A
 * network failure must not skip the must-pass channels, so this returns null and
 * the caller falls back to the released floor (recorded as a workflow warning, not
 * a hard failure).
 */
export async function resolveChannelPlan(
	load: () => Promise<QuickChrVersionApi> = loadQuickChr,
): Promise<ChannelPlan | null> {
	try {
		const quickchr = await load();
		const versions = await quickchr.resolveAllVersions();
		return {
			statuses: quickchr.classifyChannels(versions),
			active: quickchr.selectActiveChannels(versions),
		};
	} catch (error) {
		console.error(
			`::warning title=QA matrix::recency resolution failed (${String(error)}); falling back to released channels`,
		);
		return null;
	}
}

export function activeMatrixSummary(
	statuses: readonly ChannelStatus[],
	booted: readonly string[],
	degraded: boolean,
): string {
	const lines: string[] = ["## QA matrix — recency-aware active channels", ""];
	lines.push(`Booted this run: ${booted.map((c) => `\`${c}\``).join(", ")}`);
	if (degraded) {
		lines.push(
			"",
			"⚠️ Channel recency could not be resolved; fell back to the released (must-pass) channels.",
		);
	}
	if (statuses.length > 0) {
		const bootedSet = new Set(booted);
		lines.push(
			"",
			"| Channel | Version | Maturity | Ahead of stable | Booted |",
			"| --- | --- | --- | --- | --- |",
		);
		for (const status of statuses) {
			lines.push(
				`| ${status.channel} | ${status.version} | ${status.maturity} | ${status.aheadOfStable ? "yes" : "no"} | ${bootedSet.has(status.channel) ? "✅" : "—"} |`,
			);
		}
	}
	lines.push(
		"",
		"_Released channels (stable, long-term) are must-pass; pre-release legs are best-effort — booted for signal, never gating a merge._",
	);
	return `${lines.join("\n")}\n`;
}

function flag(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

export async function main(args: readonly string[]): Promise<number> {
	const requestedChannel = (flag(args, "--requested-channel") ?? "").trim();

	let activeSet: string[];
	let statuses: ChannelStatus[] = [];
	let degraded = false;

	if (isConcreteChannel(requestedChannel)) {
		// On-demand single channel: no network needed, no recency decision.
		activeSet = [requestedChannel];
	} else {
		const plan = await resolveChannelPlan();
		if (plan) {
			statuses = plan.statuses;
			activeSet = plan.active;
		} else {
			degraded = true;
			activeSet = [...MUST_PASS_CHANNELS];
		}
	}

	const channels = matrixChannels(requestedChannel, activeSet);
	const json = JSON.stringify(channels);

	const summaryPath = flag(args, "--summary");
	if (summaryPath) {
		await Bun.write(
			summaryPath,
			activeMatrixSummary(statuses, channels, degraded),
		);
	}

	const outputPath = Bun.env["GITHUB_OUTPUT"];
	if (outputPath) {
		await appendFile(outputPath, `channels=${json}\n`);
	}

	console.log(json);
	return 0;
}

if (import.meta.main) {
	main(Bun.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(`::error title=QA matrix::${String(error)}`);
			process.exit(1);
		});
}
