/**
 * Builds the GitHub Pages site: the typedoc API reference, the error pages
 * and the tip pages. The assembly lives in `./pages-site.ts`; this entry point
 * renders markdown with pandoc and fails on any broken link.
 *
 * Requires `pandoc` on PATH for markdown -> HTML (installed via apt in the
 * Pages workflow).
 *
 * Usage: bun run scripts/build-pages-site.ts <outDir>
 */

import { join } from "node:path";
import { $ } from "bun";
import { assembleSite } from "./pages-site.ts";

const outDir = process.argv[2] ?? "";
if (outDir === "") {
	console.error("usage: build-pages-site.ts <outDir>");
	process.exit(1);
}

const ROOT = join(import.meta.dir, "..");

const site = await assembleSite({
	root: ROOT,
	outDir,
	apiDir: join(ROOT, "docs", "api"),
	render: (srcPath) => $`pandoc ${srcPath} -f gfm -t html`.text(),
});

if (site.broken.length > 0) {
	console.error(
		`Broken links in the assembled site:\n${site.broken.join("\n")}`,
	);
	process.exit(1);
}

console.log(
	`Built Pages site at ${outDir}: api/ + ${site.errorPages} error pages + ${site.tipPages.length} tip pages.`,
);
