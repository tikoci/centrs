import { describe, expect, test } from "bun:test";
import { executeEnvelope } from "../../src/execute.ts";
import { resolveMcpConfig } from "../../src/mcp/config.ts";
import { handleExecute } from "../../src/mcp/tools.ts";
import { retrieve } from "../../src/retrieve.ts";
import { makeMcpTestCdb } from "../unit/mcp-cdb-fixture.ts";
import {
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

describeFast("output-file write gates against CHR", () => {
	// Export follows the selected channel, including long-term. The serialize
	// file-output control is pinned to the build on which it was reproduced;
	// this is evidence on one version, not a claimed introduction boundary.
	for (const kind of ["export", "serialize"] as const) {
		test(`${kind}: an argument prefix cannot bypass confirmation or mcp=ro (W5)`, async () => {
			const started = await startIntegrationChr(
				kind === "serialize" ? { version: "7.26beta1" } : {},
			);
			const { chr } = started;
			let cleanupCdb: (() => Promise<void>) | undefined;
			try {
				const auth = splitQuickChrAuth(
					readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
				);
				const note = await retrieve(
					{ targetInput: chr.restUrl, path: "/system/note", ...auth },
					{},
				);
				expect(note.ok).toBe(true);
				expect((note.data as { note?: string }).note).toBe("");
				const cdb = await makeMcpTestCdb([
					{
						target: chr.restUrl,
						user: auth.username,
						password: auth.password,
						comment: "mcp=ro",
					},
				]);
				cleanupCdb = cdb.cleanup;
				const config = resolveMcpConfig({ cdbFile: cdb.path, env: {} });
				for (const via of ["rest-api", "native-api"] as const) {
					const base = {
						targetInput: via === "rest-api" ? chr.restUrl : "127.0.0.1",
						via,
						...(via === "native-api" ? { port: chr.ports.api } : {}),
						...auth,
					};
					for (const separator of ["=", " "]) {
						const name = `centrs-w5-${kind}-${via}-${separator === "=" ? "equals" : "space"}`;
						const fileName =
							kind === "serialize" ? `${name}.json` : `${name}.rsc`;
						const command =
							kind === "serialize"
								? `:serialize to=json value=1 file-n${separator}"${fileName}"`
								: `/system identity export fi${separator}"${name}"`;
						const refused = await executeEnvelope(
							{ ...base, command, stdinIsTty: false },
							{},
						);
						expect(refused.ok ? undefined : refused.error.code).toBe(
							"usage/confirmation-required",
						);
						for (const confirm of [undefined, true]) {
							const denied = await handleExecute(
								{ target: chr.restUrl, command, via, confirm },
								config,
							);
							expect(denied.ok ? undefined : denied.error.code).toBe(
								"cdb/write-not-permitted",
							);
						}
						const before = await retrieve({ ...base, path: "/file" }, {});
						expect(before.ok).toBe(true);
						expect(Array.isArray(before.data)).toBe(true);
						expect(
							(before.data as { name?: string }[]).some(
								(row) => row.name === fileName,
							),
						).toBe(false);

						// The exact same command is accepted by the device with --yes.
						// This keeps a parser rejection from masquerading as a safe gate.
						const confirmed = await executeEnvelope(
							{ ...base, command, yes: true },
							{},
						);
						expect(confirmed).toMatchObject({
							ok: true,
							meta: { validation: { result: "passed" } },
						});
						const after = await retrieve({ ...base, path: "/file" }, {});
						expect(after.ok).toBe(true);
						expect(
							(after.data as { name?: string }[]).some(
								(row) => row.name === fileName,
							),
						).toBe(true);
					}
				}
				await recordIntegrationEvidence({
					suite: `output-file write gates (${kind})`,
					command: "execute / centrs_execute",
					protocol: "rest-api+native-api",
					routerosVersion: chr.state.version,
					quickChrName: chr.name,
					...(kind === "serialize"
						? { requestedVersion: "7.26beta1" }
						: {
								requestedChannel: started.requestedChannel,
								requestedVersion: started.requestedVersion,
							}),
					exampleIds: ["W5"],
				});
			} finally {
				try {
					await cleanupCdb?.();
				} finally {
					await chr.destroy();
				}
			}
		}, 120_000);
	}
});
