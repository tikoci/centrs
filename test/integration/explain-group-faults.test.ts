import { describe, expect, test } from "bun:test";
import { routerOsStringLiteral } from "../../src/core/routeros-string.ts";
import fixture from "../fixtures/explain/group-faults.json";
import {
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

interface Row {
	issue: string;
	input: string;
	device: "accept" | "reject";
	parse?: string;
}

/**
 * The device half of `test/fixtures/explain/group-faults.json` (#505, #509,
 * #511, #512); `test/unit/explain-group-faults.test.ts` is the offline half.
 * A rejected row must draw the fixture's exact `:parse` diagnostic, and an
 * accepted one IL with no complaint in it (an embedded `bad command` or
 * `expected … value` would be a rejection too). The complaint is matched by its
 * wordings, not `PARSE_REJECTED_HINT`'s bare `error`: accepted IL for
 * `:do {} on-error={}` carries the argument name `on-error`.
 */
const COMPLAINT = /syntax error|expected |bad command|bad parameter/;
describeFast("explain group faults against CHR", () => {
	test("examples 38-41: every row parses or fails as the fixture records", async () => {
		const started = await startIntegrationChr();
		try {
			const answers: { input: string; device: string; parse?: string }[] = [];
			for (const row of fixture.rows as Row[]) {
				const result = (await started.chr.exec(
					`:put [:parse ${routerOsStringLiteral(row.input)}]`,
				)) as { output?: unknown };
				const parsed = String(result.output ?? "")
					.replace(/\s+/g, " ")
					.trim();
				const accepted = parsed.startsWith("(") && !COMPLAINT.test(parsed);
				answers.push(
					accepted
						? { input: row.input, device: "accept" }
						: { input: row.input, device: "reject", parse: parsed },
				);
			}
			expect(answers).toEqual(
				(fixture.rows as Row[]).map((row) =>
					row.device === "accept"
						? { input: row.input, device: "accept" }
						: { input: row.input, device: "reject", parse: row.parse },
				),
			);
			await recordIntegrationEvidence({
				suite: "explain group faults against CHR",
				command: "explain",
				protocol: "rest-api (:parse IL)",
				routerosVersion: started.chr.state.version,
				quickChrName: started.chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [38, 39, 40, 41],
			});
		} finally {
			await started.chr.destroy();
		}
	}, 300_000);
});
