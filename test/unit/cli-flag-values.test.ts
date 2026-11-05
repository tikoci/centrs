import { describe, expect, test } from "bun:test";
import { parseApiCliArgs } from "../../src/cli/api.ts";
import { parseClientArgs, parseServerArgs } from "../../src/cli/btest.ts";
import { cliRenderOptions, inferCliFormat } from "../../src/cli/common.ts";
import { parseDevicesCliArgs } from "../../src/cli/devices.ts";
import { parseDiscoverCliArgs } from "../../src/cli/discover.ts";
import { executeCommand, parseExecuteCliArgs } from "../../src/cli/execute.ts";
import { parseExplainCliArgs } from "../../src/cli/explain.ts";
import { parseMcpCliArgs } from "../../src/cli/mcp.ts";
import { parseRetrieveCliArgs } from "../../src/cli/retrieve.ts";
import { parseSettingsCliArgs } from "../../src/cli/settings.ts";
import { parseTerminalCliArgs } from "../../src/cli/terminal.ts";
import { parseTransferCliArgs } from "../../src/cli/transfer.ts";
import { cliCommands } from "../../src/cli.ts";
import { CentrsError } from "../../src/errors.ts";
import { runCliCaptured as run } from "./cli-capture.ts";

const parsers: ReadonlyArray<{
	name: string;
	parse: (args: readonly string[]) => unknown;
	args: string[];
	valueFlag?: string;
	secretFlag?: string;
}> = [
	{
		name: "retrieve",
		parse: parseRetrieveCliArgs,
		args: ["router", "/system/identity"],
	},
	{
		name: "execute",
		parse: parseExecuteCliArgs,
		args: ["router", "/system/identity/print"],
	},
	{ name: "api", parse: parseApiCliArgs, args: ["router", "system/identity"] },
	{ name: "transfer", parse: parseTransferCliArgs, args: ["router", "list"] },
	{ name: "terminal", parse: parseTerminalCliArgs, args: ["router"] },
	{ name: "explain", parse: parseExplainCliArgs, args: ["/ip/route"] },
	{ name: "devices", parse: parseDevicesCliArgs, args: ["list"] },
	{ name: "discover", parse: parseDiscoverCliArgs, args: [] },
	{ name: "btest client", parse: parseClientArgs, args: ["router"] },
	{
		name: "btest server",
		parse: parseServerArgs,
		args: [],
		valueFlag: "--bind",
		secretFlag: "--password",
	},
	{ name: "mcp", parse: parseMcpCliArgs, args: [] },
	{ name: "settings", parse: parseSettingsCliArgs, args: [] },
];

function refusal(
	parse: (args: readonly string[]) => unknown,
	args: string[],
): CentrsError {
	try {
		parse(args);
	} catch (error) {
		if (error instanceof CentrsError) return error;
		throw error;
	}
	throw new Error("Expected a typed refusal");
}

describe("shared CLI flag values (#625)", () => {
	for (const {
		name,
		parse,
		args,
		valueFlag = "--cdb-file",
		secretFlag = "--cdb-password",
	} of parsers) {
		describe(name, () => {
			for (const help of ["--help", "-h"]) {
				test(`help wins in a value slot: ${help}`, () => {
					expect(parse([...args, valueFlag, help])).toMatchObject({
						help: true,
					});
				});
			}
			for (const got of [undefined, "--json", "--unknown", "--"]) {
				test(`missing value is typed: ${got ?? "end of argv"}`, () => {
					const error = refusal(parse, [
						...args,
						valueFlag,
						...(got === undefined ? [] : [got]),
					]);
					expect(error.code).toBe("usage/missing-flag-value");
					expect(error.context).toEqual({
						flag: valueFlag,
						got: got ?? null,
					});
					expect(error.remediation).toContain(
						valueFlag === "--bind" ? "--bind <addr>" : "--cdb-file <path>",
					);
				});
			}
			test("equals form preserves the complete value", () => {
				expect(parse([...args, `${valueFlag}=registry=one.cdb`])).toEqual(
					parse([...args, valueFlag, "registry=one.cdb"]),
				);
			});
			test("literal secrets keep flag-shaped and empty values", () => {
				for (const value of ["--json", "--format=yaml", "--", "", "-private"]) {
					expect(parse([...args, `${secretFlag}=${value}`])).toEqual(
						parse([...args, secretFlag, value]),
					);
				}
			});
		});
	}

	test("known short flags cannot become another flag's value", () => {
		const error = refusal(parseExecuteCliArgs, ["--host", "-u"]);
		expect(error.context).toEqual({ flag: "--host", got: "-u" });
	});

	test("negative coordinates, negative numbers, and stdin remain values", () => {
		expect(
			parseDevicesCliArgs(["add", "router", "--lat=-33.8", "--lon", "-118.2"]),
		).toMatchObject({ lat: "-33.8", lon: "-118.2" });
		expect(parseExplainCliArgs(["--file=-"])).toMatchObject({ filePath: "-" });
		expect(parseSettingsCliArgs(["set", "max-results", "-1"])).toMatchObject({
			value: "-1",
		});
	});

	test("inline secrets do not trigger help or get split a second time", () => {
		for (const value of [
			"--help",
			"-h",
			"--host=canary",
			"--format=yaml",
			"--",
		]) {
			const parsed = parseExecuteCliArgs([
				`--password=${value}`,
				"router",
				"/system/identity/print",
				"--json",
			]);
			expect(parsed.password).toBe(value);
			expect(parsed.format).toBe("json");
			expect(parsed.help).not.toBe(true);
		}
	});

	test("missing-value diagnostics redact attached credentials", () => {
		const secret = "canary";
		for (const token of [
			"--password=canary",
			"--cdb-password=canary",
			`--host=http://admin:${secret}@127.0.0.1`,
		]) {
			const error = refusal(parseExecuteCliArgs, ["--host", token]);
			expect(error.code).toBe("usage/missing-flag-value");
			expect(JSON.stringify(error.toJSON())).not.toContain("canary");
		}
	});
	test("unknown-flag diagnostics never echo an attached value", () => {
		for (const [parse, token] of [
			[parseMcpCliArgs, "--password=canary"],
			[parseDiscoverCliArgs, "--password=canary"],
			[parseExecuteCliArgs, "--pasword=canary"],
			[parseExecuteCliArgs, "--bogus=http://admin:canary@127.0.0.1"],
		] as const) {
			const error = refusal(parse, [token]);
			expect(error.code).toBe("input/invalid-command");
			expect(JSON.stringify(error.toJSON())).not.toContain("canary");
		}
		expect(
			refusal(parseExecuteCliArgs, ["--pasword=canary"]).context,
		).toMatchObject({ flag: "--pasword=<value>" });
	});
	test("the original quickchr and host failures stay inside the CLI", () => {
		expect(parseTerminalCliArgs(["--quickchr", "--help"]).help).toBe(true);
		expect(refusal(parseTerminalCliArgs, ["--quickchr"]).remediation).toContain(
			"--quickchr <name>",
		);
		expect(refusal(parseExecuteCliArgs, ["--host", "--json"]).context).toEqual({
			flag: "--host",
			got: "--json",
		});
		expect(parseApiCliArgs(["--method", "--help", "/x"]).help).toBe(true);
	});

	test("boolean equals values get actionable guidance; explicit validation remains supported", () => {
		const error = refusal(parseExecuteCliArgs, ["--json=true"]);
		expect(error.remediation).toContain("bare `--json`");
		expect(
			parseExecuteCliArgs([
				"router",
				"/system/identity/print",
				"--validate=false",
			]),
		).toMatchObject({ validate: false });
	});
});

describe("rendering uses the same option metadata (#625)", () => {
	test("transfer --no-verify is boolean and leaves following format flags visible", async () => {
		expect(
			parseTransferCliArgs(["router", "list", "--no-verify", "--format=json"])
				.request,
		).toMatchObject({ verify: "off", format: "json" });
		const result = await run([
			"transfer",
			"router",
			"upload",
			"source.txt",
			"destination.txt",
			"--verify",
			"size",
			"--no-verify",
			"--json",
		]);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.err).error.code).toBe("usage/conflicting-flags");
	});
	const options = executeCommand.options;
	test("skips values and stops at the real separator", () => {
		expect(
			cliRenderOptions(
				["--password", "--format=json", "--host", "--json"],
				options,
			).format,
		).toBeUndefined();
		expect(
			cliRenderOptions(
				["--password", "--", "--format=yaml", "--", "--json"],
				options,
			).format,
		).toBe("yaml");
		expect(
			cliRenderOptions(
				["--format=json", "--format", "yaml", "--", "--verbose"],
				options,
			),
		).toEqual({ format: "yaml", verbose: false });
	});
	test("invalid formats fall back without replacing the parse error", () => {
		expect(
			inferCliFormat(
				["--format=bad"],
				options,
				["text", "json"],
				"text",
				"json",
			),
		).toBe("json");
	});
	for (const name of [
		"execute",
		"retrieve",
		"api",
		"terminal",
		"transfer",
		"devices",
		"settings",
		"explain",
	]) {
		test(`${name}: equals format controls the missing-value error envelope`, async () => {
			const result = await run([name, "--format=json", "--cdb-file"]);
			expect(result.code).toBe(1);
			expect(JSON.parse(result.err).error).toMatchObject({
				code: "usage/missing-flag-value",
				context: { flag: "--cdb-file", got: null },
			});
		});
	}
});

describe("help surface (#625)", () => {
	for (const command of cliCommands) {
		test(`${command.name}: -h and --help match and beat missing values`, async () => {
			const help = await run([command.name, "--help"]);
			expect(help.code).toBe(0);
			expect(await run([command.name, "--cdb-file", "-h"])).toEqual(help);
			expect(await run([command.name, "--cdb-file", "--help"])).toEqual(help);
		});
	}
	test("global help aliases and command prefixes", async () => {
		expect(await run(["help"])).toEqual(await run(["--help"]));
		expect((await run(["help", "--help"])).code).toBe(0);
		const execute = await run(["execute", "--help"]);
		for (const prefix of ["help", "--help", "-h"])
			expect(await run([prefix, "execute"])).toEqual(execute);
	});
	test("a routed help prefix beats the separator", async () => {
		const execute = await run(["execute", "--help"]);
		expect(
			await run([
				"--help",
				"execute",
				"router",
				"--",
				"/system/identity/print",
			]),
		).toEqual(execute);
	});
	test("a flag after a help prefix is not routed as a command", async () => {
		const global = await run(["--help"]);
		for (const args of [
			["--help", "--version"],
			["-h", "--json"],
			["help", "--verbose"],
		])
			expect(await run(args)).toEqual(global);
	});
	test("subcommand help survives the early scan and prefixes", async () => {
		for (const sub of ["init", "encrypt"]) {
			const help = await run(["devices", sub, "--help"]);
			expect(help.out).toContain(`Usage: centrs devices ${sub} [flags]`);
			expect(await run(["devices", sub, "--cdb-file", "-h"])).toEqual(help);
			expect(
				await run(["devices", "--cdb-file", "registry.cdb", sub, "--help"]),
			).toEqual(help);
			expect(
				await run(["devices", "--cdb-file=registry.cdb", sub, "-h"]),
			).toEqual(help);
			expect(await run(["help", "devices", sub])).toEqual(help);
		}
		expect(await run(["devices", "list", "-h"])).toEqual(
			await run(["devices", "list", "--help"]),
		);
	});
	test("help after the separator stays input, and help remains a valid identity", () => {
		expect(parseExecuteCliArgs(["router", "--", "--help"]).command).toBe(
			"--help",
		);
		expect(parseExecuteCliArgs(["router", "--", "-h"]).command).toBe("-h");
		expect(
			parseExecuteCliArgs(["help", "/system/identity/print"]).targetInput,
		).toBe("help");
	});
});
