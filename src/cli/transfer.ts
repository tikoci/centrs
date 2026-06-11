/**
 * `centrs transfer` CLI surface: command metadata, arg parsing, sub-verb
 * dispatch, and error-to-envelope rendering. `upload` / `download` are also
 * reachable as top-level command aliases (`centrs upload <router> …`) that
 * forward here with a fixed verb — see `runTransferCli`'s `fixedVerb` option and
 * `../cli.ts`. Mirrors the shape of `./retrieve.ts`.
 */

import { asCentrsError, formatCentrsErrorText } from "../errors.ts";
import {
	buildTransferErrorEnvelope,
	CentrsError,
	describeCentrs,
	renderTransferEnvelope,
	type TransferOutputFormat,
	type TransferRequest,
	type TransferVerb,
	transfer,
	transferOutputFormats,
	transferVerbs,
} from "../index.ts";
import {
	type CliCommandMetadata,
	expectValue,
	renderCommandHelp,
} from "./common.ts";

/** Sub-verb aliases, resolved to canonical verbs silently (commands/AGENTS.md). */
const VERB_ALIASES: Record<string, TransferVerb> = {
	print: "list",
	ls: "list",
	put: "upload",
	get: "download",
	rm: "remove",
	delete: "remove",
	mkdir: "mkdir",
};

export const transferCommand: CliCommandMetadata = {
	name: "transfer",
	usage:
		"centrs transfer <router> upload <local> [remote] | download <remote> [local] | list [path] | remove <remote> | mkdir <remote> | copy <src> <dst> [flags]",
	summary:
		"Copy files to/from a RouterOS device and manage device files (rest/native).",
	options: [
		{
			flag: "--via",
			valueName: "<method>",
			description:
				"Pin the method: rest, native, or sftp (large transfers); scp/fetch/ftp are not built yet. Auto picks the cheapest by size/direction.",
		},
		{
			flag: "--ssh-key",
			valueName: "<path>",
			description:
				"sftp only: explicit private-key path. Falls back to CENTRS_SSH_KEY / the ssh-agent.",
		},
		{
			flag: "--insecure",
			description:
				"Accept a self-signed TLS cert (https/api-ssl) or a new SSH host key. Default verifies.",
		},
		{
			flag: "--force",
			valueName: "(--overwrite)",
			description: "Replace an existing destination. Default refuses it.",
		},
		{
			flag: "--verify",
			valueName: "<size|checksum|off>",
			description:
				"Post-transfer integrity check. Default size; --no-verify skips.",
		},
		{
			flag: "--type",
			valueName: "<file|directory|disk|package>",
			description: "list filter: RouterOS /file row type.",
		},
		{
			flag: "--name",
			valueName: "<glob>",
			description: "list filter: file-name glob.",
		},
		{
			flag: "--host",
			valueName: "<host|url>",
			description: "Override the resolved host or base URL.",
		},
		{
			flag: "--port",
			valueName: "<port>",
			description: "Override the resolved management port.",
		},
		{
			flag: "--username",
			valueName: "<name>",
			description: "RouterOS username. Falls back to CENTRS_USERNAME.",
		},
		{
			flag: "--password",
			valueName: "<secret>",
			description: "RouterOS password. Falls back to CENTRS_PASSWORD.",
		},
		{
			flag: "--timeout",
			valueName: "<ms|5s>",
			description: "Operation timeout. REST rejects values above 60s.",
		},
		{
			flag: "--format",
			valueName: `<${transferOutputFormats.join("|")}>`,
			description:
				"Output format. Defaults to text; --json / --yaml shortcuts.",
		},
		{ flag: "--json", description: "Shortcut for --format json." },
		{
			flag: "--cdb-file",
			valueName: "<path>",
			description: "Read target credentials from a WinBox CDB file.",
		},
		{
			flag: "--cdb-password",
			valueName: "<password>",
			description: "Decrypt an encrypted WinBox CDB file.",
		},
		{
			flag: "--validate / --no-validate",
			description: "Enable or disable the existence-probe preflight.",
		},
		{
			flag: "--verbose",
			description: "Show the resolved transport in text output.",
		},
	],
};

export interface RunTransferOptions {
	/** Fixed verb for the top-level `upload` / `download` aliases. */
	fixedVerb?: TransferVerb;
}

export async function runTransferCli(
	args: readonly string[],
	options: RunTransferOptions = {},
): Promise<number> {
	let request: TransferRequest | undefined;
	try {
		const parsed = parseTransferCliArgs(args, options.fixedVerb);
		if (parsed.help) {
			console.log(renderCommandHelp(describeCentrs(), transferCommand));
			return 0;
		}
		request = parsed.request;

		const envelope = await transfer(request);
		const format = resolvedFormat(request);
		console.log(
			renderTransferEnvelope(envelope, format, { verbose: request.verbose }),
		);
		return 0;
	} catch (error) {
		const format = inferRequestedFormat(args, request);
		if (format === "json" || format === "yaml") {
			const envelope = buildTransferErrorEnvelope(
				request ?? { verb: options.fixedVerb ?? "list" },
				error,
			);
			console.error(
				renderTransferEnvelope(envelope, format, {
					verbose: request?.verbose ?? false,
				}),
			);
		} else {
			console.error(
				formatCentrsErrorText(
					asCentrsError(error, {
						code: "input/invalid-command",
						summary: error instanceof Error ? error.message : String(error),
						remediation:
							"Use `centrs transfer --help` to inspect the supported command shape and flags.",
					}),
					{ verbose: request?.verbose ?? args.includes("--verbose") },
				),
			);
		}
		return 1;
	}
}

interface ParsedTransfer {
	help?: boolean;
	request: TransferRequest;
}

function parseTransferCliArgs(
	args: readonly string[],
	fixedVerb?: TransferVerb,
): ParsedTransfer {
	const flags: Partial<TransferRequest> & { verbose?: boolean } = {};
	const positional: string[] = [];
	let help = false;
	// `--verify <mode>` and `--no-verify` both map to the single `verify` field,
	// so a contradictory pair is a CLI-surface conflict the request shape can't see.
	let explicitVerify: string | undefined;
	let sawNoVerify = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) {
			continue;
		}
		switch (arg) {
			case "--help":
			case "-h":
				help = true;
				break;
			case "--via":
				flags.via = expectValue(args, ++index, arg);
				break;
			case "--host":
				flags.host = expectValue(args, ++index, arg);
				break;
			case "--port":
				flags.port = Number.parseInt(expectValue(args, ++index, arg), 10);
				break;
			case "--username":
				flags.username = expectValue(args, ++index, arg);
				break;
			case "--password":
				flags.password = expectValue(args, ++index, arg);
				break;
			case "--ssh-key":
				flags.sshKey = expectValue(args, ++index, arg);
				break;
			case "--insecure":
				flags.insecure = true;
				break;
			case "--timeout":
				flags.timeout = expectValue(args, ++index, arg);
				break;
			case "--format":
				flags.format = expectValue(args, ++index, arg);
				break;
			case "--json":
				flags.format = "json";
				break;
			case "--yaml":
				flags.format = "yaml";
				break;
			case "--force":
			case "--overwrite":
				flags.force = true;
				break;
			case "--verify":
				explicitVerify = expectValue(args, ++index, arg);
				flags.verify = explicitVerify;
				break;
			case "--no-verify":
				sawNoVerify = true;
				flags.verify = "off";
				break;
			case "--type":
				flags.type = expectValue(args, ++index, arg);
				break;
			case "--name":
				flags.name = expectValue(args, ++index, arg);
				break;
			case "--cdb-file":
				flags.cdbFile = expectValue(args, ++index, arg);
				break;
			case "--cdb-password":
				flags.cdbPassword = expectValue(args, ++index, arg);
				break;
			case "--validate":
				flags.validate = true;
				break;
			case "--no-validate":
				flags.validate = false;
				break;
			case "--verbose":
				flags.verbose = true;
				break;
			default:
				if (arg.startsWith("-")) {
					throw new Error(`Unknown transfer flag: ${arg}`);
				}
				positional.push(arg);
				break;
		}
	}

	if (help) {
		return { help: true, request: { verb: fixedVerb ?? "list" } };
	}

	if (sawNoVerify && explicitVerify !== undefined && explicitVerify !== "off") {
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary: "`--verify` and `--no-verify` cannot be combined.",
			remediation:
				"Pass either an explicit `--verify <size|checksum>` or `--no-verify`, not both.",
		});
	}

	const request = assemblePositionals(positional, flags, fixedVerb);
	return { request };
}

/**
 * Map positionals to the per-verb request shape. For the top-level alias the
 * verb is fixed and the first positional is `<router>`; for `centrs transfer`
 * the positionals are `<router> <verb> …`.
 */
function assemblePositionals(
	positional: readonly string[],
	flags: Partial<TransferRequest> & { verbose?: boolean },
	fixedVerb?: TransferVerb,
): TransferRequest {
	let targetInput: string | undefined;
	let verb: TransferVerb;
	let rest: readonly string[];

	if (fixedVerb) {
		targetInput = positional[0];
		verb = fixedVerb;
		rest = positional.slice(1);
	} else {
		targetInput = positional[0];
		const rawVerb = positional[1];
		if (!targetInput || !rawVerb) {
			throw new Error(
				"`centrs transfer` requires <router> and a verb (upload|download|list|remove|mkdir|copy).",
			);
		}
		verb = canonicalVerb(rawVerb);
		rest = positional.slice(2);
	}

	if (!targetInput) {
		throw new Error("`centrs transfer` requires a <router> target.");
	}

	const request: TransferRequest = { verb, targetInput, ...flags };

	switch (verb) {
		case "upload":
			request.local = rest[0];
			request.remote = rest[1];
			break;
		case "download":
			request.remote = rest[0];
			request.local = rest[1];
			break;
		case "list":
			request.path = rest[0];
			break;
		case "remove":
		case "mkdir":
			request.remote = rest[0];
			break;
		case "copy":
			request.remote = rest[0];
			request.remoteDest = rest[1];
			break;
	}

	return request;
}

function canonicalVerb(raw: string): TransferVerb {
	if (transferVerbs.includes(raw as TransferVerb)) {
		return raw as TransferVerb;
	}
	const alias = VERB_ALIASES[raw];
	if (alias) {
		return alias;
	}
	throw new Error(
		`Unknown transfer verb: ${raw}. Use one of ${transferVerbs.join(", ")}.`,
	);
}

function resolvedFormat(request: TransferRequest): TransferOutputFormat {
	const candidate = request.format;
	if (candidate === "json" || candidate === "yaml" || candidate === "text") {
		return candidate;
	}
	const envFormat = process.env["CENTRS_FORMAT"];
	if (envFormat === "json" || envFormat === "yaml" || envFormat === "text") {
		return envFormat;
	}
	return "text";
}

function inferRequestedFormat(
	args: readonly string[],
	request?: TransferRequest,
): TransferOutputFormat {
	if (request) {
		return resolvedFormat(request);
	}
	if (args.includes("--json")) {
		return "json";
	}
	if (args.includes("--yaml")) {
		return "yaml";
	}
	const formatIndex = args.indexOf("--format");
	const value = formatIndex !== -1 ? args[formatIndex + 1] : undefined;
	if (value === "json" || value === "yaml" || value === "text") {
		return value;
	}
	const envFormat = process.env["CENTRS_FORMAT"];
	if (envFormat === "json" || envFormat === "yaml" || envFormat === "text") {
		return envFormat;
	}
	return "text";
}
