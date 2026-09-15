import { describe, expect, test } from "bun:test";
import {
	cacheSafe,
	channelCacheVersion,
	UNRESOLVED,
} from "../../scripts/chr-cache-key.ts";
import type {
	Channel,
	ChannelStatus,
	QuickChrVersionApi,
} from "../../scripts/qa-active-channels.ts";

const versions: Record<Channel, string> = {
	stable: "7.24.3",
	"long-term": "7.23.6",
	testing: "7.24.3",
	development: "7.25beta4",
};

const statuses: ChannelStatus[] = (
	Object.entries(versions) as [Channel, string][]
).map(([channel, version]) => ({
	channel,
	version,
	maturity: version.includes("beta") ? "prerelease" : "released",
	aheadOfStable: false,
}));

function api(): QuickChrVersionApi {
	return {
		resolveAllVersions: async () => versions,
		classifyChannels: () => statuses,
		selectActiveChannels: () => ["stable", "long-term"],
	};
}

describe("channelCacheVersion", () => {
	test("names the version the channel will boot, suffix and all", async () => {
		expect(await channelCacheVersion("stable", async () => api())).toBe(
			"7.24.3",
		);
		expect(await channelCacheVersion("development", async () => api())).toBe(
			"7.25beta4",
		);
	});

	test("a non-channel argument never reaches the network", async () => {
		let loaded = false;
		const version = await channelCacheVersion("all", async () => {
			loaded = true;
			return api();
		});
		expect(version).toBe(UNRESOLVED);
		expect(loaded).toBe(false);
	});

	test("degrades to a usable key when quickchr cannot resolve", async () => {
		// A cache miss is never worth a red job: resolution failure prints the
		// sentinel, so the key stays well-formed and the step still runs.
		const version = await channelCacheVersion("stable", async () => {
			throw new Error("offline");
		});
		expect(version).toBe(UNRESOLVED);
	});

	test("strips anything a cache key may not carry", async () => {
		const version = await channelCacheVersion("stable", async () => ({
			...api(),
			classifyChannels: () => [
				{
					channel: "stable" as Channel,
					version: "7.24.3 (stable) /weird\n",
					maturity: "released" as const,
					aheadOfStable: false,
				},
			],
		}));
		// The invariant is the key alphabet, not any particular squashed spelling.
		expect(version).toMatch(/^[0-9A-Za-z.-]+$/);
		expect(version).toStartWith("7.24.3");
	});
});

describe("cacheSafe", () => {
	test("keeps a suffixed build readable", () => {
		expect(cacheSafe("7.25beta4")).toBe("7.25beta4");
		expect(cacheSafe("7.23.6")).toBe("7.23.6");
	});

	test("a workflow input cannot write the cache key or $GITHUB_OUTPUT", () => {
		// `--version` carries qa.yaml's `routeros_version` dispatch input, whose
		// value is echoed into GITHUB_OUTPUT and then into a cache key.
		expect(cacheSafe("7.24.3\nversion=injected")).toMatch(/^[0-9A-Za-z.-]+$/);
		expect(cacheSafe("7.24,3")).toBe("7.243");
	});

	test("an all-stripped value degrades rather than emptying the key", () => {
		expect(cacheSafe("///")).toBe(UNRESOLVED);
		expect(cacheSafe("")).toBe(UNRESOLVED);
	});
});
