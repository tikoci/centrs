import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveStatements } from "../../src/explain/pathresolve.ts";
import {
	describeStatement,
	locatedRunTokens,
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

	test("located tokens preserve slash and continuation source ranges", () => {
		expect(locatedRunTokens("/ip/route add")).toEqual([
			{
				name: "ip",
				sep: "start",
				nameSpans: [{ start: 1, end: 3 }],
				slashBefore: { start: 0, end: 1 },
			},
			{
				name: "route",
				sep: "slash",
				nameSpans: [{ start: 4, end: 9 }],
				slashBefore: { start: 3, end: 4 },
			},
			{
				name: "add",
				sep: "space",
				nameSpans: [{ start: 10, end: 13 }],
			},
		]);
		// cspell:disable-next-line -- intentional mid-word continuation fragment
		expect(locatedRunTokens("/ip/rou\\\nte add")[1]?.nameSpans).toEqual([
			{ start: 4, end: 7 },
			{ start: 9, end: 11 },
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
		// #228 step 2 gave the twin its other half: the same table lookup that
		// confirms `/ip/address` is a menu now confirms `/system/reboot` is a
		// published command. Both twins are decided; neither is guessed.
		expect(resolveVerb("/system/reboot", "/")).toMatchObject({
			resolution: "resolved",
			kind: "command",
			path: "/system",
			verb: "reboot",
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

	test("a path NEITHER table carries stays ambiguous (both are FLOORS)", () => {
		// This list used to be seven genuine no-argument COMMANDS drawn from the
		// corpus-dev residual `menus.ts` alone leaves behind. #228 step 2 decided
		// six of them from the published command axis; what is left is the honest
		// residual of BOTH tables, and absence is still not evidence either way.
		//
		//   `/terminal/cuu`               console-internal, published nowhere
		//   `/disk/format-drive`          in neither source — 7.23.2 spells it
		//                                 `/disk format` (#207's corpus example)
		//   `/system/script run myscript` the Q6 KNOWN LIMIT: the positional
		//                                 operand joins the run, and no table
		//                                 carries the result
		for (const command of [
			"/terminal/cuu",
			"/disk/format-drive",
			"/system/script run myscript",
		])
			expect(resolveVerb(command, "/").resolution).toBe("ambiguous");
	});

	test("#228 — the command axis decides the other half of V4", () => {
		// The six the menu table alone could not reach. Each names its own verb,
		// so the menu is the prefix and there is nothing left to guess.
		for (const [command, path, verb] of [
			["/system/reboot", "/system", "reboot"],
			["/quit", "/", "quit"],
			["/container/start", "/container", "start"],
			["/tool/speed-test", "/tool", "speed-test"],
			["/system/routerboard/upgrade", "/system/routerboard", "upgrade"],
			[
				"/certificate/create-certificate-request",
				"/certificate",
				"create-certificate-request",
			],
		] as const)
			expect(resolveVerb(command, "/")).toMatchObject({
				resolution: "resolved",
				kind: "command",
				path,
				verb,
			});
	});

	test("#228 — a published command outranks the punctuation guess", () => {
		// The punctuation rule reads the first SPACE token as the verb, which puts
		// it on the operand whenever the command itself was written slash-joined.
		// The publication names the command, so the operand goes back to being an
		// argument — and `argsAt` moves with it, which is what a caller lexing the
		// argument list actually consumes.
		const text = "/system/gps/monitor once";
		const split = resolveVerb(text, "/");
		expect(split).toMatchObject({
			resolution: "resolved",
			path: "/system/gps",
			verb: "monitor",
			// The whole point of moving the boundary: the operand is now INSIDE the
			// argument list. Asserted as the slice a caller would actually lex, so a
			// regression that restored `once` as the verb fails on the contract
			// rather than on a magic number.
			argsAt: 19,
			why: "published command `/system/gps/monitor`",
		});
		expect(text.slice(split.argsAt as number).trim()).toBe("once");
		expect(
			resolveVerb("/interface/lte/at-chat lte1 input=x", "/"),
		).toMatchObject({ path: "/interface/lte", verb: "at-chat" });
	});

	test("#228 — an inherited context can rescue a bare-word head; the root cannot", () => {
		// `stop [find …]` under `/container` is a published command and resolves.
		expect(resolveVerb("stop [find tag~$t]", "/container")).toMatchObject({
			resolution: "resolved",
			path: "/container",
			verb: "stop",
		});
		// At the root there is no context to supply the evidence, and the seven
		// root-level catalog commands are ordinary English words. The corpus's
		// pasted Python must not read as RouterOS `/import`.
		for (const text of ["import serial", "quit", "beep"])
			expect(resolveVerb(text, "/")).toMatchObject({
				resolution: "unknown",
				why: "bare-word head is not a known verb",
			});
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

	test("a relative bare path that joins to a known menu is navigation (#235)", () => {
		// R13 lifts R8 where the tables know: `address` under `/ip` → `/ip/address`
		// is a known menu, so the relative bare word is navigation rather than a
		// refusal. A word whose join is in neither table stays `unknown`.
		expect(resolveVerb("address", "/ip")).toMatchObject({
			resolution: "navigation",
			kind: "menu",
			path: "/ip/address",
		});
		expect(resolveVerb("filter", "/ip/firewall")).toMatchObject({
			resolution: "navigation",
			kind: "menu",
			path: "/ip/firewall/filter",
		});
		// `/interface/ethernet/poe` is published-only, so this also pins the
		// catalog kind half of #235 rather than passing only through MENU_PATHS.
		expect(resolveVerb("poe", "/interface/ethernet")).toMatchObject({
			resolution: "navigation",
			kind: "menu",
			path: "/interface/ethernet/poe",
		});
		// A run, not just a word: the device treats whitespace and `/` alike, so
		// both spellings are the same navigation and `pathresolve` agrees on both
		// (CHR 7.24rc1 `:parse` IL, pinned in `pathresolve.json`).
		for (const text of ["firewall filter", "firewall/filter"])
			expect(resolveVerb(text, "/ip")).toMatchObject({
				resolution: "navigation",
				kind: "menu",
				path: "/ip/firewall/filter",
			});
		// The verb guard still wins over the lift: this is `print` at
		// `/ip/address`, not navigation into a menu named `print`.
		expect(resolveVerb("address print", "/ip")).toMatchObject({
			resolution: "resolved",
			kind: "command",
			path: "/ip/address",
			verb: "print",
		});
		expect(resolveVerb("nonexistent", "/ip")).toMatchObject({
			resolution: "unknown",
			why: "bare-word head is not a known verb",
		});
	});

	test("an absolute bare path reads the catalog menu axis too (#235)", () => {
		// #210 answered V4's bare path from `MENU_PATHS` alone, so a published-only
		// container was `ambiguous`. #235 unions the catalog's menu/settings kind
		// into the same lookup, and it applies to the absolute spelling as well —
		// the union is one helper, deliberately not one rule per statement shape.
		//
		// A CHR without PoE hardware answers `bad command name poe`, which is the
		// published applicability GATE working as documented, not a wrong reading:
		// the catalog says MikroTik publishes the menu, never that this router has
		// it. Offline naming the menu is what lets the gate explain the absence.
		for (const text of ["/interface/ethernet/poe", "/interface ethernet poe"])
			expect(resolveVerb(text, "/")).toMatchObject({
				resolution: "navigation",
				kind: "menu",
				path: "/interface/ethernet/poe",
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
		const command = resolveVerb("/system/reboot", "/");
		expect(command.resolution).toBe("resolved");
		expect(command.candidates).toEqual(["/system", "/system/reboot"]);
		// And the third arm, where neither table reaches: candidates are still the
		// whole ladder, because a refusal is the case a consumer most needs them.
		const ambiguous = resolveVerb("/disk/format-drive", "/");
		expect(ambiguous.resolution).toBe("ambiguous");
		expect(ambiguous.candidates).toEqual(["/disk", "/disk/format-drive"]);
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

	test("a correct split after a lost context still says the context was lost", () => {
		// #192's third bullet. The cascade FIX shipped in #197 — every
		// context-DEPENDENT statement after a defect degrades — but a
		// context-INDEPENDENT one keeps resolving, correctly, and the walker used
		// to drop the resolver's certainty flag on the way out. So this document
		// reported a clean `resolved` with no trace that the document had lost its
		// place.
		const { splits } = resolveVerbs("/ip) address\n/ip route print");
		expect(splits.map((s) => s.resolution)).toEqual(["unknown", "resolved"]);
		// The second split is RIGHT — `/ip route print` is absolute, so it never
		// consumed the context — and it is reported alongside the fact that the
		// context was gone.
		expect(splits[1]?.path).toBe("/ip/route");
		expect(splits.map((s) => s.contextCertain)).toEqual([true, false]);
	});

	test("contextCertain tracks the resolver statement for statement", () => {
		// Not re-derived here: whatever the resolver decided is what the walker
		// carries, so the two can never drift apart.
		for (const text of [
			"/ip route\nprint",
			"/ip) address\nadd address=1.1.1.1\n/ip/route/add gateway=2.2.2.2",
			"/ip/$menu\n:put 1",
			":if [) do={ /ip route add }\n/ip address print",
		]) {
			const { splits } = resolveVerbs(text);
			const { statements } = resolveStatements(text);
			expect(splits.map((s) => s.contextCertain)).toEqual(
				statements.map((s) => s.contextCertain),
			);
		}
	});

	test("the single-statement entry point carries no certainty claim", () => {
		// `resolveVerb` is handed its context, so it has nothing to say about
		// whether that context was knowable — and the type must not let a caller
		// read silence as `true`.
		expect("contextCertain" in resolveVerb("/ip route print", "/")).toBe(false);
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
	}, 30_000);
});

test("verb/menu API is re-exported from the library barrel", () => {
	expect(centrs.resolveVerb).toBe(resolveVerb);
	expect(centrs.resolveVerbs).toBe(resolveVerbs);
});
