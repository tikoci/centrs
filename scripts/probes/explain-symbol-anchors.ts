/**
 * Re-verify the constructed Q13 symbol anchors against live RouterOS highlight.
 *
 * These are the corners that selected the production resolver's F1/F2/H5/H6
 * rules. The answer already lives in `src/explain/symbols.ts` and its unit
 * fixtures; this probe makes a RouterOS version bump a rerun instead of an
 * archaeology exercise.
 *
 * Run: bun run explain:probe:symbol-anchors [existing-chr-name]
 */
import { HIGHLIGHT_CLASS, resolveSymbols } from "../../src/explain/symbols.ts";
import { openChr, probeOutputPath } from "./chr.ts";

const REUSE = process.argv[2];
const chr = await openChr({
	reuse: REUSE,
	name: "centrs-q13-anchors",
	version: Bun.env["CHR_VERSION"] ?? "7.23.3",
});

async function highlight(input: string): Promise<string[]> {
	const rows = (await chr.rest("/console/inspect", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ request: "highlight", input }),
	})) as Record<string, string>[];
	const csv = rows[0]?.["highlight"] ?? "";
	return csv === "" ? [] : csv.split(",");
}

const anchors: { id: string; name: string; input: string }[] = [
	{
		id: "F1a",
		name: "a substitution carrying a nested string does not break later bindings",
		input:
			':global f do={\n    :local cs ""\n    :set cs "$cs$[[:parse "(\\"x\\")"]]"\n    :local pos 0\n    :while ($pos < 3) do={ :set pos ($pos + 1) }\n}',
	},
	{
		id: "F1b",
		name: "a hash line after such a substitution is a comment",
		input: ':local a "$[[:parse "(\\"x\\")"]]"\n# :put $a\n:put $a',
	},
	{
		id: "F2a",
		name: "a named-function body is a closure",
		input: ":local outer 1\n:local fn do={ :put $outer }\n$fn",
	},
	{
		id: "F2b",
		name: "a control-flow body shares the enclosing scope",
		input: ":local v 1\n:if (true) do={ :put $v }",
	},
	{
		id: "F2c",
		name: "a global needs an in-body re-import inside a function",
		input:
			":global G 1\n:global withImport do={ :global G\n :put $G }\n:global without do={ :put $G }",
	},
	{
		id: "F2d",
		name: "a loop variable is visible in its body but not through a function",
		input: ":foreach i in={1;2} do={ :put $i }\n:local fn do={ :put $i }",
	},
	{
		id: "H5a",
		name: "an escaped newline continues the declaration",
		input: ":local \\\nfoo 1\n:put $foo",
	},
	{
		id: "H5b",
		name: "an escaped newline before do keeps the body a closure",
		input: ":local outer 1\n:local fn do=\\\n{ :put $outer }",
	},
	{
		id: "H6a",
		name: "a colon-less local head declares",
		input: "local foo 1\n:put $foo",
	},
	{
		id: "H6b",
		name: "a colon-less global head declares",
		input: "global foo 1\n:put $foo",
	},
	{
		id: "H6c",
		name: "a colon-less foreach head binds its loop variable",
		input: "foreach i in={1} do={:put $i}",
	},
	{
		id: "H6d",
		name: "a colon-less for head binds its loop variable",
		input: "for i from=1 to=3 do={:put $i}",
	},
	{
		id: "H6e",
		name: "a colon-less set targets an existing binding",
		input: ":local foo 1\nset foo 2\n:put $foo",
	},
	{
		id: "H6f",
		name: "a colon-less set on an unknown name is a menu verb",
		input: "set foo 2",
	},
	{
		id: "H6g",
		name: "a root-path scripting head declares like its colon-less twin",
		input: "/local foo 1",
	},
];

try {
	const resource = (await chr.rest("/system/resource")) as Record<
		string,
		string
	>;
	const version = resource["version"]?.trim().split(/\s+/)[0] ?? "unknown";
	const records: Record<string, unknown>[] = [];
	let disagreements = 0;

	for (const anchor of anchors) {
		const classes = await highlight(anchor.input);
		const occurrences = resolveSymbols(anchor.input).occurrences;
		const seen = new Set(occurrences.map((occurrence) => occurrence.start));
		const variables = new Set(Object.values(HIGHLIGHT_CLASS));
		const rows: Record<string, unknown>[] = [];

		console.log(`\n=== ${anchor.id} — ${anchor.name}`);
		for (const occurrence of occurrences) {
			const device = classes[occurrence.start] ?? "?";
			const sut =
				occurrence.cls === null ? "ABSTAIN" : HIGHLIGHT_CLASS[occurrence.cls];
			const agrees = occurrence.cls !== null && sut === device;
			if (!agrees) disagreements++;
			rows.push({
				start: occurrence.start,
				text: occurrence.name,
				sut,
				device,
				agrees,
			});
			console.log(
				`  @${String(occurrence.start).padStart(4)} ${occurrence.name.padEnd(12)} sut=${sut.padEnd(18)} device=${device}${agrees ? "" : "  <-- DIFFERS"}`,
			);
		}

		for (let i = 0; i < classes.length; i++) {
			const cls = classes[i] as string;
			if (!variables.has(cls)) continue;
			let end = i;
			while (end < classes.length && classes[end] === cls) end++;
			if (!seen.has(i)) {
				disagreements++;
				rows.push({
					start: i,
					text: anchor.input.slice(i, end),
					sut: "(missed)",
					device: cls,
					agrees: false,
				});
			}
			i = end - 1;
		}
		records.push({
			...anchor,
			oracle: "highlight",
			rows,
		});
	}

	const outPath = await probeOutputPath(
		`explain-symbol-anchors.v${version}.json`,
	);
	await Bun.write(
		outPath,
		`${JSON.stringify(
			{
				routerosVersion: version,
				architectureName: resource["architecture-name"] ?? "",
				buildTime: resource["build-time"] ?? "",
				capturedAt: new Date().toISOString(),
				oracle: "highlight",
				disagreements,
				records,
			},
			null,
			2,
		)}\n`,
	);
	console.log(
		`\nWrote ${outPath}: ${records.length} anchors, ${disagreements} disagreements`,
	);
} finally {
	if (!REUSE) await chr.remove();
}
