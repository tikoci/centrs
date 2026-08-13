/**
 * #293 B2 — argSpans traps.
 *
 * Second B2 fill after the operator fill. Claims argument names and their `=`
 * on the residual left by `spans` (comment + variable-*), before `operatorSpans`
 * sees it. Vocabulary is provisional: one `arg` class (ev e11) for both name
 * bytes and the `=` separator — the `=` is derived from `valueSpan.start - 1`,
 * never by scanning.
 *
 * Traps: positional/query have no `name`/`valueSpan` and abstain; `Argument.value`
 * vs `text` is not read; normalized statements are not addressable; variable-*
 * overlap is clipped to residual; coalescing `[name][=]` → one maximal run.
 */

import { describe, expect, test } from "bun:test";
import { argSpans } from "../../src/explain/arg-tokens.ts";
import { analyzeCoordinates } from "../../src/explain/coordinates.ts";
import type { ExplainArgumentToken } from "../../src/explain.ts";
import { explainCommand, residualRanges } from "../../src/explain.ts";

function argsViaExplain(input: string): string[] {
	const data = explainCommand(input, { tokens: true });
	const analyzed = new TextDecoder().decode(analyzeCoordinates(input).analyzed);
	return (data.tokens ?? [])
		.filter((t) => t.class === "arg")
		.map((t) => analyzed.slice(t.start, t.end));
}

function argsDirect(
	analyzed: string,
	residual: { start: number; end: number }[],
	candidates: readonly ExplainArgumentToken[],
): string[] {
	return argSpans(analyzed, residual, candidates as never).map((s) =>
		analyzed.slice(s.start, s.end),
	);
}

function attr(
	start: number,
	end: number,
	valueStart: number,
	valueEnd: number,
	name: string,
): ExplainArgumentToken {
	return {
		kind: "attribute",
		span: { start, end },
		name,
		value: "x",
		valueSpan: { start: valueStart, end: valueEnd },
		text: `${name}=x`,
	};
}

describe("#293 arg fill — direct residual scanner", () => {
	test("single attribute → single coalesced arg token [name=]", () => {
		// "address=1.1.1.1" name=[0,8) `=` at 7? Actually valueSpan.start = 8, so name [0,7) wait check: name=address len 7? Let's use synthetic.
		// Use analyzed "address=1" where name=address (0..7), = at 7, valueSpan [8,9)
		const analyzed = "address=1";
		expect(
			argsDirect(
				analyzed,
				[{ start: 0, end: analyzed.length }],
				[attr(0, 9, 8, 9, "address")],
			),
		).toEqual(["address="]);
	});

	test("coalesced even though name and = clipped separately", () => {
		const analyzed = "address=1 interface=ether1";
		// Two attributes: address= at [0,8) and interface= at [10,20)
		expect(
			argsDirect(
				analyzed,
				[{ start: 0, end: analyzed.length }],
				[attr(0, 9, 8, 9, "address"), attr(10, 20, 20, 26, "interface")],
			),
		).toEqual(["address=", "interface="]);
	});

	test("dotted names and hyphenated names", () => {
		expect(
			argsDirect(
				".proplist=name,comment",
				[{ start: 0, end: 22 }],
				[attr(0, 22, 10, 22, ".proplist")],
			),
		).toEqual([".proplist="]);
		expect(
			argsDirect(
				"configuration.ssid=test",
				[{ start: 0, end: 22 }],
				[attr(0, 22, 19, 22, "configuration.ssid")],
			),
		).toEqual(["configuration.ssid="]);
		const wpa = "security.authentication-types=wpa2-psk";
		expect(
			argsDirect(
				wpa,
				[{ start: 0, end: wpa.length }],
				[
					attr(
						0,
						wpa.length,
						wpa.indexOf("=") + 1,
						wpa.length,
						"security.authentication-types",
					),
				],
			),
		).toEqual(["security.authentication-types="]);
	});

	test("positional is ignored even with valueSpan", () => {
		const analyzed = "where";
		const pos: ExplainArgumentToken = {
			kind: "positional",
			span: { start: 0, end: 5 },
			value: "where",
			valueSpan: { start: 0, end: 5 },
			text: "where",
		};
		expect(argsDirect(analyzed, [{ start: 0, end: 5 }], [pos])).toEqual([]);
	});

	test("query is ignored — name includes = but kind is query", () => {
		const analyzed = "?address=1.1.1.1";
		const q: ExplainArgumentToken = {
			kind: "query",
			span: { start: 0, end: 16 },
			name: "address=1.1.1.1",
			text: "?address=1.1.1.1",
		};
		expect(argsDirect(analyzed, [{ start: 0, end: 16 }], [q])).toEqual([]);
	});

	test("attribute without valueSpan or name abstains", () => {
		const analyzed = "address=1";
		const noValue: ExplainArgumentToken = {
			kind: "attribute",
			span: { start: 0, end: 9 },
			name: "address",
			text: "address=1",
		};
		expect(argsDirect(analyzed, [{ start: 0, end: 9 }], [noValue])).toEqual([]);
		const noName: ExplainArgumentToken = {
			kind: "attribute",
			span: { start: 0, end: 9 },
			value: "1",
			valueSpan: { start: 8, end: 9 },
			text: "address=1",
		};
		expect(argsDirect(analyzed, [{ start: 0, end: 9 }], [noName])).toEqual([]);
	});

	test("respects residual — clipped, not re-claimed", () => {
		// Simulate variable span claiming [4,8) inside "address=1"
		const analyzed = "address=1";
		// name "address" at [0,7), "=" at 7. Residual missing [4,8) means "ess=" gone
		expect(
			argsDirect(
				analyzed,
				[
					{ start: 0, end: 4 },
					{ start: 8, end: 9 },
				],
				[attr(0, 9, 8, 9, "address")],
			),
		).toEqual(["addr"]);
		// Only "=" claimed, name fully masked
		expect(
			argsDirect(
				analyzed,
				[{ start: 7, end: 8 }],
				[attr(0, 9, 8, 9, "address")],
			),
		).toEqual(["="]);
		// Whole name+ = outside residual → nothing
		expect(
			argsDirect(
				analyzed,
				[{ start: 9, end: 9 }],
				[attr(0, 9, 8, 9, "address")],
			),
		).toEqual([]);
	});

	test("residual clipping with multiple gaps", () => {
		const analyzed = "a=1 b=2 c=3";
		// residual has holes for " b=2 " interior
		const residual = [
			{ start: 0, end: 3 }, // "a=1"
			{ start: 7, end: 11 }, // "c=3" plus leading space?
		];
		// Provide three candidates, middle one should be fully clipped
		expect(
			argsDirect(analyzed, residual, [
				attr(0, 3, 2, 3, "a"),
				attr(4, 7, 6, 7, "b"),
				attr(8, 11, 10, 11, "c"),
			]),
		).toEqual(["a=", "c="]);
	});

	test("misaligned or out-of-bounds candidates are ignored", () => {
		const analyzed = "address=1";
		// = byte not "=" in analyzed (wrongly rebased)
		const badEq = attr(0, 9, 8, 9, "address");
		expect(argsDirect("address-1", [{ start: 0, end: 9 }], [badEq])).toEqual(
			[],
		);
		// span beyond len
		expect(
			argsDirect(
				analyzed,
				[{ start: 0, end: 9 }],
				[attr(0, 99, 8, 9, "address")],
			),
		).toEqual([]);
		expect(
			argsDirect(
				analyzed,
				[{ start: 0, end: 9 }],
				[attr(0, 9, 8, 99, "address")],
			),
		).toEqual([]);
	});

	test("empty inputs yield empty", () => {
		expect(argsDirect("", [], [])).toEqual([]);
		expect(argsDirect("", [{ start: 0, end: 0 }], [])).toEqual([]);
		const analyzed = "address=1";
		expect(argsDirect(analyzed, [], [attr(0, 9, 8, 9, "address")])).toEqual([]);
		expect(argsDirect(analyzed, [{ start: 0, end: 9 }], [])).toEqual([]);
	});

	test("candidates need not be sorted; output is byte-ordered", () => {
		const analyzed = "b=2 a=1";
		// Provide candidates out of order
		expect(
			argsDirect(
				analyzed,
				[{ start: 0, end: 7 }],
				[attr(4, 7, 6, 7, "a"), attr(0, 3, 2, 3, "b")],
			),
		).toEqual(["b=", "a="]);
	});

	test("clipToResidual binary-search path — residual far from start", () => {
		// residual single far interval, candidate before it
		const analyzed = "x".repeat(1000) + "address=1";
		const base = 1000;
		expect(
			argsDirect(
				analyzed,
				[{ start: base, end: base + 9 }],
				[
					attr(base, base + 9, base + 8, base + 9, "address"),
					attr(0, 1, 0, 1, "x"),
				],
			),
		).toEqual(["address="]);
	});
});

describe("#293 arg fill — via explainCommand (masking + evidence)", () => {
	test.each([
		["/ip/address/add address=1.1.1.1", ["address="]],
		[
			"/ip/address/add address=1.1.1.1 interface=ether1",
			["address=", "interface="],
		],
		[
			"/ip route add dst-address=1.1.1.1 gateway=1.1.1.2",
			["dst-address=", "gateway="],
		],
		["/interface/print .proplist=name,comment", [".proplist="]],
		["/ip/address/print where address=1.1.1.1", ["address="]],
		[
			"/ip/firewall/filter/add chain=forward action=accept in-interface-list=!LAN",
			["chain=", "action=", "in-interface-list="],
		],
	])("%s → %j", (input, expected) => {
		expect(argsViaExplain(input as string)).toEqual(expected as string[]);
	});

	test("positional and query produce no arg tokens", () => {
		expect(argsViaExplain("/ip address print")).toEqual([]);
		expect(argsViaExplain("/ip address print count-only")).toEqual([]);
		expect(argsViaExplain("/ip/address/print ?address=1.1.1.1")).toEqual([]);
		expect(argsViaExplain("/ip address print where chain=forward")).toEqual([
			"chain=",
		]); // where is positional, chain is arg
	});

	test("all-or-nothing: variable value refuses whole statement", () => {
		// gateway=$gw is a variable value → read:false → no arg tokens at all
		expect(
			argsViaExplain("/ip route add dst-address=1.1.1.1 gateway=$gw"),
		).toEqual([]);
		expect(
			argsViaExplain(
				"/ip route add dst-address=1.1.1.1 gateway=$gw comment=$c",
			),
		).toEqual([]);
		// substitution
		expect(
			argsViaExplain("/ip address add address=[/ip/route/get $x]"),
		).toEqual([]);
		// array/block value
		expect(
			argsViaExplain("/system script add name=s source={ :put 1 }"),
		).toEqual([]);
		// But without a refusing value, args appear
		expect(
			argsViaExplain("/ip route add dst-address=1.1.1.1 gateway=1.1.1.2"),
		).toEqual(["dst-address=", "gateway="]);
	});

	test("normalized input yields no arg tokens", () => {
		expect(argsViaExplain('/system identity set name="router-🚀"')).toEqual([]);
	});

	test("value bytes are not arg — only name+=", () => {
		const input = "/ip/address/add address=1.1.1.1";
		const data = explainCommand(input, { tokens: true });
		const analyzed = new TextDecoder().decode(
			analyzeCoordinates(input).analyzed,
		);
		const tokens = data.tokens ?? [];
		// "address=" is arg, "1.1.1.1" is unclassified (value fill not yet)
		const argText = tokens
			.filter((t) => t.class === "arg")
			.map((t) => analyzed.slice(t.start, t.end))
			.join("");
		expect(argText).toBe("address=");
		// Ensure value span is not arg
		const valueSlice = analyzed.slice(24, 31);
		expect(valueSlice).toBe("1.1.1.1");
		const valueTokens = tokens.filter((t) => t.start >= 24 && t.end <= 31);
		expect(valueTokens.every((t) => t.class !== "arg")).toBe(true);
	});

	test("every arg token carries ev e11 and evidence cites it", () => {
		const data = explainCommand(
			"/ip/address/add address=1.1.1.1 interface=ether1",
			{ tokens: true },
		);
		const args = (data.tokens ?? []).filter((t) => t.class === "arg");
		expect(args.length).toBe(2);
		for (const t of args) expect(t.ev).toBe("e11");
		expect(data.evidence.some((e) => e.id === "e11")).toBe(true);
		// No arg → no e11
		const noArg = explainCommand("/ip address print", { tokens: true });
		expect(noArg.evidence.some((e) => e.id === "e11")).toBe(false);
		const noArg2 = explainCommand(
			"/ip route add dst-address=1.1.1.1 gateway=$gw",
			{ tokens: true },
		);
		expect(noArg2.evidence.some((e) => e.id === "e11")).toBe(false);
	});

	test("spans stay proof-only — no arg class there", () => {
		const data = explainCommand("/ip/address/add address=1.1.1.1", {
			tokens: true,
		});
		expect(data.spans.some((s) => (s.class as string) === "arg")).toBe(false);
	});

	test("fill order: arg owns = before operator (expression = stays operator)", () => {
		// Attribute `=` is arg
		expect(argsViaExplain("/ip/address/add address=1.1.1.1")).toEqual([
			"address=",
		]);
		const attrEq = explainCommand("/ip/address/add address=1.1.1.1", {
			tokens: true,
		});
		expect(
			attrEq.tokens?.some((t) => t.class === "operator" && t.start === 24),
		).toBe(false);
		// Expression `=` inside ( ) is operator, not arg
		const expr = explainCommand(":put (1=2)", { tokens: true });
		expect(expr.tokens?.some((t) => t.class === "operator")).toBe(true);
		expect(expr.tokens?.some((t) => t.class === "arg")).toBe(false);
		// Top-level slash stays unclassified for path fill, not operator
		expect(
			explainCommand(":put 1 / 2", { tokens: true }).tokens?.some(
				(t) => t.class === "operator",
			),
		).toBe(false);
		expect(
			explainCommand(":put (1 / 2)", { tokens: true }).tokens?.some(
				(t) => t.class === "operator",
			),
		).toBe(true);
	});

	test("residualRanges is the complement — used by fill order", () => {
		expect(residualRanges(5, [{ start: 1, end: 3 }])).toEqual([
			{ start: 0, end: 1 },
			{ start: 3, end: 5 },
		]);
	});
});
