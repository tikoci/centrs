import { describe, expect, test } from "bun:test";
import { apiEnvelope } from "../../src/api.ts";
import {
	exampleIds,
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

interface SuccessEnvelope {
	ok: true;
	data: unknown;
	meta: {
		via: string;
		validation?: {
			source?: string;
			semantic?: boolean | string;
			enabled?: boolean;
		};
		operation?: { request?: { path?: string } };
	};
}

interface FailureEnvelope {
	ok: false;
	error: { code?: string; context?: Record<string, unknown> };
	meta: { via: string | null };
}

function expectApiSuccess(
	envelope: Awaited<ReturnType<typeof apiEnvelope>>,
	via: "rest-api" | "native-api",
): SuccessEnvelope {
	expect(envelope.ok).toBe(true);
	expect(envelope.meta.via).toBe(via);
	return envelope as SuccessEnvelope;
}

function expectApiFailure(
	envelope: Awaited<ReturnType<typeof apiEnvelope>>,
	code: string,
): FailureEnvelope {
	expect(envelope.ok).toBe(false);
	const failure = envelope as FailureEnvelope;
	expect(failure.error.code).toBe(code);
	return failure;
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

describeFast("api against CHR (rest-api)", () => {
	test("runs rest-api examples 1-20", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		try {
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			const base = {
				targetInput: chr.restUrl,
				via: "rest-api" as const,
				username: auth.username,
				password: auth.password,
			};

			// 1. GET a list.
			const list = expectApiSuccess(
				await apiEnvelope({ ...base, endpoint: "ip/address" }),
				"rest-api",
			);
			asArray(list.data);
			expect(list.meta.validation?.source).toContain("/console/inspect");
			expect(list.meta.operation?.request?.path).toBe("/ip/address");

			// 2. Endpoint-normalization variants resolve to the same path.
			for (const endpoint of [
				"/rest/ip/address",
				"rest/ip/address",
				"ip address",
			]) {
				const variant = expectApiSuccess(
					await apiEnvelope({ ...base, endpoint }),
					"rest-api",
				);
				expect(variant.meta.operation?.request?.path).toBe("/ip/address");
				asArray(variant.data);
			}

			// 3. GET a singleton → a single object.
			const resource = expectApiSuccess(
				await apiEnvelope({ ...base, endpoint: "system/resource" }),
				"rest-api",
			);
			expect(resource.data as Record<string, unknown>).toHaveProperty(
				"version",
			);
			expect(resource.data as Record<string, unknown>).toHaveProperty("uptime");

			// 4. PUT add (RouterOS create).
			const add = expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: "ip/address",
					method: "PUT",
					fields: {
						address: "198.51.100.10/32",
						interface: "ether1",
						comment: "centrs-api-rest",
					},
					yes: true,
				}),
				"rest-api",
			);
			const id = idOf(add.data);
			const afterAdd = asArray(
				expectApiSuccess(
					await apiEnvelope({ ...base, endpoint: "ip/address" }),
					"rest-api",
				).data,
			);
			expect(afterAdd.some((row) => row[".id"] === id)).toBe(true);

			// 5. PATCH set by id-in-path.
			expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: `ip/address/${id}`,
					method: "PATCH",
					fields: { comment: "centrs-api-rest-set" },
					yes: true,
				}),
				"rest-api",
			);
			const afterSet = expectApiSuccess(
				await apiEnvelope({ ...base, endpoint: `ip/address/${id}` }),
				"rest-api",
			);
			expect(afterSet.data as Record<string, unknown>).toMatchObject({
				comment: "centrs-api-rest-set",
			});

			// 6. DELETE remove by id-in-path.
			expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: `ip/address/${id}`,
					method: "DELETE",
					yes: true,
				}),
				"rest-api",
			);
			const afterDelete = asArray(
				expectApiSuccess(
					await apiEnvelope({ ...base, endpoint: "ip/address" }),
					"rest-api",
				).data,
			);
			expect(afterDelete.some((row) => row[".id"] === id)).toBe(false);

			// 7. Raw JSON body with -d.
			const dataAdd = expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: "ip/address",
					method: "PUT",
					data: '{"address":"198.51.100.11/32","interface":"ether1"}',
					yes: true,
				}),
				"rest-api",
			);
			const dataId = idOf(dataAdd.data);

			// 8. Body from "stdin" (inputBody, the orchestrator side of --input -).
			const inputAdd = expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: "ip/address",
					method: "PUT",
					inputBody: '{"address":"198.51.100.12/32","interface":"ether1"}',
					yes: true,
				}),
				"rest-api",
			);
			const inputId = idOf(inputAdd.data);

			// 9. Server-side filter with --query.
			const filtered = expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: "interface",
					query: ["type=ether"],
				}),
				"rest-api",
			);
			for (const row of asArray(filtered.data)) {
				expect(row["type"]).toBe("ether");
			}

			// 10. Projection with --proplist.
			const projected = expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: "ip/address",
					proplist: ["address", "interface"],
				}),
				"rest-api",
			);
			for (const row of asArray(projected.data)) {
				for (const key of Object.keys(row)) {
					expect(["address", "interface", ".id"]).toContain(key);
				}
			}

			// 11. Validation rejects an unknown attribute before the write.
			expectApiFailure(
				await apiEnvelope({
					...base,
					endpoint: "ip/address",
					method: "PUT",
					fields: {
						address: "198.51.100.13/32",
						interface: "ether1",
						"no-such-arg": "x",
					},
					yes: true,
				}),
				"validation/unknown-attribute",
			);

			// 12. Validation rejects an unknown path.
			expectApiFailure(
				await apiEnvelope({ ...base, endpoint: "ip/no-such-menu" }),
				"validation/unknown-path",
			);

			// 13. --raw success: ok with validation skipped (raw render is unit-tested).
			const raw = expectApiSuccess(
				await apiEnvelope({ ...base, endpoint: "ip/address", raw: true }),
				"rest-api",
			);
			expect(raw.meta.validation?.enabled).toBe(false);
			asArray(raw.data);

			// 14. --raw RouterOS error → ok:false, a RouterOS-mapped error code.
			const rawError = await apiEnvelope({
				...base,
				endpoint: "ip/address",
				method: "PUT",
				fields: { address: "not-an-ip", interface: "ether1" },
				raw: true,
				yes: true,
			});
			expect(rawError.ok).toBe(false);
			if (!rawError.ok) {
				expect(rawError.error.code.startsWith("routeros/")).toBe(true);
			}

			// 15. Mutating + non-TTY + no --yes is refused, and nothing is added.
			expectApiFailure(
				await apiEnvelope({
					...base,
					endpoint: "ip/address",
					method: "PUT",
					fields: { address: "198.51.100.14/32", interface: "ether1" },
					stdinIsTty: false,
				}),
				"usage/confirmation-required",
			);
			const afterRefused = asArray(
				expectApiSuccess(
					await apiEnvelope({ ...base, endpoint: "ip/address" }),
					"rest-api",
				).data,
			);
			expect(
				afterRefused.some((row) => row["address"] === "198.51.100.14/32"),
			).toBe(false);

			// 16. POST a console command via /rest/execute.
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
				"rest-api",
			);
			expect(JSON.stringify(script.data)).toContain(identity);
			expect(script.meta.validation?.semantic).toBe("not-applicable");

			// 17. --via rest-api --listen is rejected.
			expectApiFailure(
				await apiEnvelope({
					...base,
					endpoint: "ip/address",
					listen: true,
				}),
				"transport/capability-unsupported",
			);

			// 18. --query not-equal maps to a negated stack word.
			const ne = expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: "interface",
					query: ["type!=ether"],
				}),
				"rest-api",
			);
			for (const row of asArray(ne.data)) {
				expect(row["type"]).not.toBe("ether");
			}

			// 19. --raw-query expresses OR (union of ether + loopback).
			const union = expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: "interface",
					rawQuery: ["type=ether", "type=loopback", "#|"],
				}),
				"rest-api",
			);
			const unionTypes = new Set(
				asArray(union.data).map((row) => String(row["type"])),
			);
			for (const type of unionTypes) {
				expect(["ether", "loopback"]).toContain(type);
			}

			// 20. Bounded duration= command returns a .section array (POST, --yes).
			const monitor = expectApiSuccess(
				await apiEnvelope({
					...base,
					endpoint: "interface/monitor-traffic",
					method: "POST",
					fields: { interface: "ether1", duration: "2s" },
					yes: true,
				}),
				"rest-api",
			);
			const sections = asArray(monitor.data);
			expect(sections.length).toBeGreaterThan(0);
			// `.section` is a literal key, not a `toHaveProperty` dot-path.
			expect(Object.keys(sections[0] ?? {})).toContain(".section");

			// Clean up the rows added above.
			for (const cleanupId of [dataId, inputId]) {
				await apiEnvelope({
					...base,
					endpoint: `ip/address/${cleanupId}`,
					method: "DELETE",
					yes: true,
				});
			}

			await recordIntegrationEvidence({
				suite: "api against CHR (rest-api)",
				command: "api",
				protocol: "rest-api",
				routerosVersion: chr.state.version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(20),
			});
		} finally {
			await chr.destroy();
		}
	}, 180_000);
});
