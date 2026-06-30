/**
 * CLI smoke tier — JG-10.
 *
 * Spawns the real `src/cli.ts` as a child process (via the cli-process harness)
 * and exercises the common, **network-free** user flows: help / usage, the
 * invalid-command path, and a full `devices` CDB round-trip. No RouterOS / CHR is
 * involved, so — unlike the CHR integration suites — this is *not* gated behind
 * `CENTRS_RUN_FAST_INTEGRATION`; it always runs, which means it runs in the fast
 * push/PR gate (ci.yaml's `Test` step) on every change. It double-checks arg
 * parsing, the help system, and the error/result envelope from a *real process*,
 * complementing the in-process unit tests that cannot see exit codes or stdio.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliProcess } from "./cli-process.ts";

interface Envelope {
	ok: boolean;
	error?: { code?: string; detailsUrl?: string };
}

function parseEnvelope(text: string): Envelope {
	const value = JSON.parse(text) as unknown;
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as Envelope).ok !== "boolean"
	) {
		throw new Error(
			`expected a centrs envelope with a boolean \`ok\`; got: ${text.slice(0, 200)}`,
		);
	}
	return value as Envelope;
}

describe("CLI smoke (real subprocess, no network)", () => {
	test("top-level help and no-args both render the command index", async () => {
		for (const args of [["--help"], [] as string[]]) {
			const res = await runCliProcess({ args });
			expect(res.exitCode).toBe(0);
			expect(res.stdoutText).toContain("RouterOS interaction hub");
			expect(res.stdoutText).toContain("Commands:");
			expect(res.stdoutText).toContain("retrieve");
			expect(res.stdoutText).toContain("devices");
		}
	});

	test("command-level help is reachable (devices --help)", async () => {
		const res = await runCliProcess({ args: ["devices", "--help"] });
		expect(res.exitCode).toBe(0);
		expect(res.stdoutText.toLowerCase()).toContain("devices");
	});

	test("an unknown command is the invalid-command error", async () => {
		const res = await runCliProcess({ args: ["definitely-not-a-command"] });
		expect(res.exitCode).toBe(1);
		expect(res.stderrText).toContain("input/invalid-command");
		expect(res.stderrText).toContain("Unknown centrs command");
		expect(res.stderrText).toContain(
			"https://tikoci.github.io/centrs/errors/input/invalid-command",
		);
	});

	test("devices CDB round-trip: add → list → show → remove (temp HOME)", async () => {
		// A fresh CDB at the *default* path auto-creates on first use, so pointing
		// HOME at a temp dir gives a throwaway default CDB — the round-trip touches
		// no real CDB and no router.
		const home = await mkdtemp(join(tmpdir(), "centrs-smoke-home-"));
		const env = { HOME: home };
		const target = "192.0.2.99";
		try {
			const add = await runCliProcess({
				args: [
					"devices",
					"add",
					target,
					"--user",
					"admin",
					"--password",
					"x",
					"--group",
					"smoke",
					"--json",
				],
				env,
			});
			expect(add.exitCode).toBe(0);
			expect(parseEnvelope(add.stdoutText).ok).toBe(true);

			const list = await runCliProcess({
				args: ["devices", "list", "--json"],
				env,
			});
			expect(list.exitCode).toBe(0);
			expect(parseEnvelope(list.stdoutText).ok).toBe(true);
			expect(list.stdoutText).toContain(target);

			const show = await runCliProcess({
				args: ["devices", "show", target, "--json"],
				env,
			});
			expect(show.exitCode).toBe(0);
			expect(parseEnvelope(show.stdoutText).ok).toBe(true);

			// Error-envelope shape on a clean failure (unknown target): ok:false with
			// a stable code + details URL, on stderr.
			const miss = await runCliProcess({
				args: ["devices", "show", "10.0.0.254", "--json"],
				env,
			});
			expect(miss.exitCode).toBe(1);
			const missEnvelope = parseEnvelope(miss.stderrText);
			expect(missEnvelope.ok).toBe(false);
			expect(missEnvelope.error?.code).toBe("cdb/not-found-target");
			expect(missEnvelope.error?.detailsUrl).toContain(
				"/errors/cdb/not-found-target",
			);

			const remove = await runCliProcess({
				args: ["devices", "remove", target, "--json"],
				env,
			});
			expect(remove.exitCode).toBe(0);
			expect(parseEnvelope(remove.stdoutText).ok).toBe(true);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("terminal MAC over --via ssh with no CDB record errors + tips L2 (JG-01)", async () => {
		// A temp HOME means the default CDB has no record for the MAC, so the
		// IP-transport (ssh) MAC→IP resolution fails hermetically — no router, no
		// ARP opt-in. The tip must lead with the L2 alternative.
		const home = await mkdtemp(join(tmpdir(), "centrs-smoke-home-"));
		try {
			const res = await runCliProcess({
				args: [
					"terminal",
					"aa:bb:cc:dd:ee:ff",
					"--via",
					"ssh",
					"--username",
					"admin",
					"--json",
				],
				env: { HOME: home },
			});
			expect(res.exitCode).toBe(1);
			const envelope = parseEnvelope(res.stderrText);
			expect(envelope.ok).toBe(false);
			expect(envelope.error?.code).toBe("target/mac-unresolved");
			expect(res.stderrText).toContain("--via mac-telnet");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("--user and -u are accepted aliases for --username (JG-23)", async () => {
		// A temp HOME keeps the default CDB empty, so the missing-target tip is
		// deterministic and no real inventory leaks into the assertion. With neither
		// a target nor a command, `execute` leads with the missing-target error — but
		// the alias still has to be *parsed* (consuming "admin") to get there;
		// otherwise "admin" is read as the target and we'd hit the missing-command
		// error instead. So the missing-target code path itself proves the alias.
		const home = await mkdtemp(join(tmpdir(), "centrs-smoke-home-"));
		try {
			for (const alias of ["--user", "-u"]) {
				const res = await runCliProcess({
					args: ["execute", alias, "admin", "--json"],
					env: { HOME: home },
				});
				expect(res.exitCode).toBe(1);
				const envelope = parseEnvelope(res.stderrText);
				expect(envelope.ok).toBe(false);
				expect(envelope.error?.code).toBe("input/invalid-command");
				expect(res.stderrText).toContain("requires a <target>");
				expect(res.stderrText).not.toContain("requires a RouterOS command");
				expect(res.stderrText).toContain("tip/no-devices");
			}
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("api command-level help is reachable", async () => {
		const res = await runCliProcess({ args: ["api", "--help"] });
		expect(res.exitCode).toBe(0);
		expect(res.stdoutText).toContain("api <router> <endpoint>");
		expect(res.stdoutText).toContain("--method");
		// The folded follow surface shows up in help.
		expect(res.stdoutText).toContain("--stream");
	});

	test("the folded `stream` command points at `api --stream` (no network)", async () => {
		for (const command of ["stream", "tail"]) {
			const res = await runCliProcess({
				args: [command, "edge1", "ip/address"],
			});
			expect(res.exitCode).toBe(1);
			expect(res.stderrText).toContain("api");
			expect(res.stderrText).toContain("--stream");
		}
	});

	test("--via rest-api --stream is rejected as capability-unsupported (no network)", async () => {
		// apiListen rejects a non-native transport before any connection, so this
		// is hermetic: REST cannot follow an open-ended stream.
		const res = await runCliProcess({
			args: [
				"api",
				"192.0.2.1",
				"ip/address",
				"--stream",
				"--via",
				"rest-api",
				"--json",
			],
		});
		expect(res.exitCode).toBe(1);
		const envelope = parseEnvelope(res.stdoutText || res.stderrText);
		expect(envelope.ok).toBe(false);
		expect(envelope.error?.code).toBe("transport/capability-unsupported");
	});

	test("api lists in the top-level command index", async () => {
		const res = await runCliProcess({ args: ["--help"] });
		expect(res.exitCode).toBe(0);
		expect(res.stdoutText).toContain("api");
	});

	test("an unsupported -X method is usage/invalid-method (no network)", async () => {
		// parseApiMethod rejects before any transport/CDB I/O, so this is hermetic.
		// HEAD is a real HTTP method centrs does not map to a RouterOS verb.
		const res = await runCliProcess({
			args: ["api", "192.0.2.1", "ip/address", "-X", "HEAD", "--json"],
		});
		expect(res.exitCode).toBe(1);
		const envelope = parseEnvelope(res.stderrText);
		expect(envelope.ok).toBe(false);
		expect(envelope.error?.code).toBe("usage/invalid-method");
	});

	test("combining -f and -d is usage/conflicting-flags (no network)", async () => {
		const res = await runCliProcess({
			args: [
				"api",
				"192.0.2.1",
				"ip/address",
				"-X",
				"PUT",
				"-f",
				"address=1.2.3.4/32",
				"-d",
				"{}",
				"--yes",
				"--json",
			],
		});
		expect(res.exitCode).toBe(1);
		const envelope = parseEnvelope(res.stderrText);
		expect(envelope.ok).toBe(false);
		expect(envelope.error?.code).toBe("usage/conflicting-flags");
	});

	test("api fan-out + --listen is usage/fanout-not-supported (no network)", async () => {
		// The single-session guard fires before any CDB/transport I/O — hermetic.
		const res = await runCliProcess({
			args: ["api", "--group", "prod", "ip/address", "--listen", "--json"],
		});
		expect(res.exitCode).toBe(1);
		const envelope = parseEnvelope(res.stderrText);
		expect(envelope.ok).toBe(false);
		expect(envelope.error?.code).toBe("usage/fanout-not-supported");
	});

	test("api fan-out + --raw is usage/conflicting-flags (no network)", async () => {
		const res = await runCliProcess({
			args: ["api", "--group", "prod", "ip/address", "--raw", "--json"],
		});
		expect(res.exitCode).toBe(1);
		const envelope = parseEnvelope(res.stderrText);
		expect(envelope.ok).toBe(false);
		expect(envelope.error?.code).toBe("usage/conflicting-flags");
	});

	test("api with no <router> tips toward discover/devices", async () => {
		const home = await mkdtemp(join(tmpdir(), "centrs-smoke-home-"));
		try {
			const res = await runCliProcess({ args: ["api"], env: { HOME: home } });
			expect(res.exitCode).toBe(1);
			expect(res.stderrText).toContain("requires a <router>");
			expect(res.stderrText).toContain("tip/no-devices");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("a missing <router> tips toward discover/devices (terminal, JG-?)", async () => {
		// Empty HOME ⇒ empty registry ⇒ the tip points at `discover --save`. This is
		// the text path, so it exercises the `Tips:` footer the error renderer adds.
		const home = await mkdtemp(join(tmpdir(), "centrs-smoke-home-"));
		try {
			const res = await runCliProcess({
				args: ["terminal"],
				env: { HOME: home },
			});
			expect(res.exitCode).toBe(1);
			expect(res.stderrText).toContain("requires a <router>");
			expect(res.stderrText).toContain("Tips:");
			expect(res.stderrText).toContain("tip/no-devices");
			expect(res.stderrText).toContain("centrs discover --save");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
