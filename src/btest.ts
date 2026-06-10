/**
 * `centrs btest` orchestrator: the client and server commands built on the
 * session layer (`src/protocols/btest-session.ts`) and codec
 * (`src/protocols/btest.ts`).
 *
 * btest is centrs's peer-measurement surface — not a RouterOS-shaped command, so
 * there is no `:parse` / `/console/inspect` gate. Its product contract is
 * **option-grammar validation** (reject incoherent flag combinations *before*
 * opening a socket), EC-SRP5 auth, identity resolution, and the canonical
 * envelope. See `commands/btest/README.md` and `docs/CONSTITUTION.md` (Peer
 * measurement / Network listeners).
 *
 * Both commands run over time and stream live frames through `onReport` /
 * `onSession`; the returned envelope is the final, lossless aggregate.
 */

import { createServer } from "node:net";
import type { CentrsEnvelope, EnvelopeMeta } from "./core/envelope.ts";
import { asCentrsError, CentrsError, serializeCentrsError } from "./errors.ts";
import {
	BTEST_PORT,
	BTEST_UDP_PORT_START,
	type BtestAuthKind,
	type BtestDirection,
	type BtestProtocol,
} from "./protocols/btest.ts";
import {
	type BtestIntervalSample,
	type BtestStopReason,
	channelFromSocket,
	handleBtestServerConnection,
	runBtestClientSession,
} from "./protocols/btest-session.ts";
import { resolveAuth, resolveCdb, resolveTarget } from "./resolver/index.ts";

export { BTEST_PORT, BTEST_UDP_PORT_START };

/** Status-exchange cadence bounds (RouterOS `interval` 20ms..5s). */
const MIN_INTERVAL_MS = 20;
const MAX_INTERVAL_MS = 5000;
/** UDP per-packet size bounds (RouterOS `*-udp-tx-size`). */
const MIN_UDP_TX_SIZE = 28;
const MAX_UDP_TX_SIZE = 64000;
/** Default concurrent-session cap. */
const DEFAULT_MAX_SESSIONS = 100;

export type BtestOutputFormat = "text" | "csv" | "json" | "yaml";
export const btestOutputFormats: readonly BtestOutputFormat[] = [
	"text",
	"csv",
	"json",
	"yaml",
];

// ── Option-grammar validation (the product) ───────────────────────────────────

function optionError(option: string, summary: string): CentrsError {
	return new CentrsError({
		code: "validation/option",
		summary,
		remediation:
			"Adjust the flag to a value/combination btest accepts (see `centrs btest --help`).",
		context: { option },
	});
}

function requireRange(
	value: number | undefined,
	min: number,
	max: number,
	option: string,
): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || value < min || value > max) {
		throw optionError(
			option,
			`btest ${option} must be an integer in ${min}..${max} (got ${value}).`,
		);
	}
}

// ── Client ────────────────────────────────────────────────────────────────────

export interface BtestClientRequest {
	/** `<router>` positional (CDB identity / target / host). */
	targetInput?: string;
	host?: string;
	protocol?: BtestProtocol;
	direction?: BtestDirection;
	/** Control port; default 2000. */
	controlPort?: number;
	username?: string;
	password?: string;
	durationMs?: number;
	intervalMs?: number;
	connectionCount?: number;
	localUdpTxSize?: number;
	remoteUdpTxSize?: number;
	localTxSpeed?: number;
	remoteTxSpeed?: number;
	randomData?: boolean;
	natMode?: boolean;
	cdbFile?: string;
	cdbPassword?: string;
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
	/** Live per-interval frame callback (text/csv streaming). */
	onReport?: (record: BtestReportRecord) => void;
	/** Injection seam (tests). */
	runSession?: typeof runBtestClientSession;
}

/** One per-interval client report, lossless against the live stream. */
export interface BtestReportRecord {
	seq: number;
	direction: BtestDirection;
	protocol: BtestProtocol;
	txBps: number;
	rxBps: number;
	lostPackets: number;
	txBytes: number;
	rxBytes: number;
}

export interface BtestClientData {
	protocol: BtestProtocol;
	direction: BtestDirection;
	authKind: BtestAuthKind;
	user?: string;
	reports: readonly BtestReportRecord[];
	totalTxBytes: number;
	totalRxBytes: number;
	totalLostPackets: number;
	intervals: number;
	durationMs: number;
	txTotalAvgBps: number;
	rxTotalAvgBps: number;
	stopReason: BtestStopReason;
	serverUdpPort?: number;
	clientUdpPort?: number;
}

export interface BtestClientOperationMeta {
	command: "btest";
	mode: "client";
	protocol: BtestProtocol;
	direction: BtestDirection;
	controlPort: number;
}

export type BtestClientEnvelope = CentrsEnvelope<
	BtestClientData,
	BtestClientOperationMeta
>;

function validateClientOptions(request: BtestClientRequest): void {
	const protocol = request.protocol ?? "udp";
	if (request.connectionCount !== undefined) {
		if (protocol !== "tcp") {
			throw optionError(
				"connection-count",
				"btest connection-count applies only to --protocol tcp.",
			);
		}
		requireRange(request.connectionCount, 1, 255, "connection-count");
	}
	for (const [value, option] of [
		[request.localUdpTxSize, "local-udp-tx-size"],
		[request.remoteUdpTxSize, "remote-udp-tx-size"],
	] as const) {
		if (value !== undefined) {
			if (protocol !== "udp") {
				throw optionError(
					option,
					`btest ${option} applies only to --protocol udp.`,
				);
			}
			requireRange(value, MIN_UDP_TX_SIZE, MAX_UDP_TX_SIZE, option);
		}
	}
	requireRange(
		request.intervalMs,
		MIN_INTERVAL_MS,
		MAX_INTERVAL_MS,
		"interval",
	);
}

/** Per-protocol per-packet size from the local/remote UDP size flags. */
function clientTxSize(request: BtestClientRequest): number | undefined {
	if ((request.protocol ?? "udp") !== "udp") return undefined;
	const direction = request.direction ?? "receive";
	// The 16-byte command carries a single tx_size; pick the one for the active
	// direction (local for transmit/both, remote for a pure download).
	const size =
		direction === "receive"
			? request.remoteUdpTxSize
			: (request.localUdpTxSize ?? request.remoteUdpTxSize);
	return size;
}

/** Run a btest **client** test and return the aggregate summary envelope. */
export async function btestClient(
	request: BtestClientRequest,
): Promise<BtestClientEnvelope> {
	const env = request.env ?? Bun.env;
	const protocol = request.protocol ?? "udp";
	const direction = request.direction ?? "receive";
	const controlPort = request.controlPort ?? BTEST_PORT;
	const operation: BtestClientOperationMeta = {
		command: "btest",
		mode: "client",
		protocol,
		direction,
		controlPort,
	};

	try {
		validateClientOptions(request);

		const cdbResolution = await resolveCdb(
			{
				targetInput: request.targetInput,
				cdbFile: request.cdbFile,
				cdbPassword: request.cdbPassword,
			},
			env,
		);
		// btest is L3 to a control port; reuse the REST host-resolution path purely
		// to derive the host/identity (the resolved port/scheme are unused — the
		// control port is its own flag).
		const target = resolveTarget(
			{ targetInput: request.targetInput, host: request.host },
			env,
			"rest-api",
			cdbResolution,
		);
		const auth = resolveAuth(
			{ username: request.username, password: request.password },
			env,
			cdbResolution,
		);

		const reports: BtestReportRecord[] = [];
		const onInterval = (sample: BtestIntervalSample): void => {
			const record: BtestReportRecord = {
				seq: sample.seq,
				direction,
				protocol,
				txBps: sample.txBps,
				rxBps: sample.rxBps,
				lostPackets: sample.lostPackets,
				txBytes: sample.txBytes,
				rxBytes: sample.rxBytes,
			};
			reports.push(record);
			request.onReport?.(record);
		};

		const runSession = request.runSession ?? runBtestClientSession;
		const txSize = clientTxSize(request);
		const summary = await runSession({
			host: target.host,
			controlPort,
			protocol,
			direction,
			...(auth.username !== undefined ? { username: auth.username } : {}),
			...(auth.passwordProvided ? { password: auth.password } : {}),
			...(request.durationMs !== undefined
				? { durationMs: request.durationMs }
				: {}),
			...(request.intervalMs !== undefined
				? { statusIntervalMs: request.intervalMs }
				: {}),
			...(txSize !== undefined ? { txSize } : {}),
			...(request.localTxSpeed !== undefined
				? { localTxSpeed: request.localTxSpeed }
				: {}),
			...(request.remoteTxSpeed !== undefined
				? { remoteTxSpeed: request.remoteTxSpeed }
				: {}),
			...(request.randomData !== undefined
				? { randomData: request.randomData }
				: {}),
			...(request.natMode !== undefined ? { natMode: request.natMode } : {}),
			...(request.signal ? { signal: request.signal } : {}),
			onInterval,
		});

		const secs = summary.durationMs / 1000;
		const data: BtestClientData = {
			protocol: summary.protocol,
			direction: summary.direction,
			authKind: summary.authKind,
			reports,
			totalTxBytes: summary.totalTxBytes,
			totalRxBytes: summary.totalRxBytes,
			totalLostPackets: summary.totalLostPackets,
			intervals: summary.intervals,
			durationMs: summary.durationMs,
			txTotalAvgBps: secs > 0 ? (summary.totalTxBytes * 8) / secs : 0,
			rxTotalAvgBps: secs > 0 ? (summary.totalRxBytes * 8) / secs : 0,
			stopReason: summary.stopReason,
		};
		if (summary.username !== undefined) data.user = summary.username;
		if (summary.serverUdpPort !== undefined)
			data.serverUdpPort = summary.serverUdpPort;
		if (summary.clientUdpPort !== undefined)
			data.clientUdpPort = summary.clientUdpPort;

		return {
			ok: true,
			data,
			warnings: [],
			tips: [],
			meta: clientMeta(target.host, controlPort, operation, auth.username),
		};
	} catch (error) {
		return buildClientErrorEnvelope(request, operation, error);
	}
}

function clientMeta(
	host: string,
	port: number,
	operation: BtestClientOperationMeta,
	user?: string,
): EnvelopeMeta<BtestClientOperationMeta> {
	return {
		target: {
			host,
			port,
			...(user !== undefined ? { user } : {}),
		},
		via: "btest",
		settings: {},
		operation,
	};
}

function buildClientErrorEnvelope(
	request: BtestClientRequest,
	operation: BtestClientOperationMeta,
	error: unknown,
): BtestClientEnvelope {
	const centrsError = asCentrsError(error, {
		code: "routeros/btest-protocol",
		summary: error instanceof Error ? error.message : String(error),
		remediation:
			"Re-run `centrs btest client`; check the host, --port, and credentials.",
	});
	return {
		ok: false,
		error: serializeCentrsError(centrsError),
		warnings: [],
		tips: [],
		meta: {
			target: {
				...(request.host !== undefined ? { host: request.host } : {}),
				...(request.targetInput !== undefined
					? { input: request.targetInput }
					: {}),
				port: operation.controlPort,
			},
			via: "btest",
			settings: {},
			operation,
		},
	};
}

// ── Server ────────────────────────────────────────────────────────────────────

export interface BtestServerRequest {
	bind?: string;
	port?: number;
	authenticate?: boolean;
	username?: string;
	password?: string;
	allocateUdpPortsFrom?: number;
	maxSessions?: number;
	intervalMs?: number;
	durationMs?: number;
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
	/** Called once with the bound control port (test hook). */
	onBound?: (port: number) => void;
	/** Live per-session-event callback (text/csv streaming). */
	onSession?: (record: BtestSessionRecord) => void;
}

export interface BtestSessionRecord {
	client: string;
	protocol: BtestProtocol;
	/** Server-perspective direction (matches `/tool/bandwidth-server session`). */
	direction: BtestDirection;
	user: string;
	authKind: BtestAuthKind;
	connectionCount: number;
	totalTxBytes: number;
	totalRxBytes: number;
	totalLostPackets: number;
	intervals: number;
	durationMs: number;
	txAvgBps: number;
	rxAvgBps: number;
}

export interface BtestServerData {
	bind: string;
	port: number;
	authenticate: boolean;
	maxSessions: number;
	sessions: readonly BtestSessionRecord[];
	stopReason: BtestStopReason;
}

export interface BtestServerOperationMeta {
	command: "btest";
	mode: "server";
	bind: string;
	port: number;
}

export type BtestServerEnvelope = CentrsEnvelope<
	BtestServerData,
	BtestServerOperationMeta
>;

function validateServerOptions(request: BtestServerRequest): void {
	requireRange(request.maxSessions, 1, 1000, "max-sessions");
	requireRange(
		request.intervalMs,
		MIN_INTERVAL_MS,
		MAX_INTERVAL_MS,
		"interval",
	);
	// 0 = OS-assigned ephemeral control port (tests / dynamic binding).
	requireRange(request.port, 0, 65535, "port");
	requireRange(
		request.allocateUdpPortsFrom,
		1,
		65535,
		"allocate-udp-ports-from",
	);
	// The UDP data-port window [allocateFrom, allocateFrom + maxSessions) must fit
	// under 65535, or later sessions would be assigned an out-of-range port at
	// runtime — reject the incoherent combination up front.
	const allocFrom = request.allocateUdpPortsFrom ?? BTEST_UDP_PORT_START;
	const sessionCap = request.maxSessions ?? DEFAULT_MAX_SESSIONS;
	if (allocFrom + sessionCap - 1 > 65535) {
		throw optionError(
			"allocate-udp-ports-from",
			`btest allocate-udp-ports-from (${allocFrom}) + max-sessions (${sessionCap}) would run past UDP port 65535; lower one of them.`,
		);
	}
}

function serverDirectionLabel(
	serverTx: boolean,
	serverRx: boolean,
): BtestDirection {
	if (serverTx && serverRx) return "both";
	return serverTx ? "transmit" : "receive";
}

/** Run the btest **server** listener until `durationMs` elapses or aborted. */
export async function btestServer(
	request: BtestServerRequest,
): Promise<BtestServerEnvelope> {
	const bind = request.bind ?? "127.0.0.1";
	const port = request.port ?? BTEST_PORT;
	const authenticate = request.authenticate ?? true;
	const maxSessions = request.maxSessions ?? DEFAULT_MAX_SESSIONS;
	const allocateFrom = request.allocateUdpPortsFrom ?? BTEST_UDP_PORT_START;
	// Resolve the single accepted credential through the same path as the client
	// (flags first, then CENTRS_USERNAME / CENTRS_PASSWORD). No CDB here — the
	// server has no target device.
	const auth = resolveAuth(
		{ username: request.username, password: request.password },
		request.env ?? Bun.env,
	);
	const operation: BtestServerOperationMeta = {
		command: "btest",
		mode: "server",
		bind,
		port,
	};

	try {
		validateServerOptions(request);
		// authenticate=true (the default) without a credential would bind a server
		// that rejects every client — fail fast instead.
		if (
			authenticate &&
			(auth.username === undefined || !auth.passwordProvided)
		) {
			throw optionError(
				"authenticate",
				"btest server authenticate=true needs --user and --password (or CENTRS_USERNAME / CENTRS_PASSWORD); pass --no-authenticate for an open server.",
			);
		}
	} catch (error) {
		return buildServerErrorEnvelope(operation, error);
	}

	const sessions: BtestSessionRecord[] = [];
	const warnings: { code: string; message: string }[] = [];
	const sessionTasks: Promise<void>[] = [];
	const abort = new AbortController();
	let active = 0;
	let udpOffset = 0;
	let stopReason: BtestStopReason = "interrupted";

	const externalAbort = (): void => {
		stopReason = "interrupted";
		abort.abort();
	};
	if (request.signal) {
		if (request.signal.aborted) externalAbort();
		else
			request.signal.addEventListener("abort", externalAbort, { once: true });
	}

	const server = createServer((socket) => {
		const channel = channelFromSocket(socket);
		const client = socket.remoteAddress ?? "unknown";
		if (active >= maxSessions) {
			warnings.push({
				code: "routeros/btest-too-many-sessions",
				message: `Refused ${client}: max-sessions (${maxSessions}) reached.`,
			});
			channel.close();
			return;
		}
		active += 1;
		// Wrap within the validated [allocateFrom, allocateFrom + maxSessions)
		// window so a long-lived server never walks the monotonic counter past
		// 65535; at most `maxSessions` ports are ever live at once.
		const serverUdpPort = allocateFrom + (udpOffset % maxSessions);
		udpOffset += 1;
		sessionTasks.push(
			(async () => {
				try {
					const result = await handleBtestServerConnection(channel, {
						authenticate,
						// Only the resolved credential, and only when auth is on (never
						// leak creds into an unauthenticated handshake).
						...(authenticate && auth.username !== undefined
							? { username: auth.username }
							: {}),
						...(authenticate && auth.passwordProvided
							? { password: auth.password }
							: {}),
						serverUdpPort,
						udpBindHost: bind === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0",
						...(request.intervalMs !== undefined
							? { statusIntervalMs: request.intervalMs }
							: {}),
						signal: abort.signal,
					});
					const cmd = result.negotiated.command;
					const secs = result.durationMs / 1000;
					const record: BtestSessionRecord = {
						client,
						protocol: cmd.protocol,
						direction: serverDirectionLabel(
							cmd.serverTransmits,
							cmd.serverReceives,
						),
						user: result.negotiated.username ?? "",
						authKind: result.negotiated.authKind,
						connectionCount: cmd.tcpConnectionCount,
						totalTxBytes: result.totalTxBytes,
						totalRxBytes: result.totalRxBytes,
						totalLostPackets: result.totalLostPackets,
						intervals: result.intervals,
						durationMs: result.durationMs,
						txAvgBps: secs > 0 ? (result.totalTxBytes * 8) / secs : 0,
						rxAvgBps: secs > 0 ? (result.totalRxBytes * 8) / secs : 0,
					};
					sessions.push(record);
					request.onSession?.(record);
				} catch (error) {
					// Auth failures / malformed peers keep the server alive — record the
					// anomaly and drop the connection (mirrors RouterOS).
					const code =
						error instanceof CentrsError
							? error.code
							: "routeros/btest-protocol";
					warnings.push({
						code,
						message: `Session from ${client} failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
					});
				} finally {
					active -= 1;
					channel.close();
				}
			})(),
		);
	});

	let boundPort = port;
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, bind, () => {
				boundPort = (server.address() as { port: number }).port;
				operation.port = boundPort;
				request.onBound?.(boundPort);
				resolve();
			});
		});
	} catch (error) {
		return buildServerErrorEnvelope(operation, listenError(error, bind, port));
	}

	await new Promise<void>((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (request.durationMs !== undefined) {
			timer = setTimeout(() => {
				stopReason = "duration-elapsed";
				resolve();
			}, request.durationMs);
		}
		abort.signal.addEventListener(
			"abort",
			() => {
				if (timer) clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});

	server.close();
	abort.abort(); // stop in-flight sessions
	await Promise.allSettled(sessionTasks);
	if (request.signal)
		request.signal.removeEventListener("abort", externalAbort);

	return {
		ok: true,
		data: {
			bind,
			port: boundPort,
			authenticate,
			maxSessions,
			sessions,
			stopReason,
		},
		warnings: warnings.map((w) => ({ ...w })),
		tips: [],
		meta: { target: {}, via: "btest", settings: {}, operation },
	};
}

function listenError(error: unknown, bind: string, port: number): CentrsError {
	const code =
		error && typeof error === "object" && "code" in error
			? String((error as { code: unknown }).code)
			: undefined;
	if (code === "EADDRINUSE") {
		// Local bind failure — not a remote peer refusing us, so `transport/network`
		// rather than `transport/connection-refused`.
		return new CentrsError({
			code: "transport/network",
			summary: `TCP ${bind}:${port} is already in use; cannot bind the btest server.`,
			remediation:
				"Stop the process holding the port (often another bandwidth server), or pass a different --port.",
			context: { bind, port, cause: code },
			cause: error,
		});
	}
	return asCentrsError(error, {
		code: "transport/network",
		summary: `Failed to bind the btest server on ${bind}:${port}.`,
		remediation:
			"Check --bind/--port and that TCP listeners are permitted here.",
		context: { bind, port, cause: code },
	});
}

function buildServerErrorEnvelope(
	operation: BtestServerOperationMeta,
	error: unknown,
): BtestServerEnvelope {
	const centrsError = asCentrsError(error, {
		code: "routeros/btest-protocol",
		summary: error instanceof Error ? error.message : String(error),
		remediation:
			"Re-run `centrs btest server`; check --bind/--port and credentials.",
	});
	return {
		ok: false,
		error: serializeCentrsError(centrsError),
		warnings: [],
		tips: [],
		meta: { target: {}, via: "btest", settings: {}, operation },
	};
}

// ── Output rendering ──────────────────────────────────────────────────────────

/**
 * CSV header for the client interval stream. Columns track the row emitted by
 * {@link btestClientCsvRow} 1:1 — `seq` is the status sequence number and
 * `tx_bytes`/`rx_bytes` are the per-interval byte counts (not packet sizes).
 */
export const BTEST_CLIENT_CSV_HEADER =
	"seq,direction,protocol,tx_bps,rx_bps,lost_packets,tx_bytes,rx_bytes";
/**
 * CSV header for the server session stream. `duration_ms` is the session
 * lifetime, `tx_bps`/`rx_bps` are its average throughput, and `lost_packets` is
 * the session's UDP loss total (0 for TCP).
 */
export const BTEST_SERVER_CSV_HEADER =
	"duration_ms,event,client,protocol,direction,user,tx_bps,rx_bps,lost_packets";

/**
 * RFC 4180 field escape: wrap in double quotes (doubling any internal quote)
 * when the value carries a comma, quote, or newline. Keeps string fields like
 * `user` and `client` (e.g. an IPv6 address) from breaking the column layout.
 */
function escapeCsvField(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function btestClientCsvRow(record: BtestReportRecord): string {
	return [
		record.seq,
		escapeCsvField(record.direction),
		escapeCsvField(record.protocol),
		Math.round(record.txBps),
		Math.round(record.rxBps),
		record.lostPackets,
		record.txBytes,
		record.rxBytes,
	].join(",");
}

export function btestServerCsvRow(record: BtestSessionRecord): string {
	return [
		record.durationMs,
		"session",
		escapeCsvField(record.client),
		escapeCsvField(record.protocol),
		escapeCsvField(record.direction),
		escapeCsvField(record.user),
		Math.round(record.txAvgBps),
		Math.round(record.rxAvgBps),
		record.totalLostPackets,
	].join(",");
}

function formatBps(bps: number): string {
	if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`;
	if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mbps`;
	if (bps >= 1e3) return `${(bps / 1e3).toFixed(2)} Kbps`;
	return `${Math.round(bps)} bps`;
}

export function formatBtestReportText(record: BtestReportRecord): string {
	const parts = [`[${String(record.seq).padStart(3)}]`];
	if (record.direction !== "receive")
		parts.push(`tx ${formatBps(record.txBps)}`);
	if (record.direction !== "transmit")
		parts.push(`rx ${formatBps(record.rxBps)}`);
	if (record.lostPackets > 0) parts.push(`lost ${record.lostPackets}`);
	return parts.join("  ");
}

export function formatBtestSessionText(record: BtestSessionRecord): string {
	const rate =
		record.direction === "receive"
			? `rx ${formatBps(record.rxAvgBps)}`
			: record.direction === "transmit"
				? `tx ${formatBps(record.txAvgBps)}`
				: `tx ${formatBps(record.txAvgBps)} / rx ${formatBps(record.rxAvgBps)}`;
	const auth = record.authKind === "none" ? "" : ` user=${record.user}`;
	return `session ${record.client} ${record.protocol} ${record.direction}${auth}  ${rate}`;
}

export function renderBtestClientEnvelope(
	envelope: BtestClientEnvelope,
	format: BtestOutputFormat,
): string {
	if (format === "json") return JSON.stringify(envelope, null, 2);
	if (format === "yaml") return renderYaml(envelope);
	if (format === "csv") return renderClientCsv(envelope);
	return renderClientText(envelope);
}

export function renderBtestServerEnvelope(
	envelope: BtestServerEnvelope,
	format: BtestOutputFormat,
): string {
	if (format === "json") return JSON.stringify(envelope, null, 2);
	if (format === "yaml") return renderYaml(envelope);
	if (format === "csv") return renderServerCsv(envelope);
	return renderServerText(envelope);
}

function renderClientCsv(envelope: BtestClientEnvelope): string {
	const lines = [BTEST_CLIENT_CSV_HEADER];
	if (envelope.ok)
		for (const r of envelope.data.reports) lines.push(btestClientCsvRow(r));
	else
		lines.push(`# error: [${envelope.error.code}] ${envelope.error.summary}`);
	return lines.join("\n");
}

function renderServerCsv(envelope: BtestServerEnvelope): string {
	const lines = [BTEST_SERVER_CSV_HEADER];
	if (envelope.ok)
		for (const s of envelope.data.sessions) lines.push(btestServerCsvRow(s));
	else
		lines.push(`# error: [${envelope.error.code}] ${envelope.error.summary}`);
	return lines.join("\n");
}

/** The single trailing summary line for a finished client run. */
export function btestClientSummaryLine(d: BtestClientData): string {
	const total =
		d.direction === "transmit"
			? `tx ${formatBps(d.txTotalAvgBps)}`
			: d.direction === "receive"
				? `rx ${formatBps(d.rxTotalAvgBps)}`
				: `tx ${formatBps(d.txTotalAvgBps)} / rx ${formatBps(d.rxTotalAvgBps)}`;
	return (
		`${d.protocol} ${d.direction} done: ${total} over ${(d.durationMs / 1000).toFixed(1)}s` +
		(d.totalLostPackets > 0 ? `, lost ${d.totalLostPackets}` : "") +
		` (${d.stopReason})`
	);
}

/** The header line for a finished server run. */
export function btestServerSummaryLine(d: BtestServerData): string {
	return `btest server ${d.bind}:${d.port} (${d.sessions.length} session(s), ${d.stopReason})`;
}

function renderClientText(envelope: BtestClientEnvelope): string {
	if (!envelope.ok) return formatErrorText(envelope.error);
	const lines = envelope.data.reports.map(formatBtestReportText);
	lines.push(btestClientSummaryLine(envelope.data));
	return lines.join("\n");
}

function renderServerText(envelope: BtestServerEnvelope): string {
	if (!envelope.ok) return formatErrorText(envelope.error);
	const lines = [btestServerSummaryLine(envelope.data)];
	for (const s of envelope.data.sessions) lines.push(formatBtestSessionText(s));
	for (const w of envelope.warnings)
		lines.push(`warning: [${w.code}] ${w.message}`);
	return lines.join("\n");
}

function formatErrorText(error: {
	code: string;
	summary: string;
	remediation?: string;
	detailsUrl?: string;
}): string {
	const lines = [`[${error.code}] ${error.summary}`];
	if (error.remediation) lines.push(`Fix: ${error.remediation}`);
	if (error.detailsUrl) lines.push(`Details: ${error.detailsUrl}`);
	return lines.join("\n");
}

// Compact YAML renderer (per-command, matching the discover surface).
function renderYaml(value: unknown, indent = ""): string {
	if (value === null || value === undefined) return `${indent}null`;
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		return value
			.map((item) => `${indent}- ${yamlInline(item, `${indent}  `)}`)
			.join("\n");
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).filter(
			([, v]) => v !== undefined,
		);
		if (entries.length === 0) return "{}";
		return entries
			.map(([k, v]) => {
				const inline = yamlInline(v, `${indent}  `);
				return inline.includes("\n")
					? `${indent}${k}:\n${inline}`
					: `${indent}${k}: ${inline}`;
			})
			.join("\n");
	}
	return String(value);
}

function yamlInline(value: unknown, indent: string): string {
	if (Array.isArray(value) || (value !== null && typeof value === "object")) {
		return `\n${renderYaml(value, indent)}`;
	}
	return renderYaml(value, indent);
}
