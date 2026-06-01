import { describe, expect, test } from "bun:test";
import { resolveMcpConfig } from "../../src/mcp/config.ts";
import {
	buildDevicesResource,
	buildErrorsResource,
	DEVICES_RESOURCE_URI,
	ERRORS_RESOURCE_URI,
} from "../../src/mcp/resources.ts";
import { makeMcpTestCdb } from "./mcp-cdb-fixture.ts";

describe("buildErrorsResource", () => {
	test("includes the MCP-specific codes with stable details URLs", () => {
		const resource = buildErrorsResource();
		expect(resource.count).toBe(resource.errors.length);
		const codes = resource.errors.map((entry) => entry.code);
		expect(codes).toContain("cdb/target-not-registered");
		expect(codes).toContain("cdb/write-not-permitted");
		expect(codes).toContain("usage/confirmation-required");
		for (const entry of resource.errors) {
			expect(entry.detailsUrl).toBe(
				`https://tikoci.github.io/centrs/errors/${entry.code}`,
			);
		}
	});
});

describe("buildDevicesResource", () => {
	test("lists registered devices with write policy and no passwords", async () => {
		const { path, cleanup } = await makeMcpTestCdb([
			{ target: "rw-box", group: "edge", comment: "mcp=rw", password: "p1" },
			{ target: "ro-box", group: "edge", comment: "mcp=ro", password: "p2" },
		]);
		try {
			const resource = await buildDevicesResource(
				resolveMcpConfig({ cdbFile: path, env: {} }),
			);
			expect(resource.count).toBe(2);
			const byTarget = new Map(resource.devices.map((d) => [d.target, d]));
			expect(byTarget.get("rw-box")?.writePolicy).toBe("rw");
			expect(byTarget.get("ro-box")?.writePolicy).toBe("ro");
			const serialized = JSON.stringify(resource);
			expect(serialized).not.toContain("p1");
			expect(serialized).not.toContain("p2");
			expect(serialized).not.toContain("password");
		} finally {
			await cleanup();
		}
	});
});

describe("resource URIs", () => {
	test("are the documented centrs:// scheme", () => {
		expect(DEVICES_RESOURCE_URI).toBe("centrs://devices");
		expect(ERRORS_RESOURCE_URI).toBe("centrs://errors");
	});
});
