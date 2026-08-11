// #201 K3 — re-score the module against the RECORDED device probe output.
//
// The probes print, per case, the input and every `variable-*` run the device
// emitted (`<offset>:"<text>"=<class>`). This parses those `.out` files back and
// diffs them against `resolveSymbols`, so the whole matrix is a regression gate
// instead of a handful of hand-copied expectations — #201's "a reusable device
// probe harness" at the scale this issue needs it.
//
//   bun run explain:probe:symbol-classes-replay -- .scratch/explain-201-k3-*.out
import { HIGHLIGHT_CLASS, resolveSymbols } from "../../src/explain/symbols.ts";

const files = process.argv.slice(2);
if (files.length === 0) {
	throw new Error(
		"pass one or more recorded K3 probe-output files after `--`; refusing an empty 0/0 replay",
	);
}
let cases = 0;
let agree = 0;
const disagreements: string[] = [];

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
		// the device's variable runs, and its error cliff if it has one
		let runsLine = lines[i + 1] ?? "";
		let errAt = Number.POSITIVE_INFINITY;
		const err = /error cliff at (\d+)/.exec(runsLine);
		if (err !== null) {
			errAt = Number(err[1]);
			runsLine = lines[i + 2] ?? "";
		}
		const device = new Map<number, string>();
		for (const m of runsLine.matchAll(/(\d+):("(?:[^"\\]|\\.)*")=(\S+)/g))
			device.set(Number(m[1]), m[3] as string);

		const module_ = new Map<number, string>();
		for (const o of resolveSymbols(input).occurrences) {
			if (o.start >= errAt) continue;
			module_.set(
				o.start,
				o.cls === null
					? "(abstain)"
					: HIGHLIGHT_CLASS[o.cls].slice("variable-".length),
			);
		}

		cases++;
		const rows: string[] = [];
		for (const [off, cls] of device) {
			const got = module_.get(off);
			if (got !== cls)
				rows.push(`    @${off} device=${cls} module=${got ?? "(silent)"}`);
		}
		for (const [off, cls] of module_)
			if (!device.has(off) && off < errAt)
				rows.push(`    @${off} device=(silent) module=${cls}`);
		if (rows.length === 0) agree++;
		else
			disagreements.push(
				`${label}\n  ${JSON.stringify(input)}\n${rows.join("\n")}`,
			);
	}
}

if (cases === 0) {
	throw new Error(
		"the supplied files contained no recorded K3 cases; refusing an empty 0/0 replay",
	);
}

for (const d of disagreements) console.log(d);
console.log(`\nprobe cases: ${agree}/${cases} agree with the device`);
