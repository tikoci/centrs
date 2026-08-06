import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveStatements } from "../../src/explain/pathresolve.ts";
import {
	describeStatement,
	resolveVerb,
	resolveVerbs,
	runTokens,
	SUBMENU_DIRECTIVES,
	splitRun,
	VERBS,
} from "../../src/explain/verbsplit.ts";
import * as centrs from "../../src/index.ts";

/**
 * Q6 verb/menu boundary anchor tests (phase 0.5, #185/#186).
 *
 * Promoted from the throwaway lab probe `.scratch/explain-lab-verbsplit.ts` (the
 * SUT) and its constructed corners `.scratch/explain-lab-q6-corners.ts` (each
 * cross-checked against the device command tree as oracle). The production
 * module is `src/explain/verbsplit.ts`; only the ratified `proposed` boundary
 * arm is promoted — the six A/B arms that priced it stayed in the lab.
 *
 * These exercise the SINGLE-STATEMENT boundary (`resolveVerb(text, context)`) —
 * the Q6 question. Cases carry an explicit menu `context`; the document-scale
 * walker and its fail-closed context taint are the Q14 slice (#192), not here.
 * The flagship result is the ratified **`ambiguous`** verdict: a statement that
 * is nothing but a bare menu path (`/ip/address` vs `/system/reboot`) refuses
 * rather than guessing (V4).
 */

interface Case {
	name: string;
	input: string;
	context?: string;
	resolution: "resolved" | "navigation" | "ambiguous" | "unknown";
	path?: string;
	verb?: string;
	verbAt?: number;
	truth?: string;
	rule: string;
}

const fixtures: {
	cases: Case[];
	branches: Case[];
	contextual: Case[];
} = JSON.parse(
	readFileSync(
		new URL("../fixtures/explain/verbsplit.json", import.meta.url),
		"utf8",
	),
);

/** Every single-statement corner asserts the full split, decided or refused. */
function assertCorner(c: Case): void {
	const got = resolveVerb(c.input, c.context ?? "/");
	expect(got.resolution).toBe(c.resolution);
	// The fixture `rule` is the exact provenance string — lock it against drift.
	expect(got.why).toBe(c.rule);
	if (c.resolution === "resolved") {
		expect(got.kind).toBe("command");
		expect(got.path).toBe(c.path ?? null);
		expect(got.verb).toBe(c.verb ?? null);
		expect(got.verbAt).toBe(c.verbAt ?? null);
	} else if (c.resolution === "navigation") {
		// A navigation statement names a menu and no verb — so it carries a path,
		// but nothing that could be read as a command (#210).
		expect(got.kind).toBe("menu");
		expect(got.path).toBe(c.path ?? null);
		expect(got.verb).toBeNull();
		expect(got.verbAt).toBeNull();
	} else {
		// ambiguous and unknown decide nothing — no menu, no verb, no index.
		expect(got.kind).toBeNull();
		expect(got.path).toBeNull();
		expect(got.verb).toBeNull();
		expect(got.verbAt).toBeNull();
	}
}

describe("Q6 verb/menu boundary corners (resolveVerb — oracle-checked)", () => {
	for (const c of fixtures.cases) test(c.name, () => assertCorner(c));
});

describe("Q6 ratified-branch anchors (resolveVerb — offline behavior)", () => {
	for (const c of fixtures.branches) test(c.name, () => assertCorner(c));
});

describe("Q6 relative statements resolve against a supplied menu context", () => {
	for (const c of fixtures.contextual) test(c.name, () => assertCorner(c));
});

describe("the ratified vocabulary is frozen (decision 3 — no schema snapshot)", () => {
	test("thirteen CRUD verbs, exactly", () => {
		expect([...VERBS].sort()).toEqual(
			[
				"add",
				"comment",
				"disable",
				"edit",
				"enable",
				"export",
				"find",
				"get",
				"move",
				"print",
				"remove",
				"set",
				"unset",
			].sort(),
		);
	});
	test("one sub-menu directive, exactly (`:log`)", () => {
		expect([...SUBMENU_DIRECTIVES]).toEqual(["log"]);
	});
});

describe("candidate invariant — a resolved menu is among the run's path readings", () => {
	for (const c of [...fixtures.cases, ...fixtures.branches]) {
		if (c.resolution !== "resolved") continue;
		test(c.name, () => {
			const got = resolveVerb(c.input, c.context ?? "/");
			// The verb sits at run index verbAt, so the menu is the reading one
			// shorter — the run prefix before the verb. verbAt 0 (a root directive)
			// has an empty menu prefix, which is the base, not a candidate entry.
			if (got.verbAt !== null && got.verbAt > 0) {
				expect(got.candidates).toContain(got.path as string);
			}
		});
	}
});

describe("run tokenizing preserves separators (V1)", () => {
	test("slash-joined vs space-separated menus expand identically but carry sep", () => {
		expect(runTokens("/ip/firewall/filter add")).toEqual([
			{ name: "ip", sep: "start" },
			{ name: "firewall", sep: "slash" },
			{ name: "filter", sep: "slash" },
			{ name: "add", sep: "space" },
		]);
		expect(runTokens("/ip firewall filter add")).toEqual([
			{ name: "ip", sep: "start" },
			{ name: "firewall", sep: "space" },
			{ name: "filter", sep: "space" },
			{ name: "add", sep: "space" },
		]);
	});

	test('V2/V3 — `=`, `[`, `"`, `$` end the run', () => {
		expect(runTokens("add chain=input").map((t) => t.name)).toEqual(["add"]);
		expect(runTokens("remove [find]").map((t) => t.name)).toEqual(["remove"]);
		expect(runTokens('print where="x"').map((t) => t.name)).toEqual(["print"]);
		expect(runTokens("$x print").map((t) => t.name)).toEqual([]);
	});

	test("LF and CRLF line continuations are removed before tokenizing", () => {
		for (const newline of ["\n", "\r\n"]) {
			expect(runTokens(`/ip/route \\${newline}add gateway=1.1.1.1`)).toEqual([
				{ name: "ip", sep: "start" },
				{ name: "route", sep: "slash" },
				{ name: "add", sep: "space" },
			]);
		}
	});

	test("a `:`-prefixed token ends the run via BARE_WORD, not as a V3 opener", () => {
		// `:` is not in RUN_TERMINATOR — a colon-led token is rejected as a path
		// segment, which ends the run just the same. RouterOS never places a bare
		// `:`-token mid-statement outside a scripting directive.
		expect(runTokens("put :next").map((t) => t.name)).toEqual(["put"]);
		expect(runTokens(":global x").map((t) => t.name)).toEqual([]);
	});
});

describe("V4 — the `whole` signal (nothing follows the run)", () => {
	test("a bare path is whole; a path with arguments is not", () => {
		expect(describeStatement("/ip/address").whole).toBe(true);
		expect(describeStatement("/ip firewall filter").whole).toBe(true);
		expect(describeStatement("/ip/address print").whole).toBe(true);
		expect(describeStatement("/ip/address add name=x").whole).toBe(false);
	});
});

describe("splitRun ordering — vocabulary beats V4", () => {
	test("a bare `print` in context resolves even though the run is whole", () => {
		const run = runTokens("print");
		expect(splitRun(run, { directive: false, whole: true })).toMatchObject({
			verbAt: 0,
			ambiguous: false,
		});
	});
	test("a bare non-verb path with no follow is ambiguous", () => {
		const run = runTokens("/ip/address");
		expect(splitRun(run, { directive: false, whole: true })).toMatchObject({
			verbAt: null,
			ambiguous: true,
		});
	});
});

/**
 * #210 — V4's bare path is the one case the ratified `proposed` rule refuses,
 * and the baked container table (`menus.ts`, #207) answers exactly that
 * question. Measured over the frozen partition and the #203 export stratum,
 * this takes Q6 abstention from 37.6–38.4% to **0.0%** on device-emitted
 * `compact`/`verbose` export, and from 4.0%/1.2% to 1.4%/0.5% on corpus
 * dev/holdout. Precision was checked against the device parser, not asserted:
 * over 1,689 IL projections the table never calls a menu what `:parse` read as
 * a command, in the whole table or in the 104 paths this rule flips.
 */
describe("#210 — the container table decides V4's bare path", () => {
	test("splitRun itself is UNCHANGED — the schema-free rule still refuses", () => {
		// The layering that keeps this change off `write.ts` and out of Q16's
		// numbers: the table is consulted in `resolveVerb`, never in `splitRun`,
		// so `proposed`'s abstention rate still prices decision 3 honestly.
		for (const menu of ["/ip/address", "/ip firewall filter", "/log"]) {
			expect(
				splitRun(runTokens(menu), { directive: false, whole: true }),
			).toMatchObject({ verbAt: null, ambiguous: true });
		}
	});

	test("the V4 twin pair is separated — the whole point of the table", () => {
		expect(resolveVerb("/ip/address", "/")).toMatchObject({
			resolution: "navigation",
			// The ratified envelope's word, not a third synonym — phase 1 renders
			// this as `resolution: "resolved", kind: "menu"`.
			kind: "menu",
			path: "/ip/address",
			verb: null,
			verbAt: null,
		});
		expect(resolveVerb("/system/reboot", "/")).toMatchObject({
			resolution: "ambiguous",
			path: null,
		});
	});

	test("both spellings of one menu reach the same verdict", () => {
		for (const text of ["/ip/firewall/filter", "/ip firewall filter"])
			expect(resolveVerb(text, "/")).toMatchObject({
				resolution: "navigation",
				path: "/ip/firewall/filter",
			});
	});

	test("the lookup is case-insensitive, like the table", () => {
		expect(resolveVerb("/IP/Address", "/").resolution).toBe("navigation");
	});

	test("a path the table does not carry stays ambiguous (it is a FLOOR)", () => {
		// Every one of these is a genuine no-argument COMMAND drawn from the
		// corpus-dev residual this rule leaves behind — the residual is the right
		// residual. Absence from the table is not evidence either way, so refusing
		// is the fail-closed answer, not a missing table entry.
		for (const command of [
			"/system/reboot",
			"/quit",
			"/container/start",
			"/tool/speed-test",
			"/system/routerboard/upgrade",
			"/certificate/create-certificate-request",
			"/terminal/cuu",
		])
			expect(resolveVerb(command, "/").resolution).toBe("ambiguous");
	});

	test("an ABBREVIATED menu stays ambiguous — the table carries full names", () => {
		// `/ip fire conn` is valid RouterOS and reaches `/ip/firewall/connection`,
		// but the table cannot confirm it, so the answer is a refusal rather than a
		// guess at which menu was meant.
		expect(resolveVerb("/ip fire conn", "/").resolution).toBe("ambiguous");
		expect(resolveVerb("/ip firewall layer7", "/").resolution).toBe(
			"ambiguous",
		);
	});

	test("the Q6 KNOWN LIMIT is preserved — a positional operand is not a menu", () => {
		// `/system/script run myscript` absorbs the operand into the run, and the
		// table does not carry the result, so this stays the documented ambiguity
		// rather than being silently decided in either direction.
		expect(resolveVerb("/system/script run myscript", "/")).toMatchObject({
			resolution: "ambiguous",
			why: "bare path, nothing follows — navigation or no-arg command?",
		});
	});

	test("a vocabulary hit still wins — the table is only consulted on a refusal", () => {
		expect(resolveVerb("/ip/address/print", "/")).toMatchObject({
			resolution: "resolved",
			kind: "command",
			path: "/ip/address",
			verb: "print",
		});
	});

	test("`kind` is DERIVED from `resolution` and cannot drift from it", () => {
		// The two fields carry the same fact in two vocabularies: `resolution` says
		// what the analyzer did, `kind` says what the statement is, and phase 1
		// renders `kind`. They can therefore never legitimately disagree — so pin
		// the mapping in both directions rather than leaving two fields free to
		// diverge, since nothing else would catch it if they did.
		const inputs = [
			"/ip/firewall/filter add chain=input",
			"/ip/address",
			"/ip firewall filter",
			"/system/reboot",
			"/system/script run myscript",
			':log info "x"',
			"print",
			"$dyn",
			"[find]",
			"",
		];
		const expected = {
			resolved: "command",
			navigation: "menu",
			ambiguous: null,
			unknown: null,
		} as const;
		for (const context of ["/", "/ip/route"])
			for (const input of inputs) {
				const got = resolveVerb(input, context);
				expect({ input, context, kind: got.kind }).toEqual({
					input,
					context,
					kind: expected[got.resolution],
				});
			}
	});

	test("a relative bare path is still `unknown`, never navigation", () => {
		// The table lookup reads the context-applied candidate, so it would be
		// correct under a non-root base — but a relative bare-word head is refused
		// before it can reach that branch, and must stay refused: `address` in
		// `/ip` is indistinguishable from a no-argument command (R8).
		expect(resolveVerb("address", "/ip")).toMatchObject({
			resolution: "unknown",
			why: "bare-word head is not a known verb",
		});
	});
});

describe("robustness invariants", () => {
	test("a bare path exposes every path reading as a candidate, decided or not", () => {
		// A consumer must be able to offer the readings rather than a coin flip —
		// and that holds whichever way the bare path lands, so both arms of #210's
		// table lookup are asserted here.
		const nav = resolveVerb("/ip/address", "/");
		expect(nav.resolution).toBe("navigation");
		expect(nav.candidates).toEqual(["/ip", "/ip/address"]);
		const ambiguous = resolveVerb("/system/reboot", "/");
		expect(ambiguous.resolution).toBe("ambiguous");
		expect(ambiguous.candidates).toEqual(["/system", "/system/reboot"]);
	});

	test("the same relative command resolves identically under any certain context", () => {
		// `add chain=input` is a verb-headed relative command; wherever context is
		// certain, it resolves to `<context>/add`, never a fabricated menu.
		for (const context of ["/ip/firewall/filter", "/interface/bridge", "/"]) {
			expect(resolveVerb("add chain=input", context)).toMatchObject({
				resolution: "resolved",
				kind: "command",
				path: context,
				verb: "add",
			});
		}
	});

	test("resolution is deterministic — identical input yields a deep-equal split", () => {
		for (const input of [
			"/ip/firewall/filter add chain=input",
			":global myvar",
			"/ip/address",
			"/system/script run [find]",
		]) {
			expect(resolveVerb(input, "/")).toEqual(resolveVerb(input, "/"));
		}
	});
});

// NOTE: malformed-statement detection (unbalanced delimiters etc.) lives in the
// Q1 segmenter / Q3-Q4 resolver, not in this single-statement boundary — a bare
// `:if [) …` is a valid directive HEAD as far as the boundary is concerned. The
// document-scale fail-closed floor (refuse the malformed statement, and taint
// following context) is the Q14 walker in #192.

test("Q14 fail-closed — bare-word garbage tails never become contextual commands", () => {
	for (const [input, context] of [
		["0 protocol-mode=none", "/interface/bridge"],
		["es # harden", "/ip/service"],
		["ghost source={ :put x }", "/system/script"],
	] as const) {
		const got = resolveVerb(input, context);
		expect(got.resolution).toBe("unknown");
		expect(got.kind).toBeNull();
		expect(got.path).toBeNull();
		expect(got.verb).toBeNull();
	}
});

test("a known CRUD verb still resolves against an explicitly supplied context", () => {
	expect(resolveVerb("add name=x", "/interface/bridge")).toMatchObject({
		resolution: "resolved",
		path: "/interface/bridge",
		verb: "add",
	});
});

test("never throws on adversarial input", () => {
	const nasty = [
		"",
		":",
		"[",
		"[[[",
		"add [",
		"/ip route remove [find",
		"$[",
		'/x "$[',
		":foreach x in=[find] do={",
		`${"do={".repeat(2048)}:put 1${"}".repeat(2048)}`,
	];
	for (const input of nasty) {
		expect(() => resolveVerb(input, "/")).not.toThrow();
		expect(() => resolveVerb(input, "/ip/route")).not.toThrow();
	}
});

/**
 * The document walker, restored in the Q14 slice (#192). It was pulled from
 * this module's own PR (#193) because it fabricated on the Q14 C3b cascade; the
 * fix landed in `resolveStatements` (the context-certainty contract), so the
 * walker here is unchanged in shape and inherits the floor.
 */
describe("resolveVerbs — document walk over the certainty contract", () => {
	test("splits every statement in source order, carrying context", () => {
		const { splits } = resolveVerbs("/ip route\nadd gateway=1.1.1.1\nprint");
		expect(splits.map((s) => s.resolution)).toEqual([
			"navigation",
			"resolved",
			"resolved",
		]);
		expect(splits[0]?.path).toBe("/ip/route");
		expect(splits[1]?.verb).toBe("add");
		expect(splits[1]?.path).toBe("/ip/route");
		expect(splits[2]?.verb).toBe("print");
	});

	test("the cascade that pulled this surface from #193 now fails closed", () => {
		const { splits } = resolveVerbs("/ip) address\nadd address=1.2.3.4/24");
		expect(splits[1]?.resolution).toBe("unknown");
		expect(splits[1]?.verb).toBeNull();
		expect(splits[1]?.path).toBeNull();
		expect(splits[1]?.why).toBe(
			"context lost to an earlier unreadable statement",
		);
	});

	test("a context-neutral dynamic head does not taint the next statement", () => {
		const { splits } = resolveVerbs(
			"/ip route\n$dyn\nadd dst-address=0.0.0.0/0",
		);
		expect(splits[1]?.resolution).toBe("unknown");
		expect(splits[2]?.resolution).toBe("resolved");
		expect(splits[2]?.verb).toBe("add");
		expect(splits[2]?.path).toBe("/ip/route");
	});

	test("no statement resolves against a context the resolver lost", () => {
		// The invariant the walker exists to hold, asserted over a mixed document
		// rather than one shape: nothing is `resolved` while its own statement was
		// refused upstream.
		const text =
			"/ip) address\nadd address=1.1.1.1\n/ip/route/add gateway=2.2.2.2\n" +
			"/ip firewall filter\nremove [find]\n..\nprint";
		const { splits } = resolveVerbs(text);
		const { statements } = resolveStatements(text);
		expect(splits.length).toBe(statements.length);
		let checked = 0;
		for (let i = 0; i < splits.length; i++)
			if (statements[i]?.unresolved !== undefined) {
				checked++;
				expect(splits[i]?.resolution).toBe("unknown");
			}
		// Without this the loop passes vacuously if the resolver ever stops
		// refusing — which is the regression the test exists to catch. Exactly two
		// statements refuse: the defect and the relative statement after it. The
		// `..` further down does NOT, because the absolute `/ip firewall filter`
		// between them re-established certainty.
		expect(checked).toBe(2);
	});

	test("structural defects propagate onto the analysis", () => {
		expect(resolveVerbs("/ip) address").defects).toContainEqual({
			code: "unbalanced-close",
			start: 3,
			end: 4,
			detail: ")",
		});
		expect(resolveVerbs("/ip route\nprint").defects).toEqual([]);
	});

	test("never throws on adversarial input", () => {
		for (const input of [
			"",
			"[",
			"/ip route remove [find",
			"$[",
			":foreach x in=[find] do={",
			`${"do={".repeat(2048)}:put 1${"}".repeat(2048)}`,
		])
			expect(() => resolveVerbs(input)).not.toThrow();
	});
});

test("verb/menu API is re-exported from the library barrel", () => {
	expect(centrs.resolveVerb).toBe(resolveVerb);
	expect(centrs.resolveVerbs).toBe(resolveVerbs);
});
