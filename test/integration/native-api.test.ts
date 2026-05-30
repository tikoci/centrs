import { describe, expect, test } from "bun:test";
import { CentrsError } from "../../src/errors.ts";
import {
	connectNativeApi,
	readAttribute,
} from "../../src/protocols/native-api.ts";
import {
	exampleIds,
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
} from "./chr.ts";

const runFastIntegration = isChrIntegrationEnabled();
const describeFast = runFastIntegration ? describe : describe.skip;

describeFast("native API against CHR", () => {
	test("logs in and runs /system/resource over the binary API", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		const auth = splitQuickChrAuth(
			readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
		);

		try {
			const { session } = await connectNativeApi({
				host: "127.0.0.1",
				port: chr.ports.api,
				username: auth.username,
				password: auth.password,
			});

			try {
				const replies = await session.talk({
					command: "/system/resource/print",
				});
				const record = replies.find((reply) => reply.type === "!re");
				expect(record).toBeDefined();
				const version = record ? readAttribute(record, "version") : undefined;
				expect(typeof version).toBe("string");
				expect(version?.length ?? 0).toBeGreaterThan(0);

				const projected = await session.talk({
					command: "/system/resource/print",
					proplist: ["version", "board-name"],
				});
				const projectedRecord = projected.find((reply) => reply.type === "!re");
				expect(projectedRecord).toBeDefined();
				expect(
					projectedRecord
						? readAttribute(projectedRecord, "version")
						: undefined,
				).toBe(version);

				const boardName = projectedRecord
					? readAttribute(projectedRecord, "board-name")
					: undefined;

				await recordIntegrationEvidence({
					suite: "native API against CHR",
					command: "retrieve",
					protocol: "native-api",
					routerosVersion:
						typeof version === "string" ? version : chr.state.version,
					boardName,
					quickChrName: chr.name,
					requestedChannel: started.requestedChannel,
					requestedVersion: started.requestedVersion,
					exampleIds: exampleIds(2),
				});
			} finally {
				session.close();
			}
		} finally {
			await chr.destroy();
		}
	}, 300_000);

	test("maps bad credentials to transport/auth-failed", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;

		try {
			const attempt = connectNativeApi({
				host: "127.0.0.1",
				port: chr.ports.api,
				username: "definitely-wrong",
				password: "definitely-wrong",
			});
			await expect(attempt).rejects.toBeInstanceOf(CentrsError);
			await attempt.catch((error: unknown) => {
				expect((error as CentrsError).code).toBe("transport/auth-failed");
			});
		} finally {
			await chr.destroy();
		}
	}, 300_000);
});
