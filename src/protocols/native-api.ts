/**
 * RouterOS native API protocol (the binary "api" service).
 *
 * Transport-side base for the `native-api` protocol id. This module is split
 * into three layers so each is independently testable:
 *
 * 1. Pure **codec** — variable-length word framing, sentence framing, and
 *    reply parsing. No IO; fully unit-testable with byte vectors.
 * 2. A **session** (`NativeApiSession`) driven over an injectable byte stream
 *    (`NativeApiByteSink`), so scripted server bytes can drive it in tests and
 *    a real socket drives it in integration.
 * 3. A thin **TCP/TLS adapter** (`connectNativeApi`) built on `Bun.connect`.
 *
 * Wire format grounded against the MikroTik wiki API page and the canonical
 * `go-routeros` and `librouteros` implementations. Default ports: 8728 (plain),
 * 8729 (api-ssl / TLS).
 *
 * Selection rules live in `docs/CONSTITUTION.md`; per-cell status in
 * `docs/MATRIX.md`.
 */

import { createHash } from "node:crypto";
import { mapRouterOsError } from "../core/routeros-errors.ts";
import { CentrsError } from "../errors.ts";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Default plaintext native-api TCP port. */
export const NATIVE_API_PORT = 8728;
/** Default api-ssl (TLS) native-api TCP port. */
export const NATIVE_API_TLS_PORT = 8729;

/**
 * Encode a word length using RouterOS's variable-length big-endian scheme.
 *
 * | length range        | bytes | leading mask |
 * | ------------------- | ----- | ------------ |
 * | `< 0x80`            | 1     | `0xxxxxxx`   |
 * | `< 0x4000`          | 2     | `10xxxxxx`   |
 * | `< 0x200000`        | 3     | `110xxxxx`   |
 * | `< 0x10000000`      | 4     | `1110xxxx`   |
 * | `>= 0x10000000`     | 5     | `0xF0` + raw |
 */
export function encodeLength(length: number): Uint8Array {
	if (!Number.isInteger(length) || length < 0) {
		throw new CentrsError({
			code: "internal/native-api-length",
			summary: `Cannot encode a negative or non-integer word length (${length}).`,
			remediation:
				"This is a centrs bug; report it with the command that triggered it.",
		});
	}
	if (length > 0xffffffff) {
		throw new CentrsError({
			code: "internal/native-api-length",
			summary: `Word length ${length} exceeds the 32-bit RouterOS API limit.`,
			remediation:
				"This is a centrs bug; report it with the command that triggered it.",
		});
	}
	if (length < 0x80) {
		return Uint8Array.of(length);
	}
	if (length < 0x4000) {
		return Uint8Array.of((length >> 8) | 0x80, length & 0xff);
	}
	if (length < 0x200000) {
		return Uint8Array.of(
			(length >> 16) | 0xc0,
			(length >> 8) & 0xff,
			length & 0xff,
		);
	}
	if (length < 0x10000000) {
		return Uint8Array.of(
			(length >> 24) | 0xe0,
			(length >> 16) & 0xff,
			(length >> 8) & 0xff,
			length & 0xff,
		);
	}
	return Uint8Array.of(
		0xf0,
		(length >>> 24) & 0xff,
		(length >> 16) & 0xff,
		(length >> 8) & 0xff,
		length & 0xff,
	);
}

export interface DecodedLength {
	/** Decoded length value. */
	value: number;
	/** Number of prefix bytes consumed. */
	size: number;
}

/**
 * Decode a variable-length prefix starting at `offset`.
 *
 * Returns `null` when the buffer does not yet hold the full prefix (the caller
 * should wait for more bytes). Throws on an invalid leading byte.
 */
export function decodeLength(
	buffer: Uint8Array,
	offset = 0,
): DecodedLength | null {
	if (offset >= buffer.length) {
		return null;
	}
	const b0 = buffer[offset] as number;
	let size: number;
	let value: number;
	if ((b0 & 0x80) === 0x00) {
		return { value: b0, size: 1 };
	}
	if ((b0 & 0xc0) === 0x80) {
		size = 2;
		value = b0 & 0x3f;
	} else if ((b0 & 0xe0) === 0xc0) {
		size = 3;
		value = b0 & 0x1f;
	} else if ((b0 & 0xf0) === 0xe0) {
		size = 4;
		value = b0 & 0x0f;
	} else if ((b0 & 0xf8) === 0xf0) {
		size = 5;
		value = 0;
	} else {
		throw new CentrsError({
			code: "routeros/api-protocol",
			summary: `Invalid RouterOS API length descriptor 0x${b0.toString(16)}.`,
			remediation:
				"The byte stream is corrupt or not a RouterOS API service; confirm the target port speaks the native API.",
		});
	}
	if (offset + size > buffer.length) {
		return null;
	}
	for (let index = 1; index < size; index += 1) {
		value = (value << 8) | (buffer[offset + index] as number);
	}
	return { value: value >>> 0, size };
}

/** Encode a single word: length prefix followed by its UTF-8 bytes. */
export function encodeWord(word: string): Uint8Array {
	const payload = utf8Encoder.encode(word);
	const prefix = encodeLength(payload.length);
	const out = new Uint8Array(prefix.length + payload.length);
	out.set(prefix, 0);
	out.set(payload, prefix.length);
	return out;
}

/** Encode a sentence: each word framed, terminated by a zero-length word. */
export function encodeSentence(words: readonly string[]): Uint8Array {
	const parts = words.map(encodeWord);
	const total = parts.reduce((sum, part) => sum + part.length, 0) + 1;
	const out = new Uint8Array(total);
	let cursor = 0;
	for (const part of parts) {
		out.set(part, cursor);
		cursor += part.length;
	}
	out[cursor] = 0x00; // zero-length terminator word
	return out;
}

/**
 * Incremental sentence reader. Accumulates TCP chunks and yields whole
 * sentences (arrays of decoded words) as they complete. Partial words and
 * partial length prefixes are buffered until the rest of the bytes arrive.
 */
export class SentenceReader {
	private buffer: Uint8Array = new Uint8Array(0);
	private current: string[] = [];

	/** Push a chunk and return any sentences completed by it. */
	push(chunk: Uint8Array): string[][] {
		if (chunk.length > 0) {
			const next = new Uint8Array(this.buffer.length + chunk.length);
			next.set(this.buffer, 0);
			next.set(chunk, this.buffer.length);
			this.buffer = next;
		}

		const sentences: string[][] = [];
		let offset = 0;
		for (;;) {
			const header = decodeLength(this.buffer, offset);
			if (header === null) {
				break;
			}
			const wordStart = offset + header.size;
			const wordEnd = wordStart + header.value;
			if (header.value > 0 && wordEnd > this.buffer.length) {
				break; // word body not fully buffered yet
			}
			offset = wordEnd;
			if (header.value === 0) {
				sentences.push(this.current);
				this.current = [];
				continue;
			}
			this.current.push(
				utf8Decoder.decode(this.buffer.subarray(wordStart, wordEnd)),
			);
		}

		if (offset > 0) {
			this.buffer = this.buffer.subarray(offset);
		}
		return sentences;
	}

	/** Bytes buffered but not yet consumed into a completed sentence. */
	get pending(): number {
		return this.buffer.length;
	}
}

export type ApiReplyType = "!re" | "!done" | "!trap" | "!fatal" | "!empty";

export interface ApiReply {
	/** Reply tag word (`!re`, `!done`, `!trap`, `!fatal`, `!empty`). */
	type: ApiReplyType;
	/** `=name=value` attribute words, keyed by name. */
	attributes: Record<string, string>;
	/** `.tag=` multiplexing tag, when present. */
	tag?: string;
	/** Raw words exactly as received, including the leading reply word. */
	words: readonly string[];
}

/** Parse a raw sentence (array of words) into a structured reply. */
export function parseReply(words: readonly string[]): ApiReply {
	const head = words[0] ?? "";
	const type: ApiReplyType =
		head === "!re" ||
		head === "!done" ||
		head === "!trap" ||
		head === "!fatal" ||
		head === "!empty"
			? head
			: "!fatal";
	const attributes: Record<string, string> = {};
	let tag: string | undefined;
	for (let index = 1; index < words.length; index += 1) {
		const word = words[index] as string;
		if (word.startsWith("=")) {
			const separator = word.indexOf("=", 1);
			if (separator === -1) {
				attributes[word.slice(1)] = "";
			} else {
				attributes[word.slice(1, separator)] = word.slice(separator + 1);
			}
		} else if (word.startsWith(".tag=")) {
			tag = word.slice(".tag=".length);
		}
	}
	return { type, attributes, tag, words };
}

/** Read an attribute by name (variable key avoids index-signature pitfalls). */
export function readAttribute(
	reply: ApiReply,
	name: string,
): string | undefined {
	return reply.attributes[name];
}

/**
 * Classify a native-API `!trap` as an authentication failure.
 *
 * Auth failures surface on `/login` (bad credentials) or on any command when
 * the session is not authorized, so the trap message is matched rather than
 * relying on the command word alone. The strings are grounded on live RouterOS
 * CHR output: "invalid user name or password", "could not authenticate -
 * radius timeout", "not logged in", "access denied". Misclassifying these as a
 * syntax/validation error was the reported `execute` bug.
 */
export function isNativeAuthFailure(command: string, message: string): boolean {
	return (
		/not logged in|access denied|invalid user|could not authenticate|authentication failed|radius (?:timeout|error)|bad password|password|\blogin\b|\buser\b/i.test(
			message,
		) || command === "/login"
	);
}

/**
 * Compute the legacy (pre-6.43) login response from a hex challenge.
 *
 * `response = "00" + md5( 0x00 || password || rawChallenge )` where
 * `rawChallenge` is the challenge hex string decoded to bytes.
 */
export function challengeResponse(
	challengeHex: string,
	password: string,
): string {
	const challenge = Buffer.from(challengeHex, "hex");
	const hash = createHash("md5");
	hash.update(Buffer.from([0]));
	hash.update(Buffer.from(password, "utf8"));
	hash.update(challenge);
	return `00${hash.digest("hex")}`;
}

/**
 * Build an API command word `=name=value` attribute word.
 *
 * The value needs **no escaping**: words are length-prefix framed on the wire
 * ({@link encodeWord} UTF-8-encodes by byte length), so any UTF-8 content — `=`,
 * spaces, CR/LF, NUL, multibyte characters — passes through verbatim, and
 * {@link parseReply} splits on the *second* `=` so a value that contains `=` is
 * read back whole. Round-trip pinned in `test/unit/native-api.test.ts`
 * ("attribute value round-trip (JG-15)").
 */
export function attributeWord(name: string, value: string): string {
	return `=${name}=${value}`;
}

/** Sink the session writes encoded sentences to. */
export interface NativeApiByteSink {
	/** Write raw bytes to the transport. */
	write(bytes: Uint8Array): void;
	/** Close the transport. */
	close(): void;
}

export interface NativeApiCommand {
	/** RouterOS path/command word, e.g. `/system/resource/print`. */
	command: string;
	/** `=name=value` attributes. */
	attributes?: Record<string, string>;
	/** `?query` words (already including the leading `?`). */
	queries?: readonly string[];
	/** `.proplist` restriction (comma-joined when an array). */
	proplist?: readonly string[] | string;
}

interface PendingCommand {
	command: string;
	records: ApiReply[];
	trap?: ApiReply;
	resolve: (replies: ApiReply[]) => void;
	reject: (error: CentrsError) => void;
}

export interface NativeApiSessionOptions {
	sink: NativeApiByteSink;
	/** Host/port label used in error envelopes. */
	endpoint?: string;
}

/**
 * Stateful native API session over an injectable byte sink.
 *
 * Multiplexes commands with `.tag=` so concurrent `talk()` calls route their
 * `!re`/`!done`/`!trap` replies back to the right caller. Feed inbound bytes
 * via {@link handleData} and transport closure via {@link handleClose}.
 */
export class NativeApiSession {
	private readonly sink: NativeApiByteSink;
	private readonly endpoint: string;
	private readonly reader = new SentenceReader();
	private readonly pending = new Map<string, PendingCommand>();
	private tagCounter = 0;
	private closed = false;
	private closeError: CentrsError | undefined;

	constructor(options: NativeApiSessionOptions) {
		this.sink = options.sink;
		this.endpoint = options.endpoint ?? "the RouterOS API service";
	}

	/** Feed inbound transport bytes into the parser. */
	handleData(chunk: Uint8Array): void {
		let sentences: string[][];
		try {
			sentences = this.reader.push(chunk);
		} catch (error) {
			this.failAll(
				error instanceof CentrsError
					? error
					: new CentrsError({
							code: "routeros/api-protocol",
							summary: "Failed to parse a RouterOS API reply.",
							remediation:
								"Confirm the target port speaks the native API and is not a different service.",
							cause: error,
						}),
			);
			return;
		}
		for (const words of sentences) {
			if (words.length === 0) {
				continue;
			}
			this.dispatch(parseReply(words));
		}
	}

	/** Notify the session the transport closed (optionally with an error). */
	handleClose(error?: Error): void {
		if (this.closed) {
			return;
		}
		this.failAll(
			this.closeError ??
				new CentrsError({
					code: "transport/connection-closed",
					summary: `The RouterOS API connection to ${this.endpoint} closed unexpectedly.`,
					remediation:
						"Retry; if it persists, confirm the api service is enabled and reachable.",
					cause: error,
				}),
		);
	}

	private dispatch(reply: ApiReply): void {
		if (reply.type === "!fatal") {
			this.closeError = new CentrsError({
				code: "routeros/api-fatal",
				summary:
					readAttribute(reply, "message") ??
					`The RouterOS API service at ${this.endpoint} reported a fatal error.`,
				remediation:
					"The router closed the API connection; check the System > Logging output on the device.",
				context: { attributes: reply.attributes },
			});
			this.failAll(this.closeError);
			return;
		}

		const tag = reply.tag;
		if (tag === undefined) {
			return; // untagged async/system notice — no waiter to route to
		}
		const waiter = this.pending.get(tag);
		if (waiter === undefined) {
			return;
		}

		switch (reply.type) {
			case "!re":
				waiter.records.push(reply);
				return;
			case "!trap":
				waiter.trap = reply;
				return;
			case "!empty":
				return;
			case "!done": {
				this.pending.delete(tag);
				if (waiter.trap) {
					waiter.reject(this.trapToError(waiter.command, waiter.trap));
					return;
				}
				if (Object.keys(reply.attributes).length > 0) {
					waiter.records.push(reply);
				}
				waiter.resolve(waiter.records);
				return;
			}
			default:
				return;
		}
	}

	private trapToError(command: string, trap: ApiReply): CentrsError {
		const message =
			readAttribute(trap, "message") ?? "RouterOS API command failed.";
		if (isNativeAuthFailure(command, message)) {
			return new CentrsError({
				code: "transport/auth-failed",
				summary: `RouterOS rejected the API credentials for ${this.endpoint}: ${message}`,
				remediation:
					"Check the username/password (and any RADIUS backend) and that the user has API access (a group with the `api` policy).",
				context: {
					command,
					category: readAttribute(trap, "category"),
					message,
				},
			});
		}

		return mapRouterOsError(message, {
			transport: "native-api",
			context: {
				command,
				category: readAttribute(trap, "category"),
				message,
			},
		});
	}

	private failAll(error: CentrsError): void {
		this.closed = true;
		const waiters = [...this.pending.values()];
		this.pending.clear();
		for (const waiter of waiters) {
			waiter.reject(error);
		}
	}

	private nextTag(): string {
		this.tagCounter += 1;
		return `t${this.tagCounter}`;
	}

	private buildWords(command: NativeApiCommand, tag: string): string[] {
		const words: string[] = [command.command];
		for (const [name, value] of Object.entries(command.attributes ?? {})) {
			words.push(attributeWord(name, value));
		}
		for (const query of command.queries ?? []) {
			words.push(query);
		}
		if (command.proplist !== undefined) {
			const list = Array.isArray(command.proplist)
				? command.proplist.join(",")
				: (command.proplist as string);
			// `.proplist` is a regular attribute word (`=.proplist=`), unlike the
			// bare-dot `.tag` API attribute word.
			words.push(`=.proplist=${list}`);
		}
		words.push(`.tag=${tag}`);
		return words;
	}

	/**
	 * Send a command and resolve with its reply records (`!re` sentences, plus
	 * the `!done` sentence when it carries attributes). Rejects on `!trap`,
	 * `!fatal`, or transport closure.
	 */
	talk(command: NativeApiCommand): Promise<ApiReply[]> {
		if (this.closed) {
			return Promise.reject(
				this.closeError ??
					new CentrsError({
						code: "transport/connection-closed",
						summary: `The RouterOS API session to ${this.endpoint} is closed.`,
						remediation: "Open a new connection before sending commands.",
					}),
			);
		}
		const tag = this.nextTag();
		const words = this.buildWords(command, tag);
		return new Promise<ApiReply[]>((resolve, reject) => {
			this.pending.set(tag, {
				command: command.command,
				records: [],
				resolve,
				reject,
			});
			try {
				this.sink.write(encodeSentence(words));
			} catch (error) {
				this.pending.delete(tag);
				reject(
					error instanceof CentrsError
						? error
						: new CentrsError({
								code: "transport/network",
								summary: `Failed to write to the RouterOS API connection to ${this.endpoint}.`,
								remediation: "Retry; confirm the connection is still open.",
								cause: error,
							}),
				);
			}
		});
	}

	/**
	 * Authenticate. Uses the combined approach: send name+password; if the
	 * router answers with a legacy `=ret=` challenge, compute the MD5 response
	 * and send the second `/login`. Resolves on success, rejects on bad auth.
	 */
	async login(username: string, password: string): Promise<void> {
		const first = await this.talk({
			command: "/login",
			attributes: { name: username, password },
		});
		const challenge = first
			.map((reply) => readAttribute(reply, "ret"))
			.find((ret): ret is string => typeof ret === "string");
		if (challenge === undefined) {
			return; // modern plaintext login succeeded
		}
		await this.talk({
			command: "/login",
			attributes: {
				name: username,
				response: challengeResponse(challenge, password),
			},
		});
	}

	/** Close the transport and reject any in-flight commands. */
	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		try {
			this.sink.close();
		} finally {
			const waiters = [...this.pending.values()];
			this.pending.clear();
			for (const waiter of waiters) {
				waiter.reject(
					new CentrsError({
						code: "transport/connection-closed",
						summary: `The RouterOS API session to ${this.endpoint} was closed by the caller.`,
						remediation: "Open a new connection before sending more commands.",
					}),
				);
			}
		}
	}
}

export interface ConnectNativeApiOptions {
	host: string;
	port?: number;
	username: string;
	password: string;
	/** Use TLS (api-ssl). Defaults to false. */
	tls?: boolean;
	/** Reject self-signed/anonymous certs. api-ssl is often unverified. */
	rejectUnauthorized?: boolean;
	/** Connection timeout in milliseconds. */
	timeoutMs?: number;
}

interface ConnectedNativeApi {
	session: NativeApiSession;
}

/**
 * Open a TCP (or TLS) native API connection, authenticate, and return a
 * ready-to-use {@link NativeApiSession}. IO path; covered by integration tests.
 */
export async function connectNativeApi(
	options: ConnectNativeApiOptions,
): Promise<ConnectedNativeApi> {
	const port =
		options.port ?? (options.tls ? NATIVE_API_TLS_PORT : NATIVE_API_PORT);
	const endpoint = `${options.host}:${port}`;
	const timeoutMs = options.timeoutMs ?? 15_000;

	let session: NativeApiSession | undefined;
	const connectPromise = Bun.connect({
		hostname: options.host,
		port,
		...(options.tls
			? {
					tls: {
						rejectUnauthorized: options.rejectUnauthorized ?? false,
					},
				}
			: {}),
		socket: {
			data(_socket, data) {
				session?.handleData(new Uint8Array(data));
			},
			close() {
				session?.handleClose();
			},
			error(_socket, error) {
				session?.handleClose(error);
			},
		},
	}).catch((error: unknown) => {
		throw mapConnectError(error, endpoint);
	});

	const socket = await withTimeout(connectPromise, timeoutMs, endpoint);
	session = new NativeApiSession({
		endpoint,
		sink: {
			write(bytes) {
				socket.write(bytes);
			},
			close() {
				socket.end();
			},
		},
	});

	try {
		await withTimeout(
			session.login(options.username, options.password),
			timeoutMs,
			endpoint,
		);
	} catch (error) {
		// Never leave a half-open socket when login times out or is rejected.
		session.close();
		throw error;
	}
	return { session };
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	endpoint: string,
): Promise<T> {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		handle = setTimeout(() => {
			reject(
				new CentrsError({
					code: "transport/timeout",
					summary: `Connecting to the RouterOS API service at ${endpoint} timed out after ${timeoutMs}ms.`,
					remediation:
						"Confirm the api service is enabled and reachable, or raise the timeout.",
				}),
			);
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (handle !== undefined) {
			clearTimeout(handle);
		}
	}
}

function mapConnectError(error: unknown, endpoint: string): CentrsError {
	if (error instanceof CentrsError) {
		return error;
	}
	const code = extractSystemCode(error);
	if (code === "ECONNREFUSED") {
		return new CentrsError({
			code: "transport/connection-refused",
			summary: `The RouterOS API service at ${endpoint} refused the connection.`,
			remediation:
				"Enable the api service (`/ip service enable api`) and confirm the port/firewall.",
			cause: error,
		});
	}
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
		return new CentrsError({
			code: "transport/dns",
			summary: `Could not resolve the RouterOS API host for ${endpoint}.`,
			remediation: "Check the hostname or use an IP address.",
			cause: error,
		});
	}
	if (isTlsCertificateError(code, error)) {
		return new CentrsError({
			code: "transport/tls-certificate",
			summary: `TLS certificate validation failed for the api-ssl service at ${endpoint}.`,
			remediation:
				"RouterOS ships a self-signed certificate by default. Install a trusted chain, or pass `--insecure` (`CENTRS_INSECURE=1`) to accept it.",
			cause: error,
		});
	}
	return new CentrsError({
		code: "transport/network",
		summary: `Failed to connect to the RouterOS API service at ${endpoint}.`,
		remediation: "Confirm the host, port, and network path to the device.",
		cause: error,
	});
}

/** Detect a TLS peer-verification failure (api-ssl self-signed cert, etc.). */
function isTlsCertificateError(
	code: string | undefined,
	error: unknown,
): boolean {
	if (code && /CERT|SELF_SIGNED|VERIFY|SSL|TLS/i.test(code)) {
		return true;
	}
	const message =
		error instanceof Error
			? error.message
			: typeof error === "object" && error && "message" in error
				? String((error as { message: unknown }).message)
				: "";
	return /certificate|self.signed|self_signed/i.test(message);
}

function extractSystemCode(error: unknown): string | undefined {
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { code: unknown }).code;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}
