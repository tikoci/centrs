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
	test("runs listen examples L1-L4", async () => {
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

			await recordIntegrationEvidence({
				suite: "api --stream against CHR (native-api)",
				command: "api",
				protocol: "native-api",
				routerosVersion: chr.state.version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: exampleIds(4),
			});
		} finally {
			await chr.destroy();
		}
	}, 180_000);
});
