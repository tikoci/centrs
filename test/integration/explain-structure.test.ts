import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { executeEnvelope } from "../../src/execute.ts";
import fixture from "../fixtures/explain/statement-ownership.json";
import {
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

describeFast("explain statement ownership against CHR", () => {
	test("examples 46-47: syntactic bodies parse; stored creation defers execution", async () => {
		const started = await startIntegrationChr();
		try {
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			for (const row of fixture.rows) {
				expect(createHash("sha256").update(row.command).digest("hex")).toBe(
					row.sha256,
				);
				const result = await executeEnvelope({
					targetInput: started.chr.restUrl,
					via: "rest-api",
					username: auth.username,
					password: auth.password,
					command: row.command,
					yes: true,
				});
				expect(result.ok).toBe(true);
				if (!result.ok) throw new Error(result.error.summary);
				expect(result.meta.validation?.result).toBe("passed");
				expect((result.data as { ret: string }).ret).toBe(row.ret);
			}
			await recordIntegrationEvidence({
				suite: "explain statement ownership against CHR",
				command: "explain",
				protocol: "rest-api (:parse and stored-script execution controls)",
				routerosVersion: started.chr.state.version,
				quickChrName: started.chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [46, 47],
			});
		} finally {
			await started.chr.destroy();
		}
	}, 180_000);
});
