import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { populationScripts } from "../../scripts/corpus-db.ts";
import { cachePath, readPin, sha256File } from "../../scripts/corpus-fetch.ts";
import { resolveStatements } from "../../src/explain/pathresolve.ts";
import { type ExplainSpanRange, explainCommand } from "../../src/explain.ts";

const contains = (outer: ExplainSpanRange, inner: ExplainSpanRange): boolean =>
	outer.start <= inner.start && outer.end >= inner.end;

/** Independent interval oracle; production obtains ownership from traversal. */
function checkOwnership(input: string): void {
	const result = explainCommand(input, { tokens: true });
	const { statements, blocks, subcommands } = result.structure;
	const bytes = Buffer.from(input);
	const source = resolveStatements(input).statements;
	const ids = new Map(
		statements.map((statement, index) => [statement.id, index]),
	);
	expect(ids.size).toBe(statements.length);
	expect(result.structure.statementCount).toBe(statements.length);
	// Unicode can widen a descendant's span to its parent's. Such spans cannot
	// distinguish siblings; compare containment only where source text agrees.
	const precise = new Set(
		statements
			.filter(
				(statement, index) =>
					bytes
						.subarray(statement.span.start, statement.span.end)
						.toString() === source[index]?.text,
			)
			.map((statement) => statement.id),
	);
	const ancestors = new Map<string, string[]>();
	for (const [index, statement] of statements.entries()) {
		expect(statement.id).toBe(`s${index}`);
		const parentAt =
			statement.parent === undefined ? undefined : ids.get(statement.parent);
		if (statement.parent !== undefined) {
			expect(parentAt).toBeDefined();
			expect(parentAt).toBeLessThan(index);
			const parent = statements[parentAt as number];
			expect(parent).toBeDefined();
			expect(contains((parent as typeof statement).span, statement.span)).toBe(
				true,
			);
		}
		const chain =
			statement.parent === undefined
				? []
				: [statement.parent, ...(ancestors.get(statement.parent) ?? [])];
		ancestors.set(statement.id, chain);
		if (statement.block !== undefined) {
			const block = blocks[statement.block];
			expect(block).toBeDefined();
			expect(chain).toContain(block?.owner ?? "");
		}
	}
	const stack: (typeof statements)[number][] = [];
	for (const statement of statements
		.filter((entry) => precise.has(entry.id))
		.sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end)) {
		while (
			stack.length > 0 &&
			!contains((stack.at(-1) as typeof statement).span, statement.span)
		)
			stack.pop();
		expect(ancestors.get(statement.id)?.find((id) => precise.has(id))).toBe(
			stack.at(-1)?.id,
		);
		stack.push(statement);
	}
	for (const subcommand of subcommands) {
		const ownerAt = ids.get(subcommand.owner);
		expect(ownerAt).toBeDefined();
		expect(
			contains(
				(statements[ownerAt as number] as (typeof statements)[number]).span,
				subcommand.span,
			),
		).toBe(true);
	}
	for (const block of blocks) {
		if (block.owner !== undefined) expect(ids.has(block.owner)).toBe(true);
	}
	expect(result.runtimeAcceptance).toBe("not-proven");
}

test("example 46: nested bodies link to their owning statements and published blocks", () => {
	const input =
		":if (true) do={ :foreach i in={1;2} do={ :put $i } } else={ :put 0 }; :put 3";
	const result = explainCommand(input);
	expect(
		result.structure.statements.map((statement) => [
			statement.id,
			statement.parent,
			statement.block,
		]),
	).toEqual([
		["s0", undefined, undefined],
		["s1", "s0", 0],
		["s2", "s1", 0],
		["s3", "s0", 1],
		["s4", undefined, undefined],
	]);
	expect(
		result.structure.blocks.map((block) => [block.name, block.owner]),
	).toEqual([
		["do", "s0"],
		["else", "s0"],
	]);
	checkOwnership(input);
});

test("on-error bodies and a following statement keep distinct ownership", () => {
	const input =
		':do { :put [/system/resource/get uptime] } on-error={ :put "error" }; :put 2';
	const { structure } = explainCommand(input);
	expect(structure.statements.map((s) => s.parent)).toEqual([
		undefined,
		"s0",
		"s0",
		undefined,
	]);
	expect(structure.blocks.map((b) => [b.name, b.owner])).toEqual([
		["command", "s0"],
		["on-error", "s0"],
	]);
	expect(structure.subcommands.map((s) => s.owner)).toEqual(["s1"]);
	checkOwnership(input);
});

test("nested brackets and substitutions in different bodies name their statement owner", () => {
	const input =
		":put [ :pick [/ip/address/find] 0 ]; :if (true) do={ :put [ :len [/ip/address/find] ] }; :put [/system/resource/get uptime]";
	expect(
		explainCommand(input).structure.subcommands.map((s) => s.owner),
	).toEqual(["s0", "s0", "s2", "s2", "s3"]);
	checkOwnership(input);
});

test("menu containers retain their existing published statements without invented owners", () => {
	const input = "/ip { address { print } }; :put 1";
	const { structure } = explainCommand(input);
	expect(structure.statements.map((s) => s.parent)).toEqual([
		undefined,
		undefined,
		undefined,
	]);
	expect(structure.blocks).toEqual([]);
	checkOwnership(input);
});

test("Unicode-widened sibling spans retain traversal ownership instead of becoming a chain", () => {
	const input =
		':if (true) do={ :put "é"; :put [/system/resource/get uptime] }; :put 3';
	const { structure } = explainCommand(input);
	expect(structure.statements.map((s) => s.parent)).toEqual([
		undefined,
		"s0",
		"s0",
		undefined,
	]);
	expect(structure.statements[1]?.span).toEqual(structure.statements[2]?.span);
	expect(structure.statements.map((s) => s.block)).toEqual([
		undefined,
		0,
		0,
		undefined,
	]);
	expect(structure.subcommands.map((s) => s.owner)).toEqual(["s2"]);
	checkOwnership(input);
});

test("published block indexes survive Unicode before and inside multiple bodies", () => {
	const input =
		':put "é"; :if (true) do={ :put "α"; :if (true) do={ :put 1 } } else={ :put 2 }; :do { :put 3 }';
	const { structure } = explainCommand(input);
	expect(structure.statements.map((s) => s.block)).toEqual([
		undefined,
		undefined,
		0,
		0,
		0,
		1,
		undefined,
		2,
	]);
	expect(structure.blocks.map((b) => b.owner)).toEqual(["s1", "s1", "s6"]);
	checkOwnership(input);
});

test("navigation, uncertainty and string interpolation preserve bracket statement indexes", () => {
	for (const [input, owners] of [
		["/ip) address\n:put [/system/resource/get uptime]", ["s1"]],
		[
			"/terminal/cuu\n:put [/system/resource/get uptime]; /ip/address; :if (true) do={ :put [find] }",
			["s1", "s4"],
		],
		[
			'/ip/address; :put "$[:len [find]]"; :if (true) do={ :put "$[:len [find]]" }',
			["s1", "s1", "s3", "s3"],
		],
	] as const) {
		expect(
			explainCommand(input).structure.subcommands.map((s) => s.owner),
		).toEqual([...owners]);
		checkOwnership(input);
	}
});

test("example 47: stored script and callback bodies stay opaque in the statement tree", () => {
	for (const input of [
		"/system/script/add name=proof source={ :local x 1; :put $x }; :put 2",
		"/system/scheduler/add name=proof on-event={ :local x 1; :put $x }; :put 2",
		"/tool/netwatch/add host=192.0.2.1 down-script={ :local x 1; :put $x }; :put 2",
	]) {
		const { structure } = explainCommand(input);
		expect(structure.statements.map((s) => s.id)).toEqual(["s0", "s1"]);
		expect(structure.statements.map((s) => s.parent)).toEqual([
			undefined,
			undefined,
		]);
		expect(structure.blocks).toEqual([]);
		checkOwnership(input);
	}
});

function inputsIn(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(inputsIn);
	if (value === null || typeof value !== "object") return [];
	const object = value as Record<string, unknown>;
	return [
		...(typeof object["input"] === "string" ? [object["input"]] : []),
		...Object.values(object).flatMap(inputsIn),
	];
}

test("source ownership agrees with interval containment over segmentation and scope fixtures", () => {
	for (const name of ["segments", "pathresolve", "blocks"]) {
		const fixture = JSON.parse(
			readFileSync(
				new URL(`../fixtures/explain/${name}.json`, import.meta.url),
				"utf8",
			),
		);
		for (const input of inputsIn(fixture)) checkOwnership(input);
	}
});

// The corpus CI job fetches the exact pinned DB and enables this test. The
// ordinary unit tier needs no download; absence is explicit in its skip report.
test.skipIf(process.env["CENTRS_CHECK_CORPUS"] !== "1")(
	"source ownership agrees with interval containment over the pinned study population",
	() => {
		const pin = readPin();
		const path = cachePath(pin);
		expect(sha256File(path)).toBe(pin.sha256);
		const db = new Database(path, { readonly: true });
		try {
			const rows = populationScripts(db);
			expect(rows.length).toBe(pin.scripts);
			for (const row of rows) checkOwnership(row.text);
			console.log(
				`#497 ownership contract: ${rows.length} study inputs; snapshot ${pin.sha256.slice(0, 12)}`,
			);
		} finally {
			db.close();
		}
	},
	120_000,
);
