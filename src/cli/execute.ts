import { fanoutExitCode } from "../core/fanout.ts";
import { asCentrsError, formatCentrsErrorText } from "../errors.ts";
import {
	buildExecuteErrorEnvelope,
	type ExecuteOutputFormat,
	type ExecuteRequest,
	executeEnvelope,
	executeOutputFormats,
	renderExecuteEnvelope,
} from "../execute.ts";
import {
	buildExecuteFanoutErrorEnvelope,
	executeFanout,
	renderExecuteFanoutEnvelope,
} from "../execute-fanout.ts";
import { describeCentrs } from "../index.ts";
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
	hasTargetSelector,
	isFanoutMode,
	type SelectionFlags,
	selectionCommandOptions,
} from "./selection.ts";

export const executeCommand: CliCommandMetadata = {
	name: "execute",
	usage:
		"centrs execute <target> <command> [flags] | centrs execute <target...> -- <command> [flags] | centrs execute --group <name> <command> [flags]",
	summary:
		"Run a RouterOS read or write command via native API, REST, or mac-telnet.",
	options: [
		{
			flag: "--via",
			valueName: "<native-api|rest-api|mac-telnet>",
			description:
				"Pin the protocol selector; no silent downgrade when set. A bare MAC target defaults to mac-telnet.",
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
			flag: "--ssh-key",
			valueName: "<path>",
			description:
				"`--via ssh`: explicit private-key path. Falls back to `CENTRS_SSH_KEY` / the `ssh-agent`.",
		},
		{
			flag: "--insecure",
			description:
				"Disable SSH host-key verification (`--via ssh`: accepts changed/impersonated keys, not just new) or accept a self-signed `api-ssl` TLS cert. Default verifies.",
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
			flag: "--timeout",
			valueName: "<duration>",
			description: "Per-request timeout (for REST, max 60s).",
		},
		{
			flag: "--validate[=false]",
			description:
				"Run RouterOS :parse and /console/inspect validation before execution (default true).",
		},
		{
			flag: "--yes",
			description:
				"Confirm write-shaped add/set/remove commands in non-interactive runs.",
		},
		{
			flag: "--max-results",
			valueName: "<bytes>",
			description: "Fail if the rendered envelope exceeds this byte budget.",
		},
		{
			flag: "--format",
			valueName: "<text|json|yaml>",
			description:
				"Output format for the CLI response. Defaults to text; use --json or --format json for the structured envelope.",
		},
		{
			flag: "--json",
			description: "Shortcut for `--format json`.",
		},
		{
			flag: "--verbose",
			description: "Include additional context in text output.",
		},
		{
			flag: "--",
			description:
				"End centrs option parsing: every following token is the literal RouterOS command, even flag-shaped ones (e.g. `-- /interface print where disabled=yes`).",
		},
	],
};

interface ExecuteCliArgs extends ExecuteRequest {
	help?: boolean;
	format?: ExecuteOutputFormat;
	selectionFlags?: SelectionFlags;
	targetPositionals?: readonly string[];
}

export function parseExecuteCliArgs(args: readonly string[]): ExecuteCliArgs {
	const parsed: ExecuteCliArgs = { command: "" };
	const selectionFlags = emptySelectionFlags();
	const positional: string[] = [];
	const afterDashDash: string[] = [];
	let endOfOptions = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) {
			continue;
		}
		// A bare `--` ends centrs option parsing: every later token is part of the
		// literal RouterOS command, even flag-shaped ones. Lets a command carry
		// tokens like `--` / `-foo` (or a value that looks like a flag) without the
		// parser claiming them. `--` itself is consumed, not added to the command.
		if (endOfOptions) {
			afterDashDash.push(arg);
			continue;
		}
		if (arg === "--") {
			endOfOptions = true;
			continue;
		}
		if (arg.startsWith("--validate=")) {
			parsed.validate = parseBooleanFlag(arg.slice("--validate=".length), arg);
			continue;
		}
		switch (arg) {
			case "--help":
			case "-h":
				parsed.help = true;
				break;
			case "--json":
				parsed.format = "json";
				break;
			case "--verbose":
				parsed.verbose = true;
				break;
			case "--yes":
				parsed.yes = true;
				break;
			case "--validate":
				parsed.validate = true;
				break;
			case "--no-validate":
				parsed.validate = false;
				break;
			case "--via":
				parsed.via = expectValue(args, ++index, arg);
				break;
			case "--host":
				parsed.host = expectValue(args, ++index, arg);
				break;
			case "--port":
				parsed.port = parseIntegerFlag(expectValue(args, ++index, arg), arg);
				break;
			case "--user":
			case "-u":
			case "--username":
				parsed.username = expectValue(args, ++index, arg);
				break;
			case "--password":
				parsed.password = expectValue(args, ++index, arg);
				break;
			case "--ssh-key":
				parsed.sshKey = expectValue(args, ++index, arg);
				break;
			case "--insecure":
				parsed.insecure = true;
				break;
			case "--cdb-file":
				parsed.cdbFile = expectValue(args, ++index, arg);
				break;
			case "--cdb-password":
				parsed.cdbPassword = expectValue(args, ++index, arg);
				break;
			case "--resolve":
				parsed.resolve = expectValue(args, ++index, arg);
				break;
			case "--timeout":
				parsed.timeout = expectValue(args, ++index, arg);
				break;
			case "--max-results":
				parsed.maxResultsBytes = parseIntegerFlag(
					expectValue(args, ++index, arg),
					arg,
				);
				break;
			case "--format": {
				const value = expectValue(args, ++index, arg);
				if (!executeOutputFormats.includes(value as ExecuteOutputFormat)) {
					throw new Error(
						`--format must be one of ${executeOutputFormats.join(", ")}; got ${value}.`,
					);
				}
				parsed.format = value as ExecuteOutputFormat;
				break;
			}
			default: {
				const consumed = consumeSelectionFlag(args, index, selectionFlags);
				if (consumed !== null) {
					index = consumed;
					break;
				}
				if (arg.startsWith("-")) {
					throw unknownFlagError("execute", arg, executeCommand.options);
				}
				positional.push(arg);
				break;
			}
		}
	}

	parsed.selectionFlags = selectionFlags;
	// Positional boundary for execute (see `docs/CONSTITUTION.md` → Target selection):
	//   - `--` present: targets are the positionals BEFORE it, command is AFTER it.
	//   - selector flag (or `--quickchr`) present, no `--`: every positional is the
	//     command (targets come from the flag).
	//   - otherwise (no `--`, no selector): legacy single-target split — first
	//     positional is the target, the rest is the command. Multiple positional
	//     targets therefore REQUIRE `--`.
	const hasSelector = hasTargetSelector(selectionFlags);
	if (endOfOptions) {
		parsed.targetPositionals = positional;
		parsed.command = afterDashDash.join(" ");
	} else if (hasSelector) {
		parsed.targetPositionals = [];
		parsed.command = positional.join(" ");
	} else {
		parsed.targetPositionals =
			positional[0] !== undefined ? [positional[0]] : [];
		parsed.command = positional.slice(1).join(" ");
	}
	parsed.targetInput = parsed.targetPositionals[0];
	parsed.stdinIsTty = process.stdin.isTTY;
	return parsed;
}

export async function runExecuteCli(args: readonly string[]): Promise<number> {
	let parsed: ExecuteCliArgs | undefined;
	try {
		parsed = parseExecuteCliArgs(args);
		if (parsed.help) {
			console.log(renderCommandHelp(describeCentrs(), executeCommand));
			return 0;
		}

		// Fan-out mode (a selector flag, or >1 positional target before `--`) has its
		// own envelope shape, single up-front write-confirm, and granular exit code.
		const selectionFlags = parsed.selectionFlags ?? emptySelectionFlags();
		const targetPositionals = parsed.targetPositionals ?? [];
		assertQuickchrExclusive(selectionFlags, targetPositionals.length);
		// Direct connection overrides conflict with `--quickchr` globally: reject
		// before fan-out dispatch so a repeated `--quickchr` gets one usage error
		// (exit 1), never per-member failures. The resolver re-checks for library
		// callers.
		if (selectionFlags.quickchr.length > 0) {
			assertNoQuickchrOverrideConflict(
				parsed,
				selectionFlags.quickchr[0] ?? "",
			);
		}
		if (isFanoutMode(selectionFlags, targetPositionals.length)) {
			return await runExecuteFanoutCli(
				parsed,
				selectionFlags,
				targetPositionals,
				args,
			);
		}
		// A single `--quickchr <name>` is single-target mode: the machine name is
		// the target (resolved from the live descriptor inside the resolver).
		if (selectionFlags.quickchr.length === 1) {
			parsed.quickchr = selectionFlags.quickchr[0];
		}

		// No positional at all: lead with the missing-target guidance (CDB picker /
		// discover) rather than the missing-command error — there is nothing to run
		// without a device. A lone positional is treated as the target, so the
		// "requires a command" path still fires for `execute <target>`.
		if (!parsed.targetInput && parsed.quickchr === undefined) {
			throw missingTargetError({
				command: "execute",
				summary: "`centrs execute` requires a <target> and a RouterOS command.",
				remediation:
					'Pass the router host/identity then the command, e.g. `centrs execute 192.0.2.10 "/system/resource/print"`.',
			});
		}

		const envelope = await executeEnvelope(parsed);
		const resolvedFormat =
			(
				envelope.meta.operation as {
					request?: { format?: ExecuteOutputFormat };
				}
			)?.request?.format ??
			parsed.format ??
			"text";
		const rendered = renderExecuteEnvelope(envelope, resolvedFormat, {
			verbose: parsed.verbose,
		});
		if (envelope.ok) {
			console.log(rendered);
			return 0;
		}
		console.error(rendered);
		return 1;
	} catch (error) {
		// Parse/usage errors land here too: surface them through the same typed
		// envelope as every other runner (no raw message, no exit code 2).
		const format = inferExecuteFormat(args, parsed);
		const tips = isMissingTargetError(error)
			? await buildTargetSelectionTips({
					cdbFile: parsed?.cdbFile ?? cdbFileFromArgs(args),
					env: Bun.env,
				})
			: [];
		if (format === "json" || format === "yaml") {
			const envelope = withTips(
				buildExecuteErrorEnvelope(parsed ?? { command: "" }, error),
				tips,
			);
			console.error(
				// codeql[js/clear-text-logging] No secret reaches this sink. The tainted 'password' flows in only as provenance (SettingSource={kind,key}), never the value — see CommonSettingsMeta.password in src/core/envelope.ts.
				renderExecuteEnvelope(envelope, format, {
					verbose: parsed?.verbose ?? false,
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
							"Use `centrs execute --help` to inspect the supported command shape and flags.",
					}),
					{ verbose: parsed?.verbose ?? args.includes("--verbose") },
				) + formatTipsText(tips),
			);
		}
		return 1;
	}
}

async function runExecuteFanoutCli(
	parsed: ExecuteCliArgs,
	selectionFlags: SelectionFlags,
	targetPositionals: readonly string[],
	args: readonly string[],
): Promise<number> {
	const selection = buildTargetSelection(selectionFlags, targetPositionals);
	const format = inferExecuteFormat(args, parsed);
	try {
		const envelope = await executeFanout(
			parsed,
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
			renderExecuteFanoutEnvelope(envelope, resolvedFormat, {
				verbose: parsed.verbose ?? false,
			}),
		);
		// Granular exit contract: 0 all-ok / 2 partial / 1 all-failed.
		return fanoutExitCode(envelope);
	} catch (error) {
		const envelope = buildExecuteFanoutErrorEnvelope(parsed, error);
		console.error(
			// codeql[js/clear-text-logging] Twin of #80/#81/#83/#84. No secret logged: buildExecuteFanoutErrorEnvelope meta is {target:{},via,settings:{}}; CodeQL taints the whole request object but the builder projects the password away.
			renderExecuteFanoutEnvelope(envelope, format, {
				verbose: parsed.verbose ?? false,
			}),
		);
		return 1;
	}
}

function inferExecuteFormat(
	args: readonly string[],
	parsed?: ExecuteCliArgs,
): ExecuteOutputFormat {
	if (parsed?.format) {
		return parsed.format;
	}
	if (args.includes("--json")) {
		return "json";
	}
	const index = args.indexOf("--format");
	if (index >= 0) {
		const value = args[index + 1];
		if (
			value !== undefined &&
			executeOutputFormats.includes(value as ExecuteOutputFormat)
		) {
			return value as ExecuteOutputFormat;
		}
	}
	return "text";
}

function parseIntegerFlag(value: string, flag: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed)) {
		throw new Error(`${flag} must be an integer; got ${value}.`);
	}
	return parsed;
}

function parseBooleanFlag(value: string, flag: string): boolean {
	if (["true", "1", "yes", "on"].includes(value.toLowerCase())) {
		return true;
	}
	if (["false", "0", "no", "off"].includes(value.toLowerCase())) {
		return false;
	}
	throw new Error(`${flag} must be true or false; got ${value}.`);
}
