/**
 * Link handling for the Pages site (`scripts/build-pages-site.ts`, #464).
 *
 * The error pages are written for GitHub: they link siblings as `foo.md` and
 * repo files as `../../CONSTITUTION.md`. On Pages each page is served as
 * `errors/<code>/index.html`, so those links 404. {@link rewriteHref} maps a
 * link to another error page onto that page's site URL, and any other repo file
 * onto its GitHub blob URL. {@link brokenLinks} is the build's own check: a
 * relative href that names no file in the assembled tree fails the build, and
 * so does a GitHub blob URL for this repo whose file does not exist
 * (`repoRoot` given), so a typo is not published as a 404.
 */

import { existsSync, statSync } from "node:fs";
import { join, posix } from "node:path";

export const REPO_BLOB_BASE = "https://github.com/tikoci/centrs/blob/main/";

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The site directory a source page is served from: `errors/<code>/`, or
 * `errors/` for `docs/errors/README.md`. */
export function siteDirFor(errorsRelPath: string): string {
	return errorsRelPath === "README.md"
		? "errors/"
		: `errors/${errorsRelPath.replace(/\.md$/, "")}/`;
}

/**
 * Rewrite one href found in `docs/errors/<errorsRelPath>`. Absolute URLs and
 * fragment-only links are returned unchanged.
 */
export function rewriteHref(href: string, errorsRelPath: string): string {
	if (SCHEME.test(href) || href.startsWith("#") || href.startsWith("/"))
		return href;
	const hashAt = href.indexOf("#");
	const path = hashAt >= 0 ? href.slice(0, hashAt) : href;
	const fragment = hashAt >= 0 ? href.slice(hashAt) : "";
	if (path === "") return href;

	const sourceDir = posix.dirname(posix.join("docs/errors", errorsRelPath));
	const repoPath = posix.normalize(posix.join(sourceDir, path));
	if (repoPath.startsWith("docs/errors/") && repoPath.endsWith(".md")) {
		const target = siteDirFor(repoPath.slice("docs/errors/".length));
		const from = siteDirFor(errorsRelPath);
		const relative = posix.relative(from, target);
		return `${relative === "" ? "." : relative}/${fragment}`;
	}
	return `${REPO_BLOB_BASE}${repoPath}${fragment}`;
}

const HREF = /href="([^"]*)"/g;

/** Apply {@link rewriteHref} to every `href` in a pandoc HTML fragment. */
export function rewriteHtmlLinks(html: string, errorsRelPath: string): string {
	return html.replace(
		HREF,
		(_match, href: string) =>
			`href="${rewriteHref(href.replaceAll("&amp;", "&"), errorsRelPath).replaceAll("&", "&amp;")}"`,
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
 * Relative links in the markdown of `docs/errors/<errorsRelPath>` that name no
 * file in the repo. This is the source-side twin of {@link brokenLinks}: it
 * renders with `Bun.markdown` instead of pandoc, so a unit test can run it on
 * every PR (#659). Rendering first means it sees exactly the navigation links
 * HTML gets — inline and reference links with any title form, and raw
 * `<a href>` — and never a link-shaped string inside code. Fragments are not
 * checked.
 */
export function brokenSourceLinks(
	markdown: string,
	errorsRelPath: string,
	repoRoot: string,
): string[] {
	const broken: string[] = [];
	const sourceDir = posix.dirname(posix.join("docs/errors", errorsRelPath));
	for (const [, raw] of Bun.markdown.html(markdown).matchAll(HREF)) {
		const href = (raw ?? "").replaceAll("&amp;", "&");
		if (SCHEME.test(href) || href.startsWith("#") || href.startsWith("/"))
			continue;
		const path = decodeURI(href.split("#")[0] ?? "");
		if (path === "") continue;
		if (!existsSync(join(repoRoot, posix.join(sourceDir, path))))
			broken.push(href);
	}
	return broken;
}
