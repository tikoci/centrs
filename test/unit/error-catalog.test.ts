import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import {
	detailsUrlForCode,
	ERROR_DETAILS_BASE_URL,
	errorCatalog,
	errorCatalogCodes,
} from "../../src/core/error-catalog.ts";
import { routerOsErrorRules } from "../../src/core/routeros-errors.ts";
import { buildErrorsResource } from "../../src/mcp/resources.ts";

const SRC_DIR = join(import.meta.dir, "..", "..", "src");

/** Families declared in the `CentrsErrorCode` union in `src/errors.ts`. */
const KNOWN_FAMILIES = new Set([
	"auth",
	"cdb",
	"discover",
	"identity",
	"input",
	"internal",
	"mndp",
	"quickchr",
	"routeros",
	"settings",
	"target",
	"tool",
	"transport",
	"usage",
	"validation",
]);

/**
 * Codes built dynamically (not as `code: "..."` literals) and therefore invisible
 * to the source scan below. Keep this list in sync with `mapRouterOsError`'s
 * catch-all ternary in `src/core/routeros-errors.ts`.
 */
const DYNAMIC_CODES = ["routeros/api-trap", "routeros/request-failed"] as const;

function scanLiveCodes(): Set<string> {
	const codes = new Set<string>();
	const pattern = /code:\s*"([a-z]+\/[a-z0-9-]+)"/g;
	const glob = new Glob("**/*.ts");
	for (const rel of glob.scanSync({ cwd: SRC_DIR })) {
		if (rel.endsWith(".test.ts")) {
			continue;
		}
		const text = readFileSync(join(SRC_DIR, rel), "utf8");
		for (const match of text.matchAll(pattern)) {
			if (match[1]) {
				codes.add(match[1]);
			}
		}
	}
	return codes;
}

describe("errorCatalog shape", () => {
	test("has no duplicate codes", () => {
		expect(errorCatalogCodes.size).toBe(errorCatalog.length);
	});

	test("every code is a known family/slug", () => {
		for (const entry of errorCatalog) {
			expect(entry.code).toMatch(/^[a-z]+\/[a-z0-9-]+$/);
			const family = entry.code.split("/")[0] ?? "";
			expect(KNOWN_FAMILIES.has(family)).toBe(true);
			expect(entry.summary.length).toBeGreaterThan(0);
		}
	});

	test("detailsUrlForCode is the stable details URL", () => {
		expect(detailsUrlForCode("routeros/unknown-path")).toBe(
			`${ERROR_DETAILS_BASE_URL}routeros/unknown-path`,
		);
	});
});

describe("errorCatalog covers every live code", () => {
	test("every code: literal in src/ is cataloged", () => {
		const live = scanLiveCodes();
		const missing = [...live].filter((code) => !errorCatalogCodes.has(code));
		expect(missing).toEqual([]);
	});

	test("every routerOsErrorRules code is cataloged", () => {
		const missing = routerOsErrorRules
			.map((rule) => rule.code)
			.filter((code) => !errorCatalogCodes.has(code));
		expect(missing).toEqual([]);
	});

	test("the dynamic catch-all codes are cataloged", () => {
		for (const code of DYNAMIC_CODES) {
			expect(errorCatalogCodes.has(code)).toBe(true);
		}
	});
});

describe("MCP errors resource contract", () => {
	test("exposes the full catalog with stable URLs", () => {
		const resource = buildErrorsResource();
		expect(resource.count).toBe(errorCatalog.length);
		const codes = new Set(resource.errors.map((entry) => entry.code));
		// MCP clients rely on these specifically (see commands/mcp/README.md).
		expect(codes.has("cdb/target-not-registered")).toBe(true);
		expect(codes.has("cdb/write-not-permitted")).toBe(true);
		expect(codes.has("usage/confirmation-required")).toBe(true);
		for (const entry of resource.errors) {
			expect(entry.detailsUrl).toBe(detailsUrlForCode(entry.code));
		}
	});
});
