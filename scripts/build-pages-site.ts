/**
 * Assembles the static tree GitHub Pages deploys.
 *
 * Two sources, both already generated elsewhere:
 *   - `docs/api/` — the typedoc API reference (`bun run build:doc:api`).
 *   - `docs/errors/**\/*.md` — the per-code error pages.
 *
 * `docs/errors/README.md` documents a load-bearing contract: every
 * `CentrsError` carries `details_url: https://tikoci.github.io/centrs/errors/<code>`,
 * an **extensionless** URL. That's why each error page becomes
 * `errors/<code>/index.html` (a directory, so the extensionless path resolves
 * to its index file) rather than `errors/<code>.html`. Until this script and
 * the Pages workflow existed, that URL was live in shipped error objects but
 * 404'd — this is fixing a real (if minor) product contract, not just adding
 * a docs nicety.
 *
 * Requires `pandoc` on PATH for markdown -> HTML (installed via apt in the
 * Pages workflow); this script does the tree-walk and page-wrapping, not the
 * markdown parsing.
 *
 * Usage: bun run scripts/build-pages-site.ts <outDir>
 */

import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $, Glob } from "bun";

const outDir = process.argv[2];
if (!outDir) {
	console.error("usage: build-pages-site.ts <outDir>");
	process.exit(1);
}

const ROOT = join(import.meta.dir, "..");
const ERRORS_DIR = join(ROOT, "docs", "errors");
const API_DIR = join(ROOT, "docs", "api");

function layout(title: string, bodyHtml: string, rootHref: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — centrs</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
</head>
<body>
<main class="container">
<p><a href="${rootHref}index.html">&larr; centrs docs</a></p>
${bodyHtml}
</main>
</body>
</html>
`;
}

await mkdir(outDir, { recursive: true });

// API reference — already built by `bun run build:doc:api`.
await cp(API_DIR, join(outDir, "api"), { recursive: true });

// Error pages: docs/errors/<code>.md -> <outDir>/errors/<code>/index.html
const errorLinks: string[] = [];
const glob = new Glob("**/*.md");
for await (const relPath of glob.scan({ cwd: ERRORS_DIR })) {
	const srcPath = join(ERRORS_DIR, relPath);
	const bodyHtml = await $`pandoc ${srcPath} -f gfm -t html`.text();

	if (relPath === "README.md") {
		const destDir = join(outDir, "errors");
		await mkdir(destDir, { recursive: true });
		await writeFile(
			join(destDir, "index.html"),
			layout("Error catalog", bodyHtml, "../"),
		);
		continue;
	}

	const code = relPath.replace(/\.md$/, "");
	const depth = code.split("/").length + 1; // + "errors/" itself
	const rootHref = "../".repeat(depth);
	const destDir = join(outDir, "errors", code);
	await mkdir(destDir, { recursive: true });
	await writeFile(
		join(destDir, "index.html"),
		layout(code, bodyHtml, rootHref),
	);
	errorLinks.push(`<li><a href="./errors/${code}/">${code}</a></li>`);
}

await writeFile(
	join(outDir, "index.html"),
	`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>centrs docs</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
</head>
<body>
<main class="container">
<h1>centrs</h1>
<p><a href="https://github.com/tikoci/centrs">tikoci/centrs</a> generated docs.</p>
<ul>
<li><a href="./api/index.html">API reference (typedoc)</a></li>
<li><a href="./errors/index.html">Error code catalog</a> (${errorLinks.length} codes)</li>
</ul>
</main>
</body>
</html>
`,
);

console.log(
	`Built Pages site at ${outDir}: api/ + ${errorLinks.length} error pages.`,
);
