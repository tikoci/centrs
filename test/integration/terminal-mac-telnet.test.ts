/**
 * `terminal` over MAC-Telnet — the interactive relay against a real CHR over a
 * real L2 path, driven through the **real `centrs terminal` binary**
 * (`./cli-process.ts`) pointed at the L2 bridge's UDP relay. This reuses the
 * subprocess harness built for the transfer stdin/stdout examples: piped stdin
 * stands in for typed keystrokes, and the device's response is read off stdout.
 *
 * Maps `commands/terminal/examples.md`:
 *   T1 — batch relay: pipe a command in, the device's output appears on stdout.
 *   T2/T3 — `--via rest-api` / `--via native-api` have no terminal capability.
 *
 * The transport (resolver → UDP transport → `MacTelnetConsole`) is the exact path
 * `execute / mac-telnet` proved; `terminal` adds only the raw passthrough on top.
 * Grounded on stock CHR 7.23.1; REST is the source of truth for the cross-check.
 */

import { describe, expect, test } from "bun:test";
import {
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";
import { runCliProcess } from "./cli-process.ts";
import { startMacTelnetL2Bridge } from "./mactelnet-l2-bridge.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

const MT_USER = "mt";
const MT_PASSWORD = "mt-secret";

function asRecord(value: unknown): Record<string, string> {
	return (value ?? {}) as Record<string, string>;
}
function asRecordArray(value: unknown): Record<string, string>[] {
	return Array.isArray(value) ? (value as Record<string, string>[]) : [];
}

describeFast("terminal over mac-telnet (interactive relay)", () => {
	test("batch relay runs a command + capability gate, over real L2", async () => {
		const bridge = await startMacTelnetL2Bridge();
		let chr: Awaited<ReturnType<typeof startIntegrationChr>>["chr"] | undefined;
		try {
			const started = await startIntegrationChr({
				name: `centrs-mt-term-${Date.now()}`,
				networks: ["user", { type: "socket-connect", port: bridge.tcpPort }],
			});
			chr = started.chr;
			expect(await chr.waitForBoot(180_000)).toBe(true);
			expect(await bridge.waitForConnection(10_000)).toBe(true);

			await chr.exec("/tool/mac-server set allowed-interface-list=all");
			await chr.exec(
				`/user/add name=${MT_USER} password=${MT_PASSWORD} group=full`,
			);

			const eths = asRecordArray(await chr.rest("/interface/ethernet"));
			const ether2 =
				eths.find((e) => e["name"] === "ether2") ?? eths[eths.length - 1];
			const targetMac = ether2?.["mac-address"] as string;
			const identity = (asRecord(await chr.rest("/system/identity"))["name"] ??
				"") as string;

			// The UDP transport addresses the L2 bridge's loopback relay, which injects
			// to the guest and relays the device's replies back — exactly as the
			// execute / mac-telnet command-path test drives it.
			const base = [
				"terminal",
				targetMac,
				"--via",
				"mac-telnet",
				"--host",
				"127.0.0.1",
				"--port",
				String(bridge.udpPort),
				"--username",
				MT_USER,
				"--password",
				MT_PASSWORD,
			];

			// T1 — pipe a command in; the device's response appears on stdout.
			const t1 = await runCliProcess({
				args: base,
				stdin: "/system/identity/print\n",
			});
			expect(
				t1.exitCode,
				`terminal exit ${t1.exitCode}; stderr=${t1.stderrText}`,
			).toBe(0);
			expect(t1.stdoutText).toContain(identity);

			// T2 — rest-api has no terminal capability (short-circuits before connect).
			const t2 = await runCliProcess({
				args: [
					"terminal",
					targetMac,
					"--via",
					"rest-api",
					"--username",
					MT_USER,
					"--password",
					MT_PASSWORD,
					"--json",
				],
			});
			expect(t2.exitCode).toBe(1);
			expect(t2.stdout.length).toBe(0);
			expect(JSON.parse(t2.stderrText).error.code as string).toBe(
				"transport/capability-unsupported",
			);

			// T3 — native-api likewise has no terminal capability.
			const t3 = await runCliProcess({
				args: [
					"terminal",
					targetMac,
					"--via",
					"native-api",
					"--username",
					MT_USER,
					"--password",
					MT_PASSWORD,
					"--json",
				],
			});
			expect(t3.exitCode).toBe(1);
			expect(JSON.parse(t3.stderrText).error.code as string).toBe(
				"transport/capability-unsupported",
			);

			const resource = asRecord(await chr.rest("/system/resource"));
			await recordIntegrationEvidence({
				suite: "terminal over mac-telnet (interactive relay)",
				command: "terminal",
				protocol: "mac-telnet",
				routerosVersion: resource["version"] ?? chr.state.version,
				boardName: resource["board-name"],
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [1, 2, 3],
			});
		} finally {
			await chr?.destroy();
			await bridge.close();
		}
	}, 300_000);
});
