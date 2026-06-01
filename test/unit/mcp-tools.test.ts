import { describe, expect, test } from "bun:test";
import { resolveMcpConfig } from "../../src/mcp/config.ts";
import {
	handleDevices,
	handleExecute,
	handleExplain,
	handleRetrieve,
	handleValidate,
} from "../../src/mcp/tools.ts";
import { makeMcpTestCdb } from "./mcp-cdb-fixture.ts";

interface ExplainData {
	path?: string;
	verb?: string;
	writeShaped?: boolean;
}

function config(path: string) {
	return resolveMcpConfig({ cdbFile: path, env: {} });
}

describe("handleExplain (offline)", () => {
	test("canonicalizes a structured write command", () => {
		const env = handleExplain({
			command: "/ip/firewall/filter/add chain=forward action=drop",
		});
		expect(env.ok).toBe(true);
		if (!env.ok) {
			return;
		}
		const data = env.data as ExplainData;
		expect(data.path).toBe("/ip/firewall/filter");
		expect(data.verb).toBe("add");
		expect(data.writeShaped).toBe(true);
	});

	test("a read command is not write-shaped", () => {
		const env = handleExplain({ command: "/interface/print" });
		expect(env.ok).toBe(true);
		if (!env.ok) {
			return;
		}
		expect((env.data as ExplainData).writeShaped).toBe(false);
	});
});

describe("handleValidate (offline allowlist gate)", () => {
	test("rejects an unregistered target before any network call", async () => {
		const { path, cleanup } = await makeMcpTestCdb([{ target: "known" }]);
		try {
			const env = await handleValidate(
				{ target: "stranger", command: "/interface/print" },
				config(path),
			);
			expect(env.ok).toBe(false);
			if (env.ok) {
				return;
			}
			expect(env.error.code).toBe("cdb/target-not-registered");
		} finally {
			await cleanup();
		}
	});
});

describe("handleRetrieve (offline allowlist gate)", () => {
	test("requires exactly one of target or group", async () => {
		const { path, cleanup } = await makeMcpTestCdb([{ target: "known" }]);
		try {
			const both = await handleRetrieve(
				{ target: "known", group: "edge", path: "/system/resource" },
				config(path),
			);
			expect(both.ok).toBe(false);
			const neither = await handleRetrieve(
				{ path: "/system/resource" },
				config(path),
			);
			expect(neither.ok).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("rejects an unregistered target", async () => {
		const { path, cleanup } = await makeMcpTestCdb([{ target: "known" }]);
		try {
			const env = await handleRetrieve(
				{ target: "stranger", path: "/system/resource" },
				config(path),
			);
			expect(env.ok).toBe(false);
			if (env.ok) {
				return;
			}
			expect(env.error.code).toBe("cdb/target-not-registered");
		} finally {
			await cleanup();
		}
	});

	test("rejects an empty group", async () => {
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "known", group: "edge" },
		]);
		try {
			const env = await handleRetrieve(
				{ group: "core", path: "/system/resource" },
				config(path),
			);
			expect(env.ok).toBe(false);
			if (env.ok) {
				return;
			}
			expect(env.error.code).toBe("cdb/target-not-registered");
		} finally {
			await cleanup();
		}
	});
});

describe("handleExecute (offline gates)", () => {
	test("rejects an unregistered target", async () => {
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "rw-box", comment: "mcp=rw" },
		]);
		try {
			const env = await handleExecute(
				{ target: "stranger", command: "/system/identity/print" },
				config(path),
			);
			expect(env.ok).toBe(false);
			if (env.ok) {
				return;
			}
			expect(env.error.code).toBe("cdb/target-not-registered");
		} finally {
			await cleanup();
		}
	});

	test("denies a write to an mcp=ro device before any network call", async () => {
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "ro-box", comment: "mcp=ro" },
		]);
		try {
			const env = await handleExecute(
				{
					target: "ro-box",
					command: "/system/identity/set name=x",
					confirm: true,
				},
				config(path),
			);
			expect(env.ok).toBe(false);
			if (env.ok) {
				return;
			}
			expect(env.error.code).toBe("cdb/write-not-permitted");
		} finally {
			await cleanup();
		}
	});

	test("an mcp=rw write without confirm is refused as confirmation-required", async () => {
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "rw-box", comment: "mcp=rw" },
		]);
		try {
			const env = await handleExecute(
				{
					target: "rw-box",
					command: "/system/identity/set name=x",
					via: "rest-api",
				},
				config(path),
			);
			expect(env.ok).toBe(false);
			if (env.ok) {
				return;
			}
			expect(env.error.code).toBe("usage/confirmation-required");
		} finally {
			await cleanup();
		}
	});
});

describe("handleDevices (offline registry reads)", () => {
	test("lists registered devices", async () => {
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "a", group: "edge" },
			{ target: "b", group: "core" },
		]);
		try {
			const env = await handleDevices({ op: "list" }, config(path));
			expect(env.ok).toBe(true);
			if (!env.ok) {
				return;
			}
			expect((env.data as readonly unknown[]).length).toBe(2);
		} finally {
			await cleanup();
		}
	});

	test("groups summarizes membership", async () => {
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "a", group: "edge" },
			{ target: "b", group: "edge" },
		]);
		try {
			const env = await handleDevices({ op: "groups" }, config(path));
			expect(env.ok).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("show requires a target", async () => {
		const { path, cleanup } = await makeMcpTestCdb([{ target: "a" }]);
		try {
			const env = await handleDevices({ op: "show" }, config(path));
			expect(env.ok).toBe(false);
			if (env.ok) {
				return;
			}
			expect(env.error.code).toBe("input/invalid-command");
		} finally {
			await cleanup();
		}
	});

	test("show returns a registered device", async () => {
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "a", group: "edge" },
		]);
		try {
			const env = await handleDevices(
				{ op: "show", target: "a" },
				config(path),
			);
			expect(env.ok).toBe(true);
		} finally {
			await cleanup();
		}
	});
});
