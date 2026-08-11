/**
 * #225 / #257 — the (verb, slot) brace table, built from the device.
 *
 * `explain` gates a `{…}` array literal on the statement's PATH, and a sweep
 * after the PR #256 review showed that is wrong in both directions. The gate
 * has to fail closed on evidence instead, so this builds the evidence: for
 * every root builtin and every slot it completes, ask whether a brace there is
 * an ARRAY, a CODE BLOCK, or a syntax error.
 *
 * Method — three probes per slot, so a rejection is never confused with an
 * unrelated one:
 *
 *   1. a CONTROL with a scalar value (`:verb name=1`). If the control does not
 *      parse, the slot needs arguments this probe does not supply and the row
 *      is inconclusive rather than "rejects".
 *   2. the brace probe (`:verb name={1;2}`).
 *   3. a DISCRIMINATOR probe, `{(1,2)}`, because accepting a brace is not the
 *      same as reading one as an array. `(1,2)` lowers to the IL `(, 1 2)` only
 *      when the content is EVALUATED; a slot that takes script TEXT echoes it
 *      verbatim. `{1;2}` cannot tell those apart — `:local z {1;2}` and
 *      `:execute script={1;2}` both lower to `…=1;2` — and reading `{1;2}`
 *      alone put `:execute script=` in the array set, where it would have hinted
 *      `array` on a script body. A code block instead reports `bad command
 *      name 1`, which is how `:onerror in=` differs from `:foreach in=`.
 *
 * `:parse` is the oracle, not `highlight`: `highlight` accepts `{1;2,}`,
 * `{2,}` and `{(1,2),}`, all of which `:parse` rejects.
 *
 * Run: bun run .scratch/explain-225-brace-slot-sweep.ts [existing-chr-name]
 */
import { QuickCHR } from "@tikoci/quickchr";

const REUSE = process.argv[2];

const chr = REUSE
	? await QuickCHR.get(REUSE)
	: await QuickCHR.start({
			name: `centrs-225slots-${Date.now()}`,
			version: process.env.CHR_VERSION ?? "7.23.3",
			arch: "x86",
		});
if (!chr) throw new Error(`no CHR named ${REUSE}`);

async function exec(input: string): Promise<string> {
	const out = (await chr.exec(input)) as unknown;
	const text =
		typeof out === "string" ? out : String((out as any)?.output ?? "");
	return text.replaceAll("\r\n", " ").trim();
}

async function parse(src: string): Promise<string> {
	if (/["\\]/.test(src)) throw new Error(`unquotable probe input: ${src}`);
	return exec(`:put [:parse "${src}"]`);
}

function rejected(il: string): boolean {
	return /syntax error|expected /.test(il);
}

async function completions(input: string, style: string): Promise<string[]> {
	const rows = (await chr.rest("/console/inspect", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ request: "completion", input }),
	})) as { completion?: string; style?: string }[];
	const out = new Set<string>();
	for (const row of rows) {
		if (row.style !== style) continue;
		const name = (row.completion ?? "").trim();
		if (name) out.add(name);
	}
	return [...out].sort();
}

type Outcome = "array" | "code" | "text" | "error" | "inconclusive";
type Row = {
	verb: string;
	/** A named slot, or the positional's zero-based index as `#0`/`#1`. */
	slot: string;
	outcome: Outcome;
	control: string;
	braceIl: string;
	discriminatorIl: string;
};

/**
 * array / code / text / error, from the three probes.
 *
 * The control only disambiguates a REJECTION: when the brace probe parses, the
 * slot plainly takes a brace whatever the scalar control did (`:execute 1` is a
 * syntax error while `:execute {1;2}` parses). What the slot DOES with the
 * brace is then the discriminator's question, not the brace probe's.
 */
function classify(
	control: string,
	braceIl: string,
	discriminatorIl: string,
): Outcome {
	if (rejected(braceIl)) return rejected(control) ? "inconclusive" : "error";
	if (braceIl.includes("bad command name")) return "code";
	if (rejected(discriminatorIl)) return "inconclusive";
	if (discriminatorIl.includes("(, 1 2)")) return "array";
	return discriminatorIl.includes("(1,2)") ? "text" : "inconclusive";
}

const verbs = await completions(":", "cmd");
const rows: Row[] = [];

/**
 * `:set` needs a variable that already exists, so every bare `:set g …` probe
 * fails at `g` and says nothing about braces. Declaring one first is the only
 * way to ask the question, and the answer matters: `:set` carries 5 of the
 * corpus's 112 brace arrays.
 */
for (const [index, prefix] of [":set ", ":set g "].entries()) {
	const control = await parse(`{:global g; ${prefix}1}`);
	const braceIl = await parse(`{:global g; ${prefix}{1;2}}`);
	const discriminatorIl = await parse(`{:global g; ${prefix}{(1,2)}}`);
	rows.push({
		verb: "set",
		slot: `#${index}`,
		outcome: classify(control, braceIl, discriminatorIl),
		control,
		braceIl,
		discriminatorIl,
	});
}
for (const name of ["value", "name", "do"]) {
	const control = await parse(`{:global g; :set g ${name}=1}`);
	const braceIl = await parse(`{:global g; :set g ${name}={1;2}}`);
	const discriminatorIl = await parse(`{:global g; :set g ${name}={(1,2)}}`);
	rows.push({
		verb: "set",
		slot: name,
		outcome: classify(control, braceIl, discriminatorIl),
		control,
		braceIl,
		discriminatorIl,
	});
}

for (const verb of verbs.filter((v) => v !== "set")) {
	// Positional 0 and 1: `:local z {1;2}` puts the literal in the VALUE slot
	// while `:local {1;2}` puts it in the NAME slot, and only one of those is an
	// array. The lexer knows a positional's index, so the table records it.
	for (const [index, prefix] of [`:${verb} `, `:${verb} x `].entries()) {
		const control = await parse(`${prefix}1`);
		const braceIl = await parse(`${prefix}{1;2}`);
		const discriminatorIl = await parse(`${prefix}{(1,2)}`);
		rows.push({
			verb,
			slot: `#${index}`,
			outcome: classify(control, braceIl, discriminatorIl),
			control,
			braceIl,
			discriminatorIl,
		});
	}
	for (const name of await completions(`:${verb} `, "arg")) {
		const control = await parse(`:${verb} ${name}=1`);
		const braceIl = await parse(`:${verb} ${name}={1;2}`);
		const discriminatorIl = await parse(`:${verb} ${name}={(1,2)}`);
		rows.push({
			verb,
			slot: name,
			outcome: classify(control, braceIl, discriminatorIl),
			control,
			braceIl,
			discriminatorIl,
		});
	}
}

const counts: Record<Outcome, number> = {
	array: 0,
	code: 0,
	text: 0,
	error: 0,
	inconclusive: 0,
};
for (const row of rows) counts[row.outcome]++;
console.log(`${rows.length} slots across ${verbs.length} verbs:`, counts);

for (const outcome of ["array", "code", "text", "inconclusive"] as const) {
	console.log(`\n-- ${outcome} --`);
	for (const row of rows.filter((r) => r.outcome === outcome)) {
		console.log(
			`  :${row.verb} ${row.slot}`.padEnd(34) +
				(outcome === "array" ? "" : `  ${row.discriminatorIl.slice(0, 80)}`),
		);
	}
}

const res = (await chr.rest("/system/resource")) as Record<string, string>;
await Bun.write(
	".scratch/explain-225-brace-slot-sweep.json",
	`${JSON.stringify(
		{ version: res.version, captured: new Date().toISOString(), rows },
		null,
		"\t",
	)}\n`,
);
console.log("\nwrote .scratch/explain-225-brace-slot-sweep.json");
