/**
 * `centrs explain` CLI surface: command metadata, arg parsing, dispatch, and
 * envelope rendering for the phase-1 OFFLINE analysis (#202b).
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
 * `--file` / stdin REPLACE the input positional, so with either of them every
 * positional is a target. stdin is consulted only when no positional could be
 * the input at all — `explain <router>` with a piped script would otherwise be
 * indistinguishable from `explain '<input>'`, and guessing between them is
 * exactly the kind of arity magic the target-first rule exists to avoid. Pass
 * `--file -` to read stdin in the live form.
 *
 * ## What this surface refuses to do
 *
 * - **The live form is rejected, not degraded.** Phase 2 owns the probes; a
 *   phase-1 run that silently analyzed offline while a router was named would
 *   report `mode: "offline"` about an invocation that asked for more.
 * - **Fan-out is rejected** (`usage/fanout-not-supported`, the `terminal`
 *   pattern): `explain` takes at most one router.
 * - **`--complete` / `--schema` enumerate nothing offline.** They are accepted,
 *   they emit the live-target tip, and they add no fabricated `data.schema` —
 *   offline consults no schema snapshot, by ratified decision.
 */

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
} from "../explain.ts";
import { describeCentrs } from "../index.ts";
import {
	type CliCommandMetadata,
	expectValue,
	renderCommandHelp,
	unknownFlagError,
} from "./common.ts";
import { withTips } from "./missing-target.ts";
import { selectionFlagTokens } from "./selection.ts";

export const explainCliCommand: CliCommandMetadata = {
	name: "explain",
	usage: "centrs explain '<input>' [flags]",
	summary:
		"Analyze a RouterOS command offline: canonical form, structure, and syntax diagnostics.",
	options: [
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
				"Continuation candidates at the cursor. Live evidence — offline emits a tip and enumerates nothing.",
		},
		{
			flag: "--schema",
			description:
				"Path enumeration (verbs, args, types, enums). Live evidence — offline emits a tip and enumerates nothing.",
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

export interface ExplainCliArgs {
	help?: boolean;
	positionals: string[];
	filePath?: string;
	failOn: ExplainFailOn;
	facets: string[];
	format?: ExplainOutputFormat;
	verbose?: boolean;
}

export function parseExplainCliArgs(args: readonly string[]): ExplainCliArgs {
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
					throw new CentrsError({
						code: "usage/fanout-not-supported",
						summary:
							"`centrs explain` analyzes one input against at most one router and cannot fan out across a multi-target selection.",
						remediation:
							"Drop the selection flag and pass a single input (`centrs explain '<input>'`); use `execute` / `api` for multi-target commands.",
						context: { flag: arg, capability: "explain" },
					});
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
 * The one live-form error.
 *
 * Named separately because it is a PHASE boundary, not a usage mistake: the
 * invocation is the ratified grammar and will work unchanged when phase 2
 * lands, so the remediation points at the offline form rather than at `--help`.
 */
function liveNotImplementedError(router: string): CentrsError {
	return new CentrsError({
		code: "usage/not-implemented",
		summary: `\`centrs explain <router> '<input>'\` needs live \`/console/inspect\` evidence, which is phase 2; the router \`${router}\` was not contacted.`,
		remediation:
			"Drop the router for the offline analysis (`centrs explain '<input>'`), or use `rosetta` for documented RouterOS schema facts.",
		context: { router, phase: "2" },
	});
}

/** Resolve the input text from `--file`, piped stdin, or the input positional. */
async function readInput(
	parsed: ExplainCliArgs,
): Promise<{ input: string; targets: readonly string[] }> {
	if (parsed.filePath !== undefined) {
		const input =
			parsed.filePath === "-"
				? await Bun.stdin.text()
				: await readFileInput(parsed.filePath);
		return { input, targets: parsed.positionals };
	}
	if (parsed.positionals.length === 0) {
		// The TTY guard keeps an interactive `centrs explain` from silently waiting
		// on EOF; the empty check covers the other way in — stdin closed or bound to
		// /dev/null, where the read succeeds with nothing. Both mean the same thing
		// to the user, so both raise the same error rather than analyzing "".
		const piped = process.stdin.isTTY ? "" : await Bun.stdin.text();
		if (piped.trim() === "") throw missingInputError();
		return { input: piped, targets: [] };
	}
	// Target-first: the LAST positional is the input, everything before it is the
	// target. Splitting from the end is what keeps the two forms unambiguous.
	const positionals = [...parsed.positionals];
	const input = positionals.pop() as string;
	return { input, targets: positionals };
}

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
const VALUE_FLAGS = new Set(["--file", "--fail-on", "--format"]);

/**
 * The requested format, recovered when the parse loop THREW.
 *
 * It has to walk the same grammar the parser does — left to right, stopping at
 * `--`, skipping each value-flag's value, last format winning. A `includes()`
 * scan reads `centrs explain -- --json` as a format request when `--json` is
 * the RouterOS input, and reports JSON for `--yaml --json --bad` in either
 * order. The error renderer picking a different format than the success
 * renderer would is its own bug, even though only failures reach here.
 */
function formatFromArgs(args: readonly string[]): ExplainOutputFormat {
	let format: ExplainOutputFormat = "text";
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined || arg === "--") break;
		if (arg === "--json") format = "json";
		else if (arg === "--yaml") format = "yaml";
		else if (arg === "--format") {
			const value = args[++index];
			if ((explainOutputFormats as readonly string[]).includes(value ?? ""))
				format = value as ExplainOutputFormat;
		} else if (VALUE_FLAGS.has(arg)) index += 1;
	}
	return format;
}

export async function runExplainCli(args: readonly string[]): Promise<number> {
	const format = formatFromArgs(args);
	try {
		const parsed = parseExplainCliArgs(args);
		if (parsed.help) {
			console.log(renderCommandHelp(describeCentrs(), explainCliCommand));
			return 0;
		}

		const { input, targets } = await readInput(parsed);
		if (targets.length > 1) {
			throw new CentrsError({
				code: "input/invalid-command",
				summary: `\`centrs explain\` takes at most one router and one input; got ${targets.length + 1} positional arguments.`,
				remediation:
					"Quote the input so the shell passes it as one argument: `centrs explain '/ip/route print'`.",
				context: { positionals: [...targets] },
			});
		}
		const router = targets[0];
		if (router !== undefined) throw liveNotImplementedError(router);

		const base = explainEnvelope(input);
		const envelope =
			parsed.facets.length > 0
				? withTips(base, [...base.tips, buildExplainFacetTip(parsed.facets)])
				: base;
		console.log(renderExplainEnvelope(envelope, parsed.format ?? format));
		return explainExitCode(envelope.data.verdict, parsed.failOn);
	} catch (error) {
		const envelope = buildExplainErrorEnvelope(error);
		console.error(
			format === "text"
				? formatCentrsErrorText(envelope.error, {
						verbose: args.includes("--verbose"),
					})
				: renderExplainEnvelope(envelope, format),
		);
		return 1;
	}
}
