import { describe, expect, test } from "bun:test";
import { routerOsStringLiteral } from "../../src/core/routeros-string.ts";
import { explainCommand } from "../../src/explain.ts";
import {
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

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

async function parseText(
	chr: { exec(command: string): Promise<unknown> },
	input: string,
): Promise<string> {
	const cmd = `:put [:parse ${routerOsStringLiteral(input)}]`;
	const out = String(
		((await chr.exec(cmd)) as { output?: string }).output ?? "",
	).replaceAll("\r\n", "\n");
	return out.trim();
}

async function parseOk(
	chr: { exec(command: string): Promise<unknown> },
	input: string,
): Promise<boolean> {
	return (await parseText(chr, input)).startsWith("(evl");
}

async function parseFails(
	chr: { exec(command: string): Promise<unknown> },
	input: string,
): Promise<boolean> {
	const text = await parseText(chr, input);
	return (
		text.includes("expected message value") ||
		text.includes("syntax error") ||
		text.includes("expected value value")
	);
}

/**
 * A RouterOS console rejection is PROSE where a result would be a value, and it
 * always opens with one of these verbs. Matching the opening word (rather than
 * `expected .* value`) keeps forms like `expected end of command` and
 * `bad command name` on the reject side — a narrower pattern would score a real
 * rejection as an acceptance and silently weaken every grounding assertion
 * below (#254 review). Same predicate as the corpus audit in
 * `.scratch/explain-252-escape-corpus-audit.ts`.
 */
const CONSOLE_REJECTION =
	/^(syntax error|expected |missing |invalid |unknown |unexpected |no such |bad )/i;

/**
 * Run the input itself and report whether RouterOS accepted it.
 *
 * Stronger than the `:put [:parse …]` wrapper for #252's rows: the wrapper
 * re-escapes the payload, which is exactly what the newly-grounded escapes are
 * about, so a wrapper artifact would be indistinguishable from a real verdict.
 */
async function execAccepts(
	chr: { exec(command: string): Promise<unknown> },
	input: string,
): Promise<boolean> {
	const out = String(
		((await chr.exec(input)) as { output?: string }).output ?? "",
	).trim();
	return !CONSOLE_REJECTION.test(out);
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
			// \$ is valid per manual and highlight (escaped,escaped, no error);
			// the :parse wrapper (outer string escaping) makes parseOk unreliable
			// for this escape, so ground it via highlight + explainCommand only.

			for (const esc of [...validSingle, ...validHex]) {
				const input = `:put "${esc}"`;
				const classes = await highlightClasses(started.chr, input);
				expect(classes).not.toContain("error");
				expect(await parseOk(started.chr, input)).toBe(true);
				expect(explainCommand(input).verdict).toBe("pass");
			}

			// \$ ground via highlight (parse wrapper artifact: outer escaping turns \$ into $)
			{
				const input = ':put "\\$"';
				const classes = await highlightClasses(started.chr, input);
				expect(classes).not.toContain("error");
				expect(explainCommand(input).verdict).toBe("pass");
			}
			// Lowercase hex second digit is rejected (highlight error, :parse fail).
			// `\\ff` is excluded: it is `\\f` + literal `f`, checked as valid below.
			for (const esc of ["\\0a", "\\4c", "\\5f"]) {
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
				expect(await parseFails(started.chr, input)).toBe(true);
				expect(explainCommand(input).verdict).toBe("fail");
			}

			// Unknown escapes: highlight error at the escaped char, :parse fail
			for (const esc of ["\\q", "\\x", "\\x0a", "\\c"]) {
				const input = `:put "${esc}"`;
				const classes = await highlightClasses(started.chr, input);
				expect(classes).toContain("error");
				expect(await parseOk(started.chr, input)).toBe(false);
				expect(await parseFails(started.chr, input)).toBe(true);
				expect(explainCommand(input).verdict).toBe("fail");
			}

			// The issue's three rows
			for (const input of [':put "\\q"', ':put "\\x0a"', ':put "\\0a"']) {
				const classes = await highlightClasses(started.chr, input);
				expect(classes).toContain("error");
				expect(await parseOk(started.chr, input)).toBe(false);
				expect(await parseFails(started.chr, input)).toBe(true);
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

	// #252 — #251 built the allow-list from the manual's table and treated it as
	// closed, so 44 device-valid corpus scripts started reading `fail`. These
	// rows are the byte sweep's answers: the escapes RouterOS accepts that the
	// manual never lists.
	test("escapes outside the manual's table that RouterOS accepts (#252)", async () => {
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

			// `\?` is absent from the manual but classes `escaped` and evaluates to `?`.
			{
				const input = ':put "\\?"';
				expect(await highlightClasses(started.chr, input)).not.toContain(
					"error",
				);
				expect(await execAccepts(started.chr, input)).toBe(true);
				expect(explainCommand(input).verdict).toBe("pass");
			}

			// `\` before whitespace is a line continuation INSIDE a string, not only
			// in code — the device swallows the pair and emits nothing.
			for (const ws of [" ", "\t", "\r", "\n", "\r\n"]) {
				const input = `:put "a\\${ws}b"`;
				expect(await highlightClasses(started.chr, input)).not.toContain(
					"error",
				);
				expect(await execAccepts(started.chr, input)).toBe(true);
				expect(explainCommand(input).verdict).toBe("pass");
			}

			// The multi-line `on-event=` shape that 26 corpus scripts use.
			{
				const input =
					'/system/scheduler/add name=c252 on-event=":global AT;\\\n    :put $AT"';
				expect(await highlightClasses(started.chr, input)).not.toContain(
					"error",
				);
				expect(explainCommand(input).verdict).not.toBe("fail");
			}

			// The sweep's REJECT side must stay rejected: a backslash before a
			// non-whitespace, non-table byte is still a hard error, and so is
			// `\` + non-ASCII (the corpus `\”` row).
			for (const input of [
				':put "a\\qb"',
				':put "a\\;b"',
				':put "a\\}b"',
				':put "a\\]b"',
				':put "a\\(b"',
				':put "a\\”b"',
			]) {
				expect(await highlightClasses(started.chr, input)).toContain("error");
				expect(await execAccepts(started.chr, input)).toBe(false);
				expect(explainCommand(input).verdict).toBe("fail");
			}

			await recordIntegrationEvidence({
				suite: "explain string escapes against CHR (#252)",
				command: "highlight + execute",
				protocol: "rest-api",
				routerosVersion: version,
				boardName,
				quickChrName: started.chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [252],
			});
		} finally {
			await started.chr.destroy();
		}
	}, 300_000);
});
