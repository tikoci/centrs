import { expect, spyOn, test } from "bun:test";
import * as scopeBrace from "../../src/explain/scope-brace.ts";
import { explainCommand } from "../../src/explain.ts";

/**
 * #322: instrument the structural readers' INPUTS, not elapsed time or cache
 * internals. Every distinct string queried here can require a document-sized
 * statement index. Enclosing subtree strings made that allocation grow with
 * depth even at fixed input size. Small leaf strings are allowed; large inputs
 * must remain document views. This does not claim the scans themselves are
 * depth-independent — only that they share the index they ask questions of.
 *
 * The public entry reaches segmentation, both path walks, verb/write inference,
 * argument/value reading, symbols and token fills. The bare directive and the
 * array/substitution/scope shapes expose readers the colon-led shape skips.
 */
for (const [name, open, close] of [
	["if", ":if (true) do={", "}"],
	["bare do", "do={", "}"],
	["retry command", ":retry command={", "}"],
	["array substitution scope", ":local a {[:do {", "}]}"],
	["bracketed bare directive", "$[do={", "}]"],
] as const) {
	test(`large structural index inputs stay bounded across depth: ${name}`, async () => {
		for (const depth of [4, 64]) {
			const shell = open.repeat(depth);
			const tail = close.repeat(depth);
			const leaf = ":local v 1; :put $v;";
			const budget = 60 * 1024 - shell.length - tail.length;
			const body = leaf.repeat(Math.floor(budget / leaf.length));
			const text = shell + body.padEnd(budget, " ") + tail;
			expect(text.length).toBe(60 * 1024);
			const braces = spyOn(scopeBrace, "braceStartsStatements");
			const scopes = spyOn(scopeBrace, "scopeNameFromMasked");
			const hashes = spyOn(scopeBrace, "hashStartsHardError");
			try {
				const result = await explainCommand(text, { tokens: true, curl: true });
				expect(result.structure.statements.length).toBeGreaterThan(0);
				expect(result.tokens?.length).toBeGreaterThan(0);
				const inputs = new Set(
					[...braces.mock.calls, ...scopes.mock.calls, ...hashes.mock.calls]
						.map(([source]) => source)
						.filter((source) => source.length >= text.length / 2),
				);
				const bytes = [...inputs].reduce(
					(sum, source) => sum + source.length,
					0,
				);
				expect(bytes).toBeGreaterThanOrEqual(text.length);
				// Original and comment-masked document plus one boundary-local view
				// are permitted. A single per-level reader exceeds this at depth 64.
				expect(bytes).toBeLessThanOrEqual(text.length * 3);
			} finally {
				braces.mockRestore();
				scopes.mockRestore();
				hashes.mockRestore();
			}
		}
	}, 20_000);
}
