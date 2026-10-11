import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { isFanoutMode } from "../../src/cli/selection.ts";
import { parseTransferCliArgs } from "../../src/cli/transfer.ts";
import { fanoutExitCode } from "../../src/core/fanout.ts";
import { CentrsError } from "../../src/errors.ts";
import type {
	SelectionExpansion,
	SelectionMember,
	TargetSelection,
} from "../../src/resolver/selection.ts";
import type {
	TransferRequest,
	TransferSuccessEnvelope,
} from "../../src/transfer.ts";
import {
	type TransferFanoutInternals,
	transferFanout,
} from "../../src/transfer-fanout.ts";

function cdbMember(
	target: string,
	recordIndex: number,
	identity = target,
): SelectionMember {
	return {
		kind: "cdb",
		recordIndex,
		resolution: {
			target,
			identity,
			username: "admin",
			password: "pw",
			recordIndex,
			overrides: {},
			warnings: [],
		},
	};
}

function fakeSuccess(request: TransferRequest): TransferSuccessEnvelope {
	return {
		ok: true,
		data: {
			op: request.verb,
			remote: request.remote ?? null,
			local: request.local ?? null,
			bytes: 1,
			verified: "size",
			method: "rest",
		},
		warnings: [],
		tips: [],
		meta: {
			target: {
				input: request.targetInput,
				identity: request.targetInput,
				recordIndex: undefined,
			},
			via: "rest-api",
			settings: {},
			operation: {
				op: request.verb,
				method: "rest",
				request: {
					verb: request.verb,
					remote: request.remote ?? null,
					local: request.local ?? null,
					force: false,
					verify: "size",
					validate: true,
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

describe("parseTransferCliArgs — verb-keyword boundary", () => {
	test("two positional targets before the verb → fan-out", () => {
		const parsed = parseTransferCliArgs(["r1", "r2", "list"]);
		expect(parsed.targetPositionals).toEqual(["r1", "r2"]);
		expect(parsed.request.verb).toBe("list");
		expect(isFanoutMode(parsed.selectionFlags, 2)).toBe(true);
	});

	test("selector + verb → fan-out, targets from selector", () => {
		const parsed = parseTransferCliArgs([
			"--group",
			"prod",
			"download",
			"/f.npk",
		]);
		expect(parsed.targetPositionals).toEqual([]);
		expect(parsed.request.verb).toBe("download");
		expect(parsed.request.remote).toBe("/f.npk");
		expect(parsed.selectionFlags.groups).toEqual(["prod"]);
		expect(isFanoutMode(parsed.selectionFlags, 0)).toBe(true);
	});

	test("single target + verb stays single-target", () => {
		const parsed = parseTransferCliArgs(["r1", "list"]);
		expect(parsed.request.targetInput).toBe("r1");
		expect(parsed.request.verb).toBe("list");
		expect(isFanoutMode(parsed.selectionFlags, 1)).toBe(false);
	});

	test("verb aliases split too (`get` → download)", () => {
		const parsed = parseTransferCliArgs(["r1", "r2", "get", "/f.npk"]);
		expect(parsed.targetPositionals).toEqual(["r1", "r2"]);
		expect(parsed.request.verb).toBe("download");
	});

	test("top-level alias + selector: positionals are paths", () => {
		const parsed = parseTransferCliArgs(
			["--group", "prod", "local.npk", "/remote.npk"],
			"upload",
		);
		expect(parsed.request.verb).toBe("upload");
		expect(parsed.request.local).toBe("local.npk");
		expect(parsed.request.remote).toBe("/remote.npk");
		expect(parsed.targetPositionals).toEqual([]);
		expect(isFanoutMode(parsed.selectionFlags, 0)).toBe(true);
	});

	test("`--quickchr <name>` + verb: single-target with the machine on the request", () => {
		const parsed = parseTransferCliArgs(["--quickchr", "lab", "list"]);
		expect(parsed.request.verb).toBe("list");
		expect(parsed.request.quickchr).toBe("lab");
		expect(parsed.request.targetInput).toBeUndefined();
		expect(parsed.targetPositionals).toEqual([]);
		expect(isFanoutMode(parsed.selectionFlags, 0)).toBe(false);
	});

	test("`--quickchr` + top-level alias: positionals are paths", () => {
		const parsed = parseTransferCliArgs(
			["--quickchr", "lab", "local.npk", "/remote.npk"],
			"upload",
		);
		expect(parsed.request.verb).toBe("upload");
		expect(parsed.request.local).toBe("local.npk");
		expect(parsed.request.remote).toBe("/remote.npk");
		expect(parsed.request.quickchr).toBe("lab");
		expect(parsed.targetPositionals).toEqual([]);
	});

	test("`--quickchr` + positional target is a usage conflict", () => {
		expect(() =>
			parseTransferCliArgs(["--quickchr", "lab", "r1", "list"]),
		).toThrow(/exclusive/);
	});
});

describe("transferFanout", () => {
	test("fans a list out across members, exit 0", async () => {
		const internals: TransferFanoutInternals = {
			expand: async () =>
				expansionOf([cdbMember("10.0.0.1", 0), cdbMember("10.0.0.2", 1)]),
			execute: async (request) => fakeSuccess(request),
			sleep: async () => {},
		};
		const envelope = await transferFanout(
			{ verb: "list" },
			selection(),
			{},
			internals,
		);
		expect(envelope.ok).toBe(true);
		expect(envelope.data.summary).toEqual({ total: 2, ok: 2, failed: 0 });
		expect(envelope.meta.operation?.kind).toBe("fanout");
		expect(fanoutExitCode(envelope)).toBe(0);
	});

	test("a per-target failure is an inner ok:false, exit 2", async () => {
		const internals: TransferFanoutInternals = {
			expand: async () =>
				expansionOf([cdbMember("10.0.0.1", 0), cdbMember("10.0.0.2", 1)]),
			execute: async (request) => {
				if (request.targetInput === "10.0.0.2") {
					throw new CentrsError({
						code: "transport/connection-refused",
						summary: "refused",
					});
				}
				return fakeSuccess(request);
			},
			sleep: async () => {},
		};
		const envelope = await transferFanout(
			{ verb: "list" },
			selection(),
			{},
			internals,
		);
		expect(envelope.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
		expect(fanoutExitCode(envelope)).toBe(2);
		// The inner FAILURE keeps its per-target identity: `buildTransferErrorEnvelope`
		// only knows `targetInput`, so `applyMemberMeta` restores recordIndex/identity
		// (without it, record-index ordering breaks — a real bug the CHR test caught).
		const failed = envelope.data.targets.find((t) => !t.ok);
		expect(failed?.meta.target.recordIndex).toBe(1);
		expect(failed?.meta.target.identity).toBe("10.0.0.2");
	});

	test("a per-target failure after resolution keeps the resolved meta (#391)", async () => {
		// The default execute path (no `internals.execute`): each member resolves
		// inside `transfer()`, then a >60 KB `--via rest` upload fails before any
		// network call — after resolution, so the inner envelope must carry it.
		const dir = mkdtempSync(join(tmpdir(), "centrs-fanout-391-"));
		const local = join(dir, "big.bin");
		writeFileSync(local, Buffer.alloc(70_000, 1));
		try {
			const envelope = await transferFanout(
				{
					verb: "upload",
					local,
					remote: "big.bin",
					via: "rest",
					yes: true,
					password: "hidden-fanout-pw",
				},
				selection(),
				{},
				{
					expand: async () =>
						expansionOf([
							cdbMember("10.0.0.1", 0, "edge-1"),
							{ kind: "literal", input: "192.0.2.9" },
						]),
					sleep: async () => {},
				},
			);
			expect(envelope.data.summary).toEqual({ total: 2, ok: 0, failed: 2 });
			const [cdb, literal] = envelope.data.targets;
			for (const target of [cdb, literal]) {
				expect(target?.ok).toBe(false);
				if (!target || target.ok) continue;
				expect(target.error.code).toBe("transport/unsupported-operation");
				expect(target.meta.via).toBe("rest-api");
				expect(target.meta.settings.password).toEqual({
					kind: "cli",
					key: "password",
				});
				expect(target.meta.operation?.auth.passwordProvided).toBe(true);
			}
			expect(cdb?.meta.target).toMatchObject({
				host: "10.0.0.1",
				identity: "edge-1",
				recordIndex: 0,
			});
			expect(literal?.meta.target).toMatchObject({
				input: "192.0.2.9",
				host: "192.0.2.9",
			});
			expect(literal?.meta.target.recordIndex).toBeUndefined();
			expect(JSON.stringify(envelope)).not.toContain("hidden-fanout-pw");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an empty selection is ok:true, 0/0/0, exit 0", async () => {
		const internals: TransferFanoutInternals = {
			expand: async () => ({
				targets: [],
				warnings: [{ code: "cdb/empty-group", message: "none", context: {} }],
				empty: true,
			}),
		};
		const envelope = await transferFanout(
			{ verb: "list" },
			selection(),
			{},
			internals,
		);
		expect(envelope.data.summary).toEqual({ total: 0, ok: 0, failed: 0 });
		expect(fanoutExitCode(envelope)).toBe(0);
	});

	test("download fan-out without --out-dir is an outer error", async () => {
		const internals: TransferFanoutInternals = {
			expand: async () => expansionOf([cdbMember("10.0.0.1", 0)]),
			execute: async (request) => fakeSuccess(request),
		};
		await expect(
			transferFanout(
				{ verb: "download", remote: "/f.npk" },
				selection(),
				{},
				internals,
			),
		).rejects.toMatchObject({ code: "usage/conflicting-flags" });
	});

	test("download fan-out writes a collision-safe local path per target", async () => {
		const seen: Array<string | undefined> = [];
		const internals: TransferFanoutInternals = {
			expand: async () =>
				// Two records with the SAME identity force a name collision.
				expansionOf([
					cdbMember("10.0.0.1", 0, "router"),
					cdbMember("10.0.0.2", 1, "router"),
				]),
			execute: async (request) => {
				seen.push(request.local);
				return fakeSuccess(request);
			},
			sleep: async () => {},
		};
		const envelope = await transferFanout(
			{ verb: "download", remote: "/flash/log.npk", outDir: "/tmp/out" },
			selection(),
			{},
			internals,
		);
		expect(envelope.data.summary.ok).toBe(2);
		// Distinct paths, both under out-dir, keeping the .npk extension.
		expect(seen).toHaveLength(2);
		expect(new Set(seen).size).toBe(2);
		for (const path of seen) {
			// path.join uses the OS separator (backslash on Windows); normalize
			// to forward slashes so the pattern is platform-independent.
			expect(path?.split(sep).join("/")).toMatch(/^\/tmp\/out\/router.*\.npk$/);
		}
	});

	test("a mutating verb without --yes is rejected, naming the blast radius", async () => {
		const internals: TransferFanoutInternals = {
			expand: async () =>
				expansionOf([cdbMember("10.0.0.1", 0), cdbMember("10.0.0.2", 1)]),
			execute: async (request) => fakeSuccess(request),
		};
		await expect(
			transferFanout(
				{ verb: "remove", remote: "/f", stdinIsTty: false },
				selection(),
				{},
				internals,
			),
		).rejects.toThrow(/2 router\(s\)/);
	});

	test("a mutating verb with --yes proceeds", async () => {
		const internals: TransferFanoutInternals = {
			expand: async () =>
				expansionOf([cdbMember("10.0.0.1", 0), cdbMember("10.0.0.2", 1)]),
			execute: async (request) => fakeSuccess(request),
			sleep: async () => {},
		};
		const envelope = await transferFanout(
			{ verb: "remove", remote: "/f", yes: true, stdinIsTty: false },
			selection(),
			{},
			internals,
		);
		expect(envelope.data.summary.ok).toBe(2);
	});

	test("a __default__ member fails that one target deterministically", async () => {
		const internals: TransferFanoutInternals = {
			expand: async () =>
				expansionOf([cdbMember("10.0.0.1", 0), cdbMember("__default__", 3)]),
			execute: async (request) => fakeSuccess(request),
			sleep: async () => {},
		};
		const envelope = await transferFanout(
			{ verb: "list" },
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

	test("a literal (ad-hoc) member drops a borrowed __default__ recordIndex", async () => {
		const internals: TransferFanoutInternals = {
			expand: async () => expansionOf([{ kind: "literal", input: "1.2.3.4" }]),
			execute: async (request) => {
				const success = fakeSuccess(request);
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
		const envelope = await transferFanout(
			{ verb: "list" },
			selection({ groups: [], positionals: ["1.2.3.4"] }),
			{},
			internals,
		);
		const target = envelope.data.targets[0];
		expect(target?.meta.target.recordIndex).toBeUndefined();
		expect(target?.meta.target.input).toBe("1.2.3.4");
	});
});
