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
