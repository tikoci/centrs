/**
 * The conformance census's classification rules. Nothing here needs
 * `corpus.sqlite`: corpus → fixture is gated by `bun run explain:conformance:check`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	type ConformanceCensus,
	type ConformanceRow,
	census,
	deviceVerdict,
	diffAgainstFixture,
} from "../../scripts/explain-conformance.ts";

const ACCEPT = "il-no-recognized-diagnostic";

function row(
	path: string,
	offline: ConformanceRow["offline"],
	device: Record<string, string>,
	upstreamValid = true,
): ConformanceRow {
	return {
		path,
		section: "s",
		text: path,
		upstreamValid,
		offline,
		failCodes: offline === "fail" ? ["explain/x/y"] : [],
		device,
	};
}

const channels = {
	"long-term": {
		version: "7.23.8",
		parseRunId: "lt",
		accepted: 0,
		rejected: 0,
	},
};

describe("explain conformance census", () => {
	test("a device verdict needs every channel to agree", () => {
		expect(deviceVerdict({ a: ACCEPT, b: ACCEPT })).toBe("accept");
		expect(
			deviceVerdict({ a: "plain-diagnostic", b: "embedded-diagnostic" }),
		).toBe("reject");
		expect(deviceVerdict({ a: ACCEPT, b: "plain-diagnostic" })).toBe("split");
	});

	test("only a fail is a refusal, and a split case is in neither list", () => {
		const result = census(
			[
				row("fr", "fail", { a: ACCEPT, b: ACCEPT }),
				row(
					"ok",
					"fail",
					{ a: "plain-diagnostic", b: "plain-diagnostic" },
					false,
				),
				row(
					"warn",
					"warn",
					{ a: "plain-diagnostic", b: "plain-diagnostic" },
					false,
				),
				row("schema", "pass", {
					a: "embedded-diagnostic",
					b: "embedded-diagnostic",
				}),
				row("split", "fail", { a: ACCEPT, b: "plain-diagnostic" }),
			],
			channels,
			"abc",
		);
		expect(result.falseRejects).toEqual({ fr: "explain/x/y" });
		expect(result.missedRejections).toEqual({
			warn: "warn; device plain-diagnostic",
			schema: "pass; device embedded-diagnostic",
		});
		expect(result.missedByClass).toEqual({
			"plain-diagnostic": 1,
			"embedded-diagnostic": 1,
		});
		expect(result.split).toEqual({
			split: "a=il-no-recognized-diagnostic, b=plain-diagnostic",
		});
		// The upstream label is compared, never scored: `schema` is labelled valid
		// and the device rejects it.
		expect(result.upstreamDisagreements).toEqual({
			schema: "upstream valid, device reject",
		});
		expect(result.offline).toEqual({ pass: 1, warn: 1, fail: 3 });
		expect(result.device).toEqual({ accept: 1, reject: 3, split: 1 });
	});

	test("drift names each case that entered, left or changed a list", () => {
		const base = census([row("x", "fail", { a: ACCEPT })], channels, "abc");
		const moved = census([row("x", "pass", { a: ACCEPT })], channels, "abc");
		expect(diffAgainstFixture(moved, base)).toEqual([
			'offline: fixture {"pass":0,"warn":0,"fail":1}, measured {"pass":1,"warn":0,"fail":0}',
			"falseRejects - x (was explain/x/y)",
		]);
		expect(diffAgainstFixture(base, base)).toEqual([]);
	});

	test("the committed fixture is self-consistent", () => {
		const fixture = JSON.parse(
			readFileSync(
				new URL("../fixtures/explain/conformance.json", import.meta.url),
				"utf8",
			),
		) as ConformanceCensus;
		const sum = (o: Record<string, number>) =>
			Object.values(o).reduce((a, b) => a + b, 0);
		expect(sum(fixture.offline)).toBe(fixture.cases);
		expect(sum(fixture.device)).toBe(fixture.cases);
		expect(sum(fixture.missedByClass)).toBe(
			Object.keys(fixture.missedRejections).length,
		);
		expect(Object.keys(fixture.split).length).toBe(fixture.device.split);
		for (const c of Object.values(fixture.channels))
			expect(c.accepted + c.rejected).toBe(fixture.cases);
	});
});
