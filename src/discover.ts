/**
 * `centrs discover` core: the MNDP UDP listener plus the optional `--save` path
 * that persists discovered neighbors into the CDB.
 *
 * The wire codec ({@link parseMndpPacket}) and the cache ({@link MndpCache})
 * are pure and live in `src/data/`. This module is the thin, separately-tested
 * IO seam: it binds a UDP socket, decodes each datagram into the cache for a
 * `timeout` window, then returns a canonical {@link CentrsEnvelope}. The socket
 * layer ({@link listenMndp}) is injectable so {@link discover} can be unit
 * tested without a router, and the listener itself is tested by sending crafted
 * packets to the bound port over loopback.
 *
 * `--save` reuses WP-2a's {@link addDevice}: discovered records are written
 * through the atomic CDB writer with provenance in the comment kv-soup
 * (`source=mndp`) and `group=discovered`. Encrypted CDBs round-trip through
 * the write layer's `encryptWith` option (the password loaded from settings)
 * so discovered neighbors land on disk re-encrypted under the same secret.
 */

import { createSocket } from "node:dgram";
import type { CentrsEnvelope, EnvelopeMeta, Tip } from "./core/envelope.ts";
import { buildTip } from "./core/envelope.ts";
import {
	MNDP_BROADCAST_ADDRESS,
	MNDP_PORT,
	type MndpNeighbor,
	mndpRefreshPacket,
	parseMndpPacket,
} from "./data/mndp.ts";
import { MndpCache } from "./data/mndp-cache.ts";
import { type WinBoxCdbEntry, winBoxCdbRecordType } from "./data/winbox-cdb.ts";
import type { WriteWinBoxCdbOptions } from "./data/winbox-cdb-write.ts";
import {
	addDevice,
	type DevicesWarning,
	type LoadCdbOptions,
	loadCdb,
	resolveDevicesSettings,
} from "./devices.ts";
import { asCentrsError, CentrsError, serializeCentrsError } from "./errors.ts";
import { parseCommentKv, renderCommentKvToken } from "./resolver/comment-kv.ts";
import { normalizeMac } from "./resolver/mac.ts";

export { MNDP_PORT, MndpCache };

/** Default listen window when `--timeout` is omitted. */
export const DISCOVER_DEFAULT_TIMEOUT_MS = 15_000;
/** Default refresh-broadcast cadence inside the listen window. */
export const DISCOVER_DEFAULT_REFRESH_INTERVAL_MS = 5_000;
/** Default CDB group assigned to saved neighbors. */
export const DISCOVER_DEFAULT_GROUP = "discovered";

export interface ListenMndpOptions {
	/** Listen window in ms before the listener resolves. Default 15000. */
	timeoutMs?: number;
	/** UDP port to bind. Default 5678; pass `0` for an ephemeral test port. */
	port?: number;
	/** Bind address. Default `0.0.0.0`; tests use `127.0.0.1`. */
	host?: string;
	/** Cache TTL in ms, forwarded to a freshly created {@link MndpCache}. */
	ttlMs?: number;
	/** Cache to populate; a new one is created when omitted. */
	cache?: MndpCache;
	/** Clock injection forwarded to a freshly created {@link MndpCache}. */
	now?: () => number;
	/** Send the broadcast refresh that prompts replies. Default true. */
	sendRefresh?: boolean;
	/** Refresh cadence in ms; `0` sends a single refresh. Default 5000. */
	refreshIntervalMs?: number;
	/** Enable `SO_REUSEADDR`. Default true. */
	reuseAddr?: boolean;
	/** Enable `SO_REUSEPORT` for coexistence with other MNDP listeners. Default true. */
	reusePort?: boolean;
	/** Called once with the actually-bound port (useful with `port: 0`). */
	onBound?: (port: number) => void;
	/** Abort the listen early; resolves with whatever was collected so far. */
	signal?: AbortSignal;
}

export interface ListenMndpResult {
	/** Cache holding the decoded neighbors. */
	cache: MndpCache;
	/** Port the listener actually bound. */
	port: number;
	/** Datagrams received on the socket. */
	packetsReceived: number;
	/** Datagrams decoded into a neighbor with a MAC. */
	packetsDecoded: number;
	/** Datagrams ignored (self-echo, MAC-less, or malformed). */
	packetsRejected: number;
	/** Non-fatal anomalies observed during the listen (malformed, broadcast). */
	warnings: readonly DevicesWarning[];
}

function errorCodeOf(error: unknown): string | undefined {
	if (error && typeof error === "object" && "code" in error) {
		return String((error as { code: unknown }).code);
	}
	return undefined;
}

function listenError(error: unknown, port: number, host: string): CentrsError {
	const code =
		error && typeof error === "object" && "code" in error
			? String((error as { code: unknown }).code)
			: undefined;
	if (code === "EADDRINUSE") {
		return new CentrsError({
			code: "mndp/listen-failed",
			summary: `UDP port ${port} on ${host} is already in use; cannot bind the MNDP listener.`,
			remediation:
				"Stop the process holding the port (often WinBox), or pass a different --port. centrs enables SO_REUSEPORT, but the other process or platform may not allow sharing.",
			context: { port, host, cause: code },
			cause: error,
		});
	}
	if (code === "EACCES" || code === "EPERM") {
		return new CentrsError({
			code: "mndp/listen-failed",
			summary: `Permission denied binding UDP ${host}:${port} for the MNDP listener.`,
			remediation:
				"Bind an unprivileged port (MNDP's 5678 is unprivileged) or run with sufficient privileges for the chosen --port.",
			context: { port, host, cause: code },
			cause: error,
		});
	}
	return asCentrsError(error, {
		code: "mndp/listen-failed",
		summary: `Failed to bind the MNDP listener on ${host}:${port}.`,
		remediation:
			"Check the --port/host and that UDP sockets are permitted in this environment.",
		context: { port, host, cause: code },
	});
}

/**
 * Bind a UDP socket and collect MNDP announcements for `timeoutMs`, then
 * resolve with the populated cache. Bind/socket failures reject with an
 * actionable `mndp/listen-failed` {@link CentrsError}.
 */
export function listenMndp(
	options: ListenMndpOptions = {},
): Promise<ListenMndpResult> {
	const timeoutMs = options.timeoutMs ?? DISCOVER_DEFAULT_TIMEOUT_MS;
	const requestedPort = options.port ?? MNDP_PORT;
	const host = options.host ?? "0.0.0.0";
	const sendRefresh = options.sendRefresh ?? true;
	const refreshIntervalMs =
		options.refreshIntervalMs ?? DISCOVER_DEFAULT_REFRESH_INTERVAL_MS;
	const cache =
		options.cache ?? new MndpCache({ ttlMs: options.ttlMs, now: options.now });

	let packetsReceived = 0;
	let packetsDecoded = 0;
	let packetsRejected = 0;
	let malformedCount = 0;
	let broadcastError: unknown;

	const collectWarnings = (): DevicesWarning[] => {
		const warnings: DevicesWarning[] = [];
		if (malformedCount > 0) {
			warnings.push({
				code: "mndp/malformed",
				message: `Ignored ${malformedCount} malformed MNDP datagram(s) on the listen port.`,
				context: { count: malformedCount },
			});
		}
		if (broadcastError !== undefined) {
			warnings.push({
				code: "discover/broadcast-unavailable",
				message:
					"Could not enable UDP broadcast; discovery continued passively without sending refresh probes.",
				context: { cause: errorCodeOf(broadcastError) },
			});
		}
		return warnings;
	};

	return new Promise<ListenMndpResult>((resolve, reject) => {
		const socket = createSocket({
			type: "udp4",
			reuseAddr: options.reuseAddr ?? true,
			reusePort: options.reusePort ?? true,
		});
		let settled = false;
		let boundPort = requestedPort;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let refreshTimer: ReturnType<typeof setInterval> | undefined;

		const onAbort = (): void => finish();
		const cleanup = (): void => {
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
			}
			if (refreshTimer) {
				clearInterval(refreshTimer);
			}
			options.signal?.removeEventListener("abort", onAbort);
		};

		const finish = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			socket.close(() => {
				resolve({
					cache,
					port: boundPort,
					packetsReceived,
					packetsDecoded,
					packetsRejected,
					warnings: collectWarnings(),
				});
			});
		};

		const fail = (error: unknown): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			try {
				socket.close();
			} catch {
				// Socket may not be open yet; ignore.
			}
			reject(listenError(error, requestedPort, host));
		};

		socket.on("error", fail);
		socket.on("message", (message: Buffer) => {
			packetsReceived += 1;
			try {
				const neighbor = parseMndpPacket(new Uint8Array(message));
				if (!neighbor.macAddress) {
					// Self-echo of our own refresh, or a MAC-less announcement.
					packetsRejected += 1;
					return;
				}
				cache.observe(neighbor);
				packetsDecoded += 1;
			} catch {
				// Malformed datagram on the port; count and ignore (never throw
				// from the receive path). A single aggregated `mndp/malformed`
				// warning surfaces these in the envelope at finish time.
				packetsRejected += 1;
				malformedCount += 1;
			}
		});

		try {
			socket.bind(requestedPort, host, () => {
				boundPort = socket.address().port;
				options.onBound?.(boundPort);
				if (sendRefresh) {
					try {
						socket.setBroadcast(true);
					} catch (error) {
						// Some environments forbid broadcast; passive listen still
						// works, but surface it as a `discover/broadcast-unavailable`
						// warning so the caller knows no refresh probes were sent.
						broadcastError = error;
					}
					const refresh = (): void => {
						socket.send(
							mndpRefreshPacket(),
							MNDP_PORT,
							MNDP_BROADCAST_ADDRESS,
							() => {
								// Best-effort; a failed refresh does not end the listen.
							},
						);
					};
					refresh();
					if (refreshIntervalMs > 0) {
						refreshTimer = setInterval(refresh, refreshIntervalMs);
					}
				}
				timeoutTimer = setTimeout(finish, timeoutMs);
			});
		} catch (error) {
			fail(error);
			return;
		}

		if (options.signal) {
			if (options.signal.aborted) {
				finish();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
		}
	});
}

/** A neighbor projected for the discover envelope: JSON/YAML-safe, no bytes. */
export interface DiscoverNeighborRecord {
	mac?: string;
	identity?: string;
	version?: string;
	platform?: string;
	board?: string;
	uptimeSeconds?: number;
	softwareId?: string;
	interfaceName?: string;
	ipv4?: string;
	ipv6?: string;
	sequence: number;
	/** Unknown TLVs reduced to `{ type, byteLength }` (bytes are not emitted). */
	unknownTlvs: readonly { type: number; byteLength: number }[];
	firstSeenAt: string;
	lastSeenAt: string;
}

export interface DiscoverData {
	count: number;
	neighbors: readonly DiscoverNeighborRecord[];
}

export interface DiscoverSaveRecord {
	target: string;
	mac?: string;
	identity?: string;
	action: "added" | "skipped-existing";
	cdbRecordIndex?: number;
}

export interface DiscoverSaveSummary {
	group: string;
	added: number;
	skipped: number;
	records: readonly DiscoverSaveRecord[];
}

export interface DiscoverOperationMeta {
	command: "discover";
	timeoutMs: number;
	port: number;
	packetsReceived: number;
	packetsDecoded: number;
	packetsRejected: number;
	saved?: DiscoverSaveSummary;
}

export type DiscoverEnvelope = CentrsEnvelope<
	DiscoverData,
	DiscoverOperationMeta
>;

function toDiscoverNeighbor(
	neighbor: MndpNeighbor,
	firstSeenAt: number,
	lastSeenAt: number,
): DiscoverNeighborRecord {
	const record: DiscoverNeighborRecord = {
		sequence: neighbor.sequence,
		unknownTlvs: neighbor.unknownTlvs.map((tlv) => ({
			type: tlv.type,
			byteLength: tlv.value.length,
		})),
		firstSeenAt: new Date(firstSeenAt).toISOString(),
		lastSeenAt: new Date(lastSeenAt).toISOString(),
	};
	if (neighbor.macAddress !== undefined) {
		record.mac = neighbor.macAddress;
	}
	if (neighbor.identity !== undefined) {
		record.identity = neighbor.identity;
	}
	if (neighbor.version !== undefined) {
		record.version = neighbor.version;
	}
	if (neighbor.platform !== undefined) {
		record.platform = neighbor.platform;
	}
	if (neighbor.board !== undefined) {
		record.board = neighbor.board;
	}
	if (neighbor.uptimeSeconds !== undefined) {
		record.uptimeSeconds = neighbor.uptimeSeconds;
	}
	if (neighbor.softwareId !== undefined) {
		record.softwareId = neighbor.softwareId;
	}
	if (neighbor.interfaceName !== undefined) {
		record.interfaceName = neighbor.interfaceName;
	}
	if (neighbor.ipv4 !== undefined) {
		record.ipv4 = neighbor.ipv4;
	}
	if (neighbor.ipv6 !== undefined) {
		record.ipv6 = neighbor.ipv6;
	}
	return record;
}

/**
 * Build the comment for a saved neighbor: the allowlisted `source=mndp` token
 * and the `identity=`/`mac=` **lookup keys** (so the device resolves by any of
 * its identifiers — see `commands/devices/README.md`, Identity model), followed
 * by a free-form, parenthesized provenance detail. `identity=` is written
 * whenever advertised; `mac=` only when the **target is the IP** (a `macTarget`
 * record's target already *is* the MAC, so a `mac=` key would be redundant). The
 * parenthesized detail carries no `key=value` shapes, so it stays inert and
 * never emits a `cdb/unknown-option` warning later.
 */
export function formatMndpProvenanceComment(
	neighbor: MndpNeighbor,
	at: Date,
): string {
	const tokens: string[] = [renderCommentKvToken("source", "mndp")];
	if (neighbor.identity) {
		tokens.push(renderCommentKvToken("identity", neighbor.identity));
	}
	if (neighbor.ipv4 && neighbor.macAddress) {
		tokens.push(renderCommentKvToken("mac", neighbor.macAddress));
	}
	const detail: string[] = [`discovered ${at.toISOString()} via MNDP`];
	if (neighbor.platform) {
		detail.push(`platform: ${neighbor.platform}`);
	}
	if (neighbor.board) {
		detail.push(`board: ${neighbor.board}`);
	}
	if (neighbor.version) {
		detail.push(`version: ${neighbor.version}`);
	}
	if (neighbor.interfaceName) {
		detail.push(`interface: ${neighbor.interfaceName}`);
	}
	if (neighbor.softwareId) {
		detail.push(`software-id: ${neighbor.softwareId}`);
	}
	return `${tokens.join(" ")} (${detail.join("; ")})`;
}

/**
 * True when a discovered neighbor's MAC already names a CDB entry — as the
 * `target` of a `macTarget` record or as a `mac=` lookup key on any record. MNDP
 * always carries the MAC and it is globally unique, so it is the de-dupe key
 * (`commands/discover/README.md`, `--save` de-dupe); `identity` is *not*, since
 * factory-default devices all report `MikroTik`.
 */
function neighborMacKnown(
	entries: readonly WinBoxCdbEntry[],
	mac: string | undefined,
): boolean {
	const want = normalizeMac(mac ?? "");
	if (!want) {
		return false;
	}
	return entries.some((entry) => {
		if (normalizeMac(entry.target) === want) {
			return true;
		}
		const lookupMac = parseCommentKv(entry.comment).lookups.mac;
		return lookupMac !== undefined && normalizeMac(lookupMac) === want;
	});
}

/** Target a neighbor maps to in the CDB: its IPv4, else its MAC. */
export function discoverNeighborTarget(
	neighbor: MndpNeighbor,
): string | undefined {
	return neighbor.ipv4 ?? neighbor.macAddress;
}

export interface SaveDiscoveredNeighborsArgs {
	/** How to load (and reload between writes) the CDB. */
	loadOptions: LoadCdbOptions;
	/** Neighbors to persist; ordering is normalized internally by MAC/target. */
	neighbors: readonly MndpNeighbor[];
	/** First-class CDB group for new entries. Default `discovered`. */
	group?: string;
	/** Timestamp written into provenance comments. */
	now?: Date;
	/** Write options forwarded to {@link addDevice} (backup retention, etc.). */
	writeOptions?: WriteWinBoxCdbOptions;
}

export interface SaveDiscoveredNeighborsResult {
	summary: DiscoverSaveSummary;
	warnings: readonly DevicesWarning[];
}

/**
 * Persist discovered neighbors into the CDB via {@link addDevice}. De-dupe
 * rule: a neighbor whose target (IPv4, else MAC) already names a CDB entry is
 * skipped — never overwritten — so hand-curated records win. New neighbors are
 * added with `group=discovered` and `source=mndp` provenance. The CDB is
 * reloaded between writes so each `addDevice` sees the prior additions.
 */
export async function saveDiscoveredNeighbors(
	args: SaveDiscoveredNeighborsArgs,
): Promise<SaveDiscoveredNeighborsResult> {
	const group = args.group ?? DISCOVER_DEFAULT_GROUP;
	const at = args.now ?? new Date();
	const records: DiscoverSaveRecord[] = [];
	const warnings: DevicesWarning[] = [];
	let added = 0;
	let skipped = 0;

	const sorted = [...args.neighbors].sort((a, b) => {
		const left = discoverNeighborTarget(a) ?? "";
		const right = discoverNeighborTarget(b) ?? "";
		return left < right ? -1 : left > right ? 1 : 0;
	});

	let cdb = await loadCdb(args.loadOptions);
	for (const neighbor of sorted) {
		const target = discoverNeighborTarget(neighbor);
		if (!target) {
			continue;
		}
		// De-dupe on the MAC (globally unique, always advertised), and also skip a
		// target string that already names an entry — both guard a hand-curated
		// record from being clobbered, and the latter keeps `addDevice` from
		// failing `cdb/already-exists` on a colliding connectable address.
		const exists =
			neighborMacKnown(cdb.entries, neighbor.macAddress) ||
			cdb.entries.some((entry) => entry.target === target);
		const detail: DiscoverSaveRecord = {
			target,
			action: exists ? "skipped-existing" : "added",
		};
		if (neighbor.macAddress !== undefined) {
			detail.mac = neighbor.macAddress;
		}
		if (neighbor.identity !== undefined) {
			detail.identity = neighbor.identity;
		}
		if (exists) {
			skipped += 1;
			records.push(detail);
			continue;
		}

		const recordType = neighbor.ipv4
			? winBoxCdbRecordType.ipAdmin
			: winBoxCdbRecordType.macTarget;
		const envelope = await addDevice({
			cdb,
			target,
			recordType,
			group,
			comment: formatMndpProvenanceComment(neighbor, at),
			writeOptions: args.writeOptions,
		});
		added += 1;
		detail.cdbRecordIndex = envelope.data.cdbRecordIndex;
		records.push(detail);
		for (const warning of envelope.warnings) {
			warnings.push(warning);
		}
		cdb = await loadCdb(args.loadOptions);
	}

	return {
		summary: { group, added, skipped, records },
		warnings,
	};
}

export interface DiscoverOptions {
	/** Listen window in ms. Default 15000. */
	timeoutMs?: number;
	/** UDP port. Default 5678; `0` for an ephemeral test port. */
	port?: number;
	/** Bind address. Default `0.0.0.0`. */
	host?: string;
	/** Cache TTL in ms. */
	ttlMs?: number;
	/** Persist discovered neighbors into the CDB. */
	save?: boolean;
	/** CDB group for saved entries. Default `discovered`. */
	group?: string;
	/** CDB path override for `--save`. */
	cdbFile?: string;
	/** CDB password for `--save` against an encrypted CDB. */
	cdbPassword?: string;
	/** Environment snapshot for CDB resolution. */
	env?: Record<string, string | undefined>;
	/** Clock injection for the cache and provenance timestamps. */
	now?: () => number;
	/** Send the broadcast refresh. Default true. */
	sendRefresh?: boolean;
	/** Called once with the bound port (test hook). */
	onBound?: (port: number) => void;
	/** Abort the listen early. */
	signal?: AbortSignal;
	/** Listener injection so {@link discover} is testable without a socket. */
	listen?: (options: ListenMndpOptions) => Promise<ListenMndpResult>;
	/** Write options forwarded to the save path. */
	writeOptions?: WriteWinBoxCdbOptions;
}

function discoverMeta(
	operation: DiscoverOperationMeta,
	options: DiscoverOptions,
): EnvelopeMeta<DiscoverOperationMeta> {
	const settings = resolveDevicesSettings({
		cdbFile: options.cdbFile,
		cdbPassword: options.cdbPassword,
		env: options.env ?? {},
	});
	return {
		target: {},
		via: "mndp",
		settings: {
			timeoutMs: { kind: options.timeoutMs !== undefined ? "cli" : "default" },
			cdbFile: settings.cdbFile.source,
			cdbPassword: settings.cdbPassword.source,
		},
		operation,
	};
}

/**
 * Run an MNDP discovery: listen for `timeoutMs`, optionally persist the result
 * with `save`, and return a canonical envelope whose `data.neighbors` are
 * sorted deterministically by MAC. A `save` against an encrypted CDB re-encrypts
 * with the password loaded from settings via the write layer's `encryptWith`
 * option.
 */
export async function discover(
	options: DiscoverOptions = {},
): Promise<DiscoverEnvelope> {
	const timeoutMs = options.timeoutMs ?? DISCOVER_DEFAULT_TIMEOUT_MS;
	const listen = options.listen ?? listenMndp;

	let result: ListenMndpResult;
	try {
		result = await listen({
			timeoutMs,
			port: options.port,
			host: options.host,
			ttlMs: options.ttlMs,
			now: options.now,
			sendRefresh: options.sendRefresh,
			onBound: options.onBound,
			signal: options.signal,
		});
	} catch (error) {
		return buildDiscoverErrorEnvelope(options, timeoutMs, error);
	}

	const entries = result.cache.entries();
	const neighbors = entries.map((entry) =>
		toDiscoverNeighbor(entry.neighbor, entry.firstSeenAt, entry.lastSeenAt),
	);
	const operation: DiscoverOperationMeta = {
		command: "discover",
		timeoutMs,
		port: result.port,
		packetsReceived: result.packetsReceived,
		packetsDecoded: result.packetsDecoded,
		packetsRejected: result.packetsRejected,
	};

	const warnings: DevicesWarning[] = [...result.warnings];
	if (options.save) {
		try {
			const saved = await saveDiscoveredNeighbors({
				loadOptions: {
					cdbFile: options.cdbFile,
					cdbPassword: options.cdbPassword,
					env: options.env,
				},
				neighbors: entries.map((entry) => entry.neighbor),
				group: options.group,
				now: options.now ? new Date(options.now()) : undefined,
				writeOptions: options.writeOptions,
			});
			operation.saved = saved.summary;
			for (const warning of saved.warnings) {
				warnings.push(warning);
			}
		} catch (error) {
			return buildDiscoverErrorEnvelope(options, timeoutMs, error, operation);
		}
	}

	const tips: Tip[] = [];
	if (!options.save && neighbors.length > 0) {
		tips.push(
			buildTip(
				"tip/discover-save",
				`Found ${neighbors.length} neighbor(s); this run did not save them (read-only without --save).`,
				"Re-run with `--save` to persist them into the CDB (group=discovered) so you can target them by identity/ip/mac.",
			),
		);
	}

	return {
		ok: true,
		data: { count: neighbors.length, neighbors },
		warnings,
		tips,
		meta: discoverMeta(operation, options),
	};
}

function buildDiscoverErrorEnvelope(
	options: DiscoverOptions,
	timeoutMs: number,
	error: unknown,
	operation?: DiscoverOperationMeta,
): DiscoverEnvelope {
	const centrsError = asCentrsError(error, {
		code: "discover/failed",
		summary: error instanceof Error ? error.message : String(error),
		remediation:
			"Re-run `centrs discover`; check the --port, CDB path, and credentials when using --save.",
	});
	const op: DiscoverOperationMeta = operation ?? {
		command: "discover",
		timeoutMs,
		port: options.port ?? MNDP_PORT,
		packetsReceived: 0,
		packetsDecoded: 0,
		packetsRejected: 0,
	};
	return {
		ok: false,
		error: serializeCentrsError(centrsError),
		warnings: [],
		tips: [],
		meta: discoverMeta(op, options),
	};
}

export type DiscoverOutputFormat = "text" | "json" | "yaml";
export const discoverOutputFormats: readonly DiscoverOutputFormat[] = [
	"text",
	"json",
	"yaml",
];

export function renderDiscoverEnvelope(
	envelope: DiscoverEnvelope,
	format: DiscoverOutputFormat,
): string {
	if (format === "json") {
		return JSON.stringify(envelope, null, 2);
	}
	if (format === "yaml") {
		return renderDiscoverYaml(envelope);
	}
	return renderDiscoverText(envelope);
}

function renderDiscoverText(envelope: DiscoverEnvelope): string {
	const lines: string[] = [];
	if (!envelope.ok) {
		lines.push(`[${envelope.error.code}] ${envelope.error.summary}`);
		if (envelope.error.remediation) {
			lines.push(`Fix: ${envelope.error.remediation}`);
		}
		if (envelope.error.detailsUrl) {
			lines.push(`Details: ${envelope.error.detailsUrl}`);
		}
		appendDiscoverWarnings(lines, envelope.warnings);
		return lines.join("\n");
	}

	const op = envelope.meta.operation;
	const window = op ? `${Math.round(op.timeoutMs / 1000)}s` : "?";
	lines.push(
		`discovered ${envelope.data.count} neighbor(s) in ${window} on port ${op?.port ?? "?"}`,
	);
	if (envelope.data.neighbors.length > 0) {
		lines.push(["MAC", "IDENTITY", "BOARD", "VERSION", "IPV4"].join("\t"));
		for (const neighbor of envelope.data.neighbors) {
			lines.push(
				[
					neighbor.mac ?? "-",
					neighbor.identity ?? "-",
					neighbor.board ?? "-",
					neighbor.version ?? "-",
					neighbor.ipv4 ?? "-",
				].join("\t"),
			);
		}
	}
	if (op?.saved) {
		lines.push(
			`saved: ${op.saved.added} added, ${op.saved.skipped} skipped (group ${op.saved.group})`,
		);
	}
	appendDiscoverWarnings(lines, envelope.warnings);
	appendDiscoverTips(lines, envelope.tips);
	return lines.join("\n");
}

function appendDiscoverTips(lines: string[], tips: readonly Tip[]): void {
	if (tips.length === 0) {
		return;
	}
	lines.push("Tips:");
	for (const item of tips) {
		lines.push(`  - [${item.code}] ${item.message}`);
		if (item.fix) {
			lines.push(`    fix: ${item.fix}`);
		}
	}
}

function appendDiscoverWarnings(
	lines: string[],
	warnings: readonly DevicesWarning[],
): void {
	for (const warning of warnings) {
		lines.push(`warning: [${warning.code}] ${warning.message}`);
	}
}

function renderDiscoverYaml(value: unknown, indent = ""): string {
	if (value === null || value === undefined) {
		return `${indent}null`;
	}
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return "[]";
		}
		return value
			.map(
				(item) => `${indent}- ${renderDiscoverYamlInline(item, `${indent}  `)}`,
			)
			.join("\n");
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).filter(
			([, v]) => v !== undefined,
		);
		if (entries.length === 0) {
			return "{}";
		}
		return entries
			.map(([k, v]) => {
				const inline = renderDiscoverYamlInline(v, `${indent}  `);
				return inline.includes("\n")
					? `${indent}${k}:\n${inline}`
					: `${indent}${k}: ${inline}`;
			})
			.join("\n");
	}
	return String(value);
}

function renderDiscoverYamlInline(value: unknown, indent: string): string {
	if (Array.isArray(value) || (value !== null && typeof value === "object")) {
		return `\n${renderDiscoverYaml(value, indent)}`;
	}
	return renderDiscoverYaml(value, indent);
}
