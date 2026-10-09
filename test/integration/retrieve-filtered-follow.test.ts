import { describe, expect, test } from "bun:test";
import { api } from "../../src/api.ts";
import { createProtocolAdapter } from "../../src/protocols/adapter.ts";
import {
	type RetrieveEnvelope,
	type RetrieveRequest,
	retrieve,
} from "../../src/retrieve.ts";
import { retrieveFollow } from "../../src/retrieve-follow.ts";
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
const PATH = "/ip/firewall/address-list";
type Row = Record<string, string>;

async function follow(
	request: RetrieveRequest,
	afterSynced?: () => Promise<void>,
	onListening?: () => void,
) {
	const out: RetrieveEnvelope[] = [];
	let work: Promise<void> | undefined;
	for await (const envelope of retrieveFollow(request, Bun.env, {
		onListening,
	})) {
		out.push(envelope);
		if (envelope.meta.operation?.stream?.kind === "synced")
			work = afterSynced?.();
	}
	await work;
	expect(out.every((envelope) => envelope.ok)).toBe(true);
	return out;
}

function frames(out: RetrieveEnvelope[]) {
	return out.flatMap((envelope) => {
		const stream = envelope.meta.operation?.stream;
		return stream?.kind === "frame" && envelope.ok
			? [{ ...stream, data: envelope.data as Row | null }]
			: [];
	});
}

describeFast("filtered retrieve --follow against CHR", () => {
	test("runs FQ1-FQ5 with validation enabled", async () => {
		const started = await startIntegrationChr();
		const { chr } = started;
		const auth = splitQuickChrAuth(
			readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
		);
		const base = {
			targetInput: "127.0.0.1",
			port: chr.ports.api,
			...auth,
			via: "native-api",
		};
		const writer = createProtocolAdapter({
			protocol: "native-api",
			host: "127.0.0.1",
			port: chr.ports.api,
			tls: false,
			baseUrl: `api://127.0.0.1:${chr.ports.api}`,
			...auth,
			timeoutMs: 10_000,
		});
		const add = async (attributes: Row): Promise<string> => {
			const result = await writer.apiRequest({
				path: PATH,
				verb: "add",
				attributes,
			});
			return String((result.data as Row)[".id"]);
		};
		const set = (id: string, attributes: Row) =>
			writer.apiRequest({ path: PATH, verb: "set", id, attributes });
		const remove = (id: string) =>
			writer.apiRequest({ path: PATH, verb: "remove", id });
		try {
			await withBootReadyRetry(() =>
				retrieve({ ...base, path: "/system/note" }),
			);
			// FQ1: typed/nested predicate, projection omits every predicate field.
			const selected = await add({
				list: "fq1",
				address: "192.0.2.1",
				comment: "a",
			});
			const excluded = await add({
				list: "fq1",
				address: "192.0.2.2",
				comment: "out",
			});
			const fq1 = await follow(
				{
					...base,
					path: PATH,
					query: ["list=fq1", "comment=a and !disabled"],
					attributes: "address",
					count: 2,
					duration: "10s",
				},
				async () => {
					await set(selected, { comment: "out" });
					await set(excluded, { comment: "a" });
				},
			);
			expect(frames(fq1).filter((frame) => frame.phase === "snapshot")).toEqual(
				[
					expect.objectContaining({
						id: selected,
						data: { address: "192.0.2.1" },
					}),
				],
			);
			expect(frames(fq1).filter((frame) => frame.phase === "live")).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: selected,
						change: "removed",
						source: "membership",
						data: null,
					}),
					expect.objectContaining({
						id: excluded,
						change: "upsert",
						source: "membership",
						data: { address: "192.0.2.2" },
					}),
				]),
			);

			// FQ2: minimal dead notices remove only known matching rows.
			const fq2 = await follow(
				{
					...base,
					path: PATH,
					query: "list=fq1 and comment=a",
					count: 1,
					duration: "10s",
					sweep: 0,
				},
				async () => {
					await remove(selected);
					await remove(excluded);
				},
			);
			expect(frames(fq2).filter((frame) => frame.phase === "live")).toEqual([
				expect.objectContaining({
					id: excluded,
					change: "removed",
					source: "listen",
				}),
			]);

			// FQ3: a timeout crosses the predicate while the row still exists.
			const timed = await add({
				list: "fq3",
				address: "192.0.2.3",
				timeout: "10s",
			});
			const fq3 = await follow({
				...base,
				path: PATH,
				query: "list=fq3 and timeout>8s",
				sweep: "200ms",
				count: 1,
				duration: "6s",
			});
			expect(frames(fq3)).toEqual([
				expect.objectContaining({
					id: timed,
					change: "upsert",
					phase: "snapshot",
				}),
				expect.objectContaining({
					id: timed,
					change: "removed",
					phase: "live",
					source: "membership",
				}),
			]);
			expect(
				(await retrieve({ ...base, path: PATH, query: "list=fq3" })).data,
			).toHaveLength(1);

			// FQ4: real CLI wiring and unknown property refusal.
			const fq4 = await runCliProcess({
				args: [
					"retrieve",
					"127.0.0.1",
					PATH,
					"--port",
					String(chr.ports.api),
					"--username",
					auth.username,
					"--password",
					auth.password,
					"--follow",
					"--filter",
					"list=fq3",
					"--attributes",
					"address",
					"--duration",
					"500ms",
					"--json",
				],
			});
			expect(fq4.exitCode).toBe(0);
			expect(
				fq4.stdoutText
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
					.some((envelope) => envelope.meta.operation.stream.kind === "synced"),
			).toBe(true);
			const bad: RetrieveEnvelope[] = [];
			for await (const envelope of retrieveFollow({
				...base,
				path: PATH,
				query: "lits=fq3",
			}))
				bad.push(envelope);
			expect(bad).toHaveLength(1);
			expect(bad[0]?.ok ? undefined : bad[0]?.error.code).toBe(
				"validation/unknown-attribute",
			);

			// FQ5: churn from listen dispatch through bootstrap and live membership.
			const ids: string[] = [];
			for (let index = 0; index < 80; index++)
				ids.push(
					await add({
						list: "fq5",
						address: `198.51.100.${index + 1}`,
						comment: index % 2 ? "out" : "in",
					}),
				);
			let writes = 0;
			let churn: Promise<void> | undefined;
			const fq5 = await follow(
				{
					...base,
					path: PATH,
					query: "list=fq5 and comment=in",
					attributes: "address",
					sweep: "200ms",
					duration: "6s",
				},
				undefined,
				() => {
					churn = (async () => {
						const end = Date.now() + 2_000;
						while (Date.now() < end) {
							const index = writes % ids.length;
							await set(ids[index] ?? "", {
								comment: writes % 3 ? "in" : "out",
							});
							writes++;
						}
						for (const id of ids.slice(0, 10)) await remove(id);
					})();
				},
			);
			await churn;
			const applied = new Map<string, Row>();
			for (const frame of frames(fq5)) {
				if (frame.change === "removed") applied.delete(frame.id);
				else applied.set(frame.id, frame.data ?? {});
			}
			const truth = await retrieve({
				...base,
				path: PATH,
				query: "list=fq5 and comment=in",
			});
			expect(Object.fromEntries(applied)).toEqual(
				Object.fromEntries(
					(truth.data as Row[]).map((row) => [
						row[".id"],
						{ address: row["address"] },
					]),
				),
			);
			expect(writes).toBeGreaterThan(50);
			expect(fq5.at(-1)?.meta.operation?.stream).toMatchObject({
				kind: "summary",
				synced: true,
			});
			// Public API and retrieve predicate share validation and device semantics.
			const reference = await api({
				...base,
				endpoint: PATH,
				query: ["list=fq5 and comment=in"],
				proplist: [".id"],
			});
			expect(reference.ok).toBe(true);
			await recordIntegrationEvidence({
				suite: "filtered retrieve --follow",
				command: "retrieve",
				protocol: "native-api",
				routerosVersion: chr.state.version,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: ["FQ1", "FQ2", "FQ3", "FQ4", "FQ5"],
			});
		} finally {
			await writer.close();
			await chr.destroy();
		}
	}, 180_000);
});
