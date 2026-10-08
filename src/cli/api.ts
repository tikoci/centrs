import {
	type ApiOutputFormat,
	type ApiRequest,
	apiEnvelope,
	apiOutputFormats,
	apiStream,
	buildApiErrorEnvelope,
	normalizeApiEndpoint,
	removedListenError,
	renderApiEnvelope,
	renderApiStreamLine,
} from "../api.ts";
import {
	apiFanout,
	buildApiFanoutErrorEnvelope,
	renderApiFanoutEnvelope,
} from "../api-fanout.ts";
import { fanoutExitCode } from "../core/fanout.ts";
import {
	asCentrsError,
	CentrsError,
	formatCentrsErrorText,
} from "../errors.ts";
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
	isFanoutMode,
	type SelectionFlags,
	selectionCommandOptions,
} from "./selection.ts";

export const apiCommand: CliCommandMetadata = {
	name: "api",
	usage: "centrs api <router> <endpoint> [flags]",
	summary:
		"Structured RouterOS API passthrough (gh-api style) over REST or native API.",
	options: [
		{
			flag: "-X / --method",
			valueName: "<verb>",
			description:
				"HTTP method, default GET (case-insensitive). GET→print, PUT→add, PATCH→set, DELETE→remove, POST→run.",
		},
		{
			flag: "-f / --field",
			valueName: "<key=value>",
			description:
				"Body field, repeatable; assembled into the JSON body (verbatim string values).",
		},
		{
			flag: "-d / --data",
			valueName: "<json>",
			description: "Raw JSON request body. Conflicts with `-f` / `--input`.",
		},
		{
			flag: "--input",
			valueName: "<file|->",
			description: "Read the raw JSON body from a file or stdin (`-`).",
		},
		{
			flag: "--query / --filter",
			valueName: "<expr>",
			description:
				"RouterOS-side row filter, AND-combined, repeatable: name=value, name!=value, name>value, name<value, name.",
		},
		{
			flag: "--raw-query",
			valueName: "<word>",
			description:
				"Verbatim RouterOS query word (repeatable) for OR / absence / stack expressions.",
		},
		{
			flag: "--attribute / --proplist",
			valueName: "<a,b>",
			description: "Property projection → `.proplist`.",
		},
		{
			flag: "--raw",
			description:
				"Strip the envelope; emit bare RouterOS JSON. Defaults `--validate` to false (an explicit `--validate=true` still runs the gate); does not imply `--yes`.",
		},
		{
			flag: "--yes",
			description:
				"Confirm a mutating (non-read) request in non-interactive runs.",
		},
		{
			flag: "--stream",
			description:
				"Stream the command's native replies (`!re` rows and `!empty`) as NDJSON, then a summary envelope. Never changes the command: a GET streams one print. To follow changes, request `<menu>/listen`, which implies it.",
		},
		{
			flag: "--count",
			valueName: "<n>",
			description:
				"Stop a `--stream` after N `!re` rows; `!empty` replies do not count (not the device count= argument).",
		},
		{
			flag: "--duration",
			valueName: "<dur>",
			description:
				"Stop a `--stream` after this wall-clock window (e.g. `5s`).",
		},
		{
			flag: "--via",
			valueName: "<rest-api|native-api>",
			description: "Pin the transport; no silent downgrade. Default rest-api.",
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
			description: "RouterOS username. Falls back to `CENTRS_USERNAME`.",
		},
		{
			flag: "--password",
			valueName: "<secret>",
			description: "RouterOS password. Falls back to `CENTRS_PASSWORD`.",
		},
		{
			flag: "--insecure",
			description:
				"Accept a self-signed `api-ssl`/REST TLS cert. Default verifies.",
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
			flag: "--validate / --no-validate",
			description:
				"Run `/console/inspect` validation before the request (default true; `--validate=false` also accepted).",
		},
		{
			flag: "--format",
			valueName: "<json|yaml|text>",
			description:
				"Output format. Defaults to json for api; `CENTRS_FORMAT` overrides.",
		},
		{
			flag: "--json",
			description: "Shortcut for `--format json`.",
		},
		{
			flag: "--verbose",
			description: "Include additional context in text output.",
		},
	],
};

interface ApiCliArgs extends ApiRequest {
	help?: boolean;
	format?: ApiOutputFormat;
	/** Unresolved `--input` value (`-` or a path); read into `inputBody` in the runner. */
	inputPath?: string;
	/** Parsed target-selection flags (fan-out grammar). */
	selectionFlags?: SelectionFlags;
	/** Positionals before the endpoint — the fan-out target list. */
	targetPositionals?: string[];
}

export function parseApiCliArgs(args: readonly string[]): ApiCliArgs {
	const parsed: ApiCliArgs = { endpoint: "" };
	const positional: string[] = [];
	const positionalIndexes: number[] = [];
	const selectionFlags = emptySelectionFlags();
	let listenFlag = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) {
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
			case "--raw":
				parsed.raw = true;
				break;
			case "--stream":
				parsed.stream = true;
				break;
			case "--listen":
				listenFlag = true;
				break;
			case "--validate":
				parsed.validate = true;
				break;
			case "--no-validate":
				parsed.validate = false;
				break;
			case "-X":
			case "--method":
				parsed.method = expectValue(args, ++index, arg);
				break;
			case "-f":
			case "--field": {
				const kv = expectValue(args, ++index, arg);
				const eq = kv.indexOf("=");
				if (eq <= 0) {
					throw new Error(`${arg} expects key=value; got ${kv}`);
				}
				parsed.fields = {
					...(parsed.fields ?? {}),
					[kv.slice(0, eq)]: kv.slice(eq + 1),
				};
				break;
			}
			case "-d":
			case "--data":
				parsed.data = expectValue(args, ++index, arg);
				break;
			case "--input":
				parsed.inputPath = expectValue(args, ++index, arg);
				break;
			case "--query":
			case "--filter":
				parsed.query = [
					...(parsed.query ?? []),
					expectValue(args, ++index, arg),
				];
				break;
			case "--raw-query":
				parsed.rawQuery = [
					...(parsed.rawQuery ?? []),
					expectValue(args, ++index, arg),
				];
				break;
			case "--attribute":
			case "--proplist":
				parsed.proplist = [
					...(parsed.proplist ?? []),
					expectValue(args, ++index, arg),
				];
				break;
			case "--duration":
				parsed.duration = expectValue(args, ++index, arg);
				break;
			case "--count":
				parsed.count = parseIntegerFlag(expectValue(args, ++index, arg), arg);
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
			case "--format": {
				const value = expectValue(args, ++index, arg);
				if (!apiOutputFormats.includes(value as ApiOutputFormat)) {
					throw new Error(
						`--format must be one of ${apiOutputFormats.join(", ")}; got ${value}.`,
					);
				}
				parsed.format = value as ApiOutputFormat;
				break;
			}
			default: {
				const consumed = consumeSelectionFlag(args, index, selectionFlags);
				if (consumed !== null) {
					index = consumed;
					break;
				}
				if (arg.startsWith("-")) {
					throw unknownFlagError("api", arg, apiCommand.options);
				}
				positional.push(arg);
				positionalIndexes.push(index);
				break;
			}
		}
	}
	if (listenFlag) {
		throw removedListenError(
			positional.at(-1) ?? "",
			"cli",
			listenReplacement(args, positionalIndexes.at(-1), parsed.method),
		);
	}

	// api/retrieve positional boundary: the FINAL positional is the endpoint; every
	// preceding positional is a fan-out target.
	parsed.endpoint = positional.at(-1) ?? "";
	parsed.targetPositionals = positional.slice(0, -1);
	parsed.selectionFlags = selectionFlags;
	parsed.targetInput = parsed.targetPositionals[0];
	parsed.stdinIsTty = process.stdin.isTTY;
	return parsed;
}

/**
 * The exact command `--listen` meant (#402): a GET becomes the menu's
 * `/listen` endpoint, anything else keeps its command and streams. Secrets in
 * the original arguments are not echoed back: auth flags, a `-d` body (any
 * JSON field may be one), and `-f` values whose key names a secret.
 */
function listenReplacement(
	args: readonly string[],
	endpointIndex: number | undefined,
	method: string | undefined,
): string {
	const get = (method ?? "GET").toUpperCase() === "GET";
	const words: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] as string;
		if (arg === "--listen") {
			if (!get) words.push("--stream");
			continue;
		}
		if (index === endpointIndex && get && !normalizeApiEndpoint(arg).listen) {
			words.push(shellWord(`${arg.replace(/\/+$/, "")}/listen`));
			continue;
		}
		words.push(shellWord(arg));
		const value = args[index + 1];
		if (value === undefined) continue;
		if (arg === "--password" || arg === "--cdb-password") {
			words.push("<password>");
			index += 1;
		} else if (arg === "-d" || arg === "--data") {
			words.push("<json>");
			index += 1;
		} else if (
			(arg === "-f" || arg === "--field") &&
			SECRET_FIELD.test(value.split("=", 1)[0] ?? "")
		) {
			// A placeholder, like `<password>` and `<router>`: left unquoted.
			words.push(`${shellWord(value.split("=", 1)[0] ?? "")}=<secret>`);
			index += 1;
		}
	}
	return `centrs api ${words.join(" ")}`;
}

/** Field names whose values are credentials (RouterOS: password, secret, psk, private-key, …). */
const SECRET_FIELD = /pass|secret|psk|key|token|auth/i;

function shellWord(word: string): string {
	return /^[\w@%+=:,./*-]+$/.test(word)
		? word
		: `'${word.replaceAll("'", "'\\''")}'`;
}

export async function runApiCli(args: readonly string[]): Promise<number> {
	let parsed: ApiCliArgs | undefined;
	try {
		parsed = parseApiCliArgs(args);
		if (parsed.help) {
			console.log(renderCommandHelp(describeCentrs(), apiCommand));
			return 0;
		}
		// Selection-shape usage errors fire before `--input` is read: a bad
		// `--quickchr` combination must not block on stdin (`--input -`) or
		// degrade into per-member fan-out failures. The resolver re-checks the
		// override conflict for library callers.
		const selectionFlags = parsed.selectionFlags ?? emptySelectionFlags();
		const targetPositionals = parsed.targetPositionals ?? [];
		assertQuickchrExclusive(selectionFlags, targetPositionals.length);
		if (selectionFlags.quickchr.length > 0) {
			assertNoQuickchrOverrideConflict(
				parsed,
				selectionFlags.quickchr[0] ?? "",
			);
		}

		// Resolve `--input` (file / stdin) before handing the body to the orchestrator.
		if (parsed.inputPath !== undefined) {
			const inputPath = parsed.inputPath;
			try {
				parsed.inputBody =
					inputPath === "-"
						? await Bun.stdin.text()
						: await Bun.file(inputPath).text();
			} catch (error) {
				throw new CentrsError({
					code: "input/local-file-not-found",
					summary: `Cannot read the --input body from ${inputPath === "-" ? "stdin" : inputPath}.`,
					remediation:
						"Check the path and read permissions, or pipe the JSON body into `--input -`.",
					context: { input: inputPath },
					cause: error,
				});
			}
		}

		// Fan-out mode (selector flag present, or >1 positional target) has its own
		// envelope shape, guards, and granular exit code. It runs first and rejects
		// `--stream` + fan-out itself (single-session is exclusive).
		if (isFanoutMode(selectionFlags, targetPositionals.length)) {
			return await runApiFanoutCli(
				parsed,
				selectionFlags,
				targetPositionals,
				args,
			);
		}
		// A single `--quickchr <name>` is single-target mode (streaming included):
		// the machine name is the target, resolved from the live descriptor.
		if (selectionFlags.quickchr.length === 1) {
			parsed.quickchr = selectionFlags.quickchr[0];
		}

		// A stream (`--stream`, or a `/listen` endpoint) consumes
		// the NDJSON envelope stream instead of a single one-shot envelope.
		const streaming =
			parsed.stream === true ||
			(parsed.endpoint.length > 0 &&
				normalizeApiEndpoint(parsed.endpoint).listen);
		if (streaming) {
			return await runApiStreamCli(parsed, args);
		}

		if (!parsed.targetInput && parsed.quickchr === undefined) {
			throw missingTargetError({
				command: "api",
				summary: "`centrs api` requires a <router> and an <endpoint>.",
				remediation:
					"Pass the router host/identity then the endpoint, e.g. `centrs api 192.0.2.10 ip/address`.",
			});
		}

		const envelope = await apiEnvelope(parsed);
		const resolvedFormat =
			(
				envelope.meta.operation as {
					request?: { format?: ApiOutputFormat };
				}
			)?.request?.format ??
			parsed.format ??
			"json";
		const rendered = renderApiEnvelope(envelope, resolvedFormat, {
			raw: parsed.raw,
			verbose: parsed.verbose,
		});
		if (envelope.ok) {
			console.log(rendered);
			return 0;
		}
		console.error(rendered);
		return 1;
	} catch (error) {
		const format = inferApiFormat(args, parsed);
		const tips = isMissingTargetError(error)
			? await buildTargetSelectionTips({
					cdbFile: parsed?.cdbFile ?? cdbFileFromArgs(args),
					env: Bun.env,
				})
			: [];
		if (parsed?.raw) {
			// `--raw` defines a compact JSON error contract (code/message → stderr);
			// keep that machine shape on the pre-envelope failure path too (e.g. a
			// missing `--input` file) instead of falling back to plain text.
			const envelope = withTips(buildApiErrorEnvelope(parsed, error), tips);
			console.error(
				// codeql[js/clear-text-logging] CLI catch-block error render. No secret logged: envelope stores only passwordProvided (boolean) and target.input (router, not the password).
				renderApiEnvelope(envelope, format, {
					raw: true,
					verbose: parsed.verbose ?? false,
				}),
			);
		} else if (format !== "text") {
			const envelope = withTips(
				buildApiErrorEnvelope(parsed ?? { endpoint: "" }, error),
				tips,
			);
			console.error(
				// codeql[js/clear-text-logging] CLI catch-block error render. No secret logged: envelope stores only passwordProvided (boolean) and target.input (router, not the password).
				renderApiEnvelope(envelope, format, {
					verbose: parsed?.verbose ?? false,
				}),
			);
		} else {
			console.error(
				// codeql[js/clear-text-logging] CLI catch-block error render. No secret logged: envelope stores only passwordProvided (boolean) and target.input (router, not the password).
				formatCentrsErrorText(
					asCentrsError(error, {
						code: "input/invalid-command",
						summary: error instanceof Error ? error.message : String(error),
						remediation:
							"Use `centrs api --help` to inspect the supported endpoint shape and flags.",
					}),
					{ verbose: parsed?.verbose ?? args.includes("--verbose") },
				) + formatTipsText(tips),
			);
		}
		return 1;
	}
}

async function runApiFanoutCli(
	parsed: ApiCliArgs,
	selectionFlags: SelectionFlags,
	targetPositionals: readonly string[],
	args: readonly string[],
): Promise<number> {
	const selection = buildTargetSelection(selectionFlags, targetPositionals);
	const format = inferApiFormat(args, parsed);
	try {
		// `--raw` strips the envelope; incompatible with per-target envelopes.
		if (parsed.raw) {
			throw new CentrsError({
				code: "usage/conflicting-flags",
				summary:
					"`--raw` cannot combine with a multi-target selection; fan-out needs per-target envelopes.",
				remediation:
					"Drop `--raw` to fan out, or target a single router for the bare RouterOS body.",
				context: { flags: ["--raw", "fanout"] },
			});
		}
		// `--stream` is single-session.
		const listenRequested =
			(parsed.stream ?? false) || endpointInfersListen(parsed.endpoint);
		if (listenRequested) {
			throw new CentrsError({
				code: "usage/fanout-not-supported",
				summary:
					"`api --stream` is single-session and cannot fan out across multiple targets.",
				remediation:
					"Follow a stream against a single router (no `--group`/`--where`/`--all`/`--default`/multiple positionals).",
				context: { capability: "listen" },
			});
		}
		const envelope = await apiFanout(
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
			renderApiFanoutEnvelope(envelope, resolvedFormat, {
				verbose: parsed.verbose ?? false,
			}),
		);
		return fanoutExitCode(envelope);
	} catch (error) {
		const envelope = buildApiFanoutErrorEnvelope(
			parsed,
			selection,
			error,
			Bun.env,
		);
		console.error(
			// codeql[js/clear-text-logging] Fan-out CLI catch-block error render — twin of #80/#81. No secret logged: the error envelope's request summary, selection and target carry no auth fields; serializeCentrsError holds only code/summary/remediation/context.
			renderApiFanoutEnvelope(envelope, format, {
				verbose: parsed.verbose ?? false,
			}),
		);
		return 1;
	}
}

/** Whether an endpoint's trailing `listen` segment implies `--stream` (without throwing). */
function endpointInfersListen(endpoint: string): boolean {
	try {
		return normalizeApiEndpoint(endpoint).listen;
	} catch {
		return false;
	}
}

/**
 * Emit all structured stream outcomes on stdout. Any failure sets exit 1,
 * including a terminal error after successful rows. Raw mode retains its
 * stderr error contract; Ctrl-C requests bounded cancellation.
 */
async function runApiStreamCli(
	parsed: ApiCliArgs,
	args: readonly string[],
): Promise<number> {
	const format = inferApiFormat(args, parsed);
	const controller = new AbortController();
	const onSigint = (): void => controller.abort();
	process.on("SIGINT", onSigint);
	let exitCode = 0;
	try {
		for await (const envelope of apiStream(
			parsed,
			Bun.env,
			controller.signal,
		)) {
			const line = renderApiStreamLine(envelope, format, {
				raw: parsed.raw,
				verbose: parsed.verbose,
			});
			if (envelope.ok || !parsed.raw) {
				console.log(line);
			} else {
				console.error(line);
			}
			if (!envelope.ok) exitCode = 1;
		}
	} finally {
		process.off("SIGINT", onSigint);
	}
	return exitCode;
}

function inferApiFormat(
	args: readonly string[],
	parsed?: ApiCliArgs,
): ApiOutputFormat {
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
			apiOutputFormats.includes(value as ApiOutputFormat)
		) {
			return value as ApiOutputFormat;
		}
	}
	// Honor CENTRS_FORMAT on the parse-time error path so the catch render matches
	// buildApiErrorEnvelope's env-aware `meta.operation.request.format`. CLI flags
	// above still win.
	const envFormat = Bun.env["CENTRS_FORMAT"];
	if (
		envFormat !== undefined &&
		apiOutputFormats.includes(envFormat as ApiOutputFormat)
	) {
		return envFormat as ApiOutputFormat;
	}
	// api is machine-first: default to the structured json envelope, not text.
	return "json";
}

function parseIntegerFlag(value: string, flag: string): number {
	// Validate the whole token: `Number.parseInt` would silently accept prefixes
	// like `8728ms` / `10abc` and send a request to the wrong port/count.
	if (!/^-?\d+$/.test(value.trim())) {
		throw new Error(`${flag} must be an integer; got ${value}.`);
	}
	return Number.parseInt(value, 10);
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
