import { describe, expect, test } from "bun:test";
import { type ApiEnvelope, apiEnvelope, apiListen } from "../../src/api.ts";
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
} {
	if (!envelope?.ok) {
		return {};
	}
	return envelope.data as { stopReason?: string; frames?: number };
}

/** The rest-style record on a success (frame) envelope; `{}` for an error envelope. */
function recordOf(envelope: ApiEnvelope | undefined): Record<string, unknown> {
	return (envelope?.ok ? envelope.data : {}) as Record<string, unknown>;
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
	listenRequest: Parameters<typeof apiListen>[0],
	trigger: () => Promise<void>,
): Promise<ApiEnvelope[]> {
	const envelopes: ApiEnvelope[] = [];
	let signalReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		signalReady = resolve;
	});
	const consumed = (async () => {
		for await (const envelope of apiListen(
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
	test("runs native stream examples L1-L4 and L6-L14", async () => {
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
					endpoint: "ip/address",
					listen: true,
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
				{ ...nativeBase, endpoint: "ip/address", listen: true, duration: "3s" },
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
			const l4: ApiEnvelope[] = [];
			for await (const envelope of apiListen({
				...nativeBase,
				endpoint: "ip/address",
				listen: true,
				duration: "2s",
			})) {
				l4.push(envelope);
			}
			const l4Summary = l4.find((e) => streamKind(e) === "summary");
			expect(l4Summary).toBeDefined();
			expect(summaryData(l4Summary as ApiEnvelope).stopReason).toBe(
				"duration-elapsed",
			);

			async function collect(request: Parameters<typeof apiListen>[0]) {
				const result: ApiEnvelope[] = [];
				for await (const envelope of apiListen(request)) result.push(envelope);
				return result;
			}

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

			// L9. Projection cannot turn a delete into an empty/update-looking row.
			const projectedSeed = await apiEnvelope({
				...restBase,
				endpoint: "ip/address",
				method: "PUT",
				fields: { address: "198.51.100.33/32", interface: "ether1" },
				yes: true,
			});
			expect(projectedSeed.ok).toBe(true);
			const projectedId = idOf(recordOf(projectedSeed));
			const projected = await streamWithTrigger(
				{
					...nativeBase,
					endpoint: "ip/address",
					proplist: ["address"],
					duration: "3s",
				},
				async () => {
					const deleted = await apiEnvelope({
						...restBase,
						endpoint: `ip/address/${projectedId}`,
						method: "DELETE",
						yes: true,
					});
					expect(deleted.ok).toBe(true);
				},
			);
			expect(projected.every((e) => e.ok)).toBe(true);
			expect(
				projected.some(
					(e) =>
						recordOf(e)[".id"] === projectedId &&
						recordOf(e)[".dead"] === "true",
				),
			).toBe(true);

			// L10. Filtering a change subscription fails closed until membership
			// initialization is designed (#396/#397); server queries drop deletes.
			const filtered = await collect({
				...nativeBase,
				endpoint: "ip/address",
				query: ["interface=ether1"],
			});
			expect(filtered).toHaveLength(1);
			expect(filtered[0]).toMatchObject({
				ok: false,
				error: { code: "usage/conflicting-flags" },
			});

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
				exampleIds: [...exampleIds(4), ...[6, 7, 8, 9, 10, 11, 12, 13, 14]],
			});
		} finally {
			await chr.destroy();
		}
	}, 180_000);
});
