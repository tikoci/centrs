import { describe, expect, test } from "bun:test";
import { explainCommand } from "../../src/explain.ts";
import {
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

function outputOf(result: unknown): string {
	return String((result as { output?: unknown }).output ?? "").replaceAll(
		"\r\n",
		"\n",
	);
}

function rosString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

describeFast("explain value facts against CHR", () => {
	test("example 26 keeps shape hints separate from live type and context", async () => {
		const started = await startIntegrationChr();
		try {
			const scalar = outputOf(
				await started.chr.exec(':put [:typeof 2.2]; :put [:typeof "2.2"]'),
			);
			expect(scalar).toBe("ip\nstr");

			const firewall = outputOf(
				await started.chr.exec(
					`:put [:parse ${rosString("/ip/firewall/filter/add chain=input action=accept src-address=2.2")}]`,
				),
			);
			expect(firewall).toContain("src-address=;2.0.0.2");

			const duration = outputOf(
				await started.chr.exec(
					`:put [:parse ${rosString("/tool/netwatch/add host=1.1.1.1 interval=2.2")}]`,
				),
			);
			expect(duration).toContain("interval=00:00:02.200");

			const data = explainCommand(':local x 2.2; :set x "2.2"');
			expect(data.values.occurrences.map((value) => value.facts)).toEqual([
				{ shapeHints: { values: ["num", "ip"], ev: "e9" } },
				{ shapeHints: { values: ["str"], ev: "e9" } },
			]);
			expect(
				data.values.occurrences.every(
					(value) =>
						value.facts.observedType === undefined &&
						value.facts.schemaType === undefined,
				),
			).toBe(true);

			await recordIntegrationEvidence({
				suite: "explain value facts against CHR",
				command: "explain",
				protocol: "rest-api (:typeof + :parse IL)",
				routerosVersion: started.chr.state.version,
				quickChrName: started.chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [26],
			});
		} finally {
			await started.chr.destroy();
		}
	}, 300_000);
});
