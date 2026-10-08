import { describe, expect, test } from "bun:test";
import { api } from "../../src/api.ts";
import { createProtocolAdapter } from "../../src/protocols/adapter.ts";
import {
	type RetrieveRequest,
	type RetrieveSuccessEnvelope,
	retrieve,
} from "../../src/retrieve.ts";
import { retrieveSample } from "../../src/retrieve-sample.ts";
import {
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
	withBootReadyRetry,
} from "./chr.ts";
import { runCliProcess } from "./cli-process.ts";

/**
 * `--query` examples QY1–QY7 (`commands/retrieve/examples.md`) and QA1–QA2
 * (`commands/api/examples.md`) against a real CHR, over rest-api and
 * native-api. QY1 is the #397 gate: for every expression in it, the rows
 * `retrieve --query` returns are exactly the rows RouterOS's own
 * `find where` selects. The expressions where the two disagree are pinned in
 * QY2 as documented differences, not left out.
 */

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

type Row = Record<string, string>;

const AL = "/ip/firewall/address-list";
const FILTER = "/ip/firewall/filter";
const VLAN = "/interface/vlan";

/** Expressions where `find where` and the compiled query select the same rows. */
const AGREE: Record<string, string[]> = {
	[AL]: [
		"list=qa-397",
		'comment="a b"',
		'comment!="a b"',
		"comment!=x",
		"comment",
		"!comment",
		'comment=""',
		"comment=x>y",
		"disabled",
		"!disabled",
		"disabled=no",
		"dynamic",
		"!dynamic",
		"timeout",
		// A row without the property is smaller than any value.
		"timeout<2d",
		"timeout<=2d",
		"timeout>1h",
		"timeout>=1h",
		"!(timeout>=1h)",
		"list=qa-397 and timeout<1w",
		"address=192.0.2.9",
		"!(list=qa-397)",
		'list=qa-397 and disabled or comment="a b"',
		'comment="a b" or disabled and dynamic',
		"disabled && dynamic",
		"disabled || dynamic",
		"comment and !disabled",
		"list=qa-397 and !comment",
	],
	[VLAN]: [
		"vlan-id=40",
		"vlan-id=040",
		"vlan-id>39",
		"vlan-id>=40",
		"vlan-id<=40",
		"vlan-id<40",
		"mtu<1500",
		"mtu!=1500",
		"mtu<=1400",
		"vlan-id<100 and vlan-id>10",
		"vlan-id>10 and vlan-id<100 or disabled",
		"(vlan-id=10 or vlan-id=100) and !disabled",
	],
	[FILTER]: [
		'dst-port="80"',
		'protocol="tcp"',
		"log",
		"!log",
		"src-address",
		"!src-address",
		"comment!=x",
		"!(comment=x)",
		'src-address="192.0.2.0/24"',
		"chain=forward and (action=drop or log)",
	],
};

function ids(rows: unknown): string {
	return (rows as Row[])
		.map((row) => row[".id"] ?? "")
		.sort()
		.join(";");
}

describeFast("retrieve --query against CHR", () => {
	test("runs query examples QY1-QY7 and QA1-QA2", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		const auth = splitQuickChrAuth(
			readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
		);
		const rest = {
			targetInput: chr.restUrl,
			username: auth.username,
			password: auth.password,
		};
		const native = {
			targetInput: "127.0.0.1",
			port: chr.ports.api,
			via: "native-api",
			username: auth.username,
			password: auth.password,
		};
		const writer = createProtocolAdapter({
			protocol: "native-api",
			host: "127.0.0.1",
			port: chr.ports.api,
			tls: false,
			baseUrl: `api://127.0.0.1:${chr.ports.api}`,
			username: auth.username,
			password: auth.password,
			timeoutMs: 10_000,
		});
		const add = (path: string, attributes: Row) =>
			writer.apiRequest({ verb: "add", path, attributes });
		/** RouterOS's own answer: the ids `<menu> find where <expression>` selects. */
		const findWhere = async (menu: string, expression: string) => {
			const result = await writer.apiRequest({
				verb: "run",
				path: "/execute",
				script: `:put [${menu} find where ${expression}]`,
			});
			return String(result.data ?? "")
				.trim()
				.split(";")
				.filter(Boolean)
				.sort()
				.join(";");
		};
		const read = async (
			base: object,
			path: string,
			query: string | string[],
		): Promise<RetrieveSuccessEnvelope> =>
			retrieve({ ...base, path, query } as RetrieveRequest, Bun.env);
		try {
			await withBootReadyRetry(() =>
				writer.apiRequest({ verb: "print", path: "/ip/address" }),
			);
			for (const [address, extra] of [
				["192.0.2.9", { comment: "a b" }],
				["192.0.2.10", {}],
				["10.0.0.1", { comment: "x>y", disabled: "yes" }],
				["10.0.0.2", { comment: "" }],
				["198.51.100.7", { timeout: "1d" }],
			] as const) {
				await add(AL, { list: "qa-397", address, ...extra });
			}
			await add("/interface/bridge", { name: "br-397" });
			for (const [id, extra] of [
				[10, {}],
				[40, { mtu: "1400" }],
				[100, { disabled: "yes" }],
			] as const) {
				await add(VLAN, {
					name: `v397-${id}`,
					interface: "br-397",
					"vlan-id": String(id),
					...extra,
				});
			}
			const rules: Row[] = [
				{
					chain: "forward",
					action: "accept",
					protocol: "tcp",
					"dst-port": "80",
				},
				{
					chain: "forward",
					action: "drop",
					protocol: "tcp",
					"dst-port": "443",
					log: "yes",
				},
				{ chain: "input", action: "accept", comment: "x" },
				{
					chain: "input",
					action: "drop",
					"src-address": "192.0.2.0/24",
					disabled: "yes",
				},
			];
			for (const rule of rules) {
				await add(FILTER, rule);
			}

			// QY1. Same rows as `find where`, over both transports.
			const disagreements: string[] = [];
			for (const [menu, expressions] of Object.entries(AGREE)) {
				for (const expression of expressions) {
					const device = await findWhere(menu, expression);
					for (const [name, base] of [
						["rest-api", rest],
						["native-api", native],
					] as const) {
						const envelope = await read(base, menu, expression);
						expect(envelope.ok).toBe(true);
						const got = ids(envelope.data);
						if (got !== device) {
							disagreements.push(
								`${name} ${menu} ${expression}: query=${got} where=${device}`,
							);
						}
					}
				}
			}
			expect(disagreements).toEqual([]);

			// QY2. Documented differences: the query compares the value retrieve
			// shows, not the CLI's typed literal, and orders text as text.
			const port80 = await read(rest, FILTER, "dst-port=80");
			expect((port80.data as Row[]).map((row) => row["dst-port"])).toEqual([
				"80",
			]);
			expect(await findWhere(FILTER, "dst-port=80")).toBe("");
			const above = await read(rest, AL, "list=qa-397 and address>192.0.2.9");
			// "192.0.2.10" < "192.0.2.9" as text, so only 198.51.100.7 is above.
			expect((above.data as Row[]).map((row) => row["address"])).toEqual([
				"198.51.100.7",
			]);

			// QY3. --filter and repeated --query are AND-ed (CLI).
			const qy3 = await runCliProcess({
				args: [
					"retrieve",
					chr.restUrl,
					AL,
					"--filter",
					"list=qa-397",
					"--query",
					"comment",
					"--query",
					"!disabled",
					"--attributes",
					"address",
					"--username",
					auth.username,
					"--password",
					auth.password,
					"--json",
				],
			});
			expect(qy3.exitCode).toBe(0);
			const qy3Envelope = JSON.parse(qy3.stdoutText) as { data: unknown };
			expect(qy3Envelope.data).toEqual([{ address: "192.0.2.9" }]);

			// QY4. A regex is refused before anything is sent.
			const qy4 = await runCliProcess({
				args: [
					"retrieve",
					chr.restUrl,
					"/interface",
					"--query",
					'name~"^ether"',
					"--username",
					auth.username,
					"--password",
					auth.password,
					"--json",
				],
			});
			expect(qy4.exitCode).toBe(1);
			expect(JSON.parse(qy4.stderrText)).toMatchObject({
				ok: false,
				error: { code: "input/unsupported-query" },
			});

			// QY5. A misspelled property fails validation instead of matching nothing.
			await expect(read(native, AL, "lists=qa-397")).rejects.toMatchObject({
				code: "validation/unknown-attribute",
			});

			// QY6. A singleton has no rows to filter.
			await expect(
				read(rest, "/system/identity", "name=MikroTik"),
			).rejects.toMatchObject({ code: "usage/conflicting-flags" });

			// QY7. --sample reads the filtered rows each time.
			const samples: unknown[] = [];
			for await (const envelope of retrieveSample(
				{
					...rest,
					path: AL,
					query: "list=qa-397 and disabled",
					sample: "500ms",
					count: 2,
				},
				Bun.env,
			)) {
				if (envelope.ok && envelope.meta.operation?.stream?.kind === "sample") {
					samples.push(envelope.data);
				}
			}
			expect(
				samples.map((data) => (data as Row[]).map((row) => row["address"])),
			).toEqual([["10.0.0.1"], ["10.0.0.1"]]);

			// QA1. api --query takes the same grammar; a bare boolean is =yes.
			for (const base of [rest, native]) {
				const qa1 = await api(
					{
						...base,
						endpoint: AL,
						query: ["list=qa-397 and disabled"],
						proplist: ["address"],
					},
					Bun.env,
				);
				expect(qa1.ok).toBe(true);
				expect(qa1.data).toEqual([{ address: "10.0.0.1" }]);
			}

			// QA2. A value containing an operator stays one value.
			const qa2 = await api(
				{
					...rest,
					endpoint: AL,
					query: ["comment=x>y"],
					proplist: ["address"],
				},
				Bun.env,
			);
			expect(qa2.data).toEqual([{ address: "10.0.0.1" }]);

			await recordIntegrationEvidence({
				suite: "retrieve --query against CHR",
				command: "retrieve",
				protocol: "rest-api+native-api",
				routerosVersion: chr.state.version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [
					"QY1",
					"QY2",
					"QY3",
					"QY4",
					"QY5",
					"QY6",
					"QY7",
					"QA1",
					"QA2",
				],
			});
		} finally {
			await writer.close();
			await chr.destroy();
		}
	}, 300_000);
});
