import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getProtocolPlan,
	type ProtocolCapability,
	protocolPlans,
	type RouterOsProtocol,
} from "../../src/protocols/index.ts";

/**
 * Drift guard for #130: the protocol registry (`src/protocols/index.ts`) must
 * never under-claim against `docs/MATRIX.md`. Every `CHR-passed` grid cell
 * implies its protocol is `implemented: true` and lists the command's
 * capability. MATRIX stays the only status surface — this test derives the
 * expectation from it rather than hard-coding a second copy.
 */

const MATRIX_PATH = join(import.meta.dir, "..", "..", "docs", "MATRIX.md");

/** Grid command → registry capability. Commands absent here (api/check/devices/
 * settings) are passthrough or transport-less and assert only `implemented`. */
const COMMAND_CAPABILITY: Partial<Record<string, ProtocolCapability>> = {
	retrieve: "retrieve",
	execute: "execute",
	terminal: "terminal",
	transfer: "transfer",
	discover: "discover",
};

interface GridCell {
	command: string;
	protocol: string;
	state: string;
}

/** Parse the `## Grid` markdown table from MATRIX.md into flat cells. */
function parseMatrixGrid(markdown: string): GridCell[] {
	const lines = markdown.split("\n");
	const headerIndex = lines.findIndex(
		(line) => line.includes("| Command") && line.includes("rest-api"),
	);
	if (headerIndex === -1) {
		throw new Error("MATRIX.md grid header row not found");
	}
	const cells = (row: string): string[] =>
		row
			.split("|")
			.slice(1, -1)
			.map((cell) => cell.trim());
	const protocols = cells(lines[headerIndex] ?? "").slice(1);
	const grid: GridCell[] = [];
	// Data rows start two lines below the header (skip the `|---|` separator).
	for (let i = headerIndex + 2; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (!line.trimStart().startsWith("|")) break;
		const row = cells(line);
		const command = row[0] ?? "";
		row.slice(1).forEach((state, index) => {
			const protocol = protocols[index];
			if (protocol) {
				grid.push({ command, protocol, state: state.replace(/`/g, "") });
			}
		});
	}
	return grid;
}

const grid = parseMatrixGrid(readFileSync(MATRIX_PATH, "utf8"));
const chrPassed = grid.filter((cell) => cell.state === "CHR-passed");

describe("protocol registry ⇄ MATRIX drift guard (#130)", () => {
	test("MATRIX grid parses into CHR-passed cells", () => {
		// Fail loud if the table shape changes and the parser silently finds none.
		expect(chrPassed.length).toBeGreaterThan(0);
	});

	for (const cell of chrPassed) {
		const capability = COMMAND_CAPABILITY[cell.command];
		test(`${cell.command} / ${cell.protocol} CHR-passed ⇒ registry consistent`, () => {
			const plan = getProtocolPlan(cell.protocol as RouterOsProtocol);
			expect(
				plan,
				`no registry entry for protocol "${cell.protocol}"`,
			).toBeDefined();
			expect(
				plan.implemented,
				`${cell.protocol} is CHR-passed for ${cell.command} but registry has implemented:false`,
			).toBe(true);
			if (capability) {
				expect(
					plan.capabilities,
					`${cell.protocol} is CHR-passed for ${cell.command} but registry lacks "${capability}"`,
				).toContain(capability);
			}
		});
	}
});

describe("protocol registry — regression anchors for the #130 fixes", () => {
	test("native-api lists the transfer capability", () => {
		expect(getProtocolPlan("native-api").capabilities).toContain("transfer");
	});
	test("ssh is implemented", () => {
		expect(getProtocolPlan("ssh").implemented).toBe(true);
	});
	test("mndp is implemented", () => {
		expect(getProtocolPlan("mndp").implemented).toBe(true);
	});
	test("every registered protocol id is unique", () => {
		const ids = protocolPlans.map((plan) => plan.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
