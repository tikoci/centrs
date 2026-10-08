import { describe, expect, test } from "bun:test";
import {
	createProtocolAdapter,
	type ProtocolAdapter,
} from "../../src/protocols/adapter.ts";
import type { RetrieveEnvelope, RetrieveRequest } from "../../src/retrieve.ts";
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

/**
 * `retrieve --follow` examples FL1–FL9 (`commands/retrieve/examples.md`)
 * against a real CHR. FL9 is the #396 round-3 A1 harness, committed as a
 * regression: churn while the follow bootstraps and runs, then compare the
 * applied lines with a fresh print.
 */

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

type Stream = NonNullable<
	NonNullable<RetrieveEnvelope["meta"]["operation"]>["stream"]
>;

function streamOf(envelope: RetrieveEnvelope | undefined): Stream | undefined {
	return envelope?.meta.operation?.stream;
}

function frames(out: readonly RetrieveEnvelope[]) {
	return out.flatMap((envelope) => {
		const stream = streamOf(envelope);
		return stream?.kind === "frame" && envelope.ok
			? [{ ...stream, data: envelope.data as Record<string, string> | null }]
			: [];
	});
}

function summaryOf(out: readonly RetrieveEnvelope[]) {
	const stream = streamOf(out.at(-1));
	return stream?.kind === "summary" ? stream : undefined;
}

/**
 * Run a follow, call `afterSynced` once (with the collected envelopes so far),
 * and stop early when `until` says so.
 */
async function follow(
	request: RetrieveRequest,
	hooks: {
		afterSynced?: () => Promise<void> | void;
		onListening?: () => void;
		until?: (envelope: RetrieveEnvelope) => boolean;
	} = {},
): Promise<RetrieveEnvelope[]> {
	const out: RetrieveEnvelope[] = [];
	const pendingHooks: Promise<void>[] = [];
	for await (const envelope of retrieveFollow(request, Bun.env, {
		onListening: hooks.onListening,
	})) {
		out.push(envelope);
		if (streamOf(envelope)?.kind === "synced" && hooks.afterSynced) {
			pendingHooks.push(Promise.resolve(hooks.afterSynced()));
		}
		if (hooks.until?.(envelope)) break;
	}
	await Promise.all(pendingHooks);
	return out;
}

async function add(
	writer: ProtocolAdapter,
	path: string,
	attributes: Record<string, string>,
): Promise<string> {
	const result = await writer.apiRequest({ verb: "add", path, attributes });
	const id = (result.data as Record<string, string>)[".id"];
	expect(id).toMatch(/^\*[0-9A-F]+$/i);
	return String(id);
}

async function remove(
	writer: ProtocolAdapter,
	path: string,
	id: string,
): Promise<void> {
	await writer.apiRequest({ verb: "remove", path, id });
}

describeFast("retrieve --follow against CHR (native-api)", () => {
	test("runs follow examples FL1-FL9", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		const auth = splitQuickChrAuth(
			readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
		);
		const base = {
			targetInput: "127.0.0.1",
			port: chr.ports.api,
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
		try {
			await withBootReadyRetry(() =>
				writer.apiRequest({ verb: "print", path: "/ip/address" }),
			);
			const seeded = await add(writer, "/ip/address", {
				address: "198.51.100.40/32",
				interface: "ether1",
			});

			// FL1. Bootstrap: snapshot frames, one synced, a summary.
			const fl1 = await follow({
				...base,
				path: "/ip/address",
				duration: "3s",
			});
			expect(fl1.every((envelope) => envelope.ok)).toBe(true);
			const fl1Frames = frames(fl1);
			expect(fl1Frames.length).toBeGreaterThanOrEqual(1);
			expect(
				fl1Frames.every(
					(f) =>
						f.phase === "snapshot" &&
						f.source === "print" &&
						/^\*[0-9A-F]+$/i.test(f.id),
				),
			).toBe(true);
			expect(fl1.filter((e) => streamOf(e)?.kind === "synced")).toHaveLength(1);
			expect(summaryOf(fl1)).toMatchObject({
				stopReason: "duration-elapsed",
				synced: true,
				changes: 0,
			});

			// FL2. A live change; --count ignores the snapshot frames.
			let fl2Added = "";
			const fl2 = await follow(
				{ ...base, path: "/ip/address", count: 1, duration: "15s" },
				{
					afterSynced: async () => {
						fl2Added = await add(writer, "/ip/address", {
							address: "198.51.100.41/32",
							interface: "ether1",
						});
					},
				},
			);
			const fl2Live = frames(fl2).filter((f) => f.phase === "live");
			expect(fl2Live).toHaveLength(1);
			expect(fl2Live[0]).toMatchObject({
				change: "upsert",
				source: "listen",
				id: fl2Added,
			});
			expect(fl2Live[0]?.data?.["address"]).toBe("198.51.100.41/32");
			expect(summaryOf(fl2)).toMatchObject({
				stopReason: "count-reached",
				changes: 1,
			});
			expect(summaryOf(fl2)?.snapshot).toBeGreaterThanOrEqual(2);

			// FL3. A removal RouterOS sends.
			const fl3 = await follow(
				{ ...base, path: "/ip/address", sweep: 0, count: 1, duration: "15s" },
				{ afterSynced: () => remove(writer, "/ip/address", seeded) },
			);
			expect(streamOf(fl3[0])?.kind).toBe("notice");
			expect(fl3[0]?.tips.map((tip) => tip.code)).toEqual([
				"tip/follow-sweep-off",
			]);
			const fl3Live = frames(fl3).filter((f) => f.phase === "live");
			expect(fl3Live).toEqual([
				expect.objectContaining({
					change: "removed",
					source: "listen",
					id: seeded,
					data: null,
				}),
			]);
			expect(summaryOf(fl3)?.stopReason).toBe("count-reached");

			// FL4. A view menu never sends .dead; the sweep reports the removal.
			let bridge = "";
			const fl4 = await follow(
				{ ...base, path: "/interface/bridge", sweep: "1s", duration: "15s" },
				{
					afterSynced: async () => {
						bridge = await add(writer, "/interface/bridge", {
							name: "fl4-bridge",
						});
						await Bun.sleep(1_000);
						await remove(writer, "/interface/bridge", bridge);
					},
					until: (envelope) => {
						const stream = streamOf(envelope);
						return (
							stream?.kind === "frame" &&
							stream.change === "removed" &&
							stream.id === bridge
						);
					},
				},
			);
			const fl4Bridge = frames(fl4).filter((f) => f.id === bridge);
			expect(fl4Bridge[0]).toMatchObject({
				change: "upsert",
				source: "listen",
			});
			expect(fl4Bridge.at(-1)).toMatchObject({
				change: "removed",
				source: "sweep",
				data: null,
			});

			// FL5. --attributes projects data; identity stays in meta.
			const fl5 = await follow({
				...base,
				path: "/ip/address",
				attributes: "address",
				duration: "3s",
			});
			const fl5Frames = frames(fl5);
			expect(fl5Frames.length).toBeGreaterThanOrEqual(1);
			for (const f of fl5Frames) {
				expect(Object.keys(f.data ?? {})).toEqual(["address"]);
				expect(f.id).toMatch(/^\*[0-9A-F]+$/i);
			}

			// FL6. A menu RouterOS cannot follow.
			const fl6 = await follow({ ...base, path: "/system/resource" });
			expect(fl6).toHaveLength(1);
			expect(fl6[0]?.ok ? undefined : fl6[0]?.error.code).toBe(
				"validation/not-followable",
			);

			// FL7. A pinned REST transport.
			const fl7 = await follow({
				targetInput: chr.restUrl,
				via: "rest-api",
				username: auth.username,
				password: auth.password,
				path: "/ip/address",
			});
			expect(fl7).toHaveLength(1);
			expect(fl7[0]?.ok ? undefined : fl7[0]?.error.code).toBe(
				"transport/capability-unsupported",
			);

			// FL8. NDJSON is readable before exit; SIGINT ends it with a summary.
			let firstFrameWhileRunning: unknown;
			const fl8 = await runCliProcess({
				args: [
					"retrieve",
					"127.0.0.1",
					"/ip/address",
					"--follow",
					"--format",
					"ndjson",
					"--port",
					String(chr.ports.api),
					"--username",
					auth.username,
					"--password",
					auth.password,
				],
				onStdoutLine: (line, child) => {
					if (firstFrameWhileRunning !== undefined || !line.trim()) return;
					const parsed = JSON.parse(line);
					if (parsed.meta?.operation?.stream?.kind !== "frame") return;
					firstFrameWhileRunning = child.exitCode === null ? parsed : null;
					child.kill("SIGINT");
				},
				killAfterMs: 30_000,
			});
			expect(firstFrameWhileRunning).toMatchObject({ ok: true });
			expect(fl8.exitCode).toBe(0);
			const fl8Last = JSON.parse(
				fl8.stdoutText.trim().split("\n").at(-1) ?? "",
			);
			expect(fl8Last.meta.operation.stream).toMatchObject({
				kind: "summary",
				stopReason: "interrupted",
			});

			// FL9. A1 and the sweep under churn.
			const list = "/ip/firewall/address-list";
			const live: string[] = [];
			let n = 0;
			const uniq = (): string => {
				n += 1;
				return `10.77.${(n >> 8) & 255}.${n & 255}`;
			};
			for (let i = 0; i < 300; i += 1) {
				live.push(
					await add(writer, list, {
						list: "fl9",
						address: uniq(),
						comment: "init",
					}),
				);
			}
			let seq = 0;
			let churning = true;
			let churn: Promise<void> = Promise.resolve();
			const fl9 = await follow(
				{ ...base, path: list, sweep: "200ms", duration: "8s" },
				{
					onListening: () => {
						churn = (async () => {
							const stopAt = Date.now() + 3_000;
							while (churning && Date.now() < stopAt) {
								seq += 1;
								const roll = Math.random();
								if (roll < 0.6 && live.length > 0) {
									const id =
										live[Math.floor(Math.random() * live.length)] ?? "";
									await writer.apiRequest({
										verb: "set",
										path: list,
										id,
										attributes: { comment: `s${seq}` },
									});
								} else if (roll < 0.8 || live.length === 0) {
									live.push(
										await add(writer, list, {
											list: "fl9",
											address: uniq(),
											comment: `s${seq}`,
										}),
									);
								} else {
									const index = Math.floor(Math.random() * live.length);
									const [id] = live.splice(index, 1);
									await remove(writer, list, id ?? "");
								}
							}
						})();
					},
				},
			);
			churning = false;
			await churn;
			expect(fl9.every((envelope) => envelope.ok)).toBe(true);
			const applied = new Map<string, string>();
			for (const f of frames(fl9)) {
				if (f.change === "removed") applied.delete(f.id);
				else applied.set(f.id, f.data?.["comment"] ?? "");
			}
			const truth = new Map(
				(
					(
						await writer.apiRequest({
							verb: "print",
							path: list,
							proplist: [".id", "comment"],
						})
					).data as Record<string, string>[]
				).map((row) => [row[".id"] ?? "", row["comment"] ?? ""]),
			);
			expect(seq).toBeGreaterThan(50);
			expect(summaryOf(fl9)).toMatchObject({ synced: true });
			expect(summaryOf(fl9)?.sweeps).toBeGreaterThan(0);
			expect(summaryOf(fl9)?.changes).toBeGreaterThan(0);
			expect(Object.fromEntries(applied)).toEqual(Object.fromEntries(truth));

			await recordIntegrationEvidence({
				suite: "retrieve --follow against CHR (native-api)",
				command: "retrieve",
				protocol: "native-api",
				routerosVersion: chr.state.version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [
					"FL1",
					"FL2",
					"FL3",
					"FL4",
					"FL5",
					"FL6",
					"FL7",
					"FL8",
					"FL9",
				],
			});
		} finally {
			await writer.close();
			await chr.destroy();
		}
	}, 300_000);
});
