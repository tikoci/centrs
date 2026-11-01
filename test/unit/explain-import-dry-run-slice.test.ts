import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import slice from "../fixtures/explain/import-dry-run.slice.json" with {
	type: "json",
};

/**
 * #520 evidence slice: identical bytes across `:parse`, `highlight`,
 * plain/verbose/dry-run imports on CHR 7.24.5.
 *
 * Written by `bun run explain:probe:import-dry-run` (one disposable CHR per
 * import run) and copied unedited. This test replays the RECORDED conclusions
 * without a router — it pins the slice contract, not the device. A device
 * that disagrees means re-recording the slice, not a silent update.
 */

interface Run {
	file: string;
	variant: string;
	command: string;
	via: string;
	importOutput: string;
	state: Record<string, string>;
}

interface Static {
	parse: { verdict: string; output: string };
	highlight: { input: string; highlight: string; errorBytes: number }[];
}

const runs = slice.runs as Run[];
const statics = slice.static as Record<string, Static>;
const FILES = slice.files.map((f) => f.name);
const VARIANTS = ["dry-run", "verbose", "plain"];

const run = (file: string, variant: string): Run => {
	const found = runs.find((r) => r.file === file && r.variant === variant);
	if (!found) throw new Error(`no recorded run ${file} ${variant}`);
	return found;
};

/** Which probe-520 addresses the address-list readback shows. */
const applied = (r: Run): string[] =>
	[...(r.state["addressList"] ?? "").matchAll(/probe-520\s+(\S+)/g)].map(
		(m) => m[1] ?? "",
	);

/** Line 1 / line 3 address-list markers around each apply-time blocker. */
const APPLY_TIME: Record<string, { first: string; error: string }> = {
	"duplicate.rsc": {
		first: "192.0.2.20",
		error:
			"failure: already have such entry (/ip/firewall/address-list/add; line 2)",
	},
	"builtin.rsc": {
		first: "192.0.2.30",
		error:
			"failure: cannot change builtin (/interface/list/set *0 = *0) (/interface/list/set; line 2)",
	},
	"missing-value.rsc": {
		first: "192.0.2.40",
		error:
			"failure: authentication password minimum length is 8 symbols (/snmp/community/add; line 2)",
	},
	"missing-object.rsc": {
		first: "192.0.2.50",
		error: "no such item (/interface/ethernet/set; line 2)",
	},
};

describe("import dry-run evidence slice (#520)", () => {
	test("the slice covers the full matrix over REST on one version", () => {
		expect(slice.routerosVersion).toBe("7.24.5");
		expect(FILES).toHaveLength(8);
		expect(runs).toHaveLength(FILES.length * VARIANTS.length);
		for (const file of FILES)
			for (const variant of VARIANTS) {
				expect(run(file, variant).command).toContain(`file-name=${file}`);
				expect(run(file, variant).via).toBe("rest");
			}
	});

	test("recorded inputs hash to the committed bytes", () => {
		for (const file of slice.files)
			expect(
				createHash("sha256").update(file.input, "utf8").digest("hex"),
			).toBe(file.sha256);
	});

	test(":parse and highlight accept every apply-time blocker", () => {
		for (const file of Object.keys(APPLY_TIME)) {
			expect(statics[file]?.parse.verdict).toBe("accepted");
			for (const line of statics[file]?.highlight ?? [])
				expect(line.highlight).toBe("clean");
		}
	});

	test("the syntax faults: :parse rejects both, highlight flags only the enum", () => {
		expect(statics["mixed.rsc"]?.parse.verdict).toBe("validation/syntax");
		expect(statics["mixed.rsc"]?.parse.output).toContain(
			"bad command name this (line 2 column 1)",
		);
		for (const line of statics["mixed.rsc"]?.highlight ?? [])
			expect(line.highlight).toBe("clean");
		expect(statics["invalid-value.rsc"]?.parse.verdict).toBe(
			"validation/syntax",
		);
		expect(
			statics["invalid-value.rsc"]?.highlight.map((l) => l.highlight),
		).toEqual(["clean", "flagged", "clean"]);
	});

	test("dry-run executes nothing (observable controls)", () => {
		for (const file of FILES) {
			const dry = run(file, "dry-run");
			expect(applied(dry)).toEqual([]);
			expect(dry.state["identity"]).toContain("name: CHR");
			expect(dry.state["snmpCommunity"]).not.toContain("canary-snmp-priv");
			expect(dry.state["forwardFilter"]).not.toContain("probe-520");
		}
	});

	test("verbose=yes alone still applies the import", () => {
		expect(applied(run("good.rsc", "verbose"))).toEqual([
			"192.0.2.1",
			"198.51.100.7",
		]);
		expect(run("side-fx.rsc", "verbose").state["identity"]).toContain(
			"probe-520-side-fx",
		);
	});

	test("a clean dry-run does not mean the import applies", () => {
		for (const [file, { first, error }] of Object.entries(APPLY_TIME)) {
			expect(run(file, "dry-run").importOutput).toContain(
				"No syntax errors found in the import file",
			);
			for (const variant of ["plain", "verbose"]) {
				const real = run(file, variant);
				// Line 1 applied, line 2 failed, line 3 never ran.
				expect(applied(real)).toEqual([first]);
			}
			expect(run(file, "plain").importOutput).toContain(error);
		}
	});

	test("dry-run scans the whole file and counts syntax errors", () => {
		for (const file of ["mixed.rsc", "invalid-value.rsc"]) {
			const output = run(file, "dry-run").importOutput;
			expect(output).toContain("#line 3");
			expect(output).toContain("found 1 error(s) in import file");
		}
		expect(run("mixed.rsc", "dry-run").importOutput).toContain(
			"bad command name this (line 2 column 1)",
		);
		expect(run("invalid-value.rsc", "dry-run").importOutput).toContain(
			"syntax error (line 2 column 46)",
		);
	});

	test("partial application depends on the fault and the mode", () => {
		// `bad command name` compiles and fails at run time: both modes apply line 1.
		expect(applied(run("mixed.rsc", "plain"))).toEqual(["192.0.2.9"]);
		expect(applied(run("mixed.rsc", "verbose"))).toEqual(["192.0.2.9"]);
		// A syntax error stops a plain import before anything runs; verbose runs
		// line by line, so line 1 still applies.
		expect(applied(run("invalid-value.rsc", "plain"))).toEqual([]);
		expect(applied(run("invalid-value.rsc", "verbose"))).toEqual([
			"192.0.2.60",
		]);
	});
});
