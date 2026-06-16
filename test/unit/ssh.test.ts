import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	cleanConsoleOutput,
	SshExecClient,
	type SshExecResult,
	sshCommonOptions,
} from "../../src/protocols/ssh.ts";

describe("cleanConsoleOutput", () => {
	test("CRLF→LF, trims trailing padding, drops trailing blank lines", () => {
		// As captured over `ssh host "/system/identity/print"` (CHR 7.23.1).
		expect(cleanConsoleOutput("  name: CHR\r\n\r\n")).toBe("  name: CHR");
	});

	test("preserves leading indentation (RouterOS print alignment) but trims tails", () => {
		const raw = "       uptime: 24s     \r\n      version: 7.23.1   \r\n";
		expect(cleanConsoleOutput(raw)).toBe(
			"       uptime: 24s\n      version: 7.23.1",
		);
	});

	test("drops leading and trailing blank lines", () => {
		expect(cleanConsoleOutput("\r\n\r\nflags: X\r\n\r\n")).toBe("flags: X");
	});

	test("empty / whitespace-only output is the empty string", () => {
		expect(cleanConsoleOutput("\r\n   \r\n")).toBe("");
	});
});

describe("sshCommonOptions", () => {
	const base = { host: "192.0.2.10", port: 22, timeoutMs: 8000 };

	test("secure default: key, batch mode, connect timeout, accept-new", () => {
		const opts = sshCommonOptions({ ...base, sshKey: "/k/id" }).join(" ");
		expect(opts).toContain("-i /k/id");
		expect(opts).toContain("BatchMode=yes");
		expect(opts).toContain("ConnectTimeout=8");
		expect(opts).toContain("StrictHostKeyChecking=accept-new");
		expect(opts).not.toContain("UserKnownHostsFile=/dev/null");
	});

	test("insecure disables host-key checking with an ephemeral hosts file", () => {
		const opts = sshCommonOptions({ ...base, insecure: true }).join(" ");
		expect(opts).toContain("StrictHostKeyChecking=no");
		expect(opts).toContain("UserKnownHostsFile=/dev/null");
	});
});

describe("SshExecClient", () => {
	function client(
		result: SshExecResult,
		capture?: { argv?: readonly string[] },
	) {
		return new SshExecClient({
			host: "192.0.2.10",
			port: 22,
			username: "admin",
			sshKey: "/k/id",
			timeoutMs: 8000,
			runner: async (argv) => {
				if (capture) capture.argv = argv;
				return result;
			},
		});
	}

	test("argv is `ssh -p <port> <opts> user@host <command>`", () => {
		const argv = client({ exitCode: 0, stdout: "", stderr: "" }).argv(
			"/system/identity/print",
		);
		expect(argv[0]).toBe("ssh");
		expect(argv).toContain("-p");
		expect(argv).toContain("22");
		expect(argv.at(-2)).toBe("admin@192.0.2.10");
		expect(argv.at(-1)).toBe("/system/identity/print");
	});

	test("never forces a PTY — RouterOS grants none and `-tt` hangs it", () => {
		// Per-command batch exec must not *force* a tty (the terminal relay guards
		// the same in terminal.test.ts). `-tt` makes the host ssh demand a PTY that
		// RouterOS refuses, hanging the session (CHR 7.23.1 grounded). Disabling a
		// PTY (`-T`, `RequestTTY=no`) is the opposite and would be fine, so only the
		// forcing forms are forbidden.
		const argv = client({ exitCode: 0, stdout: "", stderr: "" }).argv("/x");
		expect(argv).not.toContain("-t");
		expect(argv).not.toContain("-tt");
		expect(argv.join(" ")).not.toMatch(/RequestTTY[= ](?:force|yes)/i);
	});

	test("exec returns cleaned stdout on success", async () => {
		const out = await client({
			exitCode: 0,
			stdout: "  name: CHR\r\n\r\n",
			stderr: "",
		}).exec("/system/identity/print");
		expect(out).toBe("  name: CHR");
	});

	test("a non-zero exit with auth stderr maps to auth/failed", async () => {
		const c = client({
			exitCode: 255,
			stdout: "",
			stderr: "admin@192.0.2.10: Permission denied (publickey).",
		});
		await expect(c.exec("/system/identity/print")).rejects.toMatchObject({
			code: "auth/failed",
		});
	});

	test("a changed host key maps to transport/host-key-mismatch", async () => {
		const c = client({
			exitCode: 255,
			stdout: "",
			stderr: "Host key verification failed.",
		});
		const error = await c.exec("/x").catch((e) => e);
		expect(error).toBeInstanceOf(CentrsError);
		expect((error as CentrsError).code).toBe("transport/host-key-mismatch");
	});

	test("connection refused maps to transport/connection-refused", async () => {
		const c = client({
			exitCode: 255,
			stdout: "",
			stderr: "ssh: connect to host 192.0.2.10 port 22: Connection refused",
		});
		await expect(c.exec("/x")).rejects.toMatchObject({
			code: "transport/connection-refused",
		});
	});
});
