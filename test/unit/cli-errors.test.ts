import { afterEach, describe, expect, test } from "bun:test";
import { runCli } from "../../src/cli.ts";

interface Captured {
	code: number;
	out: string;
	err: string;
}

const restorers: Array<() => void> = [];
afterEach(() => {
	while (restorers.length > 0) {
		restorers.pop()?.();
	}
});

async function run(args: readonly string[]): Promise<Captured> {
	const logs: string[] = [];
	const errs: string[] = [];
	const origLog = console.log;
	const origErr = console.error;
	console.log = (...a: unknown[]) => {
		logs.push(a.map(String).join(" "));
	};
	console.error = (...a: unknown[]) => {
		errs.push(a.map(String).join(" "));
	};
	restorers.push(() => {
		console.log = origLog;
		console.error = origErr;
	});
	const code = await runCli(args);
	return { code, out: logs.join("\n"), err: errs.join("\n") };
}

// Representative bad invocations for each runner: a missing flag value, a bad
// value, or a missing required positional. Each must reach the runner's typed
// catch, not a raw throw.
const badInvocations: ReadonlyArray<{ name: string; args: string[] }> = [
	{ name: "retrieve", args: ["retrieve", "/system/resource", "--port"] },
	{
		name: "execute",
		args: ["execute", "router", "/ip/x/print", "--port", "abc"],
	},
	{ name: "devices", args: ["devices", "show"] },
	{ name: "discover", args: ["discover", "--port"] },
	{ name: "mcp", args: ["mcp", "--bogus-flag"] },
];

describe("CLI errors are structured, never raw stacks", () => {
	for (const { name, args } of badInvocations) {
		test(`${name}: exit 1, typed text error, no stack frame`, async () => {
			const { code, err } = await run(args);
			expect(code).toBe(1);
			// formatCentrsErrorText shape: "[code] summary" / "Fix:" / "Details:".
			expect(err).toMatch(/^\[[a-z]+\/[a-z0-9-]+\]/m);
			expect(err).toContain("Fix:");
			expect(err).toContain("Details: https://tikoci.github.io/centrs/errors/");
			// No raw V8 stack frame leaked to the user.
			expect(err).not.toMatch(/\n\s+at\s/);
		});
	}

	test("execute parse error returns exit 1 (not the old exit 2)", async () => {
		const { code } = await run(["execute", "router", "/ip/x", "--port", "abc"]);
		expect(code).toBe(1);
	});
});

describe("CLI --json parse errors emit an ok:false envelope", () => {
	const jsonCases: ReadonlyArray<{ name: string; args: string[] }> = [
		{ name: "execute", args: ["execute", "--json", "--port", "abc"] },
		{ name: "devices", args: ["devices", "show", "--json"] },
		{ name: "retrieve", args: ["retrieve", "--json", "--port"] },
	];
	for (const { name, args } of jsonCases) {
		test(`${name}: stderr is a valid error envelope`, async () => {
			const { code, err } = await run(args);
			expect(code).toBe(1);
			const envelope = JSON.parse(err) as {
				ok: boolean;
				error?: { code?: string; detailsUrl?: string };
			};
			expect(envelope.ok).toBe(false);
			expect(envelope.error?.code).toMatch(/^[a-z]+\/[a-z0-9-]+$/);
			expect(envelope.error?.detailsUrl).toContain(
				"https://tikoci.github.io/centrs/errors/",
			);
		});
	}
});

describe("runCli dispatch", () => {
	test("unknown command is a typed input/invalid-command, exit 1", async () => {
		const { code, err } = await run(["bogus"]);
		expect(code).toBe(1);
		expect(err).toContain("[input/invalid-command]");
		expect(err).toContain("Unknown centrs command: bogus");
		expect(err).not.toMatch(/\n\s+at\s/);
	});

	test("--help renders the global banner with exit 0", async () => {
		const { code, out } = await run(["--help"]);
		expect(code).toBe(0);
		expect(out).toContain("Commands:");
	});
});

// #111: the shared `unknownFlagError` "Did you mean?" contract, once wired into
// the `api` parser in PR #110, is now rolled out to every parser. Each parser
// must name the command and surface the closest known flag, not a bare throw.
// cspell:ignore formt resolv protcol binde jsonn filee
describe("unknown flags surface a 'Did you mean?' suggestion (#111)", () => {
	const nearMisses: ReadonlyArray<{
		name: string;
		args: string[];
		suggestion: string;
	}> = [
		{ name: "transfer", args: ["transfer", "--formt"], suggestion: "--format" },
		{
			name: "terminal",
			args: ["terminal", "--resolv"],
			suggestion: "--resolve",
		},
		{
			name: "btest client",
			args: ["btest", "client", "127.0.0.1", "--protcol"],
			suggestion: "--protocol",
		},
		{
			name: "btest server",
			args: ["btest", "server", "--binde"],
			suggestion: "--bind",
		},
		{
			name: "devices",
			args: ["devices", "show", "--jsonn"],
			suggestion: "--json",
		},
		{ name: "discover", args: ["discover", "--formt"], suggestion: "--format" },
		{ name: "mcp", args: ["mcp", "--cdb-filee"], suggestion: "--cdb-file" },
	];
	for (const { name, args, suggestion } of nearMisses) {
		const command = args[0];
		test(`${name}: names the command and suggests ${suggestion}`, async () => {
			const { code, err } = await run(args);
			expect(code).toBe(1);
			expect(err).toContain(`Unknown ${command} flag:`);
			expect(err).toContain(`Did you mean ${suggestion}`);
			// Structured, actionable — not a raw stack.
			expect(err).not.toMatch(/\n\s+at\s/);
		});
	}
});
