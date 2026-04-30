import { describe, expect, test } from "bun:test";
import {
	describeCentrs,
	plannedDeviceSources,
	plannedProtocols,
	plannedSurfaces,
	projectSummary,
} from "../../src/index.ts";

describe("centrs project baseline", () => {
	test("exports the planned public surface", () => {
		expect(projectSummary.name).toBe("centrs");
		expect(describeCentrs()).toContain("RouterOS interaction hub");
		expect(plannedSurfaces).toContain("cli");
		expect(plannedProtocols).toContain("rest-api");
		expect(plannedDeviceSources).toContain("winbox-cdb");
	});
});
