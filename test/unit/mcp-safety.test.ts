import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import { resolveMcpConfig } from "../../src/mcp/config.ts";
import {
	assertWritePermitted,
	loadAllowlistCdb,
	readWritePolicy,
	resolveRegisteredGroup,
	resolveRegisteredTarget,
} from "../../src/mcp/safety.ts";
import { makeMcpTestCdb } from "./mcp-cdb-fixture.ts";

describe("readWritePolicy", () => {
	test("defaults to ro and only mcp=rw opts into writes", () => {
		expect(readWritePolicy("")).toBe("ro");
		expect(readWritePolicy("mcp=ro")).toBe("ro");
		expect(readWritePolicy("via=rest-api mcp=rw")).toBe("rw");
		expect(readWritePolicy("mcp=yes")).toBe("ro");
	});
});

describe("MCP allowlist resolution", () => {
	test("resolves a registered target and reads its write policy", async () => {
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "rw-box", group: "edge", comment: "mcp=rw" },
			{ target: "ro-box", group: "edge", comment: "mcp=ro" },
		]);
		try {
			const cdb = await loadAllowlistCdb(
				resolveMcpConfig({ cdbFile: path, env: {} }),
			);
			const rw = resolveRegisteredTarget(cdb, "rw-box");
			expect(rw.writePolicy).toBe("rw");
			expect(rw.group).toBe("edge");
			const ro = resolveRegisteredTarget(cdb, "ro-box");
			expect(ro.writePolicy).toBe("ro");
		} finally {
			await cleanup();
		}
	});

	test("an unregistered target throws cdb/target-not-registered", async () => {
		const { path, cleanup } = await makeMcpTestCdb([{ target: "known" }]);
		try {
			const cdb = await loadAllowlistCdb(
				resolveMcpConfig({ cdbFile: path, env: {} }),
			);
			expect(() => resolveRegisteredTarget(cdb, "stranger")).toThrow(
				CentrsError,
			);
			try {
				resolveRegisteredTarget(cdb, "stranger");
			} catch (error) {
				expect((error as CentrsError).code).toBe("cdb/target-not-registered");
			}
		} finally {
			await cleanup();
		}
	});

	test("matches the CLI's lookup keys and reads the matched record's policy (#444)", async () => {
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "10.0.0.1", comment: "identity=r1 mcp=ro" },
			{
				target: "10.0.0.2",
				comment: "identity=r2 mac=02:00:00:00:00:02 ip=192.0.2.2 mcp=rw",
			},
		]);
		try {
			const cdb = await loadAllowlistCdb(
				resolveMcpConfig({ cdbFile: path, env: {} }),
			);
			expect(resolveRegisteredTarget(cdb, "r1")).toMatchObject({
				target: "10.0.0.1",
				recordIndex: 0,
				writePolicy: "ro",
			});
			for (const key of ["r2", "02:00:00:00:00:02", "192.0.2.2", "10.0.0.2"]) {
				expect(resolveRegisteredTarget(cdb, key)).toMatchObject({
					target: "10.0.0.2",
					recordIndex: 1,
					writePolicy: "rw",
				});
			}
		} finally {
			await cleanup();
		}
	});

	test("a name on two records is refused, never resolved to the first (#444)", async () => {
		// Before #444 the gate took the first exact-target record (mcp=rw here)
		// while the dialing resolver matches by every lookup key.
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "r1", comment: "mcp=rw" },
			{ target: "10.0.0.9", comment: "identity=r1 mcp=ro" },
			{ target: "10.0.0.7", comment: "identity=twin" },
			{ target: "10.0.0.8", comment: "identity=twin" },
		]);
		try {
			const cdb = await loadAllowlistCdb(
				resolveMcpConfig({ cdbFile: path, env: {} }),
			);
			for (const name of ["r1", "twin"]) {
				expect(() => resolveRegisteredTarget(cdb, name)).toThrow(
					expect.objectContaining({ code: "identity/ambiguous" }),
				);
			}
		} finally {
			await cleanup();
		}
	});

	test("resolveRegisteredGroup counts members and rejects empty groups", async () => {
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "a", group: "edge" },
			{ target: "b", group: "edge" },
		]);
		try {
			const cdb = await loadAllowlistCdb(
				resolveMcpConfig({ cdbFile: path, env: {} }),
			);
			expect(resolveRegisteredGroup(cdb, "edge")).toBe(2);
			try {
				resolveRegisteredGroup(cdb, "core");
			} catch (error) {
				expect((error as CentrsError).code).toBe("cdb/target-not-registered");
			}
		} finally {
			await cleanup();
		}
	});
});

describe("assertWritePermitted", () => {
	test("permits rw and rejects ro with cdb/write-not-permitted", () => {
		expect(() =>
			assertWritePermitted({
				target: "rw-box",
				user: "admin",
				group: "",
				recordIndex: 0,
				writePolicy: "rw",
			}),
		).not.toThrow();

		try {
			assertWritePermitted({
				target: "ro-box",
				user: "admin",
				group: "",
				recordIndex: 0,
				writePolicy: "ro",
			});
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(CentrsError);
			expect((error as CentrsError).code).toBe("cdb/write-not-permitted");
		}
	});
});
