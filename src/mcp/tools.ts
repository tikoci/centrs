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
	type LoadedCdb,
	listDevices,
	listGroups,
	showDevice,
} from "../devices.ts";
import { CentrsError, serializeCentrsError } from "../errors.ts";
import {
	canonicalizeExecuteCommand,
	executeEnvelope,
	isWriteShaped,
	validateExecuteEnvelope,
} from "../execute.ts";
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
		meta: {
			target: context.target ? { input: context.target } : {},
			via: null,
			settings: {},
			operation: { kind: "mcp", tool },
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

// --- centrs_devices (read-only in phase 1) ----------------------------------

export const devicesInputShape = {
	op: z
		.enum(["list", "show", "groups"])
		.describe(
			"Read-only registry op. Mutations (add/set/remove) are a later phase.",
		),
	target: z.string().optional().describe("Required for op=show."),
	group: z.string().optional().describe("Optional group filter for op=list."),
} as const;

const devicesSchema = z.object(devicesInputShape);
export type DevicesArgs = z.infer<typeof devicesSchema>;

/** Inspect the CDB device registry — the allowlist itself. Read-only. */
export async function handleDevices(
	args: DevicesArgs,
	config: CentrsMcpConfig,
): Promise<McpEnvelope> {
	try {
		const cdb = await loadAllowlistCdb(config);
		switch (args.op) {
			case "list":
				return listDevices({ cdb, group: args.group });
			case "groups":
				return listGroups({ cdb, withMembers: true });
			case "show": {
				if (args.target === undefined) {
					throw new CentrsError({
						code: "input/invalid-command",
						summary: "op=show requires a `target`.",
						remediation:
							"Pass the CDB target to show, or use op=list to enumerate them.",
					});
				}
				return showDevice({ cdb, target: args.target, env: config.env });
			}
			default:
				throw new CentrsError({
					code: "input/invalid-command",
					summary: `Unknown devices op "${String(args.op)}".`,
					remediation: "Use one of: list, show, groups.",
				});
		}
	} catch (error) {
		return mcpErrorEnvelope("centrs_devices", error, { target: args.target });
	}
}
