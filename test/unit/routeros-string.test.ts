import { describe, expect, test } from "bun:test";
import { routerOsStringLiteral } from "../../src/core/routeros-string.ts";
import { parseScriptFor } from "../../src/protocols/mac-telnet-console.ts";

describe("RouterOS string literals", () => {
	test("escape every byte that an outer double quote would reinterpret", () => {
		expect(routerOsStringLiteral(':put "\\$value"')).toBe(
			String.raw`":put \"\\\$value\""`,
		);
	});

	test("the MAC-Telnet parse wrapper preserves variable references", () => {
		expect(parseScriptFor(":foreach i in={1;2} do={:put $i}")).toBe(
			':put [:parse ":foreach i in={1;2} do={:put \\$i}"]',
		);
	});
});
