import { describe, expect, test } from "bun:test";
import { textWarningLines } from "../../src/cli/common.ts";

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
