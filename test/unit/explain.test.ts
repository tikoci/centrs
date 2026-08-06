import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.ts";
import type { ExplainData, ExplainEnvelope } from "../../src/explain.ts";

/**
 * `commands/explain/examples.md`, one assertion per example (example N ↔
 * assertion N), driven through the real CLI so the positional grammar, the
 * flags, the envelope and the exit code are all under test at once — an example
 * is a shell invocation, and asserting the library call instead would green a
 * spec the command cannot actually satisfy.
 *
 * Offline mode is transport-less, so its evidence is this file rather than CHR
 * (`commands/explain/README.md` → *Definition of done and staging*; the live
 * examples 7-16, 19 and 24 are phase 2 and land in `test/integration/`).
 *
 * Examples **1, 2, 6 and 23 are `test.todo`**: each asserts
 * `transport.classification` / `--curl`, which is #202c. They are listed rather
 * than omitted so the gap is visible in the test output.
 */

interface Captured {
	code: number;
	out: string;
	err: string;
}

const restorers: Array<() => void> = [];
afterEach(() => {
	while (restorers.length > 0) restorers.pop()?.();
});

async function run(args: readonly string[]): Promise<Captured> {
	const logs: string[] = [];
	const errs: string[] = [];
	const origLog = console.log;
	const origErr = console.error;
	console.log = (...a: unknown[]) => {
		logs.push(a.map(String).join(" "));
	};
	console.error = (...a: unknown[]) => {
		errs.push(a.map(String).join(" "));
	};
	restorers.push(() => {
		console.log = origLog;
		console.error = origErr;
	});
	const code = await runCli(args);
	return { code, out: logs.join("\n"), err: errs.join("\n") };
}

/** Run `centrs explain … --json` and return the parsed success envelope. */
async function explainJson(
	args: readonly string[],
): Promise<{ envelope: ExplainEnvelope; data: ExplainData; code: number }> {
	const { code, out } = await run(["explain", ...args, "--json"]);
	const envelope = JSON.parse(out) as ExplainEnvelope;
	if (!envelope.ok) throw new Error(`expected ok: true, got ${out}`);
	return { envelope, data: envelope.data, code };
}

describe("commands/explain/examples.md — offline", () => {
	test.todo("1. Canonical form, write shape, and transport (#202c)", () => {});

	test("1b. The CLI spelling is script to the gate and a command to the analysis", async () => {
		const { data, code } = await explainJson([
			"/ip/route add dst-address=10.9.0.0/16 gateway=192.0.2.1",
		]);
		expect(data.canonical.mode).toBe("script");
		expect(data.canonical.writeShaped).toBe(false);
		expect(data.structure.statements[0]?.command).toEqual({
			path: "/ip/route",
			verb: "add",
		});
		expect(data.structure.containsWrite).toBe(true);
		expect(code).toBe(0);
	});

	test.todo("2. Script mode routes to execute (#202c)", () => {});

	test("3. Sub-command paths are re-constituted; the gate verdict is untouched", async () => {
		const { data } = await explainJson([
			"/ip/address remove [find comment=defconf]",
		]);
		expect(data.canonical.mode).toBe("script");
		expect(data.canonical.writeShaped).toBe(false);
		const inner = data.structure.subcommands[0];
		expect(inner?.command).toEqual({ path: "/ip/address", verb: "find" });
		expect(inner?.span).toEqual({ start: 19, end: 41 });
		expect(data.structure.containsWrite).toBe(true);
		// "basis `heuristic` in the referenced evidence entry" — the write tristate
		// is a ratified offline rule a live probe could overturn, not a reading.
		const ev = data.evidence.find((e) => e.id === data.structure.ev);
		expect(ev?.basis).toBe("heuristic");
	});

	test("4. Same token, different role: `comment` as verb vs argument", async () => {
		const { data } = await explainJson([
			"/ip/address/comment numbers=0 comment=uplink",
		]);
		expect(data.canonical.verb).toBe("comment");
		expect(data.canonical.args).toEqual({
			numbers: "0",
			comment: "uplink",
		});
		// Both roles cite the canonicalizer; live completion is the authority.
		expect(data.evidence.every((e) => e.source === "canonicalizer")).toBe(true);
	});

	test("4b. The space spelling keeps the verb role and loses the argument one", async () => {
		const { data } = await explainJson([
			"/ip/address comment numbers=0 comment=uplink",
		]);
		expect(data.canonical.mode).toBe("script");
		expect(data.canonical.verb).toBe("");
		expect(data.canonical.args).toEqual({});
		expect(data.structure.statements[0]?.command).toEqual({
			path: "/ip/address",
			verb: "comment",
		});
	});

	test("5. Offline is honest about what it cannot know", async () => {
		const { envelope, data, code } = await explainJson([
			"/ip/address print",
			"--schema",
		]);
		expect(data).not.toHaveProperty("schema");
		expect(data.evidence.every((e) => e.source === "canonicalizer")).toBe(true);
		expect(envelope.tips.map((t) => t.code)).toContain(
			"tip/explain-live-facets",
		);
		expect(code).toBe(0);
	});

	test.todo("6. curl rendering with a placeholder host (#202c)", () => {});

	test("17. Fan-out is rejected", async () => {
		const { code, err } = await run([
			"explain",
			"--group",
			"lab",
			"/ip/route print",
			"--json",
		]);
		const envelope = JSON.parse(err) as {
			ok: boolean;
			error: { code: string };
		};
		expect(envelope.ok).toBe(false);
		expect(envelope.error.code).toBe("usage/fanout-not-supported");
		expect(code).toBe(1);
	});

	test("18. A bare path the menu table does not know is ambiguous offline", async () => {
		const { data } = await explainJson(["/system/reboot"]);
		const statement = data.structure.statements[0];
		expect(statement?.resolution).toBe("ambiguous");
		expect(statement?.command).toBeUndefined();
		expect(
			data.diagnostics.some(
				(d) => d.code === "explain/canonicalizer/ambiguous-statement",
			),
		).toBe(true);
		// The verdict is the diagnostic severity summary, not the resolution.
		expect(data.verdict).toBe("warn");
	});

	test("18b. A bare path the menu table DOES know resolves as a menu, offline", async () => {
		const { data } = await explainJson(["/ip/route"]);
		const statement = data.structure.statements[0];
		expect(statement?.resolution).toBe("resolved");
		expect(statement?.kind).toBe("menu");
		expect(statement?.command).toEqual({ path: "/ip/route" });
	});

	test("20. Explain-only write detection is three-valued", async () => {
		const write = await explainJson([
			"/ip/address add address=198.51.100.10/32 interface=ether1",
		]);
		const read = await explainJson(["/ip/address print"]);
		const opaque = await explainJson(["/disk format-drive disk1"]);
		expect(write.data.structure.containsWrite).toBe(true);
		expect(read.data.structure.containsWrite).toBe(false);
		expect(opaque.data.structure.containsWrite).toBe("unknown");
		// The tristate never alters the execute gate's verdict.
		expect(opaque.data.canonical.writeShaped).toBe(false);
	});

	test("21. A defect cannot fabricate a following command", async () => {
		const { envelope, data, code } = await explainJson([
			"/interface bridge add name=br;0 protocol-mode=none",
		]);
		expect(envelope.ok).toBe(true);
		expect(data.structure.statements).toHaveLength(2);
		const tail = data.structure.statements[1];
		expect(tail?.resolution).toBe("unknown");
		expect(tail?.command).toBeUndefined();
		const diagnostic = data.diagnostics.find(
			(d) => d.code === "explain/canonicalizer/unresolved-statement",
		);
		expect(diagnostic?.span).toEqual(
			tail?.span as { start: number; end: number },
		);
		// No defect region for the `;` itself — a stray mid-token delimiter is one
		// of the two deliberately undetected classes (#192).
		expect(
			data.diagnostics.some(
				(d) =>
					d.code.startsWith("explain/canonicalizer/un") &&
					d.severity === "error",
			),
		).toBe(false);
		// A warning-only document passes the default `--fail-on error`.
		expect(code).toBe(0);
		expect(data.verdict).toBe("warn");
	});

	test("21 (--fail-on). The same document fails at the warning threshold", async () => {
		const { code } = await run([
			"explain",
			"/interface bridge add name=br;0 protocol-mode=none",
			"--fail-on",
			"warning",
			"--json",
		]);
		expect(code).toBe(2);
	});

	test("22. Normalization preserves device byte offsets and LSP positions", async () => {
		const { data } = await explainJson([
			'/system identity set name="router-🚀"',
		]);
		expect(data.input.normalized).toBe(true);
		const astral = data.input.positionMap.find(
			(entry) => entry.analyzed.end - entry.analyzed.start === 4,
		);
		expect(astral?.originalUtf16.end).toBe(
			(astral?.originalUtf16.start ?? 0) + 2,
		);
		// Every span half-open and in bounds; `end === input.bytes` is legal.
		for (const s of data.spans) {
			expect(s.start).toBeGreaterThanOrEqual(0);
			expect(s.end).toBeLessThanOrEqual(data.input.bytes);
			expect(s.end).toBeGreaterThan(s.start);
		}
		for (const s of data.structure.statements) {
			expect(s.span.end).toBeLessThanOrEqual(data.input.bytes);
		}
	});

	test.todo("23. Selector-less set fails closed offline (#202c)", () => {});
});

/**
 * The surface itself, beyond the numbered examples: the conditional-arity
 * grammar and the phase boundary it guards. No other centrs command has an
 * optional target where arity changes meaning, so these are the cases a shared
 * helper would otherwise have covered.
 */
describe("centrs explain — the CLI surface", () => {
	test("the live form is refused, not silently degraded to offline", async () => {
		const { code, err } = await run([
			"explain",
			"edge1",
			"/ip/route print",
			"--json",
		]);
		const envelope = JSON.parse(err) as {
			ok: boolean;
			error: { code: string };
		};
		expect(envelope.ok).toBe(false);
		expect(envelope.error.code).toBe("usage/not-implemented");
		expect(code).toBe(1);
	});

	test("`--` ends the flags: everything after it is an operand", async () => {
		// POSIX `--`, so RouterOS input that starts with a dash is never read as a
		// centrs flag. It also means later flags are operands, which is why
		// `--json` has to precede it here.
		const { out } = await run(["explain", "--json", "--", "--not-a-flag"]);
		const envelope = JSON.parse(out) as ExplainEnvelope;
		if (!envelope.ok) throw new Error(out);
		expect(envelope.data.structure.statementCount).toBe(1);
		expect(envelope.data.structure.statements[0]?.resolution).toBe("unknown");
	});

	test("--file reads the input, and every positional is then a target", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-explain-"));
		try {
			const path = join(dir, "input.rsc");
			await Bun.write(path, "/ip/route\n");
			const { data } = await explainJson(["--file", path]);
			expect(data.structure.statements[0]?.kind).toBe("menu");

			// With `--file`, the single positional is the ROUTER, not the input.
			const live = await run(["explain", "edge1", "--file", path, "--json"]);
			expect(
				(JSON.parse(live.err) as { error: { code: string } }).error.code,
			).toBe("usage/not-implemented");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a missing --file path is a typed error, not a throw", async () => {
		const { code, err } = await run([
			"explain",
			"--file",
			`${import.meta.dir}/no-such-file.rsc`,
			"--json",
		]);
		expect((JSON.parse(err) as { error: { code: string } }).error.code).toBe(
			"input/local-file-not-found",
		);
		expect(code).toBe(1);
	});

	test("--fail-on never keeps a document with errors at exit 0", async () => {
		const failing = ["explain", ':put "unterminated'];
		const strict = await run([...failing, "--json"]);
		expect(strict.code).toBe(2);
		const lenient = await run([...failing, "--fail-on", "never", "--json"]);
		expect(lenient.code).toBe(0);
	});

	test("an unknown flag suggests the closest known one", async () => {
		const { code, err } = await run(["explain", "/ip/route", "--form"]);
		expect(err).toContain("Unknown explain flag: --form");
		expect(err).toContain("--format");
		expect(code).toBe(1);
	});

	test("the text format leads with the two verdicts and the gate", async () => {
		const { out, code } = await run([
			"explain",
			"/ip/route/add dst-address=10.9.0.0/16 gateway=192.0.2.1",
		]);
		expect(out).toContain("verdict: pass");
		expect(out).toContain("gate: structured /ip/route add");
		expect(out).toContain("write: true");
		expect(out).toContain("runtimeAcceptance: not-proven");
		expect(code).toBe(0);
	});

	test("--yaml renders the same envelope", async () => {
		const { out } = await run(["explain", "/ip/route", "--yaml"]);
		expect(out).toContain("ok: true");
		expect(out).toContain('verdict: "pass"');
	});
});
