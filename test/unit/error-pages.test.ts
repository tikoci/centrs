import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { brokenSourceLinks } from "../../scripts/pages-links.ts";
import {
	errorCatalog,
	errorCatalogCodes,
} from "../../src/core/error-catalog.ts";

const ROOT = join(import.meta.dir, "..", "..");
const ERRORS_DIR = join(ROOT, "docs", "errors");
const STUB_MARKER = "This stub will be expanded";

/**
 * Pages still holding the `docs:errors` scaffold (#659). This list may only
 * shrink: fill a page, then delete its line. A new scaffold fails the test, so
 * a new error code ships with a real page.
 */
const REMAINING_STUBS: readonly string[] = [
	"cdb/already-exists",
	"cdb/created",
	"cdb/decrypt-failed",
	"cdb/invalid-option",
	"cdb/invalid-record",
	"cdb/not-found",
	"cdb/not-found-target",
	"cdb/override-applied",
	"cdb/parse-failed",
	"cdb/password-not-needed",
	"cdb/reserved-key",
	"cdb/reserved-option",
	"cdb/target-not-registered",
	"cdb/unknown-field",
	"cdb/unknown-option",
	"cdb/write-not-permitted",
	"discover/broadcast-unavailable",
	"discover/failed",
	"identity/ambiguous",
	"identity/no-match",
	"input/incomplete-gps",
	"input/invalid-altitude",
	"input/invalid-bbox",
	"input/invalid-command",
	"input/invalid-coordinate",
	"input/invalid-match",
	"input/invalid-path",
	"input/invalid-radius",
	"input/local-file-not-found",
	"input/mac-address",
	"input/max-results-exceeded",
	"internal/devices-failed",
	"internal/mcp-start",
	"internal/mcp-tool",
	"internal/native-api-length",
	"internal/settings-failed",
	"internal/unhandled",
	"internal/unreachable",
	"mndp/encode-failed",
	"mndp/listen-failed",
	"mndp/malformed",
	"routeros/api-fatal",
	"routeros/api-protocol",
	"routeros/api-trap",
	"routeros/mac-telnet-error",
	"routeros/mac-telnet-not-ready",
	"routeros/mac-telnet-protocol",
	"routeros/protocol-not-implemented",
	"routeros/request-failed",
	"routeros/unsupported-capability",
	"settings/unsafe-protocol-blocked",
	"target/unresolved",
	"transport/auto-method",
	"transport/checksum-unavailable",
	"transport/insecure-trust",
	"transport/unsupported-operation",
	"usage/confirmation-required",
	"usage/conflicting-flags",
	"usage/invalid-concurrency",
	"usage/missing-group",
	"usage/not-implemented",
	"usage/target-exists",
	"usage/timeout-out-of-range",
	"validation/option",
];

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
		// Normalize Windows path separators so codes compare as `family/slug`.
		codes.push(rel.replace(/\.md$/, "").replaceAll("\\", "/"));
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
			// Tolerate CRLF checkouts (Windows): drop a trailing carriage return.
			const firstLine = (text.split("\n", 1)[0] ?? "").replace(/\r$/, "");
			expect(firstLine).toBe(`# \`${code}\``);
		}
		expect(missing).toEqual([]);
	});

	test("no new stub pages, and filled pages leave the stub list (#659)", () => {
		const stubs = pagesOnDisk()
			.filter((code) =>
				readFileSync(pagePathForCode(code), "utf8").includes(STUB_MARKER),
			)
			.sort();
		expect({
			newStubs: stubs.filter((code) => !REMAINING_STUBS.includes(code)),
			filledButStillListed: REMAINING_STUBS.filter(
				(code) => !stubs.includes(code),
			),
		}).toEqual({ newStubs: [], filledButStillListed: [] });
	});

	test("relative links resolve to repo files (checked on PRs, not only by the Pages build)", () => {
		const glob = new Glob("**/*.md");
		const broken: string[] = [];
		for (const rel of glob.scanSync({ cwd: ERRORS_DIR })) {
			const relPath = rel.replaceAll("\\", "/");
			const text = readFileSync(join(ERRORS_DIR, rel), "utf8");
			for (const href of brokenSourceLinks(text, relPath, ROOT))
				broken.push(`${relPath}: ${href}`);
		}
		expect(broken).toEqual([]);
	});

	test("no page is orphaned (every page maps to a catalog code)", () => {
		const orphans = pagesOnDisk().filter(
			(code) => !errorCatalogCodes.has(code),
		);
		expect(orphans).toEqual([]);
	});
});
