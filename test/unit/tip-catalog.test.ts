import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { buildTip } from "../../src/core/envelope.ts";
import {
	TIPS_BASE_URL,
	tipCatalog,
	tipDetailsUrl,
} from "../../src/core/tip-catalog.ts";

const ROOT = join(import.meta.dir, "..", "..");
const TIPS_DIR = join(ROOT, "docs", "tips");

/** Every `"tip/…"` string literal under `src/`, outside the catalog itself. */
async function tipLiteralsInSource(): Promise<Set<string>> {
	const found = new Set<string>();
	for await (const rel of new Glob("**/*.ts").scan(join(ROOT, "src"))) {
		if (rel.endsWith("tip-catalog.ts")) continue;
		const text = await Bun.file(join(ROOT, "src", rel)).text();
		for (const [, code] of text.matchAll(/["'`](tip\/[a-z0-9-]+)["'`]/g)) {
			if (code) found.add(code);
		}
	}
	return found;
}

describe("tip catalog (#659)", () => {
	test("every emitted tip code is catalogued, and every entry is emitted", async () => {
		const emitted = await tipLiteralsInSource();
		const catalogued = new Set<string>(tipCatalog.map((t) => t.code));
		expect([...emitted].filter((c) => !catalogued.has(c)).sort()).toEqual([]);
		expect([...catalogued].filter((c) => !emitted.has(c)).sort()).toEqual([]);
	});

	test("a tip with page: true has docs/tips/<slug>.md, and every page is flagged", () => {
		for (const { code, page } of tipCatalog) {
			const file = join(TIPS_DIR, `${code.slice("tip/".length)}.md`);
			expect({ code, page: existsSync(file) }).toEqual({ code, page });
		}
	});

	test("buildTip carries a detailsUrl only for a tip with a page", () => {
		for (const { code, page } of tipCatalog) {
			const tip = buildTip(code, "m", "f");
			expect(tip.detailsUrl).toBe(
				page ? `${TIPS_BASE_URL}${code.slice("tip/".length)}/` : undefined,
			);
			expect(tipDetailsUrl(code)).toBe(tip.detailsUrl);
			expect("detailsUrl" in tip).toBe(page);
		}
	});
});
