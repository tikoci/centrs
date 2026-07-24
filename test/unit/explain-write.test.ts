import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	classifyVerb,
	containsWrite,
	occurrences,
	READ_VERBS,
	ROOT_CMDS,
	ROOT_DYNAMIC,
	ROOT_WRITE,
	WRITE_VERBS,
	type WriteVerdict,
} from "../../src/explain/write.ts";
import * as centrs from "../../src/index.ts";

/**
 * Q16 write-shape anchor tests (phase 0.5, #185/#186).
 *
 * Promoted from the throwaway lab probe `.scratch/explain-lab-q16-write.ts` (the
 * SUT) and its constructed corners `.scratch/explain-lab-q16-corners.ts`, scored
 * against IL cmd nodes at every depth as oracle. The production module is
 * `src/explain/write.ts`; only the ratified `failclosed` navigation arm is
 * promoted — the two arms that priced it stayed in the lab.
 *
 * The flagship result is the ratified **tristate**: a two-valued
 * `containsWrite` is unsafe, because 56 write-shaped verb names on 7.24beta1
 * sit outside any frequency-justified table and a boolean has nowhere to put
 * them except `false`. The pre-registered hard threshold these tests pin is
 * **zero false negatives on statically obvious writes** — expressed here as
 * "no case whose truth is a write may come back `false`", which is a strictly
 * stronger assertion than matching the fixture verdict.
 *
 * This is NOT the execute gate. `mode`/`writeShaped` are reproduced verbatim
 * elsewhere and nothing here may widen or reinterpret them.
 */

interface Case {
	id: string;
	class: string;
	name: string;
	input: string;
	verdict: WriteVerdict;
}

const fixtures: { cases: Case[]; branches: Case[] } = JSON.parse(
	readFileSync(
		new URL("../fixtures/explain/write.json", import.meta.url),
		"utf8",
	),
);

const allCases = [...fixtures.cases, ...fixtures.branches];

describe("explain/write — Q16 ratified corners", () => {
	for (const c of fixtures.cases) {
		test(`${c.id} (${c.class}) — ${c.name}`, () => {
			expect(containsWrite(c.input).verdict).toBe(c.verdict);
		});
	}
});

describe("explain/write — ratified-branch behavior anchors", () => {
	for (const c of fixtures.branches) {
		test(`${c.id} (${c.class}) — ${c.name}`, () => {
			expect(containsWrite(c.input).verdict).toBe(c.verdict);
		});
	}
});

describe("explain/write — pre-registered thresholds", () => {
	/**
	 * The hard-0 threshold. Every fixture whose truth is a write must NOT be
	 * reported `false`; `unknown` would be a (costly but safe) abstention, while
	 * `false` is the failure the boolean shape was rejected for.
	 */
	test("zero false negatives on statically obvious writes", () => {
		const missed = allCases
			.filter((c) => c.verdict === "true")
			.filter((c) => containsWrite(c.input).verdict === "false");
		expect(missed.map((c) => c.id)).toEqual([]);
	});

	/** The mirror: inert command-shaped text must never manufacture a write. */
	test("zero false positives on inert command-shaped text", () => {
		const invented = allCases
			.filter((c) => c.verdict === "false")
			.filter((c) => containsWrite(c.input).verdict === "true");
		expect(invented.map((c) => c.id)).toEqual([]);
	});

	/** Rule 2 — an abstention may never be rendered as a clean `false`. */
	test("no case that must abstain is reported false", () => {
		const cleared = allCases
			.filter((c) => c.verdict === "unknown")
			.filter((c) => containsWrite(c.input).verdict === "false");
		expect(cleared.map((c) => c.id)).toEqual([]);
	});
});

describe("explain/write — rollup rules", () => {
	/** Rule 1: a proven write wins outright; an unknown cannot un-write it. */
	test("a proven write survives an unknown elsewhere", () => {
		const got = containsWrite(
			"/ip route add dst-address=0.0.0.0/0 gateway=1.1.1.1\n/disk format-drive disk1",
		);
		expect(got.verdict).toBe("true");
		expect(got.writes).toBe(1);
		expect(got.blockers.length).toBeGreaterThan(0);
	});

	/** Rule 4: `unknown` is reported WITH its blockers, so the caller sees why. */
	test("unknown carries its blockers", () => {
		const got = containsWrite("/interface lte firmware-upgrade");
		expect(got.verdict).toBe("unknown");
		expect(got.blockers).toHaveLength(1);
		expect(got.blockers[0]?.klass).toBe("unknown-verb");
		expect(got.blockers[0]?.verb).toBe("firmware-upgrade");
	});

	test("a clean read document reports no blockers and no writes", () => {
		const got = containsWrite("/ip route print\n/ip address print");
		expect(got.verdict).toBe("false");
		expect(got.writes).toBe(0);
		expect(got.blockers).toEqual([]);
		expect(got.occurrences.every((o) => o.klass === "read")).toBe(true);
	});

	/**
	 * Rule 1 again, on the shape an unanchored dynamic-form probe got wrong: a
	 * `[$f]` argument VALUE does not make a curated write verb uncertain. Only
	 * text that is itself a `[$f]` invocation is dynamic.
	 */
	test("a dynamic argument value does not mask a known write", () => {
		const got = containsWrite("/ip route add gateway=[$gw]");
		expect(got.verdict).toBe("true");
		expect(got.writes).toBe(1);
	});

	test("a dynamic value in an inert string stays inert", () => {
		expect(containsWrite(':put "[$x]"').verdict).toBe("false");
	});

	test("stored-script detection reads the command head, not argument strings", () => {
		expect(containsWrite(':put "/system script run backup"').verdict).toBe(
			"false",
		);
		expect(containsWrite(':put "/system/script/run backup"').verdict).toBe(
			"false",
		);
		const got = containsWrite(
			'/ip route add comment="/system script run backup"',
		);
		expect(got.verdict).toBe("true");
		expect(got.writes).toBe(1);
	});

	test.each([
		"/system/script/run backup",
		"/system/script run backup",
		"/system script/run backup",
		"/system script run backup",
	])("every stored-script separator spelling abstains: %s", (input) => {
		const got = containsWrite(input);
		expect(got.verdict).toBe("unknown");
		expect(got.blockers.some((b) => b.klass === "dynamic")).toBe(true);
	});

	test("every variable-reference spelling at statement head is dynamic", () => {
		for (const input of [
			"$myFunc",
			'$"set-dns" 1.1',
			["$", "{myFunc}"].join(""),
			"$",
		]) {
			const got = containsWrite(input);
			expect(got.verdict).toBe("unknown");
			expect(got.blockers.map((b) => b.klass)).toContain("dynamic");
		}
	});

	test("text that is itself a [$f] invocation is dynamic", () => {
		const got = containsWrite("[$myFunc]");
		expect(got.verdict).toBe("unknown");
		expect(got.blockers.some((b) => b.klass === "dynamic")).toBe(true);
	});

	/** Write counts agreed with IL 100% on both splits — pin the arithmetic. */
	test("writes counts every proven write, at every depth", () => {
		const got = containsWrite(
			"/ip address add address=1.2.3.4/24\n:foreach i in=[/ip route find] do={ /ip route remove $i }",
		);
		expect(got.verdict).toBe("true");
		expect(got.writes).toBe(2);
	});
});

describe("explain/write — finding 2: fail closed where input is discarded", () => {
	/**
	 * The shape the naive arms got wrong. Q4's nav rule swallows it (all bare
	 * words) AND its verb is outside Q6's frozen table, so the two abstention
	 * mechanisms cancelled and the document confidently reported "no write".
	 * The ratified arm emits an occurrence instead of dropping the statement.
	 */
	test("a bare-word statement with an out-of-table verb still emits an occurrence", () => {
		const got = containsWrite("/disk format-drive disk1");
		expect(got.verdict).toBe("unknown");
		expect(got.occurrences).toHaveLength(1);
		expect(got.occurrences[0]?.klass).toBe("unknown-verb");
	});

	/** Same shape, but the fallback candidate IS a curated write verb. */
	test("a bare-word statement with an in-table write verb is a write", () => {
		const got = containsWrite("/interface ethernet reset-counters");
		expect(got.verdict).toBe("true");
		expect(got.writes).toBe(1);
	});

	/** Confirmed navigation is still dropped — the abstention is not blanket. */
	test("confirmed navigation emits no occurrence", () => {
		expect(occurrences("/ip/firewall/filter")).toEqual([]);
		expect(occurrences("/ip firewall")).toEqual([]);
		expect(occurrences("/ip firewall\n/ip route")).toEqual([]);
		// The two bare nav forms Q4's CHR round confirmed name no command.
		expect(occurrences("/ip firewall\n..\n/")).toEqual([]);
	});

	/**
	 * Where this composition departs from the lab SUT. The production path
	 * resolver requires a leading `/` for navigation (Q4's CHR correction: bare
	 * -word nav is not valid RouterOS), so a bare-word head never reaches the
	 * unconfirmed-nav fallback and instead arrives with V4 ambiguity. Clearing it
	 * would be a false negative on a curated write verb, so it abstains — Q14's
	 * rule (b) enforced at the rollup.
	 */
	test("a bare-word head abstains rather than clearing the document", () => {
		const got = containsWrite("/interface\nreset-counters");
		expect(got.verdict).toBe("unknown");
		expect(got.blockers.map((b) => b.klass)).toEqual(["ambiguous"]);
	});

	/**
	 * KNOWN LIMIT, declared not fixed. A slash-led bare path with no hyphenated
	 * segment is read as confirmed navigation and dropped — which is right for
	 * `/ip/firewall/filter` (a directory) and wrong for `/system/reboot` (a
	 * no-argument write). The two are the same text; only a schema separates
	 * them, and Q6 ratified abstention there. The lab measured this as its
	 * `overconfident` bin — 3 of 352 holdout captures, reported separately and
	 * deliberately excluded from the precision denominator because the IL oracle
	 * cannot decide those cells either. It is pinned here so the residual is
	 * visible rather than latent; narrowing `isConfirmedNav` needs a corpus
	 * re-score, not a guess.
	 */
	test("KNOWN LIMIT: a trailing bare path clears instead of abstaining", () => {
		expect(containsWrite("/ip/firewall/filter").verdict).toBe("false");
		expect(containsWrite("/system/reboot").verdict).toBe("false");
	});

	/**
	 * The fallback reading is not trusted enough to CLEAR a document: even a
	 * recognized read verb reached through it downgrades to `unknown-verb`.
	 */
	test("an unconfirmed-nav fallback never clears the document", () => {
		const got = containsWrite("/interface ethernet monitor-traffic");
		expect(got.verdict).toBe("unknown");
	});
});

describe("explain/write — the (menu, verb) dependency", () => {
	/**
	 * The one boundary where write-ness needs the menu: `set`, `find`, `export`,
	 * `import`, `password`, `undo` and `redo` are ALL root cmds as well as menu
	 * verbs and mean different things in each place.
	 */
	test.each([
		["set", "write", "read"],
		["import", "unknown-verb", "write"],
		["undo", "unknown-verb", "write"],
		["export", "read", "read"],
		["find", "read", "read"],
	] as const)("%s classifies as %s at a menu and %s at root", (verb, menu, root) => {
		expect(classifyVerb(verb, false)).toBe(menu);
		expect(classifyVerb(verb, true)).toBe(root);
	});

	test(":set assigns a variable; /ip/route set writes the device", () => {
		expect(containsWrite(":local x 5\n:set x 6").verdict).toBe("false");
		expect(containsWrite("/ip route set 0 comment=x").verdict).toBe("true");
	});

	test("a root cmd written without its sigil at document root reads as root", () => {
		const got = containsWrite("/import file-name=cfg.rsc");
		expect(got.verdict).toBe("true");
		expect(got.occurrences[0]?.directive).toBe(true);
	});

	test("an unseen root directive abstains rather than reading as control flow", () => {
		expect(classifyVerb("notadirective", true)).toBe("unknown-verb");
		expect(classifyVerb(null, true)).toBe("no-verb");
		expect(classifyVerb(null, false)).toBe("no-verb");
	});

	test("verb classification is case-insensitive", () => {
		expect(classifyVerb("ADD", false)).toBe("write");
		expect(classifyVerb("Parse", true)).toBe("dynamic");
	});
});

describe("explain/write — frozen vocabularies", () => {
	/**
	 * Frozen against tuning: these are curated lists, not a schema, and their
	 * honesty depends on not being fitted to scoring output. A change here is a
	 * change to what Q16 measured.
	 */
	test("the menu-verb tables are exactly the measured sets", () => {
		expect([...WRITE_VERBS].sort()).toEqual([
			"add",
			"comment",
			"disable",
			"edit",
			"enable",
			"move",
			"remove",
			"reset",
			"reset-counters",
			"reset-counters-all",
			"set",
			"unset",
		]);
		expect([...READ_VERBS].sort()).toEqual([
			"export",
			"find",
			"get",
			"monitor",
			"print",
		]);
	});

	test("the root tables are exactly the measured sets", () => {
		expect([...ROOT_WRITE].sort()).toEqual([
			"import",
			"password",
			"redo",
			"undo",
		]);
		expect([...ROOT_DYNAMIC].sort()).toEqual(["execute", "parse"]);
		expect(ROOT_CMDS.size).toBe(56);
	});

	/** The write/read tables must not overlap, or classification order would matter. */
	test("no verb is both a curated write and a curated read", () => {
		expect([...WRITE_VERBS].filter((v) => READ_VERBS.has(v))).toEqual([]);
		expect([...ROOT_WRITE].filter((v) => ROOT_DYNAMIC.has(v))).toEqual([]);
	});

	/** Every curated root verb must be in the closed root vocabulary. */
	test("root write/dynamic verbs are members of the closed root list", () => {
		for (const v of [...ROOT_WRITE, ...ROOT_DYNAMIC])
			expect(ROOT_CMDS.has(v)).toBe(true);
	});
});

describe("explain/write — Q14 floor and structural defects", () => {
	/**
	 * The production path resolver refuses a structurally defective statement and
	 * does not descend into it, so a write may hide in a body that was never
	 * walked. That must abstain, not clear — the lab SUT had no such floor.
	 */
	test("a refused statement emits a defect occurrence", () => {
		const got = containsWrite(
			":if [) do={ /ip route add dst-address=0.0.0.0/0 }",
		);
		expect(got.verdict).toBe("unknown");
		expect(got.occurrences.some((o) => o.klass === "defect")).toBe(true);
	});

	test("a document-level structural note abstains on its own", () => {
		const got = containsWrite(':put "unterminated');
		expect(got.verdict).toBe("unknown");
		expect(got.notes.length).toBeGreaterThan(0);
	});

	test("a clean document carries no notes", () => {
		expect(containsWrite("/ip route print").notes).toEqual([]);
	});

	test("non-command heads are not mislabeled as structural defects", () => {
		for (const input of ["[find]", "(1)", '"literal"']) {
			const got = containsWrite(input);
			expect(got.verdict).toBe("false");
			expect(got.occurrences.some((o) => o.klass === "defect")).toBe(false);
		}
	});

	test("a bare path in a bracket retains Q6 ambiguity", () => {
		const got = containsWrite(":put [/system/reboot]");
		expect(got.verdict).toBe("unknown");
		expect(got.blockers).toContainEqual(
			expect.objectContaining({ kind: "bracket", klass: "ambiguous" }),
		);
	});
});

describe("explain/write — invariants", () => {
	const adversarial = [
		"",
		"   ",
		"\n\n\n",
		"/",
		":",
		"=",
		'"',
		"[",
		"{",
		"/ip route add",
		"$",
		"$$$",
		":put [:parse [:parse [:parse 1]]]",
		"/ip/route/add/".repeat(200),
		`${"{".repeat(2048)}/ip route add${"}".repeat(2048)}`,
		"# comment with no newline",
		"\u0000\u0001",
		"/ip route add comment=é中😀",
	];

	test("never throws on adversarial input", () => {
		for (const input of [...adversarial, ...allCases.map((c) => c.input)])
			expect(() => containsWrite(input)).not.toThrow();
	});

	test("deterministic", () => {
		for (const input of [...adversarial, ...allCases.map((c) => c.input)])
			expect(JSON.stringify(containsWrite(input))).toBe(
				JSON.stringify(containsWrite(input)),
			);
	});

	/** The verdict must always be one of the three ratified values. */
	test("the verdict is always three-valued", () => {
		for (const input of [...adversarial, ...allCases.map((c) => c.input)])
			expect(["true", "false", "unknown"]).toContain(
				containsWrite(input).verdict,
			);
	});

	/** Rollup consistency: the verdict is a pure function of the occurrences. */
	test("verdict, writes, and blockers agree with the occurrence set", () => {
		for (const input of [...adversarial, ...allCases.map((c) => c.input)]) {
			const got = containsWrite(input);
			expect(got.occurrences.filter((o) => o.klass === "write")).toHaveLength(
				got.writes,
			);
			if (got.writes > 0) expect(got.verdict).toBe("true");
			else if (got.blockers.length > 0 || got.notes.length > 0)
				expect(got.verdict).toBe("unknown");
			else expect(got.verdict).toBe("false");
			// A `false` verdict is the only one that may report no reason at all.
			if (got.verdict === "false") expect(got.blockers).toEqual([]);
		}
	});

	/** Order independence: the rollup is a set operation, not a sequence. */
	test("a write is found wherever it sits in the document", () => {
		const write = "/ip route add dst-address=0.0.0.0/0 gateway=1.1.1.1";
		const reads = ["/ip route print", "/ip address print", ":put 1"];
		for (let i = 0; i <= reads.length; i++) {
			const lines = [...reads.slice(0, i), write, ...reads.slice(i)];
			expect(containsWrite(lines.join("\n")).verdict).toBe("true");
		}
	});

	test("bounded: a deeply nested write does not blow the stack", () => {
		// Past the resolver's MAX_DEPTH (256) without paying the Q17 O(n²) cost
		// the recursive H7 flattening still has (#190).
		const depth = 512;
		const input = `${":foreach i in=[find] do={ ".repeat(depth)}/ip route add${" }".repeat(depth)}`;
		const got = containsWrite(input);
		// Over-depth means part of the document was never walked, so the answer
		// must abstain or find a write — it may never come back clean.
		expect(got.verdict).not.toBe("false");
	});
});

describe("explain/write — public export surface", () => {
	test("containsWrite and its vocabularies are exported from the library root", () => {
		expect(centrs.containsWrite).toBe(containsWrite);
		expect(centrs.classifyVerb).toBe(classifyVerb);
		expect(centrs.explainOccurrences).toBe(occurrences);
		expect(centrs.WRITE_VERBS).toBe(WRITE_VERBS);
		expect(centrs.READ_VERBS).toBe(READ_VERBS);
		expect(centrs.ROOT_WRITE).toBe(ROOT_WRITE);
		expect(centrs.ROOT_DYNAMIC).toBe(ROOT_DYNAMIC);
		expect(centrs.ROOT_CMDS).toBe(ROOT_CMDS);
	});
});
