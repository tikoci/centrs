/**
 * `--quickchr <name>` acceptance against a real quickchr-managed CHR (#134
 * Phase 5). Boots ONE CHR through quickchr's own registry, then targets it by
 * machine name only — no `$R`/`$U`/`$P`, no CDB, no CENTRS_HOST-style env: the
 * live descriptor (`QuickCHR.get(name).descriptor()`) is the only
 * connection-fact source. Covers the Q-series examples in
 * `commands/{retrieve,execute,api,transfer}/examples.md`, plus the TQ-series
 * in `commands/terminal/examples.md` (#610).
 */

import { describe, expect, test } from "bun:test";
import { runCli } from "../../src/cli.ts";
import {
	collapsePrintWrapping,
	exampleIds,
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";
import { runCliProcess } from "./cli-process.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

interface Envelope {
	ok: boolean;
	data?: unknown;
	error?: { code?: string; summary?: string };
	warnings?: Array<{ code?: string }>;
	meta: {
		via?: string | null;
		target: {
			identity?: string;
			recordIndex?: number;
			source?: { kind?: string; key?: string };
			host?: string;
		};
		settings?: Record<string, { kind?: string; key?: string } | undefined>;
	};
}

interface FanoutEnvelope {
	ok: boolean;
	data: {
		summary: { total: number; ok: number; failed: number };
		targets: Envelope[];
	};
}

function captureConsole() {
	const originalLog = console.log;
	const originalError = console.error;
	const logs: string[] = [];
	const errors: string[] = [];
	console.log = ((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	}) as typeof console.log;
	console.error = ((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	}) as typeof console.error;
	return {
		logs,
		errors,
		restore() {
			console.log = originalLog;
			console.error = originalError;
		},
	};
}

describeFast("--quickchr targets against CHR (#134)", () => {
	test("Q1–Q3 per command: retrieve/execute/api/transfer resolve the machine by name", async () => {
		// `secureLogin` makes quickchr provision and batch-verify a managed SSH key
		// at first boot — without it the descriptor vouches for no SSH auth, and
		// terminal TQ1 / transfer Q2's sftp branch have nothing to log in with.
		const started = await startIntegrationChr({ secureLogin: true });
		const chr = started.chr;
		const consoleCapture = captureConsole();
		try {
			const name = chr.name;

			const run = async (
				args: string[],
			): Promise<{ exit: number; out: string[]; err: string[] }> => {
				const logStart = consoleCapture.logs.length;
				const errStart = consoleCapture.errors.length;
				const exit = await runCli(args);
				return {
					exit,
					out: consoleCapture.logs.slice(logStart),
					err: consoleCapture.errors.slice(errStart),
				};
			};
			const parse = <T = Envelope>(streams: string[]): T =>
				JSON.parse(streams.join("\n")) as T;

			// retrieve Q1: REST endpoint from the descriptor; provider provenance;
			// no CDB record index may appear (the CDB was never consulted).
			const rq1 = await run([
				"retrieve",
				"--quickchr",
				name,
				"/system/resource",
				"--json",
			]);
			expect(rq1.exit).toBe(0);
			const rq1Env = parse(rq1.out);
			expect(rq1Env.ok).toBe(true);
			expect(rq1Env.meta.via).toBe("rest-api");
			expect(rq1Env.meta.target.identity).toBe(name);
			expect(rq1Env.meta.target.source?.kind).toBe("provider");
			expect(rq1Env.meta.target.recordIndex).toBeUndefined();

			// execute Q1: native-api default; identity round-trips from RouterOS.
			const eq1 = await run([
				"execute",
				"--quickchr",
				name,
				":put [/system/identity/get name]",
				"--json",
			]);
			expect(eq1.exit).toBe(0);
			const eq1Env = parse(eq1.out);
			expect(eq1Env.ok).toBe(true);
			expect(eq1Env.meta.via).toBe("native-api");
			expect(eq1Env.meta.target.source?.kind).toBe("provider");

			// execute (#470): a successful text run puts the device's answer on
			// stdout and the envelope's warning on stderr. The CMR run-script
			// detector is text-based, so a `:put` of the words raises one.
			const eqWarn = await run([
				"execute",
				"--quickchr",
				name,
				':put "cmr device run-script"',
			]);
			expect(eqWarn.exit).toBe(0);
			expect(eqWarn.out.join("\n")).toContain("cmr device run-script");
			expect(eqWarn.out.join("\n")).not.toContain("warning [");
			expect(eqWarn.err).toContainEqual(
				expect.stringMatching(
					/^warning \[cmr\/client-script-not-validated\]: /,
				),
			);

			// #470: `--verbose` text keeps stdout to the data; the header goes to
			// stderr, ahead of any warning.
			const eqVerbose = await run([
				"execute",
				"--quickchr",
				name,
				':put "cmr device run-script"',
				"--verbose",
			]);
			expect(eqVerbose.exit).toBe(0);
			expect(eqVerbose.out.join("\n").trim()).toBe(
				eqWarn.out.join("\n").trim(),
			);
			expect(eqVerbose.err[0]).toMatch(/^target: .*\nvia: native-api/);
			const rqVerbose = await run([
				"retrieve",
				"--quickchr",
				name,
				"/system/identity",
				"--verbose",
			]);
			expect(rqVerbose.exit).toBe(0);
			expect(rqVerbose.out.join("\n")).not.toMatch(/^(target|via|sources):/m);
			expect(rqVerbose.err.join("\n")).toMatch(/^via: rest-api$/m);
			expect(rqVerbose.err.join("\n")).toMatch(/^sources: via=/m);

			// execute Q1 (#426): an ambient CENTRS_HOST URL must not steer a
			// quickchr target's transport; the descriptor owns the endpoint.
			const savedHost = process.env["CENTRS_HOST"];
			process.env["CENTRS_HOST"] = "http://192.0.2.1:9";
			let eq1Url: Awaited<ReturnType<typeof run>>;
			try {
				eq1Url = await run([
					"execute",
					"--quickchr",
					name,
					":put [/system/identity/get name]",
					"--json",
				]);
			} finally {
				if (savedHost === undefined) {
					delete process.env["CENTRS_HOST"];
				} else {
					process.env["CENTRS_HOST"] = savedHost;
				}
			}
			expect(eq1Url.exit).toBe(0);
			const eq1UrlEnv = parse(eq1Url.out);
			expect(eq1UrlEnv.meta.via).toBe("native-api");
			expect(eq1UrlEnv.meta.settings?.["via"]).toEqual({
				kind: "default",
				key: "via",
			});

			// execute Q2: a --via the descriptor does not forward is a typed error,
			// never a fallback.
			const eq2 = await run([
				"execute",
				"--quickchr",
				name,
				":put 1",
				"--via",
				"mac-telnet",
				"--json",
			]);
			expect(eq2.exit).toBe(1);
			const eq2Env = parse(eq2.err);
			expect(eq2Env.ok).toBe(false);
			expect(eq2Env.error?.code).toBe("quickchr/unsupported-via");

			// execute Q3: repeated --quickchr fans out; the unknown machine is an
			// inner quickchr/machine-not-found, exit 2 (partial).
			const eq3 = await run([
				"execute",
				"--quickchr",
				name,
				"--quickchr",
				"centrs-no-such-machine",
				"--json",
				"--",
				":put 1",
			]);
			expect(eq3.exit).toBe(2);
			const eq3Env = parse<FanoutEnvelope>(eq3.out);
			expect(eq3Env.ok).toBe(true);
			expect(eq3Env.data.summary).toEqual({ total: 2, ok: 1, failed: 1 });
			const eq3Failed = eq3Env.data.targets.find((t) => !t.ok);
			expect(eq3Failed?.error?.code).toBe("quickchr/machine-not-found");
			expect(eq3Failed?.meta.target.identity).toBe("centrs-no-such-machine");

			// api Q1: GET over the descriptor's REST service.
			const aq1 = await run([
				"api",
				"--quickchr",
				name,
				"system/resource",
				"--json",
			]);
			expect(aq1.exit).toBe(0);
			const aq1Env = parse(aq1.out);
			expect(aq1Env.ok).toBe(true);
			expect(aq1Env.meta.target.source?.kind).toBe("provider");

			// transfer Q1: list over the REST service.
			const tq1 = await run(["transfer", "--quickchr", name, "list", "--json"]);
			expect(tq1.exit).toBe(0);
			const tq1Env = parse(tq1.out);
			expect(tq1Env.ok).toBe(true);
			expect(tq1Env.meta.target.source?.kind).toBe("provider");

			// transfer Q2: the sftp gate. Either the descriptor advertises a usable
			// batch-capable SSH auth mode and the list actually runs over sftp
			// (never a silent fallback to REST, never a dropped key), or the gate
			// fails typed (quickchr/ssh-auth-unavailable, exit 1) — never a prompt.
			const tq2 = await run([
				"transfer",
				"--quickchr",
				name,
				"list",
				"--via",
				"sftp",
				"--json",
			]);
			if (tq2.exit === 0) {
				const tq2Env = parse(tq2.out);
				expect(tq2Env.ok).toBe(true);
				// `meta.via` is the protocol id: sftp rides ssh (as transfer.test.ts).
				expect(tq2Env.meta.via).toBe("ssh");
				expect(tq2Env.meta.target.source?.kind).toBe("provider");
				// Trust-by-provenance: the SSH endpoint forces `insecure` with
				// provider provenance; the key (when the descriptor hands one over,
				// vs agent-or-config) must carry provider provenance too.
				expect(tq2Env.meta.settings?.["insecure"]?.kind).toBe("provider");
				const sshKeySource = tq2Env.meta.settings?.["sshKey"];
				if (sshKeySource !== undefined) {
					expect(sshKeySource.kind).toBe("provider");
				}
			} else {
				expect(tq2.exit).toBe(1);
				const tq2Env = parse(tq2.err);
				expect(tq2Env.ok).toBe(false);
				expect(tq2Env.error?.code).toBe("quickchr/ssh-auth-unavailable");
			}

			// terminal TQ1 (#610): one `--quickchr` opens an ssh console. The
			// descriptor must vouch for a provisioned, batch-verified key — that is
			// what the terminal logs in with (`-i <key> -o IdentitiesOnly=yes`), so
			// the round trip proves provider auth, not an ambient agent identity.
			const quickchrModule = "@tikoci/quickchr";
			const { QuickCHR } = (await import(quickchrModule)) as {
				QuickCHR: {
					get(name: string): {
						descriptor(): Promise<{
							services: {
								ssh?: { auth?: { username: string; batchModes: string[] } };
							};
						}>;
					};
				};
			};
			const sshAuth = (await QuickCHR.get(name).descriptor()).services.ssh
				?.auth;
			expect(
				sshAuth?.batchModes,
				"quickchr did not provision a batch-verified SSH key for this machine; terminal --quickchr cannot log in without one",
			).toContain("private-key");
			const identityRecord = (await chr.rest("/system/identity")) as Record<
				string,
				string
			>;
			const identity = identityRecord["name"] ?? "";
			const termQ1 = await runCliProcess({
				args: ["terminal", "--quickchr", name],
				// The second line asks the router which user holds this ssh login.
				stdin:
					'/system/identity/print\n:put ("ssh-user=" . [/user/active/get [find where via="ssh"] name])\n/quit\n',
				env: { CENTRS_SKIP_ENV_FILE: "1" },
				killAfterMs: 60_000,
			});
			const termQ1Out = collapsePrintWrapping(termQ1.stdoutText);
			expect(
				termQ1Out,
				`terminal --quickchr exit ${termQ1.exitCode}; stderr=${termQ1.stderrText}`,
			).toContain(`name: ${identity}`);
			// The router reports the descriptor's user on this login: the session
			// authenticated as quickchr's managed user, not another identity. (A
			// piped no-PTY console echoes no prompt to assert on.)
			expect(termQ1.stdoutText).toContain(`ssh-user=${sshAuth?.username}`);
			// Teardown: `/quit` + stdin EOF ends the session; the router drops the
			// ssh login from /user/active (the batch sftp list above may still be
			// draining, so poll briefly rather than assert one snapshot).
			let lingering: unknown[] = [];
			for (let attempt = 0; attempt < 20; attempt += 1) {
				const active = (await chr.rest("/user/active")) as Array<
					Record<string, string>
				>;
				lingering = active.filter((row) => row["via"] === "ssh");
				if (lingering.length === 0) break;
				await Bun.sleep(500);
			}
			expect(lingering, "an ssh session outlived the terminal").toEqual([]);

			// terminal TQ2: quickchr v1 forwards no mac-telnet; a pinned
			// `--via mac-telnet` is a typed error, never a swap to ssh.
			const termQ2 = await runCliProcess({
				args: ["terminal", "--quickchr", name, "--via", "mac-telnet", "--json"],
				env: { CENTRS_SKIP_ENV_FILE: "1" },
			});
			expect(termQ2.exitCode).toBe(1);
			expect(termQ2.stdoutText).toBe("");
			expect(JSON.parse(termQ2.stderrText).error.code as string).toBe(
				"quickchr/unsupported-via",
			);

			const version =
				typeof chr.state.version === "string" ? chr.state.version : "unknown";
			await recordIntegrationEvidence({
				suite: "--quickchr targets against CHR",
				command: "retrieve+execute+api+transfer",
				protocol: "rest-api+native-api",
				routerosVersion: version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(7),
			});
			await recordIntegrationEvidence({
				suite: "--quickchr targets against CHR",
				command: "terminal",
				protocol: "ssh",
				routerosVersion: version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: ["TQ1", "TQ2"],
			});
		} finally {
			consoleCapture.restore();
			await chr.destroy();
		}
	}, 600_000);
});
