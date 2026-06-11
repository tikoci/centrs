import { describe, expect, test } from "bun:test";
import type { CentrsError } from "../../src/index.ts";
import {
	parseLsOutput,
	quote,
	type SftpBatchResult,
	SftpClient,
} from "../../src/protocols/sftp.ts";

// ── injected runner: records the argv + batch, returns a canned result ───────

interface Captured {
	argv: readonly string[];
	batch: string;
}

function clientWith(
	result: SftpBatchResult,
	overrides: Record<string, unknown> = {},
): { client: SftpClient; calls: Captured[] } {
	const calls: Captured[] = [];
	const client = new SftpClient({
		host: "192.0.2.10",
		port: 22,
		username: "admin",
		timeoutMs: 5000,
		runner: async (argv, batch) => {
			calls.push({ argv, batch });
			return result;
		},
		...overrides,
	});
	return { client, calls };
}

const ok = (stdout = ""): SftpBatchResult => ({
	exitCode: 0,
	stdout,
	stderr: "",
});
const fail = (stderr: string, exitCode = 255): SftpBatchResult => ({
	exitCode,
	stdout: "",
	stderr,
});

// A representative RouterOS-style `ls -l` block (long-name format).
const LS_BLOCK = [
	"-rw-rw----    1 0        0           12345 Jan 01 12:00 fw.rsc",
	"drwxrwx---    1 0        0               0 Jan 01 12:00 flash",
	"-rw-rw----    1 0        0             512 Jan 01 12:00 notes.txt",
].join("\n");

// ── argv construction ────────────────────────────────────────────────────────

describe("SftpClient argv", () => {
	test("secure default uses accept-new and batch mode on the SSH port", () => {
		const { client } = clientWith(ok(), {
			port: 2222,
			sshKey: "/k/id_ed25519",
		});
		const argv = client.argv().join(" ");
		expect(argv).toContain("-b -");
		expect(argv).toContain("-P 2222");
		expect(argv).toContain("-i /k/id_ed25519");
		expect(argv).toContain("BatchMode=yes");
		expect(argv).toContain("StrictHostKeyChecking=accept-new");
		expect(argv).not.toContain("UserKnownHostsFile=/dev/null");
		expect(argv.endsWith("admin@192.0.2.10")).toBe(true);
	});

	test("insecure disables host-key checking with an ephemeral hosts file", () => {
		const { client } = clientWith(ok(), { insecure: true });
		const argv = client.argv().join(" ");
		expect(argv).toContain("StrictHostKeyChecking=no");
		expect(argv).toContain("UserKnownHostsFile=/dev/null");
	});

	test("no username omits the user@ prefix", () => {
		const { client } = clientWith(ok(), { username: undefined });
		expect(client.argv().at(-1)).toBe("192.0.2.10");
	});
});

// ── ls -l parsing ────────────────────────────────────────────────────────────

describe("parseLsOutput", () => {
	test("extracts name, type, and best-effort size", () => {
		const entries = parseLsOutput(LS_BLOCK);
		expect(entries).toEqual([
			{ name: "fw.rsc", type: "file", size: 12345 },
			{ name: "flash", type: "directory", size: 0 },
			{ name: "notes.txt", type: "file", size: 512 },
		]);
	});

	test("skips the sftp> echo and blank lines", () => {
		const out = `sftp> ls -l flash\n\n${LS_BLOCK.split("\n")[0]}\n`;
		const entries = parseLsOutput(out);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.name).toBe("fw.rsc");
	});
});

// ── stat / readdir ───────────────────────────────────────────────────────────

describe("SftpClient stat / readdir", () => {
	test("stat returns the entry with the requested remote name", async () => {
		const { client, calls } = clientWith(ok(LS_BLOCK));
		const entry = await client.stat("notes.txt");
		expect(entry).toEqual({ name: "notes.txt", type: "file", size: 512 });
		// stat ignores per-command errors so a missing path is not fatal.
		expect(calls[0]?.batch).toContain('-ls -l "notes.txt"');
	});

	test("stat returns undefined when the path is absent", async () => {
		const { client } = clientWith(ok("")); // empty listing
		expect(await client.stat("ghost.txt")).toBeUndefined();
	});

	test("readdir drops . and ..", async () => {
		const dotted = `drwxrwx---    1 0  0  0 Jan 01 12:00 .\n${LS_BLOCK}`;
		const { client } = clientWith(ok(dotted));
		const names = (await client.readdir("flash")).map((e) => e.name);
		expect(names).toEqual(["fw.rsc", "flash", "notes.txt"]);
	});
});

// ── put / get / mkdir / remove / rename build the right batch ────────────────

describe("SftpClient file ops", () => {
	test("put / get / mkdir / remove / rename emit the expected commands", async () => {
		const cases: Array<[() => Promise<void>, string]> = [];
		const make = () => clientWith(ok());
		const a = make();
		cases.push([
			() => a.client.put("/tmp/x", "flash/x"),
			'put "/tmp/x" "flash/x"',
		]);
		const b = make();
		cases.push([
			() => b.client.get("flash/x", "/tmp/x"),
			'get "flash/x" "/tmp/x"',
		]);
		const c = make();
		cases.push([() => c.client.mkdir("flash/dir"), 'mkdir "flash/dir"']);
		const d = make();
		cases.push([() => d.client.remove("flash/x"), 'rm "flash/x"']);
		const e = make();
		cases.push([() => e.client.rename("a", "b"), 'rename "a" "b"']);

		for (const [run] of cases) {
			await run();
		}
		expect(a.calls[0]?.batch).toContain(cases[0]?.[1]);
		expect(b.calls[0]?.batch).toContain(cases[1]?.[1]);
		expect(c.calls[0]?.batch).toContain(cases[2]?.[1]);
		expect(d.calls[0]?.batch).toContain(cases[3]?.[1]);
		expect(e.calls[0]?.batch).toContain(cases[4]?.[1]);
	});
});

// ── error mapping ────────────────────────────────────────────────────────────

describe("SftpClient error mapping", () => {
	const codeFor = async (stderr: string): Promise<string> => {
		const { client } = clientWith(fail(stderr));
		try {
			await client.put("/tmp/x", "flash/x");
			return "(no throw)";
		} catch (error) {
			return (error as CentrsError).code;
		}
	};

	test("maps stderr signatures to typed codes", async () => {
		expect(await codeFor("Host key verification failed.")).toBe(
			"transport/host-key-mismatch",
		);
		expect(await codeFor("admin@host: Permission denied (publickey).")).toBe(
			"auth/failed",
		);
		expect(
			await codeFor("ssh: connect to host port 22: Connection refused"),
		).toBe("transport/connection-refused");
		expect(
			await codeFor("ssh: connect to host port 22: Operation timed out"),
		).toBe("transport/timeout");
		expect(await codeFor("ssh: Could not resolve hostname nope")).toBe(
			"transport/dns",
		);
		expect(await codeFor('remote open("flash/x"): No such file')).toBe(
			"routeros/command-failed",
		);
		expect(await codeFor("some other failure")).toBe("transport/network");
	});
});

// ── spawn failure (no injected runner → real host spawn) ─────────────────────

describe("SftpClient spawn", () => {
	test("a missing host `sftp` binary maps to transport/local-tool-missing", async () => {
		// No `runner` override → exercises the default spawnSftpBatch path. Point at a
		// binary that cannot exist so Bun.spawn throws ENOENT synchronously.
		const client = new SftpClient({
			host: "192.0.2.10",
			port: 22,
			username: "admin",
			timeoutMs: 5000,
			binary: "centrs-nonexistent-sftp-binary-xyz",
		});
		let code = "";
		try {
			await client.stat("flash/fw.rsc");
		} catch (error) {
			code = (error as CentrsError).code;
		}
		expect(code).toBe("transport/local-tool-missing");
	});
});

// ── quoting guard ────────────────────────────────────────────────────────────

describe("quote", () => {
	test("wraps a normal path in double quotes", () => {
		expect(quote("flash/fw.rsc")).toBe('"flash/fw.rsc"');
	});

	test("rejects a path with an embedded quote or newline", () => {
		let code = "";
		try {
			quote('flash/"evil".rsc');
		} catch (error) {
			code = (error as CentrsError).code;
		}
		expect(code).toBe("input/invalid-path");
	});
});
