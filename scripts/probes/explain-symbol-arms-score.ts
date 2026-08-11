// cspell:ignore scanfix
// Q13 promotion — score every candidate arm against the frozen corpus streams.
// Precision on decided / abstention / missed, against the full highlight
// captures written by `explain:probe:highlight-recapture`. The candidate emits
// ANALYZED-BYTE offsets, which
// are the highlight stream's own byte offsets (Q15: the ASCII normalization is
// byte-count-preserving), so no char→byte remap is needed.
import {
	type Arm,
	HIGHLIGHT_CLASS,
	resolveSymbols,
} from "./explain-symbol-arms.ts";

function expandPairs(pairs: [string, string][]): {
	text: string;
	classes: string[];
} {
	let text = "";
	const classes: string[] = [];
	for (const [fragment, cls] of pairs) {
		text += fragment;
		for (let i = 0; i < fragment.length; i++) classes.push(cls);
	}
	return { text, classes };
}

const VAR_CLASSES = new Set(Object.values(HIGHLIGHT_CLASS));
const SPLITS = ["dev", "holdout"] as const;
const ARMS: Arm[] = (Bun.env["ARMS"]?.split(",") as Arm[]) ?? [
	"lab",
	"scanfix",
	"closure",
	"abstain",
];
const VERSION = Bun.env["HL_VERSION"] ?? "7.23.2";

const manifest = (await Bun.file(
	"test/fixtures/explain/corpus-partition.json",
).json()) as {
	groups: { split: string; scripts: string[] }[];
};
const splitOf = new Map<string, string>();
for (const g of manifest.groups)
	for (const p of g.scripts) splitOf.set(p, g.split);

const artifact = (await Bun.file(
	`.scratch/explain-lab-q13-streams.v${VERSION}.json`,
).json()) as {
	streams: Record<string, { pairs?: [string, string][]; aligned: boolean }>;
};

interface Tally {
	total: number;
	correct: number;
	abstained: number;
	wrong: number;
	missed: number;
	directions: Map<string, number>;
	files: Map<string, number>;
}

const empty = (): Tally => ({
	total: 0,
	correct: 0,
	abstained: 0,
	wrong: 0,
	missed: 0,
	directions: new Map(),
	files: new Map(),
});

const started = Date.now();
for (const arm of ARMS) {
	for (const split of SPLITS) {
		const t = empty();
		for (const [rel, entry] of Object.entries(artifact.streams)) {
			if (splitOf.get(rel) !== split) continue;
			if (!entry.aligned || !entry.pairs) continue;
			const { text, classes } = expandPairs(entry.pairs);
			const errAt = classes.indexOf("error");
			const limit = errAt >= 0 ? errAt : classes.length;
			const seen = new Set<number>();
			const { occurrences } = resolveSymbols(text, arm);
			for (const o of occurrences) {
				if (o.start >= limit) continue;
				const expected = classes[o.start];
				if (expected === undefined) continue;
				seen.add(o.start);
				t.total++;
				if (o.cls === null) {
					t.abstained++;
					continue;
				}
				const got = HIGHLIGHT_CLASS[o.cls];
				if (got === expected) t.correct++;
				else {
					t.wrong++;
					const key = `device=${expected} sut=${got}`;
					t.directions.set(key, (t.directions.get(key) ?? 0) + 1);
					t.files.set(rel, (t.files.get(rel) ?? 0) + 1);
				}
			}
			let i = 0;
			while (i < limit) {
				const cls = classes[i] as string;
				if (!VAR_CLASSES.has(cls)) {
					i++;
					continue;
				}
				let j = i;
				while (j < limit && classes[j] === cls) j++;
				if (!seen.has(i)) t.missed++;
				i = j;
			}
		}
		const decided = t.total - t.abstained;
		console.log(
			`${arm.padEnd(8)} ${split.padEnd(8)} occurrences ${String(t.total).padStart(6)}  precision ${((100 * t.correct) / decided).toFixed(2)}% (${t.correct}/${decided})  abstention ${((100 * t.abstained) / t.total).toFixed(2)}%  wrong ${String(t.wrong).padStart(4)}  missed ${String(t.missed).padStart(4)}`,
		);
		if (Bun.env["DETAIL"]) {
			for (const [k, v] of [...t.directions]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 8))
				console.log(`         ${String(v).padStart(4)}  ${k}`);
			for (const [k, v] of [...t.files].sort((a, b) => b[1] - a[1]).slice(0, 6))
				console.log(`         ${String(v).padStart(4)}  ${k}`);
		}
	}
}
console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s)`);
