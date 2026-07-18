/**
 * Cross-transport parity harness (#129).
 *
 * The `rest-api` and `native-api` adapters implement the same logical
 * operations with different wire idioms; when one drifts (e.g. the native
 * `execute` path once missed `as-string` while REST sent it — #125), nothing
 * noticed until CHR. This harness gives that divergence class systematic
 * unit-tier coverage:
 *
 * 1. **Wire parity** — run the same {@link ProtocolAdapter} operation through
 *    both adapters against fakes, then normalize each transport's captured
 *    wire traffic into a {@link LogicalOp} and assert the two are deep-equal.
 *    The normalizers encode the *intended* transport-idiom equivalences
 *    documented in `src/protocols/adapter.ts` (REST `.query` word ↔ native
 *    `?`-word, REST id-in-URL ↔ native `=.id=`/`?.id=`, REST `detail:"true"`
 *    ↔ native `=detail=` flag, `/execute` + `as-string` on both).
 * 2. **Result parity** — feed each transport an equivalent canned reply and
 *    assert the adapters surface identical data.
 *
 * The REST side captures `fetch`; the native side runs the real
 * `connectNativeApi` TCP path against {@link FakeNativeApiServer}, a loopback
 * canned-reply endpoint that answers the modern `/login` and records every
 * subsequent sentence. The fake speaks only the wire encoding (via the real
 * `encodeSentence`/`SentenceReader`) — RouterOS *behavior* stays grounded on
 * CHR in the integration tier.
 */

import type { TCPSocketListener } from "bun";
import {
	createProtocolAdapter,
	type ProtocolAdapter,
} from "../../src/index.ts";
import {
	encodeSentence,
	SentenceReader,
} from "../../src/protocols/native-api.ts";

/** A transport-neutral description of one RouterOS operation on the wire. */
export interface LogicalOp {
	/** Slash menu path with the trailing verb segment removed. */
	path: string;
	/** Final path segment (`print`, `add`, …) or the synthetic `script` verb. */
	verb: string;
	/** Attribute name→value pairs; flag-like attributes normalize to `true`. */
	attributes: Record<string, string | true>;
	/**
	 * Addressed row id (`*1`). One logical slot across the transports' three
	 * spellings — REST id-in-URL or a folded `.id=` `.query` word, native
	 * `=.id=`/`?.id=` — lifted out of `filters` because the *fold position*
	 * differs by design (REST folds it first, native appends it last).
	 */
	id?: string;
	/** Query/filter words in wire order, without the native `?` prefix. */
	filters: string[];
	/** Property projection, as a list. */
	proplist: string[];
}

function splitVerb(path: string): { path: string; verb: string } {
	const trimmed = path.replace(/\/$/, "");
	const cut = trimmed.lastIndexOf("/");
	return { path: trimmed.slice(0, cut) || "/", verb: trimmed.slice(cut + 1) };
}

/**
 * Attributes whose REST and native spellings differ only in how "enabled" is
 * written (REST JSON needs a value, native uses an empty attribute word).
 * Normalized to `true` when enabled either way.
 */
const FLAG_ATTRIBUTES = new Set(["detail", "as-string"]);

function normalizeAttribute(
	name: string,
	value: string,
): [string, string | true] {
	if (FLAG_ATTRIBUTES.has(name) && (value === "" || value === "true")) {
		return [name, true];
	}
	return [name, value];
}

// ── native capture ───────────────────────────────────────────────────────────

/** One scripted reply: sentences (word lists, `.tag=` appended automatically). */
export type ScriptedReply = string[][];

/**
 * Loopback native-api endpoint. Answers `/login` with a bare `!done` (modern
 * plaintext login) and every later command sentence with the next scripted
 * reply (default: `[["!done"]]`), recording the command sentences it saw.
 */
export class FakeNativeApiServer {
	/** Every non-login sentence received, in arrival order (without `.tag=`). */
	readonly sentences: string[][] = [];
	private readonly replies: ScriptedReply[];
	private readonly listener: TCPSocketListener;

	constructor(replies: readonly ScriptedReply[] = []) {
		this.replies = [...replies];
		this.listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data: (socket, chunk) => {
					const reader = socketReaders.get(socket) ?? new SentenceReader();
					socketReaders.set(socket, reader);
					for (const words of reader.push(new Uint8Array(chunk))) {
						this.handleSentence(socket, words);
					}
				},
			},
		});
	}

	get port(): number {
		return this.listener.port;
	}

	close(): void {
		this.listener.stop(true);
	}

	private handleSentence(
		socket: { write(data: Uint8Array): number },
		words: string[],
	): void {
		const tag = words
			.find((word) => word.startsWith(".tag="))
			?.slice(".tag=".length);
		const payload = words.filter((word) => !word.startsWith(".tag="));
		const reply: ScriptedReply =
			payload[0] === "/login"
				? [["!done"]]
				: (this.recordAndPick(payload) ?? [["!done"]]);
		for (const sentence of reply) {
			const tagged =
				tag !== undefined ? [...sentence, `.tag=${tag}`] : sentence;
			socket.write(encodeSentence(tagged));
		}
	}

	private recordAndPick(payload: string[]): ScriptedReply | undefined {
		this.sentences.push(payload);
		return this.replies.shift();
	}
}

const socketReaders = new WeakMap<object, SentenceReader>();

export interface NativeCapture<T> {
	/** Non-login command sentences the fake server received. */
	sentences: string[][];
	result: T;
}

/**
 * Run one operation through a real native-api adapter (TCP loopback against
 * {@link FakeNativeApiServer}) and capture the wire sentences + result.
 */
export async function captureNative<T>(
	replies: readonly ScriptedReply[],
	op: (adapter: ProtocolAdapter) => Promise<T>,
): Promise<NativeCapture<T>> {
	const server = new FakeNativeApiServer(replies);
	const adapter = createProtocolAdapter({
		protocol: "native-api",
		host: "127.0.0.1",
		port: server.port,
		tls: false,
		baseUrl: `api://127.0.0.1:${server.port}`,
		username: "admin",
		password: "",
		timeoutMs: 5_000,
	});
	try {
		const result = await op(adapter);
		return { sentences: server.sentences, result };
	} finally {
		await adapter.close();
		server.close();
	}
}

/** Normalize one captured native command sentence into a {@link LogicalOp}. */
export function logicalFromNative(words: readonly string[]): LogicalOp {
	const [command, ...rest] = words;
	if (command === undefined) {
		throw new Error("empty native sentence");
	}
	const op: LogicalOp =
		command === "/execute"
			? { path: "/", verb: "script", attributes: {}, filters: [], proplist: [] }
			: { ...splitVerb(command), attributes: {}, filters: [], proplist: [] };
	for (const word of rest) {
		if (word.startsWith("?")) {
			const filter = word.slice(1);
			if (filter.startsWith(".id=")) {
				op.id = filter.slice(".id=".length);
				continue;
			}
			op.filters.push(filter);
			continue;
		}
		if (word.startsWith("=")) {
			const cut = word.indexOf("=", 1);
			const name = word.slice(1, cut);
			const value = word.slice(cut + 1);
			if (name === ".proplist") {
				op.proplist = value.split(",");
				continue;
			}
			if (name === ".id") {
				op.id = value;
				continue;
			}
			const [key, normalized] = normalizeAttribute(name, value);
			op.attributes[key] = normalized;
			continue;
		}
		throw new Error(`unexpected native word: ${word}`);
	}
	return op;
}

// ── REST capture ─────────────────────────────────────────────────────────────

export interface RestCall {
	method: string;
	/** URL path relative to the `/rest` base. */
	path: string;
	body?: Record<string, unknown>;
}

export interface RestCapture<T> {
	calls: RestCall[];
	result: T;
}

const REST_BASE = "http://192.0.2.10:80/rest";

/**
 * Run one operation through a REST adapter with `fetch` mocked to the given
 * responses (one per expected call) and capture method/path/body + result.
 */
export async function captureRest<T>(
	responses: readonly unknown[],
	op: (adapter: ProtocolAdapter) => Promise<T>,
): Promise<RestCapture<T>> {
	const calls: RestCall[] = [];
	const queue = [...responses];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		if (!url.startsWith(REST_BASE)) {
			throw new Error(`unexpected fetch outside the REST base: ${url}`);
		}
		calls.push({
			method: init?.method ?? "GET",
			path: url.slice(REST_BASE.length),
			body:
				init?.body === undefined
					? undefined
					: (JSON.parse(String(init.body)) as Record<string, unknown>),
		});
		if (queue.length === 0) {
			throw new Error(`unexpected REST call: ${url}`);
		}
		return new Response(JSON.stringify(queue.shift()), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
	try {
		const adapter = createProtocolAdapter({
			protocol: "rest-api",
			host: "192.0.2.10",
			port: 80,
			tls: false,
			baseUrl: REST_BASE,
			username: "admin",
			password: "",
			timeoutMs: 5_000,
		});
		const result = await op(adapter);
		await adapter.close();
		return { calls, result };
	} finally {
		globalThis.fetch = originalFetch;
	}
}

function asStringRecord(
	body: Record<string, unknown> | undefined,
): Record<string, string> {
	const record: Record<string, string> = {};
	for (const [key, value] of Object.entries(body ?? {})) {
		record[key] = String(value);
	}
	return record;
}

/** Normalize one captured REST call into a {@link LogicalOp}. */
export function logicalFromRest(call: RestCall): LogicalOp {
	const op: LogicalOp = {
		path: "/",
		verb: "print",
		attributes: {},
		filters: [],
		proplist: [],
	};
	const segments = splitVerb(call.path);
	const idTail = /^\*[0-9A-F]+$/i.test(segments.verb) ? segments : undefined;

	if (call.method === "GET") {
		// GET <path> reads a menu/singleton (native: <path>/print); a trailing
		// `*id` addresses one row (native: `?.id=`).
		if (idTail) {
			op.path = idTail.path;
			op.id = idTail.verb;
		} else {
			op.path = call.path.replace(/\/$/, "") || "/";
		}
		return op;
	}
	if (call.method === "PUT") {
		op.path = call.path;
		op.verb = "add";
		op.attributes = normalizeAttributes(call.body);
		return op;
	}
	if (call.method === "PATCH" || call.method === "DELETE") {
		if (!idTail) {
			throw new Error(`expected an id-in-URL for ${call.method} ${call.path}`);
		}
		op.path = idTail.path;
		op.verb = call.method === "PATCH" ? "set" : "remove";
		op.attributes = normalizeAttributes(call.body);
		op.id = idTail.verb;
		return op;
	}
	// POST: /execute script, <path>/print projection, or a generic command.
	if (call.path === "/execute") {
		op.verb = "script";
		op.attributes = normalizeAttributes(call.body);
		return op;
	}
	op.path = segments.path;
	op.verb = segments.verb;
	const body = call.body ?? {};
	for (const [key, value] of Object.entries(body)) {
		if (key === ".query" && Array.isArray(value)) {
			for (const word of value.map(String)) {
				if (word.startsWith(".id=")) {
					op.id = word.slice(".id=".length);
					continue;
				}
				op.filters.push(word);
			}
			continue;
		}
		if (key === ".proplist" && Array.isArray(value)) {
			op.proplist = value.map(String);
			continue;
		}
		const [name, normalized] = normalizeAttribute(key, String(value));
		op.attributes[name] = normalized;
	}
	return op;
}

function normalizeAttributes(
	body: Record<string, unknown> | undefined,
): Record<string, string | true> {
	const attributes: Record<string, string | true> = {};
	for (const [key, value] of Object.entries(asStringRecord(body))) {
		const [name, normalized] = normalizeAttribute(key, value);
		attributes[name] = normalized;
	}
	return attributes;
}
