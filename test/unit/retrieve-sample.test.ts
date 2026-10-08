/**
 * Anchor tests for the `retrieve --sample` engine (`src/retrieve-sample.ts`):
 * one line per complete read, start-to-start cadence without overlap, the
 * bounds, and the flag rules. A loopback REST router stands in, because the
 * engine's subject is timing and termination; what RouterOS returns per read
 * is grounded on CHR in `test/integration/retrieve-sample.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
	type RetrieveEnvelope,
	type RetrieveRequest,
	retrieve,
} from "../../src/retrieve.ts";
import { retrieveFanout } from "../../src/retrieve-fanout.ts";
import { retrieveSample } from "../../src/retrieve-sample.ts";
import { renderRetrieveStreamLine } from "../../src/retrieve-stream.ts";
import { runCliCaptured } from "./cli-capture.ts";

const ENV = {
	HOME: "/nonexistent-centrs-sample-test",
	CENTRS_SKIP_ENV_FILE: "1",
};

type Row = Record<string, string>;

/**
 * A loopback RouterOS REST endpoint with one list menu (`/ip/address`) and
 * one singleton (`/system/resource`). It records when each data read starts
 * and ends, so a test can check cadence and overlap.
 */
class FakeRestRouter {
	rows: Row[] = [
		{ ".id": "*1", address: "192.0.2.1/24" },
		{ ".id": "*2", address: "192.0.2.2/24" },
	];
	uptime = 0;
	/** Delay before each data read answers. */
	readDelayMs = 0;
	/** Answer the Nth data read (1-based) with a RouterOS error. */
	failRead: number | undefined;
	readonly reads: Array<{ start: number; end: number }> = [];
	/** Data reads whose client went away before the answer. */
	aborted = 0;
	private inFlight = 0;
	maxInFlight = 0;
	private readonly server: Server<undefined>;

	constructor() {
		this.server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (req) => this.handle(req),
		});
	}

	get port(): number {
		return this.server.port ?? 0;
	}

	stop(): void {
		this.server.stop(true);
	}

	private async handle(req: Request): Promise<Response> {
		const path = new URL(req.url).pathname.replace(/^\/rest/, "");
		if (path === "/console/inspect") {
			const body = (await req.json()) as { request: string; path: string };
			return Response.json(inspect(body.request, body.path));
		}
		const start = performance.now();
		this.inFlight += 1;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			if (this.readDelayMs > 0) await Bun.sleep(this.readDelayMs);
			if (req.signal.aborted) this.aborted += 1;
			if (this.failRead === this.reads.length + 1) {
				return Response.json(
					{ error: 400, message: "Bad Request", detail: "no such item" },
					{ status: 400 },
				);
			}
			if (path === "/system/resource") {
				this.uptime += 1;
				return Response.json({ uptime: `${this.uptime}s`, "cpu-load": "3" });
			}
			if (path === "/ip/address/print") {
				const body = (await req.json()) as { ".proplist"?: string[] };
				const keep = body[".proplist"] ?? [];
				return Response.json(
					this.rows.map((row) =>
						Object.fromEntries(
							Object.entries(row).filter(([key]) => keep.includes(key)),
						),
					),
				);
			}
			return Response.json(this.rows);
		} finally {
			this.inFlight -= 1;
			this.reads.push({ start, end: performance.now() });
		}
	}
}

/** `/console/inspect` for the two menus, shaped like RouterOS's replies. */
function inspect(request: string, path: string): unknown[] {
	const cmd = (name: string) => ({ name, "node-type": "cmd", type: "child" });
	const arg = (name: string) => ({ name, "node-type": "arg", type: "child" });
	if (request === "completion") {
		return path === "system,resource,get,value-name"
			? ["uptime", "cpu-load"].map((completion) => ({
					completion,
					show: "true",
					style: "none",
				}))
			: [{ completion: "address", show: "true", style: "none" }];
	}
	switch (path) {
		case "ip,address":
			return [cmd("print"), cmd("get")];
		case "ip,address,get":
			return [arg("number"), arg("value-name")];
		case "system,resource":
			return [cmd("print"), cmd("get")];
		case "system,resource,get":
			return [arg("value-name")];
		default:
			return [];
	}
}

const routers: FakeRestRouter[] = [];
afterEach(() => {
	while (routers.length > 0) routers.pop()?.stop();
});

function fakeRouter(): FakeRestRouter {
	const router = new FakeRestRouter();
	routers.push(router);
	return router;
}

function request(
	router: FakeRestRouter,
	extra: Partial<RetrieveRequest> = {},
): RetrieveRequest {
	return {
		targetInput: "127.0.0.1",
		port: router.port,
		username: "admin",
		password: "",
		path: "/ip/address",
		timeout: "2s",
		sample: "50ms",
		...extra,
	};
}

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
	req: RetrieveRequest,
	hooks: {
		signal?: AbortSignal;
		onSample?: (index: number) => void;
	} = {},
): Promise<RetrieveEnvelope[]> {
	const out: RetrieveEnvelope[] = [];
	for await (const envelope of retrieveSample(req, ENV, {
		signal: hooks.signal,
	})) {
		out.push(envelope);
		const stream = streamOf(envelope);
		if (stream?.kind === "sample") hooks.onSample?.(stream.index);
	}
	return out;
}

describe("retrieveSample lines", () => {
	test("--count N gives N complete reads, each the whole table, then a summary", async () => {
		const router = fakeRouter();
		const out = await sample(request(router, { count: 3 }), {
			onSample: (index) => {
				if (index === 1) router.rows = router.rows.slice(1);
				if (index === 2) router.rows = [];
			},
		});
		const lines = samplesOf(out);
		expect(lines.map((line) => line.index)).toEqual([1, 2, 3]);
		expect(lines.map((line) => (line.data as Row[]).length)).toEqual([2, 1, 0]);
		// A zero-row read is a complete observation: `data: []`, counted.
		expect(lines[2]?.data).toEqual([]);
		for (const line of lines) {
			expect(Number.isNaN(Date.parse(line.at))).toBe(false);
			expect(line.readMs).toBeGreaterThanOrEqual(0);
		}
		expect(out[0]?.meta.via).toBe("rest-api");
		expect(out[0]?.meta.operation?.objectCount).toBe(2);
		expect(summaryOf(out)).toMatchObject({
			kind: "summary",
			stopReason: "count-reached",
			samples: 3,
		});
		expect(out.at(-1)?.ok).toBe(true);
		expect(out).toHaveLength(4);
	});

	test("a singleton yields its record per line; one --attribute yields the bare value", async () => {
		const router = fakeRouter();
		const out = await sample(
			request(router, { path: "/system/resource", count: 2 }),
		);
		expect(samplesOf(out).map((line) => line.data)).toEqual([
			{ uptime: "1s", "cpu-load": "3" },
			{ uptime: "2s", "cpu-load": "3" },
		]);
		const scalar = await sample(
			request(router, {
				path: "/system/resource",
				count: 2,
				attribute: "uptime",
			}),
		);
		expect(samplesOf(scalar).map((line) => line.data)).toEqual(["3s", "4s"]);
	});

	test("--attributes projects every sample", async () => {
		const router = fakeRouter();
		const out = await sample(
			request(router, { count: 1, attributes: "address" }),
		);
		expect(samplesOf(out)[0]?.data).toEqual([
			{ address: "192.0.2.1/24" },
			{ address: "192.0.2.2/24" },
		]);
	});
});

describe("retrieveSample cadence", () => {
	test("reads start one interval apart", async () => {
		const router = fakeRouter();
		await sample(request(router, { sample: "120ms", count: 3 }));
		const reads = router.reads.map((read) => read.start);
		expect(reads).toHaveLength(3);
		for (let i = 1; i < reads.length; i++) {
			const gap = (reads[i] ?? 0) - (reads[i - 1] ?? 0);
			expect(gap).toBeGreaterThanOrEqual(110);
			expect(gap).toBeLessThan(400);
		}
	});

	test("a read slower than the interval delays the next one, never overlaps it", async () => {
		const router = fakeRouter();
		router.readDelayMs = 80;
		await sample(request(router, { sample: "10ms", count: 4 }));
		expect(router.maxInFlight).toBe(1);
		expect(router.reads).toHaveLength(4);
		for (let i = 1; i < router.reads.length; i++) {
			expect(router.reads[i]?.start ?? 0).toBeGreaterThanOrEqual(
				router.reads[i - 1]?.end ?? 0,
			);
		}
	});
});

describe("retrieveSample memory", () => {
	test("a long run keeps a bounded number of pending promises", async () => {
		const { heapStats } = await import("bun:jsc");
		const router = fakeRouter();
		const pending = (): number => {
			Bun.gc(true);
			const counts = heapStats().objectTypeCounts;
			return (counts["Promise"] ?? 0) + (counts["SlimPromiseReaction"] ?? 0);
		};
		const at = new Map<number, number>();
		for await (const envelope of retrieveSample(
			request(router, { sample: "1ms", count: 1500 }),
			ENV,
		)) {
			const stream = streamOf(envelope);
			if (stream?.kind === "sample" && [300, 1500].includes(stream.index)) {
				at.set(stream.index, pending());
			}
		}
		// Racing each sample against one long-lived stop promise retained about
		// two objects per sample (#411 review): ~2,400 more here.
		expect((at.get(1500) ?? 0) - (at.get(300) ?? 0)).toBeLessThan(300);
	}, 30_000);
});

describe("retrieveSample bounds", () => {
	test("--duration ends the run; a read still in flight is not a sample", async () => {
		const router = fakeRouter();
		router.readDelayMs = 400;
		const out = await sample(request(router, { duration: "100ms" }));
		expect(samplesOf(out)).toHaveLength(0);
		expect(summaryOf(out)).toMatchObject({
			stopReason: "duration-elapsed",
			samples: 0,
		});
		expect(summaryOf(out)?.durationMs).toBeLessThan(400);
	});

	test("a stop aborts the REST read in flight instead of leaving it running", async () => {
		const router = fakeRouter();
		router.readDelayMs = 300;
		await sample(request(router, { duration: "50ms" }));
		await Bun.sleep(400);
		expect(router.reads).toHaveLength(1);
		expect(router.aborted).toBe(1);
	});

	test("an abort signal ends with a successful interrupted summary", async () => {
		const router = fakeRouter();
		const controller = new AbortController();
		const out = await sample(request(router), {
			onSample: (index) => {
				if (index === 2) controller.abort();
			},
			signal: controller.signal,
		});
		expect(samplesOf(out)).toHaveLength(2);
		expect(summaryOf(out)).toMatchObject({
			stopReason: "interrupted",
			samples: 2,
		});
		expect(out.at(-1)?.ok).toBe(true);
	});

	test("a signal aborted before the call reads nothing", async () => {
		const router = fakeRouter();
		const controller = new AbortController();
		controller.abort();
		const out = await sample(request(router), { signal: controller.signal });
		expect(router.reads).toHaveLength(0);
		expect(out).toHaveLength(1);
		expect(summaryOf(out)).toMatchObject({
			stopReason: "interrupted",
			samples: 0,
		});
	});

	test("a failed read ends with one failed summary carrying the partial count", async () => {
		const router = fakeRouter();
		router.failRead = 3;
		const out = await sample(request(router, { count: 5 }));
		expect(samplesOf(out)).toHaveLength(2);
		const last = out.at(-1);
		expect(last?.ok).toBe(false);
		const stream = streamOf(last);
		expect(stream?.kind === "summary" && "samples" in stream).toBe(true);
		expect(stream).toMatchObject({ samples: 2 });
		expect(["routeros-error", "transport-error"]).toContain(
			stream?.kind === "summary" ? stream.stopReason : "",
		);
	});
});

describe("retrieveSample refusals", () => {
	test("an unknown attribute fails validation once, with no summary and no read", async () => {
		const router = fakeRouter();
		const out = await sample(request(router, { attributes: "nosuch" }));
		expect(out).toHaveLength(1);
		expect(out[0]?.ok ? "" : out[0]?.error.code).toBe(
			"validation/unknown-attribute",
		);
		expect(router.reads).toHaveLength(0);
	});

	test("flag rules fail before the network", async () => {
		const cases: Array<[Partial<RetrieveRequest>, string]> = [
			[{ follow: true }, "usage/conflicting-flags"],
			[{ sweep: "5s" }, "usage/conflicting-flags"],
			[{ listAttributes: true }, "usage/conflicting-flags"],
			[{ maxResultsBytes: 100 }, "usage/conflicting-flags"],
			[{ count: 0 }, "settings/invalid-integer"],
			// A bare number is refused: RouterOS reads it as seconds, centrs as ms.
			[{ sample: "5" }, "settings/invalid-timeout"],
			[{ sample: "0s" }, "settings/invalid-timeout"],
			[{ sample: "soon" }, "settings/invalid-timeout"],
		];
		for (const [extra, code] of cases) {
			const out = await sample({
				targetInput: "127.0.0.1",
				path: "/ip/address",
				sample: "1s",
				...extra,
			});
			expect(out).toHaveLength(1);
			expect(out[0]?.ok ? "" : out[0]?.error.code).toBe(code);
		}
	});

	test("--count and --duration without --follow or --sample name both", async () => {
		await expect(
			retrieve(
				{ targetInput: "127.0.0.1", path: "/ip/address", count: 1 },
				ENV,
			),
		).rejects.toMatchObject({
			code: "usage/conflicting-flags",
			summary: "`--count` only applies to `--follow` or `--sample`.",
		});
	});

	test("retrieve() points at retrieveSample(); retrieveFanout() refuses to fan out", async () => {
		const req = {
			targetInput: "127.0.0.1",
			path: "/ip/address",
			sample: "5s",
		};
		await expect(retrieve(req, ENV)).rejects.toMatchObject({
			code: "input/invalid-command",
		});
		await expect(
			retrieveFanout(
				req,
				{
					positionals: ["10.0.0.1", "10.0.0.2"],
					groups: [],
					all: false,
					default: false,
					where: [],
				},
				ENV,
			),
		).rejects.toMatchObject({ code: "usage/fanout-not-supported" });
	});
});

describe("retrieve --sample CLI", () => {
	test("a fan-out selector fails usage/fanout-not-supported", async () => {
		const result = await runCliCaptured([
			"retrieve",
			"10.0.0.1",
			"10.0.0.2",
			"/ip/address",
			"--sample",
			"5s",
			"--json",
		]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("usage/fanout-not-supported");
	});

	test("NDJSON: one envelope per line, the summary last", async () => {
		const router = fakeRouter();
		const result = await runCliCaptured([
			"retrieve",
			"127.0.0.1",
			"/ip/address",
			"--port",
			String(router.port),
			"--username",
			"admin",
			"--password",
			"",
			"--sample",
			"20ms",
			"--count",
			"2",
			"--format",
			"ndjson",
		]);
		expect(result.code).toBe(0);
		const lines = result.out.split("\n").map((line) => JSON.parse(line));
		expect(lines.map((line) => line.meta.operation.stream.kind)).toEqual([
			"sample",
			"sample",
			"summary",
		]);
	});

	test("text lines: one per sample and one summary", async () => {
		const router = fakeRouter();
		const out = await sample(request(router, { count: 2 }));
		const lines = out.map((e) => renderRetrieveStreamLine(e, "text"));
		expect(lines.every((line) => !line.includes("\n"))).toBe(true);
		expect(lines[0]).toMatch(/^1\t\d{4}-\d\d-\d\dT[^\t]+\t\[\{".id":"\*1"/);
		expect(lines.at(-1)).toMatch(/^— count-reached: 2 sample\(s\) in \d+ms$/);
	});
});
