import { describe, expect, test } from "bun:test";
import {
	extractCompletionNames,
	type InspectBackend,
	type InspectChildItem,
	type InspectCompletionItem,
	inspectChildren,
	inspectChildrenOrEmpty,
	inspectCompletions,
	inspectPath,
	isArgumentNode,
	isCommandNode,
	pathTokens,
} from "../../src/core/inspect.ts";
import { CentrsError } from "../../src/errors.ts";

/** Records the (request, path) the core asks for and returns scripted rows. */
function recordingBackend(rows: unknown[]): {
	backend: InspectBackend;
	calls: { request: string; path: string }[];
} {
	const calls: { request: string; path: string }[] = [];
	const backend: InspectBackend = {
		inspect(request, path) {
			calls.push({ request, path });
			return Promise.resolve(rows);
		},
	};
	return { backend, calls };
}

describe("pathTokens", () => {
	test("splits a slash path and drops the leading slash + empties", () => {
		expect(pathTokens("/ip/address")).toEqual(["ip", "address"]);
		expect(pathTokens("ip/address")).toEqual(["ip", "address"]);
		expect(pathTokens("/ip//address/")).toEqual(["ip", "address"]);
	});

	test("an empty or root path yields no tokens", () => {
		expect(pathTokens("")).toEqual([]);
		expect(pathTokens("/")).toEqual([]);
	});
});

describe("inspectPath", () => {
	test("joins tokens with comma (the array-typed inspect path form)", () => {
		expect(inspectPath(["ip", "address"])).toBe("ip,address");
		expect(inspectPath(["system", "license", "renew"])).toBe(
			"system,license,renew",
		);
	});

	test("no tokens yields an empty string", () => {
		expect(inspectPath([])).toBe("");
	});
});

describe("isArgumentNode", () => {
	test("matches arg via either field; rejects non-arg", () => {
		expect(isArgumentNode({ type: "arg" })).toBe(true);
		expect(isArgumentNode({ "node-type": "arg" })).toBe(true);
		expect(isArgumentNode({ type: "cmd" })).toBe(false);
		expect(isArgumentNode({})).toBe(false);
	});
});

describe("isCommandNode", () => {
	test("matches a named cmd via either field", () => {
		expect(isCommandNode({ name: "print", type: "cmd" }, "print")).toBe(true);
		expect(isCommandNode({ name: "get", "node-type": "cmd" }, "get")).toBe(
			true,
		);
	});

	test("rejects a wrong name or a non-cmd node", () => {
		expect(isCommandNode({ name: "print", type: "cmd" }, "get")).toBe(false);
		expect(isCommandNode({ name: "print", type: "arg" }, "print")).toBe(false);
		expect(isCommandNode({ name: "print" }, "print")).toBe(false);
	});
});

describe("extractCompletionNames", () => {
	test("reads every name-like field, strips =value, trims, drops blanks", () => {
		const rows: InspectCompletionItem[] = [
			{ completion: "address=1.2.3.4" },
			{ name: " interface " },
			{ value: "comment" },
			{ text: "" },
			{},
		];
		expect(extractCompletionNames(rows)).toEqual([
			"address",
			"interface",
			"comment",
		]);
	});

	test("preserves row order WITHOUT de-duplication (callers sort/uniq)", () => {
		const rows: InspectCompletionItem[] = [
			{ name: "b" },
			{ name: "a" },
			{ name: "b" },
		];
		expect(extractCompletionNames(rows)).toEqual(["b", "a", "b"]);
	});
});

describe("inspectChildren / inspectCompletions", () => {
	test("issue the comma path with the right request mode", async () => {
		const childRow: InspectChildItem = { name: "print", type: "cmd" };
		const children = recordingBackend([childRow]);
		const result = await inspectChildren(children.backend, ["ip", "address"]);
		expect(result).toEqual([childRow]);
		expect(children.calls).toEqual([{ request: "child", path: "ip,address" }]);

		const completions = recordingBackend([{ name: "address" }]);
		await inspectCompletions(completions.backend, ["ip", "address", "print"]);
		expect(completions.calls).toEqual([
			{ request: "completion", path: "ip,address,print" },
		]);
	});
});

describe("inspectChildrenOrEmpty", () => {
	test("returns children when the path exists", async () => {
		const { backend } = recordingBackend([{ name: "print", type: "cmd" }]);
		expect(await inspectChildrenOrEmpty(backend, ["ip", "address"])).toEqual([
			{ name: "print", type: "cmd" },
		]);
	});

	test("swallows the two grounded not-found codes to an empty list", async () => {
		for (const code of [
			"routeros/unknown-path",
			"routeros/api-trap",
		] as const) {
			const backend: InspectBackend = {
				inspect() {
					return Promise.reject(new CentrsError({ code, summary: "x" }));
				},
			};
			expect(await inspectChildrenOrEmpty(backend, ["ip", "nope"])).toEqual([]);
		}
	});

	test("rethrows any other error (CentrsError or otherwise)", async () => {
		const transport: InspectBackend = {
			inspect() {
				return Promise.reject(
					new CentrsError({ code: "transport/timeout", summary: "x" }),
				);
			},
		};
		await expect(
			inspectChildrenOrEmpty(transport, ["ip", "address"]),
		).rejects.toThrow(CentrsError);

		const boom: InspectBackend = {
			inspect() {
				return Promise.reject(new Error("boom"));
			},
		};
		await expect(
			inspectChildrenOrEmpty(boom, ["ip", "address"]),
		).rejects.toThrow("boom");
	});
});
