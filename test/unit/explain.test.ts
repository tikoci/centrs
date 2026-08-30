import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExplainData, ExplainEnvelope } from "../../src/explain.ts";
import { runCliCaptured as run } from "./cli-capture.ts";

/**
 * `commands/explain/examples.md`, one assertion per example (example N ↔
 * assertion N), driven through the real CLI so the positional grammar, the
 * flags, the envelope and the exit code are all under test at once — an example
 * is a shell invocation, and asserting the library call instead would green a
 * spec the command cannot actually satisfy.
 *
 * Offline mode opens no transport, so its evidence is this file rather than CHR
 * (`commands/explain/README.md` → *Definition of done and staging*; the live
 * examples 7-16, 19 and 24 are phase 2 and land in `test/integration/`).
 *
 * Examples 1, 2, 6 and 23 are the #202c-2 transport/curl surface. The live
 * examples remain phase 2 and belong under `test/integration/`.
 */

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
	test("1. Canonical form, write shape, and transport (#202c)", async () => {
		const { data, code } = await explainJson([
			"/ip/route/add dst-address=10.9.0.0/16 gateway=192.0.2.1",
		]);
		expect(data.canonical).toMatchObject({
			path: "/ip/route",
			verb: "add",
			mode: "structured",
			writeShaped: true,
		});
		expect(data.structure.statements[0]?.transport).toMatchObject({
			classification: "api-candidate",
			rest: {
				method: "PUT",
				path: "/rest/ip/route",
				body: {
					"dst-address": "10.9.0.0/16",
					gateway: "192.0.2.1",
				},
			},
		});
		expect(data.structure.statements[0]?.transport?.curl).toBeUndefined();
		expect(code).toBe(0);
	});

	test("1b. The CLI spelling is script to the gate and a command to the analysis", async () => {
		const { data, code } = await explainJson([
			"/ip/route add dst-address=10.9.0.0/16 gateway=192.0.2.1",
		]);
		expect(data.canonical.mode).toBe("script");
		expect(data.canonical.writeShaped).toBe(false);
		expect(data.structure.statements[0]?.command).toEqual({
			path: "/ip/route",
			verb: "add",
			args: { "dst-address": "10.9.0.0/16", gateway: "192.0.2.1" },
		});
		expect(data.structure.containsWrite).toBe(true);
		expect(code).toBe(0);
	});

	test("2. Script mode routes to execute (#202c)", async () => {
		const { data, code } = await explainJson([
			":foreach i in=[/ip/address find] do={ :put $i }",
		]);
		expect(data.canonical.mode).toBe("script");
		const commands = data.structure.statements.filter(
			(statement) => statement.kind === "command",
		);
		expect(commands.length).toBeGreaterThan(0);
		for (const statement of commands) {
			expect(statement.transport?.classification).toBe("execute");
			expect(statement.transport?.centrs).toContain("centrs execute");
			expect(statement.transport?.rest).toBeUndefined();
		}
		expect(code).toBe(0);
	});

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
		// The length check keeps `every` from passing vacuously on an empty table.
		expect(data.evidence.length).toBeGreaterThan(0);
		expect(data.evidence.every((e) => e.source === "canonicalizer")).toBe(true);
	});

	test("4b. The space spelling keeps both roles in the analysis, and neither in the gate", async () => {
		const { data } = await explainJson([
			"/ip/address comment numbers=0 comment=uplink",
		]);
		expect(data.canonical.mode).toBe("script");
		expect(data.canonical.verb).toBe("");
		expect(data.canonical.args).toEqual({});
		// The gate declined the whole input, so it distinguishes no roles. The
		// analysis distinguishes both, from the same bytes (#202c).
		expect(data.structure.statements[0]?.command).toEqual({
			path: "/ip/address",
			verb: "comment",
			args: { numbers: "0", comment: "uplink" },
		});
	});

	test("5. Offline is honest about what it cannot know", async () => {
		const { envelope, data, code } = await explainJson([
			"/ip/address print",
			"--schema",
		]);
		expect(data).not.toHaveProperty("schema");
		expect(data.evidence.length).toBeGreaterThan(0);
		expect(data.evidence.every((e) => e.source === "canonicalizer")).toBe(true);
		expect(envelope.tips.map((t) => t.code)).toContain(
			"tip/explain-live-facets",
		);
		expect(code).toBe(0);
	});

	test("6. curl rendering with a placeholder host (#202c)", async () => {
		const { data, code } = await explainJson(["/ip/address print", "--curl"]);
		const transport = data.structure.statements[0]?.transport;
		expect(transport).toMatchObject({
			classification: "api-candidate",
			rest: { method: "GET", path: "/rest/ip/address" },
		});
		expect(transport?.curl).toContain("curl --user '<username>:<password>'");
		expect(transport?.curl).toContain("'https://<router>/rest/ip/address'");
		expect(transport?.centrs).toBe("centrs api '<router>' '/ip/address'");
		expect(code).toBe(0);
	});

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

	test("18. A bare path neither table knows is ambiguous offline", async () => {
		const { data } = await explainJson(["/disk/format-drive"]);
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

	test("18c. A bare path the COMMAND axis knows resolves as a command, offline", async () => {
		const { data } = await explainJson(["/system/reboot"]);
		const statement = data.structure.statements[0];
		expect(statement?.resolution).toBe("resolved");
		expect(statement?.kind).toBe("command");
		expect(statement?.command).toMatchObject({
			path: "/system",
			verb: "reboot",
		});
		// Knowing it is a command says nothing about whether it MUTATES.
		expect(data.structure.containsWrite).toBe("unknown");
	});

	test("18d. A published command does not move the menu context", async () => {
		const { data } = await explainJson([
			"/ip route\n/system reboot\nadd dst-address=8.8.8.8/32 gateway=1.1.1.1",
		]);
		const [nav, command, relative] = data.structure.statements;
		expect(nav).toMatchObject({ resolution: "resolved", kind: "menu" });
		expect(command?.command).toMatchObject({
			path: "/system",
			verb: "reboot",
		});
		// The #211 B2 closure: `add` resolves where the document actually is.
		expect(relative?.command).toMatchObject({ path: "/ip/route", verb: "add" });
		expect(data.structure.containsWrite).toBe(true);
	});

	test("18e. A published command outranks the punctuation guess", async () => {
		const { data } = await explainJson(["/system/gps/monitor once"]);
		expect(data.structure.statements[0]?.command).toMatchObject({
			path: "/system/gps",
			verb: "monitor",
		});
		// `monitor` is a curated READ; the punctuation reading (`once`) abstained.
		expect(data.structure.containsWrite).toBe(false);
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
		expect(diagnostic).toBeDefined();
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

	test("23. Selector-less set fails closed offline (#202c)", async () => {
		const { data, code } = await explainJson([
			"/ip/dns set use-doh-server=https://resolver.example/dns-query",
			"--curl",
		]);
		const transport = data.structure.statements[0]?.transport;
		expect(transport?.classification).toBe("unknown");
		expect(transport?.basis).toContain("singleton menu");
		expect(transport?.rest).toBeUndefined();
		expect(transport?.curl).toBeUndefined();
		expect(transport?.centrs).toBeUndefined();
		expect(code).toBe(0);
	});

	test("25. Offline semantic symbols retain roles and binding identity (#239)", async () => {
		const input =
			'{:local x 1.3; :put [:typeof $x]; :set x 2.1.1; /put $x; :local z (1.1,1::1,"abc",1d,1w7h2s,1.1.1.1/24,123,[:parse "(1+1)"],(1w+1d),2008:1::2/128,[:timestamp],"a"."b"."c",4%2,-1); :put "$[:typeof $z]"; :foreach i,v in=$z  do={:put "$i = $v; types i = $[:typeof $i], v = $[:typeof $v]"}}';
		const { out, code } = await run(["explain", input]);
		expect(out).toContain("symbols:");
		expect(out.split("\n").filter((line) => line.includes('name="x"'))).toEqual(
			[
				'  [8,9)        local     declaration name="x" bindings=b0',
				'  [30,31)      local     reference   name="x" bindings=b0',
				'  [39,40)      local     assignment  name="x" bindings=b0',
				'  [54,55)      local     reference   name="x" bindings=b0',
			],
		);
		expect(out).toContain('declaration name="z" bindings=b1');
		expect(out).toContain('binding     name="i" bindings=b2');
		expect(out).toContain('binding     name="v" bindings=b3');
		expect(out).not.toContain('name="d"');
		expect(out).not.toContain('name="w7h2s"');
		expect(code).toBe(0);
	});

	test("26. Value facts keep the three type axes separate (#225)", async () => {
		const { data, code } = await explainJson([
			':local x 2.2; :set x "2.2"; :local z (1,2,3); :local t 00:00:02; :local i *1; /ip/arp/add mac-address=00:11:22:33:44:55',
		]);
		expect(data.values.occurrences.map((value) => value.facts)).toEqual([
			{ shapeHints: { values: ["ip"], ev: "e9" } },
			{ shapeHints: { values: ["str"], ev: "e9" } },
			{ shapeHints: { values: ["array"], ev: "e9" } },
			// The array's own members, example 28's subject.
			{ shapeHints: { values: ["num"], ev: "e9" } },
			{ shapeHints: { values: ["num"], ev: "e9" } },
			{ shapeHints: { values: ["num"], ev: "e9" } },
			{ shapeHints: { values: ["time"], ev: "e9" } },
			{ shapeHints: { values: ["id"], ev: "e9" } },
			{ shapeHints: { values: ["mac"], ev: "e9" } },
		]);
		expect(
			data.values.occurrences.every(
				(value) => value.facts.observedType === undefined,
			),
		).toBe(true);
		expect(
			data.values.occurrences.every(
				(value) => value.facts.schemaType === undefined,
			),
		).toBe(true);
		expect(data.verdict).toBe("pass");
		expect(data.runtimeAcceptance).toBe("not-proven");
		expect(code).toBe(0);
	});

	test("28. An array literal is read member by member, and only where it is one (#225)", async () => {
		const input =
			':local z {1.1;"abc";1d;{2;3};a=0x10;b=100000w}; /ip/route/add comment={1;2}';
		const { data, code } = await explainJson([input]);
		expect(
			data.values.occurrences.map((value) => [
				value.kind,
				value.name ?? null,
				value.parent ?? null,
				value.facts.shapeHints?.values,
			]),
		).toEqual([
			["positional", null, null, ["array"]],
			["element", null, "v0", ["ip"]],
			["element", null, "v0", ["str"]],
			["element", null, "v0", ["time"]],
			["element", null, "v0", ["array"]],
			["element", null, "v4", ["num"]],
			["element", null, "v4", ["num"]],
			["element", "a", "v0", ["num"]],
		]);
		// Every member span addresses its own source bytes.
		expect(
			data.values.occurrences
				.filter((value) => value.kind === "element")
				.map((value) => input.slice(value.span.start, value.span.end)),
		).toEqual(["1.1", '"abc"', "1d", "{2;3}", "2", "3", "0x10"]);
		// `b=100000w` overflows the time range and is a variable reference on the
		// device; the second statement's brace array is a device syntax error, so
		// nothing at all is anchored past the `;`.
		const secondStatement = input.indexOf("/ip/route/add");
		expect(
			data.values.occurrences.some(
				(value) => value.span.start >= secondStatement,
			),
		).toBe(false);
		expect(data.verdict).toBe("fail");
		expect(
			data.diagnostics.find((diagnostic) =>
				diagnostic.code.endsWith("/invalid-command-brace"),
			)?.span,
		).toEqual({
			start: input.indexOf("{", secondStatement),
			end: input.indexOf("{", secondStatement) + 1,
		});
		expect(code).toBe(2);
	});

	test("28b. The comma spelling is accepted everywhere, and means two things (#225)", async () => {
		const { data, code } = await explainJson([
			"/ip/dns/set servers=1.1.1.1,8.8.8.8; /ip/route/add comment=a,b; :local x 1,2",
		]);
		expect(
			data.values.occurrences.map((value) => [
				value.kind,
				value.name ?? null,
				value.facts.shapeHints?.values,
			]),
		).toEqual([
			["attribute", "servers", ["array", "str"]],
			["attribute", "comment", ["array", "str"]],
			["positional", null, ["array"]],
		]);
		// A bare comma run is never split into members; the delimited spelling is.
		expect(
			(
				await explainJson(["/ip/dns/set servers=(1.1.1.1,8.8.8.8)"])
			).data.values.occurrences.map((value) => [
				value.kind,
				value.facts.shapeHints?.values,
			]),
		).toEqual([
			["attribute", ["array"]],
			["element", ["ip"]],
			["element", ["ip"]],
		]);
		expect(
			data.values.occurrences.every(
				(value) => value.facts.schemaType === undefined,
			),
		).toBe(true);
		expect(data.verdict).toBe("pass");
		expect(code).toBe(0);
	});
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

	test("more than one positional target is fan-out, with the fan-out code", async () => {
		// Same fact as `--group`, so the same code: `isFanoutMode` keys on either.
		const { code, err } = await run([
			"explain",
			"r1",
			"r2",
			"/ip/route print",
			"--json",
		]);
		const envelope = JSON.parse(err) as {
			error: { code: string; context?: { targets?: string[] } };
		};
		expect(envelope.error.code).toBe("usage/fanout-not-supported");
		expect(envelope.error.context?.targets).toEqual(["r1", "r2"]);
		expect(code).toBe(1);
	});

	test("an unquoted input names the likelier mistake", async () => {
		// `explain /ip/route print` is two positionals, so the grammar reads a
		// router — but a leading `/` or `:` says the shell split an input.
		const { err } = await run(["explain", "/ip/route", "print"]);
		expect(err).toContain("the input was probably not quoted");
		expect(err).toContain("centrs explain '/ip/route print'");
	});

	test("the format follows the settings ladder, CLI last", async () => {
		const env = await run(["explain", "/ip/route", "--format", "json"]);
		const settings = (
			JSON.parse(env.out) as {
				meta: { settings: { format?: { kind: string; key: string } } };
			}
		).meta.settings;
		expect(settings.format).toEqual({ kind: "cli", key: "format" });
	});

	test("a bad --format is a typed error, in text", async () => {
		const { code, err } = await run([
			"explain",
			"/ip/route",
			"--format",
			"toml",
		]);
		expect(err).toContain("[settings/invalid-format]");
		expect(code).toBe(1);
	});

	test("`--verbose` after `--` is an operand, not a flag", async () => {
		// The private error context must not be unlocked by RouterOS input.
		const { err } = await run(["explain", "--", "--verbose", "--yaml"]);
		expect(err).toContain("[usage/not-implemented]");
		expect(err).not.toContain("Context:");
	});

	test("the live form is refused BEFORE any input source is touched", async () => {
		// Ordering, not just outcome: reading first made `--file -` block on EOF
		// before the refusal, and `--file <missing>` report a file error instead of
		// it. Both must name the live form, and the `--file -` case must not hang.
		const missing = await run([
			"explain",
			"edge1",
			"--file",
			`${import.meta.dir}/no-such-file.rsc`,
			"--json",
		]);
		expect(
			(JSON.parse(missing.err) as { error: { code: string } }).error.code,
		).toBe("usage/not-implemented");

		const stdin = await run(["explain", "edge1", "--file", "-", "--json"]);
		expect(
			(JSON.parse(stdin.err) as { error: { code: string } }).error.code,
		).toBe("usage/not-implemented");
	});

	test("an empty positional is a present argument, not an absent one", async () => {
		const { code, err } = await run(["explain", "", "--json"]);
		expect((JSON.parse(err) as { error: { code: string } }).error.code).toBe(
			"input/invalid-command",
		);
		expect(code).toBe(1);
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

	test("the text format surfaces comment spans", async () => {
		const { out, code } = await run([
			"explain",
			"# root\n:put 1; # after separator\n:put 2",
		]);
		expect(out).toContain("comments:\n  [0,6)        comment");
		expect(out).toContain("[15,32)      comment");
		expect(code).toBe(0);
	});

	test("the error format follows the same grammar as the parser", async () => {
		// Flags after `--` are operands, so the error renders TEXT even though the
		// argv contains `--json`; and when two format flags are given, the LAST one
		// wins, matching what the parse loop would have decided.
		const literal = await run(["explain", "--", "--json", "--yaml"]);
		expect(literal.code).toBe(1);
		expect(literal.err).toContain("[usage/not-implemented]");
		expect(() => JSON.parse(literal.err)).toThrow();

		const lastWins = await run(["explain", "--json", "--yaml", "--nope"]);
		expect(lastWins.code).toBe(1);
		expect(lastWins.err).toContain('code: "input/invalid-command"');
	});

	test("--yaml renders the same envelope, and it parses", async () => {
		// Substring assertions would pass on YAML the hand-rolled writer emits but
		// no parser accepts, so this round-trips it and compares whole envelopes.
		const yaml = await run(["explain", "/ip/route", "--yaml"]);
		const json = await run(["explain", "/ip/route", "--json"]);
		expect(Bun.YAML.parse(yaml.out)).toEqual(JSON.parse(json.out));
		expect(yaml.code).toBe(json.code);
	});
});
