/**
 * Assembles the static tree GitHub Pages deploys.
 *
 * Two sources, both already generated elsewhere:
 *   - `docs/api/` — the typedoc API reference (`bun run build:doc:api`).
 *   - `docs/errors/**\/*.md` — the per-code error pages.
 *
 * `docs/errors/README.md` documents a load-bearing contract: every
 * `CentrsError` carries `details_url: https://tikoci.dev/centrs/errors/<code>/`,
 * an **extensionless** URL. That's why each error page becomes
 * `errors/<code>/index.html` (a directory, so the extensionless path resolves
 * to its index file) rather than `errors/<code>.html`. Until this script and
 * the Pages workflow existed, that URL was live in shipped error objects but
 * 404'd — this is fixing a real (if minor) product contract, not just adding
 * a docs nicety.
 *
 * Links inside the error pages are written for GitHub; `./pages-links.ts`
 * rewrites them for the served tree, and the build fails on any relative link
 * that names no file in it. The catalog index (`errors/index.html`) lists every
 * code in `errorCatalog` with its summary, above the README's prose.
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
import { errorCatalog } from "../src/core/error-catalog.ts";
import { brokenLinks, rewriteHtmlLinks, siteDirFor } from "./pages-links.ts";

const outDir = process.argv[2] ?? "";
if (outDir === "") {
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
const written: { siteDir: string; html: string }[] = [];
async function writePage(siteDir: string, html: string): Promise<void> {
	await mkdir(join(outDir, siteDir), { recursive: true });
	await writeFile(join(outDir, siteDir, "index.html"), html);
	written.push({ siteDir, html });
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function catalogTable(): string {
	const rows = [...errorCatalog]
		.sort((a, b) => a.code.localeCompare(b.code))
		.map(
			({ code, summary }) =>
				`<tr><td><a href="./${code}/"><code>${code}</code></a></td><td>${escapeHtml(summary)}</td></tr>`,
		);
	return `<h1>Error codes</h1>
<p>${errorCatalog.length} codes. Every <code>details_url</code> a centrs error carries points at one of these pages.</p>
<table>
<thead><tr><th>Code</th><th>Summary</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>
`;
}

let errorPages = 0;
const glob = new Glob("**/*.md");
for await (const relPath of glob.scan({ cwd: ERRORS_DIR })) {
	const srcPath = join(ERRORS_DIR, relPath);
	const bodyHtml = rewriteHtmlLinks(
		await $`pandoc ${srcPath} -f gfm -t html`.text(),
		relPath,
	);
	const siteDir = siteDirFor(relPath);

	if (relPath === "README.md") {
		await writePage(
			siteDir,
			layout("Error catalog", catalogTable() + bodyHtml, "../"),
		);
		continue;
	}

	const code = relPath.replace(/\.md$/, "");
	const rootHref = "../".repeat(code.split("/").length + 1); // + "errors/" itself
	await writePage(siteDir, layout(code, bodyHtml, rootHref));
	errorPages += 1;
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
<li><a href="./errors/index.html">Error code catalog</a> (${errorPages} codes)</li>
</ul>
</main>
</body>
</html>
`,
);

const broken = written.flatMap(({ siteDir, html }) =>
	brokenLinks(html, siteDir, outDir).map((href) => `${siteDir}: ${href}`),
);
if (broken.length > 0) {
	console.error(`Broken links in the assembled site:\n${broken.join("\n")}`);
	process.exit(1);
}

console.log(`Built Pages site at ${outDir}: api/ + ${errorPages} error pages.`);
