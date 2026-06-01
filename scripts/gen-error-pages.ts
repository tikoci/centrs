#!/usr/bin/env bun
/**
 * Generate the per-code error pages under `docs/errors/<code>.md` from the
 * single error catalog (`src/core/error-catalog.ts`).
 *
 * The constitution requires one human page per error code; `errorCatalog` is
 * the source of truth and this script materializes a stub for any code that has
 * no page yet. It NEVER overwrites an existing page, so hand-enriched pages
 * (e.g. `routeros/unknown-path.md`) are preserved — run it after adding a new
 * code to scaffold its page, then enrich by hand.
 *
 * Usage: `bun run docs:errors`
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorCatalog } from "../src/core/error-catalog.ts";

const ERRORS_DIR = join(import.meta.dir, "..", "docs", "errors");

function stubBody(code: string, summary: string): string {
	return `# \`${code}\`

${summary}

## Fix

See [\`docs/CONSTITUTION.md\`](../../CONSTITUTION.md) for the centrs error
contract. This stub will be expanded with the typical trigger and remediation
for \`${code}\`.
`;
}

let created = 0;
let skipped = 0;
for (const { code, summary } of errorCatalog) {
	const path = join(ERRORS_DIR, `${code}.md`);
	if (await Bun.file(path).exists()) {
		skipped += 1;
		continue;
	}
	await mkdir(dirname(path), { recursive: true });
	await Bun.write(path, stubBody(code, summary));
	created += 1;
	console.log(`created docs/errors/${code}.md`);
}

console.log(`\nDone: ${created} created, ${skipped} already present.`);
