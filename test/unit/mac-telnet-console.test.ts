import { describe, expect, test } from "bun:test";
import { parseRouterOsPosition } from "../../src/core/routeros-errors.ts";
import { CentrsError } from "../../src/errors.ts";
import {
	classifyParseResult,
	emulateScreen,
	extractCommandOutput,
	ROUTEROS_PROMPT_RE,
} from "../../src/protocols/mac-telnet-console.ts";

import fixtureSource from "../fixtures/parse-oracle.json" with { type: "json" };

type FixtureEntry = {
	caption: string;
	input: string;
	raw: string;
	expectedContains: string;
	expectedAlsoContains?: string;
	mustHavePosition?: boolean;
	verdict: string;
	/** Set when `raw` is a verbatim `parseil_results.il_text` corpus fragment. */
	corpusScript?: string;
	corpusVersions?: string;
};

/**
 * Fixtures are REAL console responses captured from stock CHR 7.23.3 over
 * mac-telnet (`.scratch/mactelnet-*.ts` probes), plus the 7.23.3 parse-oracle
 * sweep in `.scratch/cliref-research/parse-oracle.json` (GH#230). `P` is the
 * prompt; `TAIL` reproduces RouterOS's trailing prompt redraw (4×CR, prompt,
 * space padding, CR, prompt) so the extractor is pinned against the device's
 * actual line discipline.
 */
const P = "[mt@CHR] > ";
const TAIL = `\r\r\r\r${P}${" ".repeat(61)}\r${P}`;

/** Build a captured response: `<echo>` then output lines, then the prompt redraw. */
function response(command: string, outputLines: string[]): string {
	const echo = `${command}\r${P}${command}\r\n`;
	const out = outputLines.map((line) => `\r${line}\r\n`).join("");
	return `${echo}${out}${TAIL}`;
}

describe("ROUTEROS_PROMPT_RE", () => {
	test("matches a root prompt", () => {
		expect(ROUTEROS_PROMPT_RE.test("[mt@CHR] >")).toBe(true);
		expect(ROUTEROS_PROMPT_RE.test("[admin@MikroTik] > ")).toBe(true);
	});

	test("matches a submenu prompt", () => {
		expect(ROUTEROS_PROMPT_RE.test("[mt@CHR] /ip/address>")).toBe(true);
	});

	test("does not match an echoed command line", () => {
		expect(ROUTEROS_PROMPT_RE.test("[mt@CHR] > /system/identity/print")).toBe(
			false,
		);
	});

	test("does not match the license prompt", () => {
		expect(
			ROUTEROS_PROMPT_RE.test(
				"Do you want to see the software license? [Y/n]: ",
			),
		).toBe(false);
	});
});

describe("emulateScreen", () => {
	test("collapses a CR-redrawn padded prompt into one line", () => {
		// The exact trailing redraw RouterOS sends.
		const lines = emulateScreen(TAIL).filter((l) => l.length > 0);
		expect(lines).toEqual(["[mt@CHR] >"]);
	});

	test("CR overwrites from column 0", () => {
		expect(emulateScreen("hello\rHELLO")).toEqual(["HELLO"]);
		expect(emulateScreen("hello world\rHELLO")).toEqual(["HELLO world"]);
	});

	test("strips the login ANSI size probe", () => {
		const probe = "\r\u001b[9999B\r\u001b[9999B\u001bZ  \u001b[6n";
		expect(emulateScreen(probe).join("")).toBe("");
	});

	test("keeps printable text across CRLF rows", () => {
		expect(emulateScreen("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
	});
});

describe("extractCommandOutput — real CHR 7.23.1 captures", () => {
	test("single-line output (/system/identity/print)", () => {
		const raw = response("/system/identity/print", ["  name: CHR"]);
		expect(extractCommandOutput(raw)).toBe("  name: CHR");
	});

	test(":put [:parse valid] → parsed (evl …) form", () => {
		const cmd =
			':put [:parse "/ip/address/add address=10.9.9.9/32 interface=ether1"]';
		const raw = response(cmd, [
			"(evl /ip/address/addaddress=10.9.9.9;32;interface=ether1)",
		]);
		expect(extractCommandOutput(raw)).toBe(
			"(evl /ip/address/addaddress=10.9.9.9;32;interface=ether1)",
		);
	});

	test(":put [:parse unknown-arg] → bad parameter in the parsed form", () => {
		const cmd = ':put [:parse "/ip/address/add no-such-arg=x"]';
		const raw = response(cmd, [
			"(evl bad parameter no-such-arg (line 1 column 28) /ip/address/add)",
		]);
		expect(extractCommandOutput(raw)).toContain("bad parameter no-such-arg");
	});

	test("a wrapped echo (command longer than a line) does not leak into output", () => {
		// The device wrapped the echoed command across two lines, then a successful
		// write returned straight to the prompt (no output).
		const cmd = "/ip/address/add address=10.9.9.9/32 interface=ether1";
		const split = 14;
		const part1 = cmd.slice(0, split);
		const part2 = cmd.slice(split);
		const raw = `${P}${part1}\r\n${part2}\r\n${TAIL}`;
		// Without the command, the wrapped tail leaks; with it the echo is stripped.
		expect(extractCommandOutput(raw)).toBe(part2);
		expect(extractCommandOutput(raw, cmd)).toBe("");
	});

	test("successful write produces empty output", () => {
		// A successful add prints nothing — straight back to the prompt.
		const raw = `/ip/address/add address=10.9.9.7/32 interface=ether1\r${P}/ip/address/add address=10.9.9.7/32 interface=ether1\r\n${TAIL}`;
		expect(extractCommandOutput(raw)).toBe("");
	});

	test("write with a bad parameter surfaces the console error string", () => {
		const cmd =
			"/ip/address/add address=10.9.9.6/32 interface=ether1 no-such-arg=x";
		const raw = response(cmd, ["bad parameter no-such-arg (line 1 column 65)"]);
		expect(extractCommandOutput(raw)).toBe(
			"bad parameter no-such-arg (line 1 column 65)",
		);
	});

	test("multi-row print output is preserved line by line", () => {
		const raw = response("/ip/address/print", [
			"Flags: D - DYNAMIC",
			"Columns: ADDRESS, NETWORK, INTERFACE, VRF",
			"#   ADDRESS       NETWORK   INTERFACE  VRF ",
			"0 D 10.0.2.15/24  10.0.2.0  ether1     main",
			"1   10.9.9.7/32   10.9.9.7  ether1     main",
		]);
		expect(extractCommandOutput(raw).split("\n")).toEqual([
			"Flags: D - DYNAMIC",
			"Columns: ADDRESS, NETWORK, INTERFACE, VRF",
			"#   ADDRESS       NETWORK   INTERFACE  VRF",
			"0 D 10.0.2.15/24  10.0.2.0  ether1     main",
			"1   10.9.9.7/32   10.9.9.7  ether1     main",
		]);
	});
});

describe("classifyParseResult surfaces error.position (JG-16; GH#230)", () => {
	test("unknown-attribute carries the console byte offset", () => {
		try {
			classifyParseResult(
				"bad parameter address (line 1 column 35)",
				"/ip/address/add comment=x",
			);
			throw new Error("expected classifyParseResult to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(CentrsError);
			expect((error as CentrsError).code).toBe("validation/unknown-attribute");
			expect((error as CentrsError).position).toEqual({ line: 1, column: 35 });
		}
	});

	test("syntax error carries the console byte offset", () => {
		try {
			classifyParseResult("syntax error (line 1 column 9)", "/ip/ address");
			throw new Error("expected classifyParseResult to throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("validation/syntax");
			expect((error as CentrsError).position).toEqual({ line: 1, column: 9 });
		}
	});

	test("a rejection with no diagnostic wrapper is not treated as syntax", () => {
		// Before the GH#230 blocker fix this bare string was (incorrectly)
		// classified as validation/syntax. Real diagnostics are wrapped:
		//   (<%% bad command name ...) or ... (line N column M)
		// A bare failure to resolve a token during execution (no diagnostic
		// wrapper) must not be misclassified by the :parse gate — it belongs
		// to RouterOS execution errors, not parse validation.
		expect(() =>
			classifyParseResult("bad command name", "bogus"),
		).not.toThrow();
	});

	test("GH#230: (evl bad parameter …) inside the parsed value is still unknown-attribute", () => {
		// Grounded sweep (CHR 7.23.3): a bad parameter is reported *inside* the
		// `(evl …)` return value, not as a thrown error.
		try {
			classifyParseResult(
				"(evl bad parameter bogus-attr (line 1 column 29) /ip/address/print)",
				"/ip address print bogus-attr=1",
			);
			throw new Error("expected classifyParseResult to throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("validation/unknown-attribute");
			expect((error as CentrsError).position).toEqual({ line: 1, column: 29 });
			expect(
				((error as CentrsError).context as Record<string, unknown>)[
					"parameter"
				],
			).toBe("bogus-attr");
		}
	});

	test("GH#230: (<%% bad command name …) inside the return is syntax", () => {
		try {
			classifyParseResult(
				"(<%% bad command name poe (line 1 column 21) poe;monitor)",
				"/interface ethernet poe monitor",
			);
			throw new Error("expected classifyParseResult to throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("validation/syntax");
			expect((error as CentrsError).position).toEqual({ line: 1, column: 21 });
		}
	});

	test("GH#230: bare (evl /canonical/path) is accepted (no throw)", () => {
		// Canonicalization too: abbreviated `addr` expands to `address` in the return.
		expect(() =>
			classifyParseResult("(evl /ip/address/print)", "/ip addr print"),
		).not.toThrow();
		expect(() =>
			classifyParseResult("(evl /interface/ethernet/print)", "/int eth print"),
		).not.toThrow();
	});

	test("validationSource records the actual via (REST / native-api in GH#230)", () => {
		try {
			classifyParseResult(
				"(evl bad parameter no-such-arg (line 1 column 28) /ip/address/add)",
				"/ip/address/add no-such-arg=x",
				"rest-api",
			);
			throw new Error("expected classifyParseResult to throw");
		} catch (error) {
			expect(
				((error as CentrsError).context as Record<string, unknown>)[
					"validationSource"
				],
			).toBe(":put [:parse ...] over rest-api");
		}
	});

	test("GH#230: empty/whitespace means unknown (the '/' / stray-} reach limit — classify itself stays literal)", () => {
		// `:` + `:put [:parse \"}\"]` returned `\"/\"` on CHR 7.23.3 — i.e. `:parse` does
		// NOT reject stray braces by itself. That is a reach-limit, not a gate to
		// add here (GH#230 cautions not to oversell `:parse`). The *classifier* for
		// the issue is literal: an empty return is not a `bad parameter`/`bad command
		// name`/`syntax error`, so classifyResult correctly returns (no throw).
		expect(() => classifyParseResult("", "/ip address print")).not.toThrow();
	});
});

describe("parse-oracle.json (GH#230 frozen fixtures, CHR 7.23.3)", () => {
	const oracle = fixtureSource as unknown as {
		chr: string;
		provenance: string;
		canonicalAccepted: FixtureEntry[];
		badParameter: FixtureEntry[];
		badCommandName: FixtureEntry[];
		syntaxExpected: FixtureEntry[];
		positionFixtures: ReadonlyArray<{
			caption: string;
			raw: string;
			line: number;
			column: number;
		}>;
	};

	test("fixture shape carries the class vocabulary", () => {
		expect(oracle.chr).toMatch(/7\.23/);
		expect(Array.isArray(oracle.canonicalAccepted)).toBe(true);
		expect(Array.isArray(oracle.badParameter)).toBe(true);
		expect(Array.isArray(oracle.badCommandName)).toBe(true);
		expect(Array.isArray(oracle.syntaxExpected)).toBe(true);
	});

	test("each canonical-accepted raw is the frozen return and does not throw", () => {
		for (const row of oracle.canonicalAccepted) {
			expect(row.raw).toContain("(evl ");
			// The raw is the exact captured printed value; `expectedContains`
			// must be a true substring of it (catches misspelled fixtures).
			expect(row.raw).toContain(row.expectedContains);
			expect(() => classifyParseResult(row.raw, row.input)).not.toThrow();
		}
	});

	// GH#230 blocker: for script-shaped input RouterOS echoes the statement
	// body in the accepted return (corpus-verified), so a bare English word
	// like `expected` appearing in source text must NOT be treated as a reject.
	// This pins the false-positive class directly (firewall
	// connection-tracking `where expected`, variable names, log strings —
	// ~1.3% FP on the corpus before the fix).
	test("script-shaped `expected` in content does not throw (GH#230 FP)", () => {
		// Select on the captured return itself, not on caption prose — a caption
		// reworded to say "$Expected" must not silently drop a row from the guard.
		const rows = oracle.canonicalAccepted.filter(
			(r) => /expected/i.test(r.raw) && r.verdict === "accepted",
		);
		// Guard against a vacuous pass if the FP fixtures are ever removed.
		expect(rows.length).toBeGreaterThanOrEqual(3);
		for (const row of rows) {
			// The word is present but carries no `(line N column M)` position, so
			// it is body text, not a diagnostic.
			expect(row.raw).not.toMatch(/expected[^\n]*\(line \d+ column \d+\)/i);
			expect(() => classifyParseResult(row.raw, row.input)).not.toThrow();
		}
	});

	// Adversarial counterpart to the corpus rows. These `raw` values are
	// SYNTHETIC — the echo spelling frozen in parse-oracle.json
	// (`(evl /putmessage=…)`, `(evl /globalname=…;value=…)`, both verbatim from
	// corpus il_text) applied to a body that embeds a COMPLETE diagnostic
	// literal. They stay out of the oracle fixture, which holds device captures
	// only. The point: an accepted return echoes the body, so the matcher must
	// key on POSITION — the `(evl `/`(<%%` wrapper, or line-start plus the
	// trailing offset — and never on the words alone.
	//
	// Not covered, deliberately: a body containing the literal `(<%% bad command
	// name` is indistinguishable from a real diagnostic in the returned text.
	// Rejecting it is the safe direction, and no corpus script does it.
	test.each([
		[':put "bad parameter test"', "(evl /putmessage=bad parameter test)"],
		[
			':put "expected token (line 1 column 2)"',
			"(evl /putmessage=expected token (line 1 column 2))",
		],
		[
			':put "syntax error (line 1 column 9)"',
			"(evl /putmessage=syntax error (line 1 column 9))",
		],
		[
			':global msg "bad parameter address (line 1 column 35)"',
			"(evl /globalname=$msg;value=bad parameter address (line 1 column 35))",
		],
	])(
		"accepted content that mimics a diagnostic is not a verdict: %s",
		(cli, raw) => {
			expect(() => classifyParseResult(raw, cli, "rest")).not.toThrow();
		},
	);

	// The counterpart: RouterOS's three real `expected …` diagnostic spellings
	// must still be caught. These are what justify keeping `expected` in the
	// matcher at all, so freezing them is what makes the narrowing safe.
	test.each(oracle.syntaxExpected)("$caption", (row) => {
		expect(row.raw).toContain(row.expectedContains);
		try {
			classifyParseResult(row.raw, row.input);
			throw new Error(`expected classifyParseResult to throw: ${row.caption}`);
		} catch (e) {
			const err = e as CentrsError;
			expect(err.code).toBe("validation/syntax");
			if (row.mustHavePosition) {
				expect(err.position).toBeDefined();
				expect(typeof err.position?.column).toBe("number");
			}
		}
	});

	test("the three `expected …` diagnostic spellings are all frozen", () => {
		const spellings = new Set(
			oracle.syntaxExpected.map((r) => r.expectedContains),
		);
		expect(spellings).toEqual(
			new Set([
				"expected end of command",
				"expected command name",
				"expected input value",
			]),
		);
	});

	test.each(oracle.badParameter)("$caption", (row) => {
		expect(row.raw).toContain(row.expectedContains);
		if (row.expectedAlsoContains) {
			expect(row.raw).toContain(row.expectedAlsoContains);
		}
		try {
			classifyParseResult(row.raw, row.input);
			throw new Error(`expected classifyParseResult to throw: ${row.caption}`);
		} catch (e) {
			const err = e as CentrsError;
			expect(err.code).toBe("validation/unknown-attribute");
			if (row.mustHavePosition) {
				expect(err.position).toBeDefined();
				expect(typeof err.position?.column).toBe("number");
			}
		}
	});

	test("each bad-command-name raw classifies to syntax with a position", () => {
		for (const row of oracle.badCommandName) {
			expect(row.raw).toContain(row.expectedContains);
			try {
				classifyParseResult(row.raw, row.input);
				throw new Error(
					`expected classifyParseResult to throw: ${row.caption}`,
				);
			} catch (e) {
				expect((e as CentrsError).code).toBe("validation/syntax");
				if (row.mustHavePosition) {
					expect((e as CentrsError).position).toBeDefined();
				}
			}
		}
	});

	test.each(oracle.syntaxExpected)("$caption", (row) => {
		expect(row.raw).toContain(row.expectedContains);
		// Genuine syntax diagnostics are line-anchored: `… (line N column M)`
		// (GH#230 blocker fix). The raw must carry that position.
		expect(row.raw).toMatch(/\(line \d+ column \d+\)/i);
		try {
			classifyParseResult(row.raw, row.input);
			throw new Error(`expected classifyParseResult to throw: ${row.caption}`);
		} catch (e) {
			const err = e as CentrsError;
			expect(err.code).toBe("validation/syntax");
			expect(err.position).toBeDefined();
		}
	});

	for (const fx of oracle.positionFixtures) {
		test(`parse-oracle position: ${fx.caption}`, () => {
			expect(parseRouterOsPosition(fx.raw)).toEqual({
				line: fx.line,
				column: fx.column,
			});
		});
	}
});
