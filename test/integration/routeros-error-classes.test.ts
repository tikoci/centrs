/**
 * R4 (#659): RouterOS's "no such …" answers split into two codes on real CHR.
 * A missing item in a known menu (native `no such item`, a bare REST 404,
 * `/execute`'s `no such item (4) (…; line 1)`) is `routeros/no-such-item`; a
 * path or verb RouterOS does not have (`no such command`, `… prefix`,
 * `… or directory (x)`) is `routeros/unknown-path`. Same code on both
 * transports. Grounded on CHR 7.25.1.
 */
import { describe, expect, test } from "bun:test";
import { executeEnvelope } from "../../src/execute.ts";
import {
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

const cases = [
	{
		command: "/system/script/run number=nosuch",
		validate: true,
		code: "routeros/no-such-item",
	},
	{
		command: "/ip/address/remove numbers=*FFFF",
		validate: true,
		code: "routeros/no-such-item",
	},
	{
		command: "/ip/address/set *FFFF comment=x",
		validate: true,
		code: "routeros/no-such-item",
	},
	{
		command: "/system/script/nosuch",
		validate: false,
		code: "routeros/unknown-path",
	},
	{
		command: "/nosuch/thing/print",
		validate: false,
		code: "routeros/unknown-path",
	},
] as const;

describeFast("no such item vs unknown path against CHR (R4, #659)", () => {
	test("each RouterOS 'no such …' answer gets one code on both transports", async () => {
		const started = await startIntegrationChr({}, { reuse: true });
		const { chr } = started;
		try {
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			for (const via of ["rest-api", "native-api"] as const) {
				const base = {
					targetInput: via === "rest-api" ? chr.restUrl : "127.0.0.1",
					via,
					...(via === "native-api" ? { port: chr.ports.api } : {}),
					...auth,
				};
				for (const { command, validate, code } of cases) {
					const envelope = await executeEnvelope(
						{ ...base, command, validate, yes: true, stdinIsTty: false },
						{},
					);
					expect(
						envelope.ok ? "ok" : envelope.error.code,
						`${via}: ${command}`,
					).toBe(code);
				}
			}
			await recordIntegrationEvidence({
				suite: "no such item vs unknown path (R4)",
				command: "execute",
				protocol: "rest-api+native-api",
				routerosVersion: chr.state.version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: ["R4"],
			});
		} finally {
			await chr.destroy();
		}
	}, 120_000);
});
