/**
 * `execute --cmr` (#450) against a real two-CHR CMR lab (`cmr-lab.ts`): a
 * controller with the `cmr` package and one paired client, 7.26beta1.
 *
 * Two parts:
 *   - CMR-D*: the device behaviour `src/execute-cmr.ts` is built on, asserted
 *     directly against the controller so a later RouterOS build that changes it
 *     fails here first, not as a silent mis-binding in centrs.
 *   - CMR1–CMR9: the examples in `commands/execute/examples.md` → CMR, through
 *     the library and the CLI, with validation on, over native-api AND
 *     rest-api to the controller.
 */

import { describe, expect, test } from "bun:test";
import { runCli } from "../../src/cli.ts";
import {
	type ExecuteCmrEnvelope,
	type ExecuteCmrRequest,
	executeCmr,
} from "../../src/execute-cmr.ts";
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
		"device contract, then CMR1–CMR9 over native-api and rest-api",
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

					// CMR7. Labels that match nothing: empty success with a warning.
					const empty = await run({
						labels: "no-such-label",
						command: ":put x",
					});
					expect(empty.data.summary.total).toBe(0);
					expect(empty.warnings.map((w) => w.code)).toContain(
						"cmr/empty-selection",
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

				for (const protocol of ["native-api", "rest-api"]) {
					await recordIntegrationEvidence({
						suite: "execute-cmr",
						command: "execute --cmr",
						protocol,
						routerosVersion: `${controller.version} (controller), ${client.version} (client)`,
						quickChrName: controller.name,
						requestedVersion: CMR_SINCE,
						exampleIds: [
							"CMR1",
							"CMR2",
							"CMR3",
							"CMR4",
							"CMR5",
							"CMR6",
							"CMR7",
							"CMR8",
							"CMR9",
						],
					});
				}
			} finally {
				await lab.remove();
			}
		},
		{ timeout: 900_000 },
	);
});
