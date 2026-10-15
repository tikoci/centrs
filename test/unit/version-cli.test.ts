import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json" with { type: "json" };
import { runCliCaptured } from "./cli-capture.ts";

/** #463: `centrs --version` / `-V` print the package version and exit 0. */
describe("centrs --version (#463)", () => {
	for (const flag of ["--version", "-V"]) {
		test(`${flag} prints the bare package.json version`, async () => {
			const result = await runCliCaptured([flag]);
			expect(result.code).toBe(0);
			expect(result.out).toBe(packageJson.version);
			expect(result.err).toBe("");
		});
	}

	test("--json returns the envelope with data.version", async () => {
		const result = await runCliCaptured(["--version", "--json"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.out)).toEqual({
			ok: true,
			data: { version: packageJson.version },
			warnings: [],
			tips: [],
			meta: {
				target: {},
				via: null,
				settings: {},
				operation: { command: "version" },
			},
		});
	});

	test("--format yaml carries the same version", async () => {
		const result = await runCliCaptured(["-V", "--format", "yaml"]);
		expect(result.code).toBe(0);
		expect(
			(Bun.YAML.parse(result.out) as { data: { version: string } }).data
				.version,
		).toBe(packageJson.version);
	});

	test("anything but a format is refused", async () => {
		const result = await runCliCaptured(["--version", "execute"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("input/invalid-command");
	});
});
