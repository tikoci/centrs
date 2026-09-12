#!/usr/bin/env bun
/**
 * Offline-entry boundary gate and browser consumer proof (#312).
 *
 * The offline `explain` analysis is a library capability, and a library
 * capability that only runs under Bun is not one. This checks both halves of
 * that claim:
 *
 *   BOUNDARY — walk the module graph reachable from the documented entry
 *     (`@tikoci/centrs/explain` -> `src/explain.ts`) and fail if it reaches a transport,
 *     a resolver/CDB module, the CLI, or any Node builtin outside
 *     {@link ALLOWED_BUILTINS}. This is the check that names the offending
 *     edge, which a bundler error does not: the defect #312 reported surfaced
 *     as `node:crypto` missing `randomInt`, four modules away from its cause
 *     (`explain.ts -> execute.ts -> mac-telnet-console.ts -> mac-telnet.ts`).
 *
 *   CONSUMER — bundle a worker entry around that module with `--target
 *     browser`, wrap the output in a function that shadows every host global,
 *     spawn THAT BUNDLE as a Worker, and compare its analysis against this
 *     process's Bun-native one, field for field. Compilation is not the proof:
 *     a bundler substitutes browser polyfills silently (see
 *     `ALLOWED_BUILTINS`), so only running the bundled code shows whether the
 *     substituted implementation agrees.
 *
 *     The shadowing is applied at BUILD time, not by evaluating the bundle
 *     inside a wrapper here. `Bun` is a non-configurable global, so the absence
 *     has to be created lexically; doing it in the banner keeps the harness
 *     free of `eval`/`new Function` and makes the shipped bundle text itself
 *     the thing that demonstrates host independence.
 *
 * ```
 * bun run explain:browser-consumer          # report
 * bun run explain:browser-consumer --json   # machine-readable
 * ```
 *
 * ## What this does not claim
 *
 * It does not claim the whole `centrs` package works in a browser — it does
 * not, and is not meant to. It does not run a real browser engine, so it
 * proves host-API independence and output equality, not DOM integration. And
 * {@link BROWSER_CONSUMER_CASES} is a boundary corpus, not a parser-coverage
 * corpus: the measured parser evidence lives in the censuses and the agreement
 * report.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
	type ExplainData,
	explainCommand,
	resolveExplainFormat,
} from "../src/explain.ts";
import {
	BROWSER_CONSUMER_CASES,
	type ConsumerCase,
	caseOptions,
} from "./explain-browser-cases.ts";

export { BROWSER_CONSUMER_CASES, type ConsumerCase };

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = resolve(ROOT, "src/explain.ts");

/** The published subpath the worker entry imports, and this gate measures. */
const PUBLISHED_SUBPATH = "./explain";

/**
 * Node builtins the offline entry may reach, and why each one is tolerable.
 *
 * `node:net` is here for `isIP` in `src/explain/values.ts` — a pure predicate
 * with no socket in it. A bundler replaces the whole module with a regex
 * polyfill, so the browser build runs a DIFFERENT `isIP` than Bun does; that
 * substitution is exactly what the consumer comparison is for, and
 * {@link BROWSER_CONSUMER_CASES} carries address-shaped inputs on purpose.
 *
 * Anything else reaching this list is a boundary regression, not a new entry to
 * add: a builtin that polyfills to a stub (`node:fs`) or throws (`node:dgram`)
 * cannot be checked the way `isIP` is.
 */
const ALLOWED_BUILTINS = new Set(["node:net"]);

/** Directories the offline entry must never reach, with the reason for each. */
const FORBIDDEN_PREFIXES: readonly { prefix: string; why: string }[] = [
	{ prefix: "src/protocols/", why: "transport implementation" },
	{ prefix: "src/resolver/index.ts", why: "CDB/settings resolution barrel" },
	{ prefix: "src/cli/", why: "CLI surface" },
	{ prefix: "src/mcp", why: "MCP server surface" },
];

/** Module-graph walk: every runtime import reachable from `entry`. */
function reachableGraph(entry: string): {
	modules: string[];
	builtins: { specifier: string; chain: string[] }[];
	unresolvedDynamic: number;
} {
	const seen = new Map<string, string[]>();
	const builtins: { specifier: string; chain: string[] }[] = [];
	let unresolvedDynamic = 0;
	const visit = (file: string, chain: string[]): void => {
		if (seen.has(file)) return;
		seen.set(file, chain);
		const read = runtimeImports(file);
		unresolvedDynamic += read.unresolvedDynamic;
		for (const specifier of read.specifiers) {
			if (!specifier.startsWith(".")) {
				if (specifier.startsWith("node:") || specifier === "bun")
					builtins.push({
						specifier,
						chain: [...chain, file].map((f) => relative(ROOT, f)),
					});
				continue;
			}
			const target = resolve(dirname(file), specifier);
			if (existsSync(target)) visit(target, [...chain, file]);
		}
	};
	visit(entry, []);
	return {
		modules: [...seen.keys()].map((f) => relative(ROOT, f)).sort(),
		builtins,
		unresolvedDynamic,
	};
}

/**
 * Module specifiers `file` pulls in AT RUNTIME.
 *
 * Four forms carry a runtime edge, and missing any one leaves the gate blind:
 * `import … from "x"`, a bare side-effect `import "x"`, a re-export
 * `export {…}/* from "x"` (this repo has one inside the explain tree —
 * `explain/verbsplit.ts` re-exports `verbs.ts`, which an import-only scan does
 * not see), and a dynamic `import("x")` with a literal specifier.
 *
 * Type-only edges are excluded because they ERASE: `import type {…}`,
 * `export type {…}`, and a clause whose every specifier is `type`-prefixed
 * produce no emitted import. Counting them would fail the gate on edges that do
 * not exist — `src/core/envelope.ts` names `RouterOsProtocol` from the
 * protocols barrel that way, and always has.
 *
 * A dynamic import with a NON-literal specifier cannot be resolved statically;
 * {@link DYNAMIC_IMPORT_UNRESOLVED} reports it rather than passing silently.
 */
function runtimeImports(file: string): {
	specifiers: string[];
	unresolvedDynamic: number;
} {
	const source = readFileSync(file, "utf8");
	const specifiers: string[] = [];

	// `import …/export … from "x"` — skip `import type`/`export type` outright,
	// then skip an all-`type` specifier clause.
	const fromPattern =
		/^(?:import|export)\s+(type\s+)?([\s\S]*?)from\s+"([^"]+)";/gm;
	for (
		let match = fromPattern.exec(source);
		match !== null;
		match = fromPattern.exec(source)
	) {
		if (match[1]) continue;
		const names = (match[2] ?? "")
			.replace(/[{}]/g, "")
			.split(",")
			.map((n) => n.trim())
			.filter(Boolean);
		// `export * from "x"` has no named clause and is always a runtime edge.
		if (names.length > 0 && names.every((n) => n.startsWith("type "))) continue;
		specifiers.push(match[3] ?? "");
	}

	// Bare side-effect `import "x";`.
	const barePattern = /^import\s+"([^"]+)";/gm;
	for (
		let match = barePattern.exec(source);
		match !== null;
		match = barePattern.exec(source)
	) {
		specifiers.push(match[1] ?? "");
	}

	// Dynamic `import("x")`, literal only. `import.meta` is not an import.
	let unresolvedDynamic = 0;
	const dynamicPattern = /(?<!\.)\bimport\s*\(\s*([^)]*?)\s*\)/g;
	for (
		let match = dynamicPattern.exec(source);
		match !== null;
		match = dynamicPattern.exec(source)
	) {
		const argument = (match[1] ?? "").trim();
		const literal = /^"([^"]+)"$/.exec(argument);
		if (literal) specifiers.push(literal[1] ?? "");
		else if (argument.length > 0) unresolvedDynamic++;
	}

	return { specifiers, unresolvedDynamic };
}

export interface BoundaryReport {
	moduleCount: number;
	violations: string[];
	builtins: string[];
}

/** The BOUNDARY half: does the entry's graph stay offline and host-free? */
export function checkBoundary(): BoundaryReport {
	const { modules, builtins, unresolvedDynamic } = reachableGraph(ENTRY);
	const violations: string[] = [];
	for (const module of modules) {
		const hit = FORBIDDEN_PREFIXES.find((f) => module.startsWith(f.prefix));
		if (hit) violations.push(`${module} — ${hit.why}`);
	}
	for (const { specifier, chain } of builtins) {
		if (ALLOWED_BUILTINS.has(specifier)) continue;
		violations.push(`${specifier} — host builtin, via ${chain.join(" -> ")}`);
	}
	// The gate measures ENTRY, but consumers import the PUBLISHED subpath. If the
	// two drift — a typo in `exports`, a moved file — every check below stays
	// green while `@tikoci/centrs/explain` fails to resolve for everyone else.
	const manifest = JSON.parse(
		readFileSync(resolve(ROOT, "package.json"), "utf8"),
	) as { exports?: Record<string, string> };
	const published = manifest.exports?.[PUBLISHED_SUBPATH];
	if (published === undefined)
		violations.push(
			`package.json exports has no "${PUBLISHED_SUBPATH}" entry — the documented entry is not importable`,
		);
	else if (resolve(ROOT, published) !== ENTRY)
		violations.push(
			`package.json exports "${PUBLISHED_SUBPATH}" is ${published}, but this gate measures ${relative(ROOT, ENTRY)}`,
		);

	// A specifier the walk cannot resolve is a hole in the gate, not a pass.
	if (unresolvedDynamic > 0)
		violations.push(
			`${unresolvedDynamic} dynamic import(s) with a non-literal specifier — ` +
				"the graph below them is unmeasured",
		);
	return {
		moduleCount: modules.length,
		violations,
		builtins: [...new Set(builtins.map((b) => b.specifier))].sort(),
	};
}

/**
 * The host globals the bundle is denied.
 *
 * Shadowed as parameters of a wrapper function the bundler emits around the
 * whole bundle, so a bare `Bun`/`process`/`require` inside it reads `undefined`
 * instead of this runtime's real one. `self` is deliberately absent: the worker
 * posts its result through it, and a browser Worker has it too.
 */
const SHADOWED_GLOBALS = [
	"Bun",
	"process",
	"require",
	"module",
	"exports",
	"__dirname",
	"__filename",
] as const;

/**
 * Build the worker entry for a browser, wrapped so every host global is out of
 * scope, and write it where a `Worker` can be pointed at it.
 *
 * The wrapper is a banner/footer pair rather than a runtime `new Function`:
 * same lexical shadowing, no `eval` in the harness, and the property that the
 * bundle ON DISK is the artifact that demonstrates host independence.
 */
async function buildBrowserWorkerBundle(
	directory: string,
): Promise<{ path: string; bytes: number }> {
	const entry = resolve(ROOT, "scripts/explain-browser-worker-entry.ts");
	const built = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "esm",
		banner: `(function (${SHADOWED_GLOBALS.join(", ")}) {`,
		footer: "})();",
	});
	if (!built.success)
		throw new Error(
			`browser build failed:\n${built.logs
				.map(
					(l) =>
						`${l.message}${l.position ? ` (${l.position.file}:${l.position.line})` : ""}`,
				)
				.join("\n")}`,
		);
	const output = built.outputs[0];
	if (output === undefined) throw new Error("browser build produced no output");
	const code = await output.text();
	// The wrapper is a function body, which cannot hold a top-level `export`.
	// Bun emits one when it classifies the entry as CommonJS — which merely
	// MENTIONING `module`/`exports` is enough to trigger. Caught here because the
	// alternative is a bare "SyntaxError: Unexpected export" from the Worker with
	// nothing pointing at the cause.
	if (/^export\s/m.test(code))
		throw new Error(
			"browser bundle emitted a top-level export, which cannot sit inside the " +
				"host-shadowing wrapper. Check whether the worker entry mentions " +
				"`module`/`exports` and so was classified as CommonJS.",
		);
	const path = join(directory, "explain-browser-bundle.js");
	await Bun.write(path, code);
	return { path, bytes: code.length };
}

export interface ConsumerResult {
	name: string;
	identical: boolean;
	/** First differing path, in `$.a[0].b` form, when the two disagree. */
	detail?: string;
}

export interface ConsumerReport {
	boundary: BoundaryReport;
	bundleBytes: number;
	/**
	 * Host globals the bundle could still see, measured from inside it. Empty is
	 * the contract; a non-empty list means the shadowing silently stopped working
	 * and every case reported "identical" was produced with host APIs in reach.
	 */
	reachableHostGlobals: string[];
	/**
	 * `resolveExplainFormat(undefined).value` as computed INSIDE the bundle,
	 * where there is no host environment. Must match the Bun-native value under
	 * an explicitly empty env; a mismatch or a thrown worker means the settings
	 * ladder's default parameter stopped being host-safe.
	 */
	defaultFormat: string;
	cases: ConsumerResult[];
	ok: boolean;
}

/**
 * Run the browser bundle as a Worker and collect what it posts.
 *
 * One-way: the cases are compiled into the bundle, so there is no inbound
 * message handler and nothing this side sends can influence what executes.
 * Handlers are attached in the same synchronous block as the construction, so
 * the worker's single message cannot be missed.
 */
async function runBundleInWorker(bundlePath: string): Promise<{
	results: string[];
	reachableHostGlobals: string[];
	defaultFormat: string;
}> {
	const worker = new Worker(bundlePath);
	try {
		return await new Promise<{
			results: string[];
			reachableHostGlobals: string[];
			defaultFormat: string;
		}>((settle, fail) => {
			const timer = setTimeout(
				() => fail(new Error("browser consumer worker timed out after 60s")),
				60_000,
			);
			worker.onmessage = (event: MessageEvent) => {
				clearTimeout(timer);
				const data = event.data as {
					ok: boolean;
					results?: string[];
					reachableHostGlobals?: string[];
					defaultFormat?: string;
					error?: string;
				};
				if (!data.ok) fail(new Error(data.error ?? "worker reported failure"));
				else
					settle({
						results: data.results ?? [],
						reachableHostGlobals: data.reachableHostGlobals ?? [],
						defaultFormat: data.defaultFormat ?? "",
					});
			};
			worker.onerror = (event: ErrorEvent) => {
				clearTimeout(timer);
				fail(new Error(String(event.message ?? event)));
			};
		});
	} finally {
		worker.terminate();
	}
}

/** First path at which two parsed analyses differ, or null when identical. */
function firstDifference(a: unknown, b: unknown, path = "$"): string | null {
	if (Object.is(a, b)) return null;
	if (typeof a !== typeof b || a === null || b === null)
		return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length)
			return `${path}.length: ${a.length} vs ${b.length}`;
		for (let i = 0; i < a.length; i++) {
			const inner = firstDifference(a[i], b[i], `${path}[${i}]`);
			if (inner) return inner;
		}
		return null;
	}
	if (typeof a === "object" && typeof b === "object") {
		const keys = [
			...new Set([...Object.keys(a as object), ...Object.keys(b as object)]),
		];
		for (const key of keys) {
			const inner = firstDifference(
				(a as Record<string, unknown>)[key],
				(b as Record<string, unknown>)[key],
				`${path}.${key}`,
			);
			if (inner) return inner;
		}
		return null;
	}
	return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

/**
 * Boundary gate plus executed consumer comparison.
 *
 * The corpus is not a parameter: {@link BROWSER_CONSUMER_CASES} is compiled
 * into the bundle as well as read here, which is what makes both sides provably
 * the same list. A caller wanting another input adds it there.
 */
export async function runBrowserConsumerCheck(): Promise<ConsumerReport> {
	const boundary = checkBoundary();
	// Report the offending EDGE before bundling. A boundary break also breaks the
	// build, but as a polyfill complaint several modules away from its cause
	// (#312's own symptom), so letting the bundler fail first would throw away
	// the one diagnostic this gate exists to produce.
	if (boundary.violations.length > 0)
		return {
			boundary,
			bundleBytes: 0,
			reachableHostGlobals: [],
			defaultFormat: "",
			cases: [],
			ok: false,
		};

	const directory = mkdtempSync(join(tmpdir(), "centrs-explain-browser-"));
	let bundled: string[];
	let reachableHostGlobals: string[];
	let defaultFormat: string;
	let bundleBytes: number;
	try {
		const bundle = await buildBrowserWorkerBundle(directory);
		bundleBytes = bundle.bytes;
		const run = await runBundleInWorker(bundle.path);
		bundled = run.results;
		reachableHostGlobals = run.reachableHostGlobals;
		defaultFormat = run.defaultFormat;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}

	const results: ConsumerResult[] = BROWSER_CONSUMER_CASES.map(
		(testCase, index) => {
			const native: ExplainData = explainCommand(
				testCase.input,
				caseOptions(testCase),
			);
			const nativeJson = JSON.stringify(native);
			const bundledJson = bundled[index] ?? "";
			if (nativeJson === bundledJson)
				return { name: testCase.name, identical: true };
			const detail =
				firstDifference(native, JSON.parse(bundledJson || "null")) ??
				"serialized forms differ with no structural difference (key order)";
			return { name: testCase.name, identical: false, detail };
		},
	);
	// A short reply would otherwise score as "everything matched".
	if (bundled.length !== BROWSER_CONSUMER_CASES.length)
		throw new Error(
			`worker returned ${bundled.length} results for ${BROWSER_CONSUMER_CASES.length} cases`,
		);
	// A browser has no environment, so the native comparison uses an empty one.
	const nativeDefaultFormat = resolveExplainFormat(undefined, {}).value;
	return {
		boundary,
		bundleBytes,
		reachableHostGlobals,
		defaultFormat,
		cases: results,
		ok:
			reachableHostGlobals.length === 0 &&
			defaultFormat === nativeDefaultFormat &&
			results.every((r) => r.identical),
	};
}

function render(report: ConsumerReport): string {
	const lines = [
		"# explain offline entry — browser consumer check (#312)",
		"",
		`entry: src/explain.ts  |  modules reachable: ${report.boundary.moduleCount}`,
		`host builtins reached: ${report.boundary.builtins.join(", ") || "none"}`,
		`browser bundle: ${(report.bundleBytes / 1024).toFixed(1)} KiB`,
		`host globals reachable from inside the bundle: ${report.reachableHostGlobals.join(", ") || "none"}`,
		`settings default resolved inside the bundle: ${report.defaultFormat || "(not run)"}`,
		"",
	];
	if (report.boundary.violations.length > 0) {
		lines.push("## boundary violations", "");
		for (const violation of report.boundary.violations)
			lines.push(`- ${violation}`);
		lines.push("");
	}
	if (report.cases.length === 0) {
		lines.push(
			"consumer cases not run — the boundary gate failed first.",
			"",
			"FAIL",
		);
		return lines.join("\n");
	}
	lines.push(
		"## consumer cases",
		"",
		"| case | bundled vs native |",
		"| --- | --- |",
	);
	for (const result of report.cases)
		lines.push(
			`| ${result.name} | ${result.identical ? "identical" : `DIFFERS — ${result.detail}`} |`,
		);
	lines.push("", report.ok ? "PASS" : "FAIL");
	return lines.join("\n");
}

async function main(args: readonly string[]): Promise<number> {
	const report = await runBrowserConsumerCheck();
	const out = args.includes("--json")
		? JSON.stringify(report, null, "\t")
		: render(report);
	await Bun.write(Bun.stdout, `${out}\n`);
	return report.ok ? 0 : 1;
}

if (import.meta.main) {
	main(Bun.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(
				`::error title=explain browser consumer::${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		});
}
