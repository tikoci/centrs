import { describe, expect, test } from "bun:test";
import { routerOsStringLiteral } from "../../src/core/routeros-string.ts";
import fixture from "../fixtures/explain/token-faults.json";
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
	il?: string;
}

/**
 * The device half of `test/fixtures/explain/token-faults.json` (#504, #506,
 * #518); `test/unit/explain-token-faults.test.ts` is the offline half. A
 * rejected row must draw the fixture's exact `:parse` diagnostic, and an
 * accepted one the fixture's exact IL. The IL is what proves #504: a script
 * with a stray top-level `}` lowers to its prefix alone (`:put 1};:put 2` is
 * `(evl /putmessage=1)`).
 */
const COMPLAINT = /syntax error|expected |bad command|bad parameter|missing /;
describeFast("explain token faults against CHR", () => {
	test("examples 42-45: every row parses or fails as the fixture records", async () => {
		const started = await startIntegrationChr();
		try {
			const answers: Omit<Row, "issue">[] = [];
			for (const row of fixture.rows as Row[]) {
				const result = (await started.chr.exec(
					`:put [:parse ${routerOsStringLiteral(row.input)}]`,
				)) as { output?: unknown };
				const parsed = String(result.output ?? "")
					.replace(/\s+/g, " ")
					.trim();
				answers.push(
					COMPLAINT.test(parsed)
						? { input: row.input, device: "reject", parse: parsed }
						: { input: row.input, device: "accept", il: parsed },
				);
			}
			expect(answers).toEqual(
				(fixture.rows as Row[]).map((row) =>
					row.device === "accept"
						? { input: row.input, device: "accept", il: row.il }
						: { input: row.input, device: "reject", parse: row.parse },
				),
			);
			await recordIntegrationEvidence({
				suite: "explain token faults against CHR",
				command: "explain",
				protocol: "rest-api (:parse IL)",
				routerosVersion: started.chr.state.version,
				quickChrName: started.chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [42, 43, 44, 45],
			});
		} finally {
			await started.chr.destroy();
		}
	}, 300_000);
});
