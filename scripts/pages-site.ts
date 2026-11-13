/**
 * Assembles the static tree GitHub Pages deploys (#464, #659).
 *
 * Three sources:
 *   - `docs/api/` — the typedoc API reference (`bun run build:doc:api`).
 *   - `docs/errors/**\/*.md` — the per-code error pages.
 *   - `docs/tips/*.md` — the pages of tips flagged `page: true` in
 *     `src/core/tip-catalog.ts`.
 *
 * `docs/errors/README.md` documents a load-bearing contract: every
 * `CentrsError` carries `details_url: https://tikoci.dev/centrs/errors/<code>/`,
 * an **extensionless** URL, and a tip with a page carries
 * `https://tikoci.dev/centrs/tips/<slug>/`. That is why each page becomes
 * `<section>/<name>/index.html` (a directory, so the extensionless path
 * resolves to its index file) rather than `<section>/<name>.html`.
 *
 * Links inside the pages are written for GitHub; `./pages-links.ts` rewrites
 * them for the served tree, and {@link assembleSite} reports any relative link
 * that names no file in it. The catalog index (`errors/index.html`) lists
 * every code in `errorCatalog` with its summary, above the README's prose.
 *
 * Markdown rendering is injected: the Pages build passes pandoc
 * (`./build-pages-site.ts`), and the unit test passes `Bun.markdown`, so a PR
 * proves that every published URL resolves without pandoc installed.
 */

import { existsSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Glob } from "bun";
import { errorCatalog } from "../src/core/error-catalog.ts";
import { tipCatalog } from "../src/core/tip-catalog.ts";
import {
	brokenLinks,
	type PagesSection,
	rewriteHtmlLinks,
	siteDirFor,
} from "./pages-links.ts";

export interface AssembleSiteOptions {
	/** Repository root: `docs/errors/` and `docs/tips/` are read from here. */
	root: string;
	/** Directory the site is written into. */
	outDir: string;
	/** Markdown file path → HTML fragment. */
	render: (srcPath: string) => Promise<string>;
	/** typedoc output to copy to `api/`; omitted, the site has no `api/`. */
	apiDir?: string;
}

export interface AssembledSite {
	errorPages: number;
	/** Tip slugs published as `tips/<slug>/`. */
	tipPages: string[];
	/** `<siteDir>: <href>` for every link that names no file. */
	broken: string[];
}

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

function tipsList(slugs: readonly string[]): string {
	if (slugs.length === 0) return "";
	const summaries = new Map<string, string>(
		tipCatalog.map(({ code, summary }) => [code, summary]),
	);
	const items = slugs.map(
		(slug) =>
			`<li><a href="./tips/${slug}/"><code>tip/${slug}</code></a>: ${escapeHtml(summaries.get(`tip/${slug}`) ?? "")}</li>`,
	);
	return `<h2>Tips with a page</h2>
<ul>
${items.join("\n")}
</ul>
`;
}

export async function assembleSite(
	options: AssembleSiteOptions,
): Promise<AssembledSite> {
	const { root, outDir, render } = options;
	await mkdir(outDir, { recursive: true });

	if (options.apiDir !== undefined) {
		await cp(options.apiDir, join(outDir, "api"), { recursive: true });
	}

	const written: { siteDir: string; html: string }[] = [];
	async function writePage(siteDir: string, html: string): Promise<void> {
		await mkdir(join(outDir, siteDir), { recursive: true });
		await writeFile(join(outDir, siteDir, "index.html"), html);
		written.push({ siteDir, html });
	}

	async function renderPage(
		section: PagesSection,
		relPath: string,
	): Promise<{ siteDir: string; bodyHtml: string; rootHref: string }> {
		const bodyHtml = rewriteHtmlLinks(
			await render(join(root, "docs", section, relPath)),
			relPath,
			section,
		);
		const siteDir = siteDirFor(relPath, section);
		const depth = siteDir.split("/").filter(Boolean).length;
		return { siteDir, bodyHtml, rootHref: "../".repeat(depth) };
	}

	// Error pages: docs/errors/<code>.md -> errors/<code>/index.html
	let errorPages = 0;
	for (const relPath of [
		...new Glob("**/*.md").scanSync({ cwd: join(root, "docs", "errors") }),
	]
		.map((rel) => rel.replaceAll("\\", "/"))
		.sort()) {
		const page = await renderPage("errors", relPath);
		if (relPath === "README.md") {
			await writePage(
				page.siteDir,
				layout("Error catalog", catalogTable() + page.bodyHtml, page.rootHref),
			);
			continue;
		}
		await writePage(
			page.siteDir,
			layout(relPath.replace(/\.md$/, ""), page.bodyHtml, page.rootHref),
		);
		errorPages += 1;
	}

	// Tip pages: docs/tips/<slug>.md -> tips/<slug>/index.html
	const tipsDir = join(root, "docs", "tips");
	const tipPages: string[] = [];
	const tipSources = existsSync(tipsDir)
		? [...new Glob("*.md").scanSync({ cwd: tipsDir })]
		: [];
	for (const relPath of tipSources
		.map((rel) => rel.replaceAll("\\", "/"))
		.sort()) {
		const slug = relPath.replace(/\.md$/, "");
		const page = await renderPage("tips", relPath);
		await writePage(
			page.siteDir,
			layout(`tip/${slug}`, page.bodyHtml, page.rootHref),
		);
		tipPages.push(slug);
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
${options.apiDir !== undefined ? '<li><a href="./api/index.html">API reference (typedoc)</a></li>\n' : ""}<li><a href="./errors/index.html">Error code catalog</a> (${errorPages} codes)</li>
</ul>
${tipsList(tipPages)}</main>
</body>
</html>
`,
	);

	const broken = written.flatMap(({ siteDir, html }) =>
		brokenLinks(html, siteDir, outDir, root).map(
			(href) => `${siteDir}: ${href}`,
		),
	);
	return { errorPages, tipPages, broken };
}
