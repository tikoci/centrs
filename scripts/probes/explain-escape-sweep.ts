/**
 * #252 — sweep the REAL device-accepted string escape set.
 *
 * PR #251 built `VALID_SINGLE` by transcribing the manual's escape table and
 * treating it as closed. The corpus device oracles say RouterOS accepts more
 * (`\?`, `\`+newline, `\;`, `\}`, `\(`, `\]`, `\`+non-ASCII). Rather than patch
 * the list case by case, ask the device for the whole set.
 *
 * For every candidate character C we run three probes:
 *   highlight  :put "\C"   -> class at the escaped byte ("error" = rejected)
 *   highlight  :put "C"    -> CONTROL: is C even legal in a string unescaped?
 *   exec       :put "\C"   -> runtime accept/reject (the strongest oracle)
 *
 * The control matters: a raw `"` ends the string and a raw `$` starts a
 * substitution, so a difference there is about C, not about the escape.
 *
 * Run: bun run explain:probe:escapes [existing-chr-name]
 */
import { openChr, type ProbeChr, probeOutputPath } from "./chr.ts";

const REUSE = process.argv[2];

type Probe = { label: string; ch: string; note?: string };

const probes: Probe[] = [];
for (let b = 0x20; b <= 0x7e; b++)
	probes.push({
		label: `0x${b.toString(16).padStart(2, "0")}`,
		ch: String.fromCharCode(b),
	});
probes.push({ label: "0x09 TAB", ch: "\t" });
probes.push({ label: "0x0A LF", ch: "\n", note: "line continuation" });
probes.push({ label: "0x0D+0x0A CRLF", ch: "\r\n", note: "line continuation" });
probes.push({ label: "U+201D", ch: "”", note: "non-ASCII (corpus AT-chat)" });
probes.push({ label: "U+00E9", ch: "é", note: "non-ASCII latin-1" });

async function highlightClasses(
	chr: ProbeChr,
	input: string,
): Promise<string[]> {
	const rows = (await chr.rest("/console/inspect", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ request: "highlight", input }),
	})) as { highlight?: string }[];
	return (rows[0]?.highlight ?? "").split(",").filter(Boolean);
}

async function execOutcome(chr: ProbeChr, input: string): Promise<string> {
	try {
		const out = await chr.exec(input);
		const text = typeof out === "string" ? out : JSON.stringify(out);
		return /error|expected|syntax/i.test(text)
			? `REJECT ${text.slice(0, 70)}`
			: "accept";
	} catch (e) {
		return `REJECT ${String(e).slice(0, 70)}`;
	}
}

const chr = await openChr({ reuse: REUSE, name: "centrs-252" });

try {
	const res = (await chr.rest("/system/resource")) as Record<string, string>;
	console.log(
		`CHR ${res["version"]} (${res["architecture-name"]}) build ${res["build-time"]}\n`,
	);

	const rows: string[] = [];
	/** One structured record per candidate, so the capture is not just a banner. */
	const records: Record<string, unknown>[] = [];
	const accepted: string[] = [];
	const rejected: string[] = [];

	for (const p of probes) {
		const escaped = `:put "\\${p.ch}"`;
		const bare = `:put "${p.ch}"`;
		// index of the escaped character = after `:put "` + the backslash
		const at = ':put "'.length + 1;

		const hEsc = await highlightClasses(chr, escaped);
		const hBare = await highlightClasses(chr, bare);
		const clsEsc = hEsc[at] ?? "(none)";
		const clsBare = hBare[':put "'.length] ?? "(none)";
		const hlReject = hEsc.includes("error");
		const bareReject = hBare.includes("error");
		const ex = await execOutcome(chr, escaped);

		// The device has a POSITIVE class for a good escape (`escaped`), which is
		// a stronger signal than merely "no error token".
		const verdict = hlReject || ex.startsWith("REJECT") ? "REJECT" : "ACCEPT";
		(verdict === "ACCEPT" ? accepted : rejected).push(p.label);
		rows.push(
			`${verdict} ${p.label.padEnd(15)} clsEsc=${clsEsc.padEnd(12)} clsBare=${clsBare.padEnd(12)} bareErr=${bareReject ? "y" : "n"} exec=${ex}${p.note ? `  (${p.note})` : ""}`,
		);
		records.push({
			label: p.label,
			verdict,
			// TWO oracles, named per record: `highlight` gives the class at the
			// escaped byte, `exec` gives the runtime verdict. They are not
			// interchangeable, and the verdict above is their conjunction.
			highlightClassEscaped: clsEsc,
			highlightClassBare: clsBare,
			highlightRejectsBare: bareReject,
			execOutcome: ex,
			...(p.note ? { note: p.note } : {}),
		});
	}

	console.log(rows.join("\n"));
	console.log(`\nACCEPTED (${accepted.length}): ${accepted.join(" ")}`);
	console.log(`\nREJECTED (${rejected.length}): ${rejected.join(" ")}`);

	const outPath = await probeOutputPath("explain-252-escape-sweep.json");
	await Bun.write(
		outPath,
		`${JSON.stringify(
			{
				version: res["version"],
				architecture: res["architecture-name"],
				oracles: ["highlight", "exec"],
				captured: new Date().toISOString(),
				accepted,
				rejected,
				records,
			},
			null,
			"\t",
		)}\n`,
	);
	console.log(`\nwrote ${outPath}`);
} finally {
	if (!REUSE) await chr.remove();
}
