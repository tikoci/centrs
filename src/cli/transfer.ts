/**
 * `centrs transfer` CLI surface: command metadata, arg parsing, sub-verb
 * dispatch, and error-to-envelope rendering. `upload` / `download` are also
 * reachable as top-level command aliases (`centrs upload <router> …`) that
 * forward here with a fixed verb — see `runTransferCli`'s `fixedVerb` option and
 * `../cli.ts`. Mirrors the shape of `./retrieve.ts`.
 */

import { fanoutExitCode } from "../core/fanout.ts";
import { asCentrsError, formatCentrsErrorText } from "../errors.ts";
import {
	buildTransferErrorEnvelope,
	buildTransferFanoutErrorEnvelope,
	CentrsError,
	describeCentrs,
	renderTransferEnvelope,
	renderTransferFanoutEnvelope,
	type TransferOutputFormat,
	type TransferRequest,
	type TransferVerb,
	transfer,
	transferFanout,
	transferOutputFormats,
	transferVerbs,
} from "../index.ts";
import { assertNoQuickchrOverrideConflict } from "../resolver/index.ts";
import {
	type CliCommandMetadata,
	expectValue,
	renderCommandHelp,
	unknownFlagError,
} from "./common.ts";
import {
	buildTargetSelectionTips,
	cdbFileFromArgs,
	formatTipsText,
	isMissingTargetError,
	missingTargetError,
	withTips,
} from "./missing-target.ts";
import {
	assertQuickchrExclusive,
	buildTargetSelection,
	consumeSelectionFlag,
	emptySelectionFlags,
	isFanoutMode,
	type SelectionFlags,
	selectionCommandOptions,
} from "./selection.ts";

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
		"Copy files to/from a RouterOS device and manage device files (rest/native/sftp).",
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
		...selectionCommandOptions,
		{
			flag: "--out-dir",
			valueName: "<dir>",
			description:
				"`download` fan-out only: write one file per target into <dir>, named by CDB identity. Required when downloading across a selection.",
		},
		{
			flag: "--yes",
			description:
				"Confirm a mutating fan-out (upload/remove/mkdir/copy) across multiple routers in non-interactive runs.",
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
			flag: "--username / --user / -u",
			valueName: "<name>",
			description:
				"RouterOS username (aliases --user, -u). Falls back to CENTRS_USERNAME.",
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

		// Fan-out mode (a selector flag, or >1 positional target before the verb)
		// has its own envelope shape, single up-front write-confirm, and exit code.
		if (isFanoutMode(parsed.selectionFlags, parsed.targetPositionals.length)) {
			return await runTransferFanoutCli(
				parsed.request,
				parsed.selectionFlags,
				parsed.targetPositionals,
				args,
			);
		}
		request = parsed.request;

		const envelope = await transfer(request);
		const format = resolvedFormat(request);
		const rendered = renderTransferEnvelope(envelope, format, {
			verbose: request.verbose,
		});
		// A download to stdout (`local === "-"`) has already streamed the file bytes
		// to stdout inside `transfer()`; keep the structured envelope on stderr so it
		// cannot interleave with — and corrupt — the piped payload.
		if (request.verb === "download" && request.local === "-") {
			console.error(rendered);
		} else {
			console.log(rendered);
		}
		return 0;
	} catch (error) {
		// Drop credential fields before any renderer touches the request: error
		// output reaches stderr/CI logs and must never carry the raw password
		// (CodeQL js/clear-text-logging).
		const safeRequest = redactTransferRequest(request);
		const format = inferRequestedFormat(args, safeRequest);
		const tips = isMissingTargetError(error)
			? await buildTargetSelectionTips({
					cdbFile: safeRequest?.cdbFile ?? cdbFileFromArgs(args),
					env: Bun.env,
				})
			: [];
		if (format === "json" || format === "yaml") {
			const envelope = withTips(
				buildTransferErrorEnvelope(
					safeRequest ?? { verb: options.fixedVerb ?? "list" },
					error,
				),
				tips,
			);
			console.error(
				// codeql[js/clear-text-logging] The transfer error path redacts password/cdbPassword before any renderer (redactTransferRequest), and buildTransferErrorEnvelope only emits targetInput.
				renderTransferEnvelope(envelope, format, {
					verbose: safeRequest?.verbose ?? false,
				}),
			);
		} else {
			console.error(
				// codeql[js/clear-text-logging] Credentials are redacted from the request before rendering (redactTransferRequest) and never reach the error/stderr; same known false positive dismissed across all CLI commands.
				formatCentrsErrorText(
					asCentrsError(error, {
						code: "input/invalid-command",
						summary: error instanceof Error ? error.message : String(error),
						remediation:
							"Use `centrs transfer --help` to inspect the supported command shape and flags.",
					}),
					{ verbose: safeRequest?.verbose ?? args.includes("--verbose") },
				) + formatTipsText(tips),
			);
		}
		return 1;
	}
}

async function runTransferFanoutCli(
	request: TransferRequest,
	selectionFlags: SelectionFlags,
	targetPositionals: readonly string[],
	args: readonly string[],
): Promise<number> {
	const selection = buildTargetSelection(selectionFlags, targetPositionals);
	const format = inferRequestedFormat(args, request);
	try {
		const envelope = await transferFanout(
			{ ...request, stdinIsTty: process.stdin.isTTY },
			selection,
			Bun.env,
			{},
			{ concurrency: selectionFlags.concurrency, allowAdhoc: true },
		);
		console.log(
			renderTransferFanoutEnvelope(envelope, format, {
				verbose: request.verbose ?? false,
			}),
		);
		// Granular exit contract: 0 all-ok / 2 partial / 1 all-failed.
		return fanoutExitCode(envelope);
	} catch (error) {
		// Strip credentials before any renderer touches the request (stderr/CI logs):
		// pass an explicitly redacted request, with no raw-request fallback path.
		const envelope = buildTransferFanoutErrorEnvelope(
			{ ...request, password: undefined, cdbPassword: undefined },
			error,
		);
		console.error(
			// codeql[js/clear-text-logging] No secret logged: request is redactTransferRequest'd (password/cdbPassword stripped) before the builder; fan-out error meta is {target:{},via,settings:{}}.
			renderTransferFanoutEnvelope(envelope, format, {
				verbose: request.verbose ?? false,
			}),
		);
		return 1;
	}
}

/**
 * Strip credential fields before a failed request is handed to the error
 * envelope/text renderers. Those outputs land on stderr (and CI logs), so the
 * raw `password` / `cdbPassword` must never reach them.
 */
function redactTransferRequest(
	request: TransferRequest | undefined,
): TransferRequest | undefined {
	if (!request) {
		return undefined;
	}
	// Always return a fresh object with the secrets stripped — never alias the
	// original request, so the raw password cannot flow into a rendered error
	// even by way of a sibling field.
	return { ...request, password: undefined, cdbPassword: undefined };
}

interface ParsedTransfer {
	help?: boolean;
	request: TransferRequest;
	selectionFlags: SelectionFlags;
	targetPositionals: readonly string[];
}

export function parseTransferCliArgs(
	args: readonly string[],
	fixedVerb?: TransferVerb,
): ParsedTransfer {
	const flags: Partial<TransferRequest> & { verbose?: boolean } = {};
	const selectionFlags = emptySelectionFlags();
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
			case "--user":
			case "-u":
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
			case "--out-dir":
				flags.outDir = expectValue(args, ++index, arg);
				break;
			case "--yes":
				flags.yes = true;
				break;
			case "--verbose":
				flags.verbose = true;
				break;
			default: {
				const consumed = consumeSelectionFlag(args, index, selectionFlags);
				if (consumed !== null) {
					index = consumed;
					break;
				}
				// A lone `-` is the stdin/stdout positional (upload from / download
				// to a pipe), not a flag.
				if (arg !== "-" && arg.startsWith("-")) {
					throw unknownFlagError("transfer", arg, transferCommand.options);
				}
				positional.push(arg);
				break;
			}
		}
	}

	if (help) {
		return {
			help: true,
			request: { verb: fixedVerb ?? "list" },
			selectionFlags,
			targetPositionals: [],
		};
	}

	if (sawNoVerify && explicitVerify !== undefined && explicitVerify !== "off") {
		throw new CentrsError({
			code: "usage/conflicting-flags",
			summary: "`--verify` and `--no-verify` cannot be combined.",
			remediation:
				"Pass either an explicit `--verify <size|checksum>` or `--no-verify`, not both.",
		});
	}

	const { request, targetPositionals } = assemblePositionals(
		positional,
		flags,
		selectionFlags,
		fixedVerb,
	);
	return { request, selectionFlags, targetPositionals };
}

/** Whether a positional token is a transfer verb keyword (canonical or alias). */
function isTransferVerbToken(token: string): boolean {
	return transferVerbs.includes(token as TransferVerb) || token in VERB_ALIASES;
}

/**
 * Map positionals to the per-verb request shape and split fan-out targets. The
 * boundary is the **verb keyword**: positionals before it are targets, the verb +
 * paths follow. The top-level `upload`/`download` alias fixes the verb, so its
 * positionals are paths; with a selector present, positional fan-out targets are
 * not expressible there (fan-out comes from the selector). See
 * `docs/CONSTITUTION.md` (Target selection).
 */
function assemblePositionals(
	positional: readonly string[],
	flags: Partial<TransferRequest> & { verbose?: boolean },
	selectionFlags: SelectionFlags,
	fixedVerb?: TransferVerb,
): { request: TransferRequest; targetPositionals: readonly string[] } {
	// Any target-taking flag (CDB selector or `--quickchr`) claims the target
	// slots, so every positional belongs to the verb/paths.
	const hasSelector =
		isFanoutMode(selectionFlags, 0) || selectionFlags.quickchr.length > 0;
	let verb: TransferVerb;
	let targetPositionals: readonly string[];
	let rest: readonly string[];

	if (fixedVerb) {
		verb = fixedVerb;
		if (hasSelector) {
			// alias + selector: targets come from the selector; positionals are paths.
			targetPositionals = [];
			rest = positional;
		} else {
			targetPositionals = positional[0] !== undefined ? [positional[0]] : [];
			rest = positional.slice(1);
		}
	} else {
		const verbIndex = positional.findIndex(isTransferVerbToken);
		if (verbIndex === -1) {
			if (positional.length === 0 && !hasSelector) {
				throw missingTargetError({
					command: "transfer",
					summary:
						"`centrs transfer` requires a <router> target and a verb (upload|download|list|remove|mkdir|copy).",
					remediation:
						"Pass the target then a verb, e.g. `centrs transfer <router> list`; run `--help` for the full shape.",
				});
			}
			throw new CentrsError({
				code: "input/invalid-command",
				summary:
					"`centrs transfer` requires a verb (upload|download|list|remove|mkdir|copy).",
				remediation:
					"Pass a verb, e.g. `centrs transfer <router> list`; run `--help` for the full shape.",
				context: { positionals: positional },
			});
		}
		targetPositionals = positional.slice(0, verbIndex);
		verb = canonicalVerb(positional[verbIndex] as string);
		rest = positional.slice(verbIndex + 1);
	}

	const request: TransferRequest = { verb, ...flags };
	applyVerbPaths(request, verb, rest);
	assertQuickchrExclusive(selectionFlags, targetPositionals.length);
	// Direct connection overrides conflict with `--quickchr` globally: reject at
	// parse time so a repeated `--quickchr` gets one usage error (exit 1), never
	// per-member failures. The resolver re-checks for library callers.
	if (selectionFlags.quickchr.length > 0) {
		assertNoQuickchrOverrideConflict(request, selectionFlags.quickchr[0] ?? "");
	}

	// Single-target (not fan-out mode) needs exactly one resolved target: one
	// positional, or one `--quickchr <name>` (the named-live-provider).
	if (!isFanoutMode(selectionFlags, targetPositionals.length)) {
		if (selectionFlags.quickchr.length === 1) {
			request.quickchr = selectionFlags.quickchr[0];
			return { request, targetPositionals };
		}
		const targetInput = targetPositionals[0];
		if (!targetInput) {
			throw missingTargetError({
				command: "transfer",
				summary: "`centrs transfer` requires a <router> target.",
				remediation:
					"Pass the router host/identity as the first argument; run `centrs transfer --help` for the command shape.",
			});
		}
		request.targetInput = targetInput;
	}

	return { request, targetPositionals };
}

/** Map the post-verb positionals onto the per-verb request fields. */
function applyVerbPaths(
	request: TransferRequest,
	verb: TransferVerb,
	rest: readonly string[],
): void {
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
}

function canonicalVerb(raw: string): TransferVerb {
	if (transferVerbs.includes(raw as TransferVerb)) {
		return raw as TransferVerb;
	}
	const alias = VERB_ALIASES[raw];
	if (alias) {
		return alias;
	}
	throw new CentrsError({
		code: "input/invalid-command",
		summary: `Unknown transfer verb: ${raw}.`,
		remediation: `Use one of ${transferVerbs.join(", ")} (aliases: ${Object.keys(VERB_ALIASES).join(", ")}), or run \`centrs transfer --help\`.`,
		context: { verb: raw },
	});
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
