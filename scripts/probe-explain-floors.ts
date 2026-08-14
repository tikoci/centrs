// @ts-nocheck
/**
 * Probe RouterOS version floors for explain integration tests.
 *
 * Repro for #296 and the broader 7.20.8 / long-term sweep. Boots a throwaway
 * CHR per version (via @tikoci/quickchr) and probes the device directly —
 * cheaper than running the full `test/integration/*.test.ts` per version, but
 * the same ground truth. Also documents the flooring numbers collected
 * 2026-08-14 on an Intel Mac (HVF, qemu 11.0.3):
 *
 * | Version | explain-values (3 tests) | explain-string-escape (2 tests) | Notes |
 * |---------|---------------------------|-----------------------------------|-------|
 * | 7.15.3  | FAIL (2/3)                | —                                 | v2Scalars MAC `00:11:22:33:44:55` is `time` not `str`; `100000w` etc still `time` not `nothing` (MAX_TIME cliff) |
 * | 7.16    | PASS 3/3                  | FAIL (1/2)                        | string-escape valid hex `"\xx"` highlight/parse fails |
 * | 7.16.2  | PASS 3/3                  | FAIL (1/2)                        | same as 7.16 |
 * | 7.17    | PASS 3/3                  | PASS 2/2                          | |
 * | 7.17.2  | PASS 3/3                  | PASS 2/2                          | |
 * | 7.18.2  | PASS 3/3                  | PASS 2/2                          | |
 * | 7.19.2  | PASS 3/3                  | PASS 2/2                          | |
 * | 7.20.8  | PASS 3/3                  | PASS 2/2                          | long-term floor; MIN_PROVISION_VERSION |
 * | 7.21.5  | PASS 3/3                  | PASS 2/2                          | current long-term; :tobool string nil/empty (fixed by gating) |
 * | 7.22    | PASS 3/3                  | (not probed via test harness, device probe below) | :tobool new (bool), highlight old (17) — split |
 * | 7.22.1  | PASS 3/3*                 | —                                 | :tobool new, highlight old (17) |
 * | 7.23beta5 | PASS 3/3              | PASS 2/2*                           | highlight new (27), first verified 7.23 beta |
 * | 7.23    | PASS 3/3                  | —                                 | |
 * | 7.23.3  | PASS 3/3                  | PASS 2/2                          | current stable, baseline for #296 |
 *
 * * 7.22.1/7.23beta5 explain-values pass only after #296 gating (PROPLIST_HIGHLIGHT_SPLIT_SINCE=7.23beta1).
 *
 * Device-level split (grounded via :tobool + /console/inspect highlight):
 *
 * - :tobool "yes"/"no": nil/empty on ≤7.21.x, bool/true/false on ≥7.22 (7.22, 7.22.1, 7.23beta5, 7.23, 7.23.3)
 * - .proplist highlight: error at "." (17) on ≤7.22.x (7.21.5, 7.22, 7.22.1), at "{" (27) on ≥7.23beta5
 * - :parse for .proplist: "expected end of command (line 1 column 18)" on 7.21.5 vs "syntax error (line 1 column 28)" on ≥7.23
 *
 * Usage:
 *   bun scripts/probe-explain-floors.ts --versions 7.15.3,7.16.2,7.17,7.21.5,7.22,7.23beta5
 *   bun scripts/probe-explain-floors.ts --versions 7.20.8 --json
 *   bun scripts/probe-explain-floors.ts --help
 *
 * Each version boots a CHR (x86, cached, ~20s TCG on x64), probes, destroys.
 * For full integration harness validation (slower, but exact test assertions):
 *   CENTRS_CHR_VERSION=7.21.5 CENTRS_RUN_FAST_INTEGRATION=1 bun test test/integration/explain-values.test.ts test/integration/explain-string-escape.test.ts
 */

// QuickCHR is loaded dynamically (like test/integration/chr.ts) to avoid tsc following quickchr source

type ProbeResult = {
	version: string;
	resolvedVersion: string;
	tobool: {
		typeofYes: string;
		tostrYes: string;
		tostrNo: string;
		tostr0: string;
		tostr1: string;
		raw: string;
	};
	highlightProplist: {
		errorAt: number;
		braceAt: number;
		dotAt: number;
		csv?: string;
	};
	parseProplist: string;
	v2ScalarsMac?: string;
	memberTimeCliff?: string;
};

function flag(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function parseVersions(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

const QUICKCHR_MODULE = "@tikoci/quickchr";

async function probeOne(requestedVersion: string): Promise<ProbeResult> {
	const { QuickCHR } = (await import(QUICKCHR_MODULE)) as unknown as {
		QuickCHR: {
			start(opts: { version: string; arch: "x86" }): Promise<{
				state: { version: string };
				exec(cmd: string): Promise<unknown>;
				rest(path: string, init?: RequestInit): Promise<unknown>;
				destroy(): Promise<void>;
			}>;
		};
	};
	const chr = await QuickCHR.start({
		version: requestedVersion,
		arch: "x86" as const,
	});
	try {
		const resolvedVersion = chr.state.version;

		// :tobool probe — the #296 signature
		const toboolRaw = String(
			(
				(await chr.exec(
					':put [:typeof [:tobool "yes"]]; :put [:tostr [:tobool "yes"]]; :put [:tostr [:tobool "no"]]; :put [:tostr [:tobool 0]]; :put [:tostr [:tobool 1]]',
				)) as { output?: string }
			)?.output ?? "",
		).replaceAll("\r\n", "\n");
		const toboolLines = toboolRaw.split("\n");
		// toboolRaw is 5 lines: typeofYes, tostrYes, tostrNo, tostr0, tostr1
		// On 7.21.x, lines 1-2 are "nil" and "" (empty), but split gives ["nil","","","false","true"] or similar
		const tobool = {
			typeofYes: toboolLines[0] ?? "",
			tostrYes: toboolLines[1] ?? "",
			tostrNo: toboolLines[2] ?? "",
			tostr0: toboolLines[3] ?? "",
			tostr1: toboolLines[4] ?? "",
			raw: toboolRaw,
		};

		// highlight probe — the #296 second signature
		const input = "/interface/print .proplist={name;comment}";
		const rows = (await chr.rest("/console/inspect", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ request: "highlight", input }),
		})) as { highlight?: string }[];
		const csv = rows[0]?.highlight ?? "";
		const classes = csv ? csv.split(",") : [];
		const highlightProplist = {
			errorAt: classes.indexOf("error"),
			braceAt: input.indexOf("{"),
			dotAt: input.indexOf(".proplist"),
			csv,
		};

		const parseProplist = String(
			(
				(await chr.exec(
					`:put [:parse "/interface/print .proplist={name;comment}"]`,
				)) as { output?: string }
			)?.output ?? "",
		).replaceAll("\r\n", "\n");

		// v2Scalars MAC — the 7.15.3 cliff (explain-values ex 26)
		const v2ScalarsMac = String(
			(
				(await chr.exec(`:put [:typeof 00:11:22:33:44:55]`)) as {
					output?: string;
				}
			)?.output ?? "",
		)
			.replaceAll("\r\n", "\n")
			.trim();

		// memberTimeCliff — 7.15.3 still treats 100000w as time
		const memberTimeCliff = String(
			(
				(await chr.exec(`{ :local z {100000w}; :put [:typeof ($z->0)] }`)) as {
					output?: string;
				}
			)?.output ?? "",
		)
			.replaceAll("\r\n", "\n")
			.trim();

		return {
			version: requestedVersion,
			resolvedVersion,
			tobool,
			highlightProplist,
			parseProplist,
			v2ScalarsMac,
			memberTimeCliff,
		};
	} finally {
		await chr.destroy();
	}
}

function renderTable(results: ProbeResult[]): string {
	const lines: string[] = [];
	lines.push(
		'| Requested | Resolved | :tobool "yes" typeof/tostr | :tobool "no" tostr | hl .proplist error@ | :parse .proplist | MAC typeof | 100000w member |',
	);
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const r of results) {
		lines.push(
			`| ${r.version} | ${JSON.stringify(r.resolvedVersion)} | ${JSON.stringify(r.tobool.typeofYes)}/${JSON.stringify(r.tobool.tostrYes)} | ${JSON.stringify(r.tobool.tostrNo)} | ${r.highlightProplist.errorAt} (brace ${r.highlightProplist.braceAt}, dot ${r.highlightProplist.dotAt}) | ${JSON.stringify(r.parseProplist.trim())} | ${r.v2ScalarsMac} | ${r.memberTimeCliff} |`,
		);
	}
	return lines.join("\n");
}

async function main(args: readonly string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`probe-explain-floors — probe RouterOS version floors for explain tests

Usage:
  bun scripts/probe-explain-floors.ts --versions 7.15.3,7.16.2,7.17,7.21.5,7.22,7.23beta5
  bun scripts/probe-explain-floors.ts --versions 7.20.8 --json

Probes per version: :tobool "yes"/"no", highlight .proplist, :parse .proplist,
[:typeof 00:11:22:33:44:55], member {100000w}. Prints markdown table + JSON with --json.

Floors collected 2026-08-14: explain-values down to 7.16, explain-string-escape down to 7.17.
See file header for full table.
`);
		return 0;
	}

	const versionsRaw = flag(args, "--versions") ?? flag(args, "--version");
	const json = args.includes("--json");
	const versions = parseVersions(versionsRaw);
	const toProbe = versions.length
		? versions
		: [
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
			];

	console.log(`Probing ${toProbe.length} versions: ${toProbe.join(", ")}`);
	const results: ProbeResult[] = [];
	for (const version of toProbe) {
		console.log(`\n=== ${version} ===`);
		try {
			const r = await probeOne(version);
			results.push(r);
			console.log(`  resolved: ${r.resolvedVersion}`);
			console.log(`  toBool: ${JSON.stringify(r.tobool.raw)}`);
			console.log(
				`  highlight .proplist: error@${r.highlightProplist.errorAt} (brace ${r.highlightProplist.braceAt}, dot ${r.highlightProplist.dotAt})`,
			);
			console.log(
				`  parse .proplist: ${JSON.stringify(r.parseProplist.trim())}`,
			);
			console.log(
				`  MAC typeof: ${r.v2ScalarsMac}, 100000w: ${r.memberTimeCliff}`,
			);
		} catch (error) {
			console.error(`  failed: ${String(error)}`);
			results.push({
				version,
				resolvedVersion: `error: ${String(error)}`,
				tobool: {
					typeofYes: "error",
					tostrYes: "",
					tostrNo: "",
					tostr0: "",
					tostr1: "",
					raw: String(error),
				},
				highlightProplist: { errorAt: -1, braceAt: -1, dotAt: -1 },
				parseProplist: String(error),
			});
		}
	}

	console.log(`\n${renderTable(results)}`);
	if (json) {
		console.log("\n```json");
		console.log(JSON.stringify(results, null, 2));
		console.log("```");
	}
	return 0;
}

if (import.meta.main) {
	main(Bun.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(String(error));
			process.exit(1);
		});
}
