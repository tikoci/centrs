import { describe, expect, test } from "bun:test";
import { executeEnvelope } from "../../src/execute.ts";
import { retrieveEnvelope } from "../../src/retrieve.ts";
import {
	isChrIntegrationEnabled,
	REST_API_WITHOUT_API_POLICY_SINCE,
	recordIntegrationEvidence,
	routerOsAtLeast,
	startIntegrationChr,
} from "./chr.ts";

/**
 * A RouterOS policy refusal is a router answer, not a dropped connection.
 *
 * RouterOS REST reports a refused policy as HTTP 500 with a `(9)` detail, the
 * same status a transient drop uses. centrs used to call it
 * `transport/connection-closed` ("retry the request") and, for a write,
 * `write-outcome-unknown`. Controls, each user with validation on:
 *
 * - P1 `read,api,rest-api`, REST `set`: `routeros/permission-denied`, no
 *   outcome-unknown warning, and the identity is unchanged.
 * - P2 the same user over native-api: the same code from the `!trap`.
 * - P3 `read,rest-api` without `api`, REST GET: `routeros/permission-denied`
 *   (`std failure: not allowed (9)`) before `REST_API_WITHOUT_API_POLICY_SINCE`,
 *   and a normal read from that build on.
 * - P4 the P1 user with a wrong password: RouterOS's own JSON 401 stays
 *   `transport/auth-failed`, not `transport/edge-auth-failed`.
 * - C1 `read,write,api,rest-api`, REST `set`: succeeds, so P1's refusal is the
 *   missing policy and not the command.
 */

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

const PASSWORD = `Perm-${crypto.randomUUID().slice(0, 8)}`;

describeFast("REST permission refusals (routeros/permission-denied)", () => {
	test("policy refusals map to routeros/permission-denied on both transports", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		try {
			expect(await chr.waitForBoot(180_000)).toBe(true);
			const users = {
				ro: ["centrs-perm-ro", "read,api,rest-api"],
				noApi: ["centrs-perm-no-api", "read,rest-api"],
				rw: ["centrs-perm-rw", "read,write,api,rest-api"],
			} as const;
			for (const [name, policy] of Object.values(users)) {
				await chr.exec(`/user group add name=${name} policy=${policy}`);
				await chr.exec(
					`/user add name=${name} group=${name} password="${PASSWORD}"`,
				);
			}
			const rest = (username: string, password = PASSWORD) => ({
				targetInput: chr.restUrl,
				via: "rest-api" as const,
				username,
				password,
			});
			const identity = async () =>
				((await chr.rest("/system/identity")) as Record<string, string>)[
					"name"
				];
			const before = await identity();

			const p1 = await executeEnvelope({
				...rest(users.ro[0]),
				command: "/system/identity/set name=centrs-perm-p1",
				yes: true,
			});
			expect(p1.ok).toBe(false);
			if (!p1.ok) expect(p1.error.code).toBe("routeros/permission-denied");
			expect(p1.warnings.map((warning) => warning.code)).not.toContain(
				"transport/write-outcome-unknown",
			);
			expect(await identity()).toBe(before);

			const p2 = await executeEnvelope({
				targetInput: "127.0.0.1",
				port: chr.ports.api,
				via: "native-api",
				username: users.ro[0],
				password: PASSWORD,
				command: "/system/identity/set name=centrs-perm-p2",
				yes: true,
			});
			expect(p2.ok).toBe(false);
			if (!p2.ok) expect(p2.error.code).toBe("routeros/permission-denied");

			const p3 = await retrieveEnvelope(
				{ ...rest(users.noApi[0]), path: "/system/resource" },
				{},
			);
			if (
				routerOsAtLeast(chr.state.version, REST_API_WITHOUT_API_POLICY_SINCE)
			) {
				expect(p3.ok).toBe(true);
			} else {
				expect(p3.ok).toBe(false);
				if (!p3.ok) expect(p3.error.code).toBe("routeros/permission-denied");
			}

			const p4 = await retrieveEnvelope(
				{ ...rest(users.ro[0], "centrs-wrong"), path: "/system/resource" },
				{},
			);
			expect(p4.ok).toBe(false);
			if (!p4.ok) expect(p4.error.code).toBe("transport/auth-failed");

			const c1 = await executeEnvelope({
				...rest(users.rw[0]),
				command: "/system/identity/set name=centrs-perm-c1",
				yes: true,
			});
			expect(c1.ok).toBe(true);
			expect(await identity()).toBe("centrs-perm-c1");

			const resource = (await chr.rest("/system/resource")) as Record<
				string,
				string
			>;
			await recordIntegrationEvidence({
				suite: "REST permission refusals",
				command: "execute",
				protocol: "rest-api",
				routerosVersion: resource["version"] ?? chr.state.version,
				boardName: resource["board-name"],
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: ["P1", "P2", "P3", "P4", "C1"],
			});
		} finally {
			await chr.destroy();
		}
	}, 300_000);
});
