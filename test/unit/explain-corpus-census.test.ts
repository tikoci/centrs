import { describe, expect, test } from "bun:test";
import {
	type CorpusRow,
	census,
	MARKERS,
	renderMarkdown,
} from "../../scripts/explain-corpus-census.ts";

function row(text: string, opts: Partial<CorpusRow> = {}): CorpusRow {
	return {
		path: opts.path ?? "test.rsc",
		collection: opts.collection ?? "test",
		text,
		hasCliPrompt: opts.hasCliPrompt ?? false,
	};
}

function markerTest(key: string): (row: CorpusRow) => boolean {
	const marker = MARKERS.find((m) => m.key === key);
	if (!marker) throw new Error(`no such marker: ${key}`);
	return marker.test;
}

describe("explain corpus census markers", () => {
	test("harness-header only trips on the injected first line, not a mid-file mention", () => {
		const test_ = markerTest("harness-header");
		expect(
			test_(row("# Source: https://forum.mikrotik.com/t/12345\n/ip/address")),
		).toBe(true);
		expect(
			test_(row("/ip/address\n# Source: https://forum.mikrotik.com/t/12345")),
		).toBe(false);
		expect(test_(row("/ip/address print"))).toBe(false);
	});

	test("scripting-directives matches the nine core keywords, not incidental colons", () => {
		const test_ = markerTest("scripting-directives");
		expect(test_(row(":local x 1"))).toBe(true);
		expect(test_(row(":if ($x = 1) do={ :put yes }"))).toBe(true);
		expect(test_(row("/ip/address add address=1.2.3.4/24"))).toBe(false);
		// ":put" alone is not in the core set that reproduces the #203 figure.
		expect(test_(row(":put hello"))).toBe(false);
	});

	test("line-continuation requires a trailing backslash immediately before EOL", () => {
		const test_ = markerTest("line-continuation");
		expect(test_(row("add address=1.2.3.4/24 \\\n  comment=x"))).toBe(true);
		expect(test_(row("add address=1.2.3.4/24 comment=x\\y"))).toBe(false);
	});

	test("export-idiom requires both a bare menu line and an add/set line", () => {
		const test_ = markerTest("export-idiom");
		expect(test_(row("/ip/address\nadd address=1.2.3.4/24"))).toBe(true);
		expect(test_(row("/ip address\nadd address=1.2.3.4/24"))).toBe(true);
		expect(test_(row("add address=1.2.3.4/24"))).toBe(false);
		expect(test_(row("/ip/address print"))).toBe(false);
	});

	test("pure-config excludes any file carrying a scripting colon token", () => {
		const test_ = markerTest("pure-config");
		expect(test_(row("/ip/address\nadd address=1.2.3.4/24"))).toBe(true);
		expect(test_(row(":local x 1\nadd address=1.2.3.4/24"))).toBe(false);
		expect(test_(row("/ip/address print"))).toBe(false);
	});

	test("eworm-shebang and export-banner are disjoint (the #203 conflation fix)", () => {
		const shebang = markerTest("eworm-shebang");
		const banner = markerTest("export-banner");
		const shebangRow = row("#!rsc by RouterOS 7.15.2\n/ip/address");
		const bannerRow = row(
			"# nov/14/2021 10:31:11 by RouterOS 7.1rc6\n/ip/address",
		);
		expect(shebang(shebangRow)).toBe(true);
		expect(banner(shebangRow)).toBe(false);
		expect(shebang(bannerRow)).toBe(false);
		expect(banner(bannerRow)).toBe(true);
	});

	test("script-in-string vs script-in-brace are distinct source= quoting styles", () => {
		const inString = markerTest("script-in-string");
		const inBrace = markerTest("script-in-brace");
		expect(inString(row('add source="/ip/address print"'))).toBe(true);
		expect(inBrace(row('add source="/ip/address print"'))).toBe(false);
		expect(inBrace(row("add source={ /ip/address print }"))).toBe(true);
		expect(inString(row("add source={ /ip/address print }"))).toBe(false);
	});
});

describe("census aggregation", () => {
	test("tallies collections and markers independently, in descending collection order", () => {
		const rows: CorpusRow[] = [
			row("/ip/address\nadd address=1.2.3.4/24", { collection: "a" }),
			row(":local x 1", { collection: "a" }),
			row("add address=5.6.7.8/24", { collection: "b" }),
		];
		const result = census(rows);
		expect(result.total).toBe(3);
		expect(result.byCollection).toEqual([
			{ collection: "a", files: 2 },
			{ collection: "b", files: 1 },
		]);
		const exportIdiom = result.byMarker.find((m) => m.key === "export-idiom");
		expect(exportIdiom?.files).toBe(1);
		const directives = result.byMarker.find(
			(m) => m.key === "scripting-directives",
		);
		expect(directives?.files).toBe(1);
	});

	test("renderMarkdown emits a collection table and a marker table", () => {
		const result = census([row("/ip/address\nadd address=1.2.3.4/24")]);
		const md = renderMarkdown(result, { compare: false });
		expect(md).toContain("## By collection");
		expect(md).toContain("## By genre marker");
		expect(md).not.toContain("#203 baseline");
	});

	test("renderMarkdown --compare adds the baseline and delta columns", () => {
		const result = census([row("/ip/address\nadd address=1.2.3.4/24")]);
		const md = renderMarkdown(result, { compare: true });
		expect(md).toContain("#203 baseline");
		expect(md).toContain("Delta");
	});
});
