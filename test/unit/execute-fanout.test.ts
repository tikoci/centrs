import { describe, expect, test } from "bun:test";
import { parseExecuteCliArgs } from "../../src/cli/execute.ts";
import { isFanoutMode } from "../../src/cli/selection.ts";
import { fanoutExitCode } from "../../src/core/fanout.ts";
import { CentrsError } from "../../src/errors.ts";
import type {
	ExecuteSuccessEnvelope,
	ResolvedExecuteRequest,
} from "../../src/execute.ts";
import {
	type ExecuteFanoutInternals,
	executeFanout,
	renderExecuteFanoutEnvelope,
} from "../../src/execute-fanout.ts";
import type {
	SelectionExpansion,
	SelectionMember,
	TargetSelection,
} from "../../src/resolver/selection.ts";

function cdbMember(target: string, recordIndex: number): SelectionMember {
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

function fakeSuccess(resolved: ResolvedExecuteRequest): ExecuteSuccessEnvelope {
	return {
		ok: true,
		data: { ran: true },
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
				kind: "execute",
				objectCount: 1,
				request: {
					command: resolved.command,
					write: false,
					yes: false,
					validate: true,
					verbose: false,
					timeoutMs: 10000,
					format: "json",
				},
				auth: { passwordProvided: true },
			},
		},
	};
}

function expansionOf(members: readonly SelectionMember[]): SelectionExpansion {
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

const READ = "/system/resource/print";
const WRITE = "/ip/address/add address=198.51.100.1/32 interface=ether1";

function emptyFlags() {
	return { groups: [], where: [], all: false, default: false };
}

describe("parseExecuteCliArgs — `--` boundary + selectors", () => {
	test("two positional targets + `--` + command → fan-out", () => {
		const parsed = parseExecuteCliArgs([
			"r1",
			"r2",
			"--",
			"/system/resource/print",
		]);
		expect(parsed.targetPositionals).toEqual(["r1", "r2"]);
		expect(parsed.command).toBe("/system/resource/print");
		expect(isFanoutMode(parsed.selectionFlags ?? emptyFlags(), 2)).toBe(true);
	});

	test("selector + no `--` → all positionals are the command, targets from selector", () => {
		const parsed = parseExecuteCliArgs([
			"--group",
			"prod",
			"/system/resource/print",
		]);
		expect(parsed.targetPositionals).toEqual([]);
		expect(parsed.command).toBe("/system/resource/print");
		expect(parsed.selectionFlags?.groups).toEqual(["prod"]);
		expect(isFanoutMode(parsed.selectionFlags ?? emptyFlags(), 0)).toBe(true);
	});

	test("single positional target + command (no `--`) stays single-target", () => {
		const parsed = parseExecuteCliArgs(["r1", "/system/resource/print"]);
		expect(parsed.targetInput).toBe("r1");
		expect(parsed.command).toBe("/system/resource/print");
		expect(isFanoutMode(parsed.selectionFlags ?? emptyFlags(), 1)).toBe(false);
	});

	test("multiple positionals WITHOUT `--` and no selector stay single-target (legacy split)", () => {
		const parsed = parseExecuteCliArgs(["r1", "/ip", "print"]);
		expect(parsed.targetInput).toBe("r1");
		expect(parsed.command).toBe("/ip print");
		expect(isFanoutMode(parsed.selectionFlags ?? emptyFlags(), 1)).toBe(false);
	});

	test("single target via `--` is single-target, not fan-out", () => {
		const parsed = parseExecuteCliArgs(["r1", "--", "/interface", "print"]);
		expect(parsed.targetPositionals).toEqual(["r1"]);
		expect(parsed.command).toBe("/interface print");
		expect(isFanoutMode(parsed.selectionFlags ?? emptyFlags(), 1)).toBe(false);
	});
});

describe("executeFanout", () => {
	const base = { command: READ, stdinIsTty: false };

	test("fans a read out across members, ordered by record index, exit 0", async () => {
		const internals: ExecuteFanoutInternals = {
			expand: async () =>
				expansionOf([cdbMember("10.0.0.1", 0), cdbMember("10.0.0.2", 1)]),
			execute: async (resolved) => fakeSuccess(resolved),
			sleep: async () => {},
		};
		const envelope = await executeFanout(base, selection(), {}, internals);
		expect(envelope.ok).toBe(true);
		expect(envelope.data.summary).toEqual({ total: 2, ok: 2, failed: 0 });
		expect(envelope.data.targets.map((t) => t.meta.target.recordIndex)).toEqual(
			[0, 1],
		);
		expect(envelope.meta.operation?.kind).toBe("fanout");
		expect(fanoutExitCode(envelope)).toBe(0);
	});

	test("a per-target failure is an inner ok:false, exit 2 (partial)", async () => {
		const internals: ExecuteFanoutInternals = {
			expand: async () =>
				expansionOf([cdbMember("10.0.0.1", 0), cdbMember("10.0.0.2", 1)]),
			execute: async (resolved) => {
				if (resolved.target.host === "10.0.0.2") {
					throw new CentrsError({
						code: "transport/connection-refused",
						summary: "refused",
					});
				}
				return fakeSuccess(resolved);
			},
			sleep: async () => {},
		};
		const envelope = await executeFanout(base, selection(), {}, internals);
		expect(envelope.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
		expect(fanoutExitCode(envelope)).toBe(2);
		const failed = envelope.data.targets.find((t) => !t.ok);
		expect(failed && !failed.ok && failed.error.code).toBe(
			"transport/connection-refused",
		);
	});

	test("an empty selection is ok:true with summary 0/0/0 and exit 0", async () => {
		const internals: ExecuteFanoutInternals = {
			expand: async () => ({
				targets: [],
				warnings: [{ code: "cdb/empty-group", message: "none", context: {} }],
				empty: true,
			}),
		};
		const envelope = await executeFanout(base, selection(), {}, internals);
		expect(envelope.data.summary).toEqual({ total: 0, ok: 0, failed: 0 });
		expect(envelope.warnings.map((w) => w.code)).toContain("cdb/empty-group");
		expect(fanoutExitCode(envelope)).toBe(0);
	});

	test("a write-shaped fan-out without --yes is rejected, naming the blast radius", async () => {
		const internals: ExecuteFanoutInternals = {
			expand: async () =>
				expansionOf([cdbMember("10.0.0.1", 0), cdbMember("10.0.0.2", 1)]),
			execute: async (resolved) => fakeSuccess(resolved),
		};
		await expect(
			executeFanout(
				{ command: WRITE, stdinIsTty: false },
				selection(),
				{},
				internals,
			),
		).rejects.toThrow(/2 router\(s\)/);
	});

	test("a write-shaped fan-out with --yes proceeds", async () => {
		const internals: ExecuteFanoutInternals = {
			expand: async () =>
				expansionOf([cdbMember("10.0.0.1", 0), cdbMember("10.0.0.2", 1)]),
			execute: async (resolved) => fakeSuccess(resolved),
			sleep: async () => {},
		};
		const envelope = await executeFanout(
			{ command: WRITE, yes: true, stdinIsTty: false },
			selection(),
			{},
			internals,
		);
		expect(envelope.data.summary.ok).toBe(2);
		expect(envelope.meta.operation?.request.write).toBe(true);
	});

	test("a __default__ member fails that one target deterministically", async () => {
		const internals: ExecuteFanoutInternals = {
			expand: async () =>
				expansionOf([cdbMember("10.0.0.1", 0), cdbMember("__default__", 3)]),
			execute: async (resolved) => fakeSuccess(resolved),
			sleep: async () => {},
		};
		const envelope = await executeFanout(
			base,
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
		expect(envelope.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
	});

	test("a literal (ad-hoc) member drops a borrowed __default__ recordIndex and keeps its input", async () => {
		const internals: ExecuteFanoutInternals = {
			expand: async () => expansionOf([{ kind: "literal", input: "1.2.3.4" }]),
			execute: async (resolved) => {
				const success = fakeSuccess(resolved);
				return {
					...success,
					meta: {
						...success.meta,
						target: { host: "1.2.3.4", recordIndex: 3 },
					},
				};
			},
			sleep: async () => {},
		};
		const envelope = await executeFanout(
			{ command: READ, username: "admin", password: "pw", stdinIsTty: false },
			selection({ groups: [], positionals: ["1.2.3.4"] }),
			{ HOME: "/nonexistent-centrs-home" },
			internals,
		);
		const target = envelope.data.targets[0];
		expect(target?.meta.target.recordIndex).toBeUndefined();
		expect(target?.meta.target.input).toBe("1.2.3.4");
		const text = renderExecuteFanoutEnvelope(envelope, "text");
		expect(text).toContain("1.2.3.4");
		expect(text).not.toContain("(unknown)");
	});
});
