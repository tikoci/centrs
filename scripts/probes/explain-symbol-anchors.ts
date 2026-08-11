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

const fixture = (await Bun.file(
	"test/fixtures/explain/symbols.json",
).json()) as {
	cases: { id: string; class: string; name: string; input: string }[];
};
const anchors = fixture.cases.filter(
	(row) => row.class === "device-verified branch anchor",
);
if (anchors.length === 0) {
	throw new Error(
		"test/fixtures/explain/symbols.json contains no device-verified branch anchors",
	);
}

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
