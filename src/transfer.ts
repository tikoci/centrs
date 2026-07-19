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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { SftpClient } from "./protocols/sftp.ts";
import {
	assertNoQuickchrOverrideConflict,
	type CdbResolution,
	loadEnvFileDefaults,
	parseDuration,
	quickchrConnection,
	type ResolvedAuth,
	type ResolvedSetting,
	type ResolvedTarget,
	resolveAuth,
	resolveBooleanSetting,
	resolveCdb,
	resolveQuickchrTarget,
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
 * Verbs that mutate the device (write path) — gated by `--yes` once up front in a
 * fan-out. `download`/`list` only read the device (a download writes the *local*
 * filesystem, not the router).
 */
export function isTransferWriteVerb(verb: TransferVerb): boolean {
	return (
		verb === "upload" ||
		verb === "remove" ||
		verb === "mkdir" ||
		verb === "copy"
	);
}

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
	/**
	 * quickchr machine name (`--quickchr <name>`): resolve host/port/auth from
	 * the live VM descriptor instead of CDB/env (`docs/CONSTITUTION.md` →
	 * Resolution providers). Conflicts with host/port/username/password/sshKey.
	 */
	quickchr?: string;
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
	/** SSH private-key path for sftp/scp (`--ssh-key`). Path only. */
	sshKey?: string;
	/** Accept self-signed TLS / new SSH host keys (`--insecure`). Default false. */
	insecure?: boolean;
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
	/** `download` fan-out: directory to write one file per target into. */
	outDir?: string;
	/** Fan-out write gate: confirm a mutating fan-out (upload/remove/mkdir/copy). */
	yes?: boolean;
	/** Fan-out TTY detection seam (defaults to `process.stdin.isTTY`). */
	stdinIsTty?: boolean;
	/** Fan-out confirmation prompt seam (defaults to the shared TTY prompt). */
	confirm?: (prompt: string) => Promise<boolean>;
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
	insecure: ResolvedSetting<boolean>;
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
	options: { cdbResolution?: CdbResolution } = {},
): Promise<TransferSuccessEnvelope> {
	const resolved = await resolveTransferRequest(request, env, options);
	const backend = createFileBackend(resolved);
	try {
		return await runResolvedTransfer(resolved, backend);
	} finally {
		await backend.close();
	}
}

/**
 * Build the file backend for the resolved method. `rest`/`native` wrap the
 * shared {@link ProtocolAdapter} `/file` command seam; `sftp` drives the host
 * OpenSSH `sftp` subsystem (the SSH file path — RouterOS has no pseudo-tty, and
 * its SFTP subsystem is the real file protocol, unlike a one-shot `ssh host "cmd"`
 * exec). Both satisfy {@link FileBackend}, so the verb runners are
 * backend-agnostic.
 */
export function createFileBackend(
	resolved: ResolvedTransferRequest,
): FileBackend {
	if (resolved.method === "sftp") {
		return new SftpFileBackend(
			new SftpClient({
				host: resolved.target.host,
				port: resolved.target.port,
				username: resolved.auth.username,
				sshKey: resolved.auth.sshKey,
				insecure: resolved.insecure.value,
				timeoutMs: resolved.timeoutMs.value,
			}),
		);
	}
	const adapter = createProtocolAdapter({
		protocol: resolved.protocol,
		host: resolved.target.host,
		port: resolved.target.port,
		tls: resolved.target.tls,
		baseUrl: resolved.target.baseUrl,
		username: resolved.auth.username,
		password: resolved.auth.password,
		timeoutMs: resolved.timeoutMs.value,
		insecure: resolved.insecure.value,
	});
	return new AdapterFileBackend(adapter);
}

/**
 * The verb dispatch shared by `transfer()` and (future) fanout. Takes an
 * already-built {@link FileBackend} so tests can drive it with a mocked
 * transport.
 */
export async function runResolvedTransfer(
	resolved: ResolvedTransferRequest,
	backend: FileBackend,
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
	backend: FileBackend,
	warnings: Warning[],
): Promise<VerbResult> {
	switch (resolved.verb) {
		case "list":
			return runList(resolved, backend);
		case "upload":
			return runUpload(resolved, backend, warnings);
		case "download":
			return runDownload(resolved, backend, warnings);
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

// ── Verb implementations (backend-agnostic over FileBackend) ─────────────────

async function runList(
	resolved: ResolvedTransferRequest,
	backend: FileBackend,
): Promise<VerbResult> {
	const rows = await backend.listFiles(resolved.listPath);
	const filtered = rows.filter((row) => matchesListFilters(row, resolved));
	return {
		rows: filtered,
		data: baseData(resolved, { op: "list", remote: null, local: null }),
	};
}

async function runUpload(
	resolved: ResolvedTransferRequest,
	backend: FileBackend,
	warnings: Warning[],
): Promise<VerbResult> {
	const remote = requireRemote(resolved);
	const bytes = readLocalSource(resolved);

	// REST/native cannot write past the 60 KB `/file/set contents` cap; fail
	// before any network call. sftp has no such cap (it streams the file).
	if (
		isRestFamily(resolved.method) &&
		bytes.byteLength > REST_FILE_WRITE_CAP_BYTES
	) {
		throw restWriteCapError(remote, bytes.byteLength);
	}

	const existing = await backend.findFile(remote);
	if (existing && !resolved.force) {
		throw targetExistsError(remote);
	}

	await backend.writeFile(remote, bytes, existing);

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
	backend: FileBackend,
	warnings: Warning[],
): Promise<VerbResult> {
	const remote = requireRemote(resolved);
	const row = await backend.findFile(remote);
	if (!row) {
		throw new CentrsError({
			code: "routeros/command-failed",
			summary: `RouterOS has no file named ${remote}.`,
			remediation:
				"Check the remote path (RouterOS file names have no leading slash); `transfer list` shows what is present.",
			context: { remote },
		});
	}

	const bytes = await backend.readFile(row);
	// Verify the byte count against the device-reported size *before* writing the
	// local sink, so a short read never clobbers a local file or emits partial
	// bytes to stdout.
	const verified = verifyReadSize(
		resolved,
		row.size,
		bytes.byteLength,
		remote,
		warnings,
	);
	writeLocalSink(resolved, bytes);

	return {
		data: baseData(resolved, {
			op: "download",
			remote,
			local: localLabel(resolved),
			bytes: bytes.byteLength,
			verified,
		}),
	};
}

async function runRemove(
	resolved: ResolvedTransferRequest,
	backend: FileBackend,
): Promise<VerbResult> {
	const remote = requireRemote(resolved);
	const row = await backend.findFile(remote);
	if (!row) {
		throw new CentrsError({
			code: "routeros/command-failed",
			summary: `RouterOS has no file named ${remote}.`,
			remediation: "Nothing to remove; `transfer list` shows what is present.",
			context: { remote },
		});
	}
	await backend.removeFile(row);
	return {
		data: baseData(resolved, { op: "remove", remote, local: null }),
	};
}

async function runMkdir(
	resolved: ResolvedTransferRequest,
	backend: FileBackend,
): Promise<VerbResult> {
	const remote = requireRemote(resolved);
	const existing = await backend.findFile(remote);
	if (existing && !resolved.force) {
		throw targetExistsError(remote);
	}
	await backend.makeDir(remote);
	return {
		data: baseData(resolved, { op: "mkdir", remote, local: null }),
	};
}

async function runCopy(
	resolved: ResolvedTransferRequest,
	backend: FileBackend,
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
	const source = await backend.findFile(remote);
	if (!source) {
		throw new CentrsError({
			code: "routeros/command-failed",
			summary: `RouterOS has no file named ${remote}.`,
			remediation: "Check the copy source path; `transfer list` shows files.",
			context: { remote },
		});
	}
	if (!resolved.force && (await backend.findFile(dest))) {
		throw targetExistsError(dest);
	}
	await backend.copyFile(source, dest);
	return {
		data: baseData(resolved, { op: "copy", remote, local: null }),
	};
}

// ── FileBackend: the seam the verb runners drive ─────────────────────────────

interface FileRow {
	id: string;
	name: string;
	type?: string;
	size?: number;
}

/**
 * A backend-agnostic view of a device's file store. The verb runners drive this
 * seam so the orchestration (existence guard, verify, envelope) lives in one
 * place regardless of transport. `rest`/`native` map these to `/file` commands;
 * `sftp` maps them to SFTP-subsystem operations.
 */
export interface FileBackend {
	/** List files (optionally scoped to a directory prefix), `/file`-row shaped. */
	listFiles(listPath?: string): Promise<Record<string, unknown>[]>;
	/** Resolve a file by normalized name; `undefined` when absent. */
	findFile(name: string): Promise<FileRow | undefined>;
	/** Write `bytes` to `name`, reusing `existing` when present (overwrite). */
	writeFile(
		name: string,
		bytes: Buffer,
		existing: FileRow | undefined,
	): Promise<void>;
	/** Read a file's bytes. */
	readFile(row: FileRow): Promise<Buffer>;
	removeFile(row: FileRow): Promise<void>;
	makeDir(name: string): Promise<void>;
	copyFile(source: FileRow, dest: string): Promise<void>;
	close(): Promise<void>;
}

function isRestFamily(method: TransferMethod): boolean {
	return method === "rest" || method === "native";
}

/** REST / native-api `/file` command seam. The one place those wire shapes live. */
class AdapterFileBackend implements FileBackend {
	constructor(private readonly adapter: ProtocolAdapter) {}

	async listFiles(): Promise<Record<string, unknown>[]> {
		return (await this.adapter.list("/file", {
			proplist: [".id", "name", "type", "size", "last-modified"],
		})) as Record<string, unknown>[];
	}

	async findFile(name: string): Promise<FileRow | undefined> {
		const rows = (await this.adapter.list("/file", {
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

	async writeFile(
		name: string,
		bytes: Buffer,
		existing: FileRow | undefined,
	): Promise<void> {
		const text = bytes.toString("utf8");
		let id = existing?.id;
		if (!id) {
			const added = await this.adapter.execute({
				path: "/file",
				command: "add",
				attributes: { name, type: "file" },
			});
			id = extractNewId(added) ?? (await this.findFile(name))?.id;
		}
		if (!id) {
			throw new CentrsError({
				code: "routeros/command-failed",
				summary: `RouterOS did not create the file ${name}.`,
				remediation:
					"Confirm the path is writable and the user has `ftp`/`write` policy.",
				context: { remote: name },
			});
		}
		await this.adapter.execute({
			path: "/file",
			command: "set",
			attributes: { ".id": id, contents: text },
		});
	}

	async readFile(row: FileRow): Promise<Buffer> {
		// Small file: `/file/get … contents`. Large: chunked `/file/read`.
		if (row.size !== undefined && row.size <= REST_FILE_WRITE_CAP_BYTES) {
			const result = await this.adapter.execute({
				path: "/file",
				command: "get",
				attributes: { ".id": row.id, "value-name": "contents" },
			});
			return Buffer.from(extractContents(result), "utf8");
		}
		const parts: Buffer[] = [];
		let offset = 0;
		// Bound the loop defensively even if RouterOS never returns a short chunk.
		const max = row.size ?? Number.MAX_SAFE_INTEGER;
		while (offset < max) {
			const result = await this.adapter.execute({
				path: "/file",
				command: "read",
				attributes: {
					file: row.name,
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

	async removeFile(row: FileRow): Promise<void> {
		await this.adapter.execute({
			path: "/file",
			command: "remove",
			attributes: { ".id": row.id },
		});
	}

	async makeDir(name: string): Promise<void> {
		await this.adapter.execute({
			path: "/file",
			command: "add",
			attributes: { name, type: "directory" },
		});
	}

	async copyFile(source: FileRow, dest: string): Promise<void> {
		await this.adapter.execute({
			path: "/file",
			command: "copy",
			attributes: { ".id": source.id, name: dest },
		});
	}

	async close(): Promise<void> {
		await this.adapter.close();
	}
}

/** SFTP-subsystem seam over the host OpenSSH `sftp` (see `protocols/sftp.ts`). */
class SftpFileBackend implements FileBackend {
	constructor(private readonly client: SftpClient) {}

	async listFiles(listPath?: string): Promise<Record<string, unknown>[]> {
		const entries = await this.client.readdir(listPath ?? ".");
		return entries.map((entry) => ({
			// Prefix with the listed directory so the shared `--type`/`--name`/path
			// filters see the same full-path shape the REST family returns.
			name: listPath ? `${listPath}/${entry.name}` : entry.name,
			type: entry.type,
			...(entry.size === undefined ? {} : { size: entry.size }),
		}));
	}

	async findFile(name: string): Promise<FileRow | undefined> {
		const entry = await this.client.stat(name);
		if (!entry) {
			return undefined;
		}
		// Existence probe only — no size. SFTP `put`/`get` are protocol-guaranteed
		// complete (a partial transfer errors), so the upload `--verify size` trusts
		// that guarantee rather than re-reading a server-format-dependent `ls -l`
		// size; and `get` streams any size without needing it.
		return { id: "", name, type: entry.type };
	}

	async writeFile(name: string, bytes: Buffer): Promise<void> {
		await withTempFile(bytes, (path) => this.client.put(path, name));
	}

	async readFile(row: FileRow): Promise<Buffer> {
		return withTempFile(undefined, async (path) => {
			await this.client.get(row.name, path);
			return readFileSync(path);
		});
	}

	async removeFile(row: FileRow): Promise<void> {
		await this.client.remove(row.name);
	}

	async makeDir(name: string): Promise<void> {
		await this.client.mkdir(name);
	}

	async copyFile(): Promise<void> {
		// RouterOS SFTP exposes no server-side copy; `copy` stays on rest/native.
		throw new CentrsError({
			code: "transport/unsupported-operation",
			summary: "On-device `copy` is not available over sftp.",
			remediation:
				"Use `--via rest` / `--via native` for on-device copy; sftp moves bytes host↔device only.",
			context: { via: "ssh", op: "copy" },
		});
	}

	async close(): Promise<void> {
		// The sftp client is stateless across calls (one batch per op).
	}
}

/**
 * Run `fn` with a private temp-file path. When `seed` is given the file is
 * pre-filled (upload); otherwise `fn` writes it (download). The temp dir is
 * always removed.
 */
async function withTempFile<T>(
	seed: Buffer | undefined,
	fn: (path: string) => Promise<T>,
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "centrs-sftp-"));
	const path = join(dir, "data");
	try {
		if (seed !== undefined) {
			writeFileSync(path, seed);
		}
		return await fn(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function verifyWrittenSize(
	resolved: ResolvedTransferRequest,
	backend: FileBackend,
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
	const row = await backend.findFile(remote);
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

/**
 * Verify a download by byte count. REST/native `/file` rows carry a size, so a
 * short/truncated read fails with `transport/incomplete-transfer`. SFTP rows
 * report no reliable size, so it trusts the `get` guarantee (a partial transfer
 * errors) — mirroring {@link verifyWrittenSize}.
 */
function verifyReadSize(
	resolved: ResolvedTransferRequest,
	expected: number | undefined,
	actual: number,
	remote: string,
	warnings: Warning[],
): "size" | "checksum" | "off" {
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
	if (expected !== undefined && expected !== actual) {
		throw new CentrsError({
			code: "transport/incomplete-transfer",
			summary: `Downloaded ${remote} is ${actual} bytes, expected ${expected}.`,
			remediation:
				"Re-run the download; if it recurs, the remote file or link may be unstable.",
			context: { remote, expected, actual },
		});
	}
	return "size";
}

// ── Resolution ───────────────────────────────────────────────────────────────

export async function resolveTransferRequest(
	request: TransferRequest,
	env: Record<string, string | undefined>,
	options: { cdbResolution?: CdbResolution } = {},
): Promise<ResolvedTransferRequest> {
	validateTransferRequestShape(request);
	const config = await loadEnvFileDefaults(env);

	const direction: TransferDirection =
		request.verb === "upload" ? "upload" : "download";
	const sizeHint = uploadSizeHint(request);
	const { method, protocol, via } = selectTransferMethod(
		request,
		direction,
		sizeHint,
		env,
		config,
	);

	// A quickchr target is a named-live-provider: host/port/auth come from the
	// live descriptor, bypassing CDB and the `__default__` ladder. For
	// `--via sftp`/`scp`, `quickchrConnection` additionally gates on the SSH
	// endpoint's batch-capable auth modes (typed error, never a password prompt).
	let quickchrResolution: Awaited<
		ReturnType<typeof resolveQuickchrTarget>
	> | null = null;
	if (request.quickchr !== undefined) {
		assertNoQuickchrOverrideConflict(request, request.quickchr);
		quickchrResolution = await resolveQuickchrTarget(request.quickchr);
	}
	// Fan-out passes the pre-resolved CDB record for a member (the CDB is loaded
	// once in `expandSelection`); single-target resolves it here.
	const cdbResolution = quickchrResolution
		? undefined
		: (options.cdbResolution ??
			(await resolveCdb(
				{
					targetInput: request.targetInput,
					cdbFile: request.cdbFile,
					cdbPassword: request.cdbPassword,
				},
				env,
				config,
			)));

	const format = resolveTransferFormat(request, env, config);
	const validate = resolveBooleanSetting(
		request.validate,
		env,
		"CENTRS_VALIDATE",
		true,
		"validate",
		cdbResolution?.overrides.validate,
		config,
	);
	const timeoutMs = resolveTransferTimeout(
		request.timeout,
		env,
		protocol,
		cdbResolution,
		config,
	);
	const connection = quickchrResolution
		? quickchrConnection(quickchrResolution, protocol)
		: null;
	// A quickchr TLS/SSH endpoint is trusted by provenance (self-signed VM cert /
	// ephemeral host key) — `insecure` is forced with provider provenance and the
	// provider-trust warning replaces the generic `--insecure` anomaly warning.
	const insecure =
		connection?.insecure === true
			? {
					value: true,
					source: {
						kind: "provider" as const,
						key: `quickchr:${request.quickchr}`,
					},
				}
			: resolveBooleanSetting(
					request.insecure,
					env,
					"CENTRS_INSECURE",
					false,
					"insecure",
					cdbResolution?.overrides.insecure,
					config,
				);
	const target = connection
		? connection.target
		: resolveTarget(
				{
					targetInput: request.targetInput,
					host: request.host,
					port: request.port,
				},
				env,
				protocol,
				cdbResolution,
				config,
			);
	const auth = connection
		? connection.auth
		: resolveAuth(
				{
					username: request.username,
					password: request.password,
					sshKey: request.sshKey,
				},
				env,
				cdbResolution,
				config,
			);

	const warnings: Warning[] = [
		...((cdbResolution?.warnings ?? []) as readonly Warning[]),
		...(connection?.warnings ?? []),
	];
	// Report the auto hop: a large upload cannot ride the REST family's 60 KB
	// `/file/set` cap, so auto-selection moved it to sftp.
	if (via.value === "auto" && method === "sftp") {
		warnings.push({
			code: "transport/auto-method",
			message:
				"Large upload (>60 KB) auto-selected sftp; the REST family cannot write past the 60 KB `/file/set` cap.",
		});
	}
	// A self-signed-accepting run is an anomaly worth surfacing on every
	// transport — unless the trust came from the provider, whose own
	// provider-trust warning already rides above.
	if (insecure.value && connection?.insecure !== true) {
		warnings.push({
			code: "transport/insecure-trust",
			message:
				"`--insecure` is set: TLS peer verification and strict SSH host-key checking are disabled.",
		});
	}

	return {
		verb: request.verb,
		method,
		protocol,
		target,
		auth,
		timeoutMs,
		format,
		validate,
		insecure,
		via,
		local: request.local,
		remote: resolveRemoteTarget(request),
		remoteDest: request.remoteDest,
		listPath: request.path ? normalizeRemotePath(request.path) : undefined,
		force: request.force ?? false,
		verify: parseVerifyMode(request.verify),
		type: request.type,
		name: request.name,
		verbose: request.verbose ?? false,
		warnings,
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
	config: Record<string, string | undefined> = {},
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
		undefined,
		undefined,
		config,
	) as ResolvedSetting<string>;
	const requested = via.value;

	if (requested === "auto") {
		// Auto: REST family carries reads and small writes; a large upload exceeds
		// the 60 KB `/file/set` cap, so it auto-selects sftp (reported as an auto
		// hop in meta.warnings by the caller).
		if (
			direction === "upload" &&
			uploadBytes !== undefined &&
			uploadBytes > REST_FILE_WRITE_CAP_BYTES
		) {
			return { method: "sftp", protocol: "ssh", via };
		}
		return { method: "rest", protocol: "rest-api", via };
	}

	if (requested === "rest" || requested === "rest-api") {
		return { method: "rest", protocol: "rest-api", via };
	}
	if (requested === "native" || requested === "native-api") {
		return { method: "native", protocol: "native-api", via };
	}
	if (requested === "sftp") {
		return { method: "sftp", protocol: "ssh", via };
	}
	if (requested === "scp" || requested === "fetch") {
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
			"Use `--via sftp` for large transfers, or `--via rest` / `--via native` (≤60 KB writes and all reads); scp/fetch are not built yet.",
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
	config: Record<string, string | undefined> = {},
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
		undefined,
		config,
	) as ResolvedSetting<TransferOutputFormat>;
}

function resolveTransferTimeout(
	timeout: TransferRequest["timeout"],
	env: Record<string, string | undefined>,
	protocol: RouterOsProtocol,
	cdb?: CdbResolution,
	config: Record<string, string | undefined> = {},
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
		config,
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
	// Downloaded RouterOS artifacts (backups/exports) can carry credentials,
	// so a newly created destination file gets owner-only permissions
	// instead of the process umask default. Mode only applies on creation —
	// an existing destination keeps its current permissions.
	writeFileSync(local, bytes, { mode: 0o600 });
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
			insecure: toCoreSource(resolved.insecure.source),
			username: resolved.auth.usernameSource
				? toCoreSource(resolved.auth.usernameSource)
				: undefined,
			password: resolved.auth.passwordSource
				? toCoreSource(resolved.auth.passwordSource)
				: undefined,
			sshKey: resolved.auth.sshKeySource
				? toCoreSource(resolved.auth.sshKeySource)
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
	// Size from stat only — `readLocalSource` reads the bytes later, so reading
	// the whole file here just to count would double the I/O. A missing file
	// reports `0`; method selection treats that like an unknown hint (→ rest).
	const size = Bun.file(request.local).size;
	return size > 0 ? size : undefined;
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

/**
 * Resolve the effective remote path. `upload` marks `[remote]` optional in the
 * CLI/docs: when it is omitted and the source is a real file (not stdin), it
 * defaults to that file's basename. Stdin uploads (`local === "-"`) can't derive
 * a name and fall through to {@link requireRemote}'s actionable error.
 */
function resolveRemoteTarget(request: TransferRequest): string | undefined {
	if (request.remote) {
		return normalizeRemotePath(request.remote);
	}
	if (request.verb === "upload" && request.local && request.local !== "-") {
		return normalizeRemotePath(basename(request.local));
	}
	return undefined;
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
	// Split on both separators: this helper derives a name from RouterOS remote
	// paths (always `/`) *and* from a host-local path (which uses `\` on Windows).
	// A `\`-split is harmless for remote paths since RouterOS filenames never
	// contain a backslash. (Without this, an omitted upload remote on Windows
	// defaulted to the full `C:\…\file` path instead of `file`.)
	const parts = path.split(/[/\\]/).filter(Boolean);
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
