import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	brokenLinks,
	brokenSourceLinks,
	REPO_BLOB_BASE,
	rewriteHref,
	rewriteHtmlLinks,
} from "../../scripts/pages-links.ts";

describe("Pages link rewriting (#464)", () => {
	test("a sibling error page becomes its served directory", () => {
		expect(
			rewriteHref("session-closed.md", "routeros/action-timed-out.md"),
		).toBe("../session-closed/");
		expect(rewriteHref("./outcome-unknown.md#fix", "transport/x.md")).toBe(
			"../outcome-unknown/#fix",
		);
	});

	test("an error page in another family keeps the relative depth", () => {
		expect(rewriteHref("../transport/timeout.md", "routeros/a.md")).toBe(
			"../../transport/timeout/",
		);
	});

	test("the errors README is the catalog index", () => {
		expect(rewriteHref("routeros/unknown-path.md", "README.md")).toBe(
			"routeros/unknown-path/",
		);
		expect(rewriteHref("../README.md", "routeros/a.md")).toBe("../../");
	});

	test("any other repo file goes to GitHub", () => {
		expect(
			rewriteHref("../../CONSTITUTION.md#done", "transport/network.md"),
		).toBe(`${REPO_BLOB_BASE}docs/CONSTITUTION.md#done`);
		expect(rewriteHref("../../src/core/error-catalog.ts", "README.md")).toBe(
			`${REPO_BLOB_BASE}src/core/error-catalog.ts`,
		);
	});

	test("absolute and fragment links are untouched", () => {
		for (const href of ["https://example.com/a.md", "#fix", "mailto:x@y"]) {
			expect(rewriteHref(href, "transport/network.md")).toBe(href);
		}
	});

	test("rewrites every href in pandoc output", () => {
		expect(
			rewriteHtmlLinks(
				'<a href="session-closed.md">a</a> <a href="https://x.test/?a=1&amp;b=2">b</a>',
				"routeros/action-timed-out.md",
			),
		).toBe(
			'<a href="../session-closed/">a</a> <a href="https://x.test/?a=1&amp;b=2">b</a>',
		);
	});

	test("brokenLinks reports a relative href with no file behind it", () => {
		const out = mkdtempSync(join(tmpdir(), "centrs-pages-"));
		mkdirSync(join(out, "errors", "routeros", "session-closed"), {
			recursive: true,
		});
		writeFileSync(
			join(out, "errors", "routeros", "session-closed", "index.html"),
			"",
		);
		const html =
			'<a href="../session-closed/">ok</a><a href="../missing/">bad</a><a href="#x">f</a><a href="https://x.test/">abs</a>';
		expect(brokenLinks(html, "errors/routeros/a/", out)).toEqual([
			"../missing/",
		]);
	});

	test("brokenLinks reports a rewritten repo link whose file does not exist", () => {
		const repo = mkdtempSync(join(tmpdir(), "centrs-repo-"));
		mkdirSync(join(repo, "docs"), { recursive: true });
		writeFileSync(join(repo, "docs", "CONSTITUTION.md"), "");
		const html = rewriteHtmlLinks(
			'<a href="../../CONSTITUTION.md#done">ok</a><a href="../../NO-SUCH-FILE.md">typo</a>',
			"transport/network.md",
		);
		expect(brokenLinks(html, "errors/transport/network/", repo, repo)).toEqual([
			`${REPO_BLOB_BASE}docs/NO-SUCH-FILE.md`,
		]);
	});

	test("brokenSourceLinks sees the navigation links the Pages build sees, and no code (#659)", () => {
		const root = mkdtempSync(join(tmpdir(), "centrs-pages-src-"));
		mkdirSync(join(root, "docs", "errors", "transport"), { recursive: true });
		writeFileSync(join(root, "docs", "errors", "transport", "ok.md"), "");
		const markdown = [
			"[fine](ok.md) [fine-anchor](ok.md#x) [abs](https://x.test/)",
			"[single](gone-single.md 'title') [angle](<gone-angle.md>)",
			"[ref][r]",
			"",
			'[r]: gone-ref.md "title"',
			"",
			'<a href="gone-html.md">html</a>',
			"",
			"`[span](gone-span.md)`",
			"",
			"```",
			"[fence](gone-fence.md)",
			"```",
		].join("\n");
		expect(brokenSourceLinks(markdown, "transport/page.md", root)).toEqual([
			"gone-single.md",
			"gone-angle.md",
			"gone-ref.md",
			"gone-html.md",
		]);
	});
});
