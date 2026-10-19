import { describe, expect, test } from "bun:test";
import { describePrefetch } from "../../scripts/chr-prefetch.ts";
import {
	integrationChrSelection,
	prefetchedChrVersion,
} from "../integration/chr.ts";

describe("integrationChrSelection (boot and prefetch share it, #468)", () => {
	test("defaults to the stable channel, host arch, no packages", () => {
		expect(integrationChrSelection({})).toEqual({
			channel: "stable",
			packages: [],
		});
	});

	test("a pinned version is carried alongside the channel; the version wins at use", () => {
		expect(
			integrationChrSelection({
				CENTRS_CHR_VERSION: " 7.23.8 ",
				CENTRS_CHR_CHANNEL: "long-term",
				CENTRS_CHR_ARCH: "arm64",
				CENTRS_CHR_PACKAGES: "container,rose",
			}),
		).toEqual({
			version: "7.23.8",
			channel: "long-term",
			arch: "arm64",
			packages: ["container", "rose"],
		});
	});

	test("a blank version is no pin, and an unknown channel falls back to stable", () => {
		expect(
			integrationChrSelection({
				CENTRS_CHR_VERSION: "  ",
				CENTRS_CHR_CHANNEL: "beta",
			}),
		).toEqual({ channel: "stable", packages: [] });
	});
});

test("a successful channel prefetch pins later boots until their selection changes", () => {
	const stable = integrationChrSelection({});
	const cached = { channel: "stable" as const, version: "7.24.5" };
	expect(prefetchedChrVersion(stable, {}, cached)).toBe("7.24.5");
	expect(
		prefetchedChrVersion(stable, { channel: "long-term" }, cached),
	).toBeUndefined();
	expect(
		prefetchedChrVersion(stable, { version: "7.26beta1" }, cached),
	).toBeUndefined();
	expect(
		prefetchedChrVersion(
			integrationChrSelection({ CENTRS_CHR_CHANNEL: "long-term" }),
			{},
			cached,
		),
	).toBeUndefined();
	expect(
		prefetchedChrVersion(
			integrationChrSelection({ CENTRS_CHR_ARCH: "arm64" }),
			{},
			cached,
		),
	).toBeUndefined();
	expect(
		prefetchedChrVersion(
			integrationChrSelection({ CENTRS_CHR_VERSION: "7.23.8" }),
			{},
			cached,
		),
	).toBeUndefined();
});

describe("describePrefetch (the CI step's log line)", () => {
	test("names the channel, the resolved version and the download time", () => {
		expect(
			describePrefetch(
				{ channel: "long-term", packages: [] },
				{ version: "7.23.8", arch: "x86", cacheHit: false },
				108_840,
			),
		).toBe(
			"CHR prefetch: channel long-term -> 7.23.8 (x86), downloaded in 108.8s",
		);
	});

	test("names a pinned version and a cache hit", () => {
		expect(
			describePrefetch(
				{ version: "7.26beta1", channel: "stable", packages: [] },
				{ version: "7.26beta1", arch: "x86", cacheHit: true },
				3,
			),
		).toBe(
			"CHR prefetch: version 7.26beta1 -> 7.26beta1 (x86), already cached",
		);
	});
});
