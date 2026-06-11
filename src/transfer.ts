/**
 * `transfer` — copy files to and from a RouterOS device, and manage device
 * files, over the REST / native-API `/file` menu.
 *
 * Design and grounding live in `commands/transfer/README.md`; the executable
 * spec is `commands/transfer/examples.md`. The load-bearing facts this module
 * encodes:
 *
 * - RouterOS file I/O is **asymmetric**: `/file/set contents` writes are capped
 *   at 60 KB, but reads scale via chunked `/file/read` (≤32 KB/chunk). So the
 *   default method is size- and direction-aware (see {@link selectTransferMethod}).
 * - Every `/file` operation is command-shaped, so it rides the shared
 *   {@link ProtocolAdapter} `execute`/`list` seam over both REST and native-api.
 *   Each file is resolved to its `.id` by a `print` probe, which doubles as the
 *   validate-before-write existence guard.
 * - `sftp`/`scp`/`fetch`/`ftp` are designed but not built in this pass; an
 *   explicit `--via` to one of them returns a defined not-implemented / gated
 *   error (examples P1–P4).
 */

import { readFileSync, writeFileSync } from "node:fs";
import type {
	CentrsEnvelope,
	CentrsErrorEnvelope,
	CentrsSuccessEnvelope,
	SettingSource as CoreSettingSource,
	EnvelopeValidationMeta,
	Warning,
} from "./core/envelope.ts";
import { CentrsError, serializeCentrsError } from "./errors.ts";
import {
	createProtocolAdapter,
	type ProtocolAdapter,
	type ProtocolExecuteResult,
} from "./protocols/adapter.ts";
import type { RouterOsProtocol } from "./protocols/index.ts";
import {
	type CdbResolution,
	parseDuration,
	type ResolvedAuth,
	type ResolvedSetting,
	type ResolvedTarget,
	resolveAuth,
	resolveBooleanSetting,
	resolveCdb,
	resolveStringSetting,
	resolveTarget,
	toCoreSource,
} from "./resolver/index.ts";
import { toYaml } from "./retrieve.ts";

export const transferOutputFormats = ["text", "json", "yaml"] as const;
export type TransferOutputFormat = (typeof transferOutputFormats)[number];

/** Direction / management sub-verbs. `list` is sugar over a `/file/print` read. */
export const transferVerbs = [
	"upload",
	"download",
	"list",
	"remove",
	"mkdir",
	"copy",
] as const;
export type TransferVerb = (typeof transferVerbs)[number];

/**
 * `--via` method names. These are transfer *methods*, finer than the grid
 * transport: `rest`/`native` ride rest-api/native-api; `sftp`/`scp` ride ssh;
 * `fetch` rides rest-api/native-api plus an inbound HTTP server; `ftp` is gated.
 */
export const transferMethods = [
	"sftp",
	"scp",
	"rest",
	"native",
	"fetch",
	"ftp",
] as const;
export type TransferMethod = (typeof transferMethods)[number];

/** RouterOS `/file` contents write cap (`/file/set contents`). */
export const REST_FILE_WRITE_CAP_BYTES = 60_000;
/** Maximum `/file/read` chunk RouterOS accepts (`chunk-size` upper bound). */
export const FILE_READ_CHUNK_BYTES = 32_768;

export interface TransferRequest {
	verb: TransferVerb;
	targetInput?: string;
	/** Local path (or `-` for stdin/stdout). Present for upload/download. */
	local?: string;
	/** RouterOS file path. Present for upload/download/remove/mkdir and copy source. */
	remote?: string;
	/** Copy destination (on-device). */
	remoteDest?: string;
	/** `list` path prefix filter (optional). */
	path?: string;
	via?: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	timeout?: string | number;
	format?: string;
	validate?: boolean;
	verbose?: boolean;
	/** Replace an existing destination instead of refusing it. */
	force?: boolean;
	/** Integrity check: `size` (default), `checksum`, or `off`. */
	verify?: string;
	/** `list` filter: row type. */
	type?: string;
	/** `list` filter: name glob. */
	name?: string;
	cdbFile?: string;
	cdbPassword?: string;
}

export type TransferOp = TransferVerb;

export interface TransferData {
	op: TransferOp;
	remote: string | null;
	local: string | null;
	bytes: number | null;
	verified: "size" | "checksum" | "off" | null;
	/** Concrete method used (`rest`, `native`, …). */
	method: TransferMethod;
	durationMs?: number;
	/** Only on `list`: the `/file` rows. */
	rows?: readonly Record<string, unknown>[];
}

export interface TransferOperationMeta {
	op: TransferOp;
	method: TransferMethod;
	request: {
		verb: TransferVerb;
		remote: string | null;
		local: string | null;
		force: boolean;
		verify: "size" | "checksum" | "off";
		validate: boolean;
		format: TransferOutputFormat;
	};
	auth: { username?: string; passwordProvided: boolean };
}

export type TransferEnvelope = CentrsEnvelope<
	TransferData | readonly Record<string, unknown>[],
	TransferOperationMeta
>;
export type TransferSuccessEnvelope = CentrsSuccessEnvelope<
	TransferData | readonly Record<string, unknown>[],
	TransferOperationMeta
>;
export type TransferErrorEnvelope = CentrsErrorEnvelope<TransferOperationMeta>;

interface ResolvedTransferRequest {
	verb: TransferVerb;
	method: TransferMethod;
	protocol: RouterOsProtocol;
	target: ResolvedTarget;
	auth: ResolvedAuth;
	timeoutMs: ResolvedSetting<number>;
	format: ResolvedSetting<TransferOutputFormat>;
	validate: ResolvedSetting<boolean>;
	via: ResolvedSetting<string>;
	local?: string;
	remote?: string;
	remoteDest?: string;
	listPath?: string;
	force: boolean;
	verify: "size" | "checksum" | "off";
	type?: string;
	name?: string;
	verbose: boolean;
	warnings: readonly Warning[];
}

// ── Public entry ────────────────────────────────────────────────────────────

export async function transfer(
	request: TransferRequest,
	env: Record<string, string | undefined> = Bun.env,
): Promise<TransferSuccessEnvelope> {
	const resolved = await resolveTransferRequest(request, env);
	const backend = createProtocolAdapter({
		protocol: resolved.protocol,
		host: resolved.target.host,
		port: resolved.target.port,
		tls: resolved.target.tls,
		baseUrl: resolved.target.baseUrl,
		username: resolved.auth.username,
		password: resolved.auth.password,
		timeoutMs: resolved.timeoutMs.value,
	});
	try {
		return await runResolvedTransfer(resolved, backend);
	} finally {
		await backend.close();
	}
}

/**
 * The verb dispatch shared by `transfer()` and (future) fanout. Takes an
 * already-built adapter so tests can drive it with a mocked transport.
 */
export async function runResolvedTransfer(
	resolved: ResolvedTransferRequest,
	backend: ProtocolAdapter,
): Promise<TransferSuccessEnvelope> {
	const startedAt = Date.now();
	const warnings: Warning[] = [...resolved.warnings];

	const result = await dispatchTransferVerb(resolved, backend, warnings);
	const durationMs = Date.now() - startedAt;

	if (resolved.verb === "list") {
		return buildSuccessEnvelope(
			resolved,
			result.rows ?? [],
			{ ...result.data, durationMs },
			warnings,
		);
	}

	return buildSuccessEnvelope(
		resolved,
		{ ...result.data, durationMs },
		{ ...result.data, durationMs },
		warnings,
	);
}

interface VerbResult {
	data: TransferData;
	rows?: readonly Record<string, unknown>[];
}

async function dispatchTransferVerb(
	resolved: ResolvedTransferRequest,
	backend: ProtocolAdapter,
	warnings: Warning[],
): Promise<VerbResult> {
	switch (resolved.verb) {
		case "list":
			return runList(resolved, backend);
		case "upload":
			return runUpload(resolved, backend, warnings);
		case "download":
			return runDownload(resolved, backend);
		case "remove":
			return runRemove(resolved, backend);
		case "mkdir":
			return runMkdir(resolved, backend);
		case "copy":
			return runCopy(resolved, backend);
		default:
			return exhaustiveVerb(resolved.verb);
	}
}

// ── Verb implementations (REST / native via the adapter) ────────────────────

async function runList(
	resolved: ResolvedTransferRequest,
	backend: ProtocolAdapter,
): Promise<VerbResult> {
	const rows = (await backend.list("/file", {
		proplist: [".id", "name", "type", "size", "last-modified"],
	})) as Record<string, unknown>[];
	const filtered = rows.filter((row) => matchesListFilters(row, resolved));
	return {
		rows: filtered,
		data: baseData(resolved, { op: "list", remote: null, local: null }),
	};
}

async function runUpload(
	resolved: ResolvedTransferRequest,
	backend: ProtocolAdapter,
	warnings: Warning[],
): Promise<VerbResult> {
	const remote = requireRemote(resolved);
	const bytes = readLocalSource(resolved);
	const text = bytes.toString("utf8");

	if (bytes.byteLength > REST_FILE_WRITE_CAP_BYTES) {
		throw restWriteCapError(remote, bytes.byteLength);
	}

	const existing = await findFile(backend, remote);
	if (existing && !resolved.force) {
		throw targetExistsError(remote);
	}

	let id = existing?.id;
	if (!id) {
		const added = await backend.execute({
			path: "/file",
			command: "add",
			attributes: { name: remote, type: "file" },
		});
		id = extractNewId(added) ?? (await findFile(backend, remote))?.id;
	}
	if (!id) {
		throw new CentrsError({
			code: "routeros/command-failed",
			summary: `RouterOS did not create the file ${remote}.`,
			remediation:
				"Confirm the path is writable and the user has `ftp`/`write` policy.",
			context: { remote },
		});
	}

	await backend.execute({
		path: "/file",
		command: "set",
		attributes: { ".id": id, contents: text },
	});

	const verified = await verifyWrittenSize(
		resolved,
		backend,
		remote,
		bytes.byteLength,
		warnings,
	);

	return {
		data: baseData(resolved, {
			op: "upload",
			remote,
			local: localLabel(resolved),
			bytes: bytes.byteLength,
			verified,
		}),
	};
}

async function runDownload(
	resolved: ResolvedTransferRequest,
	backend: ProtocolAdapter,
): Promise<VerbResult> {
	const remote = requireRemote(resolved);
	const row = await findFile(backend, remote);
	if (!row) {
		throw new CentrsError({
			code: "routeros/command-failed",
			summary: `RouterOS has no file named ${remote}.`,
			remediation:
				"Check the remote path (RouterOS file names have no leading slash); `transfer list` shows what is present.",
			context: { remote },
		});
	}

	const bytes =
		row.size !== undefined && row.size <= REST_FILE_WRITE_CAP_BYTES
			? await downloadSmall(backend, row.id)
			: await downloadChunked(backend, remote, row.size);

	writeLocalSink(resolved, bytes);

	return {
		data: baseData(resolved, {
			op: "download",
			remote,
			local: localLabel(resolved),
			bytes: bytes.byteLength,
			verified: resolved.verify === "off" ? "off" : "size",
		}),
	};
}

async function runRemove(
	resolved: ResolvedTransferRequest,
	backend: ProtocolAdapter,
): Promise<VerbResult> {
	const remote = requireRemote(resolved);
	const row = await findFile(backend, remote);
	if (!row) {
		throw new CentrsError({
			code: "routeros/command-failed",
			summary: `RouterOS has no file named ${remote}.`,
			remediation: "Nothing to remove; `transfer list` shows what is present.",
			context: { remote },
		});
	}
	await backend.execute({
		path: "/file",
		command: "remove",
		attributes: { ".id": row.id },
	});
	return {
		data: baseData(resolved, { op: "remove", remote, local: null }),
	};
}

async function runMkdir(
	resolved: ResolvedTransferRequest,
	backend: ProtocolAdapter,
): Promise<VerbResult> {
	const remote = requireRemote(resolved);
	const existing = await findFile(backend, remote);
	if (existing && !resolved.force) {
		throw targetExistsError(remote);
	}
	await backend.execute({
		path: "/file",
		command: "add",
		attributes: { name: remote, type: "directory" },
	});
	return {
		data: baseData(resolved, { op: "mkdir", remote, local: null }),
	};
}

async function runCopy(
	resolved: ResolvedTransferRequest,
	backend: ProtocolAdapter,
): Promise<VerbResult> {
	const remote = requireRemote(resolved);
	const dest = resolved.remoteDest
		? normalizeRemotePath(resolved.remoteDest)
		: undefined;
	if (!dest) {
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary: "`transfer copy` requires a source and a destination path.",
			remediation: "Pass both: `transfer <router> copy <src> <dst>`.",
		});
	}
	const source = await findFile(backend, remote);
	if (!source) {
		throw new CentrsError({
			code: "routeros/command-failed",
			summary: `RouterOS has no file named ${remote}.`,
			remediation: "Check the copy source path; `transfer list` shows files.",
			context: { remote },
		});
	}
	if (!resolved.force && (await findFile(backend, dest))) {
		throw targetExistsError(dest);
	}
	await backend.execute({
		path: "/file",
		command: "copy",
		attributes: { ".id": source.id, name: dest },
	});
	return {
		data: baseData(resolved, { op: "copy", remote, local: null }),
	};
}

// ── RouterOS `/file` primitives (the one place wire shapes live) ─────────────

interface FileRow {
	id: string;
	name: string;
	type?: string;
	size?: number;
}

/** Resolve a file by its (normalized) name to its `.id` + size via `print`. */
async function findFile(
	backend: ProtocolAdapter,
	name: string,
): Promise<FileRow | undefined> {
	const rows = (await backend.list("/file", {
		proplist: [".id", "name", "type", "size"],
	})) as Record<string, unknown>[];
	const match = rows.find((row) => readString(row, "name") === name);
	if (!match) {
		return undefined;
	}
	return {
		id: readString(match, ".id") ?? "",
		name,
		type: readString(match, "type"),
		size: readNumber(match, "size"),
	};
}

/** Small read: `/file/get … contents`. */
async function downloadSmall(
	backend: ProtocolAdapter,
	id: string,
): Promise<Buffer> {
	const result = await backend.execute({
		path: "/file",
		command: "get",
		attributes: { ".id": id, "value-name": "contents" },
	});
	return Buffer.from(extractContents(result), "utf8");
}

/** Large read: loop `/file/read offset chunk-size` until a short chunk. */
async function downloadChunked(
	backend: ProtocolAdapter,
	name: string,
	totalSize: number | undefined,
): Promise<Buffer> {
	const parts: Buffer[] = [];
	let offset = 0;
	// Bound the loop defensively even if RouterOS never returns a short chunk.
	const max = totalSize ?? Number.MAX_SAFE_INTEGER;
	while (offset < max) {
		const result = await backend.execute({
			path: "/file",
			command: "read",
			attributes: {
				file: name,
				offset: String(offset),
				"chunk-size": String(FILE_READ_CHUNK_BYTES),
			},
		});
		const chunk = Buffer.from(extractReadData(result), "utf8");
		if (chunk.byteLength === 0) {
			break;
		}
		parts.push(chunk);
		offset += chunk.byteLength;
		if (chunk.byteLength < FILE_READ_CHUNK_BYTES) {
			break;
		}
	}
	return Buffer.concat(parts);
}

async function verifyWrittenSize(
	resolved: ResolvedTransferRequest,
	backend: ProtocolAdapter,
	remote: string,
	expected: number,
	warnings: Warning[],
): Promise<"size" | "checksum" | "off"> {
	if (resolved.verify === "off") {
		return "off";
	}
	if (resolved.verify === "checksum") {
		warnings.push({
			code: "transport/checksum-unavailable",
			message:
				"RouterOS exposes no file digest over REST/native; verifying by size instead.",
		});
	}
	const row = await findFile(backend, remote);
	const actual = row?.size;
	if (actual !== undefined && actual !== expected) {
		throw new CentrsError({
			code: "transport/incomplete-transfer",
			summary: `Uploaded ${remote} settled at ${actual} bytes, expected ${expected}.`,
			remediation:
				"Re-run the upload; if it recurs, the device may be low on storage.",
			context: { remote, expected, actual },
		});
	}
	return "size";
}

// ── Resolution ───────────────────────────────────────────────────────────────

export async function resolveTransferRequest(
	request: TransferRequest,
	env: Record<string, string | undefined>,
): Promise<ResolvedTransferRequest> {
	validateTransferRequestShape(request);

	const direction: TransferDirection =
		request.verb === "upload" ? "upload" : "download";
	const sizeHint = uploadSizeHint(request);
	const { method, protocol, via } = selectTransferMethod(
		request,
		direction,
		sizeHint,
		env,
	);

	const cdbResolution = await resolveCdb(
		{
			targetInput: request.targetInput,
			cdbFile: request.cdbFile,
			cdbPassword: request.cdbPassword,
		},
		env,
	);

	const format = resolveTransferFormat(request, env);
	const validate = resolveBooleanSetting(
		request.validate,
		env,
		"CENTRS_VALIDATE",
		true,
		"validate",
		cdbResolution?.overrides.validate,
	);
	const timeoutMs = resolveTransferTimeout(
		request.timeout,
		env,
		protocol,
		cdbResolution,
	);
	const target = resolveTarget(
		{
			targetInput: request.targetInput,
			host: request.host,
			port: request.port,
		},
		env,
		protocol,
		cdbResolution,
	);
	const auth = resolveAuth(
		{ username: request.username, password: request.password },
		env,
		cdbResolution,
	);

	return {
		verb: request.verb,
		method,
		protocol,
		target,
		auth,
		timeoutMs,
		format,
		validate,
		via,
		local: request.local,
		remote: request.remote ? normalizeRemotePath(request.remote) : undefined,
		remoteDest: request.remoteDest,
		listPath: request.path ? normalizeRemotePath(request.path) : undefined,
		force: request.force ?? false,
		verify: parseVerifyMode(request.verify),
		type: request.type,
		name: request.name,
		verbose: request.verbose ?? false,
		warnings: (cdbResolution?.warnings ?? []) as readonly Warning[],
	};
}

type TransferDirection = "upload" | "download";

/**
 * Size/direction-aware method selection plus explicit-`--via` gating.
 * Pure (no I/O) so it is unit-testable. Throws `CentrsError` for the
 * not-implemented / gated methods (examples P1–P4) and the REST write cap.
 */
export function selectTransferMethod(
	request: TransferRequest,
	direction: TransferDirection,
	uploadBytes: number | undefined,
	env: Record<string, string | undefined>,
): {
	method: TransferMethod;
	protocol: RouterOsProtocol;
	via: ResolvedSetting<string>;
} {
	const via = resolveStringSetting(
		request.via,
		env,
		"CENTRS_TRANSFER_VIA",
		"auto",
		"via",
	) as ResolvedSetting<string>;
	const requested = via.value;

	if (requested === "auto") {
		// Auto: REST family carries reads and small writes; a large upload needs
		// sftp (not built yet), so it surfaces as not-implemented.
		if (
			direction === "upload" &&
			uploadBytes !== undefined &&
			uploadBytes > REST_FILE_WRITE_CAP_BYTES
		) {
			throw notImplementedMethod("sftp", "large uploads (>60 KB) need sftp");
		}
		return { method: "rest", protocol: "rest-api", via };
	}

	if (requested === "rest" || requested === "rest-api") {
		return { method: "rest", protocol: "rest-api", via };
	}
	if (requested === "native" || requested === "native-api") {
		return { method: "native", protocol: "native-api", via };
	}
	if (requested === "sftp" || requested === "scp" || requested === "fetch") {
		throw notImplementedMethod(requested);
	}
	if (requested === "ftp") {
		if ((env["ALLOW_UNSAFE_PROTOCOLS"] ?? "").split(",").includes("ftp")) {
			throw notImplementedMethod("ftp");
		}
		throw new CentrsError({
			code: "settings/unsafe-protocol-blocked",
			summary: "`ftp` is cleartext and is gated behind an explicit opt-in.",
			remediation:
				"Set `ALLOW_UNSAFE_PROTOCOLS=ftp` to permit it, or use the secure default (sftp) or `--via rest`.",
			context: { via: "ftp" },
		});
	}

	throw new CentrsError({
		code: "settings/invalid-via",
		summary: `Unsupported transfer method: ${requested}`,
		remediation: `Choose one of ${transferMethods.join(", ")} (or omit --via for the size-aware default).`,
		context: { via: requested },
	});
}

function notImplementedMethod(method: string, why?: string): CentrsError {
	return new CentrsError({
		code: "usage/not-implemented",
		summary: why
			? `transfer ${why} — \`--via ${method}\` is not implemented yet.`
			: `transfer \`--via ${method}\` is not implemented yet.`,
		remediation:
			"Use `--via rest` / `--via native` (≤60 KB writes and all reads) for now; sftp/scp/fetch land with the SSH transport.",
		context: { via: method },
	});
}

/**
 * Validate request-shape concerns that do not need a target or the network:
 * required positionals per verb, conflicting verify flags. Mutating ops that
 * refuse-overwrite are checked against the device later (existence probe).
 */
export function validateTransferRequestShape(request: TransferRequest): void {
	if (!transferVerbs.includes(request.verb)) {
		throw new CentrsError({
			code: "input/invalid-command",
			summary: `Unknown transfer verb: ${String(request.verb)}`,
			remediation: `Use one of ${transferVerbs.join(", ")}.`,
		});
	}

	if (request.verify !== undefined) {
		parseVerifyMode(request.verify); // throws on a bad value
	}

	// `upload` needs a local source; `download` may omit local (defaults to the
	// remote basename). Both need a remote, except `download` infers nothing there.
	if (request.verb === "upload" && !request.local) {
		throw missingArg(
			"upload",
			"a local source path (or `-`)",
			"<local> [remote]",
		);
	}

	const needsRemote: readonly TransferVerb[] = [
		"upload",
		"download",
		"remove",
		"mkdir",
	];
	if (needsRemote.includes(request.verb) && !request.remote) {
		// upload/download can take the remote as an optional positional; the
		// run-time `requireRemote` enforces it once defaults are applied, but a
		// bare `remove`/`mkdir` with no path is a usage error here.
		if (request.verb === "remove" || request.verb === "mkdir") {
			throw missingArg(request.verb, "a remote path", "<remote>");
		}
	}

	if (request.verb === "copy" && (!request.remote || !request.remoteDest)) {
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary: "`transfer copy` requires a source and a destination path.",
			remediation: "Pass both: `transfer <router> copy <src> <dst>`.",
		});
	}
}

function missingArg(verb: string, what: string, shape: string): CentrsError {
	return new CentrsError({
		code: "usage/conflicting-flags",
		summary: `\`transfer ${verb}\` requires ${what}.`,
		remediation: `Pass it: \`transfer <router> ${verb} ${shape}\`.`,
	});
}

/**
 * Normalize a RouterOS file path: accept a leading `/` for ergonomics but strip
 * it (REST `/file` keys and SFTP paths want the bare name), and collapse any
 * duplicate slashes. `flash/x` and `/flash/x` resolve to the same target.
 */
export function normalizeRemotePath(path: string): string {
	return path.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

function parseVerifyMode(
	value: string | undefined,
): "size" | "checksum" | "off" {
	if (value === undefined) {
		return "size";
	}
	if (value === "size" || value === "checksum" || value === "off") {
		return value;
	}
	throw new CentrsError({
		code: "usage/conflicting-flags",
		summary: `Unsupported --verify mode: ${value}`,
		remediation:
			"Use `--verify size` (default), `--verify checksum`, or `--no-verify`.",
	});
}

function resolveTransferFormat(
	request: TransferRequest,
	env: Record<string, string | undefined>,
): ResolvedSetting<TransferOutputFormat> {
	return resolveStringSetting(
		request.format,
		env,
		"CENTRS_FORMAT",
		"text",
		"format",
		(value) => {
			if (transferOutputFormats.includes(value as TransferOutputFormat)) {
				return value as TransferOutputFormat;
			}
			throw new CentrsError({
				code: "settings/invalid-format",
				summary: `Unsupported output format: ${value}`,
				remediation: `Choose one of ${transferOutputFormats.join(", ")}.`,
			});
		},
	) as ResolvedSetting<TransferOutputFormat>;
}

function resolveTransferTimeout(
	timeout: TransferRequest["timeout"],
	env: Record<string, string | undefined>,
	protocol: RouterOsProtocol,
	cdb?: CdbResolution,
): ResolvedSetting<number> {
	const resolved = resolveStringSetting(
		timeout === undefined ? undefined : String(timeout),
		env,
		"CENTRS_TIMEOUT",
		"30000",
		"timeout",
		(value) => {
			const parsed = parseDuration(value);
			if (parsed <= 0) {
				throw new CentrsError({
					code: "settings/invalid-timeout",
					summary: `Timeout must be greater than zero. Received: ${value}`,
					remediation: "Use a positive duration like `5s` or `30000`.",
				});
			}
			return parsed;
		},
		cdb?.overrides.timeoutMs,
	) as ResolvedSetting<number>;

	if (protocol === "rest-api" && resolved.value > 60_000) {
		throw new CentrsError({
			code: "usage/timeout-out-of-range",
			summary: `REST timeout ${resolved.value}ms exceeds the RouterOS REST ceiling.`,
			remediation: "Use `--timeout 60s` or less, or `--via native` for longer.",
			context: { via: protocol, timeoutMs: resolved.value, ceilingMs: 60_000 },
		});
	}
	return resolved;
}

// ── Local I/O (files / stdin / stdout) ───────────────────────────────────────

function readLocalSource(resolved: ResolvedTransferRequest): Buffer {
	const local = resolved.local;
	if (local === undefined) {
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary: "upload requires a local source path (or `-`).",
			remediation: "Pass the local file or `-` for stdin.",
		});
	}
	if (local === "-") {
		return readFileSync(0); // stdin
	}
	try {
		return readFileSync(local);
	} catch (error) {
		throw new CentrsError({
			code: "input/local-file-not-found",
			summary: `Cannot read local source ${local}.`,
			remediation: "Check the path and read permissions.",
			context: { local },
			cause: error,
		});
	}
}

function writeLocalSink(
	resolved: ResolvedTransferRequest,
	bytes: Buffer,
): void {
	const remote = resolved.remote ?? "";
	const local = resolved.local ?? basename(remote);
	if (local === "-") {
		process.stdout.write(bytes);
		return;
	}
	writeFileSync(local, bytes);
}

function localLabel(resolved: ResolvedTransferRequest): string {
	if (resolved.verb === "download") {
		const remote = resolved.remote ?? "";
		return resolved.local ?? basename(remote);
	}
	return resolved.local ?? "-";
}

// ── Envelope assembly ────────────────────────────────────────────────────────

function baseData(
	resolved: ResolvedTransferRequest,
	fields: Partial<TransferData> & { op: TransferOp },
): TransferData {
	return {
		op: fields.op,
		remote: fields.remote ?? null,
		local: fields.local ?? null,
		bytes: fields.bytes ?? null,
		verified: fields.verified ?? null,
		method: resolved.method,
		...(fields.durationMs !== undefined
			? { durationMs: fields.durationMs }
			: {}),
	};
}

function buildSuccessEnvelope(
	resolved: ResolvedTransferRequest,
	data: TransferData | readonly Record<string, unknown>[],
	operationData: TransferData,
	warnings: readonly Warning[],
): TransferSuccessEnvelope {
	return {
		ok: true,
		data,
		warnings,
		tips: [],
		meta: metaFromResolved(resolved, operationData, {
			enabled: resolved.validate.value,
			source: resolved.validate.value
				? "device /file existence probe"
				: "disabled",
			result: resolved.validate.value ? "passed" : "skipped",
		}),
	};
}

function metaFromResolved(
	resolved: ResolvedTransferRequest,
	operationData: TransferData,
	validation: EnvelopeValidationMeta,
): TransferEnvelope["meta"] {
	const target = resolved.target;
	const targetSources: Record<string, CoreSettingSource> = {};
	for (const [field, source] of Object.entries(target.sources)) {
		targetSources[field] = toCoreSource(source);
	}

	return {
		target: {
			input: target.input,
			host: target.host,
			port: target.port,
			baseUrl: target.baseUrl,
			identity: target.identity,
			recordIndex: target.recordIndex,
			source: toCoreSource(target.source),
			sources: targetSources,
		},
		via: resolved.protocol,
		settings: {
			via: toCoreSource(resolved.via.source),
			host: toCoreSource(target.hostSource),
			port: toCoreSource(target.portSource),
			timeoutMs: toCoreSource(resolved.timeoutMs.source),
			format: toCoreSource(resolved.format.source),
			validate: toCoreSource(resolved.validate.source),
			username: resolved.auth.usernameSource
				? toCoreSource(resolved.auth.usernameSource)
				: undefined,
			password: resolved.auth.passwordSource
				? toCoreSource(resolved.auth.passwordSource)
				: undefined,
		},
		validation,
		operation: {
			op: operationData.op,
			method: resolved.method,
			request: {
				verb: resolved.verb,
				remote: resolved.remote ?? null,
				local: resolved.local ?? null,
				force: resolved.force,
				verify: resolved.verify,
				validate: resolved.validate.value,
				format: resolved.format.value,
			},
			auth: {
				username: resolved.auth.username,
				passwordProvided: resolved.auth.passwordProvided,
			},
		},
	};
}

export function buildTransferErrorEnvelope(
	request: TransferRequest,
	error: unknown,
): TransferErrorEnvelope {
	const centrsError =
		error instanceof CentrsError
			? error
			: new CentrsError({
					code: "internal/unhandled",
					summary: "transfer failed with an unexpected internal error.",
					remediation:
						"Re-run with `--format json` to capture the structured error details.",
					cause: error,
				});

	return {
		ok: false,
		error: serializeCentrsError(centrsError),
		warnings: [],
		tips: [],
		meta: {
			target: { input: request.targetInput },
			via: null,
			settings: {},
		},
	};
}

// ── Rendering ────────────────────────────────────────────────────────────────

export function renderTransferEnvelope(
	envelope: TransferEnvelope,
	format: TransferOutputFormat,
	options: { verbose?: boolean } = {},
): string {
	switch (format) {
		case "json":
			return JSON.stringify(envelope, null, 2);
		case "yaml":
			return toYaml(envelope);
		case "text":
			return envelope.ok
				? renderSuccessText(envelope, options)
				: renderErrorText(envelope);
		default:
			return exhaustiveFormat(format);
	}
}

function renderSuccessText(
	envelope: TransferSuccessEnvelope,
	options: { verbose?: boolean },
): string {
	const lines: string[] = [];
	const operation = envelope.meta.operation;

	if (Array.isArray(envelope.data)) {
		// list
		const rows = envelope.data as readonly Record<string, unknown>[];
		if (rows.length === 0) {
			lines.push("(no files)");
		}
		for (const row of rows) {
			const name = String(row["name"] ?? "");
			const type = String(row["type"] ?? "");
			const size =
				row["size"] === undefined ? "" : humanBytes(Number(row["size"]));
			lines.push(`${name}\t${type}\t${size}`.trimEnd());
		}
	} else {
		const data = envelope.data as TransferData;
		const parts = [`${data.op} ok`, `method=${data.method}`];
		if (data.remote) parts.push(`remote=${data.remote}`);
		if (data.local) parts.push(`local=${data.local}`);
		if (data.bytes !== null) parts.push(`bytes=${data.bytes}`);
		if (data.verified && data.verified !== "off")
			parts.push(`verified=${data.verified}`);
		lines.push(parts.join(" "));
	}

	if (options.verbose && operation) {
		lines.push("");
		lines.push(`via: ${envelope.meta.via}`);
	}

	if (envelope.warnings.length > 0) {
		lines.push("");
		for (const warning of envelope.warnings) {
			lines.push(`warning [${warning.code}]: ${warning.message}`);
		}
	}

	return lines.join("\n");
}

function renderErrorText(envelope: TransferErrorEnvelope): string {
	const { error } = envelope;
	const lines = [`[${error.code}] ${error.summary}`];
	if (error.remediation) {
		lines.push(`Fix: ${error.remediation}`);
	}
	return lines.join("\n");
}

// ── Small helpers ────────────────────────────────────────────────────────────

function uploadSizeHint(request: TransferRequest): number | undefined {
	if (request.verb !== "upload" || !request.local || request.local === "-") {
		return undefined;
	}
	try {
		return readFileSync(request.local).byteLength;
	} catch {
		return undefined;
	}
}

function matchesListFilters(
	row: Record<string, unknown>,
	resolved: ResolvedTransferRequest,
): boolean {
	const name = readString(row, "name") ?? "";
	if (resolved.listPath && !name.startsWith(resolved.listPath)) {
		return false;
	}
	if (resolved.type) {
		const type = readString(row, "type") ?? "";
		// RouterOS reports file types as e.g. ".txt file" / "directory" / "disk".
		const wanted = resolved.type;
		const isMatch =
			wanted === "file"
				? type.includes("file")
				: type === wanted || type.startsWith(wanted);
		if (!isMatch) {
			return false;
		}
	}
	if (resolved.name && !globMatch(resolved.name, name)) {
		return false;
	}
	return true;
}

function globMatch(glob: string, value: string): boolean {
	const pattern = glob
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${pattern}$`).test(value);
}

function requireRemote(resolved: ResolvedTransferRequest): string {
	if (!resolved.remote) {
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary: `\`transfer ${resolved.verb}\` requires a remote path.`,
			remediation: "Pass the RouterOS file path.",
		});
	}
	return resolved.remote;
}

function targetExistsError(remote: string): CentrsError {
	return new CentrsError({
		code: "usage/target-exists",
		summary: `${remote} already exists on the device.`,
		remediation: "Pass `--force` to overwrite, or choose a different name.",
		context: { remote },
	});
}

function restWriteCapError(remote: string, bytes: number): CentrsError {
	return new CentrsError({
		code: "transport/unsupported-operation",
		summary: `Cannot write ${bytes} bytes to ${remote} over REST/native (60 KB cap).`,
		remediation:
			"Large uploads need sftp (lands with the SSH transport); the REST `/file` write cap is 60 KB.",
		context: { remote, bytes, capBytes: REST_FILE_WRITE_CAP_BYTES },
	});
}

function extractNewId(result: ProtocolExecuteResult): string | undefined {
	if (typeof result.ret === "string" && result.ret.length > 0) {
		return result.ret;
	}
	const first = result.records[0];
	return first
		? (readString(first, "ret") ?? readString(first, ".id"))
		: undefined;
}

function extractContents(result: ProtocolExecuteResult): string {
	if (typeof result.ret === "string") {
		return result.ret;
	}
	const first = result.records[0];
	return (
		(first && (readString(first, "contents") ?? readString(first, "ret"))) ?? ""
	);
}

function extractReadData(result: ProtocolExecuteResult): string {
	if (typeof result.ret === "string") {
		return result.ret;
	}
	const first = result.records[0];
	return (
		(first && (readString(first, "data") ?? readString(first, "ret"))) ?? ""
	);
}

function readString(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function readNumber(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key];
	if (typeof value === "number") {
		return value;
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

function basename(path: string): string {
	const parts = path.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? path;
}

function humanBytes(bytes: number): string {
	if (!Number.isFinite(bytes)) {
		return "";
	}
	const units = ["B", "KiB", "MiB", "GiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return unit === 0
		? `${value}${units[unit]}`
		: `${value.toFixed(1)}${units[unit]}`;
}

function exhaustiveVerb(verb: never): never {
	throw new Error(`Unhandled transfer verb: ${String(verb)}`);
}

function exhaustiveFormat(format: never): never {
	throw new Error(`Unhandled transfer output format: ${String(format)}`);
}
