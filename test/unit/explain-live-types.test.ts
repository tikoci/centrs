import { describe, expect, test } from "bun:test";
import { explainCommand } from "../../src/explain.ts";
import { collectExplainEvidence } from "../../src/explain-live.ts";
import {
	EXPLAIN_TYPE_LIMITS,
	observedTypeOf,
	resolveArgumentName,
	schemaTypeOf,
	splitRenderings,
} from "../../src/explain-live-types.ts";
import longTerm from "../fixtures/explain/live-types.long-term.json";
import stable from "../fixtures/explain/live-types.stable.json";

type Backend = Parameters<typeof collectExplainEvidence>[2];
type Call = { method: string; args: unknown[]; result?: unknown };

/** Serves recorded answers by request, so replay does not depend on call order. */
function replay(calls: readonly Call[]): Backend {
	const answer = (method: string, args: unknown[]) => {
		const key = JSON.stringify([method, ...args]);
		const call = calls.find(
			(c) => JSON.stringify([c.method, ...c.args]) === key,
		);
		if (!call) throw new Error(`unrecorded call ${key}`);
		return call.result;
	};
	return {
		protocol: "rest-api",
		getSingleton: async (path) => answer("getSingleton", [path]),
		inspect: async (...args) => answer("inspect", args) as unknown[],
		execute: async (request) => answer("execute", [request]) as never,
	} as Backend;
}

describe("committed CHR value-type evidence (#225)", () => {
	for (const fixture of [stable, longTerm])
		for (const capture of fixture.captures)
			test(`${fixture.version} example ${capture.example}`, async () => {
				const data = explainCommand(capture.input);
				await collectExplainEvidence(
					data,
					capture.input,
					replay(capture.calls as Call[]),
				);
				expect(data.values.occurrences).toEqual(capture.values as never);
				expect(data.runtimeAcceptance).toBe("not-proven");
			});
});

/**
 * What each literal is observed as, in each context. `-` is an abstention: the
 * rendering is unchanged, or no type explains it (`$abc`, `(- 1)`).
 */
const EXPECTED: Record<string, [operand: string, member: string]> = {
	"2.2": ["ip", "ip"],
	"1.1.1.1": ["-", "-"],
	"2.2/8": ["ip-prefix", "ip-prefix"],
	"1.1.1.1/24": ["-", "-"],
	"1::1": ["-", "-"],
	"1:0:0::1": ["ip6", "ip6"],
	"2008:1::2/128": ["-", "-"],
	"0123": ["num", "num"],
	"0x10": ["num", "num"],
	"-1": ["-", "-"],
	"123": ["-", "-"],
	"99999999999999999999": ["num", "num"],
	yes: ["bool", "bool"],
	no: ["bool", "bool"],
	true: ["-", "-"],
	false: ["-", "-"],
	Yes: ["-", "-"],
	"200ms": ["time", "time"],
	"1d": ["time", "time"],
	"1w7h2s": ["time", "time"],
	"00:00:02": ["-", "-"],
	"1:2": ["time", "time"],
	"100000w": ["-", "-"],
	"10000w": ["time", "time"],
	"00:11:22:33:44:55": ["-", "-"],
	abc: ["-", "-"],
	"a-b": ["-", "-"],
	"1e5": ["-", "-"],
	"1.1.1.1.1": ["-", "-"],
	"300.1.1.1": ["-", "-"],
	"2.2-3.3": ["-", "-"],
};

describe("the conversion matrix (#225)", () => {
	for (const fixture of [stable, longTerm])
		test(`${fixture.version}: every literal observes as recorded`, () => {
			for (const row of fixture.matrix) {
				const rendered = splitRenderings(row.output, row.literals.length);
				expect(rendered).toBeDefined();
				const column = row.context === "operand" ? 0 : 1;
				const observed: (string | undefined)[] = row.literals.map(
					(literal, i) =>
						observedTypeOf(literal, rendered?.[i] ?? "", "ev")?.value ?? "-",
				);
				expect(observed).toEqual(
					row.literals.map((literal) => EXPECTED[literal]?.[column]),
				);
			}
		});

	test("an unchanged rendering is never a type, however typed it looks", () => {
		for (const literal of ["123", "1.1.1.1", "true", "00:00:02", "1::1"])
			expect(observedTypeOf(literal, literal, "ev")).toBeUndefined();
	});

	test("a rendering no type explains abstains", () => {
		expect(observedTypeOf("abc", "$abc", "ev")).toBeUndefined();
		expect(observedTypeOf("-1", "(- 1)", "ev")).toBeUndefined();
		expect(observedTypeOf("1.2", "1.2/x", "ev")).toBeUndefined();
	});

	test("a rendering that does not split into one per literal is refused", () => {
		expect(
			splitRenderings(
				"(evl /localname=$v0;value=1);(evl /localname=$v1;value=2)",
				2,
			),
		).toEqual(["1", "2"]);
		expect(splitRenderings("(evl /localname=$v0;value=1)", 2)).toBeUndefined();
		expect(
			splitRenderings("syntax error (line 1 column 9)", 1),
		).toBeUndefined();
		expect(splitRenderings("(evl /localname=$v0;value=1", 1)).toBeUndefined();
	});
});

/** A device that answers each probe from a table, recording what it was asked. */
function device(
	answers: {
		parse?: (script: string) => string;
		syntax?: Record<string, Record<string, string>[]>;
		children?: Record<string, string[]>;
	} = {},
) {
	const calls: { method: string; args: unknown[] }[] = [];
	const backend = {
		protocol: "rest-api",
		getSingleton: async () => ({ version: "7.24.5" }),
		execute: async (request: { script: string }) => {
			calls.push({ method: "execute", args: [request.script] });
			const inner = request.script.startsWith(":put [:parse ")
				? request.script
				: "";
			return { ret: answers.parse?.(inner) ?? "" };
		},
		inspect: async (request: string, path: string, input?: string) => {
			calls.push({ method: "inspect", args: [request, path] });
			if (request === "highlight")
				return [
					{
						highlight: Array(input?.length ?? 0)
							.fill("none")
							.join(","),
					},
				];
			if (request === "child")
				return (answers.children?.[path] ?? []).map((name) => ({
					type: "child",
					"node-type": "arg",
					name,
				}));
			if (request === "syntax") return answers.syntax?.[path] ?? [];
			return [];
		},
	} as unknown as Backend;
	return { backend, calls };
}

const typeProbes = (calls: { method: string; args: unknown[] }[]) =>
	calls.filter(
		(c) => c.method === "execute" && String(c.args[0]).includes(":local v0 "),
	);

describe("observedType reaches only bare scripting literals", () => {
	test("a menu-command argument is never probed or observed", async () => {
		const input = "/ip/route/add distance=0x10";
		const { backend, calls } = device({
			parse: () => "(evl /localname=$v0;value=16)",
		});
		const data = explainCommand(input);
		await collectExplainEvidence(data, input, backend);
		expect(typeProbes(calls)).toEqual([]);
		for (const o of data.values.occurrences)
			expect(o.facts.observedType).toBeUndefined();
	});

	test("a directive's named argument joins the operand batch", async () => {
		const input = ":for i from=0x10 to=20 do={:put $i}";
		const { backend, calls } = device({
			parse: (script) =>
				script.includes(":local v0 ")
					? "(evl /localname=$v0;value=16);(evl /localname=$v1;value=20)"
					: "(evl /forcounter=$i;do=;(evl /putmessage=$i);from=16;to=20)",
		});
		const data = explainCommand(input);
		await collectExplainEvidence(data, input, backend);
		expect(String(typeProbes(calls)[0]?.args[0])).toContain(
			":local v0 0x10;:local v1 20",
		);
		expect(data.values.occurrences[0]?.facts.observedType?.value).toBe("num");
		expect(data.values.occurrences[1]?.facts.observedType).toBeUndefined();
	});

	for (const input of [
		":local yes 2",
		":set yes 3",
		":for yes from=1 to=2 do={}",
		":local name=no value=1",
		":for counter=yes from=1 to=2 do={}",
	])
		test(`a NAME slot is a variable, never probed: ${input}`, async () => {
			const { backend, calls } = device();
			const data = explainCommand(input);
			await collectExplainEvidence(data, input, backend);
			const script = String(typeProbes(calls)[0]?.args[0] ?? "");
			expect(script).not.toMatch(/:local v\d+ (yes|no)\b/);
		});

	test("a quoted operand is never probed", async () => {
		const input = ':local x "2.2"';
		const { backend, calls } = device();
		const data = explainCommand(input);
		await collectExplainEvidence(data, input, backend);
		expect(typeProbes(calls)).toEqual([]);
	});

	test("a batch past the literal budget is skipped, not cut", async () => {
		const members = Array.from(
			{ length: EXPLAIN_TYPE_LIMITS.literals + 1 },
			(_, i) => String(i + 1),
		);
		const input = `:local z {${members.join(";")}}`;
		const { backend, calls } = device();
		const data = explainCommand(input);
		await collectExplainEvidence(data, input, backend);
		expect(typeProbes(calls)).toEqual([]);
		const ev = data.evidence.find(
			(e) => e.facet === "types" && e.probe === ":parse",
		);
		expect(ev?.outcome).toBe("skipped");
		expect(ev?.reason).toContain("budget");
	});

	test("a rejected batch abstains with the device's reason", async () => {
		const input = ":local x 2.2";
		const { backend } = device({
			parse: (script) =>
				script.includes(":local v0 ")
					? "syntax error (line 1 column 12)"
					: "(evl /localname=$x;value=2.0.0.2)",
		});
		const data = explainCommand(input);
		await collectExplainEvidence(data, input, backend);
		const ev = data.evidence.find(
			(e) => e.facet === "types" && e.probe === ":parse",
		);
		expect(ev?.outcome).toBe("invalid-response");
		expect(ev?.reason).toContain("syntax error");
		expect(data.values.occurrences[0]?.facts.observedType).toBeUndefined();
	});

	test("an empty type answer is a result, not a warning", async () => {
		const input = ":local x 2.2";
		const { backend } = device({
			parse: (script) =>
				script.includes(":local v0 ")
					? ""
					: "(evl /localname=$x;value=2.0.0.2)",
		});
		const data = explainCommand(input);
		await collectExplainEvidence(data, input, backend);
		const ev = data.evidence.find(
			(e) => e.facet === "types" && e.probe === ":parse",
		);
		expect(ev?.outcome).toBe("empty");
		expect(data.diagnostics.map((d) => d.ev)).not.toContain(ev?.id);
	});
});

describe("schemaType reaches only discovered argument paths", () => {
	const children = { "ip,route,add": ["distance", "dst-address", "gateway"] };
	const distance = [
		{
			"symbol-type": "definition",
			nested: "0",
			symbol: "Distance",
			text: "Num",
		},
		{
			"symbol-type": "definition",
			nested: "1",
			symbol: "Num",
			text: "1..255    (integer number)",
		},
	];

	test("a unique prefix resolves; the syntax path is the argument's", async () => {
		const input = "/ip/route/add dist=2";
		const { backend, calls } = device({
			children,
			syntax: { "ip,route,add,distance": distance },
		});
		const data = explainCommand(input);
		await collectExplainEvidence(data, input, backend);
		expect(
			calls.filter((c) => c.method === "inspect" && c.args[0] === "syntax"),
		).toEqual([
			{ method: "inspect", args: ["syntax", "ip,route,add,distance"] },
		]);
		expect(data.values.occurrences[0]?.facts.schemaType).toMatchObject({
			values: ["num"],
			declared: "Num",
		});
	});

	test("an ambiguous or unknown name sends no probe", async () => {
		const input = "/ip/route/add d=2 zz=1";
		const { backend, calls } = device({ children });
		const data = explainCommand(input);
		await collectExplainEvidence(data, input, backend);
		expect(
			calls.filter((c) => c.method === "inspect" && c.args[0] === "syntax"),
		).toEqual([]);
	});

	test("probes past the budget are skipped with a reason", async () => {
		const names = Array.from(
			{ length: EXPLAIN_TYPE_LIMITS.syntaxProbes + 2 },
			(_, i) => `a${i}`,
		);
		const input = `/ip/route/add ${names.map((n) => `${n}=x`).join(" ")}`;
		const { backend, calls } = device({
			children: { "ip,route,add": names },
		});
		const data = explainCommand(input);
		await collectExplainEvidence(data, input, backend);
		expect(
			calls.filter((c) => c.method === "inspect" && c.args[0] === "syntax"),
		).toHaveLength(EXPLAIN_TYPE_LIMITS.syntaxProbes);
		const skipped = data.evidence.filter(
			(e) => e.facet === "types" && e.outcome === "skipped",
		);
		expect(skipped).toHaveLength(2);
		expect(skipped[0]?.reason).toContain("budget");
	});
});

describe("resolveArgumentName", () => {
	const names = ["comment", "copy-from", "distance", "dst-address"];
	test("exact, unique prefix, ambiguous, unknown", () => {
		expect(resolveArgumentName("comment", names)).toBe("comment");
		expect(resolveArgumentName("dist", names)).toBe("distance");
		expect(resolveArgumentName("co", names)).toBeUndefined();
		expect(resolveArgumentName("zz", names)).toBeUndefined();
		expect(resolveArgumentName("", names)).toBeUndefined();
	});
});

const row = (
	depth: number,
	symbol: string,
	text: string,
	kind = "definition",
) => ({
	kind,
	depth,
	symbol,
	text,
});

describe("schemaTypeOf", () => {
	test("a blank declaration (a flag, a boolean) abstains", () => {
		expect(schemaTypeOf([row(0, "", "")], "ev")).toBeUndefined();
		expect(schemaTypeOf([], "ev")).toBeUndefined();
	});

	test("an undocumented leaf abstains the whole fact", () => {
		expect(
			schemaTypeOf(
				[
					row(0, "Address", "Ip | Ipv6"),
					row(1, "Ip", "A.B.C.D    (IP address)"),
					row(1, "Ipv6", "see documentation"),
				],
				"ev",
			),
		).toBeUndefined();
	});

	test("a blank placeholder leaf is skipped", () => {
		expect(
			schemaTypeOf(
				[
					row(0, "FromPool", ""),
					row(1, "", ""),
					row(1, "", "string value", "explanation"),
				],
				"ev",
			),
		).toEqual({ values: ["str"], declared: "FromPool", ev: "ev" });
	});

	test("keyword help is not a leaf, and repetition marks a list", () => {
		expect(
			schemaTypeOf(
				[
					row(0, "DstAddressType", "[!]Type"),
					row(1, "Type", "unicast|local|broadcast[,Type*]"),
					row(2, "unicast", "unicast address", "explanation"),
				],
				"ev",
			),
		).toEqual({ values: ["enum"], list: true, declared: "[!]Type", ev: "ev" });
	});

	test("listed configuration names are enum, cut short or not", () => {
		for (const text of ["ether1 | lo", "lo | ether1 | dv-port | ...", " | ..."])
			expect(schemaTypeOf([row(0, "Interface", text)], "ev")?.values).toEqual([
				"enum",
			]);
	});

	test("annotations map to the shared lexicon", () => {
		const one = (text: string) =>
			schemaTypeOf([row(0, "X", text)], "ev")?.values;
		expect(one("1..255    (integer number)")).toEqual(["num"]);
		expect(one("00:00:00.200..    (time interval)")).toEqual(["time"]);
		expect(one("A.B.C.D/M    (IP prefix)")).toEqual(["ip-prefix"]);
		expect(one("IPv6/0..128    (IPv6 prefix)")).toEqual(["ip6-prefix"]);
		expect(
			one("A.B.C.D[-A.B.C.D |0..32 |/A.B.C.D ]    (IP address range)"),
		).toEqual(["ip-range"]);
		expect(
			one("AB[:|-|.]CD[:|-|.]EF[:|-|.]GH[:|-|.]IJ[:|-|.]KL    (MAC address)"),
		).toEqual(["mac"]);
		expect(one("string value, max length 255")).toEqual(["str"]);
		expect(one("0..65535")).toEqual(["num"]);
	});
});
