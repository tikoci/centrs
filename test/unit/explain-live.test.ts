import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CentrsError } from "../../src/errors.ts";
import { explainCommand } from "../../src/explain.ts";
import {
	collectExplainEvidence,
	EXPLAIN_LIVE_LIMITS,
	explainLiveEnvelope,
} from "../../src/explain-live.ts";
import type { ProtocolAdapter } from "../../src/protocols/index.ts";
import { classifyParseResult } from "../../src/protocols/mac-telnet-console.ts";
import longTerm from "../fixtures/explain/live-probes.long-term.json";
import stable from "../fixtures/explain/live-probes.stable.json";

type Backend = Parameters<typeof collectExplainEvidence>[2];

describe("committed CHR parse/highlight evidence (#491)", () => {
	for (const fixture of [stable, longTerm]) {
		for (const capture of fixture.captures) {
			test(`${capture.environment.version} ${capture.via}: ${capture.input}`, async () => {
				const parse = capture.live.parse;
				const classify = () =>
					classifyParseResult(parse.output, capture.input, capture.via);
				if (parse.rejected) expect(classify).toThrow(CentrsError);
				else expect(classify).not.toThrow();
				const data = await collect(capture.input, {
					getSingleton: async () => ({ version: capture.environment.version }),
					execute: async () => ({ ret: parse.output }) as never,
					inspect: async (request) =>
						request === "highlight"
							? [{ highlight: capture.live.highlight.classes.join(",") }]
							: [],
				});
				expect(data.live?.parse).toEqual(parse);
				expect(data.live?.highlight).toEqual(capture.live.highlight);
				expect(data.runtimeAcceptance).toBe("not-proven");
				expect(
					capture.evidence.find((e) => e.probe === ":parse")?.inputSha256,
				).toBe(createHash("sha256").update(capture.input).digest("hex"));
				if (capture.input === "/interface set ether1 name x") {
					expect(
						data.diagnostics.some(
							(d) => d.code === "explain/live-inspect/obsolete-syntax",
						),
					).toBe(true);
					expect(capture.live.arguments[0]?.names).toContain("name");
				}
				if (capture.input === "/interface print detail without-paging") {
					expect(
						data.diagnostics.some(
							(d) => d.code === "explain/live-inspect/obsolete-syntax",
						),
					).toBe(false);
					expect(capture.live.arguments[0]?.names).toContain("detail");
				}
			});
		}
	}
});

function backend(overrides: Partial<Backend> = {}): Backend {
	return {
		protocol: "rest-api",
		getSingleton: async () => ({ version: "7.24.5" }),
		execute: async () => ({ ret: "(evl /ip/address/print)" }),
		inspect: async (request, _path, input) =>
			request === "highlight"
				? [
						{
							highlight: Array(input?.length ?? 0)
								.fill("none")
								.join(","),
						},
					]
				: [{ type: "child", "node-type": "arg", name: "detail" }],
		...overrides,
	} as Backend;
}
async function collect(
	input: string,
	overrides: Partial<Backend> = {},
	signal?: AbortSignal,
) {
	const data = explainCommand(input);
	await collectExplainEvidence(data, input, backend(overrides), signal);
	return data;
}
describe("live evidence controls", () => {
	test("escaped parse wrapper and child-only discovery never execute input", async () => {
		const input =
			'/system/identity/set name="x$y"; :put [/system/identity/get name]';
		const calls: unknown[] = [];
		const data = await collect(input, {
			execute: async (request) => {
				calls.push(request);
				return { ret: "(evl /system/identity/set)" } as Awaited<
					ReturnType<ProtocolAdapter["execute"]>
				>;
			},
			inspect: async (kind, path) => {
				calls.push([kind, path]);
				return [];
			},
		});
		expect(calls[0]).toEqual({
			path: "",
			command: "",
			script:
				':put [:parse "/system/identity/set name=\\"x\\$y\\"; :put [/system/identity/get name]"]',
		});
		expect(calls).not.toContainEqual(["completion", "system,identity,set"]);
		expect(calls).toContainEqual(["child", "system,identity,set"]);
		expect(data.structure).toEqual(explainCommand(input).structure);
		expect(data.runtimeAcceptance).toBe("not-proven");
	});
	test.each([
		"transport/timeout",
		"transport/connection-closed",
		"transport/auth-failed",
	])("%s keeps offline facts and stops subsequent requests", async (code) => {
		let calls = 0;
		const data = await collect("/ip/address print", {
			getSingleton: async () => {
				throw new CentrsError({
					code,
					summary: "probe failed",
					remediation: "Retry.",
				});
			},
			execute: async () => {
				calls++;
				return {} as never;
			},
		});
		expect(calls).toBe(0);
		const evidence = data.evidence.filter((e) => e.source === "live-inspect");
		expect(evidence[0]?.errorCode).toBe(code);
		expect(evidence.slice(1).every((e) => e.outcome === "skipped")).toBe(true);
		expect(data.verdict).toBe("warn");
		expect(data.structure.statements[0]?.id).toBe("s0");
	});
	test("empty, unsupported, malformed and rejected are distinct", async () => {
		const empty = await collect("/ip/address print", {
			execute: async () => ({ ret: "" }) as never,
			inspect: async () => [],
		});
		expect(empty.live?.parse).toBeUndefined();
		expect(
			empty.evidence
				.filter((e) => e.source === "live-inspect")
				.map((e) => e.outcome),
		).toEqual(["ok", "empty", "empty", "empty"]);
		const unsupported = await collect("/ip/address print", {
			inspect: async () => {
				throw new CentrsError({
					code: "routeros/unknown-path",
					summary: "unknown",
					remediation: "Use a supported path.",
				});
			},
		});
		expect(unsupported.evidence.some((e) => e.outcome === "unsupported")).toBe(
			true,
		);
		const malformed = await collect("/ip/address print", {
			inspect: async () => [{ highlight: "error" }],
		});
		expect(malformed.live?.highlight).toBeUndefined();
		expect(
			malformed.evidence.some((e) => e.outcome === "invalid-response"),
		).toBe(true);
		const rejected = await collect(':put "🛰"\n:put (1 +)', {
			execute: async () =>
				({ ret: "syntax error (line 2 column 10)" }) as never,
		});
		expect(rejected.live?.parse?.rejected).toBe(true);
		expect(
			rejected.diagnostics.find(
				(d) => d.code === "explain/live-inspect/parse-rejected",
			)?.span,
		).toEqual({ start: 21, end: 22 });
	});
	test("highlight normalization preserves UTF-8 byte length and original map", async () => {
		const input = ':put "🛰é"';
		let submitted = "";
		const data = await collect(input, {
			inspect: async (kind, _path, value) => {
				if (kind === "highlight") {
					submitted = value ?? "";
					return [
						{ highlight: Array(submitted.length).fill("none").join(",") },
					];
				}
				return [];
			},
		});
		expect(submitted).toBe(`:put "${"\x1a".repeat(6)}"`);
		expect(data.input.positionMap).toEqual(
			explainCommand(input).input.positionMap,
		);
		expect(data.live?.highlight?.classes).toHaveLength(
			new TextEncoder().encode(input).length,
		);
	});
	test("oversize highlight sends no prefix, oversized parse also skips", async () => {
		let parses = 0;
		let highlights = 0;
		const overrides: Partial<Backend> = {
			execute: async () => {
				parses++;
				return { ret: "{}" } as never;
			},
			inspect: async (kind) => {
				if (kind === "highlight") highlights++;
				return [];
			},
		};
		await collect(
			`#${"x".repeat(EXPLAIN_LIVE_LIMITS.highlightBytes)}`,
			overrides,
		);
		expect(parses).toBe(1);
		expect(highlights).toBe(0);
		const data = await collect(
			`#${"x".repeat(EXPLAIN_LIVE_LIMITS.parseBytes)}`,
			overrides,
		);
		expect(parses).toBe(1);
		expect(highlights).toBe(0);
		expect(data.input.truncated).toBe(false);
		expect(data.evidence.find((e) => e.probe === ":parse")?.outcome).toBe(
			"skipped",
		);
	});
	test("old/unknown versions skip scripting-path discovery and never use completion", async () => {
		for (const version of ["7.20.8", "unknown"]) {
			const calls: string[] = [];
			const data = await collect(":put 1", {
				getSingleton: async () => ({ version }),
				inspect: async (kind) => {
					calls.push(kind);
					return [];
				},
			});
			expect(calls).toEqual(["highlight"]);
			expect(data.evidence.find((e) => e.probe === "child")?.outcome).toBe(
				"skipped",
			);
		}
	});
	test("interruption retains completed parse and marks remaining probes", async () => {
		const controller = new AbortController();
		const data = await collect(
			"/ip/address print",
			{
				execute: async () => {
					controller.abort();
					return { ret: "(evl /ip/address/print)" } as never;
				},
			},
			controller.signal,
		);
		expect(data.live?.parse?.rejected).toBe(false);
		expect(data.evidence.find((e) => e.probe === "highlight")?.outcome).toBe(
			"interrupted",
		);
	});
	test("discovery deduplicates paths and keeps owning statement ids", async () => {
		const data = await collect("/interface print; /interface print");
		expect(data.live?.arguments[0]?.statementIds).toEqual(["s0", "s1"]);
		expect(data.live?.arguments).toHaveLength(1);
	});
	test("pinned unsupported transport is refused without fallback or credential disclosure", async () => {
		const result = await explainLiveEnvelope(
			{
				input: ":put 1",
				targetInput: new URL(`http://${"user"}:${"private-token"}@127.0.0.1`)
					.href,
				via: "ssh",
			},
			{},
			{},
		);
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain("private-token");
	});
});

test("actual REST authentication failure keeps resolved target and produces a command failure", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("unauthorized", { status: 401 }),
	});
	try {
		const result = await explainLiveEnvelope(
			{
				input: ":put 1",
				targetInput: server.url.href,
				username: "admin",
				password: "test-only",
				timeout: "1s",
			},
			{},
			{},
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("transport/auth-failed");
		expect(result.meta.target.port).toBe(server.port);
		expect(result.meta.validation).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain("test-only");
	} finally {
		await server.stop(true);
	}
});

test("actual REST timeout is bounded and does not dispatch later probes", async () => {
	let calls = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async () => {
			calls++;
			await Bun.sleep(100);
			return Response.json({ version: "7.24.5" });
		},
	});
	try {
		const result = await explainLiveEnvelope(
			{ input: ":put 1", targetInput: server.url.href, timeout: "20ms" },
			{},
			{},
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("transport/timeout");
		// Under load the timeout can expire before the local server accepts the first request.
		expect(calls).toBeLessThanOrEqual(1);
	} finally {
		await server.stop(true);
	}
});

test("child discovery is bounded and overflow remains explicit", async () => {
	const input = Array.from({ length: 40 }, (_, i) => `/menu${i}/print`).join(
		";",
	);
	let calls = 0;
	const data = await collect(input, {
		inspect: async (kind) => {
			if (kind === "child") calls++;
			return [];
		},
	});
	expect(calls).toBe(EXPLAIN_LIVE_LIMITS.commandPaths);
	expect(
		data.evidence.filter((e) => e.probe === "child" && e.outcome === "skipped"),
	).toHaveLength(8);
});
