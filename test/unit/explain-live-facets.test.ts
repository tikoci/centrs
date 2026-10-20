import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import { explainCommand } from "../../src/explain.ts";
import { collectExplainEvidence } from "../../src/explain-live.ts";
import {
	cursorRole,
	type ExplainLiveFacets,
	resolveExplainCursor,
} from "../../src/explain-live-facets.ts";
import longTerm from "../fixtures/explain/live-facets.long-term.json";
import stable from "../fixtures/explain/live-facets.stable.json";

// cspell:ignore forw
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

describe("committed CHR describe/completion evidence (#492)", () => {
	for (const fixture of [stable, longTerm])
		for (const capture of fixture.captures)
			test(`${fixture.version} example ${capture.example}: ${capture.input}`, async () => {
				const data = explainCommand(capture.input);
				await collectExplainEvidence(
					data,
					capture.input,
					replay(capture.calls as Call[]),
					undefined,
					capture.facets as ExplainLiveFacets,
				);
				expect(data.schema).toEqual(capture.schema as never);
				expect(data.completion).toEqual(capture.completion as never);
				expect(data.runtimeAcceptance).toBe("not-proven");
			});
});

/** Run-length device classes, as recorded from CHR 7.24.5 highlight. */
function classes(spec: string): string[] {
	return spec.split(" ").flatMap((run) => {
		const [cls, count] = run.split(":");
		return Array(Number(count)).fill(cls);
	});
}

describe("cursor role from device classes", () => {
	const cases: [string, string, ReturnType<typeof cursorRole>][] = [
		[
			"/ip/address add comm",
			"dir:11 none:1 cmd:3 none:1 error:1 arg:3",
			{ context: "argument-name", start: 16 },
		],
		[
			"/ip/firewall/filter add chain=forw",
			"dir:19 none:1 cmd:3 none:1 arg:5 syntax-meta:1 none:4",
			{ context: "value", start: 30, argument: "chain", query: false },
		],
		[
			"/ip/address/print where comm",
			"dir:12 cmd:5 none:1 arg:5 syntax-meta:1 variable-undefined:4",
			{ context: "variable", start: 24 },
		],
		[
			"/ip/address/print where ",
			"dir:12 cmd:5 none:1 arg:5 syntax-meta:1",
			{ context: "variable", start: 24 },
		],
		[
			"/ip/address/print where disabled=",
			"dir:12 cmd:5 none:1 arg:5 syntax-meta:1 variable-local:8 syntax-meta:1",
			{ context: "value", start: 33, argument: "disabled", query: true },
		],
		[
			"/ip address\n",
			"dir:3 none:1 dir:7 none:1",
			{ context: "path", start: 12 },
		],
		["/ip/addr", "dir:8", { context: "path", start: 4 }],
		["/ip/address ad", "dir:11 none:1 cmd:2", { context: "path", start: 12 }],
		[
			"/ip/address re",
			"dir:11 none:1 obj-inactive:2",
			{ context: "path", start: 12 },
		],
		[":lo", "dir:1 obj-inactive:2", { context: "path", start: 1 }],
		[
			"/ip/address add zz",
			"dir:11 none:1 cmd:3 none:1 obj-inactive:2",
			{ context: "argument-name", start: 16 },
		],
		[
			"/ip/address add ",
			"dir:11 none:1 cmd:3 none:1",
			{ context: "argument-name", start: 16 },
		],
		[
			"/ip/address add comment=x ",
			"dir:11 none:1 cmd:3 none:1 arg:7 syntax-meta:1 none:2",
			{ context: "argument-name", start: 26 },
		],
	];
	for (const [text, spec, role] of cases)
		test(text, () => {
			expect(cursorRole(text, classes(spec), text.length)).toEqual(role);
		});

	test("the obsolete spaced value is refused", () => {
		const spaced = "/ip/address add comment ";
		expect(
			cursorRole(
				spaced,
				classes("dir:11 none:1 cmd:3 none:1 arg:7 syntax-obsolete:1"),
				spaced.length,
			).context,
		).toBe("unsupported");
	});
});

describe("cursor validation", () => {
	test("defaults to the end and snaps inside a multi-byte character", () => {
		expect(resolveExplainCursor(':put "é"', undefined)).toBe(9);
		expect(resolveExplainCursor(':put "é"', 7)).toBe(6);
		expect(resolveExplainCursor('a\n:put "é"', { line: 1, character: 7 })).toBe(
			10,
		);
	});
	test("an offset past the input is a usage error", () => {
		for (const cursor of [10, -1, 1.5, { line: 3, character: 0 }])
			expect(() => resolveExplainCursor(':put "é"', cursor)).toThrow(
				expect.objectContaining({ code: "usage/invalid-cursor" }),
			);
	});
});

describe("probe shape safety", () => {
	async function collect(
		input: string,
		facets: ExplainLiveFacets,
		version = "7.24.5",
		inspect: Backend["inspect"] = async () => [],
	) {
		const sent: unknown[][] = [];
		const data = explainCommand(input);
		await collectExplainEvidence(
			data,
			input,
			{
				protocol: "rest-api",
				getSingleton: async () => ({ version }),
				execute: async () => ({ ret: "(evl /put)" }) as never,
				inspect: async (...args) => {
					sent.push(args);
					return inspect(...args);
				},
			} as Backend,
			undefined,
			facets,
		);
		return { data, sent };
	}

	test("syntax is only ever sent for an argument path (7.12.2 hangs on a command path)", async () => {
		const { sent } = await collect(
			"/ip/address/set",
			{ schema: true },
			"7.24.5",
			async (request, path) =>
				request === "child" && path === "ip,address,set"
					? [
							{ type: "self", "node-type": "cmd", name: "set" },
							{ type: "child", "node-type": "arg", name: "address" },
							{ type: "child", "node-type": "arg", name: "comment" },
						]
					: [],
		);
		const syntax = sent.filter(([request]) => request === "syntax");
		expect(syntax.map(([, path]) => path)).toEqual([
			"ip,address,set,address",
			"ip,address,set,comment",
		]);
		expect(
			sent.some(([request, path]) => request === "completion" && path !== ""),
		).toBe(false);
	});

	test("completion is input-based, scripting keywords included (safe on 7.12.2 and 7.20.8)", async () => {
		const { sent } = await collect(
			":put message=",
			{ complete: true },
			"7.12.2",
			async (request) =>
				request === "highlight"
					? [
							{
								highlight:
									"dir,cmd,cmd,cmd,none,arg,arg,arg,arg,arg,arg,arg,syntax-meta",
							},
						]
					: [],
		);
		const facet = sent.filter(
			([request]) => request === "syntax" || request === "completion",
		);
		expect(facet).toEqual([
			["completion", "", ":put message="],
			["syntax", "put,message"],
		]);
	});

	test("an empty facet answer is a fact, not a warning", async () => {
		const { data } = await collect("/zz/qq", { schema: true });
		expect(data.schema).toMatchObject({ node: "unknown", path: "/zz/qq" });
		expect(data.evidence.find((e) => e.facet === "schema")?.outcome).toBe(
			"empty",
		);
		expect(
			data.diagnostics.some(
				(d) =>
					d.code === "explain/live-inspect/empty" && d.ev === data.schema?.ev,
			),
		).toBe(false);
	});

	test("more children than the probe budget lists names, counts all and expands none", async () => {
		const children = Array.from({ length: 17 }, (_, i) => ({
			type: "child",
			"node-type": "dir",
			name: `m${i}`,
		}));
		const inspect: Backend["inspect"] = async (request, path) =>
			request === "child" && path === "ip"
				? [{ type: "self", "node-type": "path", name: "ip" }, ...children]
				: [];
		const { data, sent } = await collect(
			"/ip",
			{ schema: true },
			"7.24.5",
			inspect,
		);
		expect(data.schema?.truncated).toBe(true);
		expect(data.schema?.counts.menus).toBe(17);
		expect(sent.filter(([request]) => request === "child")).toHaveLength(1);
		const full = await collect(
			"/ip",
			{ schema: true, full: true },
			"7.24.5",
			inspect,
		);
		expect(full.data.schema?.truncated).toBe(false);
		expect(full.sent.filter(([request]) => request === "child")).toHaveLength(
			18,
		);
	});

	test("a transport failure stops the facet probes", async () => {
		const { data } = await collect(
			"/ip/address",
			{ schema: true },
			"7.24.5",
			async () => {
				throw new CentrsError({
					code: "transport/connection-closed",
					summary: "closed",
					remediation: "retry",
				});
			},
		);
		expect(data.schema?.reason).toBe(
			"a prior transport or authentication probe failed",
		);
	});
});
