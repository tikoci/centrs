import { describe, expect, test } from "bun:test";
import { createProtocolAdapter } from "../../src/protocols/adapter.ts";
import type { RetrieveEnvelope, RetrieveRequest } from "../../src/retrieve.ts";
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
 * `retrieve --sample` examples SA1–SA6 (`commands/retrieve/examples.md`)
 * against a real CHR, over rest-api (the default) and native-api.
 */

const describeFast = isChrIntegrationEnabled() ? describe : describe.skip;

type Stream = NonNullable<
	NonNullable<RetrieveEnvelope["meta"]["operation"]>["stream"]
>;

function streamOf(envelope: RetrieveEnvelope | undefined): Stream | undefined {
	return envelope?.meta.operation?.stream;
}

function samplesOf(out: readonly RetrieveEnvelope[]) {
	return out.flatMap((envelope) => {
		const stream = streamOf(envelope);
		return stream?.kind === "sample" && envelope.ok
			? [{ ...stream, data: envelope.data }]
			: [];
	});
}

function summaryOf(out: readonly RetrieveEnvelope[]) {
	const stream = streamOf(out.at(-1));
	return stream?.kind === "summary" && "samples" in stream ? stream : undefined;
}

async function sample(
	request: RetrieveRequest,
	onSample?: (index: number) => Promise<void>,
): Promise<RetrieveEnvelope[]> {
	const out: RetrieveEnvelope[] = [];
	for await (const envelope of retrieveSample(request, Bun.env)) {
		out.push(envelope);
		const stream = streamOf(envelope);
		if (stream?.kind === "sample") await onSample?.(stream.index);
	}
	return out;
}

type Row = Record<string, string>;

describeFast("retrieve --sample against CHR", () => {
	test("runs sample examples SA1-SA6", async () => {
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
		try {
			await withBootReadyRetry(() =>
				writer.apiRequest({ verb: "print", path: "/ip/address" }),
			);

			// SA1. Three samples over rest-api, one interval apart.
			for (const [name, base] of [
				["rest-api", rest],
				["native-api", native],
			] as const) {
				const sa1 = await sample({
					...base,
					path: "/ip/address",
					sample: "1s",
					count: 3,
				});
				expect(sa1.every((envelope) => envelope.ok)).toBe(true);
				expect(sa1[0]?.meta.via).toBe(name);
				const lines = samplesOf(sa1);
				expect(lines.map((line) => line.index)).toEqual([1, 2, 3]);
				expect(lines.every((line) => Array.isArray(line.data))).toBe(true);
				const at = lines.map((line) => Date.parse(line.at));
				for (let i = 1; i < at.length; i += 1) {
					expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeGreaterThanOrEqual(990);
				}
				expect(summaryOf(sa1)).toMatchObject({
					stopReason: "count-reached",
					samples: 3,
				});
			}

			// SA2. Counters `listen` never reports: ether1 rx-byte grows across
			// samples (this test's own API traffic arrives on ether1).
			const sa2 = await sample({
				...native,
				path: "/interface",
				attributes: "name,rx-byte",
				sample: "1s",
				count: 3,
			});
			const rx = samplesOf(sa2).map((line) =>
				Number(
					(line.data as Row[]).find((row) => row["name"] === "ether1")?.[
						"rx-byte"
					],
				),
			);
			expect(rx).toHaveLength(3);
			expect(rx.every(Number.isFinite)).toBe(true);
			expect(rx[2] ?? 0).toBeGreaterThan(rx[0] ?? 0);
			const sa2Rows = samplesOf(sa2).flatMap((line) => line.data as Row[]);
			expect(
				sa2Rows.every((row) =>
					Object.keys(row).every((key) => key === "name" || key === "rx-byte"),
				),
			).toBe(true);

			// SA3. A singleton, one --attribute: a bare value per line.
			const sa3 = await sample({
				...rest,
				path: "/system/resource",
				attribute: "uptime",
				sample: "1s",
				count: 2,
			});
			const uptimes = samplesOf(sa3).map((line) => line.data);
			expect(uptimes).toHaveLength(2);
			expect(uptimes.every((value) => typeof value === "string")).toBe(true);
			expect(uptimes[0]).not.toBe(uptimes[1]);

			// SA4. A removal is absence in the next sample.
			const list = "/ip/firewall/address-list";
			const added = String(
				(
					(
						await writer.apiRequest({
							verb: "add",
							path: list,
							attributes: { list: "sa4", address: "198.51.100.44" },
						})
					).data as Row
				)[".id"],
			);
			const sa4 = await sample(
				{
					...native,
					path: list,
					sample: "500ms",
					count: 2,
				},
				async (index) => {
					if (index === 1) {
						await writer.apiRequest({ verb: "remove", path: list, id: added });
					}
				},
			);
			const sa4Ids = samplesOf(sa4).map((line) =>
				(line.data as Row[]).map((row) => row[".id"]),
			);
			expect(sa4Ids[0]).toContain(added);
			expect(sa4Ids[1]).not.toContain(added);

			// SA5. --follow and --sample are exclusive, before any device work.
			const sa5 = await sample({
				...rest,
				path: "/ip/address",
				sample: "1s",
				follow: true,
			});
			expect(sa5).toHaveLength(1);
			expect(sa5[0]?.ok ? "" : sa5[0]?.error.code).toBe(
				"usage/conflicting-flags",
			);

			// SA6. NDJSON is readable before exit; SIGINT ends it with a summary.
			let firstSampleWhileRunning: unknown;
			const sa6 = await runCliProcess({
				args: [
					"retrieve",
					"127.0.0.1",
					"/system/resource",
					"--sample",
					"1s",
					"--via",
					"native-api",
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
					if (firstSampleWhileRunning !== undefined || !line.trim()) return;
					const parsed = JSON.parse(line);
					if (parsed.meta?.operation?.stream?.kind !== "sample") return;
					firstSampleWhileRunning = child.exitCode === null ? parsed : null;
					child.kill("SIGINT");
				},
				killAfterMs: 30_000,
			});
			expect(firstSampleWhileRunning).toMatchObject({ ok: true });
			expect(sa6.exitCode).toBe(0);
			const sa6Last = JSON.parse(
				sa6.stdoutText.trim().split("\n").at(-1) ?? "",
			);
			expect(sa6Last.meta.operation.stream).toMatchObject({
				kind: "summary",
				stopReason: "interrupted",
			});

			await recordIntegrationEvidence({
				suite: "retrieve --sample against CHR",
				command: "retrieve",
				protocol: "rest-api+native-api",
				routerosVersion: chr.state.version,
				quickChrName: chr.name,
				requestedChannel: started.requestedChannel,
				requestedVersion: started.requestedVersion,
				exampleIds: ["SA1", "SA2", "SA3", "SA4", "SA5", "SA6"],
			});
		} finally {
			await writer.close();
			await chr.destroy();
		}
	}, 300_000);
});
