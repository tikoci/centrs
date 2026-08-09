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

			const v2Scalars = outputOf(
				await started.chr.exec(
					":put [:typeof 00:00:02]; :put [:tostr 00:60:00]; :put [:typeof *1]; :put [:typeof 00:11:22:33:44:55]",
				),
			);
			expect(v2Scalars).toBe("time\n01:00:00\nid\nstr");

			const v2Arrays = outputOf(
				await started.chr.exec(
					':put [:typeof (1,2,3)]; :put [:typeof {1;2;3}]; :put [:typeof ((1,2,3) . "a")]; :put [:tostr ((1,2,3) . "a")]; :put [:typeof (1 . 2)]',
				),
			);
			expect(v2Arrays).toBe("array\narray\narray\n1a;2a;3a\nstr");

			const producedTypes = outputOf(
				await started.chr.exec(
					':put [:typeof [:toarray ""]]; :local empty [:toarray ""]; :put [:typeof ($empty->0)]; :put [:typeof [:parse ":put hello"]]; :put [:tostr [:parse ":put hello"]]; :local unset; :put [:typeof $unset]; :put [:typeof [:nothing]]',
				),
			);
			expect(producedTypes).toBe("array\nnothing\ncode\n(code)\nnothing\nnil");

			const macParse = outputOf(
				await started.chr.exec(
					`:put [:parse ${rosString("/interface/ethernet/set [find default-name=ether1] mac-address=00:11:22:33:44:55")}]`,
				),
			);
			expect(macParse).toContain("mac-address=00:11:22:33:44:55");

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

			const booleanScalars = outputOf(
				await started.chr.exec(
					':put [:typeof true]; :put [:typeof false]; :put [:typeof yes]; :put [:typeof no]; :put [:typeof "true"]; :put [:typeof "yes"]; :put [:typeof 0]; :put [:typeof 1]',
				),
			);
			expect(booleanScalars).toBe("bool\nbool\nbool\nbool\nstr\nstr\nnum\nnum");

			const booleanAssignments = outputOf(
				await started.chr.exec(
					':global flag true; :put [:typeof $flag]; :set flag "true"; :put [:typeof $flag]; :set flag yes; :put [:typeof $flag]; :set flag "yes"; :put [:typeof $flag]',
				),
			);
			expect(booleanAssignments).toBe("bool\nstr\nbool\nstr");

			const toBool = outputOf(
				await started.chr.exec(
					':put [:typeof [:tobool "yes"]]; :put [:tostr [:tobool "yes"]]; :put [:tostr [:tobool "no"]]; :put [:tostr [:tobool 0]]; :put [:tostr [:tobool 1]]',
				),
			);
			expect(toBool).toBe("bool\ntrue\nfalse\nfalse\ntrue");

			for (const [suffix, disabled] of [
				["yes", "true"],
				["no", "false"],
				['"yes"', "true"],
				['"no"', "false"],
			] as const) {
				const index = suffix.includes("no") ? 2 : 1;
				const comment = `explain-bool-${index}-${suffix.length}`;
				expect(
					outputOf(
						await started.chr.exec(
							`/ip/address/add address=192.0.${index}.${suffix.startsWith('"') ? 2 : 1}/32 interface=ether1 comment=${comment} disabled=${suffix}`,
						),
					),
				).toBe("");
				const rows = (await started.chr.rest("/ip/address")) as Record<
					string,
					string
				>[];
				expect(
					rows.find((row) => row["comment"] === comment)?.["disabled"],
				).toBe(disabled);
			}
			expect(
				outputOf(
					await started.chr.exec(
						"/ip/address/add address=192.0.3.1/32 interface=ether1 disabled=true",
					),
				),
			).toContain("syntax error");

			const restBoolean = (await started.chr.rest("/ip/address", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					address: "198.51.100.1/32",
					interface: "ether1",
					disabled: true,
				}),
			})) as Record<string, string>;
			expect(restBoolean["disabled"]).toBe("true");
			const restString = (await started.chr.rest("/ip/address", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					address: "198.51.100.2/32",
					interface: "ether1",
					disabled: "false",
				}),
			})) as Record<string, string>;
			expect(restString["disabled"]).toBe("false");
			let numericRestError = "";
			try {
				await started.chr.rest("/ip/address", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						address: "198.51.100.3/32",
						interface: "ether1",
						disabled: 1,
					}),
				});
			} catch (error) {
				numericRestError = String(error);
			}
			expect(numericRestError).toContain("must be either yes or no");

			const data = explainCommand(
				':local x 2.2; :set x "2.2"; :local z (1,2,3); :local t 00:00:02; :local i *1; /ip/arp/add mac-address=00:11:22:33:44:55',
			);
			expect(data.values.occurrences.map((value) => value.facts)).toEqual([
				{ shapeHints: { values: ["ip"], ev: "e9" } },
				{ shapeHints: { values: ["str"], ev: "e9" } },
				{ shapeHints: { values: ["array"], ev: "e9" } },
				{ shapeHints: { values: ["time"], ev: "e9" } },
				{ shapeHints: { values: ["id"], ev: "e9" } },
				{ shapeHints: { values: ["mac"], ev: "e9" } },
			]);
			expect(
				data.values.occurrences.every(
					(value) =>
						value.facts.observedType === undefined &&
						value.facts.schemaType === undefined,
				),
			).toBe(true);
			expect(
				explainCommand(':local z ((1,2,3) . "a")').values.occurrences,
			).toEqual([]);
			expect(
				explainCommand(':local f [:parse ":put hello"]').values.occurrences,
			).toEqual([]);
			expect(
				explainCommand(':local empty [:toarray ""]').values.occurrences,
			).toEqual([]);

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
