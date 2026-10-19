import { describe, expect, test } from "bun:test";
import { explainCommand } from "../../src/explain.ts";
import { explainLiveEnvelope } from "../../src/explain-live.ts";
import { retrieveEnvelope } from "../../src/retrieve.ts";
import {
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";
import { runCliProcess } from "./cli-process.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;
describeFast("explain live foundation (#491)", () => {
	test("examples 11, 12, 16, 24 and 48: read-only probes on REST/native", async () => {
		const started = await startIntegrationChr();
		const captures: unknown[] = [];
		let packages: unknown;
		try {
			for (const via of ["rest-api", "native-api"]) {
				const connection = { quickchr: started.chr.name, via };
				if (packages === undefined) {
					const result = await retrieveEnvelope(
						{ ...connection, path: "/system/package" },
						{},
					);
					expect(result.ok).toBe(true);
					if (result.ok) packages = result.data;
				}
				const before = await retrieveEnvelope(
					{ ...connection, path: "/system/identity" },
					{},
				);
				const inputs = [
					"/ip/address add address=bogus interface=",
					":if (1 > 2) do={ :put x",
					"/ip/route add dst-address=10.9.0.0/16 blackhole=yes",
					"/interface set ether1 name x",
					"/interface print detail without-paging",
					"/interface set ether1 definitely-unknown-491=x",
					':put "🛰"; /system/identity/set name="explain-must-not-run-491"',
					':put [/system/identity/get name]; :put "\\$literal"',
					":put (1 +)",
				];
				for (const [index, input] of inputs.entries()) {
					const result = await explainLiveEnvelope(
						{ ...connection, input },
						{},
						{},
					);
					expect(result.ok).toBe(true);
					if (!result.ok) throw new Error(JSON.stringify(result));
					captures.push({
						input,
						via,
						environment: result.data.live?.environment,
						evidence: result.data.evidence.filter(
							(e) => e.source === "live-inspect",
						),
						live: result.data.live,
					});
					expect(result.meta.operation?.mode).toBe("live");
					expect(result.data.runtimeAcceptance).toBe("not-proven");
					expect(result.data.structure).toEqual(
						explainCommand(input).structure,
					);
					expect(result.data.live?.parse?.output.length).toBeGreaterThan(0);
					const evidence = result.data.evidence.filter(
						(e) => e.source === "live-inspect",
					);
					expect(
						evidence.every((e) =>
							e.version?.startsWith(started.chr.state.version),
						),
					).toBe(true);
					expect(
						evidence.some(
							(e) => e.outcome === "timeout" || e.outcome === "transport-error",
						),
					).toBe(false);
					if (index === 2)
						expect(
							result.data.diagnostics.find(
								(d) => d.code === "explain/live-inspect/highlight-error",
							)?.span.start,
						).toBe(47);
					if (index === 0)
						expect(result.data.live?.parse?.rejected).toBe(false);
					if (index === 1 || index === 5 || index === 8) {
						expect(result.data.live?.parse?.rejected).toBe(true);
						expect(result.data.live?.parse?.position?.line).toBeGreaterThan(0);
					}
					if (index === 3 || index === 4) {
						expect(result.data.live?.parse?.rejected).toBe(false);
						expect(result.data.live?.arguments[0]?.names).toContain(
							index === 3 ? "name" : "detail",
						);
						expect(result.data.live?.arguments[0]?.statementIds).toEqual([
							"s0",
						]);
						expect(
							result.data.diagnostics.some(
								(d) => d.code === "explain/live-inspect/obsolete-syntax",
							),
						).toBe(index === 3);
					}
				}
				const cli = await runCliProcess({
					args: [
						"explain",
						"--quickchr",
						started.chr.name,
						"--via",
						via,
						"/interface print detail without-paging",
						"--json",
					],
				});
				expect(cli.exitCode).toBe(0);
				expect(JSON.parse(cli.stdoutText).meta.operation.mode).toBe("live");
				const piped = await runCliProcess({
					args: [
						"explain",
						"--quickchr",
						started.chr.name,
						"--via",
						via,
						"--file",
						"-",
						"--json",
					],
					stdin: ":if (1 > 2) do={ :put x",
				});
				expect(piped.exitCode).toBe(2);
				expect(JSON.parse(piped.stdoutText).data.live.parse.rejected).toBe(
					true,
				);
				const oversized = await explainLiveEnvelope(
					{ ...connection, input: `#${"x".repeat(32767)}` },
					{},
					{},
				);
				expect(oversized.ok).toBe(true);
				if (oversized.ok) {
					expect(oversized.data.live?.parse?.rejected).toBe(false);
					expect(
						oversized.data.evidence.find((e) => e.probe === "highlight")
							?.outcome,
					).toBe("skipped");
					expect(oversized.data.input.truncated).toBe(false);
				}
				const after = await retrieveEnvelope(
					{ ...connection, path: "/system/identity" },
					{},
				);
				expect(after.ok).toBe(true);
				if (before.ok && after.ok) expect(after.data).toEqual(before.data);
				await recordIntegrationEvidence({
					suite: "explain-live",
					command: "explain",
					protocol: via,
					routerosVersion: started.chr.state.version,
					quickChrName: started.chr.name,
					exampleIds: [11, 12, 16, 24, 48],
				});
			}
			const capturePath = Bun.env["CENTRS_EXPLAIN_CAPTURE"];
			if (capturePath)
				await Bun.write(
					capturePath,
					`${JSON.stringify(
						{
							generator: "test/integration/explain-live.test.ts",
							packages,
							captures,
						},
						null,
						2,
					)}\n`,
				);
		} finally {
			await started.chr.destroy();
		}
	}, 180000);
});
