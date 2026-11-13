/**
 * Link handling for the Pages site (`scripts/pages-site.ts`, #464, #659).
 *
 * The site has two page sections: error pages (`docs/errors/`) and tip pages
 * (`docs/tips/`). Both are written for GitHub: they link siblings as `foo.md`
 * and repo files as `../../CONSTITUTION.md`. On Pages each page is served as
 * `<section>/<name>/index.html`, so those links 404. {@link rewriteHref} maps a
 * link to an error or tip page onto that page's site URL, and any other repo
 * file onto its GitHub blob URL. {@link brokenLinks} is the build's own check: a
 * relative href that names no file in the assembled tree fails the build, and
 * so does a GitHub blob URL for this repo whose file does not exist
 * (`repoRoot` given), so a typo is not published as a 404.
 */

import { existsSync, statSync } from "node:fs";
import { join, posix } from "node:path";

export const REPO_BLOB_BASE = "https://github.com/tikoci/centrs/blob/main/";

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A page section of the site: its source is `docs/<section>/`, and it is
 * served under `<section>/`. */
export type PagesSection = "errors" | "tips";

const PAGE_SOURCE = /^docs\/(errors|tips)\/(.+\.md)$/;

/** The site directory a source page is served from: `<section>/<name>/`, or
 * `<section>/` for the section's `README.md`. */
export function siteDirFor(
	relPath: string,
	section: PagesSection = "errors",
): string {
	return relPath === "README.md"
		? `${section}/`
		: `${section}/${relPath.replace(/\.md$/, "")}/`;
}

/**
 * Rewrite one href found in `docs/<section>/<relPath>`. Absolute URLs and
 * fragment-only links are returned unchanged.
 */
export function rewriteHref(
	href: string,
	relPath: string,
	section: PagesSection = "errors",
): string {
	if (SCHEME.test(href) || href.startsWith("#") || href.startsWith("/"))
		return href;
	const hashAt = href.indexOf("#");
	const path = hashAt >= 0 ? href.slice(0, hashAt) : href;
	const fragment = hashAt >= 0 ? href.slice(hashAt) : "";
	if (path === "") return href;

	const sourceDir = posix.dirname(posix.join("docs", section, relPath));
	const repoPath = posix.normalize(posix.join(sourceDir, path));
	const page = repoPath.match(PAGE_SOURCE);
	if (page) {
		const target = siteDirFor(page[2] ?? "", page[1] as PagesSection);
		const from = siteDirFor(relPath, section);
		const relative = posix.relative(from, target);
		return `${relative === "" ? "." : relative}/${fragment}`;
	}
	return `${REPO_BLOB_BASE}${repoPath}${fragment}`;
}

const HREF = /href="([^"]*)"/g;

/** Apply {@link rewriteHref} to every `href` in a rendered HTML fragment. */
export function rewriteHtmlLinks(
	html: string,
	relPath: string,
	section: PagesSection = "errors",
): string {
	return html.replace(
		HREF,
		(_match, href: string) =>
			`href="${rewriteHref(href.replaceAll("&amp;", "&"), relPath, section).replaceAll("&", "&amp;")}"`,
	);
}

/**
 * Relative links in `html` (a page served from `siteDir` under `outDir`) that
 * name no file in the assembled tree. A directory resolves to its
 * `index.html`.
 */
export function brokenLinks(
	html: string,
	siteDir: string,
	outDir: string,
	repoRoot?: string,
): string[] {
	const broken: string[] = [];
	for (const [, raw] of html.matchAll(HREF)) {
		const href = (raw ?? "").replaceAll("&amp;", "&");
		if (href.startsWith(REPO_BLOB_BASE)) {
			const repoPath = href.slice(REPO_BLOB_BASE.length).split("#")[0] ?? "";
			if (repoRoot !== undefined && !existsSync(join(repoRoot, repoPath)))
				broken.push(href);
			continue;
		}
		if (SCHEME.test(href) || href.startsWith("#") || href.startsWith("/"))
			continue;
		const path = href.split("#")[0] ?? "";
		if (path === "") continue;
		const target = posix.join(outDir, siteDir, path);
		const file =
			existsSync(target) && statSync(target).isDirectory()
				? posix.join(target, "index.html")
				: target;
		if (!existsSync(file)) broken.push(href);
	}
	return broken;
}

/**
 * Raw HTML passes through `Bun.markdown` as written, so a source page can hold
 * `<a href='…'>`; pandoc output (the {@link HREF} consumers) is always `"…"`.
 */
const SOURCE_HREF = /href=(?:"([^"]*)"|'([^']*)')/g;

/**
 * Relative links in the markdown of `docs/<section>/<relPath>` that name no
 * file in the repo. This is the source-side twin of {@link brokenLinks}: it
 * renders with `Bun.markdown` instead of pandoc, so a unit test can run it on
 * every PR (#659). Rendering first means it sees exactly the navigation links
 * HTML gets — inline and reference links with any title form, and raw
 * `<a href>` — and never a link-shaped string inside code. Fragments are not
 * checked.
 */
export function brokenSourceLinks(
	markdown: string,
	relPath: string,
	repoRoot: string,
	section: PagesSection = "errors",
): string[] {
	const broken: string[] = [];
	const sourceDir = posix.dirname(posix.join("docs", section, relPath));
	for (const [, double, single] of Bun.markdown
		.html(markdown)
		.matchAll(SOURCE_HREF)) {
		const href = (double ?? single ?? "").replaceAll("&amp;", "&");
		if (SCHEME.test(href) || href.startsWith("#") || href.startsWith("/"))
			continue;
		const path = decodeURI(href.split("#")[0] ?? "");
		if (path === "") continue;
		if (!existsSync(join(repoRoot, posix.join(sourceDir, path))))
			broken.push(href);
	}
	return broken;
}
