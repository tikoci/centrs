import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssembledSite, assembleSite } from "../../scripts/pages-site.ts";
import { errorCatalog } from "../../src/core/error-catalog.ts";
import { tipCatalog, tipDetailsUrl } from "../../src/core/tip-catalog.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SITE_BASE_URL = "https://tikoci.dev/centrs/";

/**
 * Assembles the real Pages tree with `Bun.markdown` standing in for pandoc, so
 * every PR proves the URLs centrs emits resolve to a published page (#659).
 */
describe("Pages site assembly (#659)", () => {
	let outDir = "";
	let site: AssembledSite;

	beforeAll(async () => {
		outDir = mkdtempSync(join(tmpdir(), "centrs-site-"));
		site = await assembleSite({
			root: ROOT,
			outDir,
			render: async (srcPath) =>
				Bun.markdown.html(await Bun.file(srcPath).text()),
		});
	});

	/** The assembled file an extensionless site URL serves. */
	function servedFile(url: string): string {
		expect(url.startsWith(SITE_BASE_URL)).toBe(true);
		return join(outDir, url.slice(SITE_BASE_URL.length), "index.html");
	}

	test("every tip detailsUrl resolves to an assembled tips/<slug>/index.html", () => {
		const missing: string[] = [];
		let linked = 0;
		for (const { code } of tipCatalog) {
			const url = tipDetailsUrl(code);
			if (url === undefined) continue;
			linked += 1;
			if (!existsSync(servedFile(url))) missing.push(url);
		}
		expect(missing).toEqual([]);
		expect(site.tipPages.length).toBe(linked);
	});

	test("every error code's page is assembled at errors/<code>/index.html", () => {
		const missing = errorCatalog
			.map(({ code }) => `${SITE_BASE_URL}errors/${code}/`)
			.filter((url) => !existsSync(servedFile(url)));
		expect(missing).toEqual([]);
		expect(site.errorPages).toBe(errorCatalog.length);
	});

	test("no link in the assembled site is broken", () => {
		expect(site.broken).toEqual([]);
	});
});
