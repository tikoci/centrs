import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	type WinBoxCdbRecord,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";
import { parseRawCommentFacts } from "../../src/resolver/comment-kv.ts";
import { parseBbox, parseNear } from "../../src/resolver/geo.ts";
import {
	expandSelection,
	isDefaultRecordTarget,
	type SelectionMember,
	type TargetSelection,
} from "../../src/resolver/selection.ts";

interface Entry {
	target: string;
	group?: string;
	comment?: string;
}

// Record index 0..4 (the order matters: selection reassembles by record index).
const ENTRIES: readonly Entry[] = [
	{
		target: "10.0.0.1",
		group: "prod",
		comment: "board=RB5009 identity=edge1 lat=37.774900 lon=-122.419400",
	},
	{ target: "10.0.0.2", group: "prod", comment: "board=hAP version=7.23.1" },
	{ target: "10.0.0.3", group: "lab", comment: "identity=lab-host" },
	{ target: "__default__", comment: "" },
	// Record 4 carries a spoof `group=fake` comment token: the core field wins.
	{ target: "10.0.0.5", group: "prod", comment: "group=fake board=RB5009" },
];

let cdbPath: string;
let cdbDir: string;

beforeAll(async () => {
	const records: WinBoxCdbRecord[] = ENTRIES.map((entry) =>
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: entry.target,
			user: "admin",
			password: "secret",
			group: entry.group ?? "",
			comment: entry.comment ?? "",
		}),
	);
	cdbDir = await mkdtemp(join(tmpdir(), "centrs-selection-"));
	cdbPath = join(cdbDir, "winbox.cdb");
	await writeFile(cdbPath, encodeOpenWinBoxCdb(records));
});

afterAll(async () => {
	await rm(cdbDir, { recursive: true, force: true });
});

function selection(overrides: Partial<TargetSelection>): TargetSelection {
	return {
		positionals: [],
		groups: [],
		all: false,
		default: false,
		where: [],
		...overrides,
	};
}

async function expand(
	overrides: Partial<TargetSelection>,
	allowAdhoc = true,
): Promise<{
	indices: number[];
	literals: string[];
	members: readonly SelectionMember[];
	empty: boolean;
	warningCodes: string[];
}> {
	const result = await expandSelection(
		selection(overrides),
		{ cdbFile: cdbPath, allowAdhoc },
		{},
	);
	const indices: number[] = [];
	const literals: string[] = [];
	for (const member of result.targets) {
		if (member.kind === "cdb") {
			indices.push(member.recordIndex);
		} else {
			literals.push(member.input);
		}
	}
	return {
		indices,
		literals,
		members: result.targets,
		empty: result.empty,
		warningCodes: result.warnings.map((w) => w.code),
	};
}

describe("parseRawCommentFacts", () => {
	test("reads every kv token, no allowlist filter, no warnings", () => {
		expect(
			parseRawCommentFacts("board=RB5009 version=7.23.1 identity=edge1"),
		).toEqual({ board: "RB5009", version: "7.23.1", identity: "edge1" });
	});

	test("last token wins on a duplicate key", () => {
		expect(parseRawCommentFacts("x=1 free text x=2")).toEqual({ x: "2" });
	});

	test("ignores free-form (non-kv) text", () => {
		expect(parseRawCommentFacts("just a note")).toEqual({});
	});
});

describe("isDefaultRecordTarget", () => {
	test("recognizes the reserved record", () => {
		expect(isDefaultRecordTarget("__default__")).toBe(true);
		expect(isDefaultRecordTarget("10.0.0.1")).toBe(false);
	});
});

describe("expandSelection — selectors", () => {
	test("--group matches members in record-index order", async () => {
		const out = await expand({ groups: ["prod"] });
		expect(out.indices).toEqual([0, 1, 4]);
		expect(out.empty).toBe(false);
	});

	test("--all excludes the __default__ record", async () => {
		const out = await expand({ all: true });
		expect(out.indices).toEqual([0, 1, 2, 4]);
	});

	test("--default selects only the __default__ record", async () => {
		const out = await expand({ default: true });
		expect(out.indices).toEqual([3]);
		const member = out.members[0];
		expect(member?.kind).toBe("cdb");
		if (member?.kind === "cdb") {
			expect(member.resolution.target).toBe("__default__");
		}
	});

	test("--where matches a raw comment fact (board=)", async () => {
		const out = await expand({ where: [{ key: "board", value: "RB5009" }] });
		expect(out.indices).toEqual([0, 4]);
	});

	test("--where matches a core field, and the comment cannot spoof it", async () => {
		// Record 4's comment says `group=fake`, but its core group is `prod`.
		const out = await expand({ where: [{ key: "group", value: "prod" }] });
		expect(out.indices).toEqual([0, 1, 4]);
		const fake = await expand({ where: [{ key: "group", value: "fake" }] });
		expect(fake.indices).toEqual([]);
		expect(fake.empty).toBe(true);
	});

	test("--where matches a stored lat= fact exactly, verbatim as typed", async () => {
		// Record 0's comment carries `lat=37.774900` — deliberately padded with a
		// trailing zero that a round-trip through Number() would drop. The exact
		// stored string must still match (issue #146: values are stored
		// verbatim-as-typed, not reformatted; see src/resolver/geo.ts).
		const exact = await expand({
			where: [{ key: "lat", value: "37.774900" }],
		});
		expect(exact.indices).toEqual([0]);

		// A numerically-equal but reformatted value (dropped trailing zero) must
		// NOT match — parseRawCommentFacts -> entryFacts -> matchesWhere is a raw
		// string compare, never a numeric/parsed one.
		const reformatted = await expand({
			where: [{ key: "lat", value: "37.7749" }],
		});
		expect(reformatted.indices).toEqual([]);
		expect(reformatted.empty).toBe(true);
	});

	test("repeated --where is AND-combined", async () => {
		const out = await expand({
			where: [
				{ key: "board", value: "RB5009" },
				{ key: "group", value: "prod" },
			],
		});
		expect(out.indices).toEqual([0, 4]);
	});

	test("--where canonicalizes a geo alias key so fan-out matches like devices list", async () => {
		// Record 0 stores `lat=37.774900`; the shared resolver must match a
		// `latitude=`/`lng=` alias too (centralized in matchesWhere), so
		// retrieve/execute/api/transfer --where behaves like `devices list`.
		const byAlias = await expand({
			where: [{ key: "latitude", value: "37.774900" }],
		});
		expect(byAlias.indices).toEqual([0]);
		const byLngAlias = await expand({
			where: [{ key: "lon", value: "-122.419400" }],
		});
		expect(byLngAlias.indices).toEqual([0]);
	});
});

describe("expandSelection — geo predicates (--near / --bbox)", () => {
	// Only record 0 carries GPS (SF: lat=37.774900 lon=-122.419400); the other
	// records are geo-less and must never be selected by --near/--bbox.
	test("--near selects the in-radius GPS record; geo-less records are excluded", async () => {
		const out = await expand({ near: parseNear("37.7749,-122.4194,5km") });
		expect(out.indices).toEqual([0]);
	});

	test("--near whose radius excludes the only GPS record matches nothing", async () => {
		// New York is ~4100 km from the SF record — outside a 50 km radius.
		const out = await expand({ near: parseNear("40.7128,-74.0060,50km") });
		expect(out.indices).toEqual([]);
		expect(out.empty).toBe(true);
		expect(out.warningCodes).toContain("cdb/empty-selection");
	});

	test("--bbox selects the GPS record inside the box; geo-less records are excluded", async () => {
		const out = await expand({
			bbox: parseBbox("37.70,-122.52,37.83,-122.35"),
		});
		expect(out.indices).toEqual([0]);
	});

	test("--bbox that does not contain the GPS record matches nothing", async () => {
		const out = await expand({ bbox: parseBbox("40.0,-75.0,41.0,-74.0") });
		expect(out.indices).toEqual([]);
	});

	test("geo predicates OR-union with other selectors (--group lab OR --near SF)", async () => {
		// group lab = record 2; near SF = record 0. Union, ordered by record index.
		const out = await expand({
			groups: ["lab"],
			near: parseNear("37.7749,-122.4194,5km"),
		});
		expect(out.indices).toEqual([0, 2]);
	});
});

describe("expandSelection — positionals & union", () => {
	test("a positional matching a record by target resolves to that record", async () => {
		const out = await expand({ positionals: ["10.0.0.3"] });
		expect(out.indices).toEqual([2]);
		expect(out.literals).toEqual([]);
	});

	test("a positional matching by identity= lookup resolves to that record", async () => {
		const out = await expand({ positionals: ["edge1"] });
		expect(out.indices).toEqual([0]);
	});

	test("a non-matching positional becomes a literal when allowAdhoc", async () => {
		const out = await expand({ positionals: ["1.2.3.4"] });
		expect(out.indices).toEqual([]);
		expect(out.literals).toEqual(["1.2.3.4"]);
	});

	test("a non-matching positional is rejected when MCP-style (no adhoc)", async () => {
		await expect(
			expandSelection(
				selection({ positionals: ["1.2.3.4"] }),
				{ cdbFile: cdbPath, allowAdhoc: false },
				{},
			),
		).rejects.toThrow("not a registered CDB target");
	});

	test("union de-dupes by record index, literals append after cdb members in record order", async () => {
		const out = await expand({
			groups: ["lab"],
			positionals: ["10.0.0.1", "9.9.9.9"],
		});
		// record 2 (lab) + record 0 (positional match), ordered by index, then the literal.
		expect(out.indices).toEqual([0, 2]);
		expect(out.literals).toEqual(["9.9.9.9"]);
	});

	test("duplicate literals collapse", async () => {
		const out = await expand({ positionals: ["9.9.9.9", "9.9.9.9"] });
		expect(out.literals).toEqual(["9.9.9.9"]);
	});
});

describe("expandSelection — empty selection", () => {
	test("an unknown group is empty with cdb/empty-group", async () => {
		const out = await expand({ groups: ["nope"] });
		expect(out.empty).toBe(true);
		expect(out.indices).toEqual([]);
		expect(out.warningCodes).toContain("cdb/empty-group");
	});

	test("a no-match mixed selection is empty with cdb/empty-selection", async () => {
		const out = await expand({ where: [{ key: "board", value: "none" }] });
		expect(out.empty).toBe(true);
		expect(out.warningCodes).toContain("cdb/empty-selection");
	});
});

describe("expandSelection — no CDB present", () => {
	test("literal positionals fan out over an absent (implicit) CDB", async () => {
		// No cdbFile, and an empty HOME so the default CDB path does not exist.
		const result = await expandSelection(
			selection({ positionals: ["10.9.9.1", "10.9.9.2"] }),
			{ allowAdhoc: true },
			{ HOME: "/nonexistent-centrs-home" },
		);
		expect(result.empty).toBe(false);
		expect(
			result.targets.map((m) => (m.kind === "literal" ? m.input : "?")),
		).toEqual(["10.9.9.1", "10.9.9.2"]);
	});

	test("an absent default CDB is NOT created on read (mirrors resolveCdb)", async () => {
		const home = await mkdtemp(join(tmpdir(), "centrs-selection-home-"));
		try {
			const result = await expandSelection(
				selection({ groups: ["nope"] }),
				{ allowAdhoc: true },
				{ HOME: home },
			);
			expect(result.empty).toBe(true);
			// The expansion must not have written a default CDB as a side effect.
			const defaultPath = join(home, ".config", "tikoci", "winbox.cdb");
			expect(await Bun.file(defaultPath).exists()).toBe(false);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
