import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type BracketEqualsCensus,
	census,
	renderReadmeBlock,
	scanEqualsSites,
} from "../../scripts/explain-bracket-equals.ts";

const fixture = JSON.parse(
	readFileSync(
		join(import.meta.dir, "..", "fixtures", "explain", "bracket-equals.json"),
		"utf8",
	),
) as BracketEqualsCensus;

/** Only the `[`-governed sites, which is what the census counts. */
function bracketSites(text: string) {
	return scanEqualsSites(text).filter((site) => site.opener === "[");
}

describe("the delimiter stack, not a depth counter", () => {
	test("`=` directly inside `[ … ]` is bracket-governed", () => {
		const sites = bracketSites("/ip/address remove [find address=1.2.3.4]");
		expect(sites.length).toBe(1);
		expect(sites[0]?.query).toBe(true);
	});

	test("`=` inside a `( … )` nested in `[ … ]` is NOT bracket-governed", () => {
		// The innermost opener decides. This is the case a depth counter gets
		// wrong, and it is the whole reason the scan keeps a stack.
		expect(bracketSites("[find where (a = b)]")).toEqual([]);
	});

	test("`=` inside a `[ … ]` nested in `( … )` IS bracket-governed", () => {
		expect(bracketSites("(x . [find name=y])").length).toBe(1);
	});

	test("a `{ … }` block governs neither", () => {
		expect(bracketSites(":if (1) do={ :set a 1 }")).toEqual([]);
	});
});

describe("the query rule is the verb, not the word `where`", () => {
	test("`find k=v` with no `where` is still a comparison", () => {
		// The device settles this: `[find address=$IP]` lowers to
		// `(= $address $IP)`. A `where`-only rule would miss every one of these.
		const sites = bracketSites("[find address=$IP list=demo]");
		expect(sites.length).toBe(2);
		expect(sites.every((site) => site.query)).toBe(true);
	});

	test("an explicit `where` marks the same thing", () => {
		expect(bracketSites("[find where leds=user-led]")[0]?.query).toBe(true);
	});

	test("a command's argument list inside brackets is NOT a query", () => {
		const sites = bracketSites("[/system/identity/get value-name=name]");
		expect(sites.length).toBe(1);
		expect(sites[0]?.query).toBe(false);
	});

	test("the query flag does not leak out of its group", () => {
		// `find` governs only the group it appears in; the second bracket is a
		// plain argument list and must not inherit the flag.
		const sites = bracketSites(
			"[find name=a] [/system/identity/get value-name=b]",
		);
		expect(sites.map((site) => site.query)).toEqual([true, false]);
	});

	test("`find` as a substring of a longer word does not arm the rule", () => {
		expect(bracketSites("[/tool/fetch findings=x]")[0]?.query).toBe(false);
	});
});

describe("malformed and adversarial source", () => {
	test("a mismatched closer does not discard the enclosing opener", () => {
		// `)` must not pop a `[`. If it did, every later `=` in the script would
		// move to top level and drop out of the universe — and 37 of the 948
		// corpus scripts carry a mismatched closer, so this is not hypothetical.
		const sites = bracketSites("[find x=1) y=2]");
		expect(sites.length).toBe(2);
		expect(sites.every((site) => site.opener === "[")).toBe(true);
	});

	test("a matching closer still pops", () => {
		// The guard must not make the stack sticky: after `]` the `=` is top level.
		expect(bracketSites("[find x=1] y=2")).toHaveLength(1);
	});

	test("`find` in VALUE position does not arm the query rule", () => {
		// `[set comment=find other=x]` is two argument separators, not a query.
		// The corpus carries three such spellings, one the pathological
		// `find=.id=*8;name=find`.
		const sites = bracketSites("[set comment=find other=x]");
		expect(sites.length).toBe(2);
		expect(sites.every((site) => site.query)).toBe(false);
	});

	test("`$find` as a variable does not arm the query rule", () => {
		expect(bracketSites("[set x=$find other=y]").every((s) => s.query)).toBe(
			false,
		);
	});

	test("a quoted value before a word does not arm the query rule", () => {
		expect(
			bracketSites('[set comment="a" find other=y]')
				.map((s) => s.query)
				.includes(true),
		).toBe(true);
		// …but the word after the quote is still command position only when it is
		// not glued to the quote; the guard covers the glued case.
		expect(bracketSites('[set c="x"find other=y]').every((s) => !s.query)).toBe(
			true,
		);
	});
});

describe("strings and comments are not source structure", () => {
	test("a bracket inside a quoted string opens nothing", () => {
		expect(bracketSites(':log info "[find name=x]"')).toEqual([]);
	});

	test("a bracket inside a `#` comment opens nothing", () => {
		expect(bracketSites("# [find name=x]\n/ip/address print")).toEqual([]);
	});
});

describe("the census over a tiny corpus", () => {
	test("counts, splits, and reports the class the pipeline assigned", () => {
		const result = census(
			[{ text: "/ip/address remove [find address=1.2.3.4]" }],
			{},
		);
		expect(result.scripts).toBe(1);
		expect(result.scriptsWithBracketEquals).toBe(1);
		expect(result.bracketEquals).toBe(1);
		expect(result.queryComparisons).toBe(1);
		expect(result.argumentSeparators).toBe(0);
		// The operator fill abstains here, which is the whole point of the figure.
		expect(result.bracketEqualsByClass["unclassified"]).toBe(1);
		expect(result.unclassifiedQuery).toBe(1);
	});

	test("a script with no bracket `=` contributes nothing", () => {
		const result = census([{ text: "/ip/address print" }], {});
		expect(result.bracketEquals).toBe(0);
		expect(result.scriptsWithBracketEquals).toBe(0);
	});
});

describe("the committed corpus figures", () => {
	test("the abstention is essentially the whole universe", () => {
		// The obvious guess is that the `arg` fill rescues these bytes now that it
		// runs before the operator fill. It does not: it offers only the `=` its
		// own located argument token names, and a `[ … ]` substitution is not
		// where it locates arguments. If this ever becomes non-zero, the `arg`
		// fill's reach has genuinely changed and the README prose needs rewriting
		// rather than just regenerating.
		expect(fixture.bracketEqualsByClass["arg-sep"] ?? 0).toBe(0);
		expect(fixture.bracketEqualsByClass["unclassified"]).toBe(1067);
		expect(fixture.bracketEquals).toBe(1079);
		// Every bracket `=` is accounted for by exactly one class. Before the
		// coordinate-space fix a stray `cmd` bucket of 4 appeared here — the
		// non-ASCII offset shift, showing up as bytes attributed to a token they
		// were never in. The sum holding is what says the join is sound.
		const classTotal = Object.values(fixture.bracketEqualsByClass).reduce(
			(a, b) => a + b,
			0,
		);
		expect(classTotal).toBe(fixture.bracketEquals);
		expect(fixture.bracketEqualsByClass["cmd"]).toBeUndefined();
	});

	test("the split is the cost the abstention actually pays", () => {
		expect(fixture.unclassifiedQuery).toBe(448);
		expect(fixture.unclassifiedArgument).toBe(619);
		expect(fixture.unclassifiedQuery + fixture.unclassifiedArgument).toBe(
			fixture.bracketEqualsByClass["unclassified"] ?? 0,
		);
	});

	test("the device corroborates the query reading where it could resolve the command", () => {
		const co = fixture.ilCorroboration;
		expect(co.build).toBe("7.24.2");
		expect(co.corroborated + co.commandUnresolved + co.rejectedParse).toBe(
			co.scriptsWithQueryEquals,
		);
		// Of the scripts that parsed at all, the great majority carry the nodes.
		const parsed = co.scriptsWithQueryEquals - co.rejectedParse;
		expect(co.corroborated / parsed).toBeGreaterThan(0.8);
	});

	test("the old 224 / 1,259 / 1,035 figure is gone and stays gone", () => {
		// #341: it was prose with no generator and no gate, and no universe
		// reproduces it. Nothing should reintroduce it as a literal.
		expect(fixture.bracketEquals).not.toBe(1259);
		expect(fixture.unclassifiedQuery).not.toBe(224);
		expect(fixture.unclassifiedArgument).not.toBe(1035);
	});
});

describe("the README projection", () => {
	test("renders every load-bearing number from the fixture", () => {
		const block = renderReadmeBlock(fixture).join("\n");
		expect(block).toContain("1,079");
		expect(block).toContain("1,067");
		expect(block).toContain("448");
		expect(block).toContain("619");
		expect(block).toContain("7.24.2");
	});
});
