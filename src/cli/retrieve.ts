/**
 * `centrs retrieve` CLI surface: command metadata, arg parsing, dispatch, and
 * error-to-envelope rendering. Behavior, flags, exit codes, and output are
 * unchanged from the former monolithic `cli.ts`.
 */

import {
	asCentrsError,
	CentrsError,
	formatCentrsErrorText,
} from "../errors.ts";
import {
	buildRetrieveErrorEnvelope,
	buildRetrieveFanoutErrorEnvelope,
	describeCentrs,
	fanoutExitCode,
	type RetrieveOutputFormat,
	type RetrieveRequest,
	renderRetrieveEnvelope,
	renderRetrieveFanoutEnvelope,
	retrieve,
	retrieveFanout,
	retrieveOutputFormats,
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

export const retrieveCommand: CliCommandMetadata = {
	name: "retrieve",
	usage:
		"centrs retrieve <target> <routeros-path> [flags] | centrs retrieve <target...> <routeros-path> [flags] | centrs retrieve --group <name> <routeros-path> [flags]",
	summary:
		"Read RouterOS values through the shared core using the selected protocol.",
	options: [
		{
			flag: "--via",
			valueName: "<protocol>",
			description:
				"Pin the protocol selector. Defaults to `rest-api` for retrieve.",
		},
		...selectionCommandOptions,
		{
			flag: "--host",
			valueName: "<host|url>",
			description: "Override the resolved host or base URL for the target.",
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
				"RouterOS username (aliases `--user`, `-u`). Falls back to `CENTRS_USERNAME`.",
		},
		{
			flag: "--password",
			valueName: "<secret>",
			description: "RouterOS password. Falls back to `CENTRS_PASSWORD`.",
		},
		{
			flag: "--timeout",
			valueName: "<ms|5s>",
			description:
				"Operation timeout. REST currently rejects values above 60s.",
		},
		{
			flag: "--attribute",
			valueName: "<name>",
			description: "Project one attribute. May be repeated.",
		},
		{
			flag: "--attributes",
			valueName: "<a,b>",
			description: "Project a comma-separated attribute list.",
		},
		{
			flag: "--all-attributes",
			description: "Request the RouterOS detail/all-attributes shape.",
		},
		{
			flag: "--list-attributes",
			description:
				"List inspect-derived attributes without running the data call.",
		},
		{
			flag: "--format",
			valueName: `<${retrieveOutputFormats.join("|")}>`,
			description:
				"Output format for the CLI response. Defaults to text; use --json or --format json for the structured envelope.",
		},
		{
			flag: "--json",
			description: "Shortcut for `--format json`.",
		},
		{
			flag: "--max-results",
			valueName: "<bytes>",
			description:
				"Fail instead of printing output larger than the given byte budget.",
		},
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
			flag: "--resolve",
			valueName: "<none|arp>",
			description:
				"Resolve a MAC-address target to an IP via the host ARP cache (default none).",
		},
		{
			flag: "--validate / --no-validate",
			description: "Enable or disable inspect-backed preflight validation.",
		},
		{
			flag: "--verbose",
			description: "Show resolved setting sources in text output.",
		},
	],
};

type RetrieveCliArgs = RetrieveRequest & {
	help?: boolean;
	selectionFlags?: SelectionFlags;
	targetPositionals?: readonly string[];
};

export async function runRetrieveCli(args: readonly string[]): Promise<number> {
	let request: RetrieveCliArgs | undefined;

	try {
		request = parseRetrieveCliArgs(args);
		if (request.help) {
			console.log(renderCommandHelp(describeCentrs(), retrieveCommand));
			return 0;
		}

		// Fan-out mode (a selector flag present, or >1 positional target) has its own
		// envelope shape and granular exit code; a plain single-target call keeps the
		// single-target envelope.
		const selectionFlags = request.selectionFlags ?? emptySelectionFlags();
		const targetPositionals = request.targetPositionals ?? [];
		if (isFanoutMode(selectionFlags, targetPositionals.length)) {
			return await runRetrieveFanoutCli(
				request,
				selectionFlags,
				targetPositionals,
				args,
			);
		}

		const envelope = await retrieve(request);
		const resolvedFormat =
			(
				envelope.meta.operation as {
					request?: { format?: RetrieveOutputFormat };
				}
			)?.request?.format ?? "text";
		console.log(
			renderRetrieveEnvelope(
				envelope as Parameters<typeof renderRetrieveEnvelope>[0],
				resolvedFormat,
				{ verbose: request.verbose },
			),
		);
		return 0;
	} catch (error) {
		const format = inferRequestedFormat(args, request);
		const tips = isMissingTargetError(error)
			? await buildTargetSelectionTips({
					cdbFile: request?.cdbFile ?? cdbFileFromArgs(args),
					env: Bun.env,
				})
			: [];
		if (format === "json" || format === "yaml") {
			// When parsing failed before a request existed, build the error envelope
			// from an empty request rather than reconstructing positionals from raw
			// args — a credential value (e.g. the token after `--password` /
			// `--cdb-password`) would otherwise be echoed as `meta.target.input`.
			const envelope = withTips(
				buildRetrieveErrorEnvelope(request ?? { path: "" }, error),
				tips,
			);
			console.error(
				// codeql[js/clear-text-logging] Twin of the established redacted-request dismissals: error builders carry only targetInput (host)+via (protocol); the raw password never reaches this render.
				renderRetrieveEnvelope(envelope, format, {
					verbose: request?.verbose ?? false,
				}),
			);
		} else {
			console.error(
				// codeql[js/clear-text-logging] Same false-positive pattern: password parsed from args never reaches error.message in the text-format catch path.
				formatCentrsErrorText(
					asCentrsError(error, {
						code: "input/invalid-command",
						summary: error instanceof Error ? error.message : String(error),
						remediation:
							"Use `centrs retrieve --help` to inspect the supported command shape and flags.",
					}),
					{
						verbose: request?.verbose ?? args.includes("--verbose"),
					},
				) + formatTipsText(tips),
			);
		}
		return 1;
	}
}

async function runRetrieveFanoutCli(
	request: RetrieveCliArgs,
	selectionFlags: SelectionFlags,
	targetPositionals: readonly string[],
	args: readonly string[],
): Promise<number> {
	const selection = buildTargetSelection(selectionFlags, targetPositionals);
	const format = inferRequestedFormat(args, request);
	try {
		const envelope = await retrieveFanout(
			request,
			selection,
			Bun.env,
			{},
			{
				concurrency: selectionFlags.concurrency,
				allowAdhoc: true,
			},
		);
		const resolvedFormat = envelope.meta.operation?.request.format ?? format;
		console.log(
			renderRetrieveFanoutEnvelope(envelope, resolvedFormat, {
				verbose: request.verbose ?? false,
			}),
		);
		// Granular exit contract: 0 all-ok / 2 partial / 1 all-failed.
		return fanoutExitCode(envelope);
	} catch (error) {
		const envelope = buildRetrieveFanoutErrorEnvelope(request, error);
		console.error(
			// codeql[js/clear-text-logging] Twin of #80/#81/#83. No secret logged: error builders carry only targetInput (host)+via (protocol); serializeCentrsError holds code/summary/remediation/context.
			renderRetrieveFanoutEnvelope(envelope, format, {
				verbose: request.verbose ?? false,
			}),
		);
		return 1;
	}
}

function parseRetrieveCliArgs(args: readonly string[]): RetrieveCliArgs {
	const request: RetrieveCliArgs = {
		path: "",
	};
	const selectionFlags = emptySelectionFlags();
	const positional: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) {
			continue;
		}
		switch (arg) {
			case "--help":
			case "-h":
				request.help = true;
				break;
			case "--via":
				request.via = expectValue(args, ++index, arg);
				break;
			case "--host":
				request.host = expectValue(args, ++index, arg);
				break;
			case "--port":
				request.port = Number.parseInt(expectValue(args, ++index, arg), 10);
				break;
			case "--user":
			case "-u":
			case "--username":
				request.username = expectValue(args, ++index, arg);
				break;
			case "--password":
				request.password = expectValue(args, ++index, arg);
				break;
			case "--timeout":
				request.timeout = expectValue(args, ++index, arg);
				break;
			case "--format":
				request.format = expectValue(args, ++index, arg);
				break;
			case "--json":
				request.format = "json";
				break;
			case "--attribute": {
				const value = expectValue(args, ++index, arg);
				request.attribute = [
					...(Array.isArray(request.attribute) ? request.attribute : []),
					value,
				];
				break;
			}
			case "--attributes":
				request.attributes = [
					...(Array.isArray(request.attributes) ? request.attributes : []),
					expectValue(args, ++index, arg),
				];
				break;
			case "--all-attributes":
				request.allAttributes = true;
				break;
			case "--list":
			case "--list-attributes":
				request.listAttributes = true;
				break;
			case "--filter":
				request.filter = expectValue(args, ++index, arg);
				break;
			case "--query":
				request.query = expectValue(args, ++index, arg);
				break;
			case "--max-results":
				request.maxResultsBytes = Number.parseInt(
					expectValue(args, ++index, arg),
					10,
				);
				break;
			case "--cdb-file":
				request.cdbFile = expectValue(args, ++index, arg);
				break;
			case "--cdb-password":
				request.cdbPassword = expectValue(args, ++index, arg);
				break;
			case "--resolve":
				request.resolve = expectValue(args, ++index, arg);
				break;
			case "--validate":
				request.validate = true;
				break;
			case "--no-validate":
				request.validate = false;
				break;
			case "--verbose":
				request.verbose = true;
				break;
			default: {
				const consumed = consumeSelectionFlag(args, index, selectionFlags);
				if (consumed !== null) {
					index = consumed;
					break;
				}
				if (arg.startsWith("-")) {
					throw unknownFlagError("retrieve", arg, retrieveCommand.options);
				}
				positional.push(arg);
				break;
			}
		}
	}

	request.selectionFlags = selectionFlags;

	if (request.help) {
		return request;
	}

	// api/retrieve positional boundary: the FINAL positional is the routeros-path;
	// every preceding positional is a fan-out target.
	const path = positional.at(-1) ?? "";
	const targetPositionals = positional.slice(0, -1);
	request.path = path;
	request.targetPositionals = targetPositionals;
	assertQuickchrExclusive(selectionFlags, targetPositionals.length);
	// Direct connection overrides conflict with `--quickchr` globally: reject at
	// parse time so a repeated `--quickchr` gets one usage error (exit 1), never
	// per-member failures. The resolver re-checks for library callers.
	if (selectionFlags.quickchr.length > 0) {
		assertNoQuickchrOverrideConflict(request, selectionFlags.quickchr[0] ?? "");
	}

	if (isFanoutMode(selectionFlags, targetPositionals.length)) {
		if (positional.length === 0 || path.length === 0) {
			throw new CentrsError({
				code: "input/invalid-command",
				summary:
					"`centrs retrieve` fan-out requires a <routeros-path> after the selectors/targets.",
				remediation:
					"Add the RouterOS menu path as the final positional, e.g. `centrs retrieve --group prod /system/resource`.",
				context: { command: "retrieve", missingPath: true },
			});
		}
		return request;
	}

	// A single `--quickchr <name>` is single-target mode: the machine name is the
	// target (resolved from the live descriptor inside the resolver); the lone
	// positional is the routeros-path.
	if (selectionFlags.quickchr.length === 1) {
		if (positional.length === 0 || path.length === 0) {
			throw new CentrsError({
				code: "input/invalid-command",
				summary: "`centrs retrieve --quickchr` requires a <routeros-path>.",
				remediation:
					"Add the RouterOS menu path as the final positional, e.g. `centrs retrieve --quickchr lab /system/resource`.",
				context: { command: "retrieve", missingPath: true },
			});
		}
		request.quickchr = selectionFlags.quickchr[0];
		return request;
	}

	if (positional.length === 0 || targetPositionals.length === 0) {
		throw missingTargetError({
			command: "retrieve",
			summary: "`centrs retrieve` requires a <target> and a <routeros-path>.",
			remediation:
				"Pass the router host/identity then the RouterOS path, e.g. `centrs retrieve 192.0.2.10 /system/resource`.",
		});
	}
	// Single-target: exactly one target positional (more would be fan-out mode).
	request.targetInput = targetPositionals[0];
	return request;
}

function inferRequestedFormat(
	args: readonly string[],
	request?: RetrieveRequest,
): RetrieveOutputFormat {
	if (request?.format) {
		return request.format as RetrieveOutputFormat;
	}
	if (args.includes("--json")) {
		return "json";
	}
	const formatIndex = args.indexOf("--format");
	if (formatIndex !== -1 && args[formatIndex + 1]) {
		return args[formatIndex + 1] as RetrieveOutputFormat;
	}
	const envFormat = process.env["CENTRS_FORMAT"];
	if (envFormat === "json" || envFormat === "yaml" || envFormat === "text") {
		return envFormat;
	}
	return "text";
}
