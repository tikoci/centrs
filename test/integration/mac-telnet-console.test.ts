/**
 * `execute` over MAC-Telnet — console reader **and** full command path — against
 * a real CHR over a real L2 path.
 *
 * The transport/auth base (MTWEI login, MD5 refusal) is proven in
 * `mac-telnet.test.ts`. This proves the pieces that make mac-telnet an *execute*
 * surface, in one CHR boot:
 *
 *   A. {@link MacTelnetConsole} directly (callback sink): login + terminal-probe
 *      negotiation + license clear + prompt sync, clean command output, and the
 *      `:parse` validation gate.
 *   B. the **product command path** — `executeEnvelope()` over the resolver →
 *      `MacTelnetAdapter` → `createUdpMacTelnetTransport` (a real UDP socket) —
 *      with the bridge's UDP relay standing in for the L2 segment. This is the
 *      `commands/execute/examples.md` mac-telnet evidence (examples 19–21).
 *
 * All grounded on stock CHR 7.23.1 (see `mac-telnet-console.ts` and
 * `commands/execute/README.md`). REST is the source of truth for cross-checks.
 */

import { describe, expect, test } from "bun:test";
import type { CentrsError } from "../../src/errors.ts";
import { executeEnvelope } from "../../src/execute.ts";
import { parseMac } from "../../src/protocols/mac-telnet.ts";
import { MacTelnetConsole } from "../../src/protocols/mac-telnet-console.ts";
import {
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";
import { HOST_MAC, startMacTelnetL2Bridge } from "./mactelnet-l2-bridge.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

const MT_USER = "mt";
const MT_PASSWORD = "mt-secret";

function asRecord(value: unknown): Record<string, string> {
	return (value ?? {}) as Record<string, string>;
}
function asRecordArray(value: unknown): Record<string, string>[] {
	return Array.isArray(value) ? (value as Record<string, string>[]) : [];
}
function retOf(data: unknown): string {
	return asRecord(data)["ret"] ?? "";
}

describeFast("execute over mac-telnet (console reader + command path)", () => {
	test("console reader + executeEnvelope run/write/validate over real L2", async () => {
		const bridge = await startMacTelnetL2Bridge();
		let chr: Awaited<ReturnType<typeof startIntegrationChr>>["chr"] | undefined;
		let cons: MacTelnetConsole | undefined;
		try {
			const started = await startIntegrationChr({
				name: `centrs-mt-exec-${Date.now()}`,
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
			const dst = parseMac(targetMac);
			const identityRest = asRecord(await chr.rest("/system/identity"))["name"];

			// ── A. console reader directly (callback sink) ──────────────────────
			cons = new MacTelnetConsole({
				sink: { send: (b) => bridge.inject(b), close: () => {} },
				sourceMac: HOST_MAC,
				destinationMac: dst,
				username: MT_USER,
				password: MT_PASSWORD,
			});
			bridge.onPacket((p) => cons?.handlePacket(new Uint8Array(p)));

			const primeStart = Date.now();
			await cons.open();
			const primeMs = Date.now() - primeStart;
			expect(cons.isReady).toBe(true);

			expect((await cons.run("/system/identity/print")).output).toContain(
				identityRest ?? "",
			);
			const validCli =
				"/ip/address/add address=198.51.100.30/32 interface=ether1";
			await cons.parseGate(validCli); // valid → no throw
			let parseErr: unknown;
			try {
				await cons.parseGate(`${validCli} no-such-arg=x`);
			} catch (error) {
				parseErr = error;
			}
			expect((parseErr as CentrsError)?.code).toBe(
				"validation/unknown-attribute",
			);
			cons.close();
			cons = undefined;
			// Detach the (now closed) console from the bridge; section B drives the
			// device over the UDP relay instead.
			bridge.onPacket(() => {});

			// ── B. product command path: executeEnvelope over the UDP transport ──
			const base = {
				targetInput: targetMac,
				via: "mac-telnet" as const,
				host: "127.0.0.1",
				port: bridge.udpPort,
				username: MT_USER,
				password: MT_PASSWORD,
			};

			// 19 — read a command, clean output, cross-checked against REST.
			const read = await executeEnvelope({
				...base,
				command: "/system/identity/print",
			});
			expect(read.ok, read.ok ? "" : JSON.stringify(read.error)).toBe(true);
			if (!read.ok) return;
			expect(read.meta.via).toBe("mac-telnet");
			expect(retOf(read.data)).toContain(identityRest ?? "");

			// 20 — write (add) with --yes; success prints nothing; verify via REST.
			const write = await executeEnvelope({
				...base,
				command: "/ip/address/add address=198.51.100.40/32 interface=ether1",
				yes: true,
			});
			expect(write.ok, write.ok ? "" : JSON.stringify(write.error)).toBe(true);
			if (!write.ok) return;
			const addresses = asRecordArray(await chr.rest("/ip/address"));
			expect(
				addresses.some((a) => (a["address"] ?? "").startsWith("198.51.100.40")),
				"address added over mac-telnet command path missing from REST",
			).toBe(true);

			// 21 — validation rejects an unknown attribute via the console :parse gate.
			const reject = await executeEnvelope({
				...base,
				command:
					"/ip/address/add address=198.51.100.41/32 interface=ether1 no-such-arg=x",
				yes: true,
			});
			expect(reject.ok).toBe(false);
			if (reject.ok) return;
			expect(reject.error.code).toBe("validation/unknown-attribute");
			// The rejected address must NOT have been written.
			const after = asRecordArray(await chr.rest("/ip/address"));
			expect(
				after.some((a) => (a["address"] ?? "").startsWith("198.51.100.41")),
			).toBe(false);

			const resource = asRecord(await chr.rest("/system/resource"));
			console.log(
				`  mac-telnet execute: routeros=${resource["version"]} primeMs=${primeMs} ` +
					`identity="${(identityRest ?? "").trim()}" added=198.51.100.40`,
			);
			await recordIntegrationEvidence({
				suite: "execute over mac-telnet (console reader + command path)",
				command: "execute",
				protocol: "mac-telnet",
				routerosVersion: resource["version"] ?? chr.state.version,
				boardName: resource["board-name"],
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [19, 20, 21],
			});
		} finally {
			cons?.close();
			await chr?.destroy();
			await bridge.close();
		}
	}, 300_000);
});
