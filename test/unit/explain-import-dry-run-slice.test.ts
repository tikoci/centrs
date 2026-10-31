import { describe, expect, test } from "bun:test";
import slice from "../fixtures/explain/import-dry-run.slice.json" with {
	type: "json",
};

/**
 * #520 evidence slice: identical bytes across `:parse`, `highlight`,
 * plain/verbose/dry-run imports on CHR 7.24.5.
 *
 * Recorded by `bun run explain:probe:import-dry-run` (one disposable CHR
 * per import run). This test replays the RECORDED conclusions without a
 * router — it pins the slice contract, not the device. Re-derive live with
 * that command; a device that disagrees with the slice means the slice (and
 * these assertions) needs re-recording, not a silent update.
 */

interface Run {
	file: string;
	variant: string;
	command: string;
	importMs: number;
	importOutput: { output?: string };
	stateOutput: { output?: string };
	identityOutput: { output?: string };
}

const runs = slice.runs as Run[];
const run = (file: string, variant: string): Run => {
	const found = runs.find((r) => r.file === file && r.variant === variant);
	if (!found) throw new Error(`no recorded run ${file} ${variant}`);
	return found;
};

describe("import dry-run evidence slice (#520)", () => {
	test("the slice covers the full matrix", () => {
		expect(slice.routerosVersion).toBe("7.24.5");
		expect(runs).toHaveLength(9);
		for (const file of ["good.rsc", "mixed.rsc", "side-fx.rsc"])
			for (const variant of ["dry-run", "verbose", "plain"])
				expect(run(file, variant).command).toContain(`file-name=${file}`);
	});

	test("dry-run executes nothing (observable controls)", () => {
		for (const file of ["good.rsc", "mixed.rsc", "side-fx.rsc"]) {
			const dry = run(file, "dry-run");
			expect(dry.stateOutput.output ?? "").not.toContain("probe-520");
			expect(dry.identityOutput.output ?? "").toContain("name: CHR");
		}
		expect(run("good.rsc", "dry-run").importOutput.output ?? "").toContain(
			"No syntax errors found in the import file",
		);
	});

	test("verbose=yes alone still applies the import", () => {
		const verbose = run("good.rsc", "verbose");
		expect(verbose.stateOutput.output ?? "").toContain("192.0.2.1");
		expect(verbose.stateOutput.output ?? "").toContain("198.51.100.7");
		expect(run("side-fx.rsc", "verbose").identityOutput.output ?? "").toContain(
			"probe-520-side-fx",
		);
	});

	test("plain and verbose imports are fail-fast with partial application", () => {
		for (const variant of ["plain", "verbose"]) {
			const mixed = run("mixed.rsc", variant);
			expect(mixed.importOutput.output ?? "").toContain(
				"bad command name this (line 2 column 1)",
			);
			// Line 1 applied, line 3 never ran.
			expect(mixed.stateOutput.output ?? "").toContain("192.0.2.9");
			expect(mixed.stateOutput.output ?? "").not.toContain("203.0.113.4");
		}
	});

	test("dry-run scans the whole file and counts errors", () => {
		const dry = run("mixed.rsc", "dry-run");
		const output = dry.importOutput.output ?? "";
		expect(output).toContain("#line 3");
		expect(output).toContain("found 1 error(s) in import file");
		expect(dry.stateOutput.output ?? "").not.toContain("probe-520");
	});

	test("recorded inputs hash to the committed bytes", async () => {
		const { createHash } = await import("node:crypto");
		for (const file of slice.files as {
			name: string;
			sha256: string;
			input: string;
		}[]) {
			expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(
				createHash("sha256").update(file.input, "utf8").digest("hex"),
			).toBe(file.sha256);
		}
	});
});
