import { describe, expect, test } from "bun:test";
import { apiEnvelope } from "../../src/api.ts";
import {
	exampleIds,
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
	withBootReadyRetry,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

interface SuccessEnvelope {
	ok: true;
	data: unknown;
	meta: {
		via: string;
		validation?: { semantic?: boolean | string; enabled?: boolean };
	};
}

interface FailureEnvelope {
	ok: false;
	error: { code?: string };
}

function expectApiSuccess(
	envelope: Awaited<ReturnType<typeof apiEnvelope>>,
): SuccessEnvelope {
	expect(envelope.ok).toBe(true);
	expect(envelope.meta.via).toBe("native-api");
	return envelope as SuccessEnvelope;
}

function expectApiFailure(
	envelope: Awaited<ReturnType<typeof apiEnvelope>>,
	code: string,
): FailureEnvelope {
	expect(envelope.ok).toBe(false);
	expect((envelope as FailureEnvelope).error.code).toBe(code);
	return envelope as FailureEnvelope;
}

function asArray(data: unknown): Record<string, unknown>[] {
	expect(Array.isArray(data)).toBe(true);
	return data as Record<string, unknown>[];
}

function idOf(data: unknown): string {
	expect(typeof data).toBe("object");
	const id = (data as Record<string, unknown>)[".id"];
	expect(id).toMatch(/^\*[0-9A-F]+$/i);
	return String(id);
}

describeFast("api against CHR (native-api)", () => {
	test("runs native-api examples N1-N8", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		try {
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			const base = {
				targetInput: "127.0.0.1",
				via: "native-api" as const,
				port: chr.ports.api,
				username: auth.username,
				password: auth.password,
			};

			// N1. GET a list (string values). Retry the first connect against a
			// just-booted CHR whose api service may still be coming up.
			const list = expectApiSuccess(
				await withBootReadyRetry(() =>
					apiEnvelope({ ...base, endpoint: "interface", method: "GET" }),
				),
			);
			expect(asArray(list.data).length).toBeGreaterThan(0);

			// N2. PUT add (returns .id).
			const add = expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: "ip/address",
					method: "PUT",
					fields: { address: "198.51.100.20/32", interface: "ether1" },
					yes: true,
				}),
			);
			const id = idOf(add.data);

			// N3. PATCH set by id (id → =.id= word).
			expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: `ip/address/${id}`,
					method: "PATCH",
					fields: { comment: "centrs-api-native-set" },
					yes: true,
				}),
			);
			const afterSet = expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: `ip/address/${id}`,
					method: "GET",
				}),
			);
			expect(afterSet.data as Record<string, unknown>).toMatchObject({
				comment: "centrs-api-native-set",
			});

			// N5. GET one by id (→ print ?.id=) is a single object with that id.
			expect((afterSet.data as Record<string, unknown>)[".id"]).toBe(id);

			// N4. DELETE remove by id (id → =.id= word).
			expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: `ip/address/${id}`,
					method: "DELETE",
					yes: true,
				}),
			);
			const afterDelete = asArray(
				expectApiSuccess(
					await apiEnvelope({ ...base, endpoint: "ip/address", method: "GET" }),
				).data,
			);
			expect(afterDelete.some((row) => row[".id"] === id)).toBe(false);

			// N6. Validation rejects an unknown attribute over native (inspect gate,
			// not a native !trap).
			expectApiFailure(
				await apiEnvelope({
					...base,
					endpoint: "ip/address",
					method: "PUT",
					fields: {
						address: "198.51.100.21/32",
						interface: "ether1",
						"no-such-arg": "x",
					},
					yes: true,
				}),
				"validation/unknown-attribute",
			);

			// N7. --raw over native → bare rest-style array, validation skipped.
			const raw = expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: "interface",
					method: "GET",
					raw: true,
				}),
			);
			expect(raw.meta.validation?.enabled).toBe(false);
			asArray(raw.data);

			// N8. POST a console command via native /execute.
			const identity =
				((await chr.rest("/system/identity")) as Record<string, string>)[
					"name"
				] ?? "";
			expect(identity.length).toBeGreaterThan(0);
			const script = expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: "execute",
					method: "POST",
					fields: { script: ":put [/system/identity/get name]" },
					yes: true,
				}),
			);
			expect(JSON.stringify(script.data)).toContain(identity);
			expect(script.meta.validation?.semantic).toBe("not-applicable");

			await recordIntegrationEvidence({
				suite: "api against CHR (native-api)",
				command: "api",
				protocol: "native-api",
				routerosVersion: chr.state.version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(8),
			});
		} finally {
			await chr.destroy();
		}
	}, 180_000);
});
