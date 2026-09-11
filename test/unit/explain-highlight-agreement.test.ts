/**
 * #264 B4 / #263 — the device-agreement report is re-derivable, and drift-gated.
 *
 * Three things can drift apart here and all three are silent on their own:
 * the measurement (fresh run vs `test/fixtures/explain/highlight-agreement.json`),
 * the README block (a projection of that fixture through
 * `src/explain/highlight-projection.ts`, also checked by `bun run lint:ci`),
 * and the projection's own totality. Nothing here needs a router, the corpus,
 * or the ~7.5 MB per-version captures — the committed slice is the whole input,
 * which is why this gates in the unit suite.
 *
 * What these tests do NOT do is check the device's answers. Every pair in the
 * slice is verbatim `/console/inspect request=highlight` output with no second
 * oracle offline; `test/unit/explain-highlight-slice.test.ts` keeps that file
 * honest about itself.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	addBuckets,
	allSplits,
	applicabilityOfSplit,
	bucketOf,
	bucketsOf,
	cellsInApplicability,
	cellsInBucket,
	decidedAgreementExcluding,
	decidedAgreementPct,
	diffAgainstFixture,
	exampleForPair,
	type HighlightAgreement,
	measure,
	mergeSplits,
	parseCell,
	perClassAgreement,
	perClassUnprojected,
	readFixture,
	readSlice,
	renderReadmeBlock,
	splitLines,
} from "../../scripts/explain-highlight-agreement.ts";
import {
	applicabilityOf,
	DEVICE_CLASS_KIND,
	deviceClassKind,
	HIGHLIGHT_PROJECTION,
	projectTokenClass,
} from "../../src/explain/highlight-projection.ts";
import { type ExplainTokenClass, explainCommand } from "../../src/explain.ts";

const README = readFileSync(
	new URL("../../commands/explain/README.md", import.meta.url),
	"utf8",
);
const BEGIN =
	"<!-- BEGIN GENERATED highlight-agreement — regenerate with `bun run explain:highlight-agreement:readme` -->";
const END = "<!-- END GENERATED highlight-agreement -->";

const fixture: HighlightAgreement = readFixture();
const slice = readSlice();

describe("#263 — the committed report is what a fresh run measures", () => {
	test("measuring the slice reproduces the fixture cell for cell", () => {
		const drift = diffAgainstFixture(measure(slice), fixture);
		expect(drift).toEqual([]);
	});

	test("the fixture names the slice bytes it was measured from", () => {
		expect(fixture.slice.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(fixture.slice.baseVersion).toBe(slice.baseVersion);
		expect(fixture.slice.scripts).toBe(Object.keys(slice.scripts).length);
	});

	test("every captured version is measured", () => {
		expect(Object.keys(fixture.versions).sort()).toEqual(
			slice.versions.map((v) => v.version).sort(),
		);
	});

	test("the same 70 scripts and bytes are scored on every version", () => {
		for (const measurement of Object.values(fixture.versions)) {
			const all = allSplits(measurement);
			expect(all.scripts).toBe(fixture.slice.scripts);
			expect(all.bytes).toBe(
				allSplits(fixture.versions[fixture.slice.baseVersion] as never).bytes,
			);
		}
	});
});

describe("#263 — the outcome buckets are a partition, like the token partition", () => {
	test("buckets sum to the measured bytes, per version and per split", () => {
		for (const measurement of Object.values(fixture.versions)) {
			for (const split of [
				measurement.dev,
				measurement.holdout,
				mergeSplits(measurement.dev, measurement.holdout),
			]) {
				const buckets = bucketsOf(split);
				const sum = Object.values(buckets).reduce((a, b) => a + b, 0);
				expect(sum).toBe(split.bytes);
			}
		}
	});

	test("dev + holdout buckets equal the merged buckets", () => {
		for (const measurement of Object.values(fixture.versions)) {
			expect(
				addBuckets(bucketsOf(measurement.dev), bucketsOf(measurement.holdout)),
			).toEqual(bucketsOf(allSplits(measurement)));
		}
	});

	test("the stopped region is exactly the post-`error` tail", () => {
		for (const measurement of Object.values(fixture.versions))
			for (const split of [measurement.dev, measurement.holdout]) {
				const stoppedCells = Object.values(split.stopped).reduce(
					(a, b) => a + b,
					0,
				);
				expect(stoppedCells).toBe(split.stoppedBytes);
				// One `error` byte per stopped script — the slice's own fact, and the
				// reason `parserStopped` can be counted from `stoppedBytes` alone.
				const errors = Object.entries(split.stopped)
					.filter(([cell]) => parseCell(cell).deviceClass === "error")
					.reduce((sum, [, n]) => sum + n, 0);
				expect(errors).toBe(split.scriptsWithParserStop);
			}
	});

	test("no `error` byte survives in the live region", () => {
		for (const measurement of Object.values(fixture.versions))
			for (const split of [measurement.dev, measurement.holdout])
				expect(
					Object.keys(split.live).filter(
						(cell) => parseCell(cell).deviceClass === "error",
					),
				).toEqual([]);
	});

	test("agreement is computed only over bytes both sides decided", () => {
		for (const measurement of Object.values(fixture.versions)) {
			const buckets = bucketsOf(allSplits(measurement));
			const decided = buckets.agree + buckets.disagree;
			expect(decidedAgreementPct(buckets)).toBeCloseTo(
				(buckets.agree / decided) * 100,
				10,
			);
			// The silent buckets are large enough that folding either one in would
			// move the figure by tens of points. That is the whole reason they are
			// separate, so pin that they are not part of the denominator.
			expect(buckets.bothSilent + buckets.deviceSilent).toBeGreaterThan(
				decided / 4,
			);
		}
	});

	test("holding `comment` out leaves a smaller, still non-empty decided region", () => {
		const base = allSplits(
			fixture.versions[fixture.slice.baseVersion] as never,
		);
		const buckets = bucketsOf(base);
		const held = decidedAgreementExcluding(base, "comment");
		expect(held.agree + held.disagree).toBeGreaterThan(0);
		expect(held.agree + held.disagree).toBeLessThan(
			buckets.agree + buckets.disagree,
		);
		// The banner really does dominate: if it ever stops doing so, the README's
		// "set `comment` aside" sentence is describing a corpus that no longer exists.
		expect(buckets.agree - held.agree).toBeGreaterThan(held.agree);
	});
});

describe("#264 B4 — the projection is total, declared, and abstains on merges", () => {
	const classes: ExplainTokenClass[] = [
		"comment",
		"variable-local",
		"variable-global",
		"variable-auto",
		"variable-parameter",
		"dir",
		"cmd",
		"operator",
		"arg",
		"value",
		"string",
		"brace",
		"unclassified",
	];

	test("every `ExplainTokenClass` has an entry with a reason", () => {
		expect(Object.keys(HIGHLIGHT_PROJECTION).sort()).toEqual(
			[...classes].sort(),
		);
		for (const cls of classes) {
			const entry = HIGHLIGHT_PROJECTION[cls];
			expect(entry.because.length, cls).toBeGreaterThan(20);
			// An empty accept set would read as "predicts nothing", which is what
			// `null` already means. Keep the two spellings from blurring.
			if (entry.accepts !== null)
				expect(entry.accepts.length, cls).toBeGreaterThan(0);
		}
	});

	test("a projected class only accepts classes the device actually emits", () => {
		for (const cls of classes)
			for (const accepted of projectTokenClass(cls) ?? [])
				expect(deviceClassKind(accepted), `${cls} → ${accepted}`).toBe(
					"syntax",
				);
	});

	test("the classes that are provisional merges abstain", () => {
		expect(projectTokenClass("string")).toBeNull();
		expect(projectTokenClass("value")).toBeNull();
		expect(projectTokenClass("unclassified")).toBeNull();
	});

	test("`arg` covers the device's dotted spellings, never the `=`", () => {
		const accepts = projectTokenClass("arg") ?? [];
		expect([...accepts].sort()).toEqual(["arg", "arg-dot", "arg-scope"]);
		expect(accepts).not.toContain("syntax-meta");
	});

	test("the device class table covers every class the slice carries", () => {
		const seen = new Set<string>();
		for (const entry of Object.values(slice.scripts))
			for (const stream of Object.values(entry.streams))
				for (const [, cls] of stream ?? []) seen.add(cls);
		for (const cls of seen)
			expect(deviceClassKind(cls), cls).not.toBe("unknown");
		expect([...seen].sort()).toEqual(Object.keys(DEVICE_CLASS_KIND).sort());
	});

	test("an upstream class this build has never seen is reported, not blamed", () => {
		expect(deviceClassKind("some-new-7.99-class")).toBe("unknown");
		expect(bucketOf("cmd", "some-new-7.99-class")).toBe("unprojected");
	});

	test("a non-syntax answer and device silence never score as agreement", () => {
		for (const cls of ["obj-inactive", "obj-dynamic", "variable-undefined"])
			expect(bucketOf("cmd", cls)).toBe("nonSyntax");
		expect(bucketOf("cmd", "none")).toBe("deviceSilent");
		expect(bucketOf("unclassified", "none")).toBe("bothSilent");
		expect(bucketOf("unclassified", "cmd")).toBe("offlineSilent");
	});
});

describe("#263 — applicability is assigned from context, not from the class name", () => {
	test("one highlight class can carry two categories", () => {
		// The requirement #263 states outright: `obj-inactive` is schema-dependent
		// on an argument name and state-dependent on a menu or command name, so a
		// rule keyed on the class alone would be wrong for one of them.
		expect(applicabilityOf("arg", "obj-inactive", true)).toBe(
			"schema-dependent",
		);
		expect(applicabilityOf("dir", "obj-inactive", true)).toBe(
			"state-dependent",
		);
		expect(applicabilityOf("cmd", "obj-inactive", true)).toBe(
			"state-dependent",
		);
		expect(applicabilityOf("unclassified", "obj-inactive", true)).toBe(
			"uncategorized",
		);
	});

	test("`variable-undefined` is not blanket-exempted as state-dependent", () => {
		// #263: lexical spellings, query/filter fields and external globals need
		// different treatment, and nothing committed here separates them.
		for (const centrsClass of ["unclassified", "value", "string", "arg"])
			expect(applicabilityOf(centrsClass, "variable-undefined", true)).toBe(
				"uncategorized",
			);
	});

	test("a version disagreement outranks every other category", () => {
		for (const deviceClass of [
			"cmd",
			"obj-inactive",
			"obj-dynamic",
			"variable-undefined",
			"syntax-obsolete",
		])
			expect(applicabilityOf("cmd", deviceClass, false)).toBe(
				"version-dependent",
			);
		// …except where the device never answered: there is nothing to disagree on.
		expect(applicabilityOf("cmd", "none", false)).toBe("no-device-answer");
		expect(applicabilityOf("cmd", "error", false)).toBe("no-device-answer");
	});

	test("a deprecation the running version names is version-dependent", () => {
		expect(applicabilityOf("unclassified", "syntax-obsolete", true)).toBe(
			"version-dependent",
		);
	});

	test("a syntax class the versions agree on is offline-decidable", () => {
		for (const deviceClass of ["cmd", "dir", "arg", "comment", "syntax-meta"])
			expect(applicabilityOf("cmd", deviceClass, true)).toBe(
				"offline-decidable",
			);
	});

	test("applicability partitions the measured bytes, like the buckets do", () => {
		for (const measurement of Object.values(fixture.versions)) {
			const all = allSplits(measurement);
			const total = [...applicabilityOfSplit(all).values()].reduce(
				(a, b) => a + b,
				0,
			);
			expect(total).toBe(all.bytes);
		}
	});

	test("every category the report ranks is backed by cells that sum to it", () => {
		const base = allSplits(
			fixture.versions[fixture.slice.baseVersion] as never,
		);
		const byCategory = applicabilityOfSplit(base);
		for (const category of [
			"offline-decidable",
			"schema-dependent",
			"state-dependent",
			"version-dependent",
			"uncategorized",
		] as const) {
			const cells = cellsInApplicability(base, category);
			const sum = cells.reduce((total, [, n]) => total + n, 0);
			expect(sum, category).toBe(byCategory.get(category) ?? 0);
		}
	});

	test("the slice really does carry all four categories", () => {
		// A category with no observation would make its README row a claim about
		// nothing. Every one of #263's four is present in the committed slice.
		const base = allSplits(
			fixture.versions[fixture.slice.baseVersion] as never,
		);
		const byCategory = applicabilityOfSplit(base);
		for (const category of [
			"offline-decidable",
			"schema-dependent",
			"state-dependent",
			"version-dependent",
		] as const)
			expect(byCategory.get(category) ?? 0, category).toBeGreaterThan(0);
	});
});

describe("#263 — representative examples, and the text they were taken from", () => {
	test("every example key is a live cell of the base version", () => {
		const base = allSplits(
			fixture.versions[fixture.slice.baseVersion] as never,
		);
		for (const key of Object.keys(fixture.examples))
			expect(base.live[key], key).toBeGreaterThan(0);
	});

	test("an example's text really occurs at the offset it names", () => {
		const streams = slice.scripts;
		for (const [key, example] of Object.entries(fixture.examples)) {
			const entry = streams[example.path];
			expect(entry, `${key}: ${example.path}`).toBeDefined();
			const text = (entry?.streams[slice.baseVersion] ?? [])
				.map(([fragment]: [string, string]) => fragment)
				.join("");
			expect(
				text.slice(example.offset, example.offset + example.text.length),
				key,
			).toBe(example.text);
		}
	});

	test("every disagreement cell has an example to read", () => {
		const base = allSplits(
			fixture.versions[fixture.slice.baseVersion] as never,
		);
		for (const [pair] of cellsInBucket(base, "disagree"))
			expect(exampleForPair(fixture, pair), pair).toBeDefined();
	});

	test("examples are capped, so a fixture cannot grow a corpus excerpt", () => {
		for (const [key, example] of Object.entries(fixture.examples))
			expect(example.text.length, key).toBeLessThanOrEqual(40);
	});
});

describe("#263 — transformed text: the scorer refuses what it cannot align", () => {
	function sliceWith(text: string, cls = "cmd"): Parameters<typeof measure>[0] {
		return {
			baseVersion: "7.23.2",
			versions: [{ version: "7.23.2", routerosVersion: "7.23.2" }],
			selection: { selected: 1, versionDiffering: 0 },
			scripts: {
				"synthetic.rsc": {
					split: "dev" as const,
					chars: text.length,
					streams: { "7.23.2": [[text, cls]] as [string, string][] },
				},
			},
		} as unknown as Parameters<typeof measure>[0];
	}

	test("a non-ASCII stream is refused, not silently mis-aligned", () => {
		// The capture replaces non-ASCII before sending, so a stream carrying it
		// did not come from that pipeline — and a JS char index would stop being a
		// byte offset, which is the one assumption the whole score rests on.
		expect(() => measure(sliceWith("/ip address print # café"))).toThrow(
			/not pure ASCII/,
		);
	});

	test("a stream whose length contradicts its own header is refused", () => {
		const bad = sliceWith("/ip print");
		// biome-ignore lint/suspicious/noExplicitAny: reaching into a synthetic fixture.
		(bad as any).scripts["synthetic.rsc"].chars = 3;
		expect(() => measure(bad)).toThrow(/header says 3/);
	});

	test("an all-ASCII stream measures without complaint", () => {
		const report = measure(sliceWith("/ip address print"));
		expect(allSplits(report.versions["7.23.2"] as never).bytes).toBe(17);
	});

	test("the coordinate contract survives non-ASCII for a future oracle", () => {
		// centrs itself handles non-ASCII: offsets stay BYTE offsets, which is what
		// makes them comparable to a device stream at all (Q15). The scorer's
		// refusal above is about the committed capture, not about the analyzer.
		const input = '/ip address add comment="café"';
		const bytes = new TextEncoder().encode(input).length;
		const data = explainCommand(input, { tokens: true });
		expect(data.input.bytes).toBe(bytes);
		expect(data.tokens?.at(-1)?.end).toBe(bytes);
	});
});

describe("#263 — the README block is a projection of the fixture", () => {
	function block(): string[] {
		const lines = splitLines(README);
		const begin = lines.indexOf(BEGIN);
		const end = lines.indexOf(END);
		expect(begin).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(begin);
		return lines.slice(begin + 1, end);
	}

	test("the committed block is what the fixture renders", () => {
		expect(block().join("\n")).toBe(renderReadmeBlock(fixture).join("\n"));
	});

	test("the block names every projected class and its accept set", () => {
		const text = block().join("\n");
		for (const [cls, entry] of Object.entries(HIGHLIGHT_PROJECTION)) {
			if (cls === "unclassified") continue;
			expect(text, cls).toContain(`| \`${cls}\` |`);
			for (const accepted of entry.accepts ?? [])
				expect(text, `${cls} → ${accepted}`).toContain(`\`${accepted}\``);
		}
	});

	test("the block reports a trend, and says so", () => {
		// Wrapped at 78 columns, so the phrase can straddle a line break.
		expect(block().join(" ").replace(/\s+/g, " ")).toContain(
			"trend line, not a pass gate",
		);
	});
});

describe("#263 — the derived tables agree with the raw matrix", () => {
	const base = allSplits(fixture.versions[fixture.slice.baseVersion] as never);

	test("per-class agreement sums to the agree/disagree buckets", () => {
		const buckets = bucketsOf(base);
		let agree = 0;
		let disagree = 0;
		for (const row of perClassAgreement(base).values()) {
			agree += row.agree;
			disagree += row.disagree;
		}
		expect(agree).toBe(buckets.agree);
		expect(disagree).toBe(buckets.disagree);
	});

	test("per-class unprojected sums to the unprojected bucket", () => {
		const total = [...perClassUnprojected(base).values()].reduce(
			(a, b) => a + b,
			0,
		);
		expect(total).toBe(bucketsOf(base).unprojected);
	});

	test("only abstaining classes contribute unprojected bytes", () => {
		// True while every device class in the slice is one this build knows: an
		// unknown upstream class also lands unprojected, and the
		// "covers every class the slice carries" test above is what would catch
		// that first, with the actionable message.
		for (const cls of perClassUnprojected(base).keys())
			expect(
				projectTokenClass(cls as ExplainTokenClass),
				`${cls} projects somewhere yet lands unprojected`,
			).toBeNull();
	});

	test("every live cell lands in exactly one bucket", () => {
		const cells = [
			...new Set(
				Object.keys(base.live).map((key) => {
					const { centrsClass, deviceClass } = parseCell(key);
					return `${centrsClass}|${deviceClass}`;
				}),
			),
		].sort();
		const bucketed: string[] = [];
		for (const bucket of [
			"agree",
			"disagree",
			"unprojected",
			"offlineSilent",
			"nonSyntax",
			"deviceSilent",
			"bothSilent",
			"parserStopped",
		] as const)
			for (const [cell] of cellsInBucket(base, bucket)) bucketed.push(cell);
		expect(bucketed.sort()).toEqual(cells);
	});
});
