/**
 * MCP tool handlers for centrs.
 *
 * Each handler is a plain async function that returns the standard centrs
 * envelope (`{ ok, data?|error, warnings, meta }`) — the same shape every other
 * surface emits. The server module (`./server.ts`) wraps these as MCP tools and
 * serializes the returned envelope as JSON text content. Keeping the handlers
 * transport-free makes them directly unit-testable without an MCP client.
 *
 * The tool surface is a small set of scoped verbs (never one tool per RouterOS
 * command), grounded in the `bench-routeros-tools` study: an explain → validate
 * → run split where `:parse` is the real-parser validation gate.
 */

import { z } from "zod";
import type { CentrsEnvelope } from "../core/envelope.ts";
import {
	addDevice,
	editInteractiveOnlyError,
	type LoadedCdb,
	listDevices,
	listGroups,
	recordTypeFromName,
	removeDevice,
	setDevice,
	showDevice,
} from "../devices.ts";
import { discover } from "../discover.ts";
import { CentrsError, serializeCentrsError } from "../errors.ts";
import {
	canonicalizeExecuteCommand,
	executeEnvelope,
	isWriteShaped,
	validateExecuteEnvelope,
} from "../execute.ts";
import type { CommentKvUpdate } from "../resolver/comment-kv.ts";
import { parseDuration } from "../resolver/settings.ts";
import { buildRetrieveErrorEnvelope, retrieve } from "../retrieve.ts";
import {
	buildRetrieveFanoutErrorEnvelope,
	retrieveGroup,
} from "../retrieve-fanout.ts";
import type { CentrsMcpConfig } from "./config.ts";
import {
	assertWritePermitted,
	loadAllowlistCdb,
	resolveRegisteredGroup,
	resolveRegisteredTarget,
} from "./safety.ts";

export interface McpOperationMeta {
	kind: "mcp";
	tool: string;
}

/**
 * The MCP tools return whatever envelope their core call produced (each carries
 * its own command-specific operation meta), plus the synthetic adapter-error
 * envelope below. The shared shape is the standard centrs envelope, so the type
 * stays open on the operation slot rather than forcing a re-stamp.
 */
type McpEnvelope = CentrsEnvelope;

type EnvelopeWithData = CentrsEnvelope<unknown> & { data?: unknown };

/**
 * Build a minimal centrs error envelope for failures that happen in the MCP
 * adapter itself (allowlist rejections, policy denials) — before or instead of
 * a core call that would have produced its own envelope.
 */
function mcpErrorEnvelope(
	tool: string,
	error: unknown,
	context: { target?: string } = {},
): McpEnvelope {
	const centrsError =
		error instanceof CentrsError
			? error
			: new CentrsError({
					code: "internal/mcp-tool",
					summary: error instanceof Error ? error.message : String(error),
					remediation:
						"This is an unexpected MCP adapter failure; retry, and report it if it persists.",
				});
	return {
		ok: false,
		error: serializeCentrsError(centrsError),
		warnings: [],
		tips: [],
		meta: {
			target: context.target ? { input: context.target } : {},
			via: null,
			settings: {},
			operation: { kind: "mcp", tool },
		},
	};
}

function requireConfirm(tool: string, confirmed: boolean | undefined): void {
	if (confirmed !== true) {
		throw new CentrsError({
			code: "usage/confirmation-required",
			summary: `${tool} mutates the CDB and requires \`confirm: true\`.`,
			remediation:
				"Re-submit the MCP tool call with confirm=true after verifying the target and requested CDB change.",
		});
	}
}

function redactEntry(entry: unknown): unknown {
	if (typeof entry !== "object" || entry === null) {
		return entry;
	}
	const { password, ...rest } = entry as Record<string, unknown>;
	return {
		...rest,
		passwordSet: typeof password === "string" ? password.length > 0 : undefined,
	};
}

function redactDeviceSecrets(envelope: McpEnvelope): McpEnvelope {
	if (!envelope.ok) {
		return envelope;
	}
	const withData = envelope as EnvelopeWithData;
	const data = withData.data;
	if (typeof data !== "object" || data === null) {
		return envelope;
	}
	const deviceData = data as { entry?: unknown };
	if (deviceData.entry === undefined) {
		return envelope;
	}
	return {
		...envelope,
		data: {
			...data,
			entry: redactEntry(deviceData.entry),
		},
	};
}

// --- centrs_explain ---------------------------------------------------------

export const explainInputShape = {
	command: z
		.string()
		.describe(
			"A RouterOS CLI command string to canonicalize, e.g. '/ip/address/add address=1.2.3.4/24 interface=ether1'.",
		),
} as const;

const explainSchema = z.object(explainInputShape);
export type ExplainArgs = z.infer<typeof explainSchema>;

/**
 * Offline canonicalization: turn a RouterOS CLI string into
 * `{ path, verb, attributes, queries, mode, writeShaped }` without touching a
 * device. No CDB or target needed — this is the cheap knowledge tier.
 */
export function handleExplain(args: ExplainArgs): McpEnvelope {
	try {
		const canonical = canonicalizeExecuteCommand(args.command);
		return {
			ok: true,
			data: {
				input: canonical.input,
				mode: canonical.mode,
				path: canonical.path,
				verb: canonical.verb,
				attributes: canonical.attributes,
				queries: canonical.queries,
				writeShaped: isWriteShaped(canonical),
			},
			warnings: [],
			tips: [],
			meta: {
				target: {},
				via: null,
				settings: {},
				operation: { kind: "mcp", tool: "centrs_explain" },
			},
		};
	} catch (error) {
		return mcpErrorEnvelope("centrs_explain", error);
	}
}

// --- centrs_validate --------------------------------------------------------

export const validateInputShape = {
	target: z
		.string()
		.describe(
			"CDB-registered target (name / IP / URL / MAC). Must be on the allowlist.",
		),
	command: z.string().describe("RouterOS CLI command to dry-run."),
	via: z
		.string()
		.optional()
		.describe(
			"Override transport (rest-api, native-api, ssh). Defaults to the CDB/record preference.",
		),
	timeout: z
		.union([z.string(), z.number()])
		.optional()
		.describe("Request timeout (ms or duration string)."),
} as const;

const validateSchema = z.object(validateInputShape);
export type ValidateArgs = z.infer<typeof validateSchema>;

/**
 * Dry-run a command through `:parse` + `/console/inspect` against a registered
 * device, never running it. This is the bench's gold-bug catcher: schema
 * inspection alone accepts `blackhole=yes`, but the real parser rejects it.
 */
export async function handleValidate(
	args: ValidateArgs,
	config: CentrsMcpConfig,
): Promise<McpEnvelope> {
	let cdb: LoadedCdb;
	try {
		cdb = await loadAllowlistCdb(config);
		resolveRegisteredTarget(cdb, args.target);
	} catch (error) {
		return mcpErrorEnvelope("centrs_validate", error, { target: args.target });
	}
	return await validateExecuteEnvelope(
		{
			targetInput: args.target,
			command: args.command,
			via: args.via,
			timeout: args.timeout,
			cdbFile: config.cdbFile,
			cdbPassword: config.cdbPassword,
			validate: true,
			stdinIsTty: false,
		},
		config.env,
	);
}

// --- centrs_retrieve --------------------------------------------------------

export const retrieveInputShape = {
	target: z
		.string()
		.optional()
		.describe("CDB-registered single target. Use either target or group."),
	group: z
		.string()
		.optional()
		.describe("CDB group selector — fans out over all registered members."),
	path: z
		.string()
		.describe("RouterOS menu path to read, e.g. '/system/resource'."),
	attributes: z
		.array(z.string())
		.optional()
		.describe("Project only these attributes."),
	allAttributes: z
		.boolean()
		.optional()
		.describe("Return every attribute instead of the default projection."),
	filter: z.string().optional().describe("RouterOS-style filter expression."),
	query: z
		.string()
		.optional()
		.describe("Raw query word(s) appended to the read."),
	via: z.string().optional().describe("Override transport."),
	timeout: z
		.union([z.string(), z.number()])
		.optional()
		.describe("Request timeout."),
} as const;

const retrieveSchema = z.object(retrieveInputShape);
export type RetrieveArgs = z.infer<typeof retrieveSchema>;

/** Read RouterOS state over the API for a registered target or group. */
export async function handleRetrieve(
	args: RetrieveArgs,
	config: CentrsMcpConfig,
): Promise<McpEnvelope> {
	if ((args.target === undefined) === (args.group === undefined)) {
		return mcpErrorEnvelope(
			"centrs_retrieve",
			new CentrsError({
				code: "input/invalid-command",
				summary: "Provide exactly one of `target` or `group`.",
				remediation:
					"Pass a single CDB target, or a group selector — not both, not neither.",
			}),
		);
	}

	let cdb: LoadedCdb;
	try {
		cdb = await loadAllowlistCdb(config);
		if (args.group !== undefined) {
			resolveRegisteredGroup(cdb, args.group);
		} else if (args.target !== undefined) {
			resolveRegisteredTarget(cdb, args.target);
		}
	} catch (error) {
		return mcpErrorEnvelope("centrs_retrieve", error, {
			target: args.target ?? args.group,
		});
	}

	const request = {
		targetInput: args.target,
		group: args.group,
		path: args.path,
		attributes: args.attributes,
		allAttributes: args.allAttributes,
		filter: args.filter,
		query: args.query,
		via: args.via,
		timeout: args.timeout,
		cdbFile: config.cdbFile,
		cdbPassword: config.cdbPassword,
	};

	try {
		const envelope =
			args.group !== undefined
				? await retrieveGroup(request)
				: await retrieve(request);
		return envelope;
	} catch (error) {
		const envelope =
			args.group !== undefined
				? buildRetrieveFanoutErrorEnvelope(request, error)
				: buildRetrieveErrorEnvelope(request, error);
		return envelope;
	}
}

// --- centrs_execute ---------------------------------------------------------

export const executeInputShape = {
	target: z
		.string()
		.describe(
			"CDB-registered target. Inline host+credentials are not accepted.",
		),
	command: z.string().describe("RouterOS CLI command to run."),
	confirm: z
		.boolean()
		.optional()
		.describe(
			"Required true for write-shaped commands (add/set/remove). Reads ignore it.",
		),
	via: z.string().optional().describe("Override transport."),
	timeout: z
		.union([z.string(), z.number()])
		.optional()
		.describe("Request timeout."),
} as const;

const executeSchema = z.object(executeInputShape);
export type ExecuteArgs = z.infer<typeof executeSchema>;

/**
 * Run a read- or write-shaped command against a registered device. Writes are
 * double-gated: the CDB record must be `mcp=rw` (else `cdb/write-not-permitted`)
 * and the call must pass `confirm:true` (else `usage/confirmation-required`).
 */
export async function handleExecute(
	args: ExecuteArgs,
	config: CentrsMcpConfig,
): Promise<McpEnvelope> {
	try {
		const cdb = await loadAllowlistCdb(config);
		const registered = resolveRegisteredTarget(cdb, args.target);
		const canonical = canonicalizeExecuteCommand(args.command);
		if (isWriteShaped(canonical)) {
			assertWritePermitted(registered);
		}
	} catch (error) {
		return mcpErrorEnvelope("centrs_execute", error, { target: args.target });
	}

	return await executeEnvelope(
		{
			targetInput: args.target,
			command: args.command,
			via: args.via,
			timeout: args.timeout,
			cdbFile: config.cdbFile,
			cdbPassword: config.cdbPassword,
			validate: true,
			yes: args.confirm === true,
			stdinIsTty: false,
		},
		config.env,
	);
}

// --- centrs_devices ----------------------------------------------------------

export const devicesInputShape = {
	op: z
		.enum(["list", "show", "groups", "add", "edit", "set", "remove"])
		.describe(
			"Registry operation. Reads: list/show/groups. Writes (require confirm=true): add/set/remove. edit is reserved for the future interactive editor and returns usage/not-implemented.",
		),
	target: z
		.string()
		.optional()
		.describe("Required for op=show/add/set/remove."),
	group: z
		.string()
		.optional()
		.describe(
			"Group filter for op=list; first-class group field for op=add/set.",
		),
	user: z.string().optional().describe("CDB username for op=add/set."),
	password: z
		.string()
		.optional()
		.describe("CDB password for op=add/set. It is never returned by MCP."),
	profile: z.string().optional().describe("CDB profile for op=add/set."),
	session: z.string().optional().describe("CDB session for op=add/set."),
	comment: z
		.string()
		.optional()
		.describe(
			"CDB base comment for op=add; op=set edits the comment via updates.",
		),
	recordType: z
		.string()
		.optional()
		.describe("CDB record type for op=add, e.g. ipAdmin or macTarget."),
	savedPassword: z
		.boolean()
		.optional()
		.describe("Set the CDB saved-password flag for op=add/set."),
	force: z
		.boolean()
		.optional()
		.describe("Allow op=add to replace an existing target."),
	updates: z
		.array(
			z.object({
				key: z.string(),
				value: z.string().nullable(),
			}),
		)
		.optional()
		.describe("Comment kv-soup updates for op=set. Use value=null to remove."),
	strict: z
		.boolean()
		.optional()
		.describe("For op=set, reject comment keys outside the allowlist."),
	lat: z
		.number()
		.optional()
		.describe(
			"Latitude in decimal degrees (-90..90) for op=add/set; a comment-kv fact, paired with lon (issue #146).",
		),
	lon: z
		.number()
		.optional()
		.describe(
			"Longitude in decimal degrees (-180..180) for op=add/set; a comment-kv fact, paired with lat.",
		),
	altitude: z
		.number()
		.optional()
		.describe(
			"Altitude in meters for op=add/set (may be negative); a comment-kv fact.",
		),
	altitudeType: z
		.enum(["MSL", "AGL"])
		.optional()
		.describe(
			"Vertical datum for altitude, op=add/set (default MSL when altitude is set).",
		),
	confirm: z
		.boolean()
		.optional()
		.describe("Required true for CDB-mutating ops add/set/remove."),
} as const;

const devicesSchema = z.object(devicesInputShape);
export type DevicesArgs = z.infer<typeof devicesSchema>;

function requireDevicesTarget(
	args: DevicesArgs,
	operation: "show" | "add" | "edit" | "set" | "remove",
): string {
	if (args.target !== undefined) {
		return args.target;
	}
	throw new CentrsError({
		code: "input/invalid-command",
		summary: `op=${operation} requires a \`target\`.`,
		remediation:
			"Pass the CDB target to mutate, or use op=list to enumerate registered targets.",
	});
}

/**
 * Lower the typed `lat`/`lon`/`altitude`/`altitudeType` MCP args into comment-kv
 * updates — the same core surface the CLI's `--lat`/`--lon`/`--gps` flags lower
 * into (`src/cli/devices.ts`). Light touch: no alias handling here (the MCP
 * schema only exposes the canonical field names), range/enum/pairing
 * validation happens once in `validateCommentKvUpdates` (`src/devices.ts`).
 */
function buildGeoUpdates(args: DevicesArgs): CommentKvUpdate[] {
	const updates: CommentKvUpdate[] = [];
	if (args.lat !== undefined) {
		updates.push({ key: "lat", value: String(args.lat) });
	}
	if (args.lon !== undefined) {
		updates.push({ key: "lon", value: String(args.lon) });
	}
	if (args.altitude !== undefined) {
		updates.push({ key: "altitude", value: String(args.altitude) });
	}
	if (args.altitudeType !== undefined) {
		updates.push({ key: "altitude-type", value: args.altitudeType });
	}
	return updates;
}

function resolveRecordType(recordType: string | undefined): number | undefined {
	if (recordType === undefined) {
		return undefined;
	}
	const resolved = recordTypeFromName(recordType);
	if (resolved !== undefined) {
		return resolved;
	}
	throw new CentrsError({
		code: "input/invalid-command",
		summary: `Unknown CDB recordType "${recordType}".`,
		remediation:
			"Use a WinBox CDB record type name such as ipAdmin, ipUser, or macTarget.",
		context: { recordType },
	});
}

/** Inspect or mutate the CDB device registry — the allowlist itself. */
export async function handleDevices(
	args: DevicesArgs,
	config: CentrsMcpConfig,
): Promise<McpEnvelope> {
	try {
		const cdb = await loadAllowlistCdb(config);
		// GPS fields write via add/set only; reject them for read/other ops
		// instead of silently dropping the caller's input (mirrors the CLI's
		// per-subcommand flag guard in src/cli/devices.ts).
		if (
			args.op !== "add" &&
			args.op !== "set" &&
			(args.lat !== undefined ||
				args.lon !== undefined ||
				args.altitude !== undefined ||
				args.altitudeType !== undefined)
		) {
			throw new CentrsError({
				code: "input/invalid-command",
				summary: `GPS fields (lat/lon/altitude/altitudeType) are not valid for op="${args.op}".`,
				remediation:
					"Store GPS with op=add or op=set; drop the GPS fields for list/show/groups/edit/remove.",
				context: { op: args.op },
			});
		}
		switch (args.op) {
			case "list":
				return listDevices({ cdb, group: args.group });
			case "groups":
				return listGroups({ cdb, withMembers: true });
			case "show": {
				const target = requireDevicesTarget(args, "show");
				return redactDeviceSecrets(
					showDevice({ cdb, target, env: config.env }),
				);
			}
			case "add": {
				requireConfirm("centrs_devices op=add", args.confirm);
				const target = requireDevicesTarget(args, "add");
				return redactDeviceSecrets(
					await addDevice({
						cdb,
						target,
						recordType: resolveRecordType(args.recordType),
						user: args.user,
						password: args.password,
						group: args.group,
						profile: args.profile,
						session: args.session,
						comment: args.comment,
						commentKvUpdates: buildGeoUpdates(args),
						savedPassword: args.savedPassword,
						force: args.force,
					}),
				);
			}
			case "edit":
				// The interactive editor has no MCP analogue; modify via op=set.
				throw editInteractiveOnlyError();
			case "set": {
				requireConfirm("centrs_devices op=set", args.confirm);
				const target = requireDevicesTarget(args, "set");
				return redactDeviceSecrets(
					await setDevice({
						cdb,
						target,
						updates: [...buildGeoUpdates(args), ...(args.updates ?? [])],
						user: args.user,
						password: args.password,
						group: args.group,
						profile: args.profile,
						session: args.session,
						savedPassword: args.savedPassword,
						strict: args.strict,
					}),
				);
			}
			case "remove": {
				requireConfirm("centrs_devices op=remove", args.confirm);
				const target = requireDevicesTarget(args, "remove");
				return await removeDevice({ cdb, target });
			}
			default:
				throw new CentrsError({
					code: "input/invalid-command",
					summary: `Unknown devices op "${String(args.op)}".`,
					remediation:
						"Use one of: list, show, groups, add, edit, set, remove.",
				});
		}
	} catch (error) {
		return mcpErrorEnvelope("centrs_devices", error, { target: args.target });
	}
}

// --- centrs_discover ---------------------------------------------------------

export const discoverInputShape = {
	timeout: z
		.union([z.string(), z.number()])
		.optional()
		.describe("MNDP listen window (ms or duration string). Defaults to 15s."),
	port: z
		.number()
		.int()
		.min(0)
		.max(65535)
		.optional()
		.describe(
			"UDP port to bind. Defaults to 5678; use 0 for an ephemeral port.",
		),
	host: z
		.string()
		.optional()
		.describe("Bind address for MNDP listen. Defaults to 0.0.0.0."),
	ttlMs: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("MNDP cache TTL in ms."),
	save: z
		.boolean()
		.optional()
		.describe("Persist discovered neighbors into the active CDB."),
	group: z
		.string()
		.optional()
		.describe("CDB group for saved neighbors. Defaults to discovered."),
	confirm: z
		.boolean()
		.optional()
		.describe("Required true when save=true because saving mutates the CDB."),
	sendRefresh: z
		.boolean()
		.optional()
		.describe(
			"Send MNDP broadcast refresh. Defaults true; tests may set false.",
		),
} as const;

const discoverSchema = z.object(discoverInputShape);
export type DiscoverArgs = z.infer<typeof discoverSchema>;

function mcpTimeoutMs(timeout: DiscoverArgs["timeout"]): number | undefined {
	if (timeout === undefined) {
		return undefined;
	}
	if (typeof timeout === "number") {
		return timeout;
	}
	return parseDuration(timeout);
}

/** Listen for MNDP neighbors and optionally save them into the active CDB. */
export async function handleDiscover(
	args: DiscoverArgs,
	config: CentrsMcpConfig,
): Promise<McpEnvelope> {
	try {
		if (args.save === true) {
			requireConfirm("centrs_discover save", args.confirm);
		}
		return await discover({
			timeoutMs: mcpTimeoutMs(args.timeout),
			port: args.port,
			host: args.host,
			ttlMs: args.ttlMs,
			save: args.save,
			group: args.group,
			cdbFile: config.cdbFile,
			cdbPassword: config.cdbPassword,
			env: config.env,
			sendRefresh: args.sendRefresh,
		});
	} catch (error) {
		return mcpErrorEnvelope("centrs_discover", error);
	}
}
