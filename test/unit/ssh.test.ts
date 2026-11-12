import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	cleanConsoleOutput,
	encodeSshScript,
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
		expect(opts).toContain("-o IdentitiesOnly=yes");
		expect(opts).toContain("BatchMode=yes");
		expect(opts).toContain("ConnectTimeout=8");
		expect(opts).toContain("StrictHostKeyChecking=accept-new");
		expect(opts).not.toContain("UserKnownHostsFile=/dev/null");
	});

	test("no selected key leaves agent/config identity selection unrestricted", () => {
		const opts = sshCommonOptions(base);
		expect(opts).not.toContain("-i");
		expect(opts.join(" ")).not.toContain("IdentitiesOnly");
	});

	test("insecure disables host-key checking with an ephemeral hosts file", () => {
		const opts = sshCommonOptions({ ...base, insecure: true }).join(" ");
		expect(opts).toContain("StrictHostKeyChecking=no");
		// The null known_hosts sink is platform-specific: `NUL` on Windows OpenSSH,
		// `/dev/null` elsewhere (mirrors src/protocols/ssh.ts).
		const nullSink = process.platform === "win32" ? "NUL" : "/dev/null";
		expect(opts).toContain(`UserKnownHostsFile=${nullSink}`);
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
		const error = (await c
			.exec("/system/identity/print")
			.catch((e) => e)) as CentrsError;
		expect(error.code).toBe("auth/failed");
		// Batch ssh never sends a password (#391): name the key source, and keep
		// RouterOS's password policy a separate fact, not the guessed cause.
		expect(error.context).toMatchObject({ sshKeySelected: true });
		expect(error.remediation).toContain("never sends a password");
		expect(error.remediation).toContain(
			"the selected SSH key (plus any `IdentityFile`",
		);
		expect(error.remediation).toContain("`ssh` policy");
		expect(error.remediation).toContain("`/ip/ssh password-authentication`");
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

	test("an IPv6 host dials bare but reads bracketed in the error (#427)", async () => {
		const capture: { argv?: readonly string[] } = {};
		const c = new SshExecClient({
			host: "2001:db8::10",
			port: 9,
			username: "admin",
			timeoutMs: 8000,
			runner: async (argv) => {
				capture.argv = argv;
				return {
					exitCode: 255,
					stdout: "",
					stderr:
						"ssh: connect to host 2001:db8::10 port 9: Connection refused",
				};
			},
		});
		await expect(c.exec("/x")).rejects.toMatchObject({
			code: "transport/connection-refused",
			summary: "SSH connection to [2001:db8::10]:9 was refused.",
		});
		// `ssh user@[addr]` fails to resolve; ssh takes the bare address.
		expect(capture.argv).toContain("admin@2001:db8::10");
	});
});

// Captures from CHR 7.25.1 and 7.24.6 (2026-11-11): the system `ssh` exit
// status and stdout for each shape (#576), and a script cut off by the budget
// (#592). The known-hosts warning is OpenSSH's, on stderr.
const KNOWN_HOSTS =
	"Warning: Permanently added '[127.0.0.1]:9272' (ED25519) to the list of known hosts.";

describe("SshExecClient: remote exit status (#576)", () => {
	function client(result: SshExecResult) {
		return new SshExecClient({
			host: "127.0.0.1",
			port: 9272,
			username: "admin",
			timeoutMs: 10_000,
			runner: async () => result,
		});
	}

	test("a RouterOS diagnostic on stdout keeps its specific code, not transport/network", async () => {
		const error = (await client({
			exitCode: 1,
			stdout: "bad command name print (line 1 column 1)\n",
			stderr: KNOWN_HOSTS,
		})
			.exec("/ip/firewall/address-list\nprint\n")
			.catch((e) => e)) as CentrsError;
		expect(error.code).toBe("routeros/unknown-path");
		expect(error.position).toEqual({ line: 1, column: 1 });
		expect(error.context).toMatchObject({
			via: "ssh",
			exitCode: 1,
			output: "bad command name print (line 1 column 1)",
			partialRunPossible: true,
		});
	});

	test("an unrecognized diagnostic is routeros/command-failed and says earlier lines ran", async () => {
		const error = (await client({
			exitCode: 1,
			stdout: "something RouterOS said\r\n",
			stderr: KNOWN_HOSTS,
		})
			.exec("/ip/firewall/address-list\nprint")
			.catch((e) => e)) as CentrsError;
		expect(error.code).toBe("routeros/command-failed");
		expect(error.summary).toContain("exit 1: something RouterOS said");
		expect(error.remediation).toContain(
			"the statements before it have already run",
		);
		expect(error.context?.["stderr"]).toBe(KNOWN_HOSTS);
	});

	test("statements on one line are a partial run too, not only line breaks", async () => {
		const error = (await client({
			exitCode: 1,
			stdout: "boom (:error; line 1)\r\n",
			stderr: KNOWN_HOSTS,
		})
			.exec("/file/add name=review-single.txt type=file; :error boom")
			.catch((e) => e)) as CentrsError;
		expect(error.context?.["partialRunPossible"]).toBe(true);
	});

	test("a CR-encoded script (as the adapter sends it) counts its lines", async () => {
		const error = (await client({
			exitCode: 1,
			stdout: "before\r\nboom (:error; line 2)\r\n",
			stderr: KNOWN_HOSTS,
		})
			.exec(encodeSshScript(":put before\n:error boom\n:put after"))
			.catch((e) => e)) as CentrsError;
		expect(error.context?.["partialRunPossible"]).toBe(true);
	});

	test("a nonzero exit with no output says there was no diagnostic", async () => {
		const error = (await client({ exitCode: 1, stdout: "", stderr: "" })
			.exec("/x")
			.catch((e) => e)) as CentrsError;
		expect(error.code).toBe("routeros/command-failed");
		expect(error.summary).toContain("printed no diagnostic");
		expect(error.context?.["partialRunPossible"]).toBeUndefined();
		expect(error.remediation).not.toContain("multi-line");
	});

	test("exit 255 with unknown stderr stays a transport failure", async () => {
		await expect(
			client({
				exitCode: 255,
				stdout: "",
				stderr: "kex_exchange_identification",
			}).exec("/x"),
		).rejects.toMatchObject({ code: "transport/network" });
	});
});

describe("SshExecClient: timeout keeps what it saw (#592)", () => {
	test("an execution timeout names the budget, keeps partial output, and says it may still run", async () => {
		const c = new SshExecClient({
			host: "127.0.0.1",
			port: 9272,
			username: "admin",
			timeoutMs: 10_000,
			runner: async () => ({
				exitCode: 143,
				stdout: "begin\r\n",
				stderr: `${KNOWN_HOSTS}\nConnection timed out`,
				timedOut: true,
			}),
		});
		const error = (await c
			.exec(":put begin; :delay 15s; :put end")
			.catch((e) => e)) as CentrsError;
		expect(error.code).toBe("transport/timeout");
		expect(error.summary).toBe(
			"SSH execute on 127.0.0.1:9272 did not finish within 10s; the command may still be running on the router.",
		);
		expect(error.remediation).toContain("`CENTRS_TIMEOUT`");
		expect(error.remediation).toContain("`--timeout`");
		expect(error.context).toMatchObject({
			timeoutMs: 10_000,
			partialOutput: "begin",
			outputComplete: false,
		});
	});
});

// Over SSH exec, LF ends RouterOS's prompt (each line runs on its own) and CR is
// a line break inside it, so a script is sent with CR line breaks to run as one
// unit (CHR 7.25.1 and 7.24.6, #576).
describe("encodeSshScript (#576)", () => {
	test("LF and CRLF line breaks become CR; a trailing break is dropped", () => {
		expect(encodeSshScript("/ip/firewall/address-list\nprint\n")).toBe(
			"/ip/firewall/address-list\rprint",
		);
		expect(encodeSshScript(":local x 17\r\n:put $x")).toBe(
			":local x 17\r:put $x",
		);
		expect(encodeSshScript("{\n:local n 0\n:put $n\n}")).toBe(
			"{\r:local n 0\r:put $n\r}",
		);
	});

	test("a single line is sent unchanged", () => {
		expect(
			encodeSshScript('/ip/address/add address=192.0.2.1/32 comment="a b"'),
		).toBe('/ip/address/add address=192.0.2.1/32 comment="a b"');
	});

	test("an escaped newline inside a string is kept as written", () => {
		expect(encodeSshScript(':put "a\\nb"\n:put c')).toBe(
			':put "a\\nb"\r:put c',
		);
		expect(encodeSshScript(':put "say \\"hi\\""\n:put c')).toBe(
			':put "say \\"hi\\""\r:put c',
		);
	});

	test("a quote inside a # comment line does not open a string", () => {
		expect(encodeSshScript("# it's \"odd\n:put 1")).toBe(
			"# it's \"odd\r:put 1",
		);
	});

	test("a quote inside an inline comment does not open a string", () => {
		expect(
			encodeSshScript(':put before; # a lone " in a comment\n:put after'),
		).toBe(':put before; # a lone " in a comment\r:put after');
		expect(encodeSshScript('{ # a lone " in a comment\n:put after\n}')).toBe(
			'{ # a lone " in a comment\r:put after\r}',
		);
		// A `#` inside a string is not a comment.
		expect(encodeSshScript(':put "a # b"\n:put c')).toBe(
			':put "a # b"\r:put c',
		);
	});

	test("a raw line break inside a quoted string is refused", () => {
		for (const script of [
			':put "a\nb"',
			':put "a\\\nb"',
			'{ :put "a\r\nb" }',
		]) {
			expect(() => encodeSshScript(script)).toThrow(
				expect.objectContaining({ code: "transport/capability-unsupported" }),
			);
		}
	});
});
