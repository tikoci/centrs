import { describe, expect, test } from "bun:test";
import { type ApiEnvelope, apiEnvelope, apiStream } from "../../src/api.ts";
import {
	exampleIds,
	isChrIntegrationEnabled,
	readEnv,
	recordIntegrationEvidence,
	splitQuickChrAuth,
	startIntegrationChr,
	withBootReadyRetry,
} from "./chr.ts";

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

/** The `--stream` marker on an envelope: a change frame or the terminating summary. */
function streamKind(envelope: ApiEnvelope): "frame" | "summary" | undefined {
	const operation = envelope.meta.operation as
		| { stream?: { kind?: "frame" | "summary" } }
		| undefined;
	return operation?.stream?.kind;
}

function summaryData(envelope: ApiEnvelope | undefined): {
	stopReason?: string;
	frames?: number;
	rows?: number;
	empty?: number;
} {
	const stream = envelope?.meta.operation?.stream;
	return stream?.kind === "summary" ? stream : {};
}

/** The rest-style record on a success (frame) envelope; `{}` for an error envelope or an `!empty` frame. */
function recordOf(envelope: ApiEnvelope | undefined): Record<string, unknown> {
	return (
		envelope?.ok && envelope.data !== null ? envelope.data : {}
	) as Record<string, unknown>;
}

function replyOf(envelope: ApiEnvelope): string | undefined {
	const stream = envelope.meta.operation?.stream;
	return stream?.kind === "frame" ? stream.reply : undefined;
}

function tipCodes(envelope: ApiEnvelope | undefined): string[] {
	return (envelope?.tips ?? []).map((tip) => tip.code);
}

function idOf(data: unknown): string {
	const id = (data as Record<string, unknown>)[".id"];
	expect(id).toMatch(/^\*[0-9A-F]+$/i);
	return String(id);
}

/**
 * Run a `--stream` follow in the background, fire `trigger` only once the listen
 * is actually established on the wire (the `onListening` barrier, not a blind
 * timer — so slow CHR startup can't make this miss the first change), and collect
 * every yielded envelope (frames + summary). The generator ends on its own bound
 * (`--count` / `--duration`).
 */
async function streamWithTrigger(
	listenRequest: Parameters<typeof apiStream>[0],
	trigger: () => Promise<void>,
): Promise<ApiEnvelope[]> {
	const envelopes: ApiEnvelope[] = [];
	let signalReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		signalReady = resolve;
	});
	const consumed = (async () => {
		for await (const envelope of apiStream(
			listenRequest,
			Bun.env,
			undefined,
			() => signalReady(),
		)) {
			envelopes.push(envelope);
		}
	})();
	await ready; // the listen sentence is on the wire (connect + login + write done)
	await Bun.sleep(150); // small margin for the router to register the subscription
	await trigger();
	await consumed;
	return envelopes;
}

describeFast("api --stream against CHR (native-api)", () => {
	test("runs native stream examples L1-L4 and L6-L16", async () => {
		const started = await startIntegrationChr();
		const chr = started.chr;
		try {
			const auth = splitQuickChrAuth(
				readEnv(started.env, "QUICKCHR_AUTH") ?? "admin:",
			);
			const nativeBase = {
				targetInput: "127.0.0.1",
				via: "native-api" as const,
				port: chr.ports.api,
				username: auth.username,
				password: auth.password,
			};
			const restBase = {
				targetInput: chr.restUrl,
				via: "rest-api" as const,
				username: auth.username,
				password: auth.password,
			};

			// Warm up: make sure the native api service is accepting connections on a
			// just-booted CHR before we open a long-lived listen against it.
			await withBootReadyRetry(() =>
				apiEnvelope({ ...nativeBase, endpoint: "ip/address" }),
			);

			// L1. A change frame, then a count-reached summary. The duration is only a
			// safety net so a (never-expected) missed frame fails fast, not at the
			// 180s test timeout — the barrier above makes the count path reliable.
			const l1 = await streamWithTrigger(
				{
					...nativeBase,
					endpoint: "ip/address/listen",
					count: 1,
					duration: "10s",
				},
				async () => {
					await apiEnvelope({
						...restBase,
						endpoint: "ip/address",
						method: "PUT",
						fields: { address: "198.51.100.30/32", interface: "ether1" },
						yes: true,
					});
				},
			);
			const l1Frames = l1.filter((e) => streamKind(e) === "frame");
			const l1Summary = l1.find((e) => streamKind(e) === "summary");
			expect(l1Frames.length).toBeGreaterThanOrEqual(1);
			expect(l1Frames.every((e) => e.ok)).toBe(true);
			expect(l1Summary).toBeDefined();
			expect(l1Summary?.meta.via).toBe("native-api");
			expect(summaryData(l1Summary as ApiEnvelope).stopReason).toBe(
				"count-reached",
			);
			expect(
				summaryData(l1Summary as ApiEnvelope).frames ?? 0,
			).toBeGreaterThanOrEqual(1);

			// L2. A deletion frame carries `.dead`. Seed an address, then remove it
			// over REST while listening (duration-bounded so we collect the delete
			// frame regardless of how many changes the window sees).
			const seed = await apiEnvelope({
				...restBase,
				endpoint: "ip/address",
				method: "PUT",
				fields: { address: "198.51.100.31/32", interface: "ether1" },
				yes: true,
			});
			const seedId = idOf(recordOf(seed));
			const l2 = await streamWithTrigger(
				{ ...nativeBase, endpoint: "ip/address/listen", duration: "3s" },
				async () => {
					await apiEnvelope({
						...restBase,
						endpoint: `ip/address/${seedId}`,
						method: "DELETE",
						yes: true,
					});
				},
			);
			const deadFrame = l2.find(
				(e) => streamKind(e) === "frame" && recordOf(e)[".dead"] === "true",
			);
			expect(deadFrame).toBeDefined();
			expect(recordOf(deadFrame)[".id"]).toBe(seedId);

			// L3. A `/listen` endpoint infers `--stream` + `--via native-api` (no flags).
			const l3 = await streamWithTrigger(
				{
					targetInput: "127.0.0.1",
					port: chr.ports.api,
					username: auth.username,
					password: auth.password,
					endpoint: "ip/address/listen",
					count: 1,
					duration: "10s",
				},
				async () => {
					await apiEnvelope({
						...restBase,
						endpoint: "ip/address",
						method: "PUT",
						fields: { address: "198.51.100.32/32", interface: "ether1" },
						yes: true,
					});
				},
			);
			const l3Frames = l3.filter((e) => streamKind(e) === "frame");
			const l3Summary = l3.find((e) => streamKind(e) === "summary");
			expect(l3Frames.length).toBeGreaterThanOrEqual(1);
			expect(l3Summary?.meta.via).toBe("native-api");
			expect(summaryData(l3Summary as ApiEnvelope).stopReason).toBe(
				"count-reached",
			);

			// L4. A bounded `--duration` with no change ends with `duration-elapsed`.
			// RouterOS answers the /cancel of a listen that sent nothing with
			// interrupted, `!empty`, `!done`: that `!empty` is a frame marked
			// `afterStop`, never evidence of an empty table (#402).
			const l4: ApiEnvelope[] = [];
			for await (const envelope of apiStream({
				...nativeBase,
				endpoint: "ip/address/listen",
				duration: "2s",
			})) {
				l4.push(envelope);
			}
			const l4Summary = l4.find((e) => streamKind(e) === "summary");
			expect(l4Summary).toBeDefined();
			expect(summaryData(l4Summary as ApiEnvelope)).toMatchObject({
				stopReason: "duration-elapsed",
				rows: 0,
				empty: 1,
			});
			expect(l4[0]?.meta.operation?.stream).toEqual({
				kind: "frame",
				index: 1,
				reply: "empty",
				afterStop: true,
			});

			async function collect(request: Parameters<typeof apiStream>[0]) {
				const result: ApiEnvelope[] = [];
				for await (const envelope of apiStream(request)) result.push(envelope);
				return result;
			}

			// L17. A GET stream is one literal print: it completes on its own, one
			// frame per row, and the tip names the listen it no longer becomes.
			const printed = await apiEnvelope({
				...nativeBase,
				endpoint: "ip/address",
			});
			expect(printed.ok).toBe(true);
			const rowCount = (printed.ok ? (printed.data as unknown[]) : []).length;
			const getStream = await collect({
				...nativeBase,
				endpoint: "ip/address",
				duration: "10s",
			});
			expect(getStream.every((e) => e.ok)).toBe(true);
			expect(summaryData(getStream.at(-1))).toMatchObject({
				stopReason: "completed",
				rows: rowCount,
			});
			expect(tipCodes(getStream.at(-1))).toEqual(["tip/stream-print"]);

			// L18. Each zero-row `print interval=` tick is an `!empty` frame; they
			// do not use up `--count`, which counts rows.
			const emptyTicks = await collect({
				...nativeBase,
				endpoint: "ip/firewall/raw/print",
				method: "POST",
				fields: { interval: "1" },
				count: 1,
				duration: "2500ms",
			});
			expect(emptyTicks.every((e) => e.ok)).toBe(true);
			const emptyFrames = emptyTicks.filter((e) => replyOf(e) === "empty");
			expect(emptyFrames.length).toBeGreaterThanOrEqual(2);
			expect(emptyFrames.every((e) => e.ok && e.data === null)).toBe(true);
			expect(summaryData(emptyTicks.at(-1))).toMatchObject({
				stopReason: "duration-elapsed",
				rows: 0,
			});

			// L6. Device count= ends ping naturally, without centrs --count.
			const ping = await collect({
				...nativeBase,
				endpoint: "tool/ping",
				method: "POST",
				fields: { address: "10.0.2.2", count: "3" },
				yes: true,
				duration: "10s",
			});
			expect(ping.every((e) => e.ok)).toBe(true);
			expect(ping.filter((e) => streamKind(e) === "frame")).toHaveLength(3);
			expect(summaryData(ping.at(-1)).stopReason).toBe("completed");

			// L7. A bounded monitor retains its device tick grouping.
			const monitor = await collect({
				...nativeBase,
				endpoint: "interface/monitor-traffic",
				method: "POST",
				fields: { interface: "ether1", duration: "2s" },
				yes: true,
				duration: "10s",
			});
			expect(monitor.every((e) => e.ok)).toBe(true);
			const ticks = monitor.filter((e) => streamKind(e) === "frame");
			expect(ticks.length).toBeGreaterThan(0);
			expect(
				ticks.every((e) => typeof recordOf(e)[".section"] === "string"),
			).toBe(true);
			expect(summaryData(monitor.at(-1)).stopReason).toBe("completed");

			// L8. POST print streams attributes instead of becoming a listen.
			const interval = await collect({
				...nativeBase,
				endpoint: "system/resource/print",
				method: "POST",
				fields: { interval: "1" },
				count: 2,
				duration: "10s",
			});
			expect(interval.every((e) => e.ok)).toBe(true);
			expect(interval.filter((e) => streamKind(e) === "frame")).toHaveLength(2);
			expect(summaryData(interval.at(-1)).stopReason).toBe("count-reached");

			/** Seed an address, follow `request`, delete the seed once listening. */
			async function followDelete(
				request: Omit<Parameters<typeof apiStream>[0], "endpoint"> & {
					endpoint: (id: string) => string;
				},
			): Promise<{ id: string; envelopes: ApiEnvelope[] }> {
				const seed = await apiEnvelope({
					...restBase,
					endpoint: "ip/address",
					method: "PUT",
					fields: { address: "198.51.100.33/32", interface: "ether1" },
					yes: true,
				});
				expect(seed.ok).toBe(true);
				const id = idOf(recordOf(seed));
				const envelopes = await streamWithTrigger(
					{ ...request, endpoint: request.endpoint(id), duration: "3s" },
					async () => {
						const deleted = await apiEnvelope({
							...restBase,
							endpoint: `ip/address/${id}`,
							method: "DELETE",
							yes: true,
						});
						expect(deleted.ok).toBe(true);
					},
				);
				expect(envelopes.every((e) => e.ok)).toBe(true);
				return { id, envelopes };
			}
			const deadFor = (envelopes: ApiEnvelope[], id: string) =>
				envelopes.some(
					(e) => recordOf(e)[".id"] === id && recordOf(e)[".dead"] === "true",
				);

			// L9. `api` sends .proplist as typed (#402). Without `.id,.dead` a delete
			// is not reported as one, so the tip says so; naming them shows it.
			const projected = await followDelete({
				...nativeBase,
				endpoint: () => "ip/address/listen",
				proplist: ["address"],
			});
			expect(deadFor(projected.envelopes, projected.id)).toBe(false);
			expect(tipCodes(projected.envelopes.at(-1))).toEqual([
				"tip/follow-proplist",
			]);
			const withDead = await followDelete({
				...nativeBase,
				endpoint: () => "ip/address/listen",
				proplist: ["address", ".id", ".dead"],
			});
			expect(deadFor(withDead.envelopes, withDead.id)).toBe(true);
			expect(tipCodes(withDead.envelopes.at(-1))).toEqual([]);

			// L15. An addressed listen (`?.id=`) reports its delete. Under a
			// projection without `.id,.dead`, RouterOS strips both, so the delete
			// is an `!re` with no attributes; the tip says so.
			const addressed = await followDelete({
				...nativeBase,
				endpoint: (id) => `ip/address/${id}/listen`,
			});
			expect(deadFor(addressed.envelopes, addressed.id)).toBe(true);
			expect(tipCodes(addressed.envelopes.at(-1))).toEqual([]);
			const addressedProjected = await followDelete({
				...nativeBase,
				endpoint: (id) => `ip/address/${id}/listen`,
				proplist: ["address"],
			});
			expect(
				addressedProjected.envelopes
					.filter((e) => streamKind(e) === "frame")
					.map(recordOf),
			).toEqual([{}]);
			expect(tipCodes(addressedProjected.envelopes.at(-1))).toEqual([
				"tip/follow-proplist",
			]);

			// L10. A filtered listen is sent as typed, and RouterOS drops the
			// delete of a row that matched the filter; the tip says so.
			const filtered = await followDelete({
				...nativeBase,
				endpoint: () => "ip/address/listen",
				query: ["interface=ether1"],
			});
			// Nothing at all for the delete: the only frame is the `!empty` that
			// answers the cancel.
			expect(
				filtered.envelopes
					.filter((e) => streamKind(e) === "frame")
					.map((e) => e.meta.operation?.stream),
			).toEqual([{ kind: "frame", index: 1, reply: "empty", afterStop: true }]);
			expect(tipCodes(filtered.envelopes.at(-1))).toEqual([
				"tip/filtered-follow",
			]);
			// The advice is the first line, before RouterOS has said anything.
			expect(filtered.envelopes[0]?.meta.operation?.stream).toEqual({
				kind: "notice",
			});
			expect(tipCodes(filtered.envelopes[0])).toEqual(["tip/filtered-follow"]);

			// L11. Command arguments are validated before starting the stream.
			const badArgument = await collect({
				...nativeBase,
				endpoint: "tool/ping",
				method: "POST",
				fields: { "no-such-arg": "x" },
				yes: true,
				duration: "1s",
			});
			expect(badArgument[0]).toMatchObject({
				ok: false,
				error: { code: "validation/unknown-attribute" },
			});

			// L12. Streaming a mutator never bypasses confirmation.
			const unconfirmed = await collect({
				...nativeBase,
				endpoint: "system/license/renew",
				method: "POST",
			});
			expect(unconfirmed[0]).toMatchObject({
				ok: false,
				error: { code: "usage/confirmation-required" },
			});

			// L13. Streamed mutations retain verb mapping and !done ret; read back
			// the address to prove add ran rather than another listen opening.
			const created = await collect({
				...nativeBase,
				endpoint: "ip/address",
				method: "PUT",
				fields: { address: "198.51.100.34/32", interface: "ether1" },
				yes: true,
				duration: "5s",
			});
			expect(created.every((e) => e.ok)).toBe(true);
			expect(created).toHaveLength(1);
			expect(summaryData(created[0]).stopReason).toBe("completed");
			const createdId = String(
				(recordOf(created[0])["done"] as Record<string, string>)["ret"],
			);
			expect(createdId).toMatch(/^\*[0-9A-F]+$/i);
			const readBack = await apiEnvelope({
				...nativeBase,
				endpoint: `ip/address/${createdId}`,
			});
			expect(readBack.ok).toBe(true);
			expect(recordOf(readBack)["address"]).toBe("198.51.100.34/32");
			// L16. Explicit POST print keeps query/projection in either delivery mode.
			for (const base of [nativeBase, restBase]) {
				const selected = await apiEnvelope({
					...base,
					endpoint: "ip/address/print",
					method: "POST",
					query: ["address=198.51.100.34/32"],
					proplist: ["address"],
				});
				expect(selected.ok).toBe(true);
				if (selected.ok)
					expect(selected.data).toEqual([{ address: "198.51.100.34/32" }]);
			}
			const selectedStream = await collect({
				...nativeBase,
				endpoint: "ip/address/print",
				method: "POST",
				query: ["address=198.51.100.34/32"],
				proplist: ["address"],
			});
			expect(selectedStream.every((e) => e.ok)).toBe(true);
			expect(
				selectedStream.filter((e) => streamKind(e) === "frame").map(recordOf),
			).toEqual([{ address: "198.51.100.34/32" }]);

			const removed = await collect({
				...nativeBase,
				endpoint: `ip/address/${createdId}`,
				method: "DELETE",
				yes: true,
			});
			expect(removed.every((e) => e.ok)).toBe(true);
			expect(summaryData(removed.at(-1)).stopReason).toBe("completed");

			// L14. /execute runtime rejection in !done.ret follows the one-shot
			// error contract; ordinary stdout containing fault words stays successful.
			const scriptRejected = await collect({
				...nativeBase,
				endpoint: "execute",
				method: "POST",
				fields: { script: "/ip/service/set www-ssl certificate=nope" },
				yes: true,
			});
			expect(scriptRejected).toHaveLength(1);
			expect(scriptRejected[0]).toMatchObject({
				ok: false,
				error: { code: "routeros/invalid-value" },
				meta: {
					operation: {
						stream: { kind: "summary", stopReason: "routeros-error" },
					},
				},
			});
			expect(
				scriptRejected[0]?.meta.validation?.stages?.map(
					(stage) => stage.result,
				),
			).toEqual(["passed", "passed"]);
			const scriptOutput = await collect({
				...nativeBase,
				endpoint: "execute",
				method: "POST",
				fields: {
					script: ':put "status: no such item appears in ordinary output"',
				},
				yes: true,
			});
			expect(scriptOutput.every((e) => e.ok)).toBe(true);
			expect(summaryData(scriptOutput.at(-1)).stopReason).toBe("completed");

			await recordIntegrationEvidence({
				suite: "api --stream against CHR (native-api)",
				command: "api",
				protocol: "native-api",
				routerosVersion: chr.state.version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: [
					...exampleIds(4),
					...[6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
				],
			});
		} finally {
			await chr.destroy();
		}
	}, 180_000);
});
