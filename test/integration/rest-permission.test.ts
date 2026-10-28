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
 * - P5 the P1 user, REST multi-statement `:put "p5-first";
 *   /system/identity/set …`: HTTP 200 whose `ret` ends in the refusal, so
 *   `routeros/permission-denied` plus `transport/write-outcome-unknown`
 *   (#549). The `:put` output in the summary proves the first statement ran;
 *   the identity is unchanged, so the refused write did not.
 * - P6 the P5 script over native-api: the same code and warning.
 * - P7 the P5 pair nested in one `:if (true) do={ … }` statement over REST:
 *   the first statement still runs before the refused write, so the same code
 *   and warning. A single nested statement would stay silent.
 * - P8 the P7 script over native-api: the same code and warning.
 * - P9 the P5 pair inside one command substitution, `:put [:put "p9-first";
 *   /system/identity/set …]`, over REST: the substitution's first statement
 *   runs before the refused write, so the same code and warning.
 * - P10 the P9 script over native-api: the same code and warning.
 * - P11 a lone refused write wrapped in a menu block,
 *   `/system/identity { set … }`, over REST: the prefix only navigates, so
 *   the dispatch counts one statement and stays silent like P1.
 * - P12 the P11 script over native-api: the same code and silence.
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

			const script =
				':put "p5-first"; /system/identity/set name=centrs-perm-p5';
			const p5 = await executeEnvelope({
				...rest(users.ro[0]),
				command: script,
				yes: true,
			});
			expect(p5.ok).toBe(false);
			if (!p5.ok) {
				expect(p5.error.code).toBe("routeros/permission-denied");
				expect(p5.error.summary).toContain("p5-first");
			}
			expect(p5.warnings.map((warning) => warning.code)).toContain(
				"transport/write-outcome-unknown",
			);
			expect(await identity()).toBe(before);

			const p6 = await executeEnvelope({
				targetInput: "127.0.0.1",
				port: chr.ports.api,
				via: "native-api",
				username: users.ro[0],
				password: PASSWORD,
				command: script,
				yes: true,
			});
			expect(p6.ok).toBe(false);
			if (!p6.ok) {
				expect(p6.error.code).toBe("routeros/permission-denied");
				expect(p6.error.summary).toContain("p5-first");
			}
			expect(p6.warnings.map((warning) => warning.code)).toContain(
				"transport/write-outcome-unknown",
			);
			expect(await identity()).toBe(before);

			const nested =
				':if (true) do={ :put "p7-first"; /system/identity/set name=centrs-perm-p7 }';
			const p7 = await executeEnvelope({
				...rest(users.ro[0]),
				command: nested,
				yes: true,
			});
			expect(p7.ok).toBe(false);
			if (!p7.ok) {
				expect(p7.error.code).toBe("routeros/permission-denied");
				expect(p7.error.summary).toContain("p7-first");
			}
			expect(p7.warnings.map((warning) => warning.code)).toContain(
				"transport/write-outcome-unknown",
			);
			expect(await identity()).toBe(before);

			const p8 = await executeEnvelope({
				targetInput: "127.0.0.1",
				port: chr.ports.api,
				via: "native-api",
				username: users.ro[0],
				password: PASSWORD,
				command: nested,
				yes: true,
			});
			expect(p8.ok).toBe(false);
			if (!p8.ok) {
				expect(p8.error.code).toBe("routeros/permission-denied");
				expect(p8.error.summary).toContain("p7-first");
			}
			expect(p8.warnings.map((warning) => warning.code)).toContain(
				"transport/write-outcome-unknown",
			);
			expect(await identity()).toBe(before);

			const substituted =
				':put [:put "p9-first"; /system/identity/set name=centrs-perm-p9]';
			for (const [id, transport] of [
				["P9", rest(users.ro[0])],
				[
					"P10",
					{
						targetInput: "127.0.0.1",
						port: chr.ports.api,
						via: "native-api" as const,
						username: users.ro[0],
						password: PASSWORD,
					},
				],
			] as const) {
				const envelope = await executeEnvelope({
					...transport,
					command: substituted,
					yes: true,
				});
				expect({ id, ok: envelope.ok }).toEqual({ id, ok: false });
				if (!envelope.ok) {
					expect(envelope.error.code).toBe("routeros/permission-denied");
					expect(envelope.error.summary).toContain("p9-first");
				}
				expect({
					id,
					warnings: envelope.warnings.map((warning) => warning.code),
				}).toMatchObject({
					id,
					warnings: expect.arrayContaining(["transport/write-outcome-unknown"]),
				});
				expect(await identity()).toBe(before);
			}

			const menuWrapped = "/system/identity { set name=centrs-perm-p11 }";
			for (const [id, transport] of [
				["P11", rest(users.ro[0])],
				[
					"P12",
					{
						targetInput: "127.0.0.1",
						port: chr.ports.api,
						via: "native-api" as const,
						username: users.ro[0],
						password: PASSWORD,
					},
				],
			] as const) {
				const envelope = await executeEnvelope({
					...transport,
					command: menuWrapped,
					yes: true,
				});
				expect({ id, ok: envelope.ok }).toEqual({ id, ok: false });
				if (!envelope.ok) {
					expect(envelope.error.code).toBe("routeros/permission-denied");
				}
				expect(envelope.warnings.map((warning) => warning.code)).not.toContain(
					"transport/write-outcome-unknown",
				);
				expect(await identity()).toBe(before);
			}

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
				exampleIds: [
					"P1",
					"P2",
					"P3",
					"P4",
					"P5",
					"P6",
					"P7",
					"P8",
					"P9",
					"P10",
					"P11",
					"P12",
					"C1",
				],
			});
		} finally {
			await chr.destroy();
		}
	}, 300_000);
});
