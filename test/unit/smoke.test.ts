import { describe, expect, test } from "bun:test";
import {
	describeCentrs,
	getProtocolPlan,
	plannedDeviceSources,
	plannedProtocols,
	plannedSurfaces,
	projectSummary,
	protocolsWithCapability,
} from "../../src/index.ts";

describe("centrs project baseline", () => {
	test("exports the planned public surface", () => {
		expect(projectSummary.name).toBe("centrs");
		expect(describeCentrs()).toContain("RouterOS interaction hub");
		expect(plannedSurfaces).toContain("cli");
		expect(plannedProtocols).toContain("rest-api");
		expect(plannedDeviceSources).toContain("winbox-cdb");
	});

	test("exports one protocol registry source of truth", () => {
		expect(getProtocolPlan("rest-api").capabilities).toContain("retrieve");
		expect(
			protocolsWithCapability("terminal").map((plan) => plan.id),
		).toContain("ssh");
	});
});
