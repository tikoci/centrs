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
 * arm is promoted — the six A/B arms that priced it stayed in the lab. It sits
 * on the Q4 resolver (`resolveStatements`, #191) for persistent menu context.
 *
 * The `cases` corners assert one statement's split under `/` context; the
 * `contextual` corners assert the per-statement splits across a document, so a
 * relative command's inherited context is exercised. The flagship result is the
 * ratified **`ambiguous`** verdict: a statement that is nothing but a bare menu
 * path (`/ip/address` vs `/system/reboot`) refuses rather than guessing (V4).
 */

interface Case {
	name: string;
	input: string;
	context?: string;
	resolution: "resolved" | "ambiguous" | "unknown";
	path?: string;
	verb?: string;
	verbAt?: number;
	truth?: string;
	rule: string;
}

interface ContextualCase {
	name: string;
	input: string;
	expect: {
		resolution: "resolved" | "ambiguous" | "unknown";
		path?: string;
		verb?: string;
		verbAt?: number;
	}[];
	rule: string;
}

const fixtures: {
	cases: Case[];
	branches: Case[];
	contextual: ContextualCase[];
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

describe("Q6 persistent context across statements (resolveVerbs)", () => {
	for (const c of fixtures.contextual) {
		test(c.name, () => {
			const { splits } = resolveVerbs(c.input);
			expect(splits.map((s) => s.resolution)).toEqual(
				c.expect.map((e) => e.resolution),
			);
			for (const [i, e] of c.expect.entries()) {
				if (e.resolution !== "resolved") continue;
				expect(splits[i]?.path).toBe(e.path ?? null);
				expect(splits[i]?.verb).toBe(e.verb ?? null);
				expect(splits[i]?.verbAt).toBe(e.verbAt ?? null);
			}
		});
	}
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

describe("robustness invariants", () => {
	test("an ambiguous bare path still exposes both path readings as candidates", () => {
		// `/ip/address` decides nothing, but a consumer must be able to offer the
		// menu-vs-command readings rather than a coin flip.
		const got = resolveVerb("/ip/address", "/");
		expect(got.resolution).toBe("ambiguous");
		expect(got.candidates).toEqual(["/ip", "/ip/address"]);
	});

	test("resolveVerbs agrees with resolveVerb on each statement's context", () => {
		// The document walk must not diverge from the single-statement entry point.
		const doc = "/ip firewall filter\nadd chain=input\nprint";
		const { statements } = resolveStatements(doc);
		const { splits } = resolveVerbs(doc);
		expect(splits.length).toBe(statements.length);
		for (const [i, s] of statements.entries()) {
			const direct = s.unresolved
				? "unknown"
				: resolveVerb(s.text, s.context).resolution;
			expect(splits[i]?.resolution).toBe(direct);
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

test("Q14 fail-closed — a resolver-refused statement stays unknown", () => {
	// `:if [) do={ /ip route add }` is malformed; resolveStatements refuses it,
	// and the verb layer must not manufacture a confident command from it.
	const { splits } = resolveVerbs(":if [) do={ /ip route add }");
	for (const s of splits) {
		expect(s.resolution).not.toBe("resolved");
		expect(s.verb).not.toBe("add");
	}
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
		expect(() => resolveVerbs(input)).not.toThrow();
	}
});

test("verb/menu API is re-exported from the library barrel", () => {
	expect(centrs.resolveVerb).toBe(resolveVerb);
	expect(centrs.resolveVerbs).toBe(resolveVerbs);
});
