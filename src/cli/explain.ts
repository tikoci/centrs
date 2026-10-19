/**
 * `centrs explain` CLI surface: command metadata, arg parsing, dispatch, and
 * envelope rendering for offline analysis and read-only live evidence (#491).
 *
 * ## The positional grammar is conditional, and that is deliberate
 *
 * `explain '<input>'` is offline; `explain <router> '<input>'` is live. One
 * positional means the input, two mean router-then-input — target-first like
 * every other router-taking command, so adding a router never reinterprets a
 * previously valid offline invocation (`commands/explain/README.md` → Surface).
 * No other centrs command has an optional target where arity changes meaning,
 * which is why the split is done here rather than in a shared helper.
 *
 * `--file` REPLACES the input positional, so with it every positional is a
 * target. **Ambient stdin does not**: it is read only when no positional could
 * be the input, a positional always wins, and a redirected fd 0 that went
 * unread is reported as a `usage/stdin-ignored` warning rather than dropped
 * quietly. `--file -` names stdin explicitly and works in both forms. The
 * reasoning — and the measurement behind it — is on {@link readInput}.
 *
 * ## What this surface refuses to do
 *
 * - **Live probes never execute the input.** The shared live module attaches
 *   device evidence, `--schema` and `--complete` to the offline result.
 * - **Fan-out is rejected** (`usage/fanout-not-supported`, the `terminal`
 *   pattern): `explain` takes at most one router.
 * - **`--complete` / `--schema` enumerate nothing offline.** They are accepted,
 *   they emit the live-target tip, and they add no fabricated `data.schema` —
 *   offline consults no schema snapshot, by ratified decision.
 */

import { fstatSync } from "node:fs";
import type { Warning } from "../core/envelope.ts";
import { CentrsError, formatCentrsErrorText } from "../errors.ts";
import {
	buildExplainErrorEnvelope,
	buildExplainFacetTip,
	type ExplainFailOn,
	type ExplainOutputFormat,
	explainEnvelope,
	explainExitCode,
	explainFailOnLevels,
	explainOutputFormats,
	renderExplainEnvelope,
	resolveExplainFormat,
} from "../explain.ts";
import {
	assertExplainTarget,
	type ExplainLiveRequest,
	explainLiveEnvelope,
} from "../explain-live.ts";
import { resolveExplainCursor } from "../explain-live-facets.ts";
import { describeCentrs } from "../index.ts";
import { loadEnvFileDefaults } from "../resolver/config-file.ts";
import { redactTargetInput } from "../resolver/index.ts";
import type { ResolvedSetting } from "../resolver/settings.ts";
import { apiCommand } from "./api.ts";
import {
	type CliCommandMetadata,
	expectValue,
	rejectFlagsAfterSeparator,
	renderCommandHelp,
	unknownFlagError,
} from "./common.ts";
import { selectionFlagTokens } from "./selection.ts";

export const explainCliCommand: CliCommandMetadata = {
	name: "explain",
	usage: "centrs explain [<router>] '<input>' [flags]",
	summary:
		"Analyze RouterOS input offline or add read-only device evidence from one router.",
	options: [
		...apiCommand.options.filter((o) =>
			[
				"--via",
				"--host",
				"--port",
				"--username / --user / -u",
				"--password",
				"--timeout",
				"--insecure",
				"--cdb-file",
				"--cdb-password",
				"--resolve",
			].includes(o.flag),
		),
		{ flag: "-p", valueName: "<secret>", description: "Alias for --password." },
		{
			flag: "--quickchr",
			valueName: "<name>",
			description: "Resolve one running quickchr VM by name.",
		},
		{
			flag: "--file",
			valueName: "<path>",
			description:
				"Read the input from a file instead of the positional (`-` reads stdin). Piped stdin is used automatically when no input positional is given.",
		},
		{
			flag: "--fail-on",
			valueName: `<${explainFailOnLevels.join("|")}>`,
			description:
				"Exit 2 when the verdict reaches this severity. Default `error`; an ambiguous or unknown statement is a warning, never an error.",
		},
		{
			flag: "--complete",
			description:
				"Candidates at the cursor: menus and verbs, argument names, or values. Live evidence — offline emits a tip and enumerates nothing.",
		},
		{
			flag: "--schema",
			description:
				"Describe the path at the cursor: a menu's verbs and submenus, a command's arguments, `print`'s proplist. Live evidence — offline emits a tip and enumerates nothing.",
		},
		{
			flag: "--cursor",
			valueName: "<byte>",
			description:
				"UTF-8 byte offset for --complete/--schema. Default: the end of the input.",
		},
		{
			flag: "--full",
			description:
				"Lift --complete/--schema sizing to its safety ceiling (1024 names, 128 expansion probes).",
		},
		{
			flag: "--curl",
			description:
				"Render a ready-to-edit REST curl for statements covered by a runtime-tested mapping rule.",
		},
		{
			flag: "--tokens",
			description:
				"Emit the total, gapless token partition behind `data.tokens[]` (every byte not claimed by an analyzer is `unclassified`).",
		},
		{
			flag: "--format",
			valueName: `<${explainOutputFormats.join("|")}>`,
			description: "Output format for the CLI response.",
		},
		{ flag: "--json", description: "Shortcut for `--format json`." },
		{ flag: "--yaml", description: "Shortcut for `--format yaml`." },
		{ flag: "--verbose", description: "Verbose error output." },
	],
};

export interface ExplainCliArgs extends Omit<ExplainLiveRequest, "input"> {
	help?: boolean;
	positionals: string[];
	filePath?: string;
	failOn: ExplainFailOn;
	facets: string[];
	cursor?: number;
	full?: boolean;
	curl?: boolean;
	tokens?: boolean;
	format?: ExplainOutputFormat;
	verbose?: boolean;
	/** First explicitly supplied connection flag, for the missing-target refusal. */
	connectionFlag?: string;
}

export function parseExplainCliArgs(args: readonly string[]): ExplainCliArgs {
	rejectFlagsAfterSeparator("explain", args, explainCliCommand.options);
	const parsed: ExplainCliArgs = {
		positionals: [],
		failOn: "error",
		facets: [],
	};
	let literal = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (literal) {
			parsed.positionals.push(arg);
			continue;
		}
		if (LIVE_CONNECTION_FLAGS.has(arg)) parsed.connectionFlag ??= arg;
		switch (arg) {
			case "--":
				// Everything after `--` is input, however command-shaped it looks:
				// RouterOS input legitimately starts with `-` (`--` is also a comment
				// in some spellings) and must never be read as a centrs flag.
				literal = true;
				break;
			case "--help":
			case "-h":
				parsed.help = true;
				break;
			case "--via":
				parsed.via = expectValue(args, ++index, arg);
				break;
			case "--host":
				parsed.host = expectValue(args, ++index, arg);
				break;
			case "--quickchr":
				if (parsed.quickchr !== undefined)
					throw fanoutNotSupportedError({ flag: arg });
				parsed.quickchr = expectValue(args, ++index, arg);
				break;
			case "--timeout":
				parsed.timeout = expectValue(args, ++index, arg);
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
			case "--password":
				parsed.password = expectValue(args, ++index, arg);
				break;
			case "-p":
				parsed.password = expectValue(args, ++index, arg);
				break;
			case "-u":
			case "--user":
			case "--username":
				parsed.username = expectValue(args, ++index, arg);
				break;
			case "--insecure":
				parsed.insecure = true;
				break;
			case "--port": {
				const value = expectValue(args, ++index, arg);
				if (!/^\d+$/.test(value))
					throw new CentrsError({
						code: "input/invalid-command",
						summary: "Port must be an integer.",
						remediation: "Pass a TCP port between 1 and 65535.",
					});
				parsed.port = Number(value);
				break;
			}
			case "--file":
				parsed.filePath = expectValue(args, ++index, arg);
				break;
			case "--fail-on": {
				const value = expectValue(args, ++index, arg);
				if (!(explainFailOnLevels as readonly string[]).includes(value)) {
					throw new CentrsError({
						code: "input/invalid-command",
						summary: `--fail-on must be one of ${explainFailOnLevels.join(", ")}; got ${value}.`,
						remediation:
							"Pass `--fail-on error` (default), `--fail-on warning`, or `--fail-on never`.",
						context: { failOn: value },
					});
				}
				parsed.failOn = value as ExplainFailOn;
				break;
			}
			case "--complete":
				parsed.facets.push("--complete");
				break;
			case "--schema":
				parsed.facets.push("--schema");
				break;
			case "--cursor": {
				const value = expectValue(args, ++index, arg);
				if (!/^\d+$/.test(value))
					throw new CentrsError({
						code: "usage/invalid-cursor",
						summary: `--cursor must be a non-negative byte offset; got ${value}.`,
						remediation:
							"Pass a UTF-8 byte offset into the input, or omit --cursor to complete at the end.",
						context: { cursor: value },
					});
				parsed.cursor = Number(value);
				break;
			}
			case "--full":
				parsed.full = true;
				break;
			case "--curl":
				parsed.curl = true;
				break;
			case "--tokens":
				parsed.tokens = true;
				break;
			case "--format": {
				const value = expectValue(args, ++index, arg);
				if (!(explainOutputFormats as readonly string[]).includes(value)) {
					throw new CentrsError({
						code: "settings/invalid-format",
						summary: `--format must be one of ${explainOutputFormats.join(", ")}; got ${value}.`,
						remediation: `Choose one of ${explainOutputFormats.join(", ")}.`,
						context: { format: value },
					});
				}
				parsed.format = value as ExplainOutputFormat;
				break;
			}
			case "--json":
				parsed.format = "json";
				break;
			case "--yaml":
				parsed.format = "yaml";
				break;
			case "--verbose":
				parsed.verbose = true;
				break;
			default:
				// `explain` analyzes one input against at most one router, so a
				// multi-target selection has nothing to mean here (the `terminal`
				// pattern, shared catalog code).
				if ((selectionFlagTokens as readonly string[]).includes(arg)) {
					throw fanoutNotSupportedError({ flag: arg });
				}
				if (arg.startsWith("-")) {
					throw unknownFlagError("explain", arg, explainCliCommand.options);
				}
				parsed.positionals.push(arg);
				break;
		}
	}
	return parsed;
}

/**
 * The one fan-out refusal, for both ways of asking for one.
 *
 * A selection flag and more than one positional target are the SAME fact under
 * the constitution (`isFanoutMode` keys on either), so they get the same code.
 * Giving the positional form its own `input/invalid-command` would have made a
 * documented contract — the module header and the command README both promise
 * `usage/fanout-not-supported` — false for half its cases.
 */
function fanoutNotSupportedError(context: {
	flag?: string;
	targets?: readonly string[];
}): CentrsError {
	return new CentrsError({
		code: "usage/fanout-not-supported",
		summary:
			"`centrs explain` analyzes one input against at most one router and cannot fan out across a multi-target selection.",
		remediation:
			"Pass one input and at most one router, quoting the input so the shell keeps it as one argument (`centrs explain '/ip/route print'`); use `execute` / `api` for multi-target commands.",
		context: {
			capability: "explain",
			...(context.flag === undefined ? {} : { flag: context.flag }),
			...(context.targets === undefined
				? {}
				: { targets: context.targets.map(redactTargetInput) }),
		},
	});
}

/**
 * Is fd 0 attached to something that could be carrying input?
 *
 * A **stat**, never a read. Stated as an exclusion, because the carriers are
 * open-ended while the non-carriers are two: a TTY (a human who would be left
 * waiting on EOF) and the ambient `/dev/null` that CI runners and `< /dev/null`
 * scripts attach. Both are character devices, and so is `/dev/zero`, the one
 * shape whose read never ends. Everything else — a shell pipe, a redirected
 * file, the socket `Bun.spawn` hands a child — may be handing us bytes.
 *
 * An `isTTY`-only check is not enough: it reads `< /dev/null` as "the user
 * piped input", which would break every non-interactive invocation.
 */
function stdinMayCarryInput(): boolean {
	try {
		const stat = fstatSync(0);
		return !stat.isCharacterDevice() && !stat.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Split the positionals into targets and the one that may be the input.
 *
 * Pure and cheap: fan-out and unsupported facets are refused before any file
 * or stdin is read. Supported live calls read the input before connecting.
 *
 * `--file` replaces the input positional, so with it every positional is a
 * target. Otherwise the LAST positional is the input and everything before it is
 * a target; splitting from the end is what keeps the two forms unambiguous.
 *
 * PRESENCE, never truthiness: `centrs explain ""` gave an empty positional that
 * a `&&` spread dropped, so the same argv fell through to ambient stdin and
 * analyzed whatever was piped in. An explicit empty argument is a mistake the
 * user made, not an absent argument, and "a positional always wins" has to hold
 * for it too — otherwise identical argv means different things depending on the
 * shape of fd 0.
 */
function splitPositionals(parsed: ExplainCliArgs): {
	targets: readonly string[];
	inputPositional?: string;
} {
	if (parsed.filePath !== undefined) return { targets: parsed.positionals };
	const positionals = [...parsed.positionals];
	const inputPositional = positionals.pop();
	return inputPositional === undefined
		? { targets: positionals }
		: { targets: positionals, inputPositional };
}

/**
 * Read the input text after the invocation shape has been checked.
 *
 * ## Ambient stdin is read ONLY when nothing else could be the input
 *
 * Measured, not assumed: consuming fd 0 whenever it looked like a carrier made
 * `bun test` read the invoking shell's stdin, feed those bytes to the analyzer,
 * and fail 21 unrelated tests — once, because the read DRAINED the fd and the
 * next run passed. `runCli` is called in-process by tests, so any ambient read
 * on a path a test can reach is a landmine that fires on whoever's terminal has
 * bytes queued. Zero positionals is the one shape no in-process caller uses.
 *
 * ## The collision is reported, not resolved
 *
 * `… | centrs explain '<input>'` cannot silently drop the pipe — but proving the
 * pipe has bytes would mean reading it, which is the landmine above. So the
 * stat-only signal becomes a WARNING on a result that is otherwise exactly what
 * the arguments asked for, naming `--file -` as the way to mean the other thing.
 * A warning is a fact about the invocation; it changes no analysis, so it cannot
 * make a test's subject non-deterministic.
 */
async function readInput(
	parsed: ExplainCliArgs,
	inputPositional: string | undefined,
): Promise<{ input: string; warnings: readonly Warning[] }> {
	if (parsed.filePath !== undefined) {
		const input =
			parsed.filePath === "-"
				? await Bun.stdin.text()
				: await readFileInput(parsed.filePath);
		return { input, warnings: [] };
	}
	if (inputPositional === undefined) {
		const piped = stdinMayCarryInput() ? await Bun.stdin.text() : "";
		if (piped.trim() === "") throw missingInputError();
		return { input: piped, warnings: [] };
	}
	// An empty positional is rejected HERE, before fd 0 is even stat'd: it is a
	// present-but-empty argument, so falling through to stdin would make the same
	// argv mean two different things.
	if (inputPositional.trim() === "") throw missingInputError();
	return {
		input: inputPositional,
		warnings: stdinMayCarryInput() ? [STDIN_IGNORED_WARNING] : [],
	};
}

const STDIN_IGNORED_WARNING: Warning = {
	code: "usage/stdin-ignored",
	message:
		"stdin is redirected, and the input came from the positional argument instead — anything piped in was NOT analyzed. Pass `--file -` to analyze stdin, or drop the positional.",
};

function missingInputError(): CentrsError {
	return new CentrsError({
		code: "input/invalid-command",
		summary: "`centrs explain` needs a RouterOS input to analyze.",
		remediation:
			"Pass it as a quoted positional (`centrs explain '/ip/route print'`), with `--file <path>`, or on stdin.",
	});
}

async function readFileInput(path: string): Promise<string> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		throw new CentrsError({
			code: "input/local-file-not-found",
			summary: `--file path not found: ${path}`,
			remediation:
				"Check the path, or pass the input as a quoted positional instead.",
			context: { path },
		});
	}
	return await file.text();
}

/** Flags whose NEXT token is a value, so a scanner must skip it. */
const VALUE_FLAGS = new Set([
	"--file",
	"--fail-on",
	"--format",
	"--via",
	"--host",
	"--port",
	"--username",
	"--user",
	"-u",
	"--password",
	"-p",
	"--timeout",
	"--cdb-file",
	"--cdb-password",
	"--resolve",
	"--quickchr",
	"--cursor",
]);

const LIVE_CONNECTION_FLAGS = new Set([
	"--via",
	"--port",
	"--username",
	"--user",
	"-u",
	"--password",
	"-p",
	"--timeout",
	"--insecure",
	"--cdb-file",
	"--cdb-password",
	"--resolve",
]);

/**
 * The render options, recovered when the parse loop THREW.
 *
 * ONE scan for both, walking the same grammar the parser does — left to right,
 * stopping at `--`, skipping each value-flag's value, last format winning. Two
 * `includes()` scans is how the bug appeared twice: `centrs explain -- --json`
 * read a format request out of RouterOS input, and `-- --verbose` turned on the
 * private error context for a router literally named `--verbose`. A second
 * option parser that disagrees with the first is the defect, so there is one.
 */
function recoverRenderOptions(args: readonly string[]): {
	format?: string;
	verbose: boolean;
} {
	let format: string | undefined;
	let verbose = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined || arg === "--") break;
		if (arg === "--json") format = "json";
		else if (arg === "--yaml") format = "yaml";
		else if (arg === "--verbose") verbose = true;
		else if (arg === "--format") format = args[++index];
		else if (VALUE_FLAGS.has(arg)) index += 1;
	}
	return { format, verbose };
}

/**
 * The same ladder as the success path, but it must never throw: a bad
 * `CENTRS_FORMAT` (or a bad `--format`, which is often WHY we are here) would
 * otherwise replace the user's actual error with a complaint about rendering.
 */
function recoverFormat(
	args: readonly string[],
	env: Record<string, string | undefined>,
	config: Record<string, string | undefined>,
): ResolvedSetting<ExplainOutputFormat> {
	const { format } = recoverRenderOptions(args);
	try {
		return resolveExplainFormat(format, env, config);
	} catch {
		try {
			return resolveExplainFormat(undefined, env, config);
		} catch {
			return { value: "text", source: { kind: "default", key: "format" } };
		}
	}
}

export async function runExplainCli(args: readonly string[]): Promise<number> {
	const env = Bun.env;
	let config: Record<string, string | undefined> = {};
	try {
		// Inside the try: a settings file that cannot be read or parsed is a real
		// failure with a real remedy, and swallowing it would silently bypass the
		// configured format and the rest of the precedence ladder.
		config = await loadEnvFileDefaults(env);
		const parsed = parseExplainCliArgs(args);
		if (parsed.help) {
			console.log(renderCommandHelp(describeCentrs(), explainCliCommand));
			return 0;
		}
		// Resolved ONCE across config < env < CLI, so `meta.settings.format` can
		// name the tier that won (`docs/CONSTITUTION.md` → Settings precedence).
		const format = resolveExplainFormat(parsed.format, env, config);

		// Targets first, from the positionals alone — no file opened, no fd read.
		// More than one positional target IS fan-out mode under the constitution
		// (`isFanoutMode`), so it gets the same refusal as `--group` rather than a
		// second code for the same fact.
		const { targets, inputPositional } = splitPositionals(parsed);
		if (targets.length > 1) throw fanoutNotSupportedError({ targets });
		const router = targets[0];
		assertExplainTarget({ targetInput: router, quickchr: parsed.quickchr });
		if (router !== undefined && (/^\//.test(router) || /^:[a-z]/i.test(router)))
			throw new CentrsError({
				code: "input/invalid-command",
				summary:
					"The input was probably not quoted; two positionals mean router then input.",
				remediation:
					"Quote the whole input as one argument: `centrs explain '/ip/route print'`.",
			});
		const live =
			router !== undefined ||
			parsed.quickchr !== undefined ||
			parsed.host !== undefined;
		if (!live && parsed.connectionFlag !== undefined)
			throw new CentrsError({
				code: "input/invalid-command",
				summary: `${parsed.connectionFlag} requires a router target for live explain.`,
				remediation:
					"Add <router>, --host <host>, or --quickchr <name>; remove the connection flag for offline analysis.",
				context: { flag: parsed.connectionFlag },
			});
		if (
			parsed.facets.length === 0 &&
			(parsed.cursor !== undefined || parsed.full)
		)
			throw new CentrsError({
				code: "usage/conflicting-flags",
				summary: `${parsed.cursor !== undefined ? "--cursor" : "--full"} applies only with --complete or --schema.`,
				remediation: "Add --complete or --schema, or remove the flag.",
			});

		const { input, warnings } = await readInput(parsed, inputPositional);
		resolveExplainCursor(input, parsed.cursor);

		const options = {
			format,
			curl: parsed.curl,
			tokens: parsed.tokens,
			warnings,
			tips:
				!live && parsed.facets.length > 0
					? [buildExplainFacetTip(parsed.facets)]
					: undefined,
		};
		const envelope = live
			? await explainLiveEnvelope(
					{
						...parsed,
						targetInput: router,
						input,
						schema: parsed.facets.includes("--schema"),
						complete: parsed.facets.includes("--complete"),
					},
					options,
					env,
				)
			: explainEnvelope(input, options);
		if (envelope.ok) console.log(renderExplainEnvelope(envelope, format.value));
		else console.error(renderExplainEnvelope(envelope, format.value));
		return envelope.ok
			? explainExitCode(envelope.data.verdict, parsed.failOn)
			: 1;
	} catch (error) {
		// Only here is the parser's answer unavailable — it threw. `config` is
		// whatever loaded before the throw, which is `{}` when the loader itself is
		// what failed: the tier that broke cannot also be the one that renders it.
		const format = recoverFormat(args, env, config);
		const { verbose } = recoverRenderOptions(args);
		const envelope = buildExplainErrorEnvelope(error, [], format);
		console.error(
			format.value === "text"
				? formatCentrsErrorText(envelope.error, { verbose })
				: renderExplainEnvelope(envelope, format.value),
		);
		return 1;
	}
}
