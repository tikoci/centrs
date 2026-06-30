import { describe, expect, test } from "bun:test";
import {
	type ApiRequest,
	type ApiSuccessEnvelope,
	apiRequestSummaryFromRequest,
	type ResolvedApiRequest,
} from "../../src/api.ts";
import {
	type ApiFanoutInternals,
	apiFanout,
	renderApiFanoutEnvelope,
} from "../../src/api-fanout.ts";
import { parseApiCliArgs } from "../../src/cli/api.ts";
import { isFanoutMode } from "../../src/cli/selection.ts";
import { fanoutExitCode } from "../../src/core/fanout.ts";
import { CentrsError } from "../../src/errors.ts";
import type {
	CdbSelectionExpansion,
	CdbSelectionMember,
	TargetSelection,
} from "../../src/resolver/selection.ts";

function cdbMember(target: string, recordIndex: number): CdbSelectionMember {
	return {
		kind: "cdb",
		recordIndex,
		resolution: {
			target,
			identity: target,
			username: "admin",
			password: "pw",
			recordIndex,
			overrides: {},
			warnings: [],
		},
	};
}

function fakeSuccess(
	request: ApiRequest,
	resolved: ResolvedApiRequest,
): ApiSuccessEnvelope {
	return {
		ok: true,
		data: { resolved: true },
		warnings: [],
		tips: [],
		meta: {
			target: {
				identity: resolved.target.identity,
				host: resolved.target.host,
				recordIndex: resolved.target.recordIndex,
			},
			via: resolved.via.value,
			settings: {},
			operation: {
				kind: "api",
				objectCount: 1,
				request: apiRequestSummaryFromRequest(request, {}),
				auth: { passwordProvided: true },
			},
		},
	};
}

function expansionOf(
	members: readonly CdbSelectionMember[],
): CdbSelectionExpansion {
	return { targets: members, warnings: [], empty: false };
}

function selection(overrides: Partial<TargetSelection> = {}): TargetSelection {
	return {
		positionals: [],
		groups: ["prod"],
		all: false,
		default: false,
		where: [],
		...overrides,
	};
}

describe("parseApiCliArgs — positional boundary", () => {
	test("two positional targets + endpoint", () => {
		const parsed = parseApiCliArgs(["r1", "r2", "ip/address"]);
		expect(parsed.targetPositionals).toEqual(["r1", "r2"]);
		expect(parsed.endpoint).toBe("ip/address");
		expect(isFanoutMode(parsed.selectionFlags ?? emptyFlags(), 2)).toBe(true);
	});

	test("--group + endpoint has no positional targets", () => {
		const parsed = parseApiCliArgs(["--group", "prod", "ip/address"]);
		expect(parsed.targetPositionals).toEqual([]);
		expect(parsed.endpoint).toBe("ip/address");
		expect(parsed.selectionFlags?.groups).toEqual(["prod"]);
		expect(isFanoutMode(parsed.selectionFlags ?? emptyFlags(), 0)).toBe(true);
	});

	test("single target + endpoint stays single-target", () => {
		const parsed = parseApiCliArgs(["r1", "ip/address"]);
		expect(parsed.targetInput).toBe("r1");
		expect(parsed.endpoint).toBe("ip/address");
		expect(isFanoutMode(parsed.selectionFlags ?? emptyFlags(), 1)).toBe(false);
	});

	test("--where / --all / --concurrency parse into selection flags", () => {
		const parsed = parseApiCliArgs([
			"--where",
			"board=RB5009",
			"--all",
			"--concurrency",
			"3",
			"ip/address",
		]);
		expect(parsed.selectionFlags?.where).toEqual([
			{ key: "board", value: "RB5009" },
		]);
		expect(parsed.selectionFlags?.all).toBe(true);
		expect(parsed.selectionFlags?.concurrency).toBe(3);
	});

	test("--concurrency rejects numeric prefixes / decimals / < 1 (strict integer >= 1)", () => {
		for (const bad of ["2abc", "1.5", "abc", "0", "-1"]) {
			expect(() =>
				parseApiCliArgs(["--group", "g", "--concurrency", bad, "ip/address"]),
			).toThrow(/--concurrency must be an integer >= 1/);
		}
	});
});

function emptyFlags() {
	return { groups: [], where: [], all: false, default: false };
}

describe("apiFanout", () => {
	const base: ApiRequest = {
		endpoint: "ip/address",
		stdinIsTty: false,
	};

	test("fans a GET out across members, ordered by record index, exit 0", async () => {
		const internals: ApiFanoutInternals = {
			expand: async () =>
				expansionOf([cdbMember("10.0.0.1", 0), cdbMember("10.0.0.2", 1)]),
			execute: async (resolved) => fakeSuccess(base, resolved),
			sleep: async () => {},
		};
		const envelope = await apiFanout(base, selection(), {}, internals);
		expect(envelope.ok).toBe(true);
		expect(envelope.data.summary).toEqual({ total: 2, ok: 2, failed: 0 });
		expect(envelope.data.targets.map((t) => t.meta.target.recordIndex)).toEqual(
			[0, 1],
		);
		expect(envelope.meta.operation?.kind).toBe("fanout");
		expect(fanoutExitCode(envelope)).toBe(0);
	});

	test("a per-target failure is an inner ok:false, exit 2 (partial)", async () => {
		const internals: ApiFanoutInternals = {
			expand: async () =>
				expansionOf([cdbMember("10.0.0.1", 0), cdbMember("10.0.0.2", 1)]),
			execute: async (resolved) => {
				if (resolved.target.host === "10.0.0.2") {
					throw new CentrsError({
						code: "transport/connection-refused",
						summary: "refused",
					});
				}
				return fakeSuccess(base, resolved);
			},
			sleep: async () => {},
		};
		const envelope = await apiFanout(base, selection(), {}, internals);
		expect(envelope.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
		expect(fanoutExitCode(envelope)).toBe(2);
		const failed = envelope.data.targets.find((t) => !t.ok);
		expect(failed && !failed.ok && failed.error.code).toBe(
			"transport/connection-refused",
		);
	});

	test("an empty selection is ok:true with summary 0/0/0 and exit 0", async () => {
		const internals: ApiFanoutInternals = {
			expand: async () => ({
				targets: [],
				warnings: [{ code: "cdb/empty-group", message: "none", context: {} }],
				empty: true,
			}),
		};
		const envelope = await apiFanout(base, selection(), {}, internals);
		expect(envelope.data.summary).toEqual({ total: 0, ok: 0, failed: 0 });
		expect(envelope.warnings.map((w) => w.code)).toContain("cdb/empty-group");
		expect(fanoutExitCode(envelope)).toBe(0);
	});

	test("a mutating fan-out without --yes is rejected, naming the blast radius", async () => {
		const internals: ApiFanoutInternals = {
			expand: async () =>
				expansionOf([cdbMember("10.0.0.1", 0), cdbMember("10.0.0.2", 1)]),
			execute: async (resolved) => fakeSuccess(base, resolved),
		};
		await expect(
			apiFanout({ ...base, method: "PUT" }, selection(), {}, internals),
		).rejects.toThrow(/2 router\(s\)/);
	});

	test("a mutating fan-out with --yes proceeds", async () => {
		const internals: ApiFanoutInternals = {
			expand: async () =>
				expansionOf([cdbMember("10.0.0.1", 0), cdbMember("10.0.0.2", 1)]),
			execute: async (resolved) => fakeSuccess(base, resolved),
			sleep: async () => {},
		};
		const envelope = await apiFanout(
			{ ...base, method: "PUT", yes: true },
			selection(),
			{},
			internals,
		);
		expect(envelope.data.summary.ok).toBe(2);
	});

	test("a __default__ member fails that one target deterministically", async () => {
		const internals: ApiFanoutInternals = {
			expand: async () =>
				expansionOf([cdbMember("10.0.0.1", 0), cdbMember("__default__", 3)]),
			execute: async (resolved) => fakeSuccess(base, resolved),
			sleep: async () => {},
		};
		const envelope = await apiFanout(
			{ ...base, default: true } as ApiRequest,
			selection({ default: true }),
			{},
			internals,
		);
		const defaultTarget = envelope.data.targets.find(
			(t) => t.meta.target.recordIndex === 3,
		);
		expect(defaultTarget && !defaultTarget.ok && defaultTarget.error.code).toBe(
			"target/unresolved",
		);
		// The other target still succeeded — partial.
		expect(envelope.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
	});

	test("a globally-invalid --via is an outer pre-flight throw, not N per-target failures", async () => {
		let expanded = false;
		const internals: ApiFanoutInternals = {
			expand: async () => {
				expanded = true;
				return expansionOf([cdbMember("10.0.0.1", 0)]);
			},
			execute: async (resolved) => fakeSuccess(base, resolved),
			sleep: async () => {},
		};
		await expect(
			apiFanout({ ...base, via: "ssh" }, selection(), {}, internals),
		).rejects.toMatchObject({ code: "routeros/protocol-not-implemented" });
		await expect(
			apiFanout({ ...base, via: "bogus" }, selection(), {}, internals),
		).rejects.toMatchObject({ code: "settings/invalid-via" });
		// The throw is pre-flight: selection never expanded.
		expect(expanded).toBe(false);
	});

	test("an invalid CENTRS_VIA (env-pinned) is rejected up front too", async () => {
		const internals: ApiFanoutInternals = {
			expand: async () => expansionOf([cdbMember("10.0.0.1", 0)]),
			execute: async (resolved) => fakeSuccess(base, resolved),
			sleep: async () => {},
		};
		await expect(
			apiFanout(base, selection(), { CENTRS_VIA: "bogus" }, internals),
		).rejects.toMatchObject({ code: "settings/invalid-via" });
	});

	test("a literal (ad-hoc) member drops a borrowed __default__ recordIndex and keeps its input", async () => {
		const internals: ApiFanoutInternals = {
			expand: async () => expansionOf([{ kind: "literal", input: "1.2.3.4" }]),
			// Simulate resolveApiRequest borrowing the __default__ record's index (3)
			// for fallback creds on an ad-hoc literal — distinct literals would
			// otherwise collide on that one index.
			execute: async (resolved) => {
				const base = fakeSuccess(
					{ endpoint: "ip/address", stdinIsTty: false },
					resolved,
				);
				return {
					...base,
					meta: { ...base.meta, target: { host: "1.2.3.4", recordIndex: 3 } },
				};
			},
			sleep: async () => {},
		};
		const envelope = await apiFanout(
			{
				endpoint: "ip/address",
				stdinIsTty: false,
				username: "admin",
				password: "pw",
			},
			selection({ groups: [], positionals: ["1.2.3.4"] }),
			{ HOME: "/nonexistent-centrs-home" },
			internals,
		);
		const target = envelope.data.targets[0];
		expect(target?.meta.target.recordIndex).toBeUndefined();
		expect(target?.meta.target.input).toBe("1.2.3.4");
		// The text renderer labels an ad-hoc target by its input, not "(unknown)".
		const text = renderApiFanoutEnvelope(envelope, "text");
		expect(text).toContain("1.2.3.4");
		expect(text).not.toContain("(unknown)");
	});
});
