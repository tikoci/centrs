import { describe, expect, test } from "bun:test";
import { apiEnvelope } from "../../src/api.ts";
import {
	type CmrFleetCommand,
	cmrFleetCommand,
	cmrFleetGate,
	cmrFleetWarnings,
	cmrLabelsSelect,
	readCmrFleet,
	resolveCmrFleetScope,
} from "../../src/core/cmr-fleet.ts";
import { executeEnvelope } from "../../src/execute.ts";

type Row = Record<string, string>;

// The shape of a 7.26beta1 lab inventory (2026-10-15): the controller's own
// row carries `controller=true`; `labels` is absent until set.
const CTL: Row = {
	".id": "*1",
	identity: "lab-ctl",
	controller: "true",
	connected: "false",
	"auto-labels": "7.26beta1,x86,CHR,lab-ctl",
	"upgrade-rule": "default",
};
const C1: Row = {
	".id": "*2",
	identity: "lab-c1",
	connected: "true",
	labels: "edge,site-a",
	"auto-labels": "192.0.2.2,7.26beta1,x86,CHR,lab-c1",
	"upgrade-rule": "default",
};
const C2: Row = {
	".id": "*3",
	identity: "lab-c2",
	connected: "true",
	"auto-labels": "192.0.2.3,7.26beta1,arm64,RB5009,lab-c2",
	"upgrade-rule": "arm",
};
const INVENTORY = [CTL, C1, C2];

function reader(menus: Record<string, Row[]>) {
	const reads: string[] = [];
	return {
		reads,
		read: async (menu: string) => {
			reads.push(menu);
			const rows = menus[menu];
			if (!rows) throw new Error(`unexpected read ${menu}`);
			return rows;
		},
	};
}

function command(path: string, attributes: Row = {}): CmrFleetCommand {
	const found = cmrFleetCommand(path, attributes);
	if (!found) throw new Error(`not a fleet command: ${path}`);
	return found;
}

async function identities(path: string, attributes: Row, menus = {}) {
	const { read } = reader({ "/cmr/device": INVENTORY, ...menus });
	const scope = await resolveCmrFleetScope(command(path, attributes), read);
	return scope.devices?.map((device) => device.identity);
}

describe("cmrFleetCommand", () => {
	test.each([
		["/cmr/device/reboot", "/cmr/device/reboot"],
		["/cmr/dev/reb", "/cmr/device/reboot"],
		["/CMR/Device/Run-Script", "/cmr/device/run-script"],
		["/cmr/device/upgrade", "/cmr/device/upgrade"],
		["/cmr/device/pair", "/cmr/device/pair"],
		["/cmr/upgrade/trigger", "/cmr/upgrade/trigger"],
		["/cmr/upgrade/add", "/cmr/upgrade/add"],
		["/cmr/upgrade/job/run-next", "/cmr/upgrade/job/run-next"],
		["/cmr/vlan/add", "/cmr/vlan/add"],
		["/cmr/vlan/remove", "/cmr/vlan/remove"],
		["/cmr/wifi/set", "/cmr/wifi/set"],
		["/cmr/wifi/radio/disable", "/cmr/wifi/radio/disable"],
		["/cmr/w/r/add", "/cmr/wifi/radio/add"],
	])("%s is %s", (path, expected) => {
		expect(cmrFleetCommand(path, {})?.command).toBe(expected);
	});

	test.each([
		"/cmr/device/print",
		"/cmr/device/set",
		"/cmr/device/dashboard",
		"/cmr/alert/add",
		"/cmr/upgrade/job/print",
		"/ip/address/add",
		"/cmr/vlan",
		"/cmr/device/reboot/extra",
	])("%s is not a fleet command", (path) => {
		expect(cmrFleetCommand(path, {})).toBeUndefined();
	});
});

describe("cmrLabelsSelect: the manual's label rules", () => {
	// Every row was checked on the 7.26beta1 lab against a per-device
	// `run-script numbers=<id> labels=<expr>` probe (2026-10-15).
	const ctl = new Set(["7.26beta1", "x86", "CHR", "ctl"]);
	const c1 = new Set(["edge", "site-a", "7.26beta1", "x86", "CHR", "c1"]);
	test.each([
		["all", true, true],
		["-x", true, true],
		["all,-x", true, true],
		["ctl", true, false],
		["c1", false, true],
		["x86", true, true],
		["nope", false, false],
		["ctl,c1", true, true],
		["all,-ctl", false, true],
		["-ctl", false, true],
		["c1,+x86", false, true],
		["c1,+nope", false, false],
		["CTL", false, false],
		["edge", false, true],
		["site-a,+edge", false, true],
		["edge,-site-a", false, false],
		["Edge", false, false],
		["all,-edge", true, false],
	])("%s selects ctl=%p c1=%p", (expression, inCtl, inC1) => {
		expect(cmrLabelsSelect(expression, ctl)).toBe(inCtl);
		expect(cmrLabelsSelect(expression, c1)).toBe(inC1);
	});
});

describe("resolveCmrFleetScope", () => {
	test("labels=all reaches every row, the controller included", async () => {
		expect(await identities("/cmr/device/reboot", { labels: "all" })).toEqual([
			"lab-ctl",
			"lab-c1",
			"lab-c2",
		]);
	});

	test("an automatic label: the architecture", async () => {
		expect(await identities("/cmr/device/reboot", { labels: "x86" })).toEqual([
			"lab-ctl",
			"lab-c1",
		]);
	});

	test("numbers by .id or identity, intersected with labels", async () => {
		expect(
			await identities("/cmr/device/run-script", { numbers: "*1,lab-c2" }),
		).toEqual(["lab-ctl", "lab-c2"]);
		expect(
			await identities("/cmr/device/run-script", {
				numbers: "*1,lab-c2",
				labels: "x86",
			}),
		).toEqual(["lab-ctl"]);
	});

	test("a device command with no selector is not resolved", async () => {
		const { read } = reader({ "/cmr/device": INVENTORY });
		const scope = await resolveCmrFleetScope(
			command("/cmr/device/reboot"),
			read,
		);
		expect(scope.devices).toBeUndefined();
		expect(scope.unresolved).toContain("no `numbers` or `labels`");
	});

	test("an abbreviated selector is not expanded, and nothing is read", async () => {
		const { read, reads } = reader({});
		const scope = await resolveCmrFleetScope(
			command("/cmr/device/reboot", { lab: "all" }),
			read,
		);
		expect(scope.unresolved).toContain("`lab=`");
		expect(reads).toEqual([]);
	});

	test("trigger reaches the rows whose upgrade-rule it names (by name or .id)", async () => {
		const rules = {
			"/cmr/upgrade": [
				{ ".id": "*1", name: "default" },
				{ ".id": "*2", name: "arm" },
			],
		};
		expect(
			await identities("/cmr/upgrade/trigger", { numbers: "arm" }, rules),
		).toEqual(["lab-c2"]);
		expect(
			await identities("/cmr/upgrade/trigger", { numbers: "*1" }, rules),
		).toEqual(["lab-ctl", "lab-c1"]);
	});

	test("run-next is not resolved and reads nothing", async () => {
		const { read, reads } = reader({});
		const scope = await resolveCmrFleetScope(
			command("/cmr/upgrade/job/run-next", { number: "*1" }),
			read,
		);
		expect(scope.unresolved).toContain("upgrade job");
		expect(reads).toEqual([]);
	});

	test("a rule added without labels reaches every device", async () => {
		const { read } = reader({ "/cmr/device": INVENTORY });
		const scope = await resolveCmrFleetScope(
			command("/cmr/vlan/add", { "vlan-ids": "10" }),
			read,
		);
		expect(scope.everyDevice).toBe(true);
		expect(scope.devices?.length).toBe(3);
	});

	test("a VLAN rule with port-labels only is narrowed by port, not flagged", async () => {
		const { read } = reader({ "/cmr/device": INVENTORY });
		const scope = await resolveCmrFleetScope(
			command("/cmr/vlan/add", { "port-labels": "ether5", "vlan-ids": "10" }),
			read,
		);
		expect(scope.everyDevice).toBe(false);
	});

	test("WiFi band labels pick radios, not devices", async () => {
		expect(
			await identities("/cmr/wifi/radio/add", { labels: "edge,+5ghz" }),
		).toEqual(["lab-c1"]);
		const { read } = reader({ "/cmr/device": INVENTORY });
		const scope = await resolveCmrFleetScope(
			command("/cmr/wifi/add", { labels: "+5ghz", ssid: "x" }),
			read,
		);
		expect(scope.everyDevice).toBe(true);
	});

	test("set/remove use the existing rule; a set that changes labels reaches old and new", async () => {
		const vlan = {
			"/cmr/vlan": [{ ".id": "*1", labels: "edge", "vlan-ids": "10" }],
		};
		expect(
			await identities("/cmr/vlan/remove", { numbers: "*1" }, vlan),
		).toEqual(["lab-c1"]);
		expect(
			await identities(
				"/cmr/vlan/set",
				{ numbers: "*1", labels: "arm64" },
				vlan,
			),
		).toEqual(["lab-c1", "lab-c2"]);
		const { read } = reader({ "/cmr/device": INVENTORY, ...vlan });
		const scope = await resolveCmrFleetScope(
			command("/cmr/vlan/set", { numbers: "*9" }),
			read,
		);
		expect(scope.unresolved).toContain("did not match");
	});

	test("each VLAN rule is judged on its own selectors", async () => {
		const vlan: Record<string, Row[]> = {
			"/cmr/device": INVENTORY,
			"/cmr/vlan": [
				{ ".id": "*1", "port-labels": "ether5", "vlan-ids": "10" },
				{ ".id": "*2", "vlan-ids": "11" },
			],
		};
		const every = async (attributes: Row) => {
			const { read } = reader(vlan);
			return (
				await resolveCmrFleetScope(
					command("/cmr/vlan/remove", attributes),
					read,
				)
			).everyDevice;
		};
		// One port-scoped rule does not cover for an unscoped one beside it.
		expect(await every({ numbers: "*1,*2" })).toBe(true);
		expect(await every({ numbers: "*2,*1" })).toBe(true);
		expect(await every({ numbers: "*1" })).toBe(false);
		const { read } = reader(vlan);
		// Scoping an unscoped rule still reaches every device it leaves.
		const narrowed = await resolveCmrFleetScope(
			command("/cmr/vlan/set", { numbers: "*2", "port-labels": "ether5" }),
			read,
		);
		expect(narrowed.everyDevice).toBe(true);
		// …and a set that drops the port selector is unscoped in its new state.
		const widened = await resolveCmrFleetScope(
			command("/cmr/vlan/set", { numbers: "*1", "port-labels": "" }),
			read,
		);
		expect(widened.everyDevice).toBe(true);
	});

	test("disabling a label-less rule reaches every device", async () => {
		const { read } = reader({
			"/cmr/device": INVENTORY,
			"/cmr/wifi": [{ ".id": "*1", ssid: "x" }],
		});
		const scope = await resolveCmrFleetScope(
			command("/cmr/wifi/disable", { numbers: "*1" }),
			read,
		);
		expect(scope.everyDevice).toBe(true);
	});
});

describe("cmrFleetWarnings", () => {
	test("controller included, every device, and nothing selected", async () => {
		const resolve = async (path: string, attributes: Row) => {
			const { read } = reader({ "/cmr/device": INVENTORY });
			return cmrFleetWarnings(
				await resolveCmrFleetScope(command(path, attributes), read),
			).map((w) => w.code);
		};
		expect(await resolve("/cmr/device/reboot", { labels: "all" })).toEqual([
			"cmr/selection-includes-controller",
		]);
		expect(await resolve("/cmr/device/reboot", { labels: "edge" })).toEqual([]);
		expect(await resolve("/cmr/vlan/add", { "vlan-ids": "10" })).toEqual([
			"cmr/rule-selects-every-device",
		]);
		expect(await resolve("/cmr/vlan/add", { labels: "EDGE" })).toEqual([
			"cmr/empty-selection",
		]);
	});
});

describe("readCmrFleet", () => {
	const adapter = (fail: Set<string> = new Set()) => ({
		apiRequest: async (request: { path: string }) => {
			if (fail.has(request.path)) {
				throw Object.assign(new Error("boom"), { code: "transport/network" });
			}
			const data: Record<string, Row[]> = {
				"/cmr/device": INVENTORY,
				"/user": [{ name: "reader", group: "readers" }],
				"/user/group": [
					{ name: "readers", policy: "read,test,api,!write,!reboot" },
				],
			};
			return { data: data[request.path] ?? [] } as never;
		},
	});

	test("an unreachable controller is not asked again for the policy", async () => {
		const calls: string[] = [];
		const fail = (code: string) => ({
			apiRequest: async (request: { path: string }) => {
				calls.push(request.path);
				if (request.path === "/cmr/device") {
					throw Object.assign(new Error("boom"), { code });
				}
				return { data: [] } as never;
			},
		});
		await readCmrFleet(
			command("/cmr/device/reboot", { labels: "all" }),
			fail("transport/timeout"),
			"reader",
		);
		expect(calls).toEqual(["/cmr/device"]);
		calls.length = 0;
		// A refusal that is not about reaching the controller keeps the policy read.
		await readCmrFleet(
			command("/cmr/device/reboot", { labels: "all" }),
			fail("routeros/permission-denied"),
			"reader",
		);
		expect(calls).toEqual(["/cmr/device", "/user"]);
	});

	test("a failed inventory read leaves the scope unresolved, never throws", async () => {
		const read = await readCmrFleet(
			command("/cmr/device/reboot", { labels: "all" }),
			adapter(new Set(["/cmr/device"])),
			undefined,
		);
		expect(read.scope.devices).toBeUndefined();
		expect(read.scope.unresolved).toContain("transport/network");
		expect(read.warnings).toEqual([]);
	});

	test("reboot and run-script warn when the login lacks what they run with", async () => {
		const codes = async (path: string) =>
			(
				await readCmrFleet(
					command(path, { labels: "edge" }),
					adapter(),
					"reader",
				)
			).warnings.map((w) => [w.code, w.context?.["missing"]]);
		expect(await codes("/cmr/device/reboot")).toEqual([
			["cmr/caller-policy-not-enforced", ["reboot"]],
		]);
		expect(await codes("/cmr/device/run-script")).toEqual([
			["cmr/caller-policy-not-enforced", ["write", "reboot"]],
		]);
		// Not measured for upgrade (#456), so no claim is made.
		expect(await codes("/cmr/device/upgrade")).toEqual([]);
	});
});

describe("cmrFleetGate wording", () => {
	test("an unresolved reach still names the fleet command and why", async () => {
		const read = await readCmrFleet(
			command("/cmr/upgrade/job/run-next", { number: "*1" }),
			{ apiRequest: async () => ({ data: [] }) as never },
			undefined,
		);
		const gate = cmrFleetGate(read, "lab-ctl");
		expect(gate.summary).toBe(
			"A write-shaped `/cmr/upgrade/job/run-next` would reach the CMR devices it selects through controller lab-ctl (not resolved: an upgrade job's devices are not in the inventory), and needs explicit confirmation.",
		);
		expect(gate.context).toEqual({
			cmr: {
				command: "/cmr/upgrade/job/run-next",
				unresolved: "an upgrade job's devices are not in the inventory",
			},
		});
	});

	test("names the reach and repeats every warning but the controller one", async () => {
		const read = await readCmrFleet(
			command("/cmr/vlan/add", { "vlan-ids": "10" }),
			{
				apiRequest: async () => ({ data: INVENTORY }) as never,
			},
			undefined,
		);
		const gate = cmrFleetGate(read, "lab-ctl");
		expect(gate.prompt).toContain(
			"on 3 CMR device(s) through controller lab-ctl, the controller itself among them?",
		);
		expect(gate.prompt).toContain("cuts the fleet's management access");
		expect(gate.context).toEqual({
			cmr: {
				command: "/cmr/vlan/add",
				devices: 3,
				connected: 2,
				controllerIncluded: true,
				identities: ["lab-ctl", "lab-c1", "lab-c2"],
				inventory: 3,
			},
		});
	});
});

/** A REST controller on loopback answering the scope reads. */
function fakeController() {
	const seen: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname.replace(/^\/rest/, "");
			seen.push(`${req.method} ${path}`);
			if (path.startsWith("/cmr/device")) return Response.json(INVENTORY);
			if (path.startsWith("/cmr/vlan")) {
				return Response.json([
					{ ".id": "*1", labels: "arm64", "vlan-ids": "10" },
				]);
			}
			if (path.startsWith("/user/group")) {
				return Response.json([
					{ name: "full", policy: "read,write,test,reboot,api" },
				]);
			}
			if (path.startsWith("/user")) {
				return Response.json([{ name: "admin", group: "full" }]);
			}
			return Response.json({ detail: "unexpected" }, { status: 500 });
		},
	});
	return { server, seen };
}

const NO_ENV = { CENTRS_SKIP_ENV_FILE: "1" };

describe("the write gate names the fleet (#453)", () => {
	test("execute: the refusal names the reach and context.cmr; the warning rides the envelope", async () => {
		const { server, seen } = fakeController();
		try {
			const envelope = await executeEnvelope(
				{
					targetInput: "127.0.0.1",
					port: server.port,
					username: "admin",
					password: "",
					via: "rest-api",
					command: "/cmr/device/reboot labels=all",
					stdinIsTty: false,
				},
				NO_ENV,
			);
			expect(envelope.ok).toBe(false);
			if (envelope.ok) return;
			expect(envelope.error.code).toBe("usage/confirmation-required");
			expect(envelope.error.summary).toContain(
				"would reach 3 CMR device(s) through controller 127.0.0.1, the controller itself among them,",
			);
			expect(envelope.error.context?.["cmr"]).toMatchObject({
				devices: 3,
				controllerIncluded: true,
			});
			expect(envelope.warnings.map((w) => w.code)).toContain(
				"cmr/selection-includes-controller",
			);
			// Read-only: nothing but GETs and `print`s reached the controller.
			expect(
				seen.every(
					(line) => line.startsWith("GET ") || line.endsWith("/print"),
				),
			).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	test("execute: the TTY prompt names the reach", async () => {
		const { server } = fakeController();
		const prompts: string[] = [];
		try {
			await executeEnvelope(
				{
					targetInput: "127.0.0.1",
					port: server.port,
					username: "admin",
					password: "",
					via: "rest-api",
					command: "/cmr/vlan/add vlan-ids=10",
					stdinIsTty: true,
					confirm: async (prompt) => {
						prompts.push(prompt);
						return false;
					},
				},
				NO_ENV,
			);
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain("`/cmr/vlan/add` on 3 CMR device(s)");
			expect(prompts[0]).toContain("no `port-labels`");
		} finally {
			server.stop(true);
		}
	});

	test("api: POST to a device command names its reach", async () => {
		const { server } = fakeController();
		try {
			const envelope = await apiEnvelope(
				{
					endpoint: "/cmr/device/reboot",
					method: "POST",
					fields: { labels: "edge" },
					targetInput: "127.0.0.1",
					port: server.port,
					username: "admin",
					password: "",
					via: "rest-api",
					stdinIsTty: false,
				},
				NO_ENV,
			);
			expect(envelope.ok).toBe(false);
			if (envelope.ok) return;
			expect(envelope.error.code).toBe("usage/confirmation-required");
			expect(envelope.error.summary).toContain(
				"`/cmr/device/reboot` would reach 1 CMR device(s) through controller 127.0.0.1, and",
			);
			expect(envelope.error.context?.["cmr"]).toMatchObject({
				identities: ["lab-c1"],
				controllerIncluded: false,
			});
		} finally {
			server.stop(true);
		}
	});

	test("api: PATCH on a rule reads that rule and names its reach", async () => {
		const { server } = fakeController();
		try {
			const envelope = await apiEnvelope(
				{
					endpoint: "/cmr/vlan/*1",
					method: "PATCH",
					fields: { disabled: "yes" },
					targetInput: "127.0.0.1",
					port: server.port,
					username: "admin",
					password: "",
					via: "rest-api",
					stdinIsTty: false,
				},
				NO_ENV,
			);
			expect(envelope.ok).toBe(false);
			if (envelope.ok) return;
			expect(envelope.error.context?.["cmr"]).toMatchObject({
				command: "/cmr/vlan/set",
				identities: ["lab-c2"],
			});
		} finally {
			server.stop(true);
		}
	});

	test("a non-fleet write does not read the controller", async () => {
		const { server, seen } = fakeController();
		try {
			await executeEnvelope(
				{
					targetInput: "127.0.0.1",
					port: server.port,
					username: "admin",
					password: "",
					via: "rest-api",
					command: "/system/identity/set name=x",
					stdinIsTty: false,
				},
				NO_ENV,
			);
			expect(seen).toEqual([]);
		} finally {
			server.stop(true);
		}
	});
});
