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
		expect(fixture.bracketEqualsByClass["unclassified"]).toBe(1063);
		expect(fixture.bracketEquals).toBe(1079);
	});

	test("the split is the cost the abstention actually pays", () => {
		expect(fixture.unclassifiedQuery).toBe(446);
		expect(fixture.unclassifiedArgument).toBe(617);
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
		expect(block).toContain("1,063");
		expect(block).toContain("446");
		expect(block).toContain("617");
		expect(block).toContain("7.24.2");
	});
});
