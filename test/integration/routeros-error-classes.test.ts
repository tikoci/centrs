/**
 * R4 (#659): RouterOS's "no such …" answers split into two codes on real CHR.
 * A missing item in a known menu (native `no such item`, a bare REST 404,
 * `/execute`'s `no such item (4) (…; line 1)`) is `routeros/no-such-item`; a
 * path or verb RouterOS does not have (`no such command`, `… prefix`,
 * `… or directory (x)`) is `routeros/unknown-path`. Same code on both
 * transports. A script that prints before it fails returns the diagnostic as
 * its last line (`before\r\nno such item (4) (…; line 1)`), through both
 * `execute` and the `api` `/execute` script path (#665 review). Grounded on
 * CHR 7.25.1.
 */
import { describe, expect, test } from "bun:test";
import { apiEnvelope } from "../../src/api.ts";
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
		command: ":put before; /ip/address/set *FFFF comment=x",
		validate: true,
		code: "routeros/no-such-item",
	},
	{
		command: ":put before; /system/script/run nosuch",
		validate: true,
		code: "routeros/no-such-item",
	},
	{
		// `r4-bad` (added below) holds a verb `/system/identity` lacks, so
		// RouterOS prints `bad command name … (line 1 column 18)` after `before`.
		command: ":put before; /system/script/run r4-bad",
		validate: true,
		code: "routeros/unknown-path",
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
			const added = await executeEnvelope(
				{
					targetInput: chr.restUrl,
					via: "rest-api",
					...auth,
					command:
						'/system/script/add name=r4-bad source="/system/identity/nosuchverb"',
					yes: true,
					stdinIsTty: false,
				},
				{},
			);
			expect(added.ok).toBe(true);
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
				// The `api` `/execute` script path normalizes returned text the
				// same way.
				const script = await apiEnvelope({
					...base,
					endpoint: "execute",
					method: "POST",
					fields: { script: ":put before; /ip/address/set *FFFF comment=x" },
					yes: true,
				});
				expect(
					script.ok ? "ok" : script.error.code,
					`${via}: api execute`,
				).toBe("routeros/no-such-item");
				// A trailed parse rejection keeps the transport's catch-all code.
				const parsed = await executeEnvelope(
					{
						...base,
						command: ':put before; [:parse "/nosuch/thing"]',
						yes: true,
						stdinIsTty: false,
					},
					{},
				);
				expect(
					parsed.ok ? "ok" : parsed.error.code,
					`${via}: trailed syntax error`,
				).toBe(
					via === "rest-api" ? "routeros/request-failed" : "routeros/api-trap",
				);
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
