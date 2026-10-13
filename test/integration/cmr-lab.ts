/**
 * Two-CHR CMR lab for `execute --cmr` (#450): a controller with the optional
 * `cmr` package and one client using the built-in `/cmr/client`, joined by a
 * quickchr named socket link. The client reaches the controller over the link,
 * never over the SLIRP management NIC: tcp/54321 is dropped inbound and reset
 * outbound on ether1. The reset keeps a reconnect from hanging for one SYN
 * timeout on the 10.0.2.15 source every SLIRP NIC shares (tikoci/quickchr's CMR
 * example traced its 90 s stalls to exactly this).
 *
 * CMR exists from 7.26beta1, so the lab pins its own version and ignores
 * `CENTRS_CHR_CHANNEL`. `CENTRS_CMR_VERSION` overrides it for a later beta.
 */

import { CMR_SINCE, routerOsAtLeast, splitQuickChrAuth } from "./chr.ts";

export const CMR_LAB_VERSION =
	Bun.env["CENTRS_CMR_VERSION"]?.trim() || CMR_SINCE;

type Row = Record<string, string>;

export interface CmrLabRouter {
	name: string;
	identity: string;
	version: string;
	restUrl: string;
	ports: { api: number; [key: string]: number };
	username: string;
	password: string;
	/** REST GET, returning rows (a singleton becomes a one-row list). */
	read(path: string): Promise<Row[]>;
	/** REST `/execute` of one console line; throws on a RouterOS failure. */
	run(script: string): Promise<string>;
	stop(): Promise<void>;
	start(): Promise<void>;
}

export interface CmrLab {
	controller: CmrLabRouter;
	client: CmrLabRouter;
	/** Snapshot of `/cmr/device` on the controller. */
	devices(): Promise<Row[]>;
	/** Wait until the client is paired and connected again (after a restart). */
	waitConnected(timeoutMs?: number): Promise<void>;
	remove(): Promise<void>;
}

interface LabInstance {
	name: string;
	state: { version: string };
	restUrl: string;
	ports: { api: number; [key: string]: number };
	subprocessEnv(): Promise<Record<string, string>>;
	rest(path: string, init?: RequestInit): Promise<unknown>;
	stop(): Promise<void>;
	remove(): Promise<void>;
}

interface QuickChrModule {
	QuickCHR: {
		start(options: Record<string, unknown>): Promise<LabInstance>;
		get(name: string): LabInstance | undefined;
	};
}

async function quickChr(): Promise<QuickChrModule> {
	const moduleName = "@tikoci/quickchr";
	return (await import(moduleName)) as unknown as QuickChrModule;
}

function rows(value: unknown): Row[] {
	if (Array.isArray(value)) return value as Row[];
	return value && typeof value === "object" ? [value as Row] : [];
}

async function until(
	description: string,
	predicate: () => Promise<boolean>,
	timeoutMs = 90_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(1_000);
	}
	throw new Error(`CMR lab timed out: ${description}`);
}

async function wrap(
	instance: LabInstance,
	identity: string,
): Promise<CmrLabRouter> {
	const env = await instance.subprocessEnv();
	const auth = splitQuickChrAuth(env["QUICKCHR_AUTH"] ?? "admin:");
	const authorization = `Basic ${btoa(`${auth.username}:${auth.password}`)}`;
	const router: CmrLabRouter = {
		name: instance.name,
		identity,
		version: instance.state.version,
		restUrl: instance.restUrl,
		ports: instance.ports,
		username: auth.username,
		password: auth.password,
		read: async (path) => rows(await instance.rest(path)),
		async run(script) {
			const response = await fetch(`${instance.restUrl}/rest/execute`, {
				method: "POST",
				headers: {
					authorization,
					"content-type": "application/json",
				},
				body: JSON.stringify({ script, "as-string": "" }),
			});
			const body = (await response.json()) as { ret?: string; detail?: string };
			const ret = body.ret ?? "";
			if (
				!response.ok ||
				/^(failure:|syntax error|bad command name|expected |input does not match|no such item)/m.test(
					ret,
				)
			) {
				throw new Error(
					`CMR lab: \`${script}\` on ${identity} failed: ${body.detail ?? ret}`,
				);
			}
			return ret;
		},
		stop: () => instance.stop(),
		async start() {
			const { QuickCHR } = await quickChr();
			await QuickCHR.start({ name: instance.name });
		},
	};
	return router;
}

/**
 * Boot, link and pair the lab. The controller pairs the client with the client's
 * own RouterOS login (`/cmr/device/pair … username= password=`), the normal
 * flow; neither side's pairing requirement is relaxed to `none`.
 */
export async function startCmrLab(prefix: string): Promise<CmrLab> {
	const { QuickCHR } = await quickChr();
	const link = { type: "socket", name: `${prefix}-link` };
	const base = { version: CMR_LAB_VERSION, arch: "x86", mem: 512 };
	const remove = async () => {
		for (const name of [`${prefix}-ctl`, `${prefix}-c1`]) {
			try {
				await QuickCHR.get(name)?.remove();
			} catch {
				// best-effort teardown
			}
		}
	};
	try {
		// Sequential: two concurrent starts race quickchr's host-port allocation
		// (QEMU then fails "Could not set up host forwarding rule").
		const ctl = await QuickCHR.start({
			...base,
			name: `${prefix}-ctl`,
			networks: ["user", link],
			packages: ["cmr"],
		});
		const c1 = await QuickCHR.start({
			...base,
			name: `${prefix}-c1`,
			networks: ["user", link],
		});
		const controller = await wrap(ctl, `${prefix}-ctl`);
		const client = await wrap(c1, `${prefix}-c1`);
		if (!routerOsAtLeast(controller.version, CMR_SINCE)) {
			throw new Error(
				`CMR lab needs RouterOS ${CMR_SINCE}+, got ${controller.version}`,
			);
		}
		const addresses = {
			[controller.identity]: "192.0.2.1/30",
			[client.identity]: "192.0.2.2/30",
		};
		for (const router of [controller, client]) {
			await router.run(`/system/identity/set name=${router.identity}`);
			await router.run(
				"/ip/firewall/filter/add chain=input in-interface=ether1 protocol=tcp dst-port=54321 action=drop comment=cmr-lab",
			);
			await router.run(
				"/ip/firewall/filter/add chain=output out-interface=ether1 protocol=tcp dst-port=54321 action=reject reject-with=tcp-reset comment=cmr-lab",
			);
			await router.run(
				`/ip/address/add address=${addresses[router.identity]} interface=ether2`,
			);
		}
		await controller.run("/cmr/set enabled=yes auto-labels=all");
		await client.run(
			"/cmr/client/set enabled=yes controller-addresses=192.0.2.1",
		);
		const devices = async () => controller.read("/cmr/device");
		await until(`controller sees ${client.identity}`, async () =>
			(await devices()).some((row) => row["identity"] === client.identity),
		);
		const quote = (value: string) =>
			`"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$")}"`;
		await controller.run(
			`/cmr/device/pair [find identity=${quote(client.identity)}] username=${quote(client.username)} password=${quote(client.password)}`,
		);
		const waitConnected = async (timeoutMs = 120_000) => {
			await until(
				`${client.identity} paired and connected`,
				async () => {
					const status = (await client.read("/cmr/client"))[0]?.["status"];
					const row = (await devices()).find(
						(r) => r["identity"] === client.identity,
					);
					return status === "paired,connected" && row?.["connected"] === "true";
				},
				timeoutMs,
			);
		};
		await waitConnected();
		return { controller, client, devices, waitConnected, remove };
	} catch (error) {
		await remove();
		throw error;
	}
}
