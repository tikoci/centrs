/**
 * #296 — re-derive the RouterOS version floors the `explain` integration tests
 * gate on.
 *
 * `test/integration/explain-values.test.ts` asserts device behaviour that is
 * NOT constant across the four QA channels, so the must-pass `long-term` leg
 * went red while `stable`/`testing`/`development` stayed green. This probe asks
 * one CHR per version the two questions that split, plus the two that set the
 * older floor, so the next version bump is a re-run rather than an archaeology
 * exercise.
 *
 * Durable answer: `TOBOOL_STRING_COERCED_SINCE` and
 * `PROPLIST_HIGHLIGHT_SPLIT_SINCE` in `test/integration/chr.ts`.
 *
 * Probes, per version:
 *   - `:tobool "yes"/"no"/0/1`             — signature 1 (#296)
 *   - highlight `.proplist={name;comment}` — signature 2, the error offset
 *   - `:parse` over ALL FIVE brace inputs the test loops — the wording the
 *     test's `toMatch` has to accept, asked on the same bytes the test sends
 *     (via `routerOsStringLiteral`, so both oracles see one program)
 *   - `[:typeof 00:11:22:33:44:55]` and `{100000w}` — the 7.15.3 cliff that
 *     sets the *lower* bound of what this file can be run against
 *
 * ## Measured 2026-08-14 (Intel Mac, HVF, qemu 11.0.3, quickchr 0.4.7)
 *
 * Every row below was booted; see the two constants for the resulting gates.
 *
 * | Version | explain-values | explain-string-escape | Note |
 * | ------- | -------------- | --------------------- | ---- |
 * | 7.15.3 | FAIL 2/3 | — | MAC `00:11:22:33:44:55` is `time` not `str`; `100000w` still `time` (MAX_TIME cliff) |
 * | 7.16 | PASS 3/3 | FAIL 1/2 | valid hex escape `"\xx"` highlight/parse differs |
 * | 7.16.2 | PASS 3/3 | FAIL 1/2 | same |
 * | 7.17 | PASS 3/3 | PASS 2/2 | oldest version both files pass on |
 * | 7.17.2 | PASS 3/3 | PASS 2/2 | |
 * | 7.18.2 | PASS 3/3 | PASS 2/2 | |
 * | 7.19.2 | PASS 3/3 | PASS 2/2 | |
 * | 7.20.8 | PASS 3/3 | PASS 2/2 | `MIN_PROVISION_VERSION` |
 * | 7.21.5 | PASS 3/3 | PASS 2/2 | long-term; `:tobool` old + highlight old |
 * | 7.22 | PASS 3/3 | — | `:tobool` NEW, highlight OLD — the split that made one threshold wrong |
 * | 7.22.1 | PASS 3/3 | — | same |
 * | 7.23beta5 | PASS 3/3 | PASS 2/2 | highlight NEW |
 * | 7.23 | PASS 3/3 | — | |
 * | 7.23.3 | PASS 3/3 | PASS 2/2 | stable; the baseline #296 was written against |
 *
 * The `explain-values` passes at and above 7.21.5 are *after* the #296 gating;
 * before it, 7.21.5/7.22/7.22.1 failed.
 *
 * ## Boundaries this probe established, and the ones it did not
 *
 * - `:tobool "yes"/"no"` → `nil`/empty on 7.20.8 and 7.21.5, `bool`/`true`
 *   on 7.22. Both sides adjacent, so the 7.22 threshold is exact.
 * - `.proplist` highlight error offset → 17 (the `.`) up to 7.22.1, 27 (the
 *   `{`) from 7.23beta5. **7.23beta1..beta4 were never booted**, so the true
 *   boundary is somewhere in `(7.22.1, 7.23beta5]`; the constant names
 *   `7.23beta1` because that is the first build of the 7.23 line and any
 *   choice inside the gap classifies every version CI runs identically.
 *   Booting a 7.23beta1..4 is what would narrow it.
 *
 * Run:
 *   bun run explain:probe:version-floors
 *   bun run explain:probe:version-floors -- --versions 7.21.5,7.22,7.23beta5
 *   bun run explain:probe:version-floors -- --versions 7.20.8 --json
 *
 * Each version boots a throwaway CHR (x86, cached image) and removes it.
 * To re-run the exact test assertions instead of these probes:
 *   CENTRS_CHR_VERSION=7.21.5 CENTRS_RUN_FAST_INTEGRATION=1 bun test \
 *     test/integration/explain-values.test.ts \
 *     test/integration/explain-string-escape.test.ts
 */
import { routerOsStringLiteral } from "../../src/core/routeros-string.ts";
import { openChr, type ProbeChr, probeOutputPath } from "./chr.ts";

/**
 * The default sweep: every version booted for #296. Narrow it with `--versions`
 * — a full sweep is ~14 boots.
 */
const DEFAULT_VERSIONS = [
	"7.15.3",
	"7.16",
	"7.16.2",
	"7.17",
	"7.17.2",
	"7.18.2",
	"7.19.2",
	"7.20.8",
	"7.21.5",
	"7.22",
	"7.22.1",
	"7.23beta5",
	"7.23",
	"7.23.3",
] as const;

/**
 * The exact five inputs `explain-values.test.ts` loops over where a brace array
 * is legal but the whole command still fails to parse. The test asserts a
 * highlight offset AND that `:parse` rejects; this probe reports the device's
 * wording for all five so the test's matcher is grounded rather than guessed.
 */
const BRACE_INPUTS = [
	"/ip/route/add comment={1;2}",
	"/ip/dns/set servers={1.1.1.1;8.8.8.8}",
	"/interface/print .proplist={name;comment}",
	"ip route add comment={1;2}",
	":log info message={1;2}",
] as const;

/** The input whose highlight offset moves between versions (#296 signature 2). */
const PROPLIST_INPUT = "/interface/print .proplist={name;comment}";

interface FloorProbe {
	requested: string;
	resolved: string;
	/** `:tobool` over string and numeric arguments — signature 1. */
	tobool: {
		typeofYes: string;
		tostrYes: string;
		tostrNo: string;
		tostr0: string;
		tostr1: string;
		raw: string;
	};
	/** Highlight offsets for the `.proplist` input — signature 2. */
	proplistHighlight: {
		firstErrorAt: number;
		braceAt: number;
		dotAt: number;
		/** Which of the two the device picked, or `other` if neither. */
		verdict: "brace" | "dot" | "other";
		csv: string;
	};
	/** `:parse` output per brace input, keyed by the input itself. */
	parseWording: Record<string, string>;
	/** The 7.15.3 cliff: MAC literals classed `time` rather than `str`. */
	macTypeof: string;
	/** The 7.15.3 cliff: `100000w` past MAX_TIME. */
	longTimeMemberTypeof: string;
}

function flagValue(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function parseVersions(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(/[,\s]+/)
		.map((value) => value.trim())
		.filter(Boolean);
}

function outputOf(result: unknown): string {
	return String((result as { output?: unknown }).output ?? "").replaceAll(
		"\r\n",
		"\n",
	);
}

async function highlightClasses(
	chr: ProbeChr,
	input: string,
): Promise<string[]> {
	const rows = (await chr.rest("/console/inspect", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ request: "highlight", input }),
	})) as { highlight?: string }[];
	const csv = rows[0]?.highlight ?? "";
	return csv === "" ? [] : csv.split(",");
}

async function probeVersion(requested: string): Promise<FloorProbe> {
	const chr = await openChr({
		reuse: undefined,
		name: `centrs-296-${requested.replaceAll(".", "-")}`,
		version: requested,
	});
	try {
		const resource = (await chr.rest("/system/resource")) as Record<
			string,
			string
		>;
		const resolved = resource["version"] ?? "(unknown)";

		const toboolRaw = outputOf(
			await chr.exec(
				':put [:typeof [:tobool "yes"]]; :put [:tostr [:tobool "yes"]]; :put [:tostr [:tobool "no"]]; :put [:tostr [:tobool 0]]; :put [:tostr [:tobool 1]]',
			),
		);
		// Five `:put`s, one line each. On <= 7.21.x lines 1 and 2 come back empty
		// because `[:tobool "yes"]` is `nil`, so index — never filter — the lines.
		const toboolLines = toboolRaw.split("\n");

		const classes = await highlightClasses(chr, PROPLIST_INPUT);
		const firstErrorAt = classes.indexOf("error");
		const braceAt = PROPLIST_INPUT.indexOf("{");
		const dotAt = PROPLIST_INPUT.indexOf(".proplist");

		const parseWording: Record<string, string> = {};
		for (const input of BRACE_INPUTS) {
			// Same bytes the test sends: `routerOsStringLiteral` escapes `$` so the
			// device parses the input rather than a substituted rewrite of it.
			parseWording[input] = outputOf(
				await chr.exec(`:put [:parse ${routerOsStringLiteral(input)}]`),
			).trim();
		}

		return {
			requested,
			resolved,
			tobool: {
				typeofYes: toboolLines[0] ?? "",
				tostrYes: toboolLines[1] ?? "",
				tostrNo: toboolLines[2] ?? "",
				tostr0: toboolLines[3] ?? "",
				tostr1: toboolLines[4] ?? "",
				raw: toboolRaw,
			},
			proplistHighlight: {
				firstErrorAt,
				braceAt,
				dotAt,
				verdict:
					firstErrorAt === braceAt
						? "brace"
						: firstErrorAt === dotAt
							? "dot"
							: "other",
				csv: classes.join(","),
			},
			parseWording,
			macTypeof: outputOf(
				await chr.exec(":put [:typeof 00:11:22:33:44:55]"),
			).trim(),
			longTimeMemberTypeof: outputOf(
				await chr.exec("{ :local z {100000w}; :put [:typeof ($z->0)] }"),
			).trim(),
		};
	} finally {
		await chr.remove();
	}
}

function renderTable(results: readonly FloorProbe[]): string {
	const lines = [
		'| Requested | Resolved | `:tobool "yes"` typeof/tostr | hl `.proplist` | MAC | `{100000w}` |',
		"| --- | --- | --- | --- | --- | --- |",
	];
	for (const r of results) {
		lines.push(
			`| ${r.requested} | ${r.resolved} | ${JSON.stringify(r.tobool.typeofYes)}/${JSON.stringify(r.tobool.tostrYes)} | ${r.proplistHighlight.firstErrorAt} (${r.proplistHighlight.verdict}) | ${r.macTypeof} | ${r.longTimeMemberTypeof} |`,
		);
	}
	return lines.join("\n");
}

/**
 * Every distinct `:parse` wording seen, with the versions that produced it.
 * This is the part that decides what the test's `toMatch` must accept: a
 * matcher narrower than this set turns a passing leg red.
 */
function renderWordings(results: readonly FloorProbe[]): string {
	const byWording = new Map<string, string[]>();
	for (const r of results) {
		for (const wording of Object.values(r.parseWording)) {
			const seen = byWording.get(wording) ?? [];
			if (!seen.includes(r.resolved)) seen.push(r.resolved);
			byWording.set(wording, seen);
		}
	}
	return [...byWording]
		.map(
			([wording, versions]) =>
				`  ${JSON.stringify(wording)}\n      ${versions.join(", ")}`,
		)
		.join("\n");
}

const args = Bun.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
	console.log(
		`explain-version-floors — re-derive the #296 version gates on real CHRs

  bun run explain:probe:version-floors
  bun run explain:probe:version-floors -- --versions 7.21.5,7.22,7.23beta5
  bun run explain:probe:version-floors -- --versions 7.20.8 --json

Default sweep (${DEFAULT_VERSIONS.length} boots): ${DEFAULT_VERSIONS.join(", ")}
Durable answer: TOBOOL_STRING_COERCED_SINCE / PROPLIST_HIGHLIGHT_SPLIT_SINCE
in test/integration/chr.ts. See this file's header for the measured table.`,
	);
	process.exit(0);
}

const versions = parseVersions(flagValue(args, "--versions"));
const toProbe = versions.length ? versions : [...DEFAULT_VERSIONS];
const wantJson = args.includes("--json");

console.log(`Probing ${toProbe.length} version(s): ${toProbe.join(", ")}\n`);

const results: FloorProbe[] = [];
const failures: { version: string; error: string }[] = [];

for (const version of toProbe) {
	console.log(`=== ${version} ===`);
	try {
		const result = await probeVersion(version);
		results.push(result);
		console.log(`  resolved:  ${result.resolved}`);
		console.log(`  :tobool    ${JSON.stringify(result.tobool.raw)}`);
		console.log(
			`  highlight  first error @${result.proplistHighlight.firstErrorAt} (${result.proplistHighlight.verdict}; brace ${result.proplistHighlight.braceAt}, dot ${result.proplistHighlight.dotAt})`,
		);
		for (const [input, wording] of Object.entries(result.parseWording)) {
			console.log(`  :parse     ${input} -> ${JSON.stringify(wording)}`);
		}
		console.log(
			`  cliffs     MAC=${result.macTypeof} 100000w=${result.longTimeMemberTypeof}`,
		);
	} catch (error) {
		// A boot failure is a fact about the probe run, not a device answer, so it
		// is reported separately and never lands in the results table as a row.
		const message = error instanceof Error ? error.message : String(error);
		failures.push({ version, error: message });
		console.error(`  FAILED: ${message}`);
	}
	console.log("");
}

if (results.length > 0) {
	console.log(renderTable(results));
	console.log(
		`\nDistinct \`:parse\` wordings across ${BRACE_INPUTS.length} brace inputs:`,
	);
	console.log(renderWordings(results));
}

if (failures.length > 0) {
	console.log(`\n${failures.length} version(s) did not boot:`);
	for (const f of failures) console.log(`  ${f.version}: ${f.error}`);
}

const capture = {
	issue: 296,
	oracles: ["exec", "highlight"],
	captured: new Date().toISOString(),
	requested: toProbe,
	braceInputs: BRACE_INPUTS,
	results,
	failures,
};

const outPath = await probeOutputPath("explain-296-version-floors.json");
await Bun.write(outPath, `${JSON.stringify(capture, null, "\t")}\n`);
console.log(`\nwrote ${outPath}`);

if (wantJson) {
	console.log(JSON.stringify(capture, null, "\t"));
}

if (results.length === 0) {
	console.error("no version produced a result");
	process.exit(1);
}
