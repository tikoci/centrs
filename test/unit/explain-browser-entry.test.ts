import { describe, expect, test } from "bun:test";
import {
	BROWSER_CONSUMER_CASES,
	checkBoundary,
	runBrowserConsumerCheck,
	runtimeImports,
	WORKER_TIMEOUT_MS,
} from "../../scripts/explain-browser-consumer.ts";
import { explainCommand } from "../../src/explain.ts";

/**
 * The offline analysis entry's dependency boundary and its consumer proof
 * (#312).
 *
 * `explain`'s value proposition is that the analysis is a LIBRARY capability —
 * usable by an editor, an LSP, a browser inspector — and not a thing that only
 * happens inside the centrs CLI. That claim was false at `49a5db3`: importing
 * `src/explain.ts` pulled `src/execute.ts` and `src/retrieve.ts` in for two
 * pure helpers, and those reach `mac-telnet` (`node:dgram`), `native-api`
 * (`node:crypto`) and `ssh`. A browser build failed on a polyfill four modules
 * away from the cause.
 *
 * Two gates, because either one alone would let a regression through:
 *
 *   - The BOUNDARY gate is static and fails in milliseconds with the offending
 *     EDGE named. It is the one that catches the regression as it is written —
 *     a future `import { … } from "./execute.ts"` added to `explain.ts` for one
 *     more pure helper is exactly how this defect happened the first time.
 *   - The CONSUMER gate bundles for a browser and RUNS it, because compilation
 *     is not proof: a bundler silently substitutes browser polyfills (see
 *     `ALLOWED_BUILTINS` — `node:net`'s `isIP` becomes a regex pair), so only
 *     executing the bundle shows whether the substitute agrees. The bundle is
 *     wrapped at build time in a function shadowing every host global and then
 *     spawned as the Worker, so the artifact under test is the browser build
 *     itself. It compares the whole `ExplainData` — structure, diagnostics,
 *     tokens, spans — field for field against this process's Bun-native
 *     result.
 *
 * Every assertion is mutation-tested rather than assumed:
 *
 *   - re-adding an `./execute.ts` import to `explain.ts` fails the boundary
 *     gate naming `src/protocols/mac-telnet.ts` and the `node:crypto` chain;
 *   - reaching the same module through `export { … } from "./execute.ts"`
 *     instead — a runtime edge an import-only scan does not see — fails it too
 *     (60 modules, seven host builtins);
 *   - truncating `tokens` in the worker entry fails 13 of the 14 cases with the
 *     differing path reported (`tokens-off` has none to truncate);
 *   - dropping the shadowing wrapper reports `Bun, process` as reachable;
 *   - pointing `package.json`'s `exports["./explain"]` at another file fails
 *     the boundary gate naming both paths;
 *   - reverting `resolveExplainFormat`'s `env` default to a bare `Bun.env`
 *     makes the worker throw inside the bundle.
 */
/**
 * Must exceed {@link WORKER_TIMEOUT_MS}: the worker's own timer starts only
 * after the graph walk and the bundle build, so a test timeout at or below it
 * would fire first and replace the specific failure with a generic one.
 */
const TEST_TIMEOUT_MS = WORKER_TIMEOUT_MS * 2;

describe("offline explain entry stays browser-consumable (#312)", () => {
	test("the entry's module graph reaches no transport, CDB, or CLI module", () => {
		const boundary = checkBoundary();

		expect(boundary.violations).toEqual([]);
		// `node:net` is the single tolerated builtin (`isIP`, a pure predicate).
		// A new one here is a boundary regression, not a line to update: the
		// consumer gate below can only price a substitution that has a browser
		// equivalent, which `node:fs` and `node:dgram` do not.
		expect(boundary.builtins).toEqual(["node:net"]);
		// A graph that collapsed to nothing would pass every assertion above.
		expect(boundary.moduleCount).toBeGreaterThan(20);
	});

	/**
	 * The import scanner is what the boundary gate is built on, so a form it
	 * cannot read is a silent false-clean — the gate reports a tidy graph
	 * precisely because it never saw the edge. Biome normalizes this repo to
	 * double quotes and semicolons, so several of these cannot occur in `src/`
	 * today; a gate whose soundness depends on a formatter config staying put is
	 * not sound (CodeRabbit).
	 */
	describe("the import scanner reads every runtime edge form", () => {
		const specifiers = (source: string): string[] =>
			runtimeImports(source).edges.map((e) => e.specifier);

		test("both quote styles and an optional semicolon", () => {
			expect(specifiers('import { x } from "./a.ts";')).toEqual(["./a.ts"]);
			expect(specifiers("import { x } from './a.ts';")).toEqual(["./a.ts"]);
			expect(specifiers('import { x } from "./a.ts"')).toEqual(["./a.ts"]);
			expect(specifiers("import { x } from './a.ts'")).toEqual(["./a.ts"]);
		});

		test("re-exports, star re-exports and bare side-effect imports", () => {
			expect(specifiers('export { x } from "./a.ts";')).toEqual(["./a.ts"]);
			expect(specifiers('export * from "./a.ts";')).toEqual(["./a.ts"]);
			expect(specifiers('import "./a.ts";')).toEqual(["./a.ts"]);
		});

		test("dynamic imports: literal followed, non-literal reported", () => {
			expect(specifiers('await import("./a.ts");')).toEqual(["./a.ts"]);
			const dynamic = runtimeImports("await import(SOME_MODULE);");
			expect(dynamic.edges).toEqual([]);
			expect(dynamic.unmeasured).toHaveLength(1);
			// `import.meta` is not an import and must not be mistaken for one.
			expect(runtimeImports("const d = import.meta.dir;").unmeasured).toEqual(
				[],
			);
		});

		test("type-only edges are excluded because they erase", () => {
			expect(specifiers('import type { X } from "./a.ts";')).toEqual([]);
			expect(specifiers('export type { X } from "./a.ts";')).toEqual([]);
			expect(specifiers('import { type X, type Y } from "./a.ts";')).toEqual(
				[],
			);
			// A mixed clause DOES emit an import, and only the value name counts.
			const mixed = runtimeImports('import { type X, y } from "./a.ts";');
			expect(mixed.edges).toEqual([{ specifier: "./a.ts", names: ["y"] }]);
		});

		test("aliased names report the imported name, not the local one", () => {
			expect(
				runtimeImports('import { isIP as check } from "node:net";').edges,
			).toEqual([{ specifier: "node:net", names: ["isIP"] }]);
		});
	});

	test("the required input classes are all covered", () => {
		const names = BROWSER_CONSUMER_CASES.map((c) => c.name);
		// #312's acceptance names these four classes explicitly; the rest of the
		// corpus is this repo's own additions (astral, BOM, IPv6 for the polyfill).
		expect(names).toContain("normal-command");
		expect(names.some((n) => n.startsWith("multi-statement"))).toBe(true);
		expect(names.some((n) => n.startsWith("malformed-"))).toBe(true);
		expect(names).toContain("unicode");
	});

	test(
		"the browser bundle, run with no host global in scope, matches Bun exactly",
		async () => {
			const report = await runBrowserConsumerCheck();

			const differing = report.cases
				.filter((c) => !c.identical)
				.map((c) => `${c.name}: ${c.detail}`);
			expect(differing).toEqual([]);
			// Measured from INSIDE the bundle, not asserted by the build step: if the
			// shadowing wrapper stopped being emitted, every "identical" above would
			// have been produced with host APIs in reach and would prove nothing.
			expect(report.reachableHostGlobals).toEqual([]);
			// The settings ladder's host-safe default, evaluated where there is no
			// host. Nothing else in the bundle reaches that parameter.
			expect(report.defaultFormat).toBe("text");
			expect(report.cases).toHaveLength(BROWSER_CONSUMER_CASES.length);
			expect(report.ok).toBe(true);
			// The bundle is the real analysis, not an empty module that trivially
			// agrees on nothing.
			expect(report.bundleBytes).toBeGreaterThan(100_000);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"offline analysis never claims runtime acceptance, browser or Bun",
		async () => {
			const writeShaped = BROWSER_CONSUMER_CASES.find(
				(c) => c.name === "normal-write",
			);
			expect(writeShaped).toBeDefined();

			// The three-axis contract's floor (`commands/explain/README.md`): a reading
			// is never an acceptance, and the most tempting case to get wrong is the
			// write-shaped one a consumer might treat as validated.
			const native = explainCommand(writeShaped?.input ?? "", { tokens: true });
			expect(native.runtimeAcceptance).toBe("not-proven");

			// Equality with the native run is what carries that across the boundary: a
			// bundle that dropped or altered the field fails here, not silently.
			const report = await runBrowserConsumerCheck();
			expect(
				report.cases.find((c) => c.name === "normal-write")?.identical,
			).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);
});
