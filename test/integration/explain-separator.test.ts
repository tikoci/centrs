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

const CODE = "explain/canonicalizer/missing-statement-separator";

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

/** The index of the first byte `highlight` classes `error`, or -1. */
async function firstErrorByte(chr: Chr, input: string): Promise<number> {
	const rows = (await chr.rest("/console/inspect", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ request: "highlight", input }),
	})) as { highlight?: string }[];
	const csv = rows[0]?.highlight ?? "";
	return csv === "" ? -1 : csv.split(",").indexOf("error");
}

function separatorFlags(input: string) {
	return explainCommand(input, {}).diagnostics.filter((d) => d.code === CODE);
}

/**
 * The two shapes of device complaint, both meaning "not this".
 *
 * `:parse` never throws (#228): an accepted program comes back as IL, and a
 * rejected one comes back as a diagnostic VALUE. It also has a THIRD answer —
 * IL that carries `bad parameter <token> (line…)` inline, having dropped the
 * offending operand. Which of the last two a missing separator draws depends on
 * whether the second run's words abbreviate an argument name of the HEAD menu,
 * which is per-menu schema. So the assertion below accepts either, and the
 * offline rule is grounded on the device never answering cleanly.
 */
function deviceComplained(parsed: string): boolean {
	return (
		PARSE_REJECTED.test(parsed) || /bad parameter|bad command/.test(parsed)
	);
}

/**
 * Inputs where offline reports a missing statement separator (#311).
 *
 * Three device answers, all meaning "not this", and WHICH one appears is
 * per-menu schema rather than anything offline can see:
 *
 * - `hard` — `:parse` refuses outright (`PARSE_REJECTED`).
 * - `names` — `:parse` returns IL carrying `bad parameter <that token>`. The
 *   token is usually the second PATH, but on a head whose own value slot takes
 *   a bare positional the path is absorbed into it (`:put /ip/route print`
 *   lowers to `/putmessage=/ip/route`) and the device names the VERB instead.
 *
 * Pinned per row rather than matched loosely, because the token the device
 * picks is the fact that decides how much the diagnostic may claim: offline
 * asserts only that RouterOS never accepts the shape, never which byte it will
 * complain about.
 */
const FLAGGED: {
	input: string;
	hard?: true;
	names?: string;
	errorByte?: number;
}[] = [
	{
		input:
			"/ip/address add interface=ether1 /ip/route add gateway=192.168.88.1",
		hard: true,
		errorByte: 54,
	},
	{
		input: "/ip/address add interface=ether1 /ip route add gateway=1.2.3.4",
		hard: true,
	},
	{ input: "/ip/address add interface=ether1 /ip/route add", hard: true },
	{
		input: "/ip/address add interface=ether1 /ip/route print",
		names: "/ip/route",
	},
	{
		input: "/system/note set note=hello /ip/route add gateway=1.2.3.4",
		names: "/ip/route",
	},
	{
		input: "/system/note set note=hello /ip/route remove numbers=0",
		names: "/ip/route",
	},
	{
		input: "/ip/route add gateway=1.1.1.1 /ip/dns set servers=8.8.8.8",
		names: "/ip/dns",
	},
	// Heads whose own value slot takes a bare positional: the path lands in that
	// slot and the VERB is what the device refuses. Still never accepted — which
	// is the whole of the offline claim — but the proof that the diagnostic must
	// say "this READS as a second command", not "the device starts one here".
	{ input: ":put /ip/route print", names: "print" },
	{ input: ":local a /ip/route add", names: "add" },
	{ input: ":log info /ip/route print", names: "print" },
	{ input: ":set a /ip/route print", hard: true },
	{ input: "/import file-name=x.rsc /ip/route add", names: "/ip/route" },
	// A menu segment that starts with a DIGIT. `/interface/6to4` is the shipped
	// structure table's only such name, and the shape filter over a candidate
	// path has to admit it or both spellings miss the rule. Grounded on 7.24.2:
	// the two `/ip/address add` heads answer `expected end of command
	// (line 1 column 58)`, and the `/system/note set` head answers
	// `(evl bad parameter /interface/6to4 (line 1 column 44) …)`.
	{
		input: "/ip/address add interface=ether1 /interface/6to4 add name=t1",
		hard: true,
	},
	{
		input: "/ip/address add interface=ether1 /interface 6to4 add name=t1",
		hard: true,
	},
	{
		input: "/system/note set note=hello /interface/6to4 add name=t1",
		names: "/interface/6to4",
	},
];

/**
 * Inputs offline leaves alone that RouterOS accepts with no complaint at all.
 *
 * These are the reason the rule is not "a `/` after the verb": a slash-shaped
 * operand is legal and lowers to `numbers=`.
 */
const CLEAN: string[] = [
	"/file remove /flash/skins/foo.html",
	"/file remove a",
	"/ip/route add dst-address=0.0.0.0/0 gateway=1.2.3.4",
	"/tool/fetch url=https://example.com/a/b mode=https",
	'/ip/address add interface=ether1 comment="/ip/route add gateway=1.2.3.4"',
	"/ip/address add interface=ether1 comment=[/ip/route add gateway=1.2.3.4]",
	":foreach i in={1;2} do={/ip/route add gateway=192.168.88.1}",
	"/ip/route print detail terse",
	"/interface/ethernet/monitor 0 once",
	// A bare menu path IS a legal operand when no verb follows it — the device
	// lowers this to `/system/script/runnumber=/ip/route`. This is the control
	// the rule's "path THEN verb" condition exists for.
	"/system/script/run /ip/route",
	// The bracketed spelling of the flagged directive rows above.
	":put [/ip/route print]",
];

/** The same commands, separated. Both spellings must parse to two programs. */
const CORRECTED: string[] = [
	"/ip/address add interface=ether1; /ip/route add gateway=192.168.88.1",
	"/ip/address add interface=ether1\n/ip/route add gateway=192.168.88.1",
	"/system/note set note=hello; /ip/route add gateway=1.2.3.4",
];

describeFast("explain missing statement separator against CHR (#311)", () => {
	test("every flagged run is refused, every control is accepted", async () => {
		const started = await startIntegrationChr();
		try {
			for (const { input, hard, names, errorByte } of FLAGGED) {
				expect({ input, flags: separatorFlags(input).length }).toEqual({
					input,
					flags: 1,
				});
				const parsed = await parseOf(started.chr, input);
				// The claim the offline `error` severity rests on: RouterOS never
				// accepts this shape cleanly.
				expect({ input, parsed, complained: deviceComplained(parsed) }).toEqual(
					{
						input,
						parsed,
						complained: true,
					},
				);
				if (hard === true)
					expect({ input, rejected: PARSE_REJECTED.test(parsed) }).toEqual({
						input,
						rejected: true,
					});
				// Not a hard reject — the IL names one exact token as the bad
				// operand. Pinned, because which token it is is the head-dependence
				// the offline rule refuses to predict.
				else
					expect({
						input,
						named: parsed.includes(`bad parameter ${names}`),
					}).toEqual({ input, named: true });
				if (errorByte !== undefined)
					expect({
						input,
						byte: await firstErrorByte(started.chr, input),
					}).toEqual({ input, byte: errorByte });
			}

			for (const input of CLEAN) {
				expect(separatorFlags(input)).toEqual([]);
				const parsed = await parseOf(started.chr, input);
				expect({ input, complained: deviceComplained(parsed) }).toEqual({
					input,
					complained: false,
				});
				expect({ input, hinted: PARSE_REJECTED_HINT.test(parsed) }).toEqual({
					input,
					hinted: false,
				});
				expect({
					input,
					errorByte: await firstErrorByte(started.chr, input),
				}).toEqual({ input, errorByte: -1 });
			}

			for (const input of CORRECTED) {
				const result = explainCommand(input, {});
				expect({ input, verdict: result.verdict }).toEqual({
					input,
					verdict: "pass",
				});
				expect({ input, count: result.structure.statementCount }).toEqual({
					input,
					count: 2,
				});
				const parsed = await parseOf(started.chr, input);
				expect({ input, complained: deviceComplained(parsed) }).toEqual({
					input,
					complained: false,
				});
				// Two programs on the device, matching the two statements offline read.
				expect({ input, programs: parsed.split("(evl ").length - 1 }).toEqual({
					input,
					programs: 2,
				});
			}

			await recordIntegrationEvidence({
				suite: "explain-separator",
				command: "explain",
				protocol: "rest-api",
				routerosVersion: started.chr.state.version,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [29, "29b"],
			});
		} finally {
			await started.chr.destroy();
		}
	}, 300_000);

	/**
	 * The head-dependence that #311's report did not have.
	 *
	 * `/ip/address add … /ip/route add placeholder` lowers to
	 * `address=placeholder;;interface=ether1` — an attribute the source never wrote,
	 * because `add` abbreviates the head's own `address=`. That is why the
	 * offline reading withdraws the whole argument list instead of keeping the
	 * attributes it lexed.
	 */
	test("the head's own argument list is not safe to keep", async () => {
		const started = await startIntegrationChr();
		try {
			const input =
				"/ip/address add interface=ether1 /ip/route add placeholder";
			const parsed = await parseOf(started.chr, input);
			expect(parsed).toContain("address=placeholder");
			expect(parsed).toContain("bad parameter /ip/route");

			// The device just produced `address=placeholder`; offline publishes neither
			// that nor the `interface=ether1` it lexed.
			const [only] = explainCommand(input, {}).structure.statements;
			expect(only?.command).toEqual({ path: "/ip/address", verb: "add" });
			expect(only?.arguments?.read).toBe(false);
			expect(only?.transport?.classification).toBe("unknown");

			// The other half of the same row, and the grounding for the value cut:
			// what the head wrote BEFORE the run survives into the IL untouched, so
			// `values.occurrences` keeps it while dropping everything from the run's
			// first byte on. Two heads, two spellings of the same fact.
			expect(parsed).toContain("interface=ether1");
			const noteRow = await parseOf(
				started.chr,
				"/system/note set note=hello /ip/route add gateway=1.2.3.4",
			);
			expect(noteRow).toContain("note=hello");
			expect(noteRow).not.toContain("gateway");

			const values = explainCommand(input, {}).values.occurrences;
			expect(values.map((v) => v.name)).toEqual(["interface"]);
		} finally {
			await started.chr.destroy();
		}
	}, 300_000);
});
