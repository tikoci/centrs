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
	return JSON.parse(text) as Envelope;
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
});
