import { describe, expect, test } from "bun:test";
import { explainCommand } from "../../src/explain.ts";
import fixture from "../fixtures/explain/token-faults.json";

/**
 * The token rules against the device rows they were grounded on (#504, #506,
 * #518). The fixture holds the `:parse` answer of CHR 7.24.5 and 7.23.8 for
 * every row, and `test/integration/explain-token-faults.test.ts` holds the
 * device to it. This file holds offline to it: a rejected row reports its one
 * fault at its span and fails, an accepted row reports none, and a script the
 * device stops reading early reports one `discarded-close` warning over the
 * bytes it drops.
 */

const CODES = new Set([
	"glued-token",
	"invalid-variable",
	"invalid-name",
	"bad-string-variable",
	"discarded-close",
	"unbalanced-close",
]);

interface Row {
	issue: string;
	input: string;
	device: "accept" | "reject";
	code?: string;
	span?: [number, number];
}

function tokenFaults(input: string) {
	return explainCommand(input).diagnostics.filter((d) =>
		CODES.has(d.code.replace("explain/canonicalizer/", "")),
	);
}

const rows = fixture.rows as Row[];

describe("explain token faults (#504, #506, #518)", () => {
	test("a rejection has one error, an acceptance at most a discarded tail", () => {
		for (const row of rows)
			expect({
				input: row.input,
				fault:
					row.code === undefined
						? "none"
						: row.code === "discarded-close"
							? "discarded"
							: "error",
			}).toEqual({
				input: row.input,
				fault:
					row.device === "reject"
						? "error"
						: row.code === "discarded-close"
							? "discarded"
							: "none",
			});
	});

	for (const row of rows) {
		test(`${row.issue} ${row.device}s ${JSON.stringify(row.input)}`, () => {
			const data = explainCommand(row.input);
			const faults = tokenFaults(row.input).map((d) => ({
				code: d.code.replace("explain/canonicalizer/", ""),
				span: [d.span.start, d.span.end],
				severity: d.severity,
			}));
			if (row.code === undefined) {
				expect(faults).toEqual([]);
				return;
			}
			const discarded = row.code === "discarded-close";
			expect(faults).toEqual([
				{
					code: row.code,
					span: row.span as number[],
					severity: discarded ? "warning" : "error",
				},
			]);
			if (!discarded) expect(data.verdict).toBe("fail");
		});
	}

	test("each fault spans the byte it is about", () => {
		const at = (input: string) => {
			const [fault] = tokenFaults(input);
			return fault === undefined
				? undefined
				: input.slice(fault.span.start, fault.span.end);
		};
		expect(at(':put "a"b')).toBe("b");
		expect(at(":put (1)(2)")).toBe("(");
		expect(at(":if (true) do={:put 1}else={:put 2}")).toBe("e");
		expect(at(":local v 1; :put $v.b")).toBe(".");
		expect(at(":put $_")).toBe("$_");
		expect(at(':put "a$ b"')).toBe("$ ");
		expect(at(":local a_b 1")).toBe("_");
		expect(at(":foreach a,,b in={1} do={}")).toBe(",");
		expect(at(":put 1};:put 2")).toBe("};:put 2");
	});
});

describe("where the device's byte is not knowable, the rules abstain", () => {
	test.each([
		// The device rejects each of these, but not at a byte offline can name.
		// `$"` in a string opens a quoted name that every scanner here closes at
		// the next quote, and `$$` is rejected after the name it starts.
		[':put "a$"'],
		[':put "$$"'],
		[":local v 1; :put $$v"],
		[":put $(1)"],
		[':local v 1; :put "a$"v"b'],
	])("%j reports no token fault", (input) => {
		expect(tokenFaults(input)).toEqual([]);
	});
});

describe("a stray top-level close ends the script (#504)", () => {
	test("the reading is the prefix the device runs", () => {
		const input = ":put 1};/ip address remove 0";
		const data = explainCommand(input);
		expect(data.verdict).toBe("warn");
		expect(data.structure.statements.map((s) => s.span)).toEqual([
			{ start: 0, end: 6 },
		]);
		// The tail is not read, so the write in it is not either.
		expect(data.structure.containsWrite).toBe(false);
		expect(data.input.bytes).toBe(input.length);
	});

	test("the token partition still covers the whole input", () => {
		const input = ':put "a"} :put 2';
		const { tokens } = explainCommand(input, { tokens: true });
		expect(tokens?.at(-1)).toMatchObject({
			start: 8,
			end: input.length,
			class: "unclassified",
		});
		expect(tokens?.[0]?.start).toBe(0);
		for (let i = 1; i < (tokens?.length ?? 0); i++)
			expect(tokens?.[i]?.start).toBe(tokens?.[i - 1]?.end);
	});

	test("non-ASCII before the close keeps byte coordinates", () => {
		// `é` is two bytes; the cut is a byte offset into the analyzed text.
		const input = '/system identity set name="é"}x';
		const [fault] = tokenFaults(input);
		expect(fault?.span).toEqual({ start: 30, end: 32 });
		expect(explainCommand(input).input.bytes).toBe(32);
	});

	test("a stray close inside an open group is still a rejection", () => {
		for (const input of [":put (1})", "{:put 1]}", ":put [:len a}]"])
			expect(explainCommand(input).verdict).toBe("fail");
	});
});
