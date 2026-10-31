/**
 * #374 — re-derive the device answers behind the corrected core-syntax anchors.
 *
 * Each row is one exact minimized input from #374's corrected table, plus
 * rejecting controls so the run proves `:parse` discriminates on these shapes.
 * One `:put [:parse "<input>"]` per row per version, the input escaped with
 * `routerOsStringLiteral` so the device parses the same bytes the test sends
 * offline (a bare `$` would be substituted first — #269).
 *
 * Durable answer: `test/fixtures/explain/corrected-anchors.json`, read by
 * `test/unit/explain-corrected-anchors.test.ts`, which classifies each raw
 * return with the production `classifyParseResult`. This probe writes that
 * file's exact shape to `.scratch/`; review it, then copy it over the fixture.
 *
 * Run: bun run explain:probe:corrected-anchors [versions...]
 * (defaults: 7.25 7.23.8, stable and long-term on 2026-10-31).
 */
import { routerOsStringLiteral } from "../../src/core/routeros-string.ts";
import { openChr, probeOutputPath } from "./chr.ts";

interface Row {
	id: string;
	role: "anchor" | "boundary" | "control";
	input: string;
}

const ROWS: Row[] = [
	{ id: "apply-operator", role: "anchor", input: ":put ($a <%% $b)" },
	{
		id: "apply-operator-declared",
		role: "anchor",
		input: ":local a {1;2}; :local b 3; :put ($a <%% $b)",
	},
	{
		id: "nested-array",
		role: "anchor",
		input: ":local m {reset={0;0}; bold={1}}",
	},
	{
		id: "comma-value",
		role: "anchor",
		input: ":local x [:serialize to=dsv delimiter=, {1;2}]",
	},
	{
		id: "comma-value-typo",
		role: "boundary",
		input: ":local x [:serialize to=dsv decimator=, {1;2}]",
	},
	{
		id: "trailing-selector",
		role: "anchor",
		input: '/certificate sign ca=[$f] [find name="x"]',
	},
	{
		id: "trailing-selector-declared",
		role: "anchor",
		input: ':local f; /certificate sign ca=[$f] [find name="x"]',
	},
	{
		id: "contextual-find",
		role: "anchor",
		input: "/ip/address; :local varID [find where name=$varName]",
	},
	{
		id: "standalone-find",
		role: "boundary",
		input: ":local varID [find where name=$varName]",
	},
	{
		id: "standalone-find-declared",
		role: "boundary",
		input: ":local varName x; :local varID [find where name=$varName]",
	},
	{ id: "control-apply-no-rhs", role: "control", input: ":put ($a <%%)" },
	{
		id: "control-unclosed-array",
		role: "control",
		input: ":local m {reset={0;0}; bold={1}",
	},
	{
		id: "control-selector-extra",
		role: "control",
		input: '/certificate sign ca=[$f] [find name="x"] extra',
	},
	{
		id: "control-unknown-command",
		role: "control",
		input: ":local varID [nosuchcmd where name=x]",
	},
];

const requested = Bun.argv.slice(2).filter((a) => !a.startsWith("--"));
const versions: Record<string, { arch: string; capturedAt: string }> = {};
const parse = new Map<string, Record<string, string>>();

for (const version of requested.length > 0 ? requested : ["7.25", "7.23.8"]) {
	const chr = await openChr({
		reuse: undefined,
		name: "centrs-374-anchors",
		version,
	});
	try {
		const resource = (await chr.rest("/system/resource")) as Record<
			string,
			string
		>;
		const actual = resource["version"]?.trim().split(/\s+/)[0] ?? "unknown";
		versions[actual] = {
			arch: resource["architecture-name"] ?? "unknown",
			capturedAt: new Date().toISOString(),
		};
		console.log(`\n=== RouterOS ${actual} ===`);
		for (const row of ROWS) {
			const result = (await chr.exec(
				`:put [:parse ${routerOsStringLiteral(row.input)}]`,
			)) as { output?: string };
			const output = result.output?.trim() ?? "";
			parse.set(row.id, { ...parse.get(row.id), [actual]: output });
			console.log(`${row.id}: ${output.slice(0, 120)}`);
		}
	} finally {
		await chr.remove();
	}
}

const outPath = await probeOutputPath("explain-corrected-anchors.json");
await Bun.write(
	outPath,
	`${JSON.stringify(
		{
			_source: `Recorded by \`bun run explain:probe:corrected-anchors ${Object.keys(versions).join(" ")}\` (scripts/probes/explain-corrected-anchors.ts): one disposable quickchr CHR per version, one \`:put [:parse "<input>"]\` per row with the input escaped by \`routerOsStringLiteral\`. \`parse\` is the raw device return; the test classifies it with \`classifyParseResult\`. Roles: anchor = device accepts and offline must agree; boundary = device rejects on an argument name, which offline does not validate (decision 3); control = device rejects, proving the oracle discriminates on these shapes.`,
			versions,
			rows: ROWS.map((row) => ({ ...row, parse: parse.get(row.id) ?? {} })),
		},
		null,
		"\t",
	)}\n`,
);
console.log(`\nWrote ${outPath}`);
