import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	canonicalizeExecuteCommand,
	isWriteShaped,
} from "../../src/execute.ts";
import { analyzeCoordinates } from "../../src/explain/coordinates.ts";
import { segmentStatements } from "../../src/explain/segment.ts";
import {
	type ExplainData,
	explainCommand,
	explainEnvelope,
} from "../../src/explain.ts";
import * as centrs from "../../src/index.ts";

/**
 * `explainCommand` composition anchors (#202a).
 *
 * The nine analyzers each have their own frozen fixtures; nothing here re-tests
 * what they decide. What this file pins is the part that only exists once they
 * are composed: the envelope's vocabulary, the invariants that tie the surfaces
 * to each other (a span in bounds, an `ev` that resolves, a verdict that is the
 * max severity), and the boundary this composition must NOT cross — the execute
 * gate it reproduces.
 *
 * The offline examples in `commands/explain/examples.md` land in
 * `test/unit/explain.test.ts` with the CLI (#202b), one assertion per example.
 */

/** A spread of shapes: clean, ambiguous, malformed, nested, non-ASCII, empty. */
const inputs = [
	"",
	"/ip/route/add dst-address=10.9.0.0/16 gateway=192.0.2.1",
	"/ip/route add dst-address=10.9.0.0/16 gateway=192.0.2.1",
	"/ip/address print",
	"/ip/route",
	"/system/reboot",
	"/disk format-drive disk1",
	"/ip/address remove [find comment=defconf]",
	":foreach i in=[/ip/address find] do={ :put $i }",
	"/interface bridge add name=br;0 protocol-mode=none",
	'/system identity set name="router-🚀"',
	":if [) do={ /ip route add }",
	':put "unterminated',
	"/ip) address\n/ip route print",
	"# just a comment\n:local v 1\n:put $v",
];

const corners: string[] = [
	...(
		JSON.parse(
			readFileSync(
				new URL("../fixtures/explain/segments.json", import.meta.url),
				"utf8",
			),
		).corners as { input: string }[]
	).map((c) => c.input),
	...(() => {
		const f = JSON.parse(
			readFileSync(
				new URL("../fixtures/explain/pathresolve.json", import.meta.url),
				"utf8",
			),
		) as { document: { input: string }[]; statements: { input: string }[] };
		return [...f.document, ...f.statements].map((c) => c.input);
	})(),
];

describe("explainCommand — structural invariants", () => {
	for (const input of [...inputs, ...corners]) {
		test(JSON.stringify(input).slice(0, 70), () => {
			const data = explainCommand(input);
			const bytes = analyzeCoordinates(input).analyzed.length;

			// The count is the list's length — and the list is the RESOLVER's, which
			// flattens block bodies, so it is at least the top-level segmentation.
			expect(data.structure.statementCount).toBe(
				data.structure.statements.length,
			);
			expect(data.structure.statementCount).toBeGreaterThanOrEqual(
				segmentStatements(input).segments.length,
			);

			// Every span is a legal half-open analyzed-byte range in THIS input.
			const ranges = [
				...data.structure.statements.map((s) => s.span),
				...data.structure.subcommands.map((s) => s.span),
				...data.structure.blocks.map((b) => b.span),
				...data.spans,
				...data.diagnostics.map((d) => d.span),
			];
			for (const r of ranges) {
				expect(r.start).toBeGreaterThanOrEqual(0);
				expect(r.end).toBeLessThanOrEqual(bytes);
				expect(r.start).toBeLessThanOrEqual(r.end);
			}

			// `input.bytes` is the analyzed length, and the position map covers it
			// contiguously from 0 — the property a consumer indexes into.
			expect(data.input.bytes).toBe(bytes);
			let at = 0;
			for (const entry of data.input.positionMap) {
				expect(entry.analyzed.start).toBe(at);
				at = entry.analyzed.end;
			}
			expect(at).toBe(bytes);

			// Every cited evidence id resolves, and every entry is cited.
			const ids = new Set(data.evidence.map((e) => e.id));
			const cited = new Set<string>([
				data.structure.ev,
				...data.structure.statements.map((s) => s.ev),
				...data.structure.subcommands.map((s) => s.ev),
				...data.structure.blocks.map((b) => b.ev),
				...data.spans.map((s) => s.ev),
				...data.diagnostics.map((d) => d.ev),
			]);
			for (const id of cited) expect(ids.has(id)).toBe(true);
			// `e0` (the gate) and `e1` (coordinates) are cited by `canonical` and
			// `input`, which carry no `ev` field of their own.
			for (const id of ids)
				expect(cited.has(id) || id === "e0" || id === "e1").toBe(true);

			// Provenance is the pass that RAISED the fact. The classes only one
			// analyzer can produce pin it: a lexical class must never be attributed
			// to the segmenter's delimiter stack, which cannot see it.
			const probeOf = (ev: string): string | undefined =>
				data.evidence.find((e) => e.id === ev)?.probe;
			for (const d of data.diagnostics) {
				if (d.code.endsWith("/bad-escape") || d.code.endsWith("/bad-sigil"))
					expect(probeOf(d.ev)).toBe("resolveSymbols");
				if (d.code.endsWith("/bom") || d.code.endsWith("/non-ascii"))
					expect(probeOf(d.ev)).toBe("analyzeCoordinates");
			}

			// The verdict is the maximum diagnostic severity, nothing else.
			const rank = { info: 0, warning: 1, error: 2 } as const;
			const worst = data.diagnostics.reduce(
				(m, d) => Math.max(m, rank[d.severity]),
				0,
			);
			expect(data.verdict).toBe(
				(["pass", "warn", "fail"] as const)[worst] as ExplainData["verdict"],
			);

			// The resolution vocabulary is total and consistent with `kind`, on
			// BOTH surfaces that speak it — and the three shapes the exported union
			// declares are the three that actually occur. A resolved statement
			// always has a command, a menu never has a verb, a refusal has neither.
			for (const s of [
				...data.structure.statements,
				...data.structure.subcommands,
			]) {
				if (s.resolution === "resolved") {
					expect(s.kind).toBeDefined();
					expect(s.unresolved).toBeUndefined();
					expect(s.command?.path.startsWith("/")).toBe(true);
					if (s.kind === "menu") expect("verb" in s.command).toBe(false);
					else expect(typeof s.command.verb).toBe("string");
				} else {
					expect(s.kind).toBeUndefined();
					expect(s.command).toBeUndefined();
					expect(s.unresolved).toBeDefined();
				}
			}

			// Offline never claims acceptance, on any input.
			expect(data.runtimeAcceptance).toBe("not-proven");
		});
	}
});

describe("block bodies are statements too", () => {
	test("a body statement is not paired with the wrong span", () => {
		// The resolver FLATTENS `do={…}` bodies into its statement list, so it is
		// longer than the top-level segmentation. Pairing the two by index — which
		// this composition did until the corpus run showed 47% of statements
		// resolving `unknown` — attaches the wrong span to every statement after the first
		// block. Each split carries its own document-space span; nothing is paired.
		const input = ":if (true) do={ /ip route print }\n/ip address print";
		const { statements } = explainCommand(input).structure;
		expect(statements).toHaveLength(3);
		expect(statements.map((s) => s.command?.path ?? null)).toEqual([
			"/",
			"/ip/route",
			"/ip/address",
		]);
		// Every span slices back to the statement it describes.
		expect(
			statements.map((s) => input.slice(s.span.start, s.span.end)),
		).toEqual([
			":if (true) do={ /ip route print }",
			"/ip route print",
			"/ip address print",
		]);
		// The body's span is CONTAINED by its parent's, not after it.
		expect(statements[1]?.span.start).toBeGreaterThan(
			statements[0]?.span.start as number,
		);
		expect(statements[1]?.span.end).toBeLessThan(
			statements[0]?.span.end as number,
		);
	});

	test("the enclosing scope is reported separately, by name and with provenance", () => {
		const data = explainCommand(":if (true) do={ /ip route print }");
		const [block] = data.structure.blocks;
		expect(data.structure.blocks).toHaveLength(1);
		expect(block).toMatchObject({ name: "do", span: { start: 15, end: 32 } });
		// A block is a derived fact like any other, so it names the pass that found
		// it — the scope walk, which no other surface here cites.
		expect(data.evidence.find((e) => e.id === block?.ev)?.probe).toBe(
			"scopeBlocks",
		);
	});

	test("a body command's write signal reaches the document verdict", () => {
		// The reason flattening is the right default: the write is INSIDE the body.
		expect(
			explainCommand(":foreach i in=[find] do={ /ip route add gateway=$i }")
				.structure.containsWrite,
		).toBe(true);
	});
});

describe("the execute gate is reproduced, never widened", () => {
	// The parity guard. `test/unit/execute-canonicalize-contract.test.ts` pins the
	// gate itself and must stay green and unmodified; this pins that the richer
	// analysis sits BESIDE it — over every fixture corner in the repo, so a corner
	// added for the analyzers is automatically a parity case too.
	for (const input of [...inputs, ...corners]) {
		test(JSON.stringify(input).slice(0, 70), () => {
			const gate = canonicalizeExecuteCommand(input);
			expect(explainCommand(input).canonical).toEqual({
				mode: gate.mode,
				path: gate.path,
				verb: gate.verb,
				args: gate.attributes,
				queries: gate.queries,
				writeShaped: isWriteShaped(gate),
			});
		});
	}

	test("the CLI verb spelling is script to the gate and a command to the analysis", () => {
		// Not a bug, and the single most confusing thing about the two surfaces:
		// the gate wants the verb IN the path, so `/ip/route add …` is `script`
		// while the analysis reads exactly what the human wrote.
		const data = explainCommand("/ip/route add dst-address=10.9.0.0/16");
		expect(data.canonical.mode).toBe("script");
		expect(data.canonical.writeShaped).toBe(false);
		expect(data.structure.statements[0]?.command).toEqual({
			path: "/ip/route",
			verb: "add",
		});
		// …and the write signal that the gate cannot give is still reported.
		expect(data.structure.containsWrite).toBe(true);
	});
});

describe("the resolution vocabulary", () => {
	test("navigation folds into resolved + kind: menu", () => {
		const [statement] = explainCommand("/ip/route").structure.statements;
		expect(statement?.resolution).toBe("resolved");
		expect(statement?.kind).toBe("menu");
		expect(statement?.command).toEqual({ path: "/ip/route" });
	});

	test("a bare path the menu table does not know is ambiguous, with a reason", () => {
		// `/system/reboot` and `/ip/address` are the same SHAPE; the #207 table
		// settles the ones it lists and this one it does not.
		const data = explainCommand("/system/reboot");
		expect(data.structure.statements[0]?.resolution).toBe("ambiguous");
		expect(data.structure.statements[0]?.command).toBeUndefined();
		const [diagnostic] = data.diagnostics;
		expect(diagnostic?.code).toBe("explain/canonicalizer/ambiguous-statement");
		expect(diagnostic?.severity).toBe("warning");
		expect(diagnostic?.message.length).toBeGreaterThan(0);
	});

	test("a refusal is a warning, never an error — `--fail-on error` must not fire", () => {
		// Most RouterOS scripting is unreadable without a schema. If abstention
		// were an error, the default `--fail-on error` would fail on correct input.
		for (const input of ["/system/reboot", "/disk format-drive disk1"]) {
			const data = explainCommand(input);
			expect(data.verdict).toBe("warn");
			expect(data.diagnostics.every((d) => d.severity !== "error")).toBe(true);
		}
	});

	test("a defect cannot fabricate a following command", () => {
		// examples.md example 21. The injected `;` is a statement separator, so the
		// tail is a real statement — headed by a bare word, which fails closed.
		const data = explainCommand(
			"/interface bridge add name=br;0 protocol-mode=none",
		);
		expect(data.structure.statements.map((s) => s.resolution)).toEqual([
			"resolved",
			"unknown",
		]);
		expect(data.structure.statements[1]?.command).toBeUndefined();
		expect(
			data.diagnostics.some(
				(d) => d.code === "explain/canonicalizer/unresolved-statement",
			),
		).toBe(true);
	});

	test("a correct reading after a lost context says so, at info severity", () => {
		// #192's third bullet, surfaced. `/ip route print` is absolute, so it never
		// consumed the context the defect destroyed — the reading is right, and the
		// fact that the document lost its place is reported beside it.
		const data = explainCommand("/ip) address\n/ip route print");
		const [, second] = data.structure.statements;
		expect(second?.resolution).toBe("resolved");
		expect(second?.contextCertain).toBe(false);
		const lost = data.diagnostics.filter(
			(d) => d.code === "explain/canonicalizer/context-lost",
		);
		expect(lost).toHaveLength(1);
		expect(lost[0]?.severity).toBe("info");
	});
});

describe("subcommands speak the same vocabulary as statements", () => {
	test("the inner command of a selector is resolved against the enclosing menu", () => {
		// examples.md example 3. The GATE stays `script` (a `[…]` selector cannot
		// be a structured attribute map) while the analysis reads the inner
		// command, and the outer `remove` is what makes `containsWrite` true.
		const data = explainCommand("/ip/address remove [find comment=defconf]");
		expect(data.canonical.mode).toBe("script");
		expect(data.canonical.writeShaped).toBe(false);
		expect(data.structure.containsWrite).toBe(true);
		const [sub] = data.structure.subcommands;
		expect(sub?.resolution).toBe("resolved");
		expect(sub?.kind).toBe("command");
		expect(sub?.command).toEqual({ path: "/ip/address", verb: "find" });
		expect(sub?.context).toBe("/ip/address");
		expect(sub?.span).toEqual({ start: 19, end: 41 });
		// The evidence for the write verdict is the heuristic Q16 pass.
		expect(data.evidence.find((e) => e.id === data.structure.ev)?.basis).toBe(
			"heuristic",
		);
	});

	test("the verb boundary is Q6's answer, with Q3's readings kept as candidates", () => {
		// Q3's own `path` reads this as the menu `/system/identity/get`; Q6 splits
		// it into menu + verb, and Q6 is the module that decides verbs.
		const [sub] = explainCommand(":put [/system/identity/get name]").structure
			.subcommands;
		expect(sub?.command).toEqual({ path: "/system/identity", verb: "get" });
		expect(sub?.candidates).toContain("/system/identity/get");
	});

	test("a substitution Q3 refused stays unknown whatever Q6 reads", () => {
		const [sub] = explainCommand("/ip route remove [$myFinder]").structure
			.subcommands;
		expect(sub?.resolution).toBe("unknown");
		expect(sub?.command).toBeUndefined();
		expect(sub?.unresolved).toBeDefined();
	});

	test("an expression is not promoted into a command", () => {
		// Q3 resolves the bracket's CONTEXT to `/`, which is not a claim that
		// `1+1` is a command at the root. Q6 refuses, and the envelope reports the
		// refusal rather than the context.
		const [sub] = explainCommand(":put [1+1]").structure.subcommands;
		expect(sub?.resolution).toBe("unknown");
		expect(sub?.command).toBeUndefined();
	});

	test("nested substitutions each carry their own depth", () => {
		const subs = explainCommand(':put [[:parse "x"]]').structure.subcommands;
		expect(subs.map((s) => s.depth)).toEqual([0, 1]);
		expect(subs[1]?.command).toEqual({ path: "/", verb: "parse" });
	});
});

describe("the write tristate is three-valued in the envelope", () => {
	// examples.md example 20, at the library boundary.
	test("true / false / unknown", () => {
		expect(
			explainCommand(
				"/ip/address add address=198.51.100.10/32 interface=ether1",
			).structure.containsWrite,
		).toBe(true);
		expect(explainCommand("/ip/address print").structure.containsWrite).toBe(
			false,
		);
		expect(
			explainCommand("/disk format-drive disk1").structure.containsWrite,
		).toBe("unknown");
	});

	test("it does not move the gate's writeShaped verdict", () => {
		const data = explainCommand("/disk format-drive disk1");
		expect(data.structure.containsWrite).toBe("unknown");
		expect(data.canonical.writeShaped).toBe(false);
	});
});

describe("diagnostics", () => {
	test("structural defects are errors and carry their region", () => {
		const data = explainCommand(':put "unterminated');
		expect(data.verdict).toBe("fail");
		const d = data.diagnostics.find(
			(x) => x.code === "explain/canonicalizer/unterminated-string",
		);
		expect(d?.severity).toBe("error");
		// The region is the whole swallowed run, from the opening quote onward —
		// not the quote alone. The statement's own refusal is reported separately,
		// spanning the statement.
		expect(d?.span).toEqual({ start: 5, end: 18 });
		expect(data.diagnostics.map((x) => x.code)).toContain(
			"explain/canonicalizer/unresolved-statement",
		);
	});

	test("positional facts are info, so a legal non-ASCII command passes", () => {
		// examples.md example 22: `name="router-🚀"` is a correct command.
		const data = explainCommand('/system identity set name="router-🚀"');
		expect(data.verdict).toBe("pass");
		expect(data.diagnostics.map((d) => d.code)).toEqual([
			"explain/canonicalizer/non-ascii",
		]);
		expect(data.diagnostics[0]?.severity).toBe("info");
	});

	test("over-depth is a warning: it is centrs's bound, not RouterOS's", () => {
		const data = explainCommand(`${"{".repeat(300)}:put 1${"}".repeat(300)}`);
		const over = data.diagnostics.filter(
			(d) => d.code === "explain/canonicalizer/over-depth",
		);
		expect(over.length).toBeGreaterThan(0);
		expect(over.every((d) => d.severity === "warning")).toBe(true);
	});

	test("a defect is tagged with the pass that raised it, not the first merged", () => {
		// Both bots caught this: `bad-escape` and `bad-sigil` are the SYMBOL scan's
		// lexical rules, which is why they are `heuristic`, and the segmenter's
		// delimiter stack cannot produce them. Attributing every non-positional
		// defect to the segmenter claimed `direct`/`segmentStatements` for a fact
		// `segmentStatements` never saw.
		const data = explainCommand(":local \\\\\nfoo 1");
		const d = data.diagnostics.find((x) =>
			x.code.endsWith("/bad-escape"),
		) as (typeof data.diagnostics)[number];
		expect(d).toBeDefined();
		const evidence = data.evidence.find((e) => e.id === d.ev);
		expect(evidence?.probe).toBe("resolveSymbols");
		expect(evidence?.basis).toBe("heuristic");
	});

	test("a class two analyzers both raise keeps its first attribution, once", () => {
		// `unterminated-string` comes from BOTH the segmenter and the symbol scan.
		// It is one diagnostic, tagged with the direct reading.
		const data = explainCommand(':put "unterminated');
		const hits = data.diagnostics.filter((d) =>
			d.code.endsWith("/unterminated-string"),
		);
		expect(hits).toHaveLength(1);
		expect(data.evidence.find((e) => e.id === hits[0]?.ev)?.probe).toBe(
			"segmentStatements",
		);
	});

	test("statements and subcommands cite different passes", () => {
		// They come from different walks; one evidence entry for both would say a
		// probe ran that did not.
		const data = explainCommand("/ip/address remove [find comment=defconf]");
		const statementEv = data.structure.statements[0]?.ev as string;
		const subcommandEv = data.structure.subcommands[0]?.ev as string;
		expect(statementEv).not.toBe(subcommandEv);
		expect(data.evidence.find((e) => e.id === statementEv)?.probe).toBe(
			"resolveVerbs",
		);
		expect(data.evidence.find((e) => e.id === subcommandEv)?.probe).toBe(
			"resolveDocument + resolveVerb",
		);
	});

	test("every diagnostic code is slash-namespaced under explain/", () => {
		for (const input of [...inputs, ...corners])
			for (const d of explainCommand(input).diagnostics)
				expect(d.code).toMatch(/^explain\/[a-z-]+\/[a-z-]+$/);
	});
});

describe("coordinates", () => {
	test("an astral character maps four analyzed bytes to two UTF-16 units", () => {
		// examples.md example 22's coordinate half.
		const input = '/system identity set name="router-🚀"';
		const data = explainCommand(input);
		expect(data.input.normalized).toBe(true);
		const rocket = data.input.positionMap.find(
			(e) => e.analyzed.end - e.analyzed.start === 4,
		);
		expect(rocket?.originalUtf16.end).toBe(
			(rocket?.originalUtf16.start as number) + 2,
		);
		// `end === bytes` is the legal end-of-input cursor.
		expect(data.input.positionMap.at(-1)?.analyzed.end).toBe(data.input.bytes);
	});

	test("pure ASCII is one identity run and reports normalized: false", () => {
		const data = explainCommand("/ip/address/print");
		expect(data.input.normalized).toBe(false);
		expect(data.input.positionMap).toEqual([
			{ analyzed: { start: 0, end: 17 }, originalUtf16: { start: 0, end: 17 } },
		]);
	});
});

describe("spans", () => {
	test("comments and resolved variables, in source order", () => {
		const data = explainCommand("# note\n:local v 1\n:put $v");
		expect(data.spans.map((s) => s.class)).toEqual([
			"comment",
			"variable-local",
			"variable-local",
		]);
		expect(data.spans.map((s) => s.start)).toEqual(
			[...data.spans].sort((a, b) => a.start - b.start).map((s) => s.start),
		);
	});

	test("an abstained symbol class is omitted, not guessed", () => {
		// A bare word with no binding is S7's abstention: the resolver refuses to
		// call it `undefined` (menu field vs unbound name needs a schema), so it
		// has no centrs span class either.
		const data = explainCommand(":put unbound-name");
		expect(data.spans).toEqual([]);
	});
});

describe("explainEnvelope", () => {
	test("an analysis that ran is ok: true, however broken the input", () => {
		const envelope = explainEnvelope(":if [) do={ /ip route add }");
		expect(envelope.ok).toBe(true);
		expect(envelope.data.verdict).toBe("fail");
		expect(envelope.warnings).toEqual([]);
	});

	test("offline chose no transport, so `via` is null rather than invented", () => {
		const envelope = explainEnvelope("/ip/address/print");
		expect(envelope.meta.via).toBeNull();
		expect(envelope.meta.target).toEqual({});
		expect(envelope.meta.validation).toEqual({
			enabled: false,
			result: "skipped",
		});
	});

	test("the offline tip points at the live target, and is a tip not a warning", () => {
		const envelope = explainEnvelope("/ip/address/print");
		expect(envelope.tips.map((t) => t.code)).toEqual([
			"tip/explain-offline-only",
		]);
		expect(envelope.tips[0]?.fix).toContain("centrs explain <router>");
	});

	test("operation meta mirrors the data it summarizes", () => {
		const envelope = explainEnvelope("/ip/route\nprint");
		expect(envelope.meta.operation).toEqual({
			command: "explain",
			mode: "offline",
			statementCount: envelope.data.structure.statementCount,
			verdict: envelope.data.verdict,
		});
	});
});

describe("public export surface", () => {
	test("the composition is exported from the library root", () => {
		expect(centrs.explainCommand).toBe(explainCommand);
		expect(centrs.explainEnvelope).toBe(explainEnvelope);
	});
});
