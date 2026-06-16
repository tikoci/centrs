import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	classifyParseResult,
	emulateScreen,
	extractCommandOutput,
	ROUTEROS_PROMPT_RE,
} from "../../src/protocols/mac-telnet-console.ts";

/**
 * Fixtures are REAL console responses captured from stock CHR 7.23.1 over
 * mac-telnet (`.scratch/mactelnet-*.ts` probes). `P` is the prompt; `TAIL`
 * reproduces RouterOS's trailing prompt redraw (4×CR, prompt, space padding, CR,
 * prompt) so the extractor is pinned against the device's actual line discipline.
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
		const probe = "\r\x1b[9999B\r\x1b[9999B\x1bZ  \x1b[6n";
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

describe("classifyParseResult surfaces error.position (JG-16)", () => {
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

	test("a rejection with no source location still classifies, with no position", () => {
		try {
			classifyParseResult("bad command name", "bogus");
			throw new Error("expected classifyParseResult to throw");
		} catch (error) {
			expect((error as CentrsError).code).toBe("validation/syntax");
			expect((error as CentrsError).position).toBeUndefined();
		}
	});
});
