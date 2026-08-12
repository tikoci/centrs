import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogRow } from "../../scripts/explain-catalog-data.ts";
import {
	appendDriftReportToSummary,
	buildDriftReport,
	DRIFT_REPORT_SENTINEL,
	parseCommittedCatalog,
} from "../../scripts/explain-catalog-drift.ts";

const row = (
	path: string,
	kind: CatalogRow["kind"],
	provenance: CatalogRow["provenance"],
	gates: Partial<Pick<CatalogRow, "package" | "conditions" | "syscap">> = {},
): CatalogRow => ({ path, kind, provenance, ...gates });

describe("explain catalog drift report", () => {
	test("parses committed generated rows identically with LF and CRLF", () => {
		const lf = [
			"export const header = true;",
			"const ROWS = `",
			"/a|menu|both|wireless|has-cap|wifi",
			"/b|command|published|||",
			"`;",
			"export const footer = true;",
			"",
		].join("\n");

		const expected: [string, CatalogRow][] = [
			[
				"/a",
				row("/a", "menu", "both", {
					package: "wireless",
					conditions: "has-cap",
					syscap: "wifi",
				}),
			],
			["/b", row("/b", "command", "published")],
		];

		expect([...(parseCommittedCatalog(lf)?.entries() ?? [])]).toEqual(expected);
		expect([
			...(parseCommittedCatalog(lf.replaceAll("\n", "\r\n"))?.entries() ?? []),
		]).toEqual(expected);
	});

	test("itemizes structural changes and keeps Markdown tables separate", () => {
		const committed = new Map<string, CatalogRow>([
			["/gone", row("/gone", "menu", "published")],
			["/inspect-gone", row("/inspect-gone", "menu", "inspect")],
			["/flip", row("/flip", "menu", "both")],
			["/gate", row("/gate", "menu", "published", { package: "old-package" })],
			["/kind", row("/kind", "menu", "both")],
			["/steady", row("/steady", "settings", "inspect")],
		]);
		const fresh = [
			row("/added", "command", "published", { syscap: "wifi" }),
			row("/inspect-added", "menu", "inspect"),
			row("/flip", "menu", "published"),
			row("/gate", "menu", "published", { package: "new-package" }),
			row("/kind", "command", "both"),
			row("/steady", "settings", "inspect"),
		];

		const report = buildDriftReport(committed, fresh);

		expect(report.startsWith(`${DRIFT_REPORT_SENTINEL}\n`)).toBe(true);
		expect(report).toContain("Row counts — committed 6 → fresh 6 (Δ 0)");
		expect(report).toContain("| `published` | 2 | 3 |");
		expect(report).toContain("| `command` | 0 | 2 |");
		expect(report).toContain(
			"| `published` | 2 | 3 |\n\n| Kind | Committed | Fresh |",
		);

		expect(report).toContain("Published paths added (1) / removed (1)");
		expect(report).toContain(
			'`/added` — `command` `published` — syscap="wifi"',
		);
		expect(report).toContain("`/gone` — `menu` `published`");
		expect(report).toContain(
			"(Also 1 inspect-only added, 1 inspect-only removed — omitted above.)",
		);

		expect(report).toContain(
			"Both → published (losing device confirmation, 1):",
		);
		expect(report).toContain("`/flip` — `both` → `published` (`menu`)");
		expect(report.match(/`\/flip` — `both` → `published`/g)?.length).toBe(1);

		expect(report).toContain("#### Kind changes (1)");
		expect(report).toContain(
			"These are committed → fresh changes. Cross-source kind contradictions abort before this report is built.",
		);
		expect(report).not.toContain("would normally abort on contradictions");
		expect(report).toContain("`/kind` — `menu` → `command`");

		expect(report).toContain("#### Gate-string changes (1)");
		expect(report).toContain(
			'`/gate` — package="old-package" → package="new-package"',
		);
	});

	test("keeps the sentinel and binary-diff guidance when parsing fails", () => {
		expect(parseCommittedCatalog("not a generated catalog")).toBeNull();
		expect(
			parseCommittedCatalog("const ROWS = `\n/bad|new-kind|both\n`;\n"),
		).toBeNull();
		expect(
			parseCommittedCatalog(
				"const ROWS = `\n/extra|menu|both|pkg|cond|syscap|unexpected\n`;\n",
			),
		).toBeNull();
		expect(
			parseCommittedCatalog(
				"const ROWS = `\n/duplicate|menu|both\n/duplicate|menu|both\n`;\n",
			),
		).toBeNull();

		const report = buildDriftReport(null, [row("/one", "menu", "published")]);
		expect(report.startsWith(`${DRIFT_REPORT_SENTINEL}\n`)).toBe(true);
		expect(report).toContain(
			"Fresh catalog has 1 paths; committed file could not be parsed (binary diff).",
		);
		expect(report).toContain("git diff src/explain/catalog.ts");
	});

	test("the QA fallback guards against duplicate reports with the sentinel", async () => {
		const workflow = await readFile(
			join(import.meta.dir, "..", "..", ".github", "workflows", "qa.yaml"),
			"utf8",
		);
		expect(workflow).toContain(
			`grep -qF "${DRIFT_REPORT_SENTINEL}" "$GITHUB_STEP_SUMMARY"`,
		);
	});

	test("appends to the Actions summary and treats publication as best-effort", async () => {
		const dir = await mkdtemp(join(tmpdir(), "centrs-catalog-drift-"));
		try {
			const summary = join(dir, "summary.md");
			await writeFile(summary, "earlier step\n");

			expect(appendDriftReportToSummary("drift report", summary)).toBe(true);
			expect(await readFile(summary, "utf8")).toBe(
				"earlier step\ndrift report\n",
			);
			expect(appendDriftReportToSummary("ignored", undefined)).toBe(false);
			expect(
				appendDriftReportToSummary(
					"ignored",
					join(dir, "missing", "summary.md"),
				),
			).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
