import { describe, expect, test } from "bun:test";
import { loadCdb } from "../../src/devices.ts";
import { resolveMcpConfig } from "../../src/mcp/config.ts";
import {
	handleDevices,
	handleDiscover,
	handleExecute,
	handleExplain,
	handleRetrieve,
	handleValidate,
} from "../../src/mcp/tools.ts";
import { makeMcpTestCdb } from "./mcp-cdb-fixture.ts";
import { udpLoopbackSupported } from "./udp-loopback.ts";

// A *confirmed* discover save runs the real MNDP listener, which binds a UDP
// socket with reusePort; skip it where that bind is unsupported (Windows
// SO_REUSEPORT → ENOTSUP). The confirmation-*gate* test bails before binding, so
// it stays covered. The listen path itself is exercised by CHR integration. (#69)
const UDP_LOOPBACK = await udpLoopbackSupported();

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
			{ target: "a", group: "edge", password: "do-not-leak" },
		]);
		try {
			const env = await handleDevices(
				{ op: "show", target: "a" },
				config(path),
			);
			expect(env.ok).toBe(true);
			if (!env.ok) {
				return;
			}
			const data = env.data as {
				entry: { password?: string; passwordSet?: boolean };
			};
			expect(data.entry.password).toBeUndefined();
			expect(data.entry.passwordSet).toBe(true);
		} finally {
			await cleanup();
		}
	});
});

describe("handleDevices (CDB mutations)", () => {
	test("requires confirmation before adding a device", async () => {
		const { path, cleanup } = await makeMcpTestCdb([]);
		try {
			const env = await handleDevices(
				{ op: "add", target: "new-box" },
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

	test("adds a device without returning its password", async () => {
		const { path, cleanup } = await makeMcpTestCdb([]);
		try {
			const env = await handleDevices(
				{
					op: "add",
					target: "new-box",
					user: "admin",
					password: "secret-password",
					group: "edge",
					comment: "mcp=ro",
					confirm: true,
				},
				config(path),
			);
			expect(env.ok).toBe(true);
			if (!env.ok) {
				return;
			}
			const data = env.data as {
				entry: { target: string; password?: string; passwordSet?: boolean };
			};
			expect(data.entry.target).toBe("new-box");
			expect(data.entry.password).toBeUndefined();
			expect(data.entry.passwordSet).toBe(true);

			const cdb = await loadCdb({ cdbFile: path, env: {} });
			expect(cdb.entries.map((entry) => entry.target)).toEqual(["new-box"]);
			expect(cdb.entries[0]?.password).toBe("secret-password");
		} finally {
			await cleanup();
		}
	});

	test("sets comment kv-soup through the mutation path", async () => {
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "box", comment: "mcp=ro" },
		]);
		try {
			const env = await handleDevices(
				{
					op: "set",
					target: "box",
					updates: [{ key: "mcp", value: "rw" }],
					confirm: true,
				},
				config(path),
			);
			expect(env.ok).toBe(true);

			const cdb = await loadCdb({ cdbFile: path, env: {} });
			expect(cdb.entries[0]?.comment).toBe("mcp=rw");
		} finally {
			await cleanup();
		}
	});

	test("sets first-class CDB fields through the mutation path", async () => {
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "box", user: "old", group: "edge" },
		]);
		try {
			const env = await handleDevices(
				{
					op: "set",
					target: "box",
					user: "new",
					group: "core",
					confirm: true,
				},
				config(path),
			);
			expect(env.ok).toBe(true);

			const cdb = await loadCdb({ cdbFile: path, env: {} });
			expect(cdb.entries[0]?.user).toBe("new");
			expect(cdb.entries[0]?.group).toBe("core");
		} finally {
			await cleanup();
		}
	});

	test("op=edit reports usage/not-implemented (use op=set)", async () => {
		const { path, cleanup } = await makeMcpTestCdb([{ target: "box" }]);
		try {
			const env = await handleDevices(
				{ op: "edit", target: "box", user: "x", confirm: true },
				config(path),
			);
			expect(env.ok).toBe(false);
			if (!env.ok) {
				expect(env.error.code).toBe("usage/not-implemented");
			}
		} finally {
			await cleanup();
		}
	});

	test("removes a device after confirmation", async () => {
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "old-box" },
			{ target: "kept-box" },
		]);
		try {
			const env = await handleDevices(
				{ op: "remove", target: "old-box", confirm: true },
				config(path),
			);
			expect(env.ok).toBe(true);

			const cdb = await loadCdb({ cdbFile: path, env: {} });
			expect(cdb.entries.map((entry) => entry.target)).toEqual(["kept-box"]);
		} finally {
			await cleanup();
		}
	});
});

describe("handleDiscover (CDB save gate)", () => {
	test("requires confirmation before discover save mutates the CDB", async () => {
		const { path, cleanup } = await makeMcpTestCdb([]);
		try {
			const env = await handleDiscover(
				{ save: true, timeout: 1, port: 0, sendRefresh: false },
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

	test.skipIf(!UDP_LOOPBACK)(
		"runs a confirmed save path without returning credentials",
		async () => {
			const { path, cleanup } = await makeMcpTestCdb([]);
			try {
				const env = await handleDiscover(
					{
						save: true,
						confirm: true,
						timeout: 1,
						port: 0,
						sendRefresh: false,
					},
					config(path),
				);
				expect(env.ok).toBe(true);
				if (!env.ok) {
					return;
				}
				const data = env.data as { count?: number; neighbors?: unknown[] };
				expect(data.count).toBe(0);
				expect(data.neighbors).toEqual([]);
				const meta = env.meta as { operation?: { saved?: { added?: number } } };
				expect(meta.operation?.saved?.added).toBe(0);
			} finally {
				await cleanup();
			}
		},
	);
});
