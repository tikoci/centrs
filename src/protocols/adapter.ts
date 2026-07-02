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

import { mapRouterOsError } from "../core/routeros-errors.ts";
import { CentrsError } from "../errors.ts";
import type { RouterOsProtocol } from "./index.ts";
import {
	createUdpMacTelnetTransport,
	isBroadcastHost,
	type MacAddress,
	type MacTelnetTransport,
	parseMac,
	resolveMacTelnetRoute,
} from "./mac-telnet.ts";
import { MacTelnetConsole } from "./mac-telnet-console.ts";
import {
	type ApiReply,
	connectNativeApi,
	type NativeApiCommand,
	type NativeApiSession,
} from "./native-api.ts";
import { SshExecClient } from "./ssh.ts";

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
	/** Target device MAC, for L2 transports (mac-telnet). */
	mac?: string;
	/** Client (in-packet source) MAC for mac-telnet; a synthetic one is used when omitted. */
	sourceMac?: string;
	/** SSH private-key path for the ssh/sftp transport (path only). */
	sshKey?: string;
	/**
	 * Opt out of peer verification: accept self-signed TLS certs (REST/native
	 * api-ssl) and disable strict SSH host-key checking. Default `false`
	 * (verify). The single `--insecure` knob across every transport.
	 */
	insecure?: boolean;
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
 * RouterOS verb the `api` orchestrator resolved from the HTTP method (the gh-api
 * `-X` map: `GET`→print, `PUT`→add, `PATCH`→set, `DELETE`→remove, `POST`→run).
 * `print` covers list, get-singleton, and get-one (disambiguated by `id`).
 */
export type ApiVerb = "print" | "add" | "set" | "remove" | "run";

/**
 * A normalized `api` request the orchestrator hands to a transport. It is
 * transport-agnostic: the REST adapter maps the verb to an HTTP method + URL
 * (id-in-path, `.query`/`.proplist` body), the native adapter maps it to a
 * tagged `talk` (`=.id=`, `?`-prefixed queries, `=.proplist=`). The orchestrator
 * owns method→verb, validation, and the write gate; the adapter only executes.
 */
export interface ProtocolApiRequest {
	verb: ApiVerb;
	/** Slash path without id, e.g. `/ip/address`. For `run`, the command target (`/interface/monitor-traffic`); ignored when `script` is set. */
	path: string;
	/** Object id (`*1`) for get-one/set/remove — REST puts it in the URL, native in `=.id=`. */
	id?: string;
	/** Body fields (string values), the JSON object for add/set or the args for a `run` command. */
	attributes?: Record<string, string>;
	/** Row filter in REST `.query` form (no leading `?`), e.g. `["type=ether", "#!"]`; native prefixes each with `?`. */
	query?: readonly string[];
	/** Property projection → REST `.proplist` / native `=.proplist=`. */
	proplist?: readonly string[];
	/** Raw console line for the `/execute` script form (`run`); when set, `path`/`attributes` are ignored. */
	script?: string;
}

/** Result of an `apiRequest` round-trip: the response body shaped for the envelope. */
export interface ProtocolApiResult {
	/** REST returns the body verbatim (array / object / scalar); native re-maps `!re` records to the same rest-style shape. */
	data: unknown;
}

/** Options for an open-ended `listen` follow. */
export interface ProtocolListenOptions {
	/** Abort the listen (sends `/cancel`); the generator then ends cleanly. */
	signal?: AbortSignal;
	/**
	 * Fired once the subscription is on the wire (connection up, listen sentence
	 * written) — a real "listening" barrier for callers/tests that must act only
	 * after the follow is established, instead of a blind timer.
	 */
	onListening?: () => void;
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
	/** Run a normalized structured `api` request (the gh-api passthrough surface). */
	apiRequest(request: ProtocolApiRequest): Promise<ProtocolApiResult>;
	/**
	 * Open-ended `/listen` follow (native-api only). Yields one rest-style change
	 * record per `!re` frame (deletions carry `.dead`), until cancelled via
	 * `options.signal` or the consumer stopping. REST and console transports
	 * reject with `transport/capability-unsupported`.
	 */
	listen(
		request: ProtocolApiRequest,
		options: ProtocolListenOptions,
	): AsyncIterable<Record<string, unknown>>;
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
	if (config.protocol === "mac-telnet") {
		return new MacTelnetAdapter(config);
	}
	if (config.protocol === "ssh") {
		return new SshExecAdapter(config);
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
				"as-string": "",
			});
			return normalizeRestExecute(data);
		}
		const target = `${request.path.replace(/\/$/, "")}/${request.command}`;
		const data = await this.restPost<unknown>(target, request.attributes ?? {});
		return normalizeRestExecute(data);
	}

	async apiRequest(request: ProtocolApiRequest): Promise<ProtocolApiResult> {
		const base = request.path.replace(/\/$/, "");
		switch (request.verb) {
			case "print": {
				const hasQuery = (request.query?.length ?? 0) > 0;
				const hasProplist = (request.proplist?.length ?? 0) > 0;
				if (request.id && !hasQuery && !hasProplist) {
					// GET one by id: RouterOS REST addresses a single object in the URL.
					return {
						data: await this.requestRest("GET", `${base}/${request.id}`),
					};
				}
				if (request.id || hasQuery || hasProplist) {
					// A GET cannot carry a body, so `.query`/`.proplist` projection (and an
					// id, folded into `.query` as `.id=`) rides a POST to the `/print`
					// sub-endpoint — the documented REST idiom, matching native's `?`-words.
					const data = await this.requestRest(
						"POST",
						`${base}/print`,
						restQueryBody(request),
					);
					// An id addresses one row → unwrap to a single object, matching the
					// GET-by-id shape and native's `?.id=` read.
					if (request.id && Array.isArray(data)) {
						return { data: data[0] ?? null };
					}
					return { data };
				}
				return { data: await this.requestRest("GET", base) };
			}
			case "add":
				return {
					data: await this.requestRest("PUT", base, request.attributes ?? {}),
				};
			case "set":
				return {
					data: await this.requestRest(
						"PATCH",
						`${base}/${request.id}`,
						request.attributes ?? {},
					),
				};
			case "remove":
				return {
					data: await this.requestRest("DELETE", `${base}/${request.id}`),
				};
			case "run": {
				if (request.script !== undefined) {
					// Sync script run: `as-string` makes `/rest/execute` block and return the
					// captured output rather than scheduling an async job (CHR-grounded).
					const body = await this.requestRest("POST", "/execute", {
						script: request.script,
						"as-string": "",
					});
					const result = normalizeRestExecute(body);
					return { data: result.ret ?? result.records };
				}
				return {
					data: await this.requestRest("POST", base, request.attributes ?? {}),
				};
			}
			default:
				return exhaustiveApiVerb(request.verb);
		}
	}

	// REST cannot hold an open-ended follow (the 60s cap); listen is native-only.
	// biome-ignore lint/correctness/useYield: a throw-only async generator yields nothing.
	async *listen(): AsyncGenerator<Record<string, unknown>> {
		throw new CentrsError({
			code: "transport/capability-unsupported",
			summary: "REST cannot follow an open-ended `--stream` (60s cap).",
			remediation:
				"Open-ended follow is native-api only: use `--via native-api`, or drop `--stream` for a bounded one-shot.",
			context: { protocol: this.protocol, capability: "listen" },
		});
	}

	async close(): Promise<void> {
		// REST is stateless; nothing to release.
	}

	private async requestRest(
		method: string,
		path: string,
		body?: Record<string, unknown>,
	): Promise<unknown> {
		const init: RequestInit =
			body === undefined
				? { method }
				: {
						method,
						body: JSON.stringify(body),
						headers: { "Content-Type": "application/json" },
					};
		const response = await this.fetchRest(path, init);
		return response.data;
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

		// Unified TLS trust: verify by default, accept self-signed only when the
		// caller opted in with `--insecure` (RouterOS ships self-signed www-ssl
		// certs). Bun honors a `tls` field on the fetch init at runtime.
		const fetchInit: RequestInit & {
			tls?: { rejectUnauthorized?: boolean };
		} = {
			...init,
			headers,
			signal: controller.signal,
			tls: { rejectUnauthorized: this.config.insecure !== true },
		};

		try {
			const response = await fetch(url, fetchInit);
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
		const { protocol, host, port } = this.config;
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

		const detail = isPlainObject(data)
			? readRecordString(data, "detail")
			: undefined;
		const rawRouterOsError = detail ?? text;
		return mapRouterOsError(rawRouterOsError, {
			transport: "rest-api",
			httpStatus: status,
			context: { via: protocol, host, port, path, status },
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
					"RouterOS ships a self-signed certificate by default. Install a trusted chain, or pass `--insecure` (`CENTRS_INSECURE=1`) to accept it; an HTTP URL also avoids TLS.",
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
		if (request.script !== undefined) {
			return normalizeNativeExecute(await this.executeScript(request.script));
		}
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

	/**
	 * Run a script through native `/execute` with `as-string`, the sole shared
	 * path for both the CLI-shaped `execute` command and the `api` run+script
	 * verb: without `as-string` the native API schedules a background job and
	 * returns only its id rather than the captured output (CHR-grounded —
	 * mirrors REST `/rest/execute`).
	 */
	private async executeScript(
		script: string,
	): Promise<Record<string, string>[]> {
		const replies = await this.talk({
			command: "/execute",
			attributes: { script, "as-string": "" },
		});
		return repliesToRecords(replies);
	}

	async apiRequest(request: ProtocolApiRequest): Promise<ProtocolApiResult> {
		const base = request.path.replace(/\/$/, "");
		switch (request.verb) {
			case "print": {
				const command: NativeApiCommand = { command: `${base}/print` };
				const queries: string[] = [];
				// REST `.query` words map 1:1 to native `?`-prefixed words (CHR-grounded).
				for (const word of request.query ?? []) {
					queries.push(`?${word}`);
				}
				// No native get-one-by-id shorthand: address a single row with `?.id=`.
				if (request.id) {
					queries.push(`?.id=${request.id}`);
				}
				if (queries.length > 0) {
					command.queries = queries;
				}
				if (request.proplist && request.proplist.length > 0) {
					command.proplist = request.proplist;
				}
				const records = repliesToRecords(await this.talk(command));
				return { data: request.id ? (records[0] ?? null) : records };
			}
			case "add": {
				const records = repliesToRecords(
					await this.talk({
						command: `${base}/add`,
						attributes: request.attributes ?? {},
					}),
				);
				return { data: restStyleMutationData(records) };
			}
			case "set": {
				const records = repliesToRecords(
					await this.talk({
						command: `${base}/set`,
						attributes: {
							...(request.attributes ?? {}),
							".id": request.id ?? "",
						},
					}),
				);
				return { data: restStyleMutationData(records) };
			}
			case "remove": {
				const records = repliesToRecords(
					await this.talk({
						command: `${base}/remove`,
						attributes: { ".id": request.id ?? "" },
					}),
				);
				return { data: restStyleMutationData(records) };
			}
			case "run": {
				if (request.script !== undefined) {
					const records = await this.executeScript(request.script);
					return { data: restStyleRunData(records) };
				}
				const command: NativeApiCommand = { command: base };
				if (request.attributes && Object.keys(request.attributes).length > 0) {
					command.attributes = request.attributes;
				}
				return { data: repliesToRecords(await this.talk(command)) };
			}
			default:
				return exhaustiveApiVerb(request.verb);
		}
	}

	async *listen(
		request: ProtocolApiRequest,
		options: ProtocolListenOptions,
	): AsyncGenerator<Record<string, unknown>> {
		const base = request.path.replace(/\/$/, "");
		const command: NativeApiCommand = { command: `${base}/listen` };
		// A listen can filter which changes it follows with the same `?`-words /
		// `=.proplist=` as print (REST `.query` word == native `?`-word minus `?`).
		const queries = (request.query ?? []).map((word) => `?${word}`);
		// An addressed row (`ip/address/*1 --stream`) follows just that row, the
		// same `?.id=` mapping one-shot native reads use.
		if (request.id) {
			queries.push(`?.id=${request.id}`);
		}
		if (queries.length > 0) {
			command.queries = queries;
		}
		if (request.proplist && request.proplist.length > 0) {
			command.proplist = request.proplist;
		}
		const session = await this.connect();
		for await (const reply of session.listen(command, options)) {
			// Each `!re` becomes a rest-style record (string values; `.dead` preserved).
			yield { ...reply.attributes };
		}
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
			// Unified TLS trust: verify api-ssl peers by default; `--insecure` accepts
			// RouterOS's self-signed cert. (Previously native-api always accepted.)
			rejectUnauthorized: this.config.insecure !== true,
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

/**
 * MAC-Telnet execute adapter: drives a {@link MacTelnetConsole} over a UDP
 * datagram transport. Unlike REST/native this is a console transport, so it is
 * **execute-only** — `retrieve`/`inspect` are not mac-telnet capabilities
 * (matrix: retrieve/mac-telnet is out of scope), and `execute` runs the raw CLI
 * line over the console and returns the captured output as `ret`. Validation
 * over mac-telnet is the console `:parse` gate (see `execute.ts`).
 */
class MacTelnetAdapter implements ProtocolAdapter {
	readonly protocol: RouterOsProtocol = "mac-telnet";
	readonly capabilities: ProtocolAdapterCapabilities = {
		retrieve: false,
		execute: true,
		inspect: false,
	};
	private readonly destinationMac: MacAddress;
	/** Explicit client MAC from config; when unset, connect() resolves the real egress MAC. */
	private readonly explicitSourceMac?: MacAddress;
	private transport?: MacTelnetTransport;
	private console?: MacTelnetConsole;
	private opening?: Promise<MacTelnetConsole>;

	constructor(private readonly config: ProtocolAdapterConfig) {
		if (!config.mac) {
			throw new CentrsError({
				code: "internal/unhandled",
				summary: "The mac-telnet adapter was built without a target MAC.",
				remediation:
					"Report this bug; resolveTarget must set target.mac for mac-telnet.",
			});
		}
		this.destinationMac = parseMac(config.mac);
		this.explicitSourceMac = config.sourceMac
			? parseMac(config.sourceMac)
			: undefined;
	}

	private unsupported(operation: string): CentrsError {
		return new CentrsError({
			code: "transport/capability-unsupported",
			summary: `mac-telnet does not support ${operation}.`,
			remediation:
				"mac-telnet is an execute/terminal (console) transport; use `--via rest-api`/`native-api` to read structured data.",
			context: { via: "mac-telnet", operation },
		});
	}

	inspect(): Promise<unknown[]> {
		return Promise.reject(this.unsupported("/console/inspect"));
	}

	getSingleton(): Promise<unknown> {
		return Promise.reject(this.unsupported("singleton reads"));
	}

	list(): Promise<unknown[]> {
		return Promise.reject(this.unsupported("menu reads"));
	}

	async execute(
		request: ProtocolExecuteRequest,
	): Promise<ProtocolExecuteResult> {
		const cli = request.script;
		if (cli === undefined) {
			throw new CentrsError({
				code: "internal/unhandled",
				summary:
					"mac-telnet execute requires a raw CLI line (script), not a structured path command.",
				remediation:
					"Report this bug; runCommand must pass the raw command as `script` for mac-telnet.",
			});
		}
		const console = await this.open();
		const { output } = await console.run(cli);
		return { records: [], ret: output };
	}

	apiRequest(): Promise<ProtocolApiResult> {
		return Promise.reject(this.unsupported("structured api requests"));
	}

	// biome-ignore lint/correctness/useYield: a reject-only async generator yields nothing.
	async *listen(): AsyncGenerator<Record<string, unknown>> {
		throw this.unsupported("open-ended listen streaming");
	}

	async close(): Promise<void> {
		this.console?.close();
		this.transport?.close();
		this.console = undefined;
		this.transport = undefined;
		this.opening = undefined;
	}

	private open(): Promise<MacTelnetConsole> {
		if (this.console?.isReady) {
			return Promise.resolve(this.console);
		}
		if (!this.opening) {
			// On failure, tear down any partial socket/console and clear `opening` so
			// a later call can retry cleanly rather than re-await a rejected promise.
			this.opening = this.connect().catch((error) => {
				this.console?.close();
				this.transport?.close();
				this.console = undefined;
				this.transport = undefined;
				this.opening = undefined;
				throw error;
			});
		}
		return this.opening;
	}

	private async connect(): Promise<MacTelnetConsole> {
		const { sourceMac, host } = await this.resolveRoute();
		const transport = createUdpMacTelnetTransport({
			host,
			port: this.config.port,
			broadcast: isBroadcastHost(host),
		});
		await transport.ready();
		const console = new MacTelnetConsole({
			sink: transport,
			sourceMac,
			destinationMac: this.destinationMac,
			username: this.config.username ?? "",
			password: this.config.password,
			primeTimeoutMs: Math.max(this.config.timeoutMs, 30_000),
			commandTimeoutMs: this.config.timeoutMs,
		});
		transport.onMessage((bytes) => console.handlePacket(bytes));
		this.transport = transport;
		this.console = console;
		await console.open();
		return console;
	}

	/**
	 * Decide the in-packet source MAC and UDP delivery host. RouterOS only replies
	 * to a SESSIONSTART whose in-packet source MAC is the sending interface's real
	 * MAC, so a synthetic MAC is only a last resort.
	 *
	 * - An explicit configured source MAC always wins (keeps the configured host).
	 * - The default delivery host (the `255.255.255.255` sentinel) means "find the
	 *   device": spray every interface's directed broadcast and use the one that
	 *   answers — the only path that reaches a device on a non-default-route NIC
	 *   (e.g. ZeroTier), where WinBox's MAC connection also works.
	 * - An explicit host is honored, using that interface's real egress MAC.
	 */
	private resolveRoute(): Promise<{ sourceMac: MacAddress; host: string }> {
		return resolveMacTelnetRoute({
			destinationMac: this.destinationMac,
			host: this.config.host,
			port: this.config.port,
			timeoutMs: this.config.timeoutMs,
			explicitSourceMac: this.explicitSourceMac,
		});
	}
}

/**
 * Execute over SSH. RouterOS grants no pseudo-tty, but `ssh host "<command>"`
 * runs one single-line console command and returns clean output, so this is a
 * per-command batch adapter (like the SFTP client) — no persistent session,
 * `close()` is a no-op. It is a console transport: only the raw-CLI (`script`)
 * execute path applies; structured reads/inspect are unsupported (use
 * rest-api/native-api). Validation rides the shared `:put [:parse …]` gate the
 * orchestrator runs through `execute({ script })`.
 */
class SshExecAdapter implements ProtocolAdapter {
	readonly protocol: RouterOsProtocol = "ssh";
	readonly capabilities: ProtocolAdapterCapabilities = {
		retrieve: false,
		execute: true,
		inspect: false,
	};
	private readonly client: SshExecClient;

	constructor(config: ProtocolAdapterConfig) {
		this.client = new SshExecClient({
			host: config.host,
			port: config.port,
			username: config.username,
			sshKey: config.sshKey,
			insecure: config.insecure,
			timeoutMs: config.timeoutMs,
		});
	}

	private unsupported(operation: string): CentrsError {
		return new CentrsError({
			code: "transport/capability-unsupported",
			summary: `ssh does not support ${operation}.`,
			remediation:
				"ssh is an execute/terminal (console) transport; use `--via rest-api`/`native-api` to read structured data.",
			context: { via: "ssh", operation },
		});
	}

	inspect(): Promise<unknown[]> {
		return Promise.reject(this.unsupported("/console/inspect"));
	}

	getSingleton(): Promise<unknown> {
		return Promise.reject(this.unsupported("singleton reads"));
	}

	list(): Promise<unknown[]> {
		return Promise.reject(this.unsupported("menu reads"));
	}

	async execute(
		request: ProtocolExecuteRequest,
	): Promise<ProtocolExecuteResult> {
		const cli = request.script;
		if (cli === undefined) {
			throw new CentrsError({
				code: "internal/unhandled",
				summary:
					"ssh execute requires a raw CLI line (script), not a structured path command.",
				remediation:
					"Report this bug; runCommand must pass the raw command as `script` for ssh.",
			});
		}
		const output = await this.client.exec(cli);
		return { records: [], ret: output };
	}

	apiRequest(): Promise<ProtocolApiResult> {
		return Promise.reject(this.unsupported("structured api requests"));
	}

	// biome-ignore lint/correctness/useYield: a reject-only async generator yields nothing.
	async *listen(): AsyncGenerator<Record<string, unknown>> {
		throw this.unsupported("open-ended listen streaming");
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
}

/** REST `.query` / `.proplist` projection body for a POST `/print`. */
function restQueryBody(request: ProtocolApiRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	// Fold an id into `.query` as `.id=<id>` so id+query/proplist reads work over
	// REST exactly as they do over native (`?.id=` plus the `?`-words).
	const query = [
		...(request.id ? [`.id=${request.id}`] : []),
		...(request.query ?? []),
	];
	if (query.length > 0) {
		body[".query"] = query;
	}
	if (request.proplist && request.proplist.length > 0) {
		body[".proplist"] = request.proplist;
	}
	return body;
}

/**
 * Re-map a native add/set/remove reply to the rest-style shape. `add` returns the
 * new id in `=ret=`; surface it as `{".id": ret}` (REST returns the created
 * object with `.id`). `set`/`remove` reply with a bare `!done` (no records) → no
 * meaningful body, mirrored as `null`.
 */
function restStyleMutationData(
	records: readonly Record<string, string>[],
): unknown {
	if (records.length === 0) {
		return null;
	}
	const record = records[0] ?? {};
	const ret = record["ret"];
	if (typeof ret === "string" && /^\*[0-9A-F]+$/i.test(ret)) {
		return { ".id": ret };
	}
	return records.length === 1 ? record : records;
}

/** Re-map a native `/execute` reply: prefer the captured `ret` string, else the records. */
function restStyleRunData(records: readonly Record<string, string>[]): unknown {
	const ret = records.length === 1 ? records[0]?.["ret"] : undefined;
	if (typeof ret === "string") {
		return ret;
	}
	return records.length === 1 ? records[0] : records;
}

function exhaustiveApiVerb(verb: never): never {
	throw new Error(`Unhandled api verb: ${String(verb)}`);
}

/** Re-map an `as-string` native `/execute` reply into `ProtocolExecuteResult`,
 * mirroring `normalizeRestExecute`'s `ret`-vs-records split. */
function normalizeNativeExecute(
	records: readonly Record<string, string>[],
): ProtocolExecuteResult {
	const ret = records.length === 1 ? records[0]?.["ret"] : undefined;
	if (typeof ret === "string") {
		return { records: [], ret };
	}
	return { records: [...records] };
}

function normalizeRestExecute(data: unknown): ProtocolExecuteResult {
	if (Array.isArray(data)) {
		return { records: data.filter(isPlainObject) as Record<string, string>[] };
	}
	if (isPlainObject(data)) {
		const { ret } = data as { ret?: unknown };
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
		.filter(
			(reply) =>
				reply.type === "!re" ||
				(reply.type === "!done" && Object.keys(reply.attributes).length > 0),
		)
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
	} else if ("message" in error && typeof error.message === "string") {
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
