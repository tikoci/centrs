/**
 * #583: `--match` record selection on the target-resolving commands. One
 * address saved under two users is legitimate (identity is (target, user));
 * `devices show --match` could pick one, but retrieve/execute/api/transfer
 * failed `identity/ambiguous` and named a `--match` they rejected.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.ts";
import {
	buildWinBoxCdbEntryRecord,
	encodeOpenWinBoxCdb,
	winBoxCdbRecordType,
} from "../../src/data/winbox-cdb.ts";
import { CentrsError } from "../../src/errors.ts";
import {
	apiFanout,
	executeFanout,
	retrieveFanout,
	transferFanout,
} from "../../src/index.ts";
import { assertNoMatchInFanout, resolveCdb } from "../../src/resolver/index.ts";
import { assertNoQuickchrOverrideConflict } from "../../src/resolver/quickchr-provider.ts";

const TARGET = "192.0.2.10";
let dir: string;
let cdbFile: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "centrs-match-"));
	cdbFile = join(dir, "two-users.cdb");
	const record = (user: string, password: string) =>
		buildWinBoxCdbEntryRecord({
			recordType: winBoxCdbRecordType.ipAdmin,
			target: TARGET,
			user,
			password,
			group: "lab",
			comment: "",
			profile: "<own>",
			savedPassword: true,
		});
	await writeFile(
		cdbFile,
		encodeOpenWinBoxCdb([
			record("alice", "a-secret"),
			record("bob", "b-secret"),
		]),
	);
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function failure(run: () => Promise<unknown>): Promise<CentrsError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof CentrsError) return error;
		throw error;
	}
	throw new Error("expected a CentrsError");
}

describe("resolveCdb --match (#583)", () => {
	test("without --match a shared target is ambiguous and names --match", async () => {
		const error = await failure(() =>
			resolveCdb({ targetInput: TARGET, cdbFile }, {}),
		);
		expect(error.code).toBe("identity/ambiguous");
		expect(error.remediation).toContain("--match user=<name>");
	});

	test("--match user= selects the record and its credentials", async () => {
		const bob = await resolveCdb(
			{ targetInput: TARGET, cdbFile, match: "user=bob" },
			{},
		);
		expect(bob).toMatchObject({
			target: TARGET,
			username: "bob",
			password: "b-secret",
			recordIndex: 1,
		});
		const alice = await resolveCdb(
			{ targetInput: TARGET, cdbFile, match: "user=alice" },
			{},
		);
		expect(alice).toMatchObject({ username: "alice", recordIndex: 0 });
	});

	test("a --match that selects nothing fails identity/no-match", async () => {
		const error = await failure(() =>
			resolveCdb({ targetInput: TARGET, cdbFile, match: "user=carol" }, {}),
		);
		expect(error.code).toBe("identity/no-match");
	});

	test("a malformed --match fails input/invalid-match", async () => {
		const error = await failure(() =>
			resolveCdb({ targetInput: TARGET, cdbFile, match: "color=red" }, {}),
		);
		expect(error.code).toBe("input/invalid-match");
	});

	test("MA4. --match never silently degrades to a literal host", async () => {
		// An unregistered address would otherwise proceed as a literal host.
		const literal = await failure(() =>
			resolveCdb({ targetInput: "192.0.2.99", cdbFile, match: "user=bob" }, {}),
		);
		expect(literal.code).toBe("identity/no-match");
		expect(literal.summary).toContain("192.0.2.99");
		// No CDB file in play at all.
		const noCdb = await failure(() =>
			resolveCdb(
				{ targetInput: TARGET, match: "user=bob" },
				{ CENTRS_CDB_FILE: undefined, HOME: dir, XDG_CONFIG_HOME: dir },
			),
		);
		// The "no CDB file in play" branch: the default path is absent.
		expect(noCdb.code).toBe("identity/no-match");
		// No <router> (e.g. --host only).
		const noTarget = await failure(() =>
			resolveCdb({ cdbFile, match: "user=bob" }, {}),
		);
		expect(noTarget.code).toBe("identity/no-match");
	});
});

test("MA4. a __default__-only fallback does not satisfy --match", async () => {
	const defaultOnly = join(dir, "default-only.cdb");
	await writeFile(
		defaultOnly,
		encodeOpenWinBoxCdb([
			buildWinBoxCdbEntryRecord({
				recordType: winBoxCdbRecordType.ipAdmin,
				target: "__default__",
				user: "bob",
				password: "fallback",
				group: "",
				comment: "",
				profile: "<own>",
				savedPassword: true,
			}),
		]),
	);
	// Without --match the __default__ record supplies fallback credentials.
	const fallback = await resolveCdb(
		{ targetInput: "192.0.2.50", cdbFile: defaultOnly },
		{},
	);
	expect(fallback?.defaults).toBeDefined();
	const error = await failure(() =>
		resolveCdb(
			{ targetInput: "192.0.2.50", cdbFile: defaultOnly, match: "user=bob" },
			{},
		),
	);
	expect(error.code).toBe("identity/no-match");
});

describe("MA4. --match is single-target and never ignored (#583)", () => {
	test("fan-out refuses --match", async () => {
		expect(() => assertNoMatchInFanout(undefined)).not.toThrow();
		expect(() => assertNoMatchInFanout("user=bob")).toThrow(
			expect.objectContaining({ code: "usage/conflicting-flags" }),
		);
		const selection = {
			positionals: [],
			groups: ["lab"],
			all: false,
			default: false,
			where: [],
			quickchr: [],
		};
		const env = { CENTRS_CDB_FILE: cdbFile };
		for (const run of [
			() =>
				retrieveFanout(
					{ path: "/system/resource", match: "user=bob" },
					selection,
					env,
				),
			() =>
				executeFanout(
					{ command: "/system/resource/print", match: "user=bob" },
					selection,
					env,
				),
			() =>
				apiFanout(
					{ endpoint: "system/resource", match: "user=bob" },
					selection,
					env,
				),
			() =>
				transferFanout(
					{ verb: "list", remote: "/", match: "user=bob" },
					selection,
					env,
				),
		]) {
			expect((await failure(run)).code).toBe("usage/conflicting-flags");
		}
	});

	test("--quickchr refuses --match", () => {
		expect(() =>
			assertNoQuickchrOverrideConflict({ match: "user=bob" }, "vm1"),
		).toThrow(
			expect.objectContaining({
				code: "usage/conflicting-flags",
				context: expect.objectContaining({ conflicts: ["--match"] }),
			}),
		);
	});
});

describe("CLI --match parsing (#583)", () => {
	// btest takes `--format json`, not `--json`.
	const outputFlag = (args: string[]) =>
		args[0] === "btest" ? ["--format", "json"] : ["--json"];

	async function cliError(args: string[]): Promise<Record<string, unknown>> {
		const errors: string[] = [];
		const originalError = console.error;
		const originalLog = console.log;
		console.error = (...parts: unknown[]) => {
			errors.push(parts.map(String).join(" "));
		};
		console.log = () => {};
		try {
			await runCli([...args, "--cdb-file", cdbFile, ...outputFlag(args)]);
		} finally {
			console.error = originalError;
			console.log = originalLog;
		}
		return (JSON.parse(errors[0] ?? "{}") as { error: Record<string, unknown> })
			.error;
	}

	test("MA4. retrieve --match with a fan-out selector or --quickchr conflicts", async () => {
		for (const args of [
			["retrieve", "--group", "lab", "/system/resource"],
			["retrieve", TARGET, "192.0.2.11", "/system/resource"],
			["retrieve", "--quickchr", "vm1", "/system/resource"],
		]) {
			const error = await cliError([...args, "--match", "user=bob"]);
			expect({ args, code: error["code"] }).toEqual({
				args,
				code: "usage/conflicting-flags",
			});
		}
	});

	test("MA4. api fan-out refuses --match before reading --input", async () => {
		// The body is never read: an unreadable --input would otherwise fail
		// first (and `--input -` would block on stdin).
		const error = await cliError([
			"api",
			"--group",
			"lab",
			"system/resource",
			"-X",
			"POST",
			"--input",
			join(dir, "never-read.json"),
			"--match",
			"user=bob",
		]);
		expect(error["code"]).toBe("usage/conflicting-flags");
		expect(error["context"]).toMatchObject({ flag: "--match" });
	});

	test("every target-resolving command accepts --match", async () => {
		for (const args of [
			["retrieve", TARGET, "/system/resource"],
			["execute", TARGET, "/system/resource/print"],
			["api", TARGET, "system/resource"],
			["transfer", TARGET, "list", "/"],
			["terminal", TARGET],
			["btest", "client", TARGET],
		]) {
			const error = await cliError([...args, "--match", "user=carol"]);
			// Selection runs and rejects the selector — the flag was accepted.
			expect({ args, code: error["code"] }).toEqual({
				args,
				code: "identity/no-match",
			});
		}
	});
});
