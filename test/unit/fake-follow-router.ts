/**
 * A scriptable loopback native-API router for the stream engines that a CHR
 * cannot drive on demand: `retrieve --follow` (`retrieve-follow.test.ts`) and
 * `api --stream` (`api-stream-cli.test.ts`). RouterOS *behaviour* is grounded
 * on CHR in `test/integration/`.
 */

import type { Socket, TCPSocketListener } from "bun";
import {
	encodeSentence,
	SentenceReader,
} from "../../src/protocols/native-api.ts";

export type Row = Record<string, string>;

export interface FakeRouterOptions {
	/** `print` takes `follow-only` (default true). */
	followable?: boolean;
	/** Runs when the snapshot `print` arrives, before its rows are sent. */
	onSnapshot?: (router: FakeFollowRouter) => void;
	/** Runs when a sweep arrives; returns the ids the sweep reports. */
	onSweep?: (router: FakeFollowRouter) => string[];
	/**
	 * Answer every sweep with a non-interrupted `!trap` this many ms late,
	 * after announcing a new row (`*9`) to open listens.
	 */
	sweepTrapAfterMs?: number;
	/** Runs on every `/console/inspect` (live validation). */
	onInspect?: () => void;
	/** A newer wire change before an older membership result is returned. */
	onMembership?: (router: FakeFollowRouter) => void;
	/** Answer `/cancel` but never end the cancelled listen. */
	ignoreCancel?: boolean;
}

/**
 * A loopback native-API router holding one `/ip/address`-like table. It
 * answers login, inspect, `listen`, `print` and `/cancel` like RouterOS does
 * on the wire; table edits announce themselves to open listens unless told not
 * to (the view-menu gap).
 */
export class FakeFollowRouter {
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
				this.options.onInspect?.();
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
				const query = words
					.filter((word) => word.startsWith("?"))
					.map((word) => word.slice(1));
				const membership = query.some((word) => word.startsWith(".id="));
				const trapAfter = this.options.sweepTrapAfterMs;
				if (attrs[".proplist"] === ".id" && trapAfter !== undefined) {
					this.set("*9", { address: "192.0.2.9/24" });
					setTimeout(() => {
						this.send(["!trap", "=message=sweep failed", `.tag=${tag}`]);
						done();
					}, trapAfter);
					return;
				}
				if (attrs[".proplist"] === ".id") {
					const ids = this.options.onSweep?.(this) ?? [...this.rows.keys()];
					rows = ids.map((id) => this.rows.get(id) ?? { ".id": id });
				} else if (membership) {
					this.options.onMembership?.(this);
				} else {
					this.options.onSnapshot?.(this);
				}
				rows = rows.filter((row) => matches(row, query));
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
				if (!this.options.ignoreCancel && this.listens.delete(target)) {
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
		if (path === "ip") {
			return [{ type: "child", name: "address", "node-type": "dir" }];
		}
		if (path === "ip,address") {
			return ["print", "listen"].map((name) => ({
				type: "child",
				name,
				"node-type": "cmd",
			}));
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

/** Test oracle for equality and stack combinations only; CHR proves typing. */
function matches(row: Row, words: string[]): boolean {
	const stack: boolean[] = [];
	for (const word of words) {
		if (word === "#!") stack.push(!stack.pop());
		else if (word === "#&" || word === "#|") {
			const right = stack.pop();
			const left = stack.pop();
			stack.push(
				word === "#&" ? Boolean(left && right) : Boolean(left || right),
			);
		} else {
			const cut = word.indexOf("=");
			stack.push(row[word.slice(0, cut)] === word.slice(cut + 1));
		}
	}
	return stack.every(Boolean);
}
