/**
 * Placeholder for the first RouterOS CHR-backed integration test.
 *
 * Skipped until S006 protocol grounding is accepted and the REST adapter exists.
 * Kept in tree so the harness shape is visible and so `bun test` lists the
 * planned suite.
 *
 * See:
 * - docs/specs/S006-alpha-first-command.md
 * - test/AGENTS.md
 */

import { describe, test } from "bun:test";

describe.skip("alpha REST retrieve against CHR (S006)", () => {
	test("retrieves /system/resource as JSON", () => {
		// 1. Boot CHR via @tikoci/quickchr.
		// 2. Run `centrs retrieve <chr> /system/resource --via rest-api --format json`.
		// 3. Assert non-empty JSON with `version` and `uptime` fields.
	});

	test("reports actionable error when host is unreachable", () => {
		// Assert the error message names protocol, host, port, and remediation
		// per .github/instructions/actionable-errors.instructions.md.
	});
});
