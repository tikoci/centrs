import { describe, expect, test } from "bun:test";
import { routerOsStringLiteral } from "../../src/core/routeros-string.ts";
import { lexValueAnchors } from "../../src/explain/args.ts";
import { resolveDocument } from "../../src/explain/pathresolve.ts";
import { resolveSymbols } from "../../src/explain/symbols.ts";
import { explainCommand } from "../../src/explain.ts";
import {
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

function outputOf(result: unknown): string {
	return String((result as { output?: unknown }).output ?? "").replaceAll(
		"\r\n",
		"\n",
	);
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

describeFast("explain value facts against CHR", () => {
	test("example 26 keeps shape hints separate from live type and context", async () => {
		const started = await startIntegrationChr();
		try {
			const scalar = outputOf(
				await started.chr.exec(':put [:typeof 2.2]; :put [:typeof "2.2"]'),
			);
			expect(scalar).toBe("ip\nstr");

			const v2Scalars = outputOf(
				await started.chr.exec(
					":put [:typeof 00:00:02]; :put [:tostr 00:60:00]; :put [:typeof *1]; :put [:typeof 00:11:22:33:44:55]",
				),
			);
			expect(v2Scalars).toBe("time\n01:00:00\nid\nstr");

			const v2Arrays = outputOf(
				await started.chr.exec(
					':put [:typeof (1,2,3)]; :put [:typeof {1;2;3}]; :put [:typeof ((1,2,3) . "a")]; :put [:tostr ((1,2,3) . "a")]; :put [:typeof (1 . 2)]',
				),
			);
			expect(v2Arrays).toBe("array\narray\narray\n1a;2a;3a\nstr");

			const producedTypes = outputOf(
				await started.chr.exec(
					':put [:typeof [:toarray ""]]; :local empty [:toarray ""]; :put [:typeof ($empty->0)]; :put [:typeof [:parse ":put hello"]]; :put [:tostr [:parse ":put hello"]]; :local unset; :put [:typeof $unset]; :put [:typeof [:nothing]]',
				),
			);
			expect(producedTypes).toBe("array\nnothing\ncode\n(code)\nnothing\nnil");

			const macParse = outputOf(
				await started.chr.exec(
					`:put [:parse ${routerOsStringLiteral("/interface/ethernet/set [find default-name=ether1] mac-address=00:11:22:33:44:55")}]`,
				),
			);
			expect(macParse).toContain("mac-address=00:11:22:33:44:55");

			const firewall = outputOf(
				await started.chr.exec(
					`:put [:parse ${routerOsStringLiteral("/ip/firewall/filter/add chain=input action=accept src-address=2.2")}]`,
				),
			);
			expect(firewall).toContain("src-address=;2.0.0.2");

			const duration = outputOf(
				await started.chr.exec(
					`:put [:parse ${routerOsStringLiteral("/tool/netwatch/add host=1.1.1.1 interval=2.2")}]`,
				),
			);
			expect(duration).toContain("interval=00:00:02.200");

			const booleanScalars = outputOf(
				await started.chr.exec(
					':put [:typeof true]; :put [:typeof false]; :put [:typeof yes]; :put [:typeof no]; :put [:typeof "true"]; :put [:typeof "yes"]; :put [:typeof 0]; :put [:typeof 1]',
				),
			);
			expect(booleanScalars).toBe("bool\nbool\nbool\nbool\nstr\nstr\nnum\nnum");

			const booleanAssignments = outputOf(
				await started.chr.exec(
					':global flag true; :put [:typeof $flag]; :set flag "true"; :put [:typeof $flag]; :set flag yes; :put [:typeof $flag]; :set flag "yes"; :put [:typeof $flag]',
				),
			);
			expect(booleanAssignments).toBe("bool\nstr\nbool\nstr");

			const toBool = outputOf(
				await started.chr.exec(
					':put [:typeof [:tobool "yes"]]; :put [:tostr [:tobool "yes"]]; :put [:tostr [:tobool "no"]]; :put [:tostr [:tobool 0]]; :put [:tostr [:tobool 1]]',
				),
			);
			expect(toBool).toBe("bool\ntrue\nfalse\nfalse\ntrue");

			for (const [suffix, disabled] of [
				["yes", "true"],
				["no", "false"],
				['"yes"', "true"],
				['"no"', "false"],
			] as const) {
				const index = suffix.includes("no") ? 2 : 1;
				const comment = `explain-bool-${index}-${suffix.length}`;
				expect(
					outputOf(
						await started.chr.exec(
							`/ip/address/add address=192.0.${index}.${suffix.startsWith('"') ? 2 : 1}/32 interface=ether1 comment=${comment} disabled=${suffix}`,
						),
					),
				).toBe("");
				const rows = (await started.chr.rest("/ip/address")) as Record<
					string,
					string
				>[];
				expect(
					rows.find((row) => row["comment"] === comment)?.["disabled"],
				).toBe(disabled);
			}
			expect(
				outputOf(
					await started.chr.exec(
						"/ip/address/add address=192.0.3.1/32 interface=ether1 disabled=true",
					),
				),
			).toContain("syntax error");

			const restBoolean = (await started.chr.rest("/ip/address", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					address: "198.51.100.1/32",
					interface: "ether1",
					disabled: true,
				}),
			})) as Record<string, string>;
			expect(restBoolean["disabled"]).toBe("true");
			const restString = (await started.chr.rest("/ip/address", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					address: "198.51.100.2/32",
					interface: "ether1",
					disabled: "false",
				}),
			})) as Record<string, string>;
			expect(restString["disabled"]).toBe("false");
			let numericRestError = "";
			try {
				await started.chr.rest("/ip/address", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						address: "198.51.100.3/32",
						interface: "ether1",
						disabled: 1,
					}),
				});
			} catch (error) {
				numericRestError = String(error);
			}
			expect(numericRestError).toContain("must be either yes or no");

			const data = explainCommand(
				':local x 2.2; :set x "2.2"; :local z (1,2,3); :local t 00:00:02; :local i *1; /ip/arp/add mac-address=00:11:22:33:44:55',
			);
			expect(data.values.occurrences.map((value) => value.facts)).toEqual([
				{ shapeHints: { values: ["ip"], ev: "e9" } },
				{ shapeHints: { values: ["str"], ev: "e9" } },
				{ shapeHints: { values: ["array"], ev: "e9" } },
				// The array's three members; example 28 owns the interior rules.
				{ shapeHints: { values: ["num"], ev: "e9" } },
				{ shapeHints: { values: ["num"], ev: "e9" } },
				{ shapeHints: { values: ["num"], ev: "e9" } },
				{ shapeHints: { values: ["time"], ev: "e9" } },
				{ shapeHints: { values: ["id"], ev: "e9" } },
				{ shapeHints: { values: ["mac"], ev: "e9" } },
			]);
			expect(
				data.values.occurrences.every(
					(value) =>
						value.facts.observedType === undefined &&
						value.facts.schemaType === undefined,
				),
			).toBe(true);
			expect(
				explainCommand(':local z ((1,2,3) . "a")').values.occurrences,
			).toEqual([]);
			expect(
				explainCommand(':local f [:parse ":put hello"]').values.occurrences,
			).toEqual([]);
			expect(
				explainCommand(':local empty [:toarray ""]').values.occurrences,
			).toEqual([]);

			await recordIntegrationEvidence({
				suite: "explain value facts against CHR",
				command: "explain",
				protocol: "rest-api (:typeof + :parse IL)",
				routerosVersion: started.chr.state.version,
				quickChrName: started.chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [26],
			});
		} finally {
			await started.chr.destroy();
		}
	}, 300_000);

	test("example 27 grounds comment placement and continuation arguments", async () => {
		const started = await startIntegrationChr();
		try {
			for (const input of [
				":local z {#test}",
				":local z {1;#test}",
				":local z {a=1;#b=2}",
				":local z (1,#test)",
				// #249 — a scope-named or bare brace nested inside an array is still an array
				":local z {do={ # c\n:put 1}}",
				":local z {command={ # c\n:put 1}}",
				":local z {else={ # c\n:put 1}}",
				":local z {script={ # c\n:put 1}}",
				":local z {source={ # c\n:put 1}}",
				":local z {on-event={ # c\n:put 1}}",
				":local z { { # c\n:put 1}}",
				":local z {/ip/dhcp-server { # c\n:put 1}}",
				":local x 2 #",
				"{ :local x 2 # }",
				":put 2 # blah",
				':put "a;b" # blah',
				':put "a{b" # blah',
				":if ($a = true \\ # bad",
			]) {
				const classes = await highlightClasses(started.chr, input);
				expect(classes[input.indexOf("#")]).toBe("error");
				const parseOutput = outputOf(
					await started.chr.exec(
						`:put [:parse ${routerOsStringLiteral(input)}]`,
					),
				);
				expect(parseOutput).toMatch(/syntax error|expected end of command/);
				if (input === ":if ($a = true \\ # bad") {
					// The `$a` bytes must reach `:parse`; an unescaped outer string drops
					// them and reports column 7 instead of the hash at column 18 (#269).
					expect(parseOutput).toContain("(line 1 column 18)");
				}
			}

			for (const input of [
				":if (true) do={ # c\n:put x\n}",
				":if (false) do={:put x} else={ # c\n:put y\n}",
				":foreach i in={1} do={ # c\n:put $i\n}",
				"/system/scheduler/add name=x start-time=startup on-event={ # c\n:put x\n}",
				"[# c\n:put 1]",
				":local z {[:do { # c\n:put 1\n}]}",
			]) {
				const classes = await highlightClasses(started.chr, input);
				expect(classes[input.indexOf("#")]).toBe("comment");
			}

			for (const input of [
				"/ip/address/add comment=#test",
				"/ip/address/add comment=a#b",
				":global y #test\n:put $y",
				":local y #test",
				":put #test",
				":local x 1; :set x #test",
				"[:put #test]",
				":local z [:put #test]",
				// A bracket nested in an array restores the statement role the array
				// dropped, so the hash is a value again (#246 review).
				":local z {[:put #test]}",
				":local z {1;[:put #test]}",
			]) {
				const classes = await highlightClasses(started.chr, input);
				expect(classes[input.indexOf("#")]).toBe("none");
			}

			// …but only per frame: an array or group INSIDE that bracket drops the
			// role again, so the offline reader must not skip whole `[…]` regions.
			for (const input of [
				":local z {[:put {#test}]}",
				":local z {[:put (1,#test)]}",
			]) {
				const classes = await highlightClasses(started.chr, input);
				expect(classes[input.indexOf("#")]).toBe("error");
			}
			// #249 — the same scope-named brace is an error already in the first group,
			// but verify offline fail-closed there too (CHR ground: error above)
			// and that no confident path/symbol fact is invented for the array
			// body — the changed pathresolve/symbols walkers must not emit one
			// even if the segmenter verdict later drifted.
			for (const scrap of [
				":local z {do={ # c\n:put 1}}",
				":local z {script={ # c\n:put 1}}",
				":local z { { # c\n:put 1}}",
				":local z {/ip/dhcp-server { # c\n:put 1}}",
			]) {
				expect(explainCommand(scrap).verdict).toBe("fail");
				expect(
					explainCommand(scrap).diagnostics.filter((diagnostic) =>
						diagnostic.code.endsWith("/invalid-hash"),
					),
				).toHaveLength(1);
				// `resolveDocument` must surface the hard defect so the statement
				// cannot be treated as successful context for the next line.
				expect(
					resolveDocument(scrap).defects.some((d) => d.code === "invalid-hash"),
				).toBe(true);
				// `resolveSymbols` likewise stops at the hash; no post-hash
				// occurrence should be claimed as confident.
				const symbols = resolveSymbols(scrap);
				expect(symbols.defects.some((d) => d.code === "invalid-hash")).toBe(
					true,
				);
				const hash = scrap.indexOf("#");
				expect(symbols.occurrences.some((o) => o.start > hash)).toBe(false);
			}
			for (const readable of [
				":local z {[:put #test]}",
				":local z {1;[:put #test]}",
			]) {
				const anchors = lexValueAnchors(readable, ":local".length, {
					directiveVerb: "local",
				});
				expect(anchors.complete).toBeTrue();
			}
			for (const refused of [
				":local z {[:put {#test}]}",
				":local z {[:put (1,#test)]}",
			]) {
				const anchors = lexValueAnchors(refused, ":local".length, {
					directiveVerb: "local",
				});
				expect(anchors.complete).toBeFalse();
			}
			// #249 — /menu { control: same construct WITHOUT the hash is valid
			// (proves the failure above is comment placement, not an earlier
			// invalid construct). Runtime must see it as an array value.
			{
				const control = ':local z {/ip/dhcp-server { :put "INNER"}}';
				const classes = await highlightClasses(started.chr, control);
				// No hash, so no error class; verify highlight is clean and :parse succeeds
				expect(classes.includes("error")).toBe(false);
				expect(
					outputOf(
						await started.chr.exec(
							`:put [:parse ${routerOsStringLiteral(control)}]`,
						),
					),
				).not.toMatch(/syntax error|expected end of command|failure/);
				const runtime = outputOf(
					await started.chr.exec(
						`${control}\n:put ("TYPE=" . [:typeof $z])\n:put ("VALUE=" . [:tostr $z])`,
					),
				);
				expect(runtime).toContain("TYPE=array");
				expect(runtime).toContain("VALUE=INNER");
			}

			const trailing = ":if (true) do={:put x} # c\n:put y";
			const trailingClasses = await highlightClasses(started.chr, trailing);
			expect(trailingClasses[trailing.indexOf("#")]).toBe("error");

			const reported = ":local x 1; /put $x; { :local x 2 # }; :set x 3 # blah";
			const reportedClasses = await highlightClasses(started.chr, reported);
			const firstHash = reported.indexOf("#");
			const secondHash = reported.indexOf("#", firstHash + 1);
			expect(reportedClasses[firstHash]).toBe("error");
			expect(reportedClasses[secondHash]).toBe("none");
			const reportedOffline = explainCommand(reported);
			expect(reportedOffline.verdict).toBe("fail");
			expect(
				reportedOffline.diagnostics.filter((diagnostic) =>
					diagnostic.code.endsWith("/invalid-hash"),
				),
			).toHaveLength(1);

			const continued =
				"/ip/address/add address=1.2.3.4 \\\n# a note\n comment=x";
			const continuedClasses = await highlightClasses(started.chr, continued);
			expect(continuedClasses[continued.indexOf("#")]).toBe("comment");
			const statement = explainCommand(continued).structure.statements[0];
			if (statement?.kind !== "command")
				throw new Error("expected a command statement");
			expect(statement?.arguments).toMatchObject({
				read: true,
				positional: [],
			});
			expect(statement.command.args).toEqual({
				address: "1.2.3.4",
				comment: "x",
			});
			expect(statement?.transport?.classification).toBe("api-candidate");

			await recordIntegrationEvidence({
				suite: "explain value facts against CHR",
				command: "explain",
				protocol: "rest-api (/console/inspect highlight + :parse IL)",
				routerosVersion: started.chr.state.version,
				quickChrName: started.chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [27],
			});
		} finally {
			await started.chr.destroy();
		}
	}, 300_000);
	/**
	 * Example 28 — the interior of an array literal, and the positions in which
	 * one exists at all.
	 *
	 * Every assertion below re-asks the device the question the offline lexicon
	 * answers: `:foreach k,v` is RouterOS's own enumeration of the members, so
	 * member identity is never inferred here, and `/console/inspect` names the
	 * exact byte a rejected brace fails at.
	 */
	test("example 28 grounds array members and where a brace array is legal", async () => {
		const started = await startIntegrationChr();
		try {
			/** The device's own member list: `k|kt|v|vt` per member. */
			const members = async (literal: string): Promise<string[]> =>
				outputOf(
					await started.chr.exec(
						`{ :local z ${literal}; :foreach k,v in=$z do={:put "$k|$[:typeof $k]|$v|$[:typeof $v]"} }`,
					),
				)
					.split("\n")
					.filter((line) => line.length > 0);

			// The separator belongs to the delimiter, and a comma inside braces
			// builds ONE nested member rather than splitting.
			expect(await members("{1;2}")).toEqual(["0|num|1|num", "1|num|2|num"]);
			expect(await members("(1,2)")).toEqual(["0|num|1|num", "1|num|2|num"]);
			expect((await members("{1,2}")).length).toBe(1);
			expect(outputOf(await started.chr.exec(":local z (1;2)"))).toContain(
				"syntax error",
			);

			// `=` is a key in braces and a comparison in parens.
			expect(await members("{a=1}")).toEqual(["a|str|1|num"]);
			expect(await members("(a=1,b=2)")).toEqual([
				"0|num|false|bool",
				"1|num|false|bool",
			]);

			// The member lexicon: what centrs hints, and what it must not.
			const memberType = async (literal: string): Promise<string> =>
				outputOf(
					await started.chr.exec(
						`{ :local z {${literal}}; :put [:typeof ($z->0)] }`,
					),
				).trim();
			for (const [literal, type] of [
				["1.1", "ip"],
				["1::1", "ip6"],
				["1.1.1.1/24", "ip-prefix"],
				["2008:1::2/128", "ip6-prefix"],
				["123", "num"],
				["0x10", "num"],
				["1d", "time"],
				["00:00:02", "time"],
				["yes", "bool"],
				['"abc"', "str"],
			] as const) {
				expect(await memberType(literal)).toBe(type);
				const hints = explainCommand(`:local z {${literal}}`)
					.values.occurrences.filter((value) => value.kind === "element")
					.flatMap((value) => value.facts.shapeHints?.values ?? []);
				expect(hints).toEqual([type]);
			}

			// `nothing` is the device saying "variable reference", where offline
			// must stay silent: a bare word, a MAC, a boolean in the wrong case,
			// and any time literal past 2^63 nanoseconds.
			for (const literal of [
				"abc",
				"ether1",
				"00:11:22:33:44:55",
				"Yes",
				"0X10",
				"100000w",
				"15251w",
				"106752d",
				"9223372037s",
			]) {
				expect(await memberType(literal)).toBe("nothing");
				expect(
					explainCommand(`:local z {${literal}}`).values.occurrences.filter(
						(value) => value.kind === "element",
					),
				).toEqual([]);
			}
			// …and the neighbors on the in-range side of that cliff.
			for (const literal of ["15250w", "106751d", "9223372036s"])
				expect(await memberType(literal)).toBe("time");

			// Literals that do not parse at all withdraw the enclosing shape.
			for (const literal of [
				"{}",
				"{;}",
				"{;1}",
				"{1;;2}",
				"(1,)",
				"{*1}",
				"{+1}",
			]) {
				expect(
					outputOf(await started.chr.exec(`:local z ${literal}`)),
				).toContain("syntax error");
				expect(
					explainCommand(`:local z ${literal}`).values.occurrences,
				).toEqual([]);
			}
			expect(await members("{1;}")).toEqual(["0|num|1|num"]);

			// Where a brace array is legal, byte for byte with the highlighter.
			for (const input of [
				"/ip/route/add comment={1;2}",
				"/ip/dns/set servers={1.1.1.1;8.8.8.8}",
				"/interface/print .proplist={name;comment}",
				"ip route add comment={1;2}",
				":log info message={1;2}",
			]) {
				const classes = await highlightClasses(started.chr, input);
				expect(classes.indexOf("error")).toBe(input.indexOf("{"));
				expect(
					outputOf(
						await started.chr.exec(
							`:put [:parse ${routerOsStringLiteral(input)}]`,
						),
					),
				).toMatch(/error/);
				expect(explainCommand(input).values.occurrences).toEqual([]);
			}
			for (const input of [
				":local z {1;2}",
				":put {1;2}",
				":foreach i in={1;2} do={:put $i}",
				"/ip/route/add comment=(1,2)",
			]) {
				expect(await highlightClasses(started.chr, input)).not.toContain(
					"error",
				);
				const parseOutput = outputOf(
					await started.chr.exec(
						`:put [:parse ${routerOsStringLiteral(input)}]`,
					),
				);
				expect(parseOutput).not.toMatch(/error/);
				if (input === ":foreach i in={1;2} do={:put $i}") {
					// A bare outer `$i` disappears before `:parse` and turns this into
					// `:put` with no operand. Pin the parser's real variable-bearing IL.
					expect(parseOutput).toContain("/putmessage=$i");
				}
				expect(
					explainCommand(input).values.occurrences[0]?.facts.shapeHints?.values,
				).toEqual(["array"]);
			}

			// The short IPv4 spelling is octet-bounded in both positions.
			for (const [literal, type] of [
				["1.255", "ip"],
				["1.256", "time"],
				["1.16777215", "time"],
				["3.14159", "time"],
				["1.1.255", "ip"],
			] as const) {
				expect(await memberType(literal)).toBe(type);
				expect(
					outputOf(
						await started.chr.exec(
							`{ :local x ${literal}; :put [:typeof $x] }`,
						),
					).trim(),
				).toBe(type);
			}
			expect(explainCommand(":local z 3.14159").values.occurrences).toEqual([]);

			// Example 28b — the comma spelling is accepted everywhere the brace is
			// not, and the ARGUMENT's type decides whether the device splits it.
			// `highlight` is read over the REST body so no RouterOS string quoting
			// sits between the assertion and the input.
			for (const [input, expected] of [
				["/ip/dns/set servers=1.1.1.1,8.8.8.8", "servers=1.1.1.1;8.8.8.8"],
				[
					"/ip/firewall/filter/add chain=forward protocol=tcp dst-port=80,443",
					"dst-port=;80;443",
				],
				["/ip/route/add comment=a,b", "comment=a,b"],
				[
					"/interface/bridge/port/add interface=ether1,ether2",
					"interface=ether1,ether2",
				],
			] as const) {
				expect(await highlightClasses(started.chr, input)).not.toContain(
					"error",
				);
				expect(
					outputOf(
						await started.chr.exec(
							`:put [:parse ${routerOsStringLiteral(input)}]`,
						),
					),
				).toContain(expected);
			}
			// Both readings exist for the same spelling, so a named attribute keeps
			// both; a directive's value slot has only the array reading.
			expect(
				outputOf(
					await started.chr.exec(
						'{ :local x 1,2; :put "$[:typeof $x]|$[:len $x]" }',
					),
				).trim(),
			).toBe("array|2");
			expect(
				explainCommand("/ip/dns/set servers=1.1.1.1,8.8.8.8").values
					.occurrences[0]?.facts.shapeHints?.values,
			).toEqual(["array", "str"]);
			expect(
				explainCommand(":local x 1,2").values.occurrences[0]?.facts.shapeHints
					?.values,
			).toEqual(["array"]);

			// Example 28c: the (verb, slot) gate, the nested rejection, and the
			// depth bound — each asked of the device first, then scored against
			// what centrs claims for the same bytes.
			const parseIl = async (source: string): Promise<string> =>
				outputOf(
					await started.chr.exec(
						`:put [:parse ${routerOsStringLiteral(source)}]`,
					),
				).replaceAll("\n", " ");
			const parses = (il: string): boolean =>
				!/syntax error|expected /.test(il);
			const claimsArray = (input: string): boolean =>
				explainCommand(input).values.occurrences.some((value) =>
					value.facts.shapeHints?.values?.includes("array"),
				);

			// A slot that EVALUATES the brace is an array; one that keeps it
			// verbatim is a script, and `{1;2}` cannot tell them apart because both
			// lower to `…=1;2`. `{(1,2)}` can: only an evaluated one lowers to
			// `(, 1 2)`.
			for (const [source, evaluated] of [
				[":local z {(1,2)}", true],
				[":put {(1,2)}", true],
				[":foreach i in={(1,2)} do={}", true],
				[":for i from={(1,2)} to=2 do={}", true],
				[":execute script={(1,2)}", false],
				[":grep script={(1,2)}", false],
			] as const) {
				const il = await parseIl(source);
				expect({ source, evaluated: il.includes("(, 1 2)") }).toEqual({
					source,
					evaluated,
				});
			}

			// Accepted and rejected controls, device verdict and product claim
			// scored together: a slot centrs calls an array must parse, and a slot
			// the device refuses must not be called one.
			for (const [source, array] of [
				[":local z {1;2}", true],
				[":global g {1;2}", true],
				[":put {1;2}", true],
				[":return {1;2}", true],
				[":foreach i in={1;2} do={:put 1}", true],
				[":for i from={1;2} to=2 do={:put 1}", true],
				[":delay {1;2}", false],
				[":beep {1;2}", false],
				[":resolve {1;2}", false],
				[":local {1;2}", false],
				[":local name={1;2}", false],
				[":if condition={1;2}", false],
				[":onerror e in={1;2} do={}", false],
				[":retry command={1;2}", false],
				[":execute script={1;2}", false],
				["/ip/dns/set servers={1.1.1.1;8.8.8.8}", false],
			] as const) {
				const il = await parseIl(source);
				expect({ source, array: claimsArray(source) }).toEqual({
					source,
					array,
				});
				if (array)
					expect({ source, parses: parses(il) }).toEqual({
						source,
						parses: true,
					});
			}

			// A directive's casing is load-bearing and an argument's is not, so the
			// gate matches the verb verbatim rather than normalizing it.
			for (const source of [":LOCAL z {1;2}", ":Local z {1;2}", ":PUT {1;2}"]) {
				expect({ source, parses: parses(await parseIl(source)) }).toEqual({
					source,
					parses: false,
				});
				expect({ source, array: claimsArray(source) }).toEqual({
					source,
					array: false,
				});
			}
			expect(parses(await parseIl(":local Z {1;2}"))).toBe(true);
			expect(claimsArray(":local Z {1;2}")).toBe(true);

			// A nested literal the device rejects withdraws its container, while
			// the group spellings next to it still read.
			for (const literal of [
				"{(1,)}",
				"{a=(1,)}",
				"{1;(2,)}",
				"{()}",
				"{a=()}",
				"{(,)}",
				"(1,(2,))",
			]) {
				const source = `:local z ${literal}`;
				expect({ literal, parses: parses(await parseIl(source)) }).toEqual({
					literal,
					parses: false,
				});
				expect({ literal, array: claimsArray(source) }).toEqual({
					literal,
					array: false,
				});
			}
			for (const literal of ["{(1)}", "{a=(1)}", "{1;(2)}", "{1;2;}"]) {
				const source = `:local z ${literal}`;
				expect({ literal, parses: parses(await parseIl(source)) }).toEqual({
					literal,
					parses: true,
				});
				expect({ literal, array: claimsArray(source) }).toEqual({
					literal,
					array: true,
				});
			}

			// The depth bound: a fault below it is still a device syntax error, so
			// eight frames read and nine withdraw rather than claim.
			const nest = (depth: number, body: string): string =>
				`:local z ${"{".repeat(depth)}${body}${"}".repeat(depth)}`;
			expect(parses(await parseIl(nest(9, "(1,)")))).toBe(false);
			expect(claimsArray(nest(9, "(1,)"))).toBe(false);
			expect(parses(await parseIl(nest(9, "1")))).toBe(true);
			expect(claimsArray(nest(8, "1"))).toBe(true);
			expect(claimsArray(nest(9, "1"))).toBe(false);

			await recordIntegrationEvidence({
				suite: "explain value facts against CHR",
				command: "explain",
				protocol: "rest-api (:typeof + :parse IL + /console/inspect highlight)",
				routerosVersion: started.chr.state.version,
				quickChrName: started.chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [28, "28b", "28c"],
			});
		} finally {
			await started.chr.destroy();
		}
	}, 300_000);
});
