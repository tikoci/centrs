/**
 * `centrs retrieve` CLI surface: command metadata, arg parsing, dispatch, and
 * error-to-envelope rendering. Behavior, flags, exit codes, and output are
 * unchanged from the former monolithic `cli.ts`.
 */

import { asCentrsError, formatCentrsErrorText } from "../errors.ts";
import {
	buildRetrieveErrorEnvelope,
	buildRetrieveFanoutErrorEnvelope,
	describeCentrs,
	type RetrieveOutputFormat,
	type RetrieveRequest,
	renderRetrieveEnvelope,
	renderRetrieveFanoutEnvelope,
	retrieve,
	retrieveGroup,
	retrieveOutputFormats,
} from "../index.ts";
import {
	type CliCommandMetadata,
	expectValue,
	renderCommandHelp,
} from "./common.ts";
import {
	buildTargetSelectionTips,
	cdbFileFromArgs,
	formatTipsText,
	isMissingTargetError,
	missingTargetError,
	withTips,
} from "./missing-target.ts";

export const retrieveCommand: CliCommandMetadata = {
	name: "retrieve",
	usage:
		"centrs retrieve <target> <routeros-path> [flags] | centrs retrieve --group <name> <routeros-path> [flags]",
	summary:
		"Read RouterOS values through the shared core using the selected protocol.",
	options: [
		{
			flag: "--via",
			valueName: "<protocol>",
			description:
				"Pin the protocol selector. Defaults to `rest-api` for retrieve.",
		},
		{
			flag: "--group",
			valueName: "<name>",
			description:
				"Fan out over every CDB record in the group. Replaces the <target> positional.",
		},
		{
			flag: "--concurrency",
			valueName: "<n>",
			description:
				"Bounded worker-pool size for `--group` fanout (REST 8, native-api 4 by default).",
		},
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

export async function runRetrieveCli(args: readonly string[]): Promise<number> {
	let request: RetrieveRequest | undefined;

	try {
		request = parseRetrieveCliArgs(args);
		if ((request as { help?: boolean }).help) {
			console.log(renderCommandHelp(describeCentrs(), retrieveCommand));
			return 0;
		}

		const envelope = request.group
			? await retrieveGroup(request)
			: await retrieve(request);
		const resolvedFormat =
			(
				envelope.meta.operation as {
					request?: { format?: RetrieveOutputFormat };
				}
			)?.request?.format ?? "text";
		const output = request.group
			? renderRetrieveFanoutEnvelope(
					envelope as Parameters<typeof renderRetrieveFanoutEnvelope>[0],
					resolvedFormat,
					{ verbose: request.verbose },
				)
			: renderRetrieveEnvelope(
					envelope as Parameters<typeof renderRetrieveEnvelope>[0],
					resolvedFormat,
					{ verbose: request.verbose },
				);
		console.log(output);
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
			if (request?.group) {
				const envelope = buildRetrieveFanoutErrorEnvelope(request, error);
				console.error(
					renderRetrieveFanoutEnvelope(envelope, format, {
						verbose: request?.verbose ?? false,
					}),
				);
			} else {
				// When parsing failed before a request existed, build the error
				// envelope from an empty request rather than reconstructing positionals
				// from raw args — a credential value (e.g. the token after
				// `--password` / `--cdb-password`) would otherwise be echoed as
				// `meta.target.input`.
				const envelope = withTips(
					buildRetrieveErrorEnvelope(request ?? { path: "" }, error),
					tips,
				);
				console.error(
					renderRetrieveEnvelope(envelope, format, {
						verbose: request?.verbose ?? false,
					}),
				);
			}
		} else {
			console.error(
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

function parseRetrieveCliArgs(args: readonly string[]): RetrieveRequest & {
	help?: boolean;
} {
	const request: RetrieveRequest & { help?: boolean } = {
		path: "",
	};
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
			case "--group":
				request.group = expectValue(args, ++index, arg);
				break;
			case "--concurrency":
				request.concurrency = Number.parseInt(
					expectValue(args, ++index, arg),
					10,
				);
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
			default:
				if (arg.startsWith("-")) {
					throw new Error(`Unknown retrieve flag: ${arg}`);
				}
				positional.push(arg);
				break;
		}
	}

	if (request.help) {
		return request;
	}

	if (request.group !== undefined) {
		if (positional.length < 1) {
			throw new Error(
				"`centrs retrieve --group <name>` requires a <routeros-path>.",
			);
		}
		if (positional.length > 1) {
			throw new Error(
				"`centrs retrieve --group <name>` takes only a <routeros-path>; the group replaces the <target> positional.",
			);
		}
		request.path = positional[0] ?? "";
		return request;
	}

	if (positional.length === 0) {
		throw missingTargetError({
			command: "retrieve",
			summary: "`centrs retrieve` requires a <target> and a <routeros-path>.",
			remediation:
				"Pass the router host/identity then the RouterOS path, e.g. `centrs retrieve 192.0.2.10 /system/resource`.",
		});
	}
	if (positional.length < 2) {
		throw new Error(
			"`centrs retrieve` requires a <routeros-path> after the <target>.",
		);
	}

	request.targetInput = positional[0];
	request.path = positional[1] ?? "";
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
