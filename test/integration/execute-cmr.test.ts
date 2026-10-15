/**
 * `execute --cmr` (#450) against a real two-CHR CMR lab (`cmr-lab.ts`): a
 * controller with the `cmr` package and one paired client, 7.26beta1.
 *
 * Two parts:
 *   - CMR-D*: the device behaviour `src/execute-cmr.ts` is built on, asserted
 *     directly against the controller so a later RouterOS build that changes it
 *     fails here first, not as a silent mis-binding in centrs.
 *   - CMR1–CMR15: the examples in `commands/execute/examples.md` → CMR, through
 *     the library and the CLI, with validation on, over native-api AND
 *     rest-api to the controller.
 */

import { describe, expect, test } from "bun:test";
import { runCli } from "../../src/cli.ts";
import { executeEnvelope } from "../../src/execute.ts";
import {
	type ExecuteCmrEnvelope,
	type ExecuteCmrRequest,
	executeCmr,
} from "../../src/execute-cmr.ts";
import { createProtocolAdapter } from "../../src/protocols/index.ts";
import {
	CMR_SINCE,
	isChrIntegrationEnabled,
	recordIntegrationEvidence,
} from "./chr.ts";
import { type CmrLab, startCmrLab } from "./cmr-lab.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

type Row = Record<string, string>;

function codes(envelope: ExecuteCmrEnvelope): string[] {
	return envelope.data.targets.map((t) => (t.ok ? "ok" : t.error.code));
}

async function runScriptRest(lab: CmrLab, body: Record<string, string>) {
	const response = await fetch(
		`${lab.controller.restUrl}/rest/cmr/device/run-script`,
		{
			method: "POST",
			headers: {
				authorization: `Basic ${btoa(`${lab.controller.username}:${lab.controller.password}`)}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ "freeze-frame-interval": "20ms", ...body }),
		},
	);
	return {
		status: response.status,
		body: (await response.json()) as Row[] & Row,
	};
}

function lastRows(rows: Row[]): Row[] {
	const byDevice = new Map<string, Row>();
	for (const row of rows) byDevice.set(row["device"] ?? "", row);
	return [...byDevice.values()];
}

async function clientLogHas(lab: CmrLab, marker: string): Promise<boolean> {
	return (await lab.client.read("/log")).some((r) =>
		r["message"]?.includes(marker),
	);
}

async function note(router: CmrLab["controller"]): Promise<string> {
	return (await router.read("/system/note"))[0]?.["note"] ?? "";
}

describeFast("execute --cmr against a CMR lab (#450)", () => {
	test(
		"device contract, then CMR1–CMR15 over native-api and rest-api",
		async () => {
			const lab = await startCmrLab(
				`centrs-cmr-${crypto.randomUUID().slice(0, 6)}`,
			);
			try {
				const { controller, client } = lab;
				const devices = await lab.devices();
				const ctlRow = devices.find(
					(d) => d["identity"] === controller.identity,
				);
				const clientRow = devices.find(
					(d) => d["identity"] === client.identity,
				);
				expect(ctlRow?.[".id"]).toBeDefined();
				expect(clientRow?.["ids"]).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
				const clientId = clientRow?.[".id"] ?? "";

				// A controller login with the field site's group (#456): no write,
				// no reboot, no sensitive, no policy. Created before CMR-D8: the
				// dashboard probe blocks the controller's REST service for 10–30 s,
				// and this setup goes over REST.
				const restricted = {
					group: "centrs-reader",
					user: "centrs-reader-u",
					password: `Reader-${crypto.randomUUID().slice(0, 8)}`,
				};
				await controller.run(
					`/user/group/add name=${restricted.group} policy=read,test,api,rest-api,!write,!reboot,!sensitive,!policy`,
				);
				await controller.run(
					`/user/add name=${restricted.user} group=${restricted.group} password="${restricted.password}"`,
				);

				// CMR-D1. Rows carry no device id; `device` is a display key.
				const d1 = await runScriptRest(lab, {
					labels: "all",
					script: ":put x",
				});
				expect(d1.status).toBe(200);
				for (const row of d1.body) {
					expect(Object.keys(row).sort()).toEqual([
						".section",
						"device",
						"output",
						"status",
					]);
				}
				expect(
					lastRows(d1.body)
						.map((r) => r["device"])
						.sort(),
				).toEqual([controller.identity, `${client.identity}@192.0.2.2`].sort());

				// CMR-D2. numbers ∩ labels empty → refused up front.
				const d2 = await runScriptRest(lab, {
					numbers: clientId,
					labels: controller.identity,
					script: ":put x",
				});
				expect(d2.status).toBe(400);
				expect(String(d2.body["detail"])).toContain("no devices selected");

				// CMR-D3. A stale id inside `numbers` is dropped silently.
				const d3 = await runScriptRest(lab, {
					numbers: `${clientId},*FFFF`,
					script: ":put x",
				});
				expect(d3.status).toBe(200);
				expect(lastRows(d3.body).length).toBe(1);

				// CMR-D4. A CMR timeout reports `failed` while the script keeps running.
				const d4Marker = `centrs-d4-${crypto.randomUUID().slice(0, 6)}`;
				const d4 = await runScriptRest(lab, {
					numbers: clientId,
					timeout: "2s",
					script: `:delay 4s; :log info "${d4Marker}"`,
				});
				expect(lastRows(d4.body)[0]).toMatchObject({
					status: "failed",
					output: "timed out (6)",
				});
				await Bun.sleep(4_000);
				expect(await clientLogHas(lab, d4Marker)).toBe(true);

				// CMR-D5. Output is clipped in-band and still `success`.
				const d5 = await runScriptRest(lab, {
					numbers: clientId,
					script:
						':local s ""; :for i from=1 to=5000 do={ :set s ($s . "0123456789abcdef") }; :put $s',
				});
				const d5Row = lastRows(d5.body)[0];
				expect(d5Row?.["status"]).toBe("success");
				expect(d5Row?.["output"]).toMatch(/\.\.\.\(\+\d+ B\)$/);

				// CMR-D6. `:parse` on the client rejects a controller-only menu.
				const d6 = await runScriptRest(lab, {
					labels: "all",
					script: ':put [:parse "/cmr/device/print"]',
				});
				const d6Rows = lastRows(d6.body);
				expect(
					d6Rows.find((r) => r["device"] === controller.identity)?.["output"] ??
						"",
				).toStartWith("(evl /cmr/device/print)");
				expect(
					d6Rows.find((r) => r["device"]?.startsWith(client.identity))?.[
						"output"
					],
				).toStartWith("syntax error");

				// CMR-D7. A client cannot check its own key, so binding stays a
				// host-side read: `local-id` (whose first 64 hex are the device key
				// in `ids`) is masked inside run-script, and `numbers=` refuses `ids`.
				expect(
					(await client.read("/cmr/client"))[0]?.["local-id"]?.slice(0, 64),
				).toBe(clientRow?.["ids"]?.split("/")[0]);
				const d7 = await runScriptRest(lab, {
					numbers: clientId,
					script: ":put [/cmr/client get local-id]",
				});
				expect(lastRows(d7.body)[0]).toMatchObject({
					status: "success",
					output: "*****\r\n",
				});
				expect(
					(
						await runScriptRest(lab, {
							numbers: clientRow?.["ids"] ?? "",
							script: ":put x",
						})
					).status,
				).toBe(404);

				// CMR-D8. `dashboard` is console-only: over the native API it ends the
				// session (why centrs refuses it as `cmr/console-only`). REST is not
				// exercised: there it holds the controller's REST service for 10–30 s.
				const native = createProtocolAdapter({
					protocol: "native-api",
					host: "127.0.0.1",
					port: controller.ports.api,
					tls: false,
					baseUrl: `api://127.0.0.1:${controller.ports.api}`,
					username: controller.username,
					password: controller.password,
					timeoutMs: 15_000,
				});
				try {
					const dashboard = await native
						.apiRequest({
							verb: "run",
							path: "/cmr/device/dashboard",
							attributes: { numbers: clientId },
						})
						.then(
							() => "returned",
							(e: { code?: string }) => e.code,
						);
					expect(dashboard).toBe("transport/connection-closed");
				} finally {
					await native.close();
				}

				for (const via of ["native-api", "rest-api"] as const) {
					const base: ExecuteCmrRequest = {
						quickchr: controller.name,
						via,
						labels: "all",
						command: "",
						stdinIsTty: false,
					};
					const run = (overrides: Partial<ExecuteCmrRequest>) =>
						executeCmr({ ...base, ...overrides });

					// CMR1. A read on every client, each answering with its own identity.
					const read = await run({
						command: ":put [/system/identity/get name]",
					});
					expect(read.data.summary).toEqual({ total: 2, ok: 2, failed: 0 });
					for (const target of read.data.targets) {
						expect(
							target.ok && (target.data as { ret: string }).ret.trim(),
						).toBe(target.meta.target.identity ?? "");
						expect(target.meta.validation).toMatchObject({
							result: "passed",
							source: ":put [:parse ...] via cmr run-script",
						});
						expect(target.meta.target.cmr?.id).toMatch(/^\*[0-9A-F]+$/);
					}
					expect(read.meta.via).toBe(via);

					// CMR2. Mixed: the controller-only menu passes there, is rejected on the client.
					const mixed = await run({ command: "/cmr/device/print" });
					const mixedBy = Object.fromEntries(
						mixed.data.targets.map((t) => [
							t.meta.target.identity,
							t.ok ? "ok" : t.error.code,
						]),
					);
					expect(mixedBy).toEqual({
						[controller.identity]: "ok",
						[client.identity]: "validation/package-missing",
					});
					expect(mixed.meta.operation?.cmr).toMatchObject({
						selected: 2,
						dispatched: 1,
					});

					// CMR3. A confirmed write lands on every client.
					const value = `centrs-cmr3-${via}`;
					const write = await run({
						command: `/system/note/set note="${value}"`,
						yes: true,
					});
					expect(codes(write)).toEqual(["ok", "ok"]);
					expect(await note(controller)).toBe(value);
					expect(await note(client)).toBe(value);

					// CMR4. An unconfirmed write is refused before dispatch.
					const refused = await run({
						command: '/system/note/set note="centrs-cmr4"',
					}).catch((e) => e);
					expect(refused.code).toBe("usage/confirmation-required");
					expect(await note(client)).toBe(value);

					// CMR5. A command the clients reject is never sent: nothing changes.
					const invalid = await run({
						command: '/system/note/set note="centrs-cmr5" bogus-arg=1',
						yes: true,
					});
					expect(codes(invalid)).toEqual([
						"validation/unknown-attribute",
						"validation/unknown-attribute",
					]);
					expect(invalid.meta.operation?.cmr.dispatched).toBe(0);
					expect(await note(controller)).toBe(value);
					expect(await note(client)).toBe(value);

					// CMR6. A CMR timeout is an unknown outcome — and the script really kept going.
					const marker = `centrs-cmr6-${via}-${crypto.randomUUID().slice(0, 6)}`;
					const timedOut = await run({
						labels: client.identity,
						timeout: "2s",
						command: `:delay 4s; :log info "${marker}"`,
						yes: true,
					});
					expect(codes(timedOut)).toEqual(["cmr/outcome-unknown"]);
					await Bun.sleep(4_000);
					expect(await clientLogHas(lab, marker)).toBe(true);

					// CMR10. A caller cancel after dispatch is an unknown outcome, through
					// the real adapter — and the client script really kept going.
					const cancelMarker = `centrs-cmr10-${via}-${crypto.randomUUID().slice(0, 6)}`;
					const abort = new AbortController();
					const timer = setTimeout(() => abort.abort(), 2_000);
					const cancelled = await run({
						labels: client.identity,
						timeout: "20s",
						command: `:delay 6s; :log info "${cancelMarker}"`,
						yes: true,
						signal: abort.signal,
					}).finally(() => clearTimeout(timer));
					expect(codes(cancelled)).toEqual(["cmr/outcome-unknown"]);
					expect(cancelled.meta.operation?.cmr.dispatched).toBe(1);
					expect(await clientLogHas(lab, cancelMarker)).toBe(false);
					await Bun.sleep(6_000);
					expect(await clientLogHas(lab, cancelMarker)).toBe(true);

					// CMR11. A command needing a policy CMR scripts lack passes `:parse`
					// on the client, then is refused there at run time; nothing changes.
					const user = `centrs-cmr11-${via === "native-api" ? "n" : "r"}`;
					const denied = await run({
						labels: client.identity,
						command: `/user/add name=${user} group=read password=centrs-cmr11-x`,
						yes: true,
					});
					expect(codes(denied)).toEqual(["cmr/policy-denied"]);
					expect(denied.data.targets[0]?.meta.validation).toMatchObject({
						result: "passed",
					});
					expect(
						(await client.read("/user")).some((u) => u["name"] === user),
					).toBe(false);

					// CMR11b. After earlier output: the statements before the refused one
					// ran and stay; the script stopped at it.
					const mark = `centrs-cmr11b-${via === "native-api" ? "n" : "r"}`;
					const partial = await run({
						labels: client.identity,
						command: [
							":put before",
							`/system/note/set note="${mark}-before"`,
							`/user/add name=${user} group=read password=centrs-cmr11-x`,
							`/system/note/set note="${mark}-after"`,
						].join("\n"),
						yes: true,
					});
					expect(codes(partial)).toEqual(["cmr/policy-denied"]);
					const partialTarget = partial.data.targets[0];
					expect(
						partialTarget?.ok === false &&
							String(partialTarget.error.context?.["output"]),
					).toMatch(/^before\r?\nnot enough permissions \(9\)/);
					expect(await note(client)).toBe(`${mark}-before`);
					expect(
						(await client.read("/user")).some((u) => u["name"] === user),
					).toBe(false);

					// CMR13. Plain execute on the controller: a relative-menu dashboard is
					// refused from its `:parse` return and never sent; a string that only
					// spells the words runs.
					const relative = await executeEnvelope({
						quickchr: controller.name,
						via,
						command: "/cmr/dev; dash",
						// Script-shaped, so write-gated before validation runs.
						yes: true,
					});
					expect(!relative.ok && relative.error.code).toBe("cmr/console-only");
					const spelled = await executeEnvelope({
						quickchr: controller.name,
						via,
						command: ':put "CMR device dashboard"',
					});
					expect(spelled.ok && (spelled.data as { ret: string }).ret).toBe(
						"CMR device dashboard",
					);

					// CMR14. `--cmr` pointed at the client (7.26beta1, no `cmr` package)
					// names the missing package and the controller it is paired to.
					const atClient = await executeCmr({
						quickchr: client.name,
						via,
						labels: "all",
						command: ":put x",
					}).then(
						() => undefined,
						(error: { code?: string; context?: Record<string, unknown> }) =>
							error,
					);
					expect(atClient?.code).toBe("cmr/not-a-controller");
					expect(atClient?.context).toMatchObject({
						controllerIdentity: controller.identity,
					});
					expect(String(atClient?.context?.["version"])).toStartWith(
						client.version,
					);

					// CMR12. A multi-line command runs every line on the client.
					const lines = await run({
						labels: client.identity,
						command: ":put centrs-l1\n:put centrs-l2",
					});
					expect(codes(lines)).toEqual(["ok"]);
					const target = lines.data.targets[0];
					const ret = target?.ok ? (target.data as { ret: string }).ret : "";
					expect(ret.replaceAll("\r\n", "\n")).toBe("centrs-l1\ncentrs-l2\n");

					// CMR7. Labels that match nothing: empty success with a warning.
					const empty = await run({
						labels: "no-such-label",
						command: ":put x",
					});
					expect(empty.data.summary.total).toBe(0);
					expect(empty.warnings.map((w) => w.code)).toContain(
						"cmr/empty-selection",
					);
					// …and an error for a write, even with --yes (#460).
					const emptyWrite = await run({
						labels: "no-such-label",
						command: `/system/note/set note="centrs-cmr7-${via}"`,
						yes: true,
					}).catch((e) => e);
					expect(emptyWrite.code).toBe("cmr/empty-selection");
					expect(emptyWrite.context).toMatchObject({ write: true });
					expect(await note(client)).not.toBe(`centrs-cmr7-${via}`);

					// CMR15. A login without write or reboot still writes through CMR
					// (#456), so the result says the login is not the limit. MikroTik
					// says 7.26beta2 refuses this for a `read` group: under
					// CENTRS_CMR_VERSION=7.26beta2 this step should go red first.
					const marker15 = `centrs-cmr15-${via}`;
					const viaReader = await executeCmr({
						targetInput: via === "rest-api" ? controller.restUrl : "127.0.0.1",
						...(via === "native-api" ? { port: controller.ports.api } : {}),
						via,
						username: restricted.user,
						password: restricted.password,
						labels: client.identity,
						command: `/system/note/set note="${marker15}"`,
						yes: true,
						stdinIsTty: false,
					});
					expect(codes(viaReader)).toEqual(["ok"]);
					expect(await note(client)).toBe(marker15);
					expect(
						viaReader.warnings.find(
							(w) => w.code === "cmr/caller-policy-not-enforced",
						)?.context,
					).toMatchObject({
						username: restricted.user,
						group: restricted.group,
						missing: ["write", "reboot"],
					});
					// The full admin login gets no such warning.
					const asAdmin = await run({
						labels: client.identity,
						command: `/system/note/set note="${marker15}-admin"`,
						yes: true,
					});
					expect(asAdmin.warnings.map((w) => w.code)).not.toContain(
						"cmr/caller-policy-not-enforced",
					);
				}

				// CMR8. The CLI reports a mixed result as exit code 2.
				const log = console.log;
				console.log = () => {};
				const exit = await runCli([
					"execute",
					"--quickchr",
					controller.name,
					"--cmr",
					"--labels",
					"all",
					"--json",
					"/cmr/device/print",
				]).finally(() => {
					console.log = log;
				});
				expect(exit).toBe(2);

				// CMR9. A client that is down is skipped, never sent the command.
				await client.stop();
				const deadline = Date.now() + 120_000;
				while (Date.now() < deadline) {
					const row = (await lab.devices()).find((d) => d[".id"] === clientId);
					if (row?.["connected"] === "false") break;
					await Bun.sleep(2_000);
				}
				const down = await executeCmr({
					quickchr: controller.name,
					via: "native-api",
					labels: client.identity,
					command: ":put x",
				});
				expect(codes(down)).toEqual(["cmr/client-disconnected"]);
				expect(down.meta.operation?.cmr.dispatched).toBe(0);

				// CMR1–CMR7 and CMR10–CMR15 ran over both controller transports; CMR8
				// (CLI default) and CMR9 over native-api only.
				const proven = {
					"native-api": [
						"CMR1",
						"CMR2",
						"CMR3",
						"CMR4",
						"CMR5",
						"CMR6",
						"CMR7",
						"CMR8",
						"CMR9",
						"CMR10",
						"CMR11",
						"CMR12",
						"CMR13",
						"CMR14",
						"CMR15",
					],
					"rest-api": [
						"CMR1",
						"CMR2",
						"CMR3",
						"CMR4",
						"CMR5",
						"CMR6",
						"CMR7",
						"CMR10",
						"CMR11",
						"CMR12",
						"CMR13",
						"CMR14",
						"CMR15",
					],
				};
				for (const [protocol, exampleIds] of Object.entries(proven)) {
					await recordIntegrationEvidence({
						suite: "execute-cmr",
						command: "execute --cmr",
						protocol,
						routerosVersion: `${controller.version} (controller), ${client.version} (client)`,
						quickChrName: controller.name,
						requestedVersion: CMR_SINCE,
						exampleIds,
					});
				}
			} finally {
				await lab.remove();
			}
		},
		{ timeout: 900_000 },
	);
});
