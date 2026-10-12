import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseApiCliArgs } from "../../src/cli/api.ts";
import { parseExecuteCliArgs } from "../../src/cli/execute.ts";
import { parseTerminalCliArgs } from "../../src/cli/terminal.ts";
import { parseTransferCliArgs } from "../../src/cli/transfer.ts";
import { runCliCaptured as run } from "./cli-capture.ts";

/**
 * #428: the `--host` FLAG stands in for a missing `<router>` in single-target
 * mode, so `execute --host URL -- '<cmd>'` and `retrieve --host URL <path>`
 * reach the transport without a CDB record. `CENTRS_HOST` must never change
 * positional parsing.
 */

// Every test starts with no `CENTRS_*` env and ends by restoring the original
// set, including deleting any key a test added (a leaked `CENTRS_HOST` steers
// later suites' subprocesses at it).
let saved: Record<string, string> = {};

function clearCentrsEnv(): void {
	for (const key of Object.keys(Bun.env)) {
		if (key.startsWith("CENTRS_")) delete Bun.env[key];
	}
}

beforeEach(() => {
	saved = {};
	for (const [key, value] of Object.entries(Bun.env)) {
		if (key.startsWith("CENTRS_") && value !== undefined) saved[key] = value;
	}
	clearCentrsEnv();
	Bun.env["CENTRS_SKIP_ENV_FILE"] = "1";
});

afterEach(() => {
	clearCentrsEnv();
	Object.assign(Bun.env, saved);
});

/** A loopback port with nothing listening: bind an ephemeral one, then close it. */
function closedPort(): number {
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data() {} },
	});
	const port = listener.port;
	listener.stop(true);
	return port;
}

const creds = ["--username", "u", "--password", "p", "--json"];

interface ErrorEnvelope {
	ok: boolean;
	error?: { code?: string; summary?: string };
	meta: { target?: { host?: string; port?: number; source?: unknown } };
}

function envelopeOf(err: string): ErrorEnvelope {
	return JSON.parse(err) as ErrorEnvelope;
}

describe("execute parse: `--host` stands in for <router>", () => {
	test("a lone positional is the command", () => {
		const parsed = parseExecuteCliArgs([
			"--host",
			"http://127.0.0.1:9",
			"/system/resource/print",
		]);
		expect(parsed.targetInput).toBeUndefined();
		expect(parsed.targetPositionals).toEqual([]);
		expect(parsed.command).toBe("/system/resource/print");
	});

	test("`--` with nothing before it leaves --host as the target", () => {
		const parsed = parseExecuteCliArgs([
			"--host",
			"http://127.0.0.1:9",
			"--",
			"/interface",
			"print",
		]);
		expect(parsed.targetInput).toBeUndefined();
		expect(parsed.command).toBe("/interface print");
	});

	test("two positionals keep the legacy split (mac-telnet delivery override)", () => {
		const parsed = parseExecuteCliArgs([
			"aa:bb:cc:dd:ee:ff",
			"/system/identity/print",
			"--via",
			"mac-telnet",
			"--host",
			"127.0.0.1",
		]);
		expect(parsed.targetInput).toBe("aa:bb:cc:dd:ee:ff");
		expect(parsed.command).toBe("/system/identity/print");
		expect(parsed.host).toBe("127.0.0.1");
	});

	test("`<router> --host … -- <cmd>` keeps the positional target", () => {
		const parsed = parseExecuteCliArgs([
			"r1",
			"--host",
			"192.0.2.5",
			"--",
			"/system/resource/print",
		]);
		expect(parsed.targetInput).toBe("r1");
		expect(parsed.command).toBe("/system/resource/print");
	});

	test("without --host, a lone positional is still the target", () => {
		const parsed = parseExecuteCliArgs(["/system/resource/print"]);
		expect(parsed.targetInput).toBe("/system/resource/print");
		expect(parsed.command).toBe("");
	});

	test("a selector still claims every positional", () => {
		const parsed = parseExecuteCliArgs([
			"--group",
			"prod",
			"--host",
			"192.0.2.5",
			"/system/resource",
			"print",
		]);
		expect(parsed.targetPositionals).toEqual([]);
		expect(parsed.command).toBe("/system/resource print");
	});
});

describe("api/transfer/terminal parse: `--host` with no <router>", () => {
	test("api: the lone positional is the endpoint, no target", () => {
		const parsed = parseApiCliArgs(["--host", "192.0.2.5", "system/resource"]);
		expect(parsed.targetInput).toBeUndefined();
		expect(parsed.endpoint).toBe("system/resource");
	});

	test("transfer verb form: no positional before the verb", () => {
		const parsed = parseTransferCliArgs(["--host", "192.0.2.5", "list"]);
		expect(parsed.request.targetInput).toBeUndefined();
		expect(parsed.request.host).toBe("192.0.2.5");
		expect(parsed.request.verb).toBe("list");
	});

	test("transfer verb form without --host still needs a <router>", () => {
		expect(() => parseTransferCliArgs(["list"])).toThrow(
			"`centrs transfer` requires a <router> target.",
		);
	});

	test("upload alias: the first positional stays the target", () => {
		const parsed = parseTransferCliArgs(
			["--host", "192.0.2.5", "r1", "./a.rsc"],
			"upload",
		);
		expect(parsed.request.targetInput).toBe("r1");
		expect(parsed.request.local).toBe("./a.rsc");
	});

	test("upload alias with --host and no positional still needs a <router>", () => {
		expect(() =>
			parseTransferCliArgs(["--host", "192.0.2.5"], "upload"),
		).toThrow("`centrs transfer` requires a <router> target.");
	});

	test("terminal: --host alone is a target", () => {
		const parsed = parseTerminalCliArgs(["--host", "192.0.2.5"]);
		expect(parsed.request.targetInput).toBeUndefined();
		expect(parsed.request.host).toBe("192.0.2.5");
	});

	test("terminal without --host still needs a <router>", () => {
		expect(() => parseTerminalCliArgs([])).toThrow(
			"`centrs terminal` requires a <router> target.",
		);
	});
});

describe("CLI: `--host` reaches the transport with no <router>", () => {
	const cases: ReadonlyArray<{
		name: string;
		args: (url: string) => string[];
	}> = [
		{ name: "execute", args: (url) => ["execute", "--host", url, ":put 1"] },
		{
			name: "execute --",
			args: (url) => ["execute", ...creds, "--host", url, "--", ":put 1"],
		},
		{
			name: "retrieve",
			args: (url) => ["retrieve", "--host", url, "/system/resource"],
		},
		{ name: "api", args: (url) => ["api", "--host", url, "system/resource"] },
		{ name: "transfer", args: (url) => ["transfer", "--host", url, "list"] },
	];
	for (const { name, args } of cases) {
		test(`${name}: transport/connection-refused, not a missing target`, async () => {
			const url = `http://127.0.0.1:${closedPort()}`;
			const argv = args(url);
			const { code, err } = await run(
				argv.includes("--") ? argv : [...argv, ...creds],
			);
			expect(code).toBe(1);
			expect(envelopeOf(err).error?.code).toBe("transport/connection-refused");
		});
	}

	test("execute: the host comes from the --host flag, over the URL's REST port", async () => {
		const port = closedPort();
		const { err } = await run([
			"execute",
			"--host",
			`http://127.0.0.1:${port}`,
			":put 1",
			...creds,
		]);
		const envelope = envelopeOf(err) as ErrorEnvelope & {
			meta: { via?: string };
		};
		expect(envelope.meta.via).toBe("rest-api");
		expect(envelope.meta.target).toMatchObject({
			host: "127.0.0.1",
			port,
			source: { kind: "cli", key: "host" },
		});
	});

	test("execute: --host with no command asks for the command", async () => {
		const { code, err } = await run([
			"execute",
			"--host",
			"http://127.0.0.1:9",
			...creds,
		]);
		expect(code).toBe(1);
		expect(envelopeOf(err).error?.summary).toBe(
			"`centrs execute` requires a RouterOS command string.",
		);
	});

	test("retrieve: --host with no path asks for the path", async () => {
		const { code, err } = await run([
			"retrieve",
			"--host",
			"http://127.0.0.1:9",
			...creds,
		]);
		expect(code).toBe(1);
		expect(envelopeOf(err).error?.summary).toBe(
			"`centrs retrieve --host` requires a <routeros-path>.",
		);
	});
});

describe("CENTRS_HOST never changes positional parsing", () => {
	test("retrieve <path> with CENTRS_HOST set is still a missing target", async () => {
		Bun.env["CENTRS_HOST"] = "http://127.0.0.1:9";
		const { code, err } = await run(["retrieve", "/system/resource", ...creds]);
		expect(code).toBe(1);
		expect(envelopeOf(err).error?.summary).toBe(
			"`centrs retrieve` requires a <target> and a <routeros-path>.",
		);
	});

	test("api <endpoint> with CENTRS_HOST set is still a missing target", async () => {
		Bun.env["CENTRS_HOST"] = "http://127.0.0.1:9";
		const { code, err } = await run(["api", "system/resource", ...creds]);
		expect(code).toBe(1);
		expect(envelopeOf(err).error?.summary).toBe(
			"`centrs api` requires a <router> and an <endpoint>.",
		);
	});

	test("execute '<cmd>' with CENTRS_HOST set reads the lone positional as the target", () => {
		Bun.env["CENTRS_HOST"] = "http://127.0.0.1:9";
		const parsed = parseExecuteCliArgs([":put 1"]);
		expect(parsed.targetInput).toBe(":put 1");
		expect(parsed.command).toBe("");
	});
});
