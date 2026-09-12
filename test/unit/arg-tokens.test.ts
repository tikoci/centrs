/**
 * #293 B2 — argSpans traps.
 *
 * Second B2 fill after the operator fill. Claims argument names and their `=`
 * on the residual left by `spans` (comment + variable-*), before `operatorSpans`
 * sees it. Since #264 B5 the two are DIFFERENT classes (both ev e11): the name
 * run is `arg`, the single `=` byte is `arg-sep`, and the `=` is still derived
 * from `valueSpan.start - 1`, never by scanning.
 *
 * Every expectation below is spelled `class:text` for that reason. The merged
 * spelling these tests used to carry (`"address="`) cannot tell a correct split
 * from a fill that emits both runs under one class, which is the merge B5 undid.
 *
 * Traps: positional/query have no `name`/`valueSpan` and abstain; `Argument.value`
 * vs `text` is not read; normalized statements are not addressable; variable-*
 * overlap is clipped to residual, and either run can survive alone.
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
		.filter((t) => t.class === "arg" || t.class === "arg-sep")
		.map((t) => `${t.class}:${analyzed.slice(t.start, t.end)}`);
}

function argsDirect(
	analyzed: string,
	residual: { start: number; end: number }[],
	candidates: readonly ExplainArgumentToken[],
): string[] {
	return argSpans(analyzed, residual, candidates as never).map(
		(s) => `${s.class}:${analyzed.slice(s.start, s.end)}`,
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
	test("single attribute → an `arg` name run and an `arg-sep` `=`", () => {
		// `address` is 7 bytes, so for "address=1" the name run is [0,7), the `=`
		// is the single byte [7,8) — derived as `valueSpan.start - 1` — and the
		// value is valueSpan [8,9). The fill claims [0,7) `arg` and [7,8) `arg-sep`.
		const analyzed = "address=1";
		expect(
			argsDirect(
				analyzed,
				[{ start: 0, end: analyzed.length }],
				[attr(0, 9, 8, 9, "address")],
			),
		).toEqual(["arg:address", "arg-sep:="]);
	});

	test("two attributes stay four runs, in byte order", () => {
		const analyzed = "address=1 interface=ether1";
		// Two attributes: address= at [0,8) and interface= at [10,20)
		expect(
			argsDirect(
				analyzed,
				[{ start: 0, end: analyzed.length }],
				[attr(0, 9, 8, 9, "address"), attr(10, 20, 20, 26, "interface")],
			),
		).toEqual(["arg:address", "arg-sep:=", "arg:interface", "arg-sep:="]);
	});

	test("dotted names and hyphenated names", () => {
		expect(
			argsDirect(
				".proplist=name,comment",
				[{ start: 0, end: 22 }],
				[attr(0, 22, 10, 22, ".proplist")],
			),
		).toEqual(["arg:.proplist", "arg-sep:="]);
		expect(
			argsDirect(
				"configuration.ssid=test",
				[{ start: 0, end: 22 }],
				[attr(0, 22, 19, 22, "configuration.ssid")],
			),
		).toEqual(["arg:configuration.ssid", "arg-sep:="]);
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
		).toEqual(["arg:security.authentication-types", "arg-sep:="]);
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
		).toEqual(["arg:addr"]);
		// Only "=" claimed, name fully masked
		expect(
			argsDirect(
				analyzed,
				[{ start: 7, end: 8 }],
				[attr(0, 9, 8, 9, "address")],
			),
		).toEqual(["arg-sep:="]);
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
			{ start: 7, end: 11 }, // " c=3" — the space at 7 plus "c=3" at [8,11)
		];
		// Provide three candidates, middle one should be fully clipped
		expect(
			argsDirect(analyzed, residual, [
				attr(0, 3, 2, 3, "a"),
				attr(4, 7, 6, 7, "b"),
				attr(8, 11, 10, 11, "c"),
			]),
		).toEqual(["arg:a", "arg-sep:=", "arg:c", "arg-sep:="]);
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
		).toEqual(["arg:b", "arg-sep:=", "arg:a", "arg-sep:="]);
	});

	test("clipToResidual binary-search path — residual far from start", () => {
		// residual single far interval, candidate before it
		const analyzed = `${"x".repeat(1000)}address=1`;
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
		).toEqual(["arg:address", "arg-sep:="]);
	});
});

describe("#293 arg fill — via explainCommand (masking + evidence)", () => {
	test.each([
		["/ip/address/add address=1.1.1.1", ["arg:address", "arg-sep:="]],
		[
			"/ip/address/add address=1.1.1.1 interface=ether1",
			["arg:address", "arg-sep:=", "arg:interface", "arg-sep:="],
		],
		[
			"/ip route add dst-address=1.1.1.1 gateway=1.1.1.2",
			["arg:dst-address", "arg-sep:=", "arg:gateway", "arg-sep:="],
		],
		["/interface/print .proplist=name,comment", ["arg:.proplist", "arg-sep:="]],
		["/ip/address/print where address=1.1.1.1", ["arg:address", "arg-sep:="]],
		[
			"/ip/firewall/filter/add chain=forward action=accept in-interface-list=!LAN",
			[
				"arg:chain",
				"arg-sep:=",
				"arg:action",
				"arg-sep:=",
				"arg:in-interface-list",
				"arg-sep:=",
			],
		],
	])("%s → %j", (input, expected) => {
		expect(argsViaExplain(input as string)).toEqual(expected as string[]);
	});

	test("positional and query produce no arg tokens", () => {
		expect(argsViaExplain("/ip address print")).toEqual([]);
		expect(argsViaExplain("/ip address print count-only")).toEqual([]);
		expect(argsViaExplain("/ip/address/print ?address=1.1.1.1")).toEqual([]);
		expect(argsViaExplain("/ip address print where chain=forward")).toEqual([
			"arg:chain",
			"arg-sep:=",
		]); // where is positional, chain is arg
	});

	test("an undecodable VALUE no longer costs the statement its names (#316)", () => {
		// The fill reads the skip-tolerant token stream, so a token whose value
		// only the device knows still contributes its `name=` bytes. The VALUE
		// bytes stay unclaimed here either way — `argSpans` never claims them.
		expect(
			argsViaExplain("/ip route add dst-address=1.1.1.1 gateway=$gw"),
		).toEqual(["arg:dst-address", "arg-sep:=", "arg:gateway", "arg-sep:="]);
		expect(
			argsViaExplain(
				"/ip route add dst-address=1.1.1.1 gateway=$gw comment=$c",
			),
		).toEqual([
			"arg:dst-address",
			"arg-sep:=",
			"arg:gateway",
			"arg-sep:=",
			"arg:comment",
			"arg-sep:=",
		]);
		// substitution
		expect(
			argsViaExplain("/ip address add address=[/ip/route/get $x]"),
		).toEqual(["arg:address", "arg-sep:="]);
		// array/block value
		expect(
			argsViaExplain("/system script add name=s source={ :put 1 }"),
		).toEqual(["arg:name", "arg-sep:=", "arg:source", "arg-sep:="]);
		// A literal value was never the thing at issue.
		expect(
			argsViaExplain("/ip route add dst-address=1.1.1.1 gateway=1.1.1.2"),
		).toEqual(["arg:dst-address", "arg-sep:=", "arg:gateway", "arg-sep:="]);
	});

	test("a token whose NAME is not a name claims nothing (#316)", () => {
		// `{a=1;b=2}` fuses an array literal into what looks like `name=value`.
		// The tolerant walk locates the token but refuses to call it an attribute,
		// so no `arg` span is emitted over bytes that are not an argument name.
		expect(argsViaExplain("/ip/route/add {a=1;b=2} gateway=1.1.1.2")).toEqual([
			"arg:gateway",
			"arg-sep:=",
		]);
	});

	test("normalized input yields no arg tokens", () => {
		expect(argsViaExplain('/system identity set name="router-🚀"')).toEqual([]);
	});

	test("value bytes are neither arg nor arg-sep", () => {
		const input = "/ip/address/add address=1.1.1.1";
		const data = explainCommand(input, { tokens: true });
		const analyzed = new TextDecoder().decode(
			analyzeCoordinates(input).analyzed,
		);
		const tokens = data.tokens ?? [];
		// "address" is arg, "=" is arg-sep, "1.1.1.1" is unclassified (value fill
		// not yet). Joining the two classes back together must still be exactly the
		// bytes the merged class used to claim — that is the retag invariant.
		const argText = tokens
			.filter((t) => t.class === "arg")
			.map((t) => analyzed.slice(t.start, t.end))
			.join("");
		expect(argText).toBe("address");
		const sepText = tokens
			.filter((t) => t.class === "arg-sep")
			.map((t) => analyzed.slice(t.start, t.end))
			.join("");
		expect(sepText).toBe("=");
		// Ensure value span is neither
		const valueSlice = analyzed.slice(24, 31);
		expect(valueSlice).toBe("1.1.1.1");
		const valueTokens = tokens.filter((t) => t.start >= 24 && t.end <= 31);
		expect(
			valueTokens.every((t) => t.class !== "arg" && t.class !== "arg-sep"),
		).toBe(true);
	});

	test("every arg AND arg-sep token carries ev e11 and evidence cites it", () => {
		const data = explainCommand(
			"/ip/address/add address=1.1.1.1 interface=ether1",
			{ tokens: true },
		);
		const args = (data.tokens ?? []).filter((t) => t.class === "arg");
		expect(args.length).toBe(2);
		// The split did NOT split the evidence: `e11` is how `args.ts` located the
		// bytes, which is the same walk for the name and for the `=`.
		const separators = (data.tokens ?? []).filter((t) => t.class === "arg-sep");
		expect(separators.length).toBe(2);
		for (const t of [...args, ...separators]) expect(t.ev).toBe("e11");
		expect(data.evidence.some((e) => e.id === "e11")).toBe(true);
		// No arg → no e11
		const noArg = explainCommand("/ip address print", { tokens: true });
		expect(noArg.evidence.some((e) => e.id === "e11")).toBe(false);
		// A statement that is not ADDRESSABLE is the remaining no-arg case: #316 put
		// undecodable VALUES back in reach, but a normalized statement's offsets
		// still do not map back, so no token is rebased and none is claimed.
		const noArg2 = explainCommand('/system identity set name="router-🚀"', {
			tokens: true,
		});
		expect(noArg2.evidence.some((e) => e.id === "e11")).toBe(false);
	});

	test("spans stay proof-only — no arg class there", () => {
		const data = explainCommand("/ip/address/add address=1.1.1.1", {
			tokens: true,
		});
		expect(data.spans.some((s) => (s.class as string) === "arg")).toBe(false);
		expect(data.spans.some((s) => (s.class as string) === "arg-sep")).toBe(
			false,
		);
	});

	test("fill order: arg owns = before operator (expression = stays operator)", () => {
		// Attribute `=` is arg
		expect(argsViaExplain("/ip/address/add address=1.1.1.1")).toEqual([
			"arg:address",
			"arg-sep:=",
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
		// The new class must not become a magnet for every `=` in the document:
		// a comparison `=` is an operator and stays one.
		expect(expr.tokens?.some((t) => t.class === "arg-sep")).toBe(false);
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

	test("mixed document: a statement that is not addressable still claims nothing", () => {
		// The per-STATEMENT filter is applied against a document-global residual,
		// so one statement out of reach must not suppress a readable one and must
		// not let the fill spill into its own bytes. Since #316 an undecodable
		// value is no longer what puts a statement out of reach; a NORMALIZED one
		// still is, because its offsets do not map back to the source bytes.
		const input =
			'/ip/address/add address=1.1.1.1\n/system/identity/set name="router-🚀"';
		const data = explainCommand(input, { tokens: true });
		const args = (data.tokens ?? []).filter(
			(t) => t.class === "arg" || t.class === "arg-sep",
		);
		expect(
			args.map((t) => `${t.class}:${input.slice(t.start, t.end)}`),
		).toEqual(["arg:address", "arg-sep:="]);
		// Every claimed byte is in the FIRST statement.
		const secondStart = input.indexOf("\n") + 1;
		for (const t of args) expect(t.end).toBeLessThanOrEqual(secondStart);
		// Its `name=` bytes stay unclassified, because none of its spans rebase.
		const nameEq = input.indexOf("name=");
		const atName = (data.tokens ?? []).find(
			(t) => t.start <= nameEq && t.end > nameEq,
		);
		expect(atName?.class).toBe("unclassified");
		// e11 is cited because SOME statement produced arg tokens.
		expect(data.evidence.some((e) => e.id === "e11")).toBe(true);
	});

	test("a withdrawn reading claims nothing (#311 + #316)", () => {
		// A second command-shaped run withdraws the argument reading, and the
		// tolerant stream is withdrawn with it: centrs cannot say which bytes are
		// this command's arguments, and claiming `name=` runs would be that same
		// claim in lexical clothing. The literal twin is the control.
		const run = "/ip/address add interface=ether1 /ip/route add gateway=$g";
		expect(argsViaExplain(run)).toEqual([]);
		expect(argsViaExplain("/ip/address add interface=ether1")).toEqual([
			"arg:interface",
			"arg-sep:=",
		]);
	});
});
