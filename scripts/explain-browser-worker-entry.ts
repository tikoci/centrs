/**
 * The browser consumer itself (#312) — the source that is BUNDLED and then run
 * as the Worker.
 *
 * This file is never executed as TypeScript. `explain-browser-consumer.ts`
 * bundles it with `--target browser`, wraps the output in a function that
 * shadows every host global, and spawns *that bundle* as the Worker. So the
 * artifact under test is the browser build itself, polyfill substitutions
 * included — not `src/explain.ts` re-imported under a different name.
 *
 * Why the shadowing is baked into the bundle rather than applied here: `Bun` is
 * a non-configurable global, so `delete globalThis.Bun` throws and the absence
 * has to be created lexically. Wrapping at build time does that without any
 * `eval`/`new Function` in the harness, and has the better property that the
 * shipped bundle text is what demonstrates the independence.
 *
 * Communication is one-way on purpose. The cases are compiled in from
 * `explain-browser-cases.ts`, so there is no inbound `onmessage` handler to
 * accept work from — the worker computes and posts once.
 *
 * The analysis is imported through the PUBLISHED subpath
 * `@tikoci/centrs/explain`, not through `../src/explain.ts`. Importing the
 * source directly would leave this gate green while a typo in `package.json`'s
 * `exports` map broke every real consumer — the entry is what is being proven,
 * so the entry is what must resolve.
 */

import { explainCommand, resolveExplainFormat } from "@tikoci/centrs/explain";
import {
	BROWSER_CONSUMER_CASES,
	caseOptions,
} from "./explain-browser-cases.ts";

declare const self: { postMessage: (value: unknown) => void };

// Declared so `typeof` below type-checks. This is NOT an import and emits
// nothing: at runtime the name resolves to the bundler-emitted wrapper's
// parameter of the same name, which is exactly what the check measures.
declare const process: unknown;

/**
 * Which host globals were still reachable from inside the bundle.
 *
 * The shadowing is the whole host-independence claim, so it is MEASURED here
 * rather than asserted by the build step: if the banner stopped being emitted,
 * or a bundler upgrade changed how it wraps, this list stops being empty and
 * the driver fails.
 *
 * Only `Bun` and `process` are probed, because they are the only two of the
 * seven shadowed names a bundle can still observe. The other five are resolved
 * at BUILD time, and probing them measures the bundler rather than the runtime:
 *
 *   - `require` — Bun constant-folds `typeof require` to the literal
 *     `"function"`, so the check answers before the code ever runs.
 *   - `__dirname` / `__filename` — mentioning either makes Bun INJECT
 *     `var __dirname = "<build machine absolute path>"` into the bundle, which
 *     both shadows the wrapper parameter and bakes a local filesystem path into
 *     the output. The probe would be causing the condition it reports.
 *   - `module` / `exports` — mentioning either classifies this file as
 *     CommonJS, and the resulting top-level `export default require_…()` is a
 *     syntax error inside the wrapper.
 *
 * All seven stay shadowed by the wrapper regardless; this is about which ones
 * can be honestly verified from in here. `typeof` never throws on an undeclared
 * name, so a name that is genuinely absent and one that is shadowed both read
 * as absent — the property a browser has.
 */
const reachableHostGlobals = (
	[
		["Bun", typeof Bun],
		["process", typeof process],
	] as const
)
	.filter(([, kind]) => kind !== "undefined")
	.map(([name]) => name);

/**
 * The settings ladder's default parameter, evaluated INSIDE the bundle.
 *
 * `resolveExplainFormat`'s `env` default is `hostEnv()`, which exists because a
 * bare `Bun.env` default is evaluated on the first call and `Bun` does not
 * exist here. Nothing else in this file reaches that parameter, so a regression
 * back to `Bun.env` would leave every case below green while a browser caller
 * of this exported function got a `TypeError` — calling it with no `env` is
 * what makes the guard load-bearing in the gate.
 */
const defaultFormat = resolveExplainFormat(undefined).value;

try {
	self.postMessage({
		ok: true,
		reachableHostGlobals,
		defaultFormat,
		// Serialized here so the comparison is over bytes that crossed the thread
		// boundary, not over an object the structured clone might have reshaped.
		results: BROWSER_CONSUMER_CASES.map((testCase) =>
			JSON.stringify(explainCommand(testCase.input, caseOptions(testCase))),
		),
	});
} catch (error) {
	self.postMessage({
		ok: false,
		error:
			error instanceof Error
				? `${error.message}\n${error.stack}`
				: String(error),
	});
}
