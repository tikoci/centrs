import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	cleanConsoleOutput,
	encodeSshScript,
	readExecStderr,
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
			"the statements (and loop iterations) before it have already run",
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

	test("a loop that fails on a later iteration is a partial run", async () => {
		// The first iteration adds the entry; the second fails on the
		// duplicate (CHR 7.25.1, 7.24.6), so one statement still left a write.
		const error = (await client({
			exitCode: 1,
			stdout:
				"failure: already have such entry (/ip/firewall/address-list/add; line 1)\r\n",
			stderr: KNOWN_HOSTS,
		})
			.exec(
				":foreach i in={1;2} do={ /ip/firewall/address-list/add list=review-loop address=192.0.2.200 }",
			)
			.catch((e) => e)) as CentrsError;
		expect(error.context?.["partialRunPossible"]).toBe(true);
	});

	test("a single statement that fails is not a partial run", async () => {
		const error = (await client({
			exitCode: 1,
			stdout:
				"failure: already have such entry (/ip/firewall/address-list/add; line 1)\r\n",
			stderr: KNOWN_HOSTS,
		})
			.exec("/ip/firewall/address-list/add list=l address=192.0.2.200")
			.catch((e) => e)) as CentrsError;
		expect(error.context?.["partialRunPossible"]).toBeUndefined();
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

	test("a diagnostic after earlier output keeps its code; the full output stays in context", async () => {
		const error = (await client({
			exitCode: 1,
			stdout: "before\r\nbad command name no-such (line 2 column 1)\r\n",
			stderr: KNOWN_HOSTS,
		})
			.exec(encodeSshScript(":put before\n/no-such"))
			.catch((e) => e)) as CentrsError;
		expect(error.code).toBe("routeros/unknown-path");
		expect(error.position).toEqual({ line: 2, column: 1 });
		expect(error.context).toMatchObject({
			output: "before\nbad command name no-such (line 2 column 1)",
			partialRunPossible: true,
		});
	});

	test("ordinary output before an unrecognized last line is still routeros/command-failed", async () => {
		const error = (await client({
			exitCode: 1,
			stdout: "bad command name x (line 1 column 1)\r\nsomething else\r\n",
			stderr: "",
		})
			.exec(":put a\n:put b")
			.catch((e) => e)) as CentrsError;
		expect(error.code).toBe("routeros/command-failed");
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
		let sent = 0;
		const error = (await c
			.exec(":put begin; :delay 15s; :put end", { onSent: () => sent++ })
			.catch((e) => e)) as CentrsError;
		expect(sent).toBe(1);
		expect(error.code).toBe("transport/timeout");
		expect(error.summary).toBe(
			"SSH execute on 127.0.0.1:9272 did not finish within 10s; the command may still be running on the router.",
		);
		expect(error.remediation).toContain("`CENTRS_TIMEOUT`");
		expect(error.remediation).toContain("`--timeout`");
		expect(error.context).toMatchObject({
			timeoutMs: 10_000,
			sessionReached: true,
			partialOutput: "begin",
			outputComplete: false,
		});
	});

	/** A client whose runs answer in order; the last answer repeats. */
	function sequence(...results: SshExecResult[]) {
		let i = 0;
		return new SshExecClient({
			host: "127.0.0.1",
			port: 9272,
			username: "admin",
			timeoutMs: 10_000,
			runner: async () =>
				results[Math.min(i++, results.length - 1)] as SshExecResult,
		});
	}
	const silentTimeout: SshExecResult = {
		exitCode: 143,
		stdout: "",
		stderr: "",
		timedOut: true,
	};

	const AUTHENTICATED =
		'Authenticated to 127.0.0.1 ([127.0.0.1]:9272) using "publickey".';

	test("a silent timeout after this invocation logged in is an execution timeout", async () => {
		const error = (await sequence({
			...silentTimeout,
			stderr: `${KNOWN_HOSTS}\r\n${AUTHENTICATED}\r\nKilled by signal 15.\r\n`,
		})
			.exec(":delay 15s", { onSent: () => {} })
			.catch((e) => e)) as CentrsError;
		expect(error.code).toBe("transport/timeout");
		expect(error.summary).toContain("may still be running on the router");
		expect(error.context?.["sessionReached"]).toBe(true);
		expect(String(error.causeData)).not.toContain("Authenticated to");
	});

	test("an earlier exec that answered does not prove the next handshake did", async () => {
		// Each exec is a fresh ssh process and login: the `:parse` check
		// succeeded, then the command's own handshake stalled.
		const c = sequence(
			{
				exitCode: 0,
				stdout: "(evl …)\r\n",
				stderr: `${AUTHENTICATED}\r\n`,
			},
			silentTimeout,
		);
		await c.exec(':put [:parse ":put hello"]');
		let sent = 0;
		const error = (await c
			.exec(":put hello", { onSent: () => sent++ })
			.catch((e) => e)) as CentrsError;
		expect(error.code).toBe("transport/timeout");
		expect(error.summary).not.toContain("may still be running");
		expect(error.context?.["sessionReached"]).toBe(false);
		// The command never left: no dispatch, so no unknown-write warning.
		expect(sent).toBe(0);
	});

	test("a check that logged in and timed out says the command was not sent", async () => {
		// No `onSent`: this is the `:parse` gate, not the requested command.
		const error = (await sequence({
			...silentTimeout,
			stderr: `${AUTHENTICATED}\r\n`,
		})
			.exec(':put [:parse ":delay 15s"]')
			.catch((e) => e)) as CentrsError;
		expect(error.code).toBe("transport/timeout");
		expect(error.summary).toBe(
			"SSH to 127.0.0.1:9272 logged in, but the check before the command did not finish within 10s; the command was not sent.",
		);
		expect(error.summary).not.toContain("may still be running");
		expect(error.context).toMatchObject({
			sessionReached: true,
			commandSent: false,
		});
	});

	test("onSent fires only on evidence this invocation reached RouterOS", async () => {
		const cases: [SshExecResult, number][] = [
			[{ exitCode: 0, stdout: "", stderr: "" }, 1],
			[{ exitCode: 1, stdout: "boom (:error; line 1)\r\n", stderr: "" }, 1],
			[{ exitCode: 1, stdout: "", stderr: "" }, 1],
			[{ ...silentTimeout, stderr: `${AUTHENTICATED}\r\n` }, 1],
			[{ ...silentTimeout, stdout: "begin\r\n" }, 1],
			[silentTimeout, 0],
			[
				{
					exitCode: 255,
					stdout: "",
					stderr:
						"ssh: connect to host 127.0.0.1 port 9272: Connection refused",
				},
				0,
			],
			[
				{
					exitCode: 255,
					stdout: "",
					stderr: "admin@127.0.0.1: Permission denied (publickey).",
				},
				0,
			],
		];
		for (const [result, expected] of cases) {
			let sent = 0;
			await sequence(result)
				.exec("/x", { onSent: () => sent++ })
				.catch(() => {});
			expect(sent, JSON.stringify(result)).toBe(expected);
		}
	});

	test("a silent timeout on the first exec does not claim the command is running", async () => {
		// An unreachable host: ssh is killed in the connect phase, before
		// RouterOS answers anything.
		const error = (await sequence(silentTimeout)
			.exec(':put [:parse "/ip/address/print"]')
			.catch((e) => e)) as CentrsError;
		expect(error.code).toBe("transport/timeout");
		expect(error.summary).toBe(
			"SSH to 127.0.0.1:9272 got no answer within 10s; the connection or login may not have completed.",
		);
		expect(error.summary).not.toContain("may still be running");
		expect(error.remediation).toContain("`/ip service`");
		expect(error.context).toMatchObject({ sessionReached: false });
		expect(error.context?.["partialOutput"]).toBeUndefined();
	});

	test("argv asks OpenSSH for its login evidence", () => {
		const argv = sequence(silentTimeout).argv(":put 1");
		expect(argv.join(" ")).toContain("-o LogLevel=VERBOSE --");
	});

	test("OpenSSH's own connect failure wins over the budget kill", async () => {
		const error = (await sequence({
			...silentTimeout,
			stderr: "ssh: connect to host 127.0.0.1 port 9272: Connection timed out",
		})
			.exec("/x")
			.catch((e) => e)) as CentrsError;
		expect(error.code).toBe("transport/timeout");
		expect(error.summary).toBe("SSH connection to 127.0.0.1:9272 timed out.");
	});
});

// Over SSH exec, LF ends RouterOS's prompt (each line runs on its own) and CR is
// a line break inside it, so a script is sent with CR line breaks to run as one
// unit (CHR 7.25.1 and 7.24.6, #576).
describe("readExecStderr", () => {
	test("drops verbose progress lines and reports a completed login", () => {
		expect(
			readExecStderr(
				`${KNOWN_HOSTS}\r\nAuthenticated to 127.0.0.1 ([127.0.0.1]:9272) using "publickey".\r\nTransferred: sent 3624, received 2320 bytes, in 0.0 seconds\r\nBytes per second: sent 1471029.3, received 941718.6\r\n`,
			),
		).toEqual({ authenticated: true, stderr: `${KNOWN_HOSTS}\n` });
		expect(
			readExecStderr("ssh: connect to host x port 22: Connection refused"),
		).toEqual({
			authenticated: false,
			stderr: "ssh: connect to host x port 22: Connection refused",
		});
	});
});

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

	test("a CRLF comment inside a continued statement keeps one break per line", () => {
		// The mask blanks the comment's CR; the break is read from the original.
		expect(encodeSshScript(':put \\\r\n# comment\r\n"after"')).toBe(
			':put \\\r# comment\r"after"',
		);
		expect(encodeSshScript("# a\r\n# b\r\n:put 1")).toBe("# a\r# b\r:put 1");
		// A quote in a CR-only comment opens no string either.
		expect(encodeSshScript("# it's \"odd\r:put 1")).toBe(
			"# it's \"odd\r:put 1",
		);
	});

	test("a raw line break inside a quoted string is refused", () => {
		for (const script of [
			':put "a\nb"',
			':put "a\\\nb"',
			'{ :put "a\r\nb" }',
			// A lone CR ends the comment, so the string after it is scanned.
			'# note\r:put "a\nb"',
		]) {
			expect(() => encodeSshScript(script)).toThrow(
				expect.objectContaining({ code: "transport/capability-unsupported" }),
			);
		}
	});
});
