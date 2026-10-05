import { describe, expect, test } from "bun:test";
import { CentrsError, type CentrsErrorCode } from "../../src/errors.ts";
import { classifyParseResult } from "../../src/protocols/mac-telnet-console.ts";

/**
 * Every `output` below is RouterOS 7.23.7's verbatim `:put [:parse "<cli>"]`
 * return on a CHR with no extra packages (GH#361). The slash spelling points at
 * the `/` after the absent segment; the space spelling names it.
 */
const CASES: readonly [
	cli: string,
	output: string,
	code: CentrsErrorCode,
	path?: string,
][] = [
	[
		"/zerotier/print",
		"syntax error (line 1 column 10)",
		"validation/package-missing",
		"/zerotier",
	],
	[
		"/zerotier print",
		"(<%% bad command name zerotier (line 1 column 2) zerotier;print)",
		"validation/package-missing",
		"/zerotier",
	],
	[
		"/zerotier/peer/print",
		"syntax error (line 1 column 10)",
		"validation/package-missing",
		"/zerotier",
	],
	[
		"/container/print",
		"syntax error (line 1 column 11)",
		"validation/package-missing",
		"/container",
	],
	[
		"/zero/print",
		"syntax error (line 1 column 6)",
		"validation/package-missing",
		"/zerotier",
	],
	[
		"/iot/lora/print",
		"syntax error (line 1 column 5)",
		"validation/package-missing",
		"/iot",
	],
	[
		":put [/zerotier/print]",
		"syntax error (line 1 column 16)",
		"validation/package-missing",
		"/zerotier",
	],
	[
		":put 1\n/zerotier/print",
		"syntax error (line 2 column 10)",
		"validation/package-missing",
		"/zerotier",
	],
	[
		':put "é"; /zerotier/print',
		"syntax error (line 1 column 21)",
		"validation/package-missing",
		"/zerotier",
	],
	[
		"/ip/address { /zerotier/print }",
		"syntax error (line 1 column 24)",
		"validation/package-missing",
		"/zerotier",
	],
	[
		"/interface/w60g/print",
		"syntax error (line 1 column 16)",
		"validation/menu-unavailable",
		"/interface/w60g",
	],
	[
		":put [/interface/w60g/get [find] disabled]",
		"syntax error (line 1 column 22)",
		"validation/menu-unavailable",
		"/interface/w60g",
	],
	[
		"/ip/nosuchmenu/print",
		"syntax error (line 1 column 15)",
		"validation/unknown-path",
		"/ip/nosuchmenu",
	],
	[
		"/ip nosuchmenu print",
		"(<%% bad command name nosuchmenu (line 1 column 5) nosuchmenu;print)",
		"validation/unknown-path",
		"/ip/nosuchmenu",
	],
	[
		"/ip/address/nosuchverb",
		"(<%% bad command name nosuchverb (line 1 column 13) nosuchverb)",
		"validation/unknown-path",
		"/ip/address/nosuchverb",
	],
	[
		"/nosuch",
		"(<%% bad command name nosuch (line 1 column 2) nosuch)",
		"validation/unknown-path",
		"/nosuch",
	],
	// `ip` is a unique prefix of `/ip/ipsec`, so RouterOS rejects `print`.
	[
		"/ip ip print",
		"(<%% bad command name print (line 1 column 8) print)",
		"validation/unknown-path",
		"/ip/ipsec/print",
	],
	// Abstentions: a real syntax fault, and parents the analyzer does not resolve.
	[
		'/ip/address/print where "',
		"syntax error (line 1 column 26)",
		"validation/syntax",
	],
	[
		"/ip/address/print (",
		"expected end of command (line 1 column 19)",
		"validation/syntax",
	],
	[
		"/ip { nosuchmenu print }",
		"(evl (<%% bad command name nosuchmenu (line 1 column 7) nosuchmenu;print))",
		"validation/syntax",
	],
	[
		["/ip", "nosuchmenu print"].join("\n"),
		"/ip/;(<%% bad command name nosuchmenu (line 2 column 1) nosuchmenu;print)",
		"validation/syntax",
	],
	// The rejected segment repeats; which occurrence column 12 means is not mapped.
	[
		"/interface interface print",
		"(<%% bad command name interface (line 1 column 12) interface;print)",
		"validation/syntax",
	],
];

function rejection(cli: string, output: string): CentrsError {
	try {
		classifyParseResult(output, cli, "rest-api");
	} catch (error) {
		if (error instanceof CentrsError) return error;
		throw error;
	}
	throw new Error(`expected a rejection for ${JSON.stringify(cli)}`);
}

describe("absent menus are not syntax errors (GH#361)", () => {
	for (const [cli, output, code, path] of CASES)
		test(`${JSON.stringify(cli)} -> ${code}`, () => {
			const error = rejection(cli, output);
			expect(error.code).toBe(code);
			expect(error.context?.["path"]).toBe(path);
			expect(error.context?.["detail"]).toBe(output);
			expect(error.position).toBeDefined();
			if (code !== "validation/syntax")
				expect(error.remediation ?? "").not.toContain("syntax");
		});

	test("package-missing names the package and /system/package/print", () => {
		const error = rejection(
			"/zerotier/print",
			"syntax error (line 1 column 10)",
		);
		expect(error.context?.["packages"]).toEqual(["zerotier"]);
		expect(error.summary).toContain("`zerotier`");
		expect(error.remediation).toContain("/system/package/print");
	});

	test("menu-unavailable carries every published gate", () => {
		const error = rejection(
			"/interface/w60g/print",
			"syntax error (line 1 column 16)",
		);
		expect(error.context?.["gates"]).toEqual([
			{ path: "/interface/w60g", package: "wireless-rep", syscap: "60ghz" },
		]);
		expect(error.remediation).toContain("`60ghz`");
	});

	test("a published command is not called a menu", () => {
		const error = rejection(
			"/system license output",
			"(<%% bad command name output (line 1 column 17) output)",
		);
		expect(error.code).toBe("validation/menu-unavailable");
		expect(error.summary).toContain("`/system/license/output` command");
		expect(error.summary).not.toContain(" menu");
	});
});
