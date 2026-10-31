/**
 * Re-verify the #203 import-blocker validity check against live RouterOS.
 *
 * Promoted from the q203 lab probe (history — see #203, #272): the four
 * `/import` failure causes the README calls semantic/device-state rejections
 * were each replayed through the two validators centrs itself uses —
 * `:put [:parse "<stmt>"]` (RouterOS's syntax gate) and
 * `/console/inspect request=highlight` (the structural/token gate) — with
 * rejecting controls at both ends, because a check that passes everything
 * proves nothing.
 *
 * Each row's durable answer lives in `commands/explain/README.md` (the q203
 * importability section): the blockers are accepted by both validators, and
 * `:parse` rejects every control. `highlight` is the weaker gate — it marks
 * only the nonexistent menu with an `error` class (the bad attribute reads
 * `obj-inactive`, the unterminated string carries no error class) — so each
 * row also pins the highlight answer it expects. This probe makes a RouterOS
 * version bump a rerun instead of an archaeology exercise.
 *
 * Run: bun run explain:probe:import-blocker-validity [versions...] [--dump]
 * (defaults: 7.23.2 7.24rc2, the versions the README claim was measured on).
 * Each version boots a throwaway CHR; the per-version capture lands in
 * `.scratch/explain-import-blocker-validity.v<version>.json` (in-flight by
 * design, not a fixture).
 */
import { routerOsStringLiteral } from "../../src/core/routeros-string.ts";
import { CentrsError } from "../../src/errors.ts";
import { classifyParseResult } from "../../src/protocols/mac-telnet-console.ts";
import { openChr, probeOutputPath } from "./chr.ts";

interface Case {
	label: string;
	stmt: string;
	/** The `:parse` answer — the gate that must reject every control. */
	expect: "valid" | "invalid";
	/** Whether `highlight` marks an `error` class anywhere in the statement. */
	highlight: "clean" | "flagged";
	why: string;
	versions?: string[];
}

const CASES: Case[] = [
	{
		label: "blocker 1 — dhcp-client add",
		stmt: "/ip dhcp-client add interface=ether1 name=client1",
		expect: "valid",
		highlight: "clean",
		why: "import failed on a DUPLICATE object, which is device state, not syntax",
	},
	{
		label: "blocker 2 — interface list set builtin",
		stmt: '/interface list set [ find name=all ] comment="contains all interfaces" exclude="" include="" name=all',
		expect: "valid",
		highlight: "clean",
		why: "import failed because the object is builtin — an authorization/state fact",
	},
	{
		label: "blocker 3 — snmp community, hide-sensitive form",
		stmt: "/snmp community add addresses=0.0.0.0/0 name=canary-snmp-priv security=private",
		expect: "valid",
		highlight: "clean",
		why: "import failed on a MISSING MANDATORY VALUE, checked at apply time",
	},
	{
		label: "blocker 4 — keymat-provider add (7.24rc2 only)",
		stmt: "/system keymat-provider add disabled=yes key-size=0 name=default qkd-cache-size=0 qkd-certificate=*0 type=qkd",
		expect: "valid",
		highlight: "clean",
		why: "import failed on a duplicate name inside the boot window",
		versions: ["7.24rc2"],
	},
	{
		// The control has to be a name that is no prefix of any real attribute.
		label: "CONTROL bad attribute",
		stmt: "/ip address add no-such-attr=198.51.100.1/32 interface=ether1",
		expect: "invalid",
		highlight: "clean",
		why: "unknown attribute — must be rejected or the probe proves nothing",
	},
	{
		label: "CONTROL unterminated string",
		stmt: '/system identity set name="unterminated',
		expect: "invalid",
		highlight: "clean",
		why: "genuine syntax error — must be rejected",
	},
	{
		label: "CONTROL nonexistent menu",
		stmt: "/no/such/menu add name=x",
		expect: "invalid",
		highlight: "flagged",
		why: "path does not exist on the device",
	},
];

const DUMP = Bun.argv.includes("--dump");

/**
 * Classify a `:parse` return with the production gate, so this probe's verdict
 * is the one `execute` would reach: "accepted", or the `validation/*` code.
 */
function parseVerdict(output: string, stmt: string): string {
	try {
		classifyParseResult(output, stmt, "rest-api");
		return "accepted";
	} catch (error) {
		if (!(error instanceof CentrsError)) throw error;
		return error.code;
	}
}

async function main(version: string) {
	const chr = await openChr({
		reuse: undefined,
		name: "centrs-q203-blocker-validity",
		version,
	});
	try {
		const resource = (await chr.rest("/system/resource")) as Record<
			string,
			string
		>;
		const actual = resource["version"]?.trim().split(/\s+/)[0] ?? "unknown";
		console.log(`\n=== RouterOS ${actual} ===`);
		const records: Record<string, unknown>[] = [];
		let mismatches = 0;
		for (const c of CASES) {
			if (c.versions && !c.versions.includes(version)) continue;

			const parse =
				(
					(await chr.exec(
						`:put [:parse ${routerOsStringLiteral(c.stmt)}]`,
					)) as { output?: string }
				).output?.trim() ?? "";
			const parseCode = parseVerdict(parse, c.stmt);
			const parseOk = parseCode === "accepted";

			// The highlight record is ONE comma-separated per-byte class string
			// (`"dir,cmd,cmd,error,none,…"`), not a list where a failure shows up
			// as `type: "error"` or a quoted `"error"` — two earlier passes of
			// this probe read it those ways and reported every control "clean",
			// i.e. it discriminated nothing. Split it and look for the class.
			// A failed or shapeless request throws: folding it into a verdict would
			// let a broken call match a `flagged` (or, empty, a `clean`) row.
			const res = (await chr.rest("/console/inspect", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ request: "highlight", input: c.stmt }),
			})) as { highlight?: string }[];
			const raw = JSON.stringify(res);
			const perByte = Array.isArray(res) ? res[0]?.highlight : undefined;
			if (!perByte)
				throw new Error(
					`${c.label}: no per-byte highlight classes in ${raw.slice(0, 120)}`,
				);
			const highlightOk = !perByte.split(",").includes("error");
			const highlightNote = `${raw.length}B raw${DUMP ? `: ${raw.slice(0, 400)}` : ""}`;

			// Each validator is checked against its own expectation: a combined
			// verdict lets one gate's rejection mask the other gate being broken.
			const verdict = parseOk && highlightOk ? "valid" : "invalid";
			const highlight = highlightOk ? "clean" : "flagged";
			const agrees =
				parseOk === (c.expect === "valid") && highlight === c.highlight
					? "OK "
					: "MISMATCH";
			if (agrees === "MISMATCH") mismatches++;
			console.log(
				`${agrees} ${c.label}\n     parse=${parseOk ? "accepted" : `REJECTED ${parseCode}`} (${JSON.stringify(parse.slice(0, 70))})\n     highlight=${highlight} (${highlightNote})\n     expected ${c.expect}, highlight ${c.highlight} — ${c.why}`,
			);
			records.push({
				label: c.label,
				stmt: c.stmt,
				expect: c.expect,
				parse,
				parseCode,
				parseOk,
				highlightOk,
				highlightNote,
				verdict,
			});
		}
		if (records.length === 0)
			throw new Error(`no cases ran for version ${version}`);
		const outPath = await probeOutputPath(
			`explain-import-blocker-validity.v${actual}.json`,
		);
		await Bun.write(
			outPath,
			`${JSON.stringify(
				{
					routerosVersion: actual,
					requestedVersion: version,
					capturedAt: new Date().toISOString(),
					mismatches,
					records,
				},
				null,
				2,
			)}\n`,
		);
		console.log(
			`\nWrote ${outPath}: ${records.length} rows, ${mismatches} mismatches`,
		);
		if (mismatches > 0)
			throw new Error(`${mismatches} blocker-validity rows mismatched`);
	} finally {
		await chr.remove();
	}
}

const versions = Bun.argv.slice(2).filter((a) => !a.startsWith("--"));
for (const version of versions.length > 0 ? versions : ["7.23.2", "7.24rc2"]) {
	await main(version);
}
