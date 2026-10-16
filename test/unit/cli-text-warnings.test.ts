import { describe, expect, spyOn, test } from "bun:test";
import {
	printTextHeader,
	printTextNotes,
	textWarningLines,
} from "../../src/cli/common.ts";

describe("textWarningLines (#470)", () => {
	test("one fan-out-shaped line per warning, in order", () => {
		expect(
			textWarningLines([
				{ code: "cmr/rule-selects-every-device", message: "cuts access" },
				{ code: "transport/write-outcome-unknown", message: "may have run" },
			]),
		).toEqual([
			"warning [cmr/rule-selects-every-device]: cuts access",
			"warning [transport/write-outcome-unknown]: may have run",
		]);
	});

	test("transport/provider-trust is quiet in text mode", () => {
		expect(
			textWarningLines([
				{ code: "transport/provider-trust", message: "relaxed TLS" },
				{ code: "cdb/override-applied", message: "port from --port" },
			]),
		).toEqual(["warning [cdb/override-applied]: port from --port"]);
	});

	test("device text cannot add a line or a control sequence", () => {
		expect(
			textWarningLines([{ code: "x/y", message: "a\nb\u001b[2Jc" }]),
		).toEqual(["warning [x/y]: a b [2Jc"]);
	});
});

describe("printTextNotes / printTextHeader (#470)", () => {
	function captureStderr(fn: () => void): string[] {
		const lines: string[] = [];
		const spy = spyOn(console, "error").mockImplementation((line) => {
			lines.push(String(line));
		});
		const log = spyOn(console, "log");
		try {
			fn();
			expect(log).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
			log.mockRestore();
		}
		return lines;
	}

	test("warnings, then a Tips: footer, all on stderr", () => {
		const lines = captureStderr(() =>
			printTextNotes({
				warnings: [{ code: "x/warn", message: "w" }],
				tips: [{ code: "tip/do-this", message: "m", fix: "f" }],
			}),
		);
		expect(lines).toEqual([
			"warning [x/warn]: w",
			"\nTips:\n  - [tip/do-this] m\n    fix: f",
		]);
	});

	test("nothing to say writes nothing", () => {
		expect(
			captureStderr(() => printTextNotes({ warnings: [], tips: [] })),
		).toEqual([]);
		expect(captureStderr(() => printTextHeader([]))).toEqual([]);
	});

	test("the verbose header is one stderr write", () => {
		expect(
			captureStderr(() => printTextHeader(["via: rest-api", "validation: x"])),
		).toEqual(["via: rest-api\nvalidation: x"]);
	});
});
