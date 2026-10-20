import { describe, expect, test } from "bun:test";
import { resolveApiRequest } from "../../src/api.ts";
import { CentrsError } from "../../src/errors.ts";
import { type ExplainData, explainCommand } from "../../src/explain.ts";
import {
	collectExplainEvidence,
	explainLiveEnvelope,
} from "../../src/explain-live.ts";
import type { ExplainLiveFacets } from "../../src/explain-live-facets.ts";
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

/** Each case is an example of `commands/explain/examples.md` (#492). */
const cases: {
	example: string;
	input: string;
	facets: ExplainLiveFacets;
	check(data: ExplainData): void;
}[] = [
	{
		example: "7",
		input: "/ip/address",
		facets: { schema: true },
		check(data) {
			const schema = data.schema;
			expect(schema?.node).toBe("menu");
			expect(schema?.truncated).toBe(false);
			const verbs = new Map(schema?.verbs?.map((v) => [v.name, v]));
			for (const verb of ["add", "set", "remove", "print"])
				expect(verbs.get(verb)?.arguments).toBeGreaterThan(0);
		},
	},
	{
		example: "8",
		input: "/ip/address/set",
		facets: { schema: true },
		check(data) {
			const args = new Map(data.schema?.arguments?.map((a) => [a.name, a]));
			expect(data.schema?.node).toBe("command");
			for (const name of ["address", "interface", "disabled"])
				expect(args.has(name)).toBe(true);
			expect(args.get("address")?.syntax?.[0]?.text).toContain("IP address");
		},
	},
	{
		example: "9",
		input: "/ip/address/print",
		facets: { schema: true },
		check(data) {
			expect(data.schema?.proplist?.source).toBe("print-proplist");
			for (const name of ["address", "interface", "comment", "dynamic"])
				expect(data.schema?.proplist?.names).toContain(name);
		},
	},
	{
		example: "9 (singleton)",
		input: "/ip/dns/print",
		facets: { schema: true },
		check(data) {
			expect(data.schema?.proplist?.source).toBe("get-value-name");
			expect(data.schema?.proplist?.names).toContain("servers");
		},
	},
	{
		example: "10",
		input: "/ip",
		facets: { schema: true },
		check(data) {
			const schema = data.schema;
			expect(schema?.truncated).toBe(true);
			expect(schema?.counts.menus).toBeGreaterThan(16);
			expect(schema?.menus?.every((m) => m.verbs === undefined)).toBe(true);
			expect(schema?.next.length).toBeGreaterThan(0);
		},
	},
	{
		example: "10 (--full)",
		input: "/ip",
		facets: { schema: true, full: true },
		check(data) {
			expect(data.schema?.truncated).toBe(false);
			const address = data.schema?.menus?.find((m) => m.name === "address");
			expect(address?.verbs).toBeGreaterThan(0);
		},
	},
	{
		example: "13",
		input: "/ip/address add comm",
		facets: { complete: true },
		check(data) {
			const completion = data.completion;
			expect(completion?.context).toBe("argument-name");
			expect(completion?.replace).toEqual({ start: 16, end: 20 });
			expect(completion?.candidates).toContainEqual(
				expect.objectContaining({
					text: "comment",
					match: "partial",
				}),
			);
			expect(
				data.diagnostics.some((d) =>
					d.code.startsWith("explain/canonicalizer"),
				),
			).toBe(false);
			// The device rejects the partial word as written, and both probes agree on the byte.
			for (const code of [
				"explain/live-inspect/parse-rejected",
				"explain/live-inspect/highlight-error",
			])
				expect(data.diagnostics.find((d) => d.code === code)?.span.start).toBe(
					16,
				);
		},
	},
	{
		example: "14",
		input: "/ip/address add comment",
		facets: { complete: true },
		check(data) {
			expect(data.completion?.candidates).toContainEqual(
				expect.objectContaining({ text: "comment", match: "exact" }),
			);
			expect(data.completion?.takesValue).toBe(true);
		},
	},
	{
		example: "14 (flag)",
		input: "/interface print detail",
		facets: { complete: true },
		check(data) {
			expect(data.completion?.candidates[0]?.match).toBe("exact");
			expect(data.completion?.takesValue).toBe(false);
		},
	},
	{
		example: "15",
		input: "/ip/firewall/filter add chain=",
		facets: { complete: true },
		check(data) {
			const completion = data.completion;
			expect(completion?.context).toBe("value");
			expect(completion?.argument).toBe("chain");
			const values = completion?.candidates.map((c) => c.text);
			for (const chain of ["forward", "input", "output"])
				expect(values).toContain(chain);
			expect(
				data.evidence.find((e) => e.id === completion?.candidates[0]?.ev)
					?.probe,
			).toBe("completion");
		},
	},
	{
		example: "15 (free-form)",
		input: "/ip/address add comment=",
		facets: { complete: true },
		check(data) {
			expect(data.completion?.context).toBe("value");
			expect(data.completion?.candidates).toEqual([]);
			expect(data.completion?.syntax?.map((row) => row.text)).toContain(
				"string value",
			);
		},
	},
	{
		example: "15 (incomplete substitution)",
		input: ':put "é"; :local x [/ip/address add interface=',
		facets: { complete: true },
		check(data) {
			expect(data.completion?.path).toBe("/ip/address/add");
			expect(data.completion?.cursor).toBe(47);
			expect(data.completion?.at).toEqual({ line: 0, character: 46 });
			expect(data.completion?.candidates.map((c) => c.text)).toContain(
				"ether1",
			);
		},
	},
	{
		example: "13 (path)",
		input: "/ip/address re",
		facets: { complete: true },
		check(data) {
			expect(data.completion?.context).toBe("path");
			expect(data.completion?.candidates.map((c) => c.text)).toEqual([
				"remove",
				"reset",
			]);
		},
	},
	{
		example: "13 (cursor)",
		input: "/ip/address add comm address=192.0.2.1/24",
		facets: { complete: true, cursor: 20 },
		check(data) {
			expect(data.completion?.prefix).toBe("comm");
			expect(data.completion?.candidates.map((c) => c.text)).toEqual([
				"comment",
			]);
			expect(
				data.evidence.find(
					(e) => e.facet === "complete" && e.probe === "highlight",
				)?.coverage,
			).toEqual({ start: 0, end: 20 });
		},
	},
	{
		example: "13 (relative after ;)",
		input: "/ip { :put 1; address add comm",
		facets: { complete: true },
		check(data) {
			expect(data.completion?.replace).toEqual({ start: 26, end: 30 });
			expect(data.completion?.candidates.map((c) => c.text)).toEqual([
				"comment",
			]);
		},
	},
	{
		example: "13 (after navigation)",
		input: "/ip address\n",
		facets: { complete: true },
		check(data) {
			expect(data.completion?.context).toBe("path");
			const verbs = data.completion?.candidates.map((c) => c.text);
			for (const verb of ["add", "print", "set"]) expect(verbs).toContain(verb);
		},
	},
	{
		example: "13 (where)",
		input: "/ip/address/print where comm",
		facets: { complete: true },
		check(data) {
			expect(data.completion?.context).toBe("variable");
			expect(data.completion?.candidates.map((c) => c.text)).toEqual([
				"comment",
			]);
		},
	},
	{
		example: "15 (where value)",
		input: "/ip/address/print where disabled=",
		facets: { complete: true },
		check(data) {
			expect(data.completion?.context).toBe("value");
			expect(data.completion?.argument).toBe("disabled");
			expect(data.completion?.candidates.map((c) => c.text)).toEqual([
				"no",
				"yes",
			]);
			expect(data.completion?.syntax).toBeUndefined();
		},
	},
	{
		example: "19",
		input: "/ip/route",
		facets: { schema: true },
		check(data) {
			expect(new Set(data.live?.highlight?.classes)).toEqual(new Set(["dir"]));
			expect(data.structure.statements[0]).toMatchObject({
				resolution: "resolved",
				kind: "menu",
			});
			expect(data.schema?.node).toBe("menu");
		},
	},
];

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;
describeFast("explain live describe and completion (#492)", () => {
	test("examples 7–10, 13–15 and 19 on REST/native", async () => {
		const started = await startIntegrationChr();
		const captures: unknown[] = [];
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
							undefined,
							testCase.facets,
						);
						const live = data.evidence.filter(
							(e) => e.source === "live-inspect",
						);
						expect(
							live.every((e) =>
								e.version?.startsWith(started.chr.state.version),
							),
						).toBe(true);
						expect(
							live.some((e) =>
								["timeout", "transport-error", "invalid-response"].includes(
									e.outcome,
								),
							),
						).toBe(false);
						expect(data.runtimeAcceptance).toBe("not-proven");
						testCase.check(data);
						if (via === "rest-api")
							captures.push({
								example: testCase.example,
								input: testCase.input,
								facets: testCase.facets,
								calls: structuredClone(recorder.calls),
								schema: data.schema,
								completion: data.completion,
							});
					}
				} finally {
					await recorder.close();
				}

				// The public envelope: the truncation tip, and the cursor refused before connecting.
				const truncated = await explainLiveEnvelope(
					{ ...connection, input: "/ip", schema: true },
					{},
					{},
				);
				expect(truncated.ok).toBe(true);
				expect(truncated.tips.map((tip) => tip.code)).toContain(
					"tip/explain-schema-truncated",
				);
				const badCursor = await explainLiveEnvelope(
					{ ...connection, input: "/ip", complete: true, cursor: 4 },
					{},
					{},
				);
				expect(badCursor.ok).toBe(false);
				if (!badCursor.ok)
					expect(badCursor.error.code).toBe("usage/invalid-cursor");

				const cli = await runCliProcess({
					args: [
						"explain",
						"--quickchr",
						started.chr.name,
						"--via",
						via,
						"/ip/address add comment",
						"--complete",
						"--fail-on",
						"never",
						"--json",
					],
				});
				expect(cli.exitCode).toBe(0);
				const envelope = JSON.parse(cli.stdoutText);
				expect(envelope.data.completion.takesValue).toBe(true);
				expect(envelope.data.runtimeAcceptance).toBe("not-proven");

				await recordIntegrationEvidence({
					suite: "explain-live-facets",
					command: "explain",
					protocol: via,
					routerosVersion: started.chr.state.version,
					quickChrName: started.chr.name,
					exampleIds: [7, 8, 9, 10, 13, 14, 15, 19],
				});
			}
			const capturePath = Bun.env["CENTRS_EXPLAIN_FACETS_CAPTURE"];
			if (capturePath)
				await Bun.write(
					capturePath,
					`${JSON.stringify(
						{
							generator: "test/integration/explain-live-facets.test.ts",
							version: started.chr.state.version,
							captures,
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
