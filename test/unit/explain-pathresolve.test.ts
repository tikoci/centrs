import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { commandVerbIndex, PATH_CATALOG } from "../../src/explain/catalog.ts";
import { hasStructuralDefect } from "../../src/explain/defects.ts";
import { MENU_PATHS } from "../../src/explain/menus.ts";
import {
	resolveDocument,
	resolveStatements,
} from "../../src/explain/pathresolve.ts";
import { VERBS } from "../../src/explain/verbs.ts";
import { resolveVerbs } from "../../src/explain/verbsplit.ts";
import * as centrs from "../../src/index.ts";

/**
 * Q3/Q4 path-resolution anchor tests (phase 0.5, #185/#186).
 *
 * Promoted from the throwaway lab probe `.scratch/explain-lab-pathresolve.ts`
 * (the SUT) and the constructed corners `.scratch/explain-lab-q3-corners.ts` /
 * `-q4-corners.ts` (several CHR-confirmed against `:parse` IL on 7.23.2 and
 * 7.24rc2). The production module is `src/explain/pathresolve.ts`; only the
 * ratified `stateful` context model is promoted (the A/B arms stayed in the
 * lab). It sits on the Q1 segmenter (#189) and the Q2 scope classifier.
 *
 * `document` corners assert the re-constituted `[…]` substitution paths (Q3);
 * `statements` corners assert the per-statement canonical paths in source order
 * (Q4). Corners flagged `viaCandidates` are scored against the candidate set,
 * because offline provably cannot pick one reading without a schema (Q6). The
 * two KNOWN-LIMIT corners deliberately pin offline's CHR-confirmed divergence
 * from the device (the bare-path cascade and bare-word nav).
 */

interface DocCorner {
	name: string;
	input: string;
	expect: (string | null)[];
	viaCandidates?: true;
	rule: string;
	verified?: string;
}

interface StmtCorner {
	name: string;
	input: string;
	expect: (string | null)[];
	rule: string;
	verified?: string;
}

const fixtures: { document: DocCorner[]; statements: StmtCorner[] } =
	JSON.parse(
		readFileSync(
			new URL("../fixtures/explain/pathresolve.json", import.meta.url),
			"utf8",
		),
	);

describe("Q3 bracket re-constitution (resolveDocument)", () => {
	for (const c of fixtures.document) {
		test(c.name, () => {
			const res = resolveDocument(c.input).resolutions;
			const got = c.viaCandidates
				? res.map((r, i) =>
						r.candidates.includes(c.expect[i] as string) ? c.expect[i] : r.path,
					)
				: res.map((r) => r.path);
			expect(got).toEqual(c.expect);
		});
	}
});

describe("Q4 per-statement canonical paths (resolveStatements)", () => {
	for (const c of fixtures.statements) {
		test(c.name, () => {
			const got = resolveStatements(c.input).statements.map((s) => s.path);
			expect(got).toEqual(c.expect);
		});
	}
});

describe("well-formed corners report no structural defects", () => {
	for (const c of [...fixtures.document, ...fixtures.statements]) {
		// The pasted-prompt corner is well-formed text (the device rejects it, but
		// its delimiters balance), so like every ratified corner it carries no
		// structural defect; the abstention shows up as an unresolved resolution.
		// Positional facts are not structure — a corner may legally carry one.
		test(c.name, () => {
			expect(hasStructuralDefect(resolveDocument(c.input).defects)).toBe(false);
			expect(hasStructuralDefect(resolveStatements(c.input).defects)).toBe(
				false,
			);
		});
	}
});

describe("candidate invariant — a resolved path is always among its candidates", () => {
	for (const c of fixtures.document) {
		test(c.name, () => {
			for (const r of resolveDocument(c.input).resolutions) {
				if (r.path === null) continue;
				expect(r.candidates).toContain(r.path);
			}
		});
	}
});

test("R7 — a variable path segment abstains rather than guessing", () => {
	const [r] = resolveDocument("/ip route remove [$myFinder]").resolutions;
	expect(r?.path).toBeNull();
	expect(r?.unresolved).toBeDefined();
});

test("a pasted CLI prompt is not manufactured into a command", () => {
	const [r] = resolveDocument("[admin@Router] > /ip address print").resolutions;
	expect(r?.path).toBeNull();
	expect(r?.klass).toBe("cli-prompt-artifact");
});

test("resolveStatements marks navigation statements as nav", () => {
	const res = resolveStatements("/ip route\nadd gateway=1.1.1.1").statements;
	expect(res.map((s) => s.isNav)).toEqual([true, false]);
	expect(res.map((s) => s.path)).toEqual(["/ip/route", "/ip/route/add"]);
});

test("leading whitespace before a nav line still updates context", () => {
	// menuNavPath uses the trimmed text throughout, so leading spaces cannot make
	// an absolute nav skip updating the persistent context for the next line.
	const res = resolveStatements(
		"   /ip route\n   add gateway=1.1.1.1",
	).statements;
	expect(res.map((s) => s.path)).toEqual(["/ip/route", "/ip/route/add"]);
});

test("non-ASCII whitespace is opaque, not a path separator", () => {
	for (const whitespace of [" ", " ", " "]) {
		const res = resolveStatements(`/ip${whitespace}route\nadd`).statements;
		expect(res.map((s) => s.isNav)).toEqual([false, false]);
		// The point of this case is that the exotic space does NOT separate path
		// tokens, so `/ip route` stays unreadable. `add` then inherits a context
		// that unreadable `/`-led line may or may not have moved — Q14 C3b — so it
		// abstains rather than claiming the root command `/add`.
		expect(res.map((s) => s.path)).toEqual([null, null]);
		expect(res[0]?.unresolved).toBeDefined();
		expect(res[1]?.contextCertain).toBe(false);
	}
});

describe("Q14 fail-closed — malformed input degrades, never invents commands", () => {
	// `:if [) do={ /ip route add }` has unbalanced `[`/`)`. It must NOT emit a
	// confident `/if` or descend the body into `/ip/route/add`.
	const malformed = ":if [) do={ /ip route add }";

	test("resolveStatements degrades the malformed statement", () => {
		const { statements, defects } = resolveStatements(malformed);
		expect(statements.map((s) => s.path)).toEqual([null]);
		expect(statements[0]?.unresolved).toBeDefined();
		expect(statements.map((s) => s.path)).not.toContain("/ip/route/add");
		expect(hasStructuralDefect(defects)).toBe(true); // segmenter defect surfaced
	});

	test("resolveDocument emits no confident path from malformed input", () => {
		const { resolutions, defects } = resolveDocument(malformed);
		expect(resolutions.map((r) => r.path).filter((p) => p !== null)).toEqual(
			[],
		);
		expect(hasStructuralDefect(defects)).toBe(true);
	});
});

describe("comment-aware delimiter scanning", () => {
	test("a `#`-comment `}` is not a real delimiter (no false malformed)", () => {
		// `:do {\n# }\n:put 1\n}` is valid — the `}` in the comment must not make
		// the statement look unbalanced, and the body must reach `:put 1`.
		const { statements, defects } = resolveStatements(":do {\n# }\n:put 1\n}");
		expect(statements.map((s) => s.path)).toEqual(["/do", "/put"]);
		expect(statements[0]?.unresolved).toBeUndefined();
		expect(defects).toEqual([]);
	});

	test("a bogus :onerror scope does not emit confident body paths", () => {
		// `:onerror [find] { … }` is not a scope; the body must NOT resolve.
		const { statements } = resolveStatements(
			":onerror [find] { /ip route add }",
		);
		expect(statements.map((s) => s.path)).not.toContain("/ip/route/add");
	});
});

describe("Q17 over-depth — bounded traversal abstains instead of overflowing", () => {
	test("deeply nested substitutions do not overflow the stack", () => {
		const deep = `${"[".repeat(32768)}find${"]".repeat(32768)}`;
		let result: ReturnType<typeof resolveDocument> | undefined;
		expect(() => {
			result = resolveDocument(deep);
		}).not.toThrow();
		expect(result?.defects.map((d) => d.code)).toContain("over-depth");
	});

	test("deeply nested scope blocks do not overflow the stack", () => {
		const deep = `${"do={".repeat(2048)}:put 1${"}".repeat(2048)}`;
		let result: ReturnType<typeof resolveStatements> | undefined;
		expect(() => {
			result = resolveStatements(deep);
		}).not.toThrow();
		expect(result?.defects.map((d) => d.code)).toContain("over-depth");
	});
});

test("never throws on adversarial input", () => {
	const nasty = [
		"",
		"[",
		"[[[",
		"remove [",
		"/ip route remove [find",
		"$[",
		'/x "$[',
		":foreach x in=[find] do={",
	];
	for (const input of nasty) {
		expect(() => resolveDocument(input)).not.toThrow();
		expect(() => resolveStatements(input)).not.toThrow();
	}
});

/**
 * Q14 C3b — the cascade (#192). A defect does not only ruin its own statement,
 * it destroys the DOCUMENT CONTEXT, and every later statement that CONSUMES that
 * context must degrade with it. Measured over the frozen phase-0 corpus: 43
 * statements stop reporting a confident path, every one of them an out-of-domain
 * prose paste that was manufacturing a phantom root command (`/OK`, `/Binary`,
 * `/Calls/made/by/this`), and `containsWrite` abstention does not move at all
 * (44.8% dev / 46.0% holdout, unchanged).
 */
describe("Q14 C3b — a lost context poisons dependent statements", () => {
	const LOST = "context lost to an earlier unreadable statement";

	test("the reported cascade: a relative statement after a defect abstains", () => {
		// The exact repro that pulled `resolveVerbs` from #193: the second line was
		// resolving to a confident `/add` against a context already admitted lost.
		const res = resolveStatements("/ip) address\nadd address=1.2.3.4/24");
		expect(res.statements[0]?.unresolved).toBe(
			"structural defect: unbalanced delimiter or string",
		);
		expect(res.statements[1]?.path).toBeNull();
		expect(res.statements[1]?.unresolved).toBe(LOST);
		expect(res.statements[1]?.contextCertain).toBe(false);
	});

	test("a context-NEUTRAL unresolved statement does not poison", () => {
		// The over-fire a crude taint would produce. A dynamic head evaluates a
		// value; it does not navigate, so `add` keeps its context.
		const res = resolveStatements(
			"/ip route\n$dyn\nadd dst-address=0.0.0.0/0",
		).statements;
		expect(res[1]?.unresolved).toBe("dynamic or substitution-headed statement");
		expect(res[2]?.path).toBe("/ip/route/add");
		expect(res[2]?.contextCertain).toBe(true);
	});

	test("an unknown relative bare path poisons every following relative statement (#235)", () => {
		const res = resolveStatements(
			"/ip\nnonexistent\naddress\nprint",
		).statements;
		expect(res[1]?.path).toBe("/ip/nonexistent");
		expect(res[1]?.contextCertain).toBe(true);
		// A known relative menu still consumes the lost context; it cannot revive
		// certainty from the stale `/ip` value.
		expect(res[2]).toMatchObject({
			isNav: true,
			path: null,
			unresolved: LOST,
			contextCertain: false,
		});
		expect(res[3]).toMatchObject({
			path: null,
			unresolved: LOST,
			contextCertain: false,
		});
	});

	test("context-INDEPENDENT statements keep resolving while context is lost", () => {
		const res = resolveStatements(
			"/ip) address\n/ip/route/add gateway=1.1.1.1\n:global x 1",
		).statements;
		expect(res[1]?.path).toBe("/ip/route/add");
		expect(res[2]?.path).toBe("/global");
		// The context they ignore is still flagged as unknown.
		expect(res[1]?.contextCertain).toBe(false);
		expect(res[2]?.contextCertain).toBe(false);
	});

	test("an absolute navigation re-establishes certainty (R4 replaces)", () => {
		const res = resolveStatements(
			"/ip) address\nadd address=1.1.1.1\n/ip route\nadd gateway=2.2.2.2",
		).statements;
		expect(res[1]?.unresolved).toBe(LOST);
		expect(res[3]?.path).toBe("/ip/route/add");
		expect(res[3]?.contextCertain).toBe(true);
	});

	test("a bare `/` also re-establishes certainty", () => {
		const res = resolveStatements("/ip) address\n/\n:put 1").statements;
		expect(res[1]?.path).toBe("/");
		expect(res[2]?.contextCertain).toBe(true);
	});

	test("`..` cannot be read against a lost context", () => {
		const res = resolveStatements("/ip) address\n..").statements;
		expect(res[1]?.isNav).toBe(true);
		expect(res[1]?.path).toBeNull();
		expect(res[1]?.unresolved).toBe(LOST);
	});

	test("an unreadable `/`-led statement poisons — it may have been a nav", () => {
		// `/ip/$menu` is a navigation to a computed menu exactly as plausibly as it
		// is a command, so what the context is afterwards is unknown.
		const res = resolveStatements("/ip/$menu\nadd address=1.1.1.1").statements;
		expect(res[0]?.unresolved).toBeDefined();
		expect(res[1]?.unresolved).toBe(LOST);
	});

	test("a statement that refuses on its own terms keeps its own reason", () => {
		const res = resolveStatements("/ip) address\n$x\n[find]").statements;
		expect(res[1]?.unresolved).toBe("dynamic or substitution-headed statement");
		expect(res[2]?.unresolved).toBe("dynamic or substitution-headed statement");
	});

	test("a block body inherits the certainty in force where it appears", () => {
		const lost = resolveStatements(
			"/ip) address\n:foreach i in=[find] do={ remove $i }",
		).statements;
		expect(lost.at(-1)?.unresolved).toBe(LOST);
		// An absolute statement hands its body a ROOT-based context, which is
		// knowable however lost the document context is.
		const kept = resolveStatements(
			"/ip) address\n/ip/route { add gateway=1.1.1.1 }",
		).statements;
		expect(kept.at(-1)?.path).toBe("/ip/route/add");
	});

	test("the bracket walk applies the same contract (lockstep)", () => {
		// A relative `[find]` re-constitutes against the statement's menu, so it
		// cannot be resolved once that menu is unknown.
		const lost = resolveDocument("/ip) address\nremove [find default=yes]");
		expect(lost.resolutions[0]?.path).toBeNull();
		expect(lost.resolutions[0]?.unresolved).toBe(LOST);
		expect(lost.resolutions[0]?.contextCertain).toBe(false);
		// An ABSOLUTE inner path ignores the context and still resolves — but the
		// context it ignored is still reported as unknown, the bracket half of the
		// same contract the statement walk asserts above.
		const kept = resolveDocument("/ip) address\n:put [/ip/route/print]");
		expect(kept.resolutions[0]?.path).toBe("/ip/route");
		expect(kept.resolutions[0]?.contextCertain).toBe(false);
	});

	test("R6 — a nested bracket inherits its enclosing bracket's known base", () => {
		// The enclosing inner command is ABSOLUTE, so it is anchored whatever the
		// document context did. Propagating the document's uncertainty into it
		// would abstain on a bracket that is in fact fully determined.
		const res = resolveDocument(
			"/ip) address\n:put [/ip/route/get [find default=yes] gateway]",
		).resolutions;
		expect(res[0]?.path).toBe("/ip/route");
		expect(res[1]?.depth).toBe(1);
		expect(res[1]?.path).toBe("/ip/route");
		expect(res[1]?.contextCertain).toBe(true);
	});

	test("a RELATIVE enclosing bracket still poisons what nests inside it", () => {
		// The other direction of the same rule: the outer bracket resolved to
		// nothing, so the inner one has no base to inherit.
		for (const text of [
			"/ip) address\nremove [find [get 0 comment]]",
			"/ip) address\n:put [$var [find]]",
		]) {
			const res = resolveDocument(text).resolutions;
			expect(res[1]?.path).toBeNull();
			expect(res[1]?.unresolved).toBe(LOST);
		}
	});

	test("an unreadable absolute statement anchors NOTHING (R7)", () => {
		// `/ip/$menu/remove` is `/`-led, so its base does not depend on the document
		// context — but R7 leaves its own path unresolved, and `statementPath`
		// still derives `/ip/$menu` from it. Anchoring the bracket to that reports
		// `[find]` at a "path" holding a literal `$menu`, while `resolveStatements`
		// refuses the very same statement.
		const doc = resolveDocument("/ip/$menu/remove [find]");
		expect(doc.resolutions[0]?.path).toBeNull();
		expect(doc.resolutions[0]?.unresolved).toBe(LOST);
		expect(doc.resolutions[0]?.contextCertain).toBe(false);
		expect(
			resolveStatements("/ip/$menu/remove [find]").statements[0]?.path,
		).toBeNull();
	});

	test("a nested bracket needs its ENCLOSING bracket to resolve, not the document", () => {
		// Deliberately a CLEAN document: the context is perfectly known, and that
		// must not rescue a nested bracket whose enclosing bracket has no path.
		// `nestedCtx` falls back to the statement context, which is exactly the
		// unrelated base this must refuse — `[find]` never sat at `/ip/route`.
		const res = resolveDocument(
			"/ip route\nremove [/interface/$type/get [find]]",
		).resolutions;
		expect(res[0]?.unresolved).toBe("variable path segment");
		expect(res[1]?.depth).toBe(1);
		expect(res[1]?.path).toBeNull();
		expect(res[1]?.unresolved).toBe(LOST);
		// An ABSOLUTE nested command still resolves on its own terms.
		const absolute = resolveDocument(
			"/ip route\nremove [/interface/$type/get [/ip/route/print]]",
		).resolutions;
		expect(absolute[1]?.path).toBe("/ip/route");
	});

	test("an enclosing bracket that is not a MENU at all still lets the ambient context govern", () => {
		// The other half of the rule above, and the reason it is not simply "the
		// enclosing bracket must resolve". A user function establishes no menu, so
		// its arguments evaluate at the ambient context — here `/log`. Grounded in
		// the corpus (rextended/topic-166898): refusing this shape too throws away
		// 12 further correct bracket paths and moves a document's write verdict.
		const res = resolveDocument(
			'/log\n:set msg "$msg$[$formatDate [get $item time]] x"',
		).resolutions;
		expect(res[0]?.path).toBeNull();
		expect(res[1]?.depth).toBe(1);
		expect(res[1]?.path).toBe("/log");
		expect(res[1]?.contextCertain).toBe(true);
	});

	test("a variable segment after a STATIC word is still unreadable (R7)", () => {
		// Mixed space/slash menu spelling is supported, so `/ip route/$menu/remove`
		// is the same R7 case as `/ip/$menu/remove`. `statementRun` drops the whole
		// word carrying the variable, which left a clean truncated prefix and a
		// confident `/ip`. Statement, bracket and cascade are all pinned here.
		const text = "/ip route/$menu/remove [find]\nadd address=1.1.1.1";
		const stmts = resolveStatements(text).statements;
		expect(stmts[0]?.path).toBeNull();
		expect(stmts[0]?.unresolved).toBe("variable path segment");
		expect(stmts[1]?.path).toBeNull();
		expect(stmts[1]?.unresolved).toBe(LOST);
		const brackets = resolveDocument(text).resolutions;
		expect(brackets[0]?.path).toBeNull();
		expect(brackets[0]?.unresolved).toBe(LOST);
	});

	test("an unreadable RELATIVE menu poisons its nested brackets too", () => {
		// Spelling is not what makes a menu unreadable: `[route/$verb [find]]` is
		// the same case as the absolute `[/interface/$type/get [find]]`.
		const res = resolveDocument(
			"/ip route\nremove [route/$verb [find]]",
		).resolutions;
		expect(res[0]?.unresolved).toBe("variable path segment");
		expect(res[1]?.depth).toBe(1);
		expect(res[1]?.path).toBeNull();
		expect(res[1]?.unresolved).toBe(LOST);
	});

	test("a `$` inside an ARGUMENT does not make the menu unreadable", () => {
		// The counterweight to the two cases above, and a real corpus shape: a `~`
		// filter means no `=` ends the run, so a naive "any `$` in the leading
		// words" test reads these as unreadable menus and throws away two correct
		// paths. Only a whole path SEGMENT that is a variable counts.
		expect(
			resolveStatements('/ppp secret print where comment~"\\$SECRET"')
				.statements[0]?.path,
		).toBe("/ppp/secret/print/where");
		expect(
			resolveStatements('print where comment~[$strfind ("abc")]').statements[0]
				?.path,
		).toBe("/print/where");
		// A `$` word standing alone is a positional operand, not a path segment —
		// so it ENDS the run (hence `/log/get`, not `/log/get/time`) rather than
		// making the menu unreadable.
		expect(resolveStatements("/log\nget $item time").statements[1]?.path).toBe(
			"/log/get",
		);
	});

	test("EVERY `$`-headed segment is unreadable, valid spelling or not", () => {
		// The predicate makes no claim about which spellings RouterOS accepts. Two
		// of these are real references (`$menu`, `$"menu"`); the braced form is
		// rejected by the device itself (at the `{`, on 7.24rc1) and a bare `$`
		// names nothing. Offline can resolve NEITHER kind, so both must abstain —
		// a guard that decides whether to ABSTAIN has to match the general shape,
		// since an unlisted one reads as a readable menu and fails OPEN.
		// The braced form is assembled rather than written literally: as a plain
		// string it reads to the linter as a stray JS template placeholder.
		const braced = `$${"{menu}"}`;
		for (const segment of ["$menu", '$"menu"', braced, "$"]) {
			const text = `/ip route/${segment}/remove [find]\nadd address=1.1.1.1`;
			const stmts = resolveStatements(text).statements;
			expect(stmts[0]?.unresolved).toBe("variable path segment");
			expect(stmts[1]?.unresolved).toBe(LOST);
			expect(resolveDocument(text).resolutions[0]?.unresolved).toBe(LOST);
			// …and the relative spelling of the same segment, nested.
			const nested = resolveDocument(
				`/ip route\nremove [route/${segment} [find]]`,
			).resolutions;
			expect(nested[0]?.unresolved).toBe("variable path segment");
			expect(nested[1]?.path).toBeNull();
			expect(nested[1]?.unresolved).toBe(LOST);
		}
	});

	test("a clean document is entirely certain", () => {
		const res = resolveStatements(
			"/ip route\nadd gateway=1.1.1.1\n/ip firewall filter\nprint",
		).statements;
		expect(res.every((s) => s.contextCertain)).toBe(true);
		expect(res.some((s) => s.unresolved !== undefined)).toBe(false);
	});
});

/**
 * R9 (#211 B1) — the two promoted modules may not answer the same statement
 * differently. `pathresolve` used to call every `/`-led bare path navigation, so
 * `/ip address print` was a navigation to the non-existent `/ip/address/print`
 * while `verbsplit` read the identical text as verb `print` at `/ip/address`:
 * 34 dev / 13 holdout statements on the frozen partition, `verbsplit` right in
 * every one. The seam is closed by both modules consulting one `VERBS` object,
 * so what is pinned here is the PROPERTY, not the sample.
 */
describe("R9 — pathresolve and verbsplit cannot contradict each other", () => {
	test("a statement verbsplit RESOLVES to a verb is never navigation", () => {
		const texts = [
			"/ip address print",
			"/ip/address/print",
			"/system device-mode print",
			"/routing route print detail",
			"/app disable myapp",
			"/disk print detail",
			"/interface lte export",
			"/ip hotspot user remove a",
			"/ip cloud back-to-home-file print",
		];
		for (const text of texts) {
			const split = resolveVerbs(text).splits[0];
			const stmt = resolveStatements(text).statements[0];
			expect(split?.resolution).toBe("resolved");
			expect(stmt?.isNav).toBe(false);
			// …and the two agree on where the menu ends: pathresolve's `path` is the
			// greedy menu-AND-verb reading, so the split's menu is one of its
			// candidates, and the verb is the segment that follows it.
			expect(stmt?.candidates).toContain(split?.path as string);
		}
	});

	test("a statement verbsplit calls NAVIGATION is navigation here too", () => {
		for (const text of ["/ip address", "/system script", "/interface bridge"]) {
			expect(resolveVerbs(text).splits[0]?.resolution).toBe("navigation");
			expect(resolveStatements(text).statements[0]?.isNav).toBe(true);
		}
	});

	test("…including a RELATIVE one, in either spelling (#235)", () => {
		// The seam #235 re-opened: `verbsplit` reads a relative bare run through
		// its candidate list, so `firewall filter` under `/ip` was navigation
		// there while `pathresolve` — reading only the single-word spelling —
		// called it a command and resolved the NEXT statement against a stale
		// `/ip`. Both spellings are one navigation on the device, so both modules
		// have to say so. Asserted through the DOCUMENT walk, because the context
		// is what the disagreement was actually about.
		for (const [text, path] of [
			["firewall filter", "/ip/firewall/filter"],
			["firewall/filter", "/ip/firewall/filter"],
			["address", "/ip/address"],
		] as const) {
			const doc = `/ip\n${text}\nadd chain=input`;
			const [, split] = resolveVerbs(doc).splits;
			const [, stmt, next] = resolveStatements(doc).statements;
			expect(split?.resolution).toBe("navigation");
			expect(split?.path).toBe(path);
			expect(stmt?.isNav).toBe(true);
			expect(stmt?.path).toBe(path);
			expect(next?.path).toBe(`${path}/add`);
		}
	});

	test("no known menu in either generated table carries a verb segment", () => {
		// R9's premise, stated at the scope it is actually checked. If a menu were
		// named `.../print`, R9 would refuse to navigate into it. Asserted over the
		// two generated sources #235 now reads, so a regeneration that introduced
		// one fails here. Both are floors, so this says nothing about unlisted menus.
		const catalogMenus = [...PATH_CATALOG]
			.filter(([, entry]) => entry.kind === "menu" || entry.kind === "settings")
			.map(([path]) => path);
		const knownMenus = new Set([...MENU_PATHS, ...catalogMenus]);
		const offenders = [...knownMenus].filter((path) =>
			path
				.split("/")
				.filter(Boolean)
				.some((segment) => VERBS.has(segment)),
		);
		expect(offenders).toEqual([]);
	});

	test("R12's premise — no known menu is also a published command", () => {
		// R12 refuses navigation into a path the catalog calls a command. That is
		// only safe while the two tables are DISJOINT on that question: a path in
		// both would be refused as navigation despite `MENU_PATHS` carrying it.
		// Asserted over both menu sources now read by #235, so a regeneration that
		// introduced an overlap fails rather than silently changing navigation.
		const catalogMenus = [...PATH_CATALOG]
			.filter(([, entry]) => entry.kind === "menu" || entry.kind === "settings")
			.map(([path]) => path);
		const overlap = [...new Set([...MENU_PATHS, ...catalogMenus])].filter(
			(path) => commandVerbIndex(path.split("/").filter(Boolean)) !== null,
		);
		expect(overlap).toEqual([]);
	});

	test("the verb lookup is the SAME object on both sides of the seam", () => {
		// Two copies of the vocabulary could drift apart and re-open the seam, so
		// `verbs.ts` is a shared leaf and `verbsplit` merely re-exports it.
		expect(centrs.VERBS).toBe(VERBS);
	});

	test("R12 (#228) closes #211 B2 for a PUBLISHED verb-free bare path", () => {
		// This was the pinned KNOWN LIMIT: `reboot` is not in the frozen
		// vocabulary, so R9 could not reach it, and refusing it from `MENU_PATHS`
		// being silent would have inverted the floor contract. The command axis
		// says what the silence could not, and both modules now agree.
		const stmts = resolveStatements(
			"/ip route\n/system reboot\nadd x=1",
		).statements;
		expect(stmts[1]?.isNav).toBe(false);
		expect(resolveVerbs("/system reboot").splits[0]?.resolution).toBe(
			"resolved",
		);
		expect(stmts[2]?.path).toBe("/ip/route/add");
	});

	test("KNOWN LIMIT — a verb-free bare path NEITHER table knows is still navigation", () => {
		// What is left of #211 B2. `/terminal/cuu` is a real no-argument command
		// published nowhere, so offline still claims navigation into a menu that
		// does not exist and cascades. Pinned so the residue stays visible rather
		// than being assumed closed by R12: the tables are floors in both
		// directions, and neither absence is evidence.
		const stmts = resolveStatements(
			"/ip route\n/terminal cuu\nadd x=1",
		).statements;
		expect(stmts[1]?.isNav).toBe(true);
		expect(resolveVerbs("/terminal cuu").splits[0]?.resolution).toBe(
			"ambiguous",
		);
		expect(stmts[2]?.path).toBe("/terminal/cuu/add");
	});
});

test("path-resolution API is re-exported from the library barrel", () => {
	expect(centrs.resolveDocument).toBe(resolveDocument);
	expect(centrs.resolveStatements).toBe(resolveStatements);
});
