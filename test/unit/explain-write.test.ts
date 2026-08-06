import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasStructuralDefect } from "../../src/explain/defects.ts";
import { isMenuPath } from "../../src/explain/menus.ts";
import {
	resolveDocument,
	resolveStatements,
} from "../../src/explain/pathresolve.ts";
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
		expect(occurrences("/ip/firewall/filter\nprint")).toHaveLength(1);
		expect(occurrences("/ip firewall\nprint")[0]?.klass).toBe("read");
		expect(occurrences("/ip firewall\n/ip route\nprint")).toHaveLength(1);
		// The two bare nav forms Q4's CHR round confirmed name no command, so
		// they are dropped even in the trailing position.
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
	 * The P1 from the Codex review round. `isConfirmedNav` decides at STATEMENT
	 * scale, so it dropped a lone `/system/reboot` as navigation and cleared the
	 * document to `false` — a false negative on a statically obvious write, which
	 * reproduces inside the tristate precisely the failure the tristate was
	 * ratified to prevent. Position is the schema-free confirmation: a bare path
	 * with nothing after it in the document is not navigation, because navigating
	 * and then ending the script is a no-op.
	 *
	 * Measured over the frozen 911-script corpus this moves ZERO documents, so the
	 * ratified navigation arm's abstention is unchanged.
	 *
	 * #207 SPLIT this test, because it had quietly stopped testing one thing.
	 * `/system/reboot` now abstains upstream, in `isConfirmedNav`, because the
	 * menu table knows it is a `cmd` — position never gets consulted. Only the
	 * two genuine MENUS still reach `isDanglingBarePath`, so asserting all three
	 * together would report the position rule as covered while the case actually
	 * exercising it was the one that changed mechanism. They are separated below
	 * so each rule has an anchor that fails for its own reason.
	 */
	test("a dangling bare MENU abstains instead of clearing — the position rule", () => {
		for (const input of ["/ip/firewall/filter", "/log"]) {
			expect(isMenuPath(input.replace(/^\//, "").split("/"))).toBe(true);
			const got = containsWrite(input);
			expect(got.verdict).toBe("unknown");
			expect(got.blockers).toHaveLength(1);
		}
	});

	/** The same input shape, but a command — refused before position is reached. */
	test("a dangling bare COMMAND abstains via the menu table, not position", () => {
		expect(isMenuPath(["system", "reboot"])).toBe(false);
		const got = containsWrite("/system/reboot");
		expect(got.verdict).toBe("unknown");
		expect(got.blockers).toHaveLength(1);
	});

	/** But a bare MENU path the document goes on to USE is still confirmed navigation. */
	test("a consumed bare menu path still clears", () => {
		expect(containsWrite("/ip/firewall/filter\nprint").verdict).toBe("false");
	});

	/**
	 * The residual this test used to declare is CLOSED by #207. A bare-path
	 * COMMAND followed only by ABSOLUTE statements used to clear the document:
	 * nothing relative ever consumed the context it would have established, so
	 * `isDanglingBarePath` — a position rule — could not see it, and the old
	 * shape-based `isConfirmedNav` swallowed `/system/reboot` because it carries
	 * no hyphen. Closing it was priced at +1.4pp dev / +1.9pp holdout abstention
	 * *as a position rule*, and was not taken for that reason.
	 *
	 * The menu table closes it for free instead, because it answers the question
	 * position was standing in for: `/system/reboot` is a `cmd`, not a `dir`, so
	 * it was never navigation whatever follows it. Corpus abstention is unchanged
	 * (44.8% dev / 46.0% holdout) rather than up 1.4–1.9pp.
	 */
	test("a bare-path COMMAND abstains even when only absolute statements follow", () => {
		expect(containsWrite("/system/reboot\n/log print").verdict).toBe("unknown");
		expect(containsWrite("/system/reboot\nprint").verdict).toBe("unknown");
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
		// Contents, not just size: a swapped name is a vocabulary change too.
		expect([...ROOT_CMDS].sort()).toEqual([
			"beep",
			"break",
			"continue",
			"convert",
			"delay",
			"deserialize",
			"do",
			"error",
			"execute",
			"exit",
			"export",
			"find",
			"for",
			"foreach",
			"global",
			"grep",
			"if",
			"import",
			"jobname",
			"len",
			"local",
			"lock",
			"nothing",
			"onerror",
			"parse",
			"password",
			"pick",
			"ping",
			"put",
			"quit",
			"range",
			"recursive-print",
			"redo",
			"resolve",
			"retry",
			"return",
			"rndnum",
			"rndstr",
			"serialize",
			"set",
			"time",
			"timestamp",
			"toarray",
			"tobool",
			"tocrlf",
			"toid",
			"toip",
			"toip6",
			"tolf",
			"tonsec",
			"tonum",
			"tostr",
			"totime",
			"typeof",
			"undo",
			"while",
		]);
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

	test("a document-level structural defect abstains on its own", () => {
		const got = containsWrite(':put "unterminated');
		expect(got.verdict).toBe("unknown");
		expect(hasStructuralDefect(got.defects)).toBe(true);
	});

	/**
	 * The Q14 floor is an ALLOW list, not a defect-string match. `pathresolve` has
	 * four statement refusal reasons and only two are safe to clear; matching the
	 * defect prose instead would fail OPEN on the other two.
	 */
	test("a variable path segment cannot clear the document", () => {
		// `runTokens` stops at the first non-bare segment, so these yield an EMPTY
		// run while plainly naming a write. `pathresolve` calls that "no leading
		// path token" — the same reason a harmless `"a string"` gets.
		for (const input of [
			"/ip/$menu/remove 0",
			"/ip/$m/add address=1.2.3.4",
			"/interface/$if/disable",
			"/ip/route/$verb",
		]) {
			const got = containsWrite(input);
			expect(got.verdict).toBe("unknown");
			expect(got.blockers).toHaveLength(1);
		}
	});

	/** The other half of that reason: text naming no command at all stays inert. */
	test("text that names no command still clears", () => {
		expect(containsWrite('"just a string"').verdict).toBe("false");
		expect(containsWrite("=").verdict).toBe("false");
		// A bracket-headed statement carries no OUTER verb; the bracket walk
		// classifies its inner command instead of the statement abstaining.
		expect(containsWrite("[find]").verdict).toBe("false");
		expect(containsWrite("[/ip/route/print]").verdict).toBe("false");
	});

	/** An unrecognized refusal reason must block, so resolver drift over-abstains. */
	test("the clearable-reason list matches what pathresolve actually emits", () => {
		const reasons = [
			"/ip/route/remove [find",
			"[find]",
			'"a string"',
			"$f",
		].map((t) => resolveStatements(t).statements[0]?.unresolved);
		expect(reasons).toEqual([
			"structural defect: unbalanced delimiter or string",
			"dynamic or substitution-headed statement",
			"no leading path token",
			"dynamic or substitution-headed statement",
		]);
		// The fifth reason is document-scale, so it needs a second statement: the
		// Q14 C3b cascade (#192). It is deliberately NOT clearable — a statement
		// resolved against a context the resolver lost cannot clear a document.
		expect(
			resolveStatements("/ip) address\nadd address=1.1.1.1").statements[1]
				?.unresolved,
		).toBe("context lost to an earlier unreadable statement");
	});

	/**
	 * The cascade contract costs this module nothing measurable: over the frozen
	 * phase-0 corpus, `containsWrite` abstention is unchanged on both splits
	 * (44.8% dev / 46.0% holdout) and no document changes verdict, because every
	 * statement that can poison the context already blocked on its own account.
	 */
	test("a poisoned document abstains rather than clearing or asserting", () => {
		const got = containsWrite("/ip) address\nadd address=1.1.1.1");
		expect(got.verdict).toBe("unknown");
		expect(
			got.blockers.some((b) => b.klass === "defect" || b.klass === "ambiguous"),
		).toBe(true);
	});

	test("a clean document carries no defects", () => {
		expect(containsWrite("/ip route print").defects).toEqual([]);
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

	/**
	 * The bracket walk carries the SAME two fail-closed rules as the statement
	 * walk. It did not, and the gap was reachable: the statement `/ip/$menu/remove`
	 * abstained while the identical text inside brackets cleared the document to a
	 * confident `false` — a false negative on a curated write verb, which is the
	 * one thing Q16's hard-0 threshold forbids.
	 */
	test("a variable path segment cannot clear the document from a bracket", () => {
		for (const input of [
			":put [/ip/$menu/remove 0]",
			":put [/ip/$m/add address=1.2.3.4]",
			":local x [/system/$foo/reboot]",
		]) {
			const got = containsWrite(input);
			expect(got.verdict).toBe("unknown");
			expect(got.blockers).toContainEqual(
				expect.objectContaining({ kind: "bracket", klass: "defect" }),
			);
		}
	});

	/**
	 * The other half, and independently load-bearing: a `/`-led bracket inner whose
	 * run was TRUNCATED by a non-bare segment yields an empty run with NO refusal
	 * reason, so only the path-shaped guard catches it.
	 */
	test("a `/`-led bracket whose path could not be read abstains", () => {
		for (const input of [
			':put [/ip/"foo"/remove]',
			":put [/ip/[find]/remove]",
			":put [/(1)/remove]",
		]) {
			expect(containsWrite(input).verdict).toBe("unknown");
		}
	});

	/** Neither rule may fire on a bracket that genuinely names no command. */
	test("inert bracket inners still clear", () => {
		for (const input of [
			"[find]",
			"[/ip/route/print]",
			":put [:rndnum from=1 to=2]",
		]) {
			const got = containsWrite(input);
			expect(got.verdict).toBe("false");
			expect(got.occurrences.some((o) => o.klass === "defect")).toBe(false);
		}
	});

	/** The bracket reason vocabulary differs from the statement one, so anchor it. */
	test("the clearable-reason list matches what the bracket walk emits", () => {
		const reasons = [
			":put [/ip/$menu/remove 0]",
			":put [$menu/remove]",
			':put ["a string"]',
			"[admin@MikroTik] > /ip/socks/set enabled=yes",
		].map((t) => resolveDocument(t).resolutions[0]?.unresolved);
		expect(reasons).toEqual([
			// Not clearable — reachable in brackets but not at statement scale.
			"variable path segment",
			"no leading path token",
			"no leading path token",
			// Not clearable: a prompt means the line is a TRANSCRIPT, so the command
			// after it was never walked as a statement.
			"looks like a pasted CLI prompt, not a substitution",
		]);
	});

	/**
	 * The corpus shape behind the rule above. A pasted CLI transcript hides a real
	 * write behind the prompt: the statement walk reads the whole line as starting
	 * with `[`, so `/ip/socks/set enabled=yes` is never classified. This used to
	 * report a confident "no write" about a document that plainly writes.
	 */
	test("a pasted CLI transcript does not clear a write hidden behind the prompt", () => {
		const got = containsWrite(
			[
				"[admin@box] > /system/device-mode/print",
				"       mode: enterprise",
				"[admin@box] > /ip/socks/set enabled=yes",
			].join("\n"),
		);
		expect(got.verdict).toBe("unknown");
		expect(got.occurrences.some((o) => o.klass === "defect")).toBe(true);
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
			else if (got.blockers.length > 0 || hasStructuralDefect(got.defects))
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
