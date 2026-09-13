import { describe, expect, spyOn, test } from "bun:test";
import {
	lexArguments,
	lexArgumentTokens,
	lexValueAnchors,
} from "../../src/explain/args.ts";
import {
	resolveDocument,
	resolveStatements,
} from "../../src/explain/pathresolve.ts";
import * as scopeBrace from "../../src/explain/scope-brace.ts";
import { documentRange, nestedRange } from "../../src/explain/segment.ts";
import {
	describeStatement,
	isDirective,
	resolveVerb,
	resolveVerbsFromStatements,
} from "../../src/explain/verbsplit.ts";
import { containsWriteFromAnalyses } from "../../src/explain/write.ts";
import { explainCommand } from "../../src/explain.ts";

describe("ranged directive and argument readers (#322, #333 review)", () => {
	test("composed readers use absolute statement spans within a nonzero range", () => {
		const text = "/ip; do {:put 1}; :put 2";
		const statements = resolveStatements(text);
		const brackets = resolveDocument(text);
		const range = nestedRange(documentRange(text), 5, text.indexOf("; :put 2"));
		expect(resolveVerbsFromStatements(statements, range)).toEqual(
			resolveVerbsFromStatements(statements),
		);
		expect(containsWriteFromAnalyses(statements, brackets, range)).toEqual(
			containsWriteFromAnalyses(statements, brackets),
		);
	});

	test("trimmed bare directives retain their own floor and local offsets", () => {
		for (const text of [
			" \t do={ :put 1 } \r\n",
			" \t while (true) do={ :put 1 } \r\n",
			" \t retry command={ :put 1 } \r\n",
			" \t :retry command={ :put 1 } \r\n",
			" \t put command={1;2} \r\n",
			" \t /ip/route print \r\n",
		]) {
			// Unicode before the range makes these JS offsets differ from bytes;
			// the direct ranged reader still uses JS indices as its contract says.
			const prefix = ':put "α😀"; :retry command={\n';
			const range = nestedRange(
				documentRange(`${prefix}${text}}`),
				prefix.length,
				prefix.length + text.length,
			);
			expect(isDirective(text, range)).toBe(isDirective(text));
			expect(describeStatement(text, range)).toEqual(describeStatement(text));
			expect(resolveVerb(text, "/ip/route", range)).toEqual(
				resolveVerb(text, "/ip/route"),
			);
		}
	});

	test("array hash checks retain bracket and scope roles against the document mask", () => {
		for (const [text, complete] of [
			[":local z {[:do { # comment\n:put 1\n}]}", true],
			[":local z {[:retry command={ :put #test }]}", true],
			[":local z {[:put #test]}", true],
			[":local z {[:put {#test}]}", false],
			[":local z {[:put (1,#test)]}", false],
		] as const) {
			const prefix = ':put "α😀"; :retry command={\n';
			const range = nestedRange(
				documentRange(`${prefix}${text}\n}`),
				prefix.length,
				prefix.length + text.length,
			);
			const options = { directiveVerb: "local" };
			const ranged = { ...options, range };
			const from = ":local".length;
			expect(lexValueAnchors(text, from, ranged)).toEqual(
				lexValueAnchors(text, from, options),
			);
			expect(lexValueAnchors(text, from, ranged).complete).toBe(complete);
			expect(lexArgumentTokens(text, from, range)).toEqual(
				lexArgumentTokens(text, from),
			);
			expect(lexArguments(text, from, range)).toEqual(lexArguments(text, from));
		}
	});

	test("nested array scope queries reuse the document index at each statement depth", () => {
		const open = ":local z {[:do {";
		const depth = 16;
		const text = `${open.repeat(depth)}:put 1${"}]}".repeat(depth)}`;
		const document = documentRange(text);
		// Construct the document mask before observing reader queries. Every
		// following brace query should address that same indexed source, even
		// when an array's bracket context re-enters a scope several levels down.
		const braces = spyOn(scopeBrace, "braceStartsStatements");
		try {
			for (let level = 0; level < depth; level++) {
				const start = open.length * level;
				const end = text.length - 3 * level;
				lexValueAnchors(text.slice(start, end), ":local".length, {
					directiveVerb: "local",
					range: nestedRange(document, start, end),
				});
			}
			expect(braces.mock.calls.length).toBeGreaterThan(depth);
			expect(new Set(braces.mock.calls.map(([source]) => source))).toEqual(
				new Set([document.masked]),
			);
		} finally {
			braces.mockRestore();
		}
	});
});

describe("interpolation enters its own comment context (#333 review)", () => {
	test("commented brackets are absent while following code keeps its document spans", () => {
		for (const input of [
			':put "$[# [find]\n:put 1]"',
			':put "$[# [find] {[]}\n:put [/ip/route/print]]"',
			':if (true) do={ :put "before $[ # [find]\n:put [/ip/route/print]] after" }',
			':put "$[# ] ignored\n:put [/ip/route/print]]"',
			':put "$[# [ ignored\n:put [/ip/route/print]]"',
		]) {
			const result = resolveDocument(input);
			expect(result.defects).toEqual([]);
			expect(result.resolutions.some((r) => r.inner === "find")).toBeFalse();
			expect(result.resolutions.some((r) => r.inner === "")).toBeFalse();
			for (const resolution of result.resolutions) {
				expect(
					input.slice(resolution.innerSpan.start, resolution.innerSpan.end),
				).toBe(resolution.inner);
			}
			const commands = result.resolutions.filter((r) => r.depth > 0);
			expect(commands.map((r) => r.inner)).toEqual(
				input.includes("/ip/route/print") ? ["/ip/route/print"] : [],
			);
		}
	});

	test("verb and write readers use the interpolation's local mask", () => {
		const read = '/ip/route\n:put "$[find\n# do={ignored}\n]"';
		expect(explainCommand(read).structure.subcommands[0]).toMatchObject({
			resolution: "resolved",
			kind: "command",
			command: { path: "/ip/route", verb: "find" },
		});

		const write = '/ip/route\n:put "$[set numbers=0\n# do={ignored}\n]"';
		expect(explainCommand(write).structure.containsWrite).toBe(true);
	});

	test("a nested quoted interpolation ignores delimiters in its comments", () => {
		const input = ':put "$[:put "$[# [ ignored\n:put [/ip/route/print]]"]"';
		const result = resolveDocument(input);
		expect(result.defects).toEqual([]);
		expect(
			result.resolutions.some((r) => r.inner === "/ip/route/print"),
		).toBeTrue();
		for (const resolution of result.resolutions) {
			expect(
				input.slice(resolution.innerSpan.start, resolution.innerSpan.end),
			).toBe(resolution.inner);
		}
	});

	test("Unicode keeps conservative enclosing spans while comments remain opaque", () => {
		const input = ':put "α😀 $[# [find]\n:put [/ip/route/print]]"';
		const result = resolveDocument(input);
		expect(result.resolutions).toHaveLength(2);
		expect(result.resolutions[1]?.inner).toBe("/ip/route/print");
		for (const resolution of result.resolutions) {
			expect(resolution.span).toEqual({
				start: 0,
				end: new TextEncoder().encode(input).length,
			});
		}
		expect(result.defects.map((d) => d.code)).toEqual(["non-ascii"]);
	});
});
