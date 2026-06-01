import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import {
	errorCatalog,
	errorCatalogCodes,
} from "../../src/core/error-catalog.ts";

const ERRORS_DIR = join(import.meta.dir, "..", "..", "docs", "errors");

function pagePathForCode(code: string): string {
	return join(ERRORS_DIR, `${code}.md`);
}

/** All error pages on disk, as `family/slug` codes (README excluded). */
function pagesOnDisk(): string[] {
	const glob = new Glob("**/*.md");
	const codes: string[] = [];
	for (const rel of glob.scanSync({ cwd: ERRORS_DIR })) {
		if (rel === "README.md") {
			continue;
		}
		codes.push(rel.replace(/\.md$/, ""));
	}
	return codes;
}

describe("error pages", () => {
	test("every catalog code has a page whose H1 names the code", () => {
		const missing: string[] = [];
		for (const { code } of errorCatalog) {
			let text: string;
			try {
				text = readFileSync(pagePathForCode(code), "utf8");
			} catch {
				missing.push(code);
				continue;
			}
			const firstLine = text.split("\n", 1)[0] ?? "";
			expect(firstLine).toBe(`# \`${code}\``);
		}
		expect(missing).toEqual([]);
	});

	test("no page is orphaned (every page maps to a catalog code)", () => {
		const orphans = pagesOnDisk().filter(
			(code) => !errorCatalogCodes.has(code),
		);
		expect(orphans).toEqual([]);
	});
});
