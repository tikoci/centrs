/**
 * Bundle entry for the browser consumer proof (#312).
 *
 * `scripts/explain-browser-consumer.ts` bundles THIS file rather than
 * `src/explain.ts` directly, for one reason: the bundled code is executed
 * inside a `new Function` body, where an ESM `export` statement is a syntax
 * error. Assigning the namespace to an injected sink instead leaves a bundle of
 * plain statements, which is what lets the wrapper shadow `Bun`, `process`,
 * `require` and friends as parameters — the shadowing IS the host-independence
 * proof, so it has to wrap the analysis code itself.
 *
 * `__sink` is supplied by that wrapper, never by a module. This file is not
 * part of the package surface and must import nothing but the documented entry:
 * an import added here would be measured as if `src/explain.ts` had it.
 */

import * as explain from "../src/explain.ts";

declare const __sink: { api?: typeof explain };

__sink.api = explain;
