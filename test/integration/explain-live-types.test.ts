import { describe, expect, test } from "bun:test";
import { resolveApiRequest } from "../../src/api.ts";
import { routerOsStringLiteral } from "../../src/core/routeros-string.ts";
import { CentrsError } from "../../src/errors.ts";
import { type ExplainData, explainCommand } from "../../src/explain.ts";
import { collectExplainEvidence } from "../../src/explain-live.ts";
import {
	type TypeProbeContext,
	typeProbeScript,
} from "../../src/explain-live-types.ts";
import { createProtocolAdapter } from "../../src/protocols/index.ts";
import {
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";
import { runCliProcess } from "./cli-process.ts";

type Backend = Parameters<typeof collectExplainEvidence>[2];
type Call = {
	method: "getSingleton" | "inspect" | "execute";
	args: unknown[];
	result?: unknown;
	error?: string;
};

/** The conversion matrix: bare literals the probe byte set admits. */
const TYPE_MATRIX_LITERALS = [
	"2.2",
	"1.1.1.1",
	"2.2/8",
	"1.1.1.1/24",
	"1::1",
	"1:0:0::1",
	"2008:1::2/128",
	"0123",
	"0x10",
	"-1",
	"123",
	"99999999999999999999",
	"yes",
	"no",
	"true",
	"false",
	"Yes",
	"200ms",
	"1d",
	"1w7h2s",
	"00:00:02",
	"1:2",
	"100000w",
	"10000w",
	"00:11:22:33:44:55",
	"abc",
	"a-b",
	"1e5",
	"1.1.1.1.1",
	"300.1.1.1",
	"2.2-3.3",
];

const fact = (data: ExplainData, start: number) =>
	data.values.occurrences.find((o) => o.span.start === start)?.facts;

/** Each case is an example of `commands/explain/examples.md` (#225). */
const cases: {
	example: string;
	input: string;
	check(data: ExplainData): void;
}[] = [
	{
		example: "52",
		input:
			':local x 2.2; :set x "2.2"; :local z (1,0x10,2.2); :local t 200ms; :local i *1; :local y yes',
		check(data) {
			expect(fact(data, 9)?.observedType).toMatchObject({
				value: "ip",
				rendered: "2.0.0.2",
			});
			// Quoted: no conversion is visible, so nothing is claimed.
			expect(fact(data, 21)?.observedType).toBeUndefined();
			// Members: `1` renders unchanged, `0x10` and `2.2` convert.
			expect(fact(data, 38)?.observedType).toBeUndefined();
			expect(fact(data, 40)?.observedType?.value).toBe("num");
			expect(fact(data, 45)?.observedType?.value).toBe("ip");
			expect(fact(data, 60)?.observedType?.value).toBe("time");
			expect(fact(data, 76)?.observedType).toBeUndefined();
			expect(fact(data, 89)?.observedType).toMatchObject({
				value: "bool",
				rendered: "true",
			});
			for (const o of data.values.occurrences)
				expect(o.facts.schemaType).toBeUndefined();
		},
	},
	{
		example: "53",
		input:
			"/ip/dns/set servers=1.1.1.1,8.8.8.8; /ip/route/add gateway=2.2 dist=2 comment=abc; /ip/firewall/filter/add chain=input dst-port=80,443 protocol=tcp disabled=yes",
		check(data) {
			const byName = new Map(
				data.values.occurrences.map((o) => [o.name, o.facts]),
			);
			expect(byName.get("servers")?.schemaType).toMatchObject({
				values: ["ip", "ip6", "enum"],
				declared: "Address[@VRF]",
			});
			// The interface names are listed like keywords, so they are `enum`.
			expect(byName.get("gateway")?.schemaType).toMatchObject({
				values: ["ip", "ip6", "enum"],
				declared: "Address[%Interface][@VRF]",
			});
			// A unique prefix resolves as RouterOS resolves it.
			expect(byName.get("dist")?.schemaType?.values).toEqual(["num"]);
			expect(byName.get("comment")?.schemaType?.values).toEqual(["str"]);
			expect(byName.get("chain")?.schemaType?.values).toEqual(["enum", "str"]);
			expect(byName.get("dst-port")?.schemaType).toMatchObject({
				values: ["num"],
				list: true,
			});
			// A boolean is declared with a blank row: abstain.
			expect(byName.get("disabled")?.schemaType).toBeUndefined();
			// Menu arguments are the schema's slot, never observed.
			for (const o of data.values.occurrences)
				expect(o.facts.observedType).toBeUndefined();
		},
	},
];

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;
describeFast("explain live value types (#225)", () => {
	test("examples 52–53 and the conversion matrix on REST/native", async () => {
		const started = await startIntegrationChr();
		const captures: unknown[] = [];
		const matrix: unknown[] = [];
		try {
			for (const via of ["rest-api", "native-api"]) {
				const connection = { quickchr: started.chr.name, via };
				const recorder = await recordingBackend(connection);
				try {
					for (const testCase of cases) {
						recorder.calls.length = 0;
						const data = explainCommand(testCase.input);
						await collectExplainEvidence(
							data,
							testCase.input,
							recorder.backend,
						);
						const types = data.evidence.filter((e) => e.facet === "types");
						expect(types.length).toBeGreaterThan(0);
						for (const ev of types) {
							expect(ev.outcome).toBe("ok");
							expect(ev.version?.startsWith(started.chr.state.version)).toBe(
								true,
							);
						}
						// Safety: every executed script is an escaped :parse wrapper, and
						// every syntax probe names an argument the command's child listed.
						for (const call of recorder.calls) {
							if (call.method === "execute")
								expect((call.args[0] as { script: string }).script).toStartWith(
									":put [:parse ",
								);
							if (call.method === "inspect" && call.args[0] === "syntax") {
								const tokens = String(call.args[1]).split(",");
								const command = `/${tokens.slice(0, -1).join("/")}`;
								expect(
									data.live?.arguments.find((a) => a.path === command)?.names,
								).toContain(tokens.at(-1));
							}
						}
						expect(data.runtimeAcceptance).toBe("not-proven");
						testCase.check(data);
						if (via === "rest-api")
							captures.push({
								example: testCase.example,
								input: testCase.input,
								calls: structuredClone(recorder.calls),
								values: data.values.occurrences,
							});
					}
					for (const context of ["operand", "member"] as TypeProbeContext[]) {
						const script = typeProbeScript(context, TYPE_MATRIX_LITERALS);
						const result = await recorder.backend.execute({
							path: "",
							command: "",
							script: `:put [:parse ${routerOsStringLiteral(script)}]`,
						});
						if (via === "rest-api")
							matrix.push({
								context,
								literals: TYPE_MATRIX_LITERALS,
								output: result.ret,
							});
					}
				} finally {
					await recorder.close();
				}

				const cli = await runCliProcess({
					args: [
						"explain",
						"--quickchr",
						started.chr.name,
						"--via",
						via,
						":local x 2.2; /ip/route/add gateway=1.1.1.1",
						"--fail-on",
						"never",
					],
				});
				expect(cli.exitCode).toBe(0);
				expect(cli.stdoutText).toContain("observed=ip(2.0.0.2)");
				expect(cli.stdoutText).toContain("schema=ip|ip6|enum");

				await recordIntegrationEvidence({
					suite: "explain-live-types",
					command: "explain",
					protocol: via,
					routerosVersion: started.chr.state.version,
					quickChrName: started.chr.name,
					exampleIds: [52, 53],
				});
			}
			const capturePath = Bun.env["CENTRS_EXPLAIN_TYPES_CAPTURE"];
			if (capturePath)
				await Bun.write(
					capturePath,
					`${JSON.stringify(
						{
							generator: "test/integration/explain-live-types.test.ts",
							version: started.chr.state.version,
							captures,
							matrix,
						},
						null,
						2,
					)}\n`,
				);
		} finally {
			await started.chr.destroy();
		}
	}, 240000);
});

/** The adapter explain uses, with every call and its raw answer recorded. */
async function recordingBackend(connection: { quickchr: string; via: string }) {
	const resolved = await resolveApiRequest(
		{ ...connection, endpoint: "/system/resource", validate: true },
		{},
	);
	const adapter = createProtocolAdapter({
		protocol: resolved.via.value,
		...resolved.target,
		username: resolved.auth.username,
		password: resolved.auth.password,
		timeoutMs: resolved.timeoutMs.value,
		insecure: resolved.insecure.value,
	});
	const calls: Call[] = [];
	const record =
		<A extends unknown[], R>(
			method: Call["method"],
			action: (...args: A) => Promise<R>,
			sanitize: (result: R) => unknown = (result) => result,
		) =>
		async (...args: A): Promise<R> => {
			try {
				const result = await action(...args);
				calls.push({ method, args, result: sanitize(result) });
				return result;
			} catch (error) {
				calls.push({
					method,
					args,
					error: error instanceof CentrsError ? error.code : String(error),
				});
				throw error;
			}
		};
	const backend: Backend = {
		protocol: adapter.protocol,
		getSingleton: record(
			"getSingleton",
			(path: string) => adapter.getSingleton(path),
			(result) => {
				const fields = result as Record<string, unknown>;
				return {
					version: fields["version"],
					"architecture-name": fields["architecture-name"],
					"board-name": fields["board-name"],
				};
			},
		),
		inspect: record(
			"inspect",
			(
				request: "child" | "completion" | "highlight" | "syntax",
				path: string,
				input?: string,
			) => adapter.inspect(request, path, input),
		),
		execute: record("execute", (request: Parameters<Backend["execute"]>[0]) =>
			adapter.execute(request),
		),
	};
	return { backend, calls, close: () => adapter.close() };
}
