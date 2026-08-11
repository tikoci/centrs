// #201 K2 — replay the recorded device probe output against the module.
//
// K2's claim is about ONE number per case: the offset the device's hard `error`
// lands on, which the module has to reproduce as `bad-sigil:<offset>` (and, when
// the device is clean, must NOT report at all). So this compares exactly that,
// rather than the per-occurrence classes
// `bun run explain:probe:symbol-classes-replay` reads.
//
// Defaults to the committed device recordings; pass files after `--` to replay
// a fresh capture instead.
import { resolveSymbols } from "../../src/explain/symbols.ts";

const DEFAULT_FILES = [
	"test/fixtures/explain/symbol-probes/explain-201-k2-chr-probe.out",
	"test/fixtures/explain/symbol-probes/explain-201-k2-chr-probe2.out",
];
const suppliedFiles = process.argv.slice(2);
const files = suppliedFiles.length === 0 ? DEFAULT_FILES : suppliedFiles;
let cases = 0;
let agree = 0;
const falsePositives: string[] = [];
const falseNegatives: string[] = [];
const wrongOffset: string[] = [];

for (const file of files) {
	const lines = (await Bun.file(file).text()).split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		if (!line.startsWith('  "')) continue;
		let input: string;
		try {
			input = JSON.parse(line.trim()) as string;
		} catch {
			continue;
		}
		const label = (lines[i - 1] ?? "").trim();
		const verdict = lines[i + 1] ?? "";
		const err = /error cliff at (\d+)/.exec(verdict);
		if (err === null && verdict.trim() !== "clean") continue;
		const device = err === null ? null : Number(err[1]);

		const stop = resolveSymbols(input).defects.find(
			(defect) => defect.code === "bad-sigil",
		);
		const module_ = stop?.start ?? null;

		cases++;
		if (device === module_) {
			agree++;
			continue;
		}
		const row = `${label}\n  ${JSON.stringify(input)}\n    device ${device ?? "clean"}  module ${module_ ?? "clean"}`;
		if (device === null) falsePositives.push(row);
		else if (module_ === null) falseNegatives.push(row);
		else wrongOffset.push(row);
	}
}

if (cases === 0) {
	throw new Error(
		"the supplied files contained no recorded K2 cases; refusing an empty 0/0 replay",
	);
}

for (const [title, rows] of [
	["FALSE POSITIVES (module stops, device is clean) — unsafe", falsePositives],
	["WRONG OFFSET", wrongOffset],
	["FALSE NEGATIVES (device errors, module is silent) — safe", falseNegatives],
] as [string, string[]][]) {
	if (rows.length === 0) continue;
	console.log(`\n=== ${title}: ${rows.length} ===`);
	for (const r of rows) console.log(r);
}
console.log(
	`\nK2 probe cases: ${agree}/${cases} agree  (false-positive ${falsePositives.length}, wrong-offset ${wrongOffset.length}, false-negative ${falseNegatives.length})`,
);
