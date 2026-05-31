/**
 * Shared, reusable transport seam: the `ProtocolAdapter`.
 *
 * The adapter is the single boundary the command orchestrators (retrieve today,
 * execute in WP-1c) drive REST and native-api through. It exposes the read-shaped
 * `inspect`/`getSingleton`/`list` operations plus an `execute` seam for the
 * future write surface, so both transports share one validate → run pipeline and
 * one RouterOS error vocabulary.
 *
 * Dependency direction is `protocols ← retrieve`, never the reverse: this layer
 * must not import retrieve-specific types. Callers pass a small
 * {@link ProtocolAdapterConfig} describing the connection, not a resolved
 * request. Envelope assembly stays in the command layer; the adapter returns raw
 * protocol data.
 */

import { CentrsError } from "../errors.ts";
import type { RouterOsProtocol } from "./index.ts";
import {
	type ApiReply,
	connectNativeApi,
	type NativeApiCommand,
	type NativeApiSession,
} from "./native-api.ts";

/** Connection inputs an adapter needs, free of retrieve-specific resolver types. */
export interface ProtocolAdapterConfig {
	/** Transport to build. `retrieve` uses `rest-api` or `native-api`. */
	protocol: RouterOsProtocol;
	/** Resolved host (literal address or DNS name). */
	host: string;
	/** Resolved port. */
	port: number;
	/** TLS transport (native-api over api-ssl). REST uses the base URL scheme. */
	tls: boolean;
	/** REST base URL, e.g. `http://host:port`. Also used as the native endpoint label. */
	baseUrl: string;
	/** RouterOS username, when provided. */
	username?: string;
	/** RouterOS password (empty string when none). */
	password: string;
	/** Per-command timeout in milliseconds. */
	timeoutMs: number;
}

/** Projection/detail options for a menu `list`. */
export interface RetrieveListOptions {
	proplist?: readonly string[];
	detail?: boolean;
}

/** What an adapter can do. Lets callers pick a transport per capability. */
export interface ProtocolAdapterCapabilities {
	retrieve: boolean;
	execute: boolean;
	inspect: boolean;
}

/**
 * A structured CLI-shaped command for the `execute` seam. WP-1c owns
 * canonicalization and validation; this is the minimal typed shape the
 * transports run. Supply `command` for structured path-POST / native `talk`, or
 * `script` for the `/rest/execute` script fallback.
 */
export interface ProtocolExecuteRequest {
	/** Slash-prefixed RouterOS path the command targets, e.g. `/ip/address`. */
	path: string;
	/** Verb appended to the path, e.g. `add`, `set`, `remove`, `print`. */
	command: string;
	/** `name=value` attributes for the command. */
	attributes?: Record<string, string>;
	/** `?query` words (already including the leading `?`), native-api only. */
	queries?: readonly string[];
	/** Raw CLI line for the `/rest/execute` script fallback. */
	script?: string;
}

/** Result of an `execute` round-trip. */
export interface ProtocolExecuteResult {
	/** `!re`-style records the command returned (may be empty). */
	records: Record<string, string>[];
	/** Scalar `ret` value from `/rest/execute`, when present. */
	ret?: string;
}

/**
 * Runtime transport seam. The orchestrator drives validation and data fetch
 * through these operations so REST and native-api share the same pipeline and
 * envelope shape.
 */
export interface ProtocolAdapter {
	/** Transport this adapter speaks. */
	readonly protocol: RouterOsProtocol;
	/** Capability flags describing what this adapter supports. */
	readonly capabilities: ProtocolAdapterCapabilities;
	/** `/console/inspect` probe (`request=child` or `request=completion`). */
	inspect(request: "child" | "completion", path: string): Promise<unknown[]>;
	/** Read a single record (singleton menu) as an object. */
	getSingleton(path: string): Promise<unknown>;
	/** Read a menu as an array of records, optionally projected/detailed. */
	list(path: string, options: RetrieveListOptions): Promise<unknown[]>;
	/** Run a CLI-shaped command (WP-1c write surface). */
	execute(request: ProtocolExecuteRequest): Promise<ProtocolExecuteResult>;
	/** Release any underlying connection. Safe to call when never connected. */
	close(): Promise<void>;
}

/**
 * Build the adapter for the configured protocol. `retrieve` only ever asks for
 * `rest-api` or `native-api`; anything else is treated as REST today.
 */
export function createProtocolAdapter(
	config: ProtocolAdapterConfig,
): ProtocolAdapter {
	if (config.protocol === "native-api") {
		return new NativeApiAdapter(config);
	}
	return new RestAdapter(config);
}

interface RestResponse {
	status: number;
	text: string;
	data: unknown;
}

class RestAdapter implements ProtocolAdapter {
	readonly protocol: RouterOsProtocol;
	readonly capabilities: ProtocolAdapterCapabilities = {
		retrieve: true,
		execute: true,
		inspect: true,
	};

	constructor(private readonly config: ProtocolAdapterConfig) {
		this.protocol = config.protocol;
	}

	async inspect(
		request: "child" | "completion",
		path: string,
	): Promise<unknown[]> {
		return this.restPost<unknown[]>("/console/inspect", { request, path });
	}

	async getSingleton(path: string): Promise<unknown> {
		return this.restGet(path);
	}

	async list(path: string, options: RetrieveListOptions): Promise<unknown[]> {
		const hasProjection =
			(options.proplist?.length ?? 0) > 0 || options.detail === true;
		if (!hasProjection) {
			return (await this.restGet(path)) as unknown[];
		}
		const body: { ".proplist"?: readonly string[]; detail?: string } = {};
		if (options.proplist && options.proplist.length > 0) {
			body[".proplist"] = options.proplist;
		}
		if (options.detail) {
			body.detail = "true";
		}
		return this.restPost<unknown[]>(`${path.replace(/\/$/, "")}/print`, body);
	}

	async execute(
		request: ProtocolExecuteRequest,
	): Promise<ProtocolExecuteResult> {
		if (request.script !== undefined) {
			const data = await this.restPost<unknown>("/execute", {
				script: request.script,
			});
			return normalizeRestExecute(data);
		}
		const target = `${request.path.replace(/\/$/, "")}/${request.command}`;
		const data = await this.restPost<unknown>(target, request.attributes ?? {});
		return normalizeRestExecute(data);
	}

	async close(): Promise<void> {
		// REST is stateless; nothing to release.
	}

	private async restGet(path: string): Promise<unknown> {
		const response = await this.fetchRest(path, { method: "GET" });
		return response.data;
	}

	private async restPost<T = unknown>(
		path: string,
		body: Record<string, unknown>,
	): Promise<T> {
		const response = await this.fetchRest(path, {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
		});
		return response.data as T;
	}

	private async fetchRest(
		path: string,
		init: RequestInit,
	): Promise<RestResponse> {
		const url = joinRestUrl(this.config.baseUrl, path);
		const headers = new Headers(init.headers);
		if (this.config.username) {
			headers.set(
				"Authorization",
				`Basic ${Buffer.from(`${this.config.username}:${this.config.password}`, "utf8").toString("base64")}`,
			);
		}

		const controller = new AbortController();
		const timeoutHandle = setTimeout(
			() => controller.abort("timeout"),
			this.config.timeoutMs,
		);

		try {
			const response = await fetch(url, {
				...init,
				headers,
				signal: controller.signal,
			});
			const text = await response.text();
			const data = parseResponseBody(text);
			if (!response.ok) {
				throw this.mapHttpFailure(response.status, text, data, path);
			}

			return { status: response.status, text, data };
		} catch (error) {
			if (error instanceof CentrsError) {
				throw error;
			}
			throw this.mapTransportFailure(error, path);
		} finally {
			clearTimeout(timeoutHandle);
		}
	}

	private mapHttpFailure(
		status: number,
		text: string,
		data: unknown,
		path: string,
	): CentrsError {
		const { protocol, host, port, timeoutMs } = this.config;
		if (status === 401 || status === 403) {
			return new CentrsError({
				code: "transport/auth-failed",
				summary: `RouterOS rejected the REST credentials for ${host}:${port}.`,
				remediation:
					"Check `--username` / `--password` or the matching `CENTRS_*` environment variables, and confirm the user has RouterOS REST access.",
				context: { via: protocol, host, port, path, status },
				causeData: data ?? text,
			});
		}

		if (
			status === 400 &&
			isPlainObject(data) &&
			readRecordString(data, "detail") === "Session closed"
		) {
			return new CentrsError({
				code: "transport/timeout",
				summary: `RouterOS closed the REST session before ${path} completed.`,
				remediation:
					"Reduce the scope of the request, or choose a path that can complete within the current RouterOS REST timeout ceiling.",
				context: { via: protocol, host, port, path, timeoutMs },
				causeData: data,
			});
		}

		if (status === 404) {
			return new CentrsError({
				code: "routeros/path-not-found",
				summary: `RouterOS path ${path} was not found over REST.`,
				remediation:
					"Check the slash-prefixed RouterOS path, or use `--list-attributes` / `--no-validate` to narrow down where the mismatch is happening.",
				context: { via: protocol, host, port, path, status },
				causeData: data ?? text,
			});
		}

		if (status >= 500 && status <= 599) {
			// A 5xx is a transient server/connection drop (RouterOS REST under
			// fanout load drops a fraction of parallel POSTs). Classify it as a
			// transport drop, not a `routeros/*` request failure, so the fanout
			// retry allowlist can retry it without blanket-retrying real
			// router-side rejections.
			return new CentrsError({
				code: "transport/connection-closed",
				summary: `RouterOS REST returned HTTP ${status} for ${path}; the connection was dropped before a result.`,
				remediation:
					"Retry the request; if it persists, reduce fanout concurrency or check RouterOS REST service health.",
				context: { via: protocol, host, port, path, status },
				causeData: data ?? text,
			});
		}

		// WP-1c: adopt mapRouterOsError here (REST `detail` -> normalized routeros/* code).
		// Tracked as a deliverable in commands/execute/README.md (review finding #6):
		// route REST detail + HTTP status through mapRouterOsError({ transport: "rest-api" })
		// so REST and native classify the same fault identically, preserving fanout retry
		// mapping (401/403 -> auth-failed; 5xx -> retryable transport/connection-closed).
		return new CentrsError({
			code: "routeros/request-failed",
			summary: `RouterOS REST request failed with HTTP ${status} for ${path}.`,
			remediation:
				"Inspect the returned RouterOS message, then adjust the path, credentials, or request shape accordingly.",
			context: { via: protocol, host, port, path, status },
			causeData: data ?? text,
		});
	}

	private mapTransportFailure(error: unknown, path: string): CentrsError {
		const { protocol, host, port, timeoutMs } = this.config;
		const signals = collectTransportSignals(error);
		const codes = signals.codes.map((code) => code.toLowerCase());
		const messages = signals.messages.map((message) => message.toLowerCase());
		if (
			codes.includes("abort_err") ||
			messages.some((candidate) => candidate.includes("timeout"))
		) {
			return new CentrsError({
				code: "transport/timeout",
				summary: `Timed out waiting for ${protocol} to respond from ${host}:${port}.`,
				remediation:
					"Increase `--timeout` within the REST ceiling, or confirm the host and port are reachable.",
				context: { via: protocol, host, port, path, timeoutMs },
				cause: error,
			});
		}

		if (
			codes.some(
				(code) => code === "econnrefused" || code === "connectionrefused",
			) ||
			messages.some(
				(candidate) =>
					candidate.includes("econnrefused") ||
					candidate.includes("connection refused") ||
					candidate.includes("unable to connect"),
			)
		) {
			return new CentrsError({
				code: "transport/connection-refused",
				summary: `Connection refused by ${host}:${port} over ${protocol}.`,
				remediation:
					"Check that the RouterOS REST service is enabled on that port and that any local forwarding or firewall rules are correct.",
				context: { via: protocol, host, port, path },
				cause: error,
			});
		}

		if (
			codes.some((code) => ["enotfound", "eai_again", "dns"].includes(code)) ||
			messages.some(
				(candidate) =>
					candidate.includes("enotfound") ||
					candidate.includes("eai_again") ||
					candidate.includes("dns") ||
					candidate.includes("could not resolve") ||
					candidate.includes("name lookup"),
			)
		) {
			return new CentrsError({
				code: "transport/dns",
				summary: `Could not resolve ${host} for ${protocol}.`,
				remediation:
					"Check the host spelling, DNS configuration, or pass a literal address with `--host`.",
				context: { via: protocol, host, port, path },
				cause: error,
			});
		}

		if (messages.some((candidate) => candidate.includes("certificate"))) {
			return new CentrsError({
				code: "transport/tls-certificate",
				summary: `TLS certificate validation failed for ${host}:${port}.`,
				remediation:
					"Use an HTTP URL for this alpha slice, or install a certificate chain Bun can trust before using HTTPS.",
				context: { via: protocol, host, port, path },
				cause: error,
			});
		}

		return new CentrsError({
			code: "transport/network",
			summary: `Network request to ${host}:${port} failed over ${protocol}.`,
			remediation:
				"Check the host, port, and service availability, then re-run with `--format json` if you need the structured cause data.",
			context: { via: protocol, host, port, path },
			cause: error,
		});
	}
}

class NativeApiAdapter implements ProtocolAdapter {
	readonly protocol: RouterOsProtocol;
	readonly capabilities: ProtocolAdapterCapabilities = {
		retrieve: true,
		execute: true,
		inspect: true,
	};
	private session?: NativeApiSession;

	constructor(private readonly config: ProtocolAdapterConfig) {
		this.protocol = config.protocol;
	}

	async inspect(
		request: "child" | "completion",
		path: string,
	): Promise<unknown[]> {
		const replies = await this.talk({
			command: "/console/inspect",
			attributes: { request, path },
		});
		return repliesToRecords(replies);
	}

	async getSingleton(path: string): Promise<unknown> {
		const replies = await this.talk({
			command: `${path.replace(/\/$/, "")}/print`,
		});
		const records = repliesToRecords(replies);
		return records[0] ?? {};
	}

	async list(path: string, options: RetrieveListOptions): Promise<unknown[]> {
		const command: NativeApiCommand = {
			command: `${path.replace(/\/$/, "")}/print`,
		};
		if (options.proplist && options.proplist.length > 0) {
			command.proplist = options.proplist;
		}
		if (options.detail) {
			command.attributes = { detail: "" };
		}
		const replies = await this.talk(command);
		return repliesToRecords(replies);
	}

	async execute(
		request: ProtocolExecuteRequest,
	): Promise<ProtocolExecuteResult> {
		const command: NativeApiCommand = {
			command: `${request.path.replace(/\/$/, "")}/${request.command}`,
		};
		if (request.attributes && Object.keys(request.attributes).length > 0) {
			command.attributes = request.attributes;
		}
		if (request.queries && request.queries.length > 0) {
			command.queries = request.queries;
		}
		const replies = await this.talk(command);
		return { records: repliesToRecords(replies) };
	}

	async close(): Promise<void> {
		this.session?.close();
		this.session = undefined;
	}

	private async connect(): Promise<NativeApiSession> {
		if (this.session) {
			return this.session;
		}
		const { session } = await connectNativeApi({
			host: this.config.host,
			port: this.config.port,
			username: this.config.username ?? "",
			password: this.config.password,
			tls: this.config.tls,
			timeoutMs: this.config.timeoutMs,
		});
		this.session = session;
		return session;
	}

	private async talk(command: NativeApiCommand): Promise<ApiReply[]> {
		const session = await this.connect();
		return this.withTimeout(session.talk(command));
	}

	private async withTimeout<T>(promise: Promise<T>): Promise<T> {
		const timeoutMs = this.config.timeoutMs;
		let handle: ReturnType<typeof setTimeout> | undefined;
		const endpoint = this.config.baseUrl;
		// Swallow the eventual rejection from the raced command so that closing
		// the session below (which rejects the in-flight talk) cannot surface as
		// an unhandled rejection once the timeout has already won the race.
		promise.catch(() => undefined);
		const timeout = new Promise<never>((_resolve, reject) => {
			handle = setTimeout(() => {
				// Reject with the timeout error first so it wins the race, then
				// tear down the connection (which rejects the pending talk with
				// transport/connection-closed — now harmlessly ignored).
				reject(
					new CentrsError({
						code: "transport/timeout",
						summary: `The RouterOS API command to ${endpoint} timed out after ${timeoutMs}ms.`,
						remediation:
							"Raise `--timeout`, or confirm the api service is responsive.",
						context: { via: "native-api", endpoint, timeoutMs },
					}),
				);
				this.session?.close();
				this.session = undefined;
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
}

function normalizeRestExecute(data: unknown): ProtocolExecuteResult {
	if (Array.isArray(data)) {
		return { records: data.filter(isPlainObject) as Record<string, string>[] };
	}
	if (isPlainObject(data)) {
		const ret = data["ret"];
		if (typeof ret === "string") {
			return { records: [], ret };
		}
		return { records: [data as Record<string, string>] };
	}
	if (typeof data === "string") {
		return { records: [], ret: data };
	}
	return { records: [] };
}

function repliesToRecords(
	replies: readonly ApiReply[],
): Record<string, string>[] {
	return replies
		.filter((reply) => reply.type === "!re")
		.map((reply) => ({ ...reply.attributes }));
}

function joinRestUrl(baseUrl: string, path: string): string {
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	return `${baseUrl}${normalizedPath}`;
}

function parseResponseBody(text: string): unknown {
	if (text.length === 0) {
		return null;
	}

	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

interface TransportSignals {
	codes: string[];
	messages: string[];
}

function collectTransportSignals(error: unknown): TransportSignals {
	const signals: TransportSignals = { codes: [], messages: [] };
	collectTransportSignalsInto(error, signals, new Set<unknown>());
	return signals;
}

function collectTransportSignalsInto(
	error: unknown,
	signals: TransportSignals,
	seen: Set<unknown>,
): void {
	if (error === null || error === undefined || seen.has(error)) {
		return;
	}
	if (typeof error !== "object") {
		signals.messages.push(String(error));
		return;
	}
	seen.add(error);

	if (error instanceof Error && error.message.length > 0) {
		signals.messages.push(error.message);
	}
	if ("message" in error && typeof error.message === "string") {
		signals.messages.push(error.message);
	}
	if ("code" in error && typeof error.code === "string") {
		signals.codes.push(error.code);
	}
	if ("errno" in error && typeof error.errno === "string") {
		signals.codes.push(error.errno);
	}
	if ("cause" in error) {
		collectTransportSignalsInto(error.cause, signals, seen);
	}
	if ("errors" in error && Array.isArray(error.errors)) {
		for (const nested of error.errors) {
			collectTransportSignalsInto(nested, signals, seen);
		}
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecordString(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
}
