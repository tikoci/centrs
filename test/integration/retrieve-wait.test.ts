import { describe, expect, test } from "bun:test";
import { api } from "../../src/api.ts";
import { CentrsError } from "../../src/errors.ts";
import { retrieve } from "../../src/retrieve.ts";
import { retrieveWait } from "../../src/retrieve-wait.ts";
import {
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
	withBootReadyRetry,
} from "./chr.ts";
import { runCliProcess } from "./cli-process.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

describeFast("retrieve --wait/--until against CHR", () => {
	test("runs WT1-WT7 over REST and native API, including reboot and OSPF Full", async () => {
		// Reserve a loopback port for the QEMU point-to-point Ethernet link.
		const reservation = Bun.listen<undefined>({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {} },
		});
		const linkPort = reservation.port;
		reservation.stop(true);
		const started = await startIntegrationChr({
			networks: ["user", { type: "socket-listen", port: linkPort }],
		});
		const { chr } = started;
		let peer: Awaited<ReturnType<typeof startIntegrationChr>> | undefined;
		const auth = splitQuickChrAuth(
			readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
		);
		const base = {
			targetInput: "127.0.0.1",
			port: chr.ports.api,
			...auth,
			via: "native-api",
		};
		const rest = { targetInput: chr.restUrl, ...auth, via: "rest-api" };
		const write = async (
			connection: typeof base,
			endpoint: string,
			fields: Record<string, string>,
		) => {
			const result = await api({
				...connection,
				endpoint,
				method: "POST",
				fields,
				yes: true,
			});
			expect(result.ok).toBe(true);
			return result;
		};
		try {
			await withBootReadyRetry(() =>
				retrieve({ ...base, path: "/system/note" }),
			);
			for (const connection of [rest, base]) {
				// WT1: readiness and already-true any-match.
				const ready = await retrieveWait({
					...connection,
					path: "/system/resource",
					wait: "5s",
				});
				expect(ready.ok).toBe(true);
				expect(ready.meta.operation?.wait).toMatchObject({
					stopReason: "ready",
					attempts: 1,
					observations: 1,
				});
				const initial = await retrieveWait({
					...connection,
					path: "/interface",
					query: "name=ether1",
					until: "!disabled and mtu>=1500",
					attributes: "name",
					wait: "5s",
				});
				expect(initial.ok).toBe(true);
				if (initial.ok) expect(initial.data).toEqual([{ name: "ether1" }]);
				expect(initial.meta.operation?.wait).toMatchObject({
					stopReason: "condition-met",
					attempts: 1,
				});

				// WT2: a delayed matching row, with predicate fields projected away.
				const pending = retrieveWait({
					...connection,
					path: "/ip/firewall/address-list",
					query: "list=wait-364",
					until: "comment=ready",
					attributes: "address",
					wait: "10s",
					sample: "100ms",
				});
				await Bun.sleep(500);
				await write(base, "/ip/firewall/address-list/add", {
					list: "wait-364",
					address: "192.0.2.99",
					comment: "ready",
				});
				const matched = await pending;
				expect(matched.ok).toBe(true);
				if (matched.ok)
					expect(matched.data).toEqual([{ address: "192.0.2.99" }]);
				expect(matched.meta.operation?.wait?.observations).toBeGreaterThan(1);

				// WT3: drop-to-zero, including a completed empty initial observation.
				const emptyPending = retrieveWait({
					...connection,
					path: "/ip/firewall/address-list",
					query: "list=wait-364",
					untilEmpty: true,
					wait: "10s",
					sample: "100ms",
				});
				await Bun.sleep(500);
				const rows = (
					await retrieve({
						...base,
						path: "/ip/firewall/address-list",
						query: "list=wait-364",
					})
				).data as Record<string, string>[];
				for (const row of rows) {
					const removed = await api({
						...base,
						endpoint: `/ip/firewall/address-list/${row[".id"]}`,
						method: "DELETE",
						yes: true,
					});
					expect(removed.ok).toBe(true);
				}
				const empty = await emptyPending;
				expect(empty.ok).toBe(true);
				if (empty.ok) expect(empty.data).toEqual([]);
				expect(empty.meta.operation?.wait?.observations).toBeGreaterThan(1);
				const alreadyEmpty = await retrieveWait({
					...connection,
					path: "/ip/firewall/address-list",
					query: "list=wait-364",
					untilEmpty: true,
					wait: "5s",
				});
				expect(alreadyEmpty.meta.operation?.wait).toMatchObject({
					stopReason: "condition-met",
					observations: 1,
				});

				// WT4: unmet predicate, typo, auth and singleton conflicts.
				const unmet = await retrieveWait({
					...connection,
					path: "/interface",
					until: "name=missing",
					wait: "500ms",
					sample: "100ms",
				});
				expect(unmet.ok ? undefined : unmet.error.code).toBe(
					"wait/deadline-exceeded",
				);
				expect(unmet.meta.operation?.wait?.stopReason).toBe("deadline-elapsed");
				const typo = await retrieveWait({
					...connection,
					path: "/interface",
					until: "unknown-property=yes",
					wait: "5s",
				});
				expect(typo.ok ? undefined : typo.error.code).toBe(
					"validation/unknown-attribute",
				);
				expect(typo.meta.operation?.wait?.attempts).toBe(1);
				const badAuth = await retrieveWait({
					...connection,
					password: "deliberately-wrong",
					path: "/system/resource",
					wait: "5s",
				});
				expect(badAuth.ok).toBe(false);
				expect(badAuth.meta.operation?.wait).toMatchObject({
					stopReason: "failed",
					attempts: 1,
				});
				const singleton = await retrieveWait({
					...connection,
					path: "/system/resource",
					untilEmpty: true,
					wait: "5s",
				});
				expect(singleton.ok ? undefined : singleton.error.code).toBe(
					"usage/conflicting-flags",
				);
			}

			// WT5: actual reboot-readiness, starting while the services are down.
			try {
				const reboot = await api({
					...base,
					endpoint: "/system/reboot",
					method: "POST",
					yes: true,
				});
				expect(reboot.ok).toBe(true);
			} catch (error) {
				expect(error).toBeInstanceOf(CentrsError);
				expect((error as CentrsError).code).toBe("transport/connection-closed");
			}
			await Bun.sleep(1_000);
			const boot = await retrieveWait({
				...rest,
				path: "/system/resource",
				wait: "60s",
				timeout: "2s",
				sample: "500ms",
			});
			expect(boot.ok).toBe(true);
			expect(boot.meta.operation?.wait?.attempts).toBeGreaterThan(1);
			expect(boot.meta.operation?.wait?.observations).toBe(1);

			// WT6: real OSPF Full on a two-CHR link, no external polling loop.
			peer = await startIntegrationChr({
				networks: ["user", { type: "socket-connect", port: linkPort }],
			});
			const peerAuth = splitQuickChrAuth(
				readEnv(peer.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			const peerBase = {
				targetInput: "127.0.0.1",
				port: peer.chr.ports.api,
				...peerAuth,
				via: "native-api",
			};
			await withBootReadyRetry(() =>
				retrieve({ ...peerBase, path: "/system/note" }),
			);
			for (const [index, connection] of [base, peerBase].entries()) {
				await write(connection, "/ip/address/add", {
					address: `192.0.2.${index + 1}/30`,
					interface: "ether2",
				});
				await write(connection, "/routing/ospf/instance/add", {
					name: "wait-ospf",
					"router-id": `198.51.100.${index + 1}`,
				});
				await write(connection, "/routing/ospf/area/add", {
					name: "wait-backbone",
					instance: "wait-ospf",
					"area-id": "0.0.0.0",
				});
				await write(connection, "/routing/ospf/interface-template/add", {
					area: "wait-backbone",
					networks: "192.0.2.0/30",
					type: "ptp",
				});
			}
			const full = await retrieveWait({
				...base,
				path: "/routing/ospf/neighbor",
				until: "state=Full",
				wait: "40s",
				sample: "200ms",
			});
			expect(full.ok).toBe(true);
			if (full.ok)
				expect((full.data as Record<string, string>[])[0]?.["state"]).toBe(
					"Full",
				);
			const restFull = await retrieveWait({
				...rest,
				path: "/routing/ospf/neighbor",
				until: "state=Full",
				wait: "5s",
			});
			expect(restFull.ok).toBe(true);
			expect(restFull.meta.operation?.wait?.attempts).toBe(1);

			// WT7: one CLI result, no timer/sample lines, error exits nonzero.
			const cli = await runCliProcess({
				args: [
					"retrieve",
					chr.restUrl,
					"/interface",
					"--username",
					auth.username,
					"--password",
					auth.password,
					"--wait",
					"500ms",
					"--until",
					"name=missing",
					"--json",
				],
			});
			expect(cli.exitCode).toBe(1);
			expect(JSON.parse(cli.stdoutText).meta.operation.wait.stopReason).toBe(
				"deadline-elapsed",
			);
			await recordIntegrationEvidence({
				suite: "retrieve --wait/--until",
				command: "retrieve",
				protocol: "rest-api,native-api",
				routerosVersion: chr.state.version,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: ["WT1", "WT2", "WT3", "WT4", "WT5", "WT6", "WT7"],
			});
		} finally {
			await peer?.chr.destroy();
			await chr.destroy();
		}
	}, 300_000);
});
