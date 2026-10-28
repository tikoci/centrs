import { describe, expect, test } from "bun:test";
import { routerOsStringLiteral } from "../../src/core/routeros-string.ts";
import { explainCommand } from "../../src/explain.ts";
import {
	isChrIntegrationEnabled,
	PARSE_REJECTED,
	PARSE_REJECTED_HINT,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

const WARNING = "explain/canonicalizer/possible-spaced-argument";
const BRACE = "explain/canonicalizer/invalid-command-brace";
const AMBIGUOUS = "explain/canonicalizer/possible-script-body-abbreviation";

interface Chr {
	exec(command: string): Promise<unknown>;
	rest(path: string, init?: RequestInit): Promise<unknown>;
}

/** `:parse` on the exact bytes — its diagnostic, or the IL when it accepted. */
async function parseOf(chr: Chr, input: string): Promise<string> {
	const result = (await chr.exec(
		`:put [:parse ${routerOsStringLiteral(input)}]`,
	)) as { output?: unknown };
	return String(result.output ?? "")
		.replaceAll("\r\n", "\n")
		.trim();
}

/** The `highlight` class of every byte. */
async function highlightOf(chr: Chr, input: string): Promise<string[]> {
	const rows = (await chr.rest("/console/inspect", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ request: "highlight", input }),
	})) as { highlight?: string }[];
	return (rows[0]?.highlight ?? "").split(",");
}

function offline(input: string) {
	const result = explainCommand(input, {});
	return {
		read: result.structure.statements[0]?.arguments?.read,
		warnings: result.diagnostics
			.filter((d) => d.code === WARNING)
			.map((d) => input.slice(d.span.start, d.span.end)),
		braces: result.diagnostics.filter((d) => d.code === BRACE).length,
		ambiguous: result.diagnostics.filter((d) => d.code === AMBIGUOUS).length,
	};
}

/**
 * The spaced spelling and its `=` twin (#350). The device lowers both to the
 * same IL and marks each gap in `obsolete` `syntax-obsolete`. Offline abstains
 * on every row and warns on exactly the `warns` pairs: those whose value cannot
 * be a flag. The bare-word rows are obsolete on device too, which is the
 * deliberate gap — offline cannot tell them from the flag rows below.
 */
const PAIRED: {
	input: string;
	twin: string;
	obsolete: string[];
	warns: string[];
}[] = [
	{
		input: '/ip/firewall/layer7-protocol add comment "something" regexp 1.1',
		twin: '/ip/firewall/layer7-protocol add comment="something" regexp=1.1',
		obsolete: ['comment "something"', "regexp 1.1"],
		warns: ['comment "something"', "regexp 1.1"],
	},
	{
		input: '/system/note set note "hello there"',
		twin: '/system/note set note="hello there"',
		obsolete: ['note "hello there"'],
		warns: ['note "hello there"'],
	},
	{
		input: '/interface set ether1 comment "x"',
		twin: '/interface set ether1 comment="x"',
		obsolete: ['comment "x"'],
		warns: ['comment "x"'],
	},
	{
		input: "/interface set ether1 name x",
		twin: "/interface set ether1 name=x",
		obsolete: ["name x"],
		warns: [],
	},
	{
		input: "/interface set ether1 disabled yes",
		twin: "/interface set ether1 disabled=yes",
		obsolete: ["disabled yes"],
		warns: [],
	},
];

/** Two value-less flags: the same bytes as a pair, with no `syntax-obsolete`. */
const FLAGS: { input: string; il: string }[] = [
	{
		input: "/interface print detail without-paging",
		il: "detail=true;without-paging=true",
	},
	{
		input: "/interface print without-paging detail",
		il: "detail=true;without-paging=true",
	},
];

/** A body after a script-valued argument, with the `=` left out: the `=` IL. */
const BODIES: { input: string; twin: string }[] = [
	{
		input: "/system/script add name=beep source { :beep }",
		twin: "/system/script add name=beep source={ :beep }",
	},
	{
		input: "/system/scheduler add name=x on-event { :beep }",
		twin: "/system/scheduler add name=x on-event={ :beep }",
	},
	{
		input: "/tool/netwatch add host=1.1.1.1 down-script { :beep }",
		twin: "/tool/netwatch add host=1.1.1.1 down-script={ :beep }",
	},
];

describeFast("explain spaced arguments against CHR (#350)", () => {
	test("pairs lower to their `=` twin and flags do not pair", async () => {
		const started = await startIntegrationChr();
		try {
			for (const { input, twin, obsolete, warns } of PAIRED) {
				const parsed = await parseOf(started.chr, input);
				expect({ input, parsed }).toEqual({
					input,
					parsed: await parseOf(started.chr, twin),
				});
				const classes = await highlightOf(started.chr, input);
				for (const pair of obsolete) {
					const gap = input.indexOf(pair) + pair.indexOf(" ");
					expect({ input, pair, gap: classes[gap] }).toEqual({
						input,
						pair,
						gap: "syntax-obsolete",
					});
				}
				expect({ input, ...offline(input) }).toEqual({
					input,
					read: false,
					warnings: warns,
					braces: 0,
					ambiguous: 0,
				});
			}

			for (const { input, il } of FLAGS) {
				expect(await parseOf(started.chr, input)).toContain(il);
				const classes = await highlightOf(started.chr, input);
				expect({
					input,
					obsolete: classes.includes("syntax-obsolete"),
				}).toEqual({ input, obsolete: false });
				expect({ input, ...offline(input) }).toEqual({
					input,
					read: false,
					warnings: [],
					braces: 0,
					ambiguous: 0,
				});
			}

			// The control that makes pairing schema: an argument the command does not
			// have. 7.24.x names it (`bad parameter zzznotanarg`); 7.22.1 answers
			// `expected end of command`. Either way, not accepted.
			const unknown = await parseOf(
				started.chr,
				"/system/script add zzznotanarg beep",
			);
			expect(
				PARSE_REJECTED.test(unknown) || unknown.includes("bad parameter"),
			).toBeTrue();

			// A root directive's operands are positional by grammar, not spaced.
			expect(await parseOf(started.chr, ":pick abc 0 1")).toContain(
				"counter=abc",
			);

			await recordIntegrationEvidence({
				suite: "explain-spaced-args",
				command: "explain",
				protocol: "rest-api",
				routerosVersion: started.chr.state.version,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [33],
			});
		} finally {
			await started.chr.destroy();
		}
	}, 300_000);

	test("a script body may drop its `=`; any other brace may not", async () => {
		const started = await startIntegrationChr();
		try {
			for (const { input, twin } of BODIES) {
				expect({ input, parsed: await parseOf(started.chr, input) }).toEqual({
					input,
					parsed: await parseOf(started.chr, twin),
				});
				expect({ input, braces: offline(input).braces }).toEqual({
					input,
					braces: 0,
				});
			}

			// `…-script` is a body slot in the `=` spelling too.
			const upScript = "/tool/netwatch add host=1.1.1.1 up-script={ :beep }";
			expect(await parseOf(started.chr, upScript)).toContain("up-script=");
			expect(explainCommand(upScript, {}).verdict).toBe("pass");

			for (const input of [
				"/system/scheduler add name=x comment { :beep }",
				"/tool/netwatch add host=1.1.1.1 comment={ :beep }",
				"/system/script add name=x zzzscript { :beep }",
			]) {
				expect({
					input,
					rejected: PARSE_REJECTED.test(await parseOf(started.chr, input)),
				}).toEqual({ input, rejected: true });
			}
			// The fail-open direction, pinned so the unit test's claim stays true:
			// an argument the command lacks is rejected on device, while offline
			// reads the brace as a body and reports nothing.
			for (const input of [
				"/tool/netwatch add host=1.1.1.1 zzz-script={ :beep }",
				"/tool/netwatch add host=1.1.1.1 on-zzz={ :beep }",
			]) {
				expect({
					input,
					rejected: PARSE_REJECTED.test(await parseOf(started.chr, input)),
					braces: offline(input).braces,
				}).toEqual({ input, rejected: true, braces: 0 });
			}

			// The spaced rows stay the offline error: `zzzscript` lacks the hyphen
			// of RouterOS's `…-script` names, so it is not a script-body shape,
			// and a spaced body after `comment` is not an abbreviation either.
			// The `=` row warns instead of rejecting (#525): `comment={` with a
			// script-like body may abbreviate a script slot the device knows,
			// and offline has no per-command argument list to rule it out —
			// the device pins above still show this one rejected.
			for (const input of [
				"/system/scheduler add name=x comment { :beep }",
				"/system/script add name=x zzzscript { :beep }",
			])
				expect({ input, braces: offline(input).braces }).toEqual({
					input,
					braces: 1,
				});
			{
				const input = "/tool/netwatch add host=1.1.1.1 comment={ :beep }";
				expect({ input, ...offline(input) }).toEqual({
					input,
					read: false,
					warnings: [],
					braces: 0,
					ambiguous: 1,
				});
			}
		} finally {
			await started.chr.destroy();
		}
	}, 300_000);

	test("a brace after a command is its operand, not a menu block (#496)", async () => {
		const started = await startIntegrationChr();
		/** `:parse` accepted `input`, and its IL names every `needle`. */
		const accepted = async (input: string, needles: string[]) => {
			const parsed = await parseOf(started.chr, input);
			expect({
				input,
				rejected: PARSE_REJECTED_HINT.test(parsed),
				evl: parsed.startsWith("(evl"),
				missing: needles.filter((needle) => !parsed.includes(needle)),
			}).toEqual({ input, rejected: false, evl: true, missing: [] });
			return parsed;
		};
		try {
			// One command whose body is the script-valued argument. Each spelling is
			// proved accepted on its own before it is compared with the full one, so
			// two identical rejections cannot pass as agreement.
			const bodies: { input: string; full: string; needles: string[] }[] = [
				{
					input: "/system/script add name beep source { :beep }",
					full: "/system/script add name beep source={ :beep }",
					needles: ["(evl /system/script/add", "source= :beep"],
				},
				{
					input: "/system/scheduler add name beep on-event { :beep }",
					full: "/system/scheduler add name beep on-event={ :beep }",
					needles: ["(evl /system/scheduler/add", "on-event= :beep"],
				},
				// Abbreviations the script-slot shape still pins down.
				{
					input: "/system/script add name beep sour { :beep }",
					full: "/system/script add name beep source { :beep }",
					needles: ["(evl /system/script/add", "source= :beep"],
				},
				{
					input: "/tool/netwatch add host 1.1.1.1 down-scr { :beep }",
					full: "/tool/netwatch add host 1.1.1.1 down-script { :beep }",
					needles: ["(evl /tool/netwatch/add", "down-script= :beep"],
				},
				{
					input: "/system/scheduler add name=x o={ :beep }",
					full: "/system/scheduler add name=x on-event={ :beep }",
					needles: ["(evl /system/scheduler/add", "on-event= :beep"],
				},
			];
			for (const { input, full, needles } of bodies) {
				expect({ input, parsed: await accepted(input, needles) }).toEqual({
					input,
					parsed: await accepted(full, needles),
				});
				expect({
					input,
					statements: explainCommand(input, {}).structure.statements.length,
					braces: offline(input).braces,
				}).toEqual({ input, statements: 1, braces: 0 });
			}

			// A positional brace after a command is rejected, whether the verb is a
			// CRUD word or a catalog command, and so is a body after an argument
			// that cannot take one.
			for (const input of [
				"/system/script add { :beep }",
				"/ip/route/print {1;2}",
				"/system/reboot { :beep }",
				"/tool fetch { :beep }",
				"/system/script add name beep comment { :beep }",
				"/system/script add name beep com { :beep }",
			]) {
				expect({
					input,
					rejected: PARSE_REJECTED.test(await parseOf(started.chr, input)),
					braces: offline(input).braces,
				}).toEqual({ input, rejected: true, braces: 1 });
			}

			// The former known limit (#525): a first-segment abbreviation is
			// accepted on device, and offline cannot tell it from `comment`
			// without schema — so it warns and lets the device decide instead
			// of rejecting. The device pins show each shape accepted as
			// `down-script=`: a directive body, a bare command word, and a
			// body after a comment line.
			for (const { input, needle } of [
				{
					input: "/tool/netwatch add host=1.1.1.1 down={ :beep }",
					needle: "down-script= :beep",
				},
				{
					input: "/tool/netwatch add host=1.1.1.1 down={ beep }",
					needle: "down-script= beep",
				},
				{
					input: "/tool/netwatch add host=1.1.1.1 down={ # c\n :beep }",
					needle: "down-script= # c",
				},
			]) {
				await accepted(input, [needle]);
				expect({ input, ...offline(input) }).toEqual({
					input,
					read: false,
					warnings: [],
					braces: 0,
					ambiguous: 1,
				});
			}

			// A run that names no command still opens a menu block.
			for (const { input, needles } of [
				{
					input: "/system script { print }",
					needles: ["(evl (evl /system/script/print"],
				},
				{
					input: "/ip firewall filter { print }",
					needles: ["(evl (evl /ip/firewall/filter/print"],
				},
				{
					input: "/system { script add name beep source { :beep } }",
					needles: ["(evl (evl /system/script/add", "source= :beep"],
				},
			]) {
				await accepted(input, needles);
				expect({ input, braces: offline(input).braces }).toEqual({
					input,
					braces: 0,
				});
			}

			await recordIntegrationEvidence({
				suite: "explain-spaced-args",
				command: "explain",
				protocol: "rest-api",
				routerosVersion: started.chr.state.version,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [35],
			});
		} finally {
			await started.chr.destroy();
		}
	}, 300_000);

	test("the abbreviation guess never shields a root slot or a `where` comparison (#554)", async () => {
		const started = await startIntegrationChr();
		try {
			// Root slots: the (verb, slot) table decides, and neither slot
			// takes a body through any spelling.
			for (const input of [":put x={ :beep }", ":local name={ :put 1 }"]) {
				expect({
					input,
					rejected: PARSE_REJECTED.test(await parseOf(started.chr, input)),
					...offline(input),
				}).toEqual({
					input,
					rejected: true,
					read: false,
					warnings: [],
					braces: 1,
					ambiguous: 0,
				});
			}

			// A `where` named comparison reads the brace with the property's
			// own parser however the clause is wrapped, so the body the brace
			// holds never matters.
			for (const [input, wording] of [
				["/ip/route/print where gateway={ :beep }", "expected gateway value"],
				[
					"/ip/address remove [find where comment={ :beep }]",
					"expected comment value",
				],
				[
					"/system/script add name=x source={ /ip/route/print where (gateway={ :beep }) }",
					"expected gateway value",
				],
			] as const)
				expect({
					input,
					parse: await parseOf(started.chr, input),
					...offline(input),
				}).toEqual({
					input,
					parse: expect.stringContaining(wording),
					read: false,
					warnings: [],
					braces: 1,
					ambiguous: 0,
				});

			// The spaced `name= {…}` spelling lowers exactly like the glued
			// one, so it warns under the same gates instead of erroring.
			{
				const input = "/tool/netwatch add host=1.1.1.1 down= { :beep }";
				const parsed = await parseOf(started.chr, input);
				expect({
					input,
					rejected: PARSE_REJECTED_HINT.test(parsed),
					evl: parsed.startsWith("(evl"),
					lowered: parsed.includes("down-script= :beep"),
				}).toEqual({ input, rejected: false, evl: true, lowered: true });
				expect({ input, ...offline(input) }).toEqual({
					input,
					read: false,
					warnings: [],
					braces: 0,
					ambiguous: 1,
				});
			}

			// The spaced tradeoff mirrors the glued one: `comment= { :beep }`
			// is rejected on the device but warns offline, while a spaced
			// array-content brace keeps its error and a spaced proven slot
			// stays silent.
			for (const input of [
				"/tool/netwatch add host=1.1.1.1 comment= { :beep }",
				"/tool/netwatch add host=1.1.1.1 comment= {1;2}",
			])
				expect({
					input,
					rejected: PARSE_REJECTED.test(await parseOf(started.chr, input)),
				}).toEqual({ input, rejected: true });
			expect({
				...offline("/tool/netwatch add host=1.1.1.1 comment= { :beep }"),
			}).toEqual({ read: false, warnings: [], braces: 0, ambiguous: 1 });
			expect({
				...offline("/tool/netwatch add host=1.1.1.1 comment= {1;2}"),
			}).toEqual({ read: false, warnings: [], braces: 1, ambiguous: 0 });
			{
				const input = "/tool/netwatch add host=1.1.1.1 down-script= { :beep }";
				expect(await parseOf(started.chr, input)).toContain(
					"down-script= :beep",
				);
				expect({ ...offline(input) }).toEqual({
					read: false,
					warnings: [],
					braces: 0,
					ambiguous: 0,
				});
			}
		} finally {
			await started.chr.destroy();
		}
	}, 300_000);
});
