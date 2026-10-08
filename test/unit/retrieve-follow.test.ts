/**
 * Anchor tests for the `retrieve --follow` engine (`src/retrieve-follow.ts`):
 * the A1 replay order, the sweep's "changed since it was sent" exclusion,
 * projection, bounds and teardown. These are orderings a CHR cannot produce on
 * demand, so a scriptable loopback router stands in. RouterOS *behaviour* (what
 * `listen` sends, the view-menu gap) is grounded on CHR in
 * `test/integration/retrieve-follow.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Socket, TCPSocketListener } from "bun";
import {
	encodeSentence,
	SentenceReader,
} from "../../src/protocols/native-api.ts";
import {
	type RetrieveEnvelope,
	type RetrieveRequest,
	retrieve,
} from "../../src/retrieve.ts";
import { retrieveFanout } from "../../src/retrieve-fanout.ts";
import {
	renderRetrieveFollowLine,
	retrieveFollow,
} from "../../src/retrieve-follow.ts";
import { runCliCaptured } from "./cli-capture.ts";

const ENV = {
	HOME: "/nonexistent-centrs-follow-test",
	CENTRS_SKIP_ENV_FILE: "1",
};

type Row = Record<string, string>;

interface FakeRouterOptions {
	/** `print` takes `follow-only` (default true). */
	followable?: boolean;
	/** Runs when the snapshot `print` arrives, before its rows are sent. */
	onSnapshot?: (router: FakeFollowRouter) => void;
	/** Runs when a sweep arrives; returns the ids the sweep reports. */
	onSweep?: (router: FakeFollowRouter) => string[];
}

/**
 * A loopback native-API router holding one `/ip/address`-like table. It
 * answers login, inspect, `listen`, `print` and `/cancel` like RouterOS does
 * on the wire; table edits announce themselves to open listens unless told not
 * to (the view-menu gap).
 */
class FakeFollowRouter {
	readonly sentences: string[][] = [];
	readonly rows = new Map<string, Row>();
	private readonly listens = new Map<string, string[] | undefined>();
	private socket: Socket<undefined> | undefined;
	private readonly listener: TCPSocketListener<undefined>;

	constructor(private readonly options: FakeRouterOptions = {}) {
		const reader = new SentenceReader();
		this.listener = Bun.listen<undefined>({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open: (socket) => {
					this.socket = socket;
				},
				data: (socket, chunk) => {
					for (const words of reader.push(new Uint8Array(chunk))) {
						if (words.length > 0) this.handle(socket, words);
					}
				},
			},
		});
	}

	get port(): number {
		return this.listener.port;
	}

	stop(): void {
		this.listener.stop(true);
	}

	set(id: string, row: Row, announce = true): void {
		const full = { ".id": id, ...row };
		this.rows.set(id, full);
		if (announce) this.emit(full);
	}

	remove(id: string, announce = true): void {
		this.rows.delete(id);
		if (announce) this.emit({ ".id": id, ".dead": "true" });
	}

	/** Send one `!re` to every open listen, projected by its proplist. */
	emit(row: Row): void {
		for (const [tag, proplist] of this.listens) {
			this.send([
				"!re",
				...attributeWords(project(row, proplist)),
				`.tag=${tag}`,
			]);
		}
	}

	emitEmpty(): void {
		for (const tag of this.listens.keys()) this.send(["!empty", `.tag=${tag}`]);
	}

	commands(): string[] {
		return this.sentences.map((words) => words[0] ?? "");
	}

	private send(words: string[]): void {
		this.socket?.write(encodeSentence(words));
	}

	private handle(_socket: Socket<undefined>, words: string[]): void {
		const command = words[0] ?? "";
		const tag = words.find((w) => w.startsWith(".tag="))?.slice(5) ?? "";
		const attrs = Object.fromEntries(
			words
				.filter((w) => w.startsWith("="))
				.map((w) => {
					const cut = w.indexOf("=", 1);
					return [w.slice(1, cut), w.slice(cut + 1)];
				}),
		);
		const proplist = attrs[".proplist"]?.split(",");
		if (command !== "/login") this.sentences.push(words);
		const done = (): void => this.send(["!done", `.tag=${tag}`]);
		switch (command) {
			case "/login":
				done();
				return;
			case "/console/inspect":
				for (const row of this.inspect(attrs["request"], attrs["path"])) {
					this.send(["!re", ...attributeWords(row), `.tag=${tag}`]);
				}
				done();
				return;
			case "/ip/address/listen":
				this.listens.set(tag, proplist);
				return;
			case "/ip/address/print": {
				let rows = [...this.rows.values()];
				if (attrs[".proplist"] === ".id") {
					const ids = this.options.onSweep?.(this) ?? [...this.rows.keys()];
					rows = ids.map((id) => ({ ".id": id }));
				} else {
					this.options.onSnapshot?.(this);
				}
				for (const row of rows) {
					this.send([
						"!re",
						...attributeWords(project(row, proplist)),
						`.tag=${tag}`,
					]);
				}
				done();
				return;
			}
			case "/cancel": {
				const target = attrs["tag"] ?? "";
				if (this.listens.delete(target)) {
					this.send([
						"!trap",
						"=category=2",
						"=message=interrupted",
						`.tag=${target}`,
					]);
					this.send(["!done", `.tag=${target}`]);
				}
				done();
				return;
			}
			default:
				this.send(["!trap", "=message=no such command", `.tag=${tag}`]);
				done();
				return;
		}
	}

	private inspect(request?: string, path?: string): Row[] {
		if (request === "completion") {
			return ["address", "interface", "comment"].map((completion) => ({
				type: "completion",
				show: "true",
				completion,
			}));
		}
		if (path === "ip,address") {
			return [{ type: "child", name: "print", "node-type": "cmd" }];
		}
		if (path === "ip,address,print") {
			const args = ["proplist", "detail"];
			if (this.options.followable !== false) args.push("follow-only");
			return args.map((name) => ({ type: "child", name, "node-type": "arg" }));
		}
		return [];
	}
}

function attributeWords(row: Row): string[] {
	return Object.entries(row).map(([key, value]) => `=${key}=${value}`);
}

function project(row: Row, proplist: string[] | undefined): Row {
	if (!proplist) return row;
	return Object.fromEntries(
		Object.entries(row).filter(([key]) => proplist.includes(key)),
	);
}

const routers: FakeFollowRouter[] = [];
afterEach(() => {
	while (routers.length > 0) routers.pop()?.stop();
});

function fakeRouter(options?: FakeRouterOptions): FakeFollowRouter {
	const router = new FakeFollowRouter(options);
	router.set("*1", { address: "192.0.2.1/24", comment: "a" }, false);
	router.set("*2", { address: "192.0.2.2/24", comment: "old" }, false);
	routers.push(router);
	return router;
}

function request(
	router: FakeFollowRouter,
	extra: Partial<RetrieveRequest> = {},
): RetrieveRequest {
	return {
		targetInput: "127.0.0.1",
		port: router.port,
		username: "admin",
		password: "",
		path: "/ip/address",
		timeout: "2s",
		...extra,
	};
}

type Stream = NonNullable<
	NonNullable<RetrieveEnvelope["meta"]["operation"]>["stream"]
>;

function dataOf(envelope: RetrieveEnvelope | undefined): unknown {
	return envelope?.ok ? envelope.data : undefined;
}

function streamOf(envelope: RetrieveEnvelope): Stream | undefined {
	return envelope.meta.operation?.stream;
}

/** `phase change id source` for frames, `synced:N` and `summary:<reason>` markers. */
function shape(envelope: RetrieveEnvelope): string {
	const stream = streamOf(envelope);
	switch (stream?.kind) {
		case "frame":
			return `${stream.phase} ${stream.change} ${stream.id} ${stream.source}`;
		case "synced":
			return `synced:${stream.rows}`;
		case "summary":
			return `summary:${stream.stopReason}`;
		case "notice":
			return "notice";
		default:
			return envelope.ok ? "?" : `error:${envelope.error.code}`;
	}
}

/**
 * Run a follow, calling `afterSynced` once `synced` arrives and `onFrame` on
 * each live frame, and collect every envelope.
 */
async function follow(
	req: RetrieveRequest,
	hooks: {
		afterSynced?: () => void;
		signal?: AbortSignal;
		bufferLimit?: number;
	} = {},
): Promise<RetrieveEnvelope[]> {
	const out: RetrieveEnvelope[] = [];
	for await (const envelope of retrieveFollow(req, ENV, {
		signal: hooks.signal,
		bufferLimit: hooks.bufferLimit,
	})) {
		out.push(envelope);
		if (streamOf(envelope)?.kind === "synced") hooks.afterSynced?.();
	}
	return out;
}

describe("retrieveFollow bootstrap (A1)", () => {
	test("replays listen changes received during the snapshot after its rows, then synced", async () => {
		// The print rows are older than the listen changes that arrived first:
		// *2 was updated and *1 deleted while the snapshot was being read.
		const router = fakeRouter({
			onSnapshot: (r) => {
				r.emit({ ".id": "*2", address: "192.0.2.2/24", comment: "new" });
				r.emit({ ".id": "*1", ".dead": "true" });
			},
		});
		const out = await follow(
			request(router, { duration: "300ms", sweep: 0 }),
			{},
		);
		expect(out.map(shape)).toEqual([
			"notice",
			"snapshot upsert *1 print",
			"snapshot upsert *2 print",
			"snapshot upsert *2 listen",
			"snapshot removed *1 listen",
			"synced:1",
			"summary:duration-elapsed",
		]);
		const replayed = out[3];
		expect(dataOf(replayed)).toMatchObject({ comment: "new" });
		// The listen went out before the print, on the same connection.
		expect(router.commands()).toEqual(
			expect.arrayContaining(["/ip/address/listen", "/ip/address/print"]),
		);
		const commands = router.commands();
		expect(commands.indexOf("/ip/address/listen")).toBeLessThan(
			commands.indexOf("/ip/address/print"),
		);
		const summary = out.at(-1);
		expect(dataOf(summary)).toMatchObject({
			frames: 4,
			snapshot: 4,
			changes: 0,
			synced: true,
		});
	});

	test("live changes count toward --count; snapshot frames never do", async () => {
		const router = fakeRouter();
		const out = await follow(
			request(router, { count: 1, duration: "5s", sweep: 0 }),
			{
				afterSynced: () => router.set("*3", { address: "192.0.2.3/24" }),
			},
		);
		expect(
			out.filter((e) => streamOf(e)?.kind !== "notice").map(shape),
		).toEqual([
			"snapshot upsert *1 print",
			"snapshot upsert *2 print",
			"synced:2",
			"live upsert *3 listen",
			"summary:count-reached",
		]);
		expect(dataOf(out.at(-1))).toMatchObject({ snapshot: 2, changes: 1 });
		// The listen was cancelled on the way out.
		expect(router.commands()).toContain("/cancel");
	});

	test("drops a .dead for an id never reported, and ignores !empty", async () => {
		const router = fakeRouter();
		const out = await follow(request(router, { duration: "300ms", sweep: 0 }), {
			afterSynced: () => {
				router.emit({ ".id": "*77", ".dead": "true" });
				router.emitEmpty();
			},
		});
		expect(out.map(shape)).not.toContain("live removed *77 listen");
		expect(dataOf(out.at(-1))).toMatchObject({ changes: 0 });
	});
});

describe("retrieveFollow sweep", () => {
	test("reports a removal RouterOS never sent as source sweep", async () => {
		const router = fakeRouter();
		const out = await follow(
			request(router, { count: 1, duration: "5s", sweep: "50ms" }),
			{
				// A view menu: the row goes away with no `.dead`.
				afterSynced: () => router.remove("*1", false),
			},
		);
		expect(out.map(shape)).toContain("live removed *1 sweep");
		const removed = out.find((e) => shape(e) === "live removed *1 sweep");
		expect(dataOf(removed)).toBeNull();
		expect(dataOf(out.at(-1))).toMatchObject({ stopReason: "count-reached" });
	});

	test("never removes an id that changed after the sweep was sent", async () => {
		// The sweep reads membership, then *9 is created and announced before the
		// sweep's reply: *9 is not in the sweep, but it must not be removed.
		let swept = false;
		const router = fakeRouter({
			onSweep: (r) => {
				const ids = [...r.rows.keys()];
				if (!swept) r.set("*9", { address: "192.0.2.9/24" });
				swept = true;
				return ids;
			},
		});
		const out = await follow(
			request(router, { duration: "400ms", sweep: "50ms" }),
		);
		const shapes = out.map(shape);
		expect(shapes).toContain("live upsert *9 listen");
		expect(shapes).not.toContain("live removed *9 sweep");
		expect((dataOf(out.at(-1)) as { sweeps: number }).sweeps).toBeGreaterThan(
			1,
		);
	});

	test("--sweep 0 sends no sweep and leads with the follow-sweep-off notice", async () => {
		const router = fakeRouter();
		const out = await follow(request(router, { duration: "300ms", sweep: 0 }));
		expect(shape(out[0] as RetrieveEnvelope)).toBe("notice");
		expect(out[0]?.tips.map((tip) => tip.code)).toEqual([
			"tip/follow-sweep-off",
		]);
		expect(out.at(-1)?.tips.map((tip) => tip.code)).toEqual([
			"tip/follow-sweep-off",
		]);
		const prints = router.sentences.filter((w) => w[0] === "/ip/address/print");
		expect(prints).toHaveLength(1);
	});
});

describe("retrieveFollow projection and bounds", () => {
	test("--attributes projects data but keeps the identity in meta", async () => {
		const router = fakeRouter();
		const out = await follow(
			request(router, { attributes: "address", duration: "300ms", sweep: 0 }),
			{ afterSynced: () => router.remove("*2") },
		);
		const listen = router.sentences.find((w) => w[0] === "/ip/address/listen");
		expect(listen).toContain("=.proplist=.id,.dead,address");
		const first = out.find((e) => shape(e) === "snapshot upsert *1 print");
		expect(dataOf(first)).toEqual({ address: "192.0.2.1/24" });
		expect(out.map(shape)).toContain("live removed *2 listen");
	});

	test("ends with transport/stream-overflow instead of dropping changes", async () => {
		const router = fakeRouter({
			onSnapshot: (r) => {
				for (let i = 0; i < 10; i += 1)
					r.emit({ ".id": "*2", comment: `c${i}` });
			},
		});
		const out = await follow(request(router, { duration: "2s", sweep: 0 }), {
			bufferLimit: 3,
		});
		const last = out.at(-1);
		expect(last?.ok).toBe(false);
		if (last && !last.ok) {
			expect(last.error.code).toBe("transport/stream-overflow");
			expect(streamOf(last)).toMatchObject({
				kind: "summary",
				stopReason: "transport-error",
				synced: false,
			});
		}
	});

	test("an abort signal ends with a successful interrupted summary", async () => {
		const router = fakeRouter();
		const controller = new AbortController();
		const out = await follow(request(router, { duration: "5s", sweep: 0 }), {
			signal: controller.signal,
			afterSynced: () => controller.abort(),
		});
		expect(out.at(-1)?.ok).toBe(true);
		expect(shape(out.at(-1) as RetrieveEnvelope)).toBe("summary:interrupted");
	});
});

describe("retrieveFollow refusals", () => {
	test("a menu whose print has no follow-only fails validation/not-followable and sends no listen", async () => {
		const router = fakeRouter({ followable: false });
		const out = await follow(request(router));
		expect(out).toHaveLength(1);
		expect(out[0]?.ok).toBe(false);
		if (out[0] && !out[0].ok) {
			expect(out[0].error.code).toBe("validation/not-followable");
		}
		expect(router.commands()).not.toContain("/ip/address/listen");
	});

	test("via rest-api fails transport/capability-unsupported", async () => {
		const out = await follow({
			targetInput: "127.0.0.1",
			path: "/ip/address",
			via: "rest-api",
		});
		expect(out).toHaveLength(1);
		const [envelope] = out;
		expect(envelope?.ok).toBe(false);
		if (envelope && !envelope.ok) {
			expect(envelope.error.code).toBe("transport/capability-unsupported");
			expect(envelope.meta.via).toBe("rest-api");
		}
	});

	test("follow-only flags without --follow, and follow conflicts, fail before the network", async () => {
		const cases: Array<[Partial<RetrieveRequest>, string]> = [
			[{ follow: false, count: 1 }, "usage/conflicting-flags"],
			[{ follow: false, sweep: "5s" }, "usage/conflicting-flags"],
			[{ listAttributes: true }, "usage/conflicting-flags"],
			[{ maxResultsBytes: 100 }, "usage/conflicting-flags"],
			[{ count: 0 }, "settings/invalid-integer"],
		];
		for (const [extra, code] of cases) {
			const { follow: _ignored, ...rest } = extra;
			const req = { targetInput: "127.0.0.1", path: "/ip/address", ...rest };
			if (extra.follow === false) {
				await expect(retrieve(req, ENV)).rejects.toMatchObject({ code });
			} else {
				const [envelope] = await follow(req);
				expect(envelope?.ok ? undefined : String(envelope?.error.code)).toBe(
					code,
				);
			}
		}
	});
});

describe("one-shot surfaces refuse follow", () => {
	test("retrieve() points at retrieveFollow(); retrieveFanout() refuses to fan out", async () => {
		const req = { targetInput: "127.0.0.1", path: "/ip/address", follow: true };
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

describe("retrieve --follow CLI", () => {
	test("a fan-out selector fails usage/fanout-not-supported", async () => {
		const result = await runCliCaptured([
			"retrieve",
			"10.0.0.1",
			"10.0.0.2",
			"/ip/address",
			"--follow",
			"--json",
		]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("usage/fanout-not-supported");
	});

	test("text lines: frames, synced and summary each stay on one line", async () => {
		const router = fakeRouter();
		const out = await follow(request(router, { duration: "200ms", sweep: 0 }), {
			afterSynced: () => router.remove("*1"),
		});
		const lines = out.map((e) => renderRetrieveFollowLine(e, "text"));
		expect(lines.every((line) => !line.includes("\n"))).toBe(true);
		expect(lines).toContain("— synced: 2 row(s)");
		expect(
			lines.some((l) => /^\d+\tlive\tremoved\t\*1\t\(listen\)$/.test(l)),
		).toBe(true);
		expect(lines.at(-1)).toMatch(
			/^— duration-elapsed: 2 snapshot, 1 change\(s\), 0 sweep\(s\) in \d+ms$/,
		);
		const ndjson = out.map((e) => renderRetrieveFollowLine(e, "yaml"));
		expect(ndjson.every((line) => JSON.parse(line).ok === true)).toBe(true);
	});
});
