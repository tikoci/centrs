import { describe, expect, test } from "bun:test";
import { explainCommand } from "../../src/explain.ts";
import fixture from "../fixtures/explain/group-faults.json";

/**
 * `src/explain/group-faults.ts` against the device rows it was grounded on
 * (#505, #509, #511, #512). The fixture holds the `:parse` answer of CHR
 * 7.24.5 and 7.23.8 for every row, and `test/integration/explain-group-faults.test.ts`
 * holds the device to it. This file holds offline to it: a rejected row
 * reports its one fault at its span and fails, and an accepted row reports
 * none.
 */

const CODES = new Set([
	"empty-group",
	"misplaced-separator",
	"missing-operand",
	"invalid-at-sign",
	"invalid-command-brace",
]);

interface Row {
	issue: string;
	input: string;
	device: "accept" | "reject";
	code?: string;
	span?: [number, number];
}

function groupFaults(input: string) {
	return explainCommand(input).diagnostics.filter((d) =>
		CODES.has(d.code.replace("explain/canonicalizer/", "")),
	);
}

const rows = fixture.rows as Row[];

describe("explain group faults (#505, #509, #511, #512)", () => {
	test("the fixture pairs every device rejection with one fault", () => {
		for (const row of rows)
			expect({ input: row.input, fault: row.code !== undefined }).toEqual({
				input: row.input,
				fault: row.device === "reject",
			});
	});

	for (const row of rows) {
		test(`${row.issue} ${row.device}s ${JSON.stringify(row.input)}`, () => {
			const faults = groupFaults(row.input).map((d) => ({
				code: d.code.replace("explain/canonicalizer/", ""),
				span: [d.span.start, d.span.end],
				severity: d.severity,
			}));
			if (row.code === undefined) {
				expect(faults).toEqual([]);
				return;
			}
			expect(faults).toEqual([
				{ code: row.code, span: row.span as number[], severity: "error" },
			]);
			expect(explainCommand(row.input).verdict).toBe("fail");
		});
	}

	test("each fault spans the byte it is about", () => {
		const at = (input: string) => {
			const [fault] = groupFaults(input);
			return fault === undefined
				? undefined
				: input.slice(fault.span.start, fault.span.end);
		};
		expect(at(":local z {}")).toBe("{}");
		expect(at(":put ( )")).toBe("( )");
		expect(at(":put (1 +)")).toBe("+");
		expect(at(":put (1 == 2)")).toBe("=");
		expect(at(":put (1 &&& 2)")).toBe("&");
		expect(at(":put (1 and)")).toBe("and");
		expect(at(":local z {1,}")).toBe(",");
		expect(at(":local z {1\n;2}")).toBe(";");
		expect(at(":put (1\n+ 2)")).toBe("\n");
		expect(at("[admin@MikroTik]")).toBe("@");
	});

	test("an empty argument array is one `invalid-command-brace`, not two faults", () => {
		const diagnostics = explainCommand(
			"/ip address add comment={}",
		).diagnostics.filter((d) => d.severity === "error");
		expect(diagnostics.map((d) => [d.code, d.span.start])).toEqual([
			["explain/canonicalizer/invalid-command-brace", 24],
		]);
	});

	test("a `do={` body under an open `where` is not a named comparison", () => {
		// The shape of corpus `eworm/hotspot-to-wpa.template.rsc`, which
		// interleaves two `:if` lines so the second one's body sits inside the
		// first one's `[… find where`. The device reads past the `{`.
		const input =
			":if ([ :len [ /caps-man/access-list/find where \\\n" +
			"  :if ([ :len [ /interface/wifi/access-list/find where \\\n" +
			'      comment=("t " . $h) disabled ] ] = 0) do={ :put 1 }';
		expect(groupFaults(input)).toEqual([]);
	});

	test("the messages name the device answer and the remedy", () => {
		const message = (input: string) => groupFaults(input)[0]?.message ?? "";
		expect(message(":local z {}")).toContain("empty array");
		expect(message(":put ()")).toContain("empty expression");
		expect(message(":put (1 +)")).toContain("operator `+`");
		expect(message(":local z {;1}")).toContain("no array element before it");
		expect(message(":put (1; 2)")).toContain("statement separator");
		expect(message(":put (1\n+ 2)")).toContain("end the line with `\\`");
		expect(message("[admin@MikroTik] > /ip address print")).toContain(
			"console prompt",
		);
	});

	test("the faults cite their own evidence pass", () => {
		const data = explainCommand(":put (1 +)");
		const fault = data.diagnostics.find((d) =>
			d.code.endsWith("/missing-operand"),
		);
		expect(data.evidence.find((e) => e.id === fault?.ev)?.probe).toBe(
			"findGroupFaults",
		);
	});
});
