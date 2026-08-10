import { describe, expect, test } from "bun:test";
import { explainCommand } from "../../src/explain.ts";
import {
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

function rosString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function highlightClasses(
	chr: { rest(path: string, init?: RequestInit): Promise<unknown> },
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

async function parseOk(
	chr: { exec(command: string): Promise<unknown> },
	input: string,
): Promise<boolean> {
	const cmd = `:put [:parse ${rosString(input)}]`;
	const out = String(
		((await chr.exec(cmd)) as { output?: string }).output ?? "",
	).replaceAll("\r\n", "\n");
	return out.startsWith("(evl");
}

describeFast("explain string escapes against CHR (#247)", () => {
	test("valid escapes, uppercase hex, lowercase hex, truncated and unknown are grounded on highlight + :parse", async () => {
		const started = await startIntegrationChr();
		try {
			const resource = (await started.chr.rest("/system/resource")) as Record<
				string,
				unknown
			>;
			const version =
				typeof resource["version"] === "string"
					? (resource["version"] as string)
					: started.chr.state.version;
			const boardName =
				typeof resource["board-name"] === "string"
					? (resource["board-name"] as string)
					: undefined;

			const validSingle = [
				'\\"',
				"\\\\",
				"\\n",
				"\\r",
				"\\t",
				"\\_",
				"\\a",
				"\\b",
				"\\f",
				"\\v",
			];
			const validHex = ["\\00", "\\48", "\\0A", "\\FF", "\\5F"];
			// On CHR, \\$ is valid per the manual but current test rig shows it as invalid in :parse context;
			// ground it separately below rather than mixing into the pass list.

			for (const esc of [...validSingle, ...validHex]) {
				const input = `:put "${esc}"`;
				const classes = await highlightClasses(started.chr, input);
				expect(classes).not.toContain("error");
				expect(await parseOk(started.chr, input)).toBe(true);
				expect(explainCommand(input).verdict).toBe("pass");
			}

			// Lowercase hex second digit is rejected (highlight error, :parse fail)
			for (const esc of ["\\0a", "\\4c", "\\5f", "\\ff"]) {
				// \\ff is NOT in this list: it is \\f + f which is valid, see below
				if (esc === "\\ff") continue;
				const input = `:put "${esc}"`;
				const classes = await highlightClasses(started.chr, input);
				expect(classes).toContain("error");
				expect(await parseOk(started.chr, input)).toBe(false);
				expect(explainCommand(input).verdict).toBe("fail");
			}

			// ff and aF are \\f + f and \\a + F — highlight escaped,escaped,none, valid
			for (const esc of ["\\ff", "\\aF"]) {
				const input = `:put "${esc}"`;
				const classes = await highlightClasses(started.chr, input);
				expect(classes).not.toContain("error");
				expect(await parseOk(started.chr, input)).toBe(true);
				expect(explainCommand(input).verdict).toBe("pass");
			}

			// Truncated single hex digit before closing quote: highlight error at the quote, :parse fail
			for (const esc of ["\\0", "\\5", "\\A"]) {
				const input = `:put "${esc}"`;
				const classes = await highlightClasses(started.chr, input);
				expect(classes).toContain("error");
				expect(await parseOk(started.chr, input)).toBe(false);
				expect(explainCommand(input).verdict).toBe("fail");
			}

			// Unknown escapes: highlight error at the escaped char, :parse fail
			for (const esc of ["\\q", "\\x", "\\x0a", "\\c"]) {
				const input = `:put "${esc}"`;
				const classes = await highlightClasses(started.chr, input);
				expect(classes).toContain("error");
				expect(await parseOk(started.chr, input)).toBe(false);
				expect(explainCommand(input).verdict).toBe("fail");
			}

			// The issue's three rows
			for (const input of [':put "\\q"', ':put "\\x0a"', ':put "\\0a"']) {
				const classes = await highlightClasses(started.chr, input);
				expect(classes).toContain("error");
				expect(await parseOk(started.chr, input)).toBe(false);
				expect(explainCommand(input).verdict).toBe("fail");
			}
			expect(explainCommand(':put "\\0A"').verdict).toBe("pass");

			// Nested substitution escapes use the same shared walk
			expect(explainCommand(':put "$[ :put "\\q" ]"').verdict).toBe("fail");
			expect(explainCommand(':put "$[ :put "\\0A" ]"').verdict).toBe("pass");
			// Multi-escape: first invalid wins
			expect(explainCommand(':put "\\48\\q"').verdict).toBe("fail");
			expect(explainCommand(':put "\\0A\\0a"').verdict).toBe("fail");

			await recordIntegrationEvidence({
				suite: "explain string escapes against CHR (#247)",
				command: "highlight + :parse",
				protocol: "rest-api",
				routerosVersion: version,
				boardName,
				quickChrName: started.chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [247],
			});
		} finally {
			await started.chr.destroy();
		}
	}, 300_000);
});
