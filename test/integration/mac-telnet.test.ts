/**
 * MAC-Telnet against a real CHR, over a real layer-2 path.
 *
 * MAC-Telnet (UDP/20561) is a stateful, bidirectional L2 session; a `user`/SLIRP
 * CHR cannot deliver L2 to the host, so — like the MNDP test — the harness gives
 * the CHR a `socket-connect` NIC and {@link startMacTelnetL2Bridge} relays
 * UDP/20561 both ways: guest frames are lifted to the *unmodified*
 * `MacTelnetSession`, and the session's datagrams are injected back into the
 * guest. See `commands/execute/README.md` (mac-telnet L2 validation) and the
 * sibling `mndp-l2-bridge.ts`.
 *
 * This proves the client login on stock RouterOS 7.23 end to end at the
 * **protocol** level:
 *
 *   1. MTWEI (EC-SRP) — the default and the only method current RouterOS
 *      accepts. The session advertises a public key, the device replies with a
 *      49-byte salt, the `mtwei.ts` engine computes the 32-byte proof, and the
 *      login reaches the interactive console (onReady) with the device's own
 *      terminal output flowing back. Credentials are independently confirmed
 *      valid over REST, so a MAC-Telnet failure would be about the auth method,
 *      not the password.
 *   2. MD5 refusal — with MTWEI disabled, the same valid credentials are rejected
 *      by the device (it offers a 16-byte salt but refuses the proof), surfaced
 *      as `transport/auth-failed`. This validates the auth-failure detection
 *      (END_AUTH ≠ success) on the real wire.
 *
 * Out of scope here (it is the `terminal`/`execute`-over-mac-telnet *command*
 * layer, Phase 1): full interactive-console emulation — the RouterOS console
 * opens with a terminal-identification query and renders a readline prompt, so
 * capturing clean command output requires answering those queries and parsing
 * the echo. The transport, auth, and bidirectional data path are what this
 * proves.
 */

import { describe, expect, test } from "bun:test";
import {
	formatMac,
	type MacTelnetDatagramSink,
	MacTelnetSession,
	parseMac,
} from "../../src/protocols/mac-telnet.ts";
import {
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
	startIntegrationChr,
} from "./chr.ts";
import { HOST_MAC, startMacTelnetL2Bridge } from "./mactelnet-l2-bridge.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

const IDENTITY = "centrs-mactelnet";
const MT_USER = "mt";
const MT_PASSWORD = "mt-secret";

function asRecord(value: unknown): Record<string, string> {
	return (value ?? {}) as Record<string, string>;
}

function asRecordArray(value: unknown): Record<string, string>[] {
	return Array.isArray(value) ? (value as Record<string, string>[]) : [];
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await Bun.sleep(150);
	}
	return predicate();
}

interface SessionHandle {
	session: MacTelnetSession;
	output: Uint8Array[];
	state: { ready: boolean; closed: boolean; closeCode?: string };
}

/** Wire a MacTelnetSession to the L2 bridge and track its state. */
function attach(
	bridge: Awaited<ReturnType<typeof startMacTelnetL2Bridge>>,
	dst: ReturnType<typeof parseMac>,
	offerMtwei: boolean,
): SessionHandle {
	const output: Uint8Array[] = [];
	const state: SessionHandle["state"] = { ready: false, closed: false };
	const sink: MacTelnetDatagramSink = {
		send: (bytes) => bridge.inject(bytes),
		close: () => {},
	};
	const session = new MacTelnetSession({
		sink,
		sourceMac: HOST_MAC,
		destinationMac: dst,
		username: MT_USER,
		password: MT_PASSWORD,
		offerMtwei,
		onReady: () => {
			state.ready = true;
		},
		onData: (bytes) => output.push(bytes),
		onClose: (error) => {
			state.closed = true;
			state.closeCode = error?.code;
		},
	});
	bridge.onPacket((payload) => session.handlePacket(new Uint8Array(payload)));
	return { session, output, state };
}

describeFast("mac-telnet against CHR (socket-connect L2)", () => {
	test("MTWEI login reaches the console end to end; MD5 is refused", async () => {
		const bridge = await startMacTelnetL2Bridge();

		let chr: Awaited<ReturnType<typeof startIntegrationChr>>["chr"] | undefined;
		try {
			const started = await startIntegrationChr({
				name: `centrs-mactelnet-${Date.now()}`,
				networks: ["user", { type: "socket-connect", port: bridge.tcpPort }],
			});
			chr = started.chr;
			expect(await chr.waitForBoot(180_000)).toBe(true);
			expect(await bridge.waitForConnection(10_000)).toBe(true);

			await chr.exec(`/system/identity/set name=${IDENTITY}`);
			await chr.exec("/tool/mac-server set allowed-interface-list=all");
			// A full-access user with a real password (admin's is blank, which
			// RouterOS refuses on interactive logins).
			await chr.exec(
				`/user/add name=${MT_USER} password=${MT_PASSWORD} group=full`,
			);

			// Target ether2 (the socket-connect NIC): the device matches the
			// in-packet destination MAC against its receiving interface MAC.
			const eths = asRecordArray(await chr.rest("/interface/ethernet"));
			const ether2 =
				eths.find((e) => e["name"] === "ether2") ?? eths[eths.length - 1];
			const targetMac = ether2?.["mac-address"];
			expect(
				targetMac,
				`no ether2 MAC in ${JSON.stringify(eths)}`,
			).toBeTruthy();
			const dst = parseMac(targetMac as string);

			// Credentials are valid (proven over REST) — so a MAC-Telnet failure is
			// about the auth method, not the password.
			const restLogin = await fetch(`${chr.restUrl}/rest/system/identity`, {
				headers: {
					Authorization: `Basic ${Buffer.from(`${MT_USER}:${MT_PASSWORD}`).toString("base64")}`,
				},
			});
			expect(restLogin.status, "mt credentials should be valid over REST").toBe(
				200,
			);

			// ── 1. MTWEI happy path: auth → ready → terminal data both ways ──────
			const mtwei = attach(bridge, dst, true);
			mtwei.session.start();
			expect(
				await waitFor(() => mtwei.state.ready || mtwei.state.closed, 20_000),
			).toBe(true);
			// The headline result: the EC-SRP proof was accepted and the console
			// session opened.
			expect(
				mtwei.state.ready,
				`MTWEI login did not reach ready (closeCode=${mtwei.state.closeCode ?? "-"})`,
			).toBe(true);

			// Server → client: the device pushes console output after login.
			await Bun.sleep(1_500);
			expect(
				mtwei.output.reduce((n, c) => n + c.length, 0),
				"no terminal output after MTWEI login",
			).toBeGreaterThan(0);

			// Client → server: a keystroke is accepted and the session stays up
			// (the transport carries input as well as output).
			mtwei.session.sendInput(new TextEncoder().encode("\r"));
			await Bun.sleep(800);
			expect(mtwei.state.closed, "session dropped after sending input").toBe(
				false,
			);

			mtwei.session.end();
			expect(await waitFor(() => mtwei.state.closed, 3_000)).toBe(true);

			// ── 2. Classic MD5 is refused on the real device ────────────────────
			await Bun.sleep(300);
			const md5 = attach(bridge, dst, false);
			md5.session.start();
			expect(await waitFor(() => md5.state.closed, 15_000)).toBe(true);
			expect(md5.state.ready).toBe(false);
			expect(md5.state.closeCode).toBe("transport/auth-failed");

			const resource = asRecord(await chr.rest("/system/resource"));
			console.log(
				`  MAC-Telnet: target=${formatMac(dst)} routeros=${resource["version"]} ` +
					`mtweiReady=${mtwei.state.ready} bytesIn=${mtwei.output.reduce((n, c) => n + c.length, 0)} ` +
					`md5CloseCode=${md5.state.closeCode}`,
			);
			await recordIntegrationEvidence({
				suite: "mac-telnet against CHR (socket-connect L2)",
				command: "execute",
				protocol: "mac-telnet",
				routerosVersion: resource["version"] ?? chr.state.version,
				boardName: resource["board-name"],
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [],
			});
		} finally {
			await chr?.destroy();
			await bridge.close();
		}
	}, 300_000);
});
