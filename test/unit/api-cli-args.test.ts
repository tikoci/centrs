import { describe, expect, test } from "bun:test";
import { parseApiCliArgs } from "../../src/cli/api.ts";

describe("parseApiCliArgs", () => {
	test("first two positionals are <router> and <endpoint>", () => {
		const parsed = parseApiCliArgs(["192.0.2.1", "ip/address"]);
		expect(parsed.targetInput).toBe("192.0.2.1");
		expect(parsed.endpoint).toBe("ip/address");
	});

	test("-X / --method sets the method", () => {
		expect(parseApiCliArgs(["r", "ip/address", "-X", "PUT"]).method).toBe(
			"PUT",
		);
		expect(
			parseApiCliArgs(["r", "ip/address", "--method", "patch"]).method,
		).toBe("patch");
	});

	test("-f is repeatable into a body object", () => {
		const parsed = parseApiCliArgs([
			"r",
			"ip/address",
			"-f",
			"address=1.2.3.4/32",
			"-f",
			"interface=ether1",
		]);
		expect(parsed.fields).toEqual({
			address: "1.2.3.4/32",
			interface: "ether1",
		});
	});

	test("-f without an = is rejected", () => {
		expect(() => parseApiCliArgs(["r", "ip/address", "-f", "nope"])).toThrow(
			"key=value",
		);
	});

	test("-d / --data and --input are captured", () => {
		expect(parseApiCliArgs(["r", "x", "-d", '{"a":1}']).data).toBe('{"a":1}');
		expect(parseApiCliArgs(["r", "x", "--input", "-"]).inputPath).toBe("-");
		expect(parseApiCliArgs(["r", "x", "--input", "body.json"]).inputPath).toBe(
			"body.json",
		);
	});

	test("--query / --filter / --raw-query / --proplist accumulate", () => {
		const parsed = parseApiCliArgs([
			"r",
			"interface",
			"--query",
			"type=ether",
			"--filter",
			"running",
			"--raw-query",
			"#|",
			"--proplist",
			"name,type",
			"--attribute",
			"mtu",
		]);
		expect(parsed.query).toEqual(["type=ether", "running"]);
		expect(parsed.rawQuery).toEqual(["#|"]);
		expect(parsed.proplist).toEqual(["name,type", "mtu"]);
	});

	test("boolean flags", () => {
		const parsed = parseApiCliArgs([
			"r",
			"ip/address",
			"--raw",
			"--yes",
			"--stream",
			"--insecure",
		]);
		expect(parsed.raw).toBe(true);
		expect(parsed.yes).toBe(true);
		expect(parsed.stream).toBe(true);
		expect(parsed.insecure).toBe(true);
	});

	// #402: `--listen` meant "stream" AND rewrote a GET into a change feed.
	describe("--listen is removed and names the exact replacement", () => {
		const remediation = (args: string[]): string => {
			try {
				parseApiCliArgs(args);
			} catch (error) {
				expect((error as { code?: string }).code).toBe("usage/removed-flag");
				return (error as { remediation: string }).remediation;
			}
			throw new Error("--listen was accepted");
		};

		test("a GET becomes the menu's /listen endpoint", () => {
			expect(
				remediation(["r1", "ip/address", "--listen", "--count", "1"]),
			).toContain("Run: centrs api r1 ip/address/listen --count 1.");
		});

		test("another method keeps its command and streams", () => {
			expect(
				remediation([
					"r1",
					"tool/ping",
					"-X",
					"POST",
					"-f",
					"address=10.0.2.2",
					"--listen",
				]),
			).toContain(
				"Run: centrs api r1 tool/ping -X POST -f address=10.0.2.2 --stream.",
			);
		});

		test("an existing /listen endpoint just drops the flag", () => {
			expect(remediation(["r1", "ip/address/listen", "--listen"])).toContain(
				"Run: centrs api r1 ip/address/listen.",
			);
		});

		test("passwords are not echoed back", () => {
			const text = remediation([
				"r1",
				"ip/address",
				"--password",
				"hunter2",
				"--listen",
			]);
			expect(text).not.toContain("hunter2");
			expect(text).toContain("--password <password>");
		});

		test("arguments with spaces stay one shell word", () => {
			expect(remediation(["r1", "ip address", "--listen"])).toContain(
				"Run: centrs api r1 'ip address/listen'.",
			);
		});
	});

	test("--validate=false and --no-validate both disable validation", () => {
		expect(parseApiCliArgs(["r", "x", "--validate=false"]).validate).toBe(
			false,
		);
		expect(parseApiCliArgs(["r", "x", "--no-validate"]).validate).toBe(false);
		expect(parseApiCliArgs(["r", "x", "--validate"]).validate).toBe(true);
	});

	test("--json is a shortcut for --format json; --format validates", () => {
		expect(parseApiCliArgs(["r", "x", "--json"]).format).toBe("json");
		expect(parseApiCliArgs(["r", "x", "--format", "yaml"]).format).toBe("yaml");
		expect(() => parseApiCliArgs(["r", "x", "--format", "xml"])).toThrow(
			"--format must be one of",
		);
	});

	test("--user and -u alias --username", () => {
		expect(parseApiCliArgs(["r", "x", "--user", "admin"]).username).toBe(
			"admin",
		);
		expect(parseApiCliArgs(["r", "x", "-u", "admin"]).username).toBe("admin");
		expect(parseApiCliArgs(["r", "x", "--username", "admin"]).username).toBe(
			"admin",
		);
	});

	test("--port must be a whole integer (no numeric prefixes)", () => {
		expect(parseApiCliArgs(["r", "x", "--port", "8728"]).port).toBe(8728);
		expect(() => parseApiCliArgs(["r", "x", "--port", "abc"])).toThrow(
			"must be an integer",
		);
		// `Number.parseInt` would accept these prefixes; the parser must not.
		expect(() => parseApiCliArgs(["r", "x", "--port", "8728ms"])).toThrow(
			"must be an integer",
		);
		expect(() => parseApiCliArgs(["r", "x", "--count", "10abc"])).toThrow(
			"must be an integer",
		);
	});

	test("an unknown flag is rejected with a closest-match suggestion", () => {
		// A near-miss surfaces the canonical match (commands/AGENTS.md "Did you mean?").
		expect(() => parseApiCliArgs(["r", "x", "--users"])).toThrow(
			"Did you mean --user",
		);
		// A far-off flag still errors clearly, naming the command.
		expect(() => parseApiCliArgs(["r", "x", "--bogus"])).toThrow(
			"Unknown api flag",
		);
	});

	test("--help is captured", () => {
		expect(parseApiCliArgs(["--help"]).help).toBe(true);
	});
});
