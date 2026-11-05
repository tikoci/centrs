/**
 * Shared CLI plumbing: command metadata shape, help rendering, and small arg
 * helpers used by every `centrs <command>` runner. Per-command parsing,
 * dispatch, and error-to-envelope handling live in the sibling modules
 * (`./retrieve.ts`, `./devices.ts`, `./execute.ts`); `../cli.ts` wires them
 * together.
 */

import type { Tip, Warning } from "../core/envelope.ts";
import { CentrsError, terminalSafeLine } from "../errors.ts";
import { redactTargetInput } from "../resolver/target.ts";
import { formatTipsText } from "./missing-target.ts";

/**
 * Warnings that a single-target text-mode CLI leaves out (#470).
 * `transport/provider-trust` rides every quickchr run over TLS or SSH, so
 * printing it would be noise. `--json` keeps every warning.
 */
const TEXT_QUIET_WARNING_CODES: readonly string[] = [
	"transport/provider-trust",
];

/**
 * One `warning [<code>]: <message>` line per envelope warning, in the same form
 * as fan-out text, minus {@link TEXT_QUIET_WARNING_CODES}.
 */
export function textWarningLines(warnings: readonly Warning[]): string[] {
	return warnings
		.filter((warning) => !TEXT_QUIET_WARNING_CODES.includes(warning.code))
		.map((warning) =>
			terminalSafeLine(`warning [${warning.code}]: ${warning.message}`),
		);
}

/**
 * #470: in text mode a single-target command's stdout is its data and nothing
 * else. The notes around the data go to stderr: the `--verbose` header before
 * it ({@link printTextHeader}), then warnings and tips after it. This applies
 * on success and on failure, so a write whose outcome is unknown still says so.
 */
export function printTextNotes(envelope: {
	warnings: readonly Warning[];
	tips: readonly Tip[];
}): void {
	for (const line of textWarningLines(envelope.warnings)) console.error(line);
	const tips = formatTipsText(envelope.tips);
	if (tips) console.error(tips);
}

/** The `--verbose` header of a text-mode result, on stderr (#470). */
export function printTextHeader(lines: readonly string[]): void {
	if (lines.length > 0) console.error(lines.join("\n"));
}

export interface CliCommandOption {
	flag: string;
	valueName?: string;
	description: string;
}

export interface CliCommandMetadata {
	name: string;
	usage: string;
	summary: string;
	options: readonly CliCommandOption[];
	subcommands?: readonly CliCommandMetadata[];
}

/**
 * Flags whose values may legitimately start with `-`: a secret's spelling is
 * the user's, not ours, so `expectValue` takes the next token literally for
 * these, whatever it looks like. (`-p` is explain's `--password` alias.) A
 * missing value still throws. `--help`/`-h` still win globally — the
 * `helpRequested` pre-scan runs before any parser loop, so help is printed and
 * these flags never consume it.
 */
const LITERAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
	"--password",
	"--cdb-password",
	"-p",
]);

/** The `valueName` (`<host>`, `<name>`, …) of the option that owns `flag`. */
function valueNameFor(
	flag: string,
	options: readonly CliCommandOption[],
): string {
	for (const option of options) {
		const tokens = option.flag.split("/").map((token) => token.trim());
		if (tokens.includes(flag)) {
			return option.valueName ?? "<value>";
		}
	}
	return "<value>";
}

/**
 * The typed "this flag needs a value" error (#625): `got` is `undefined` at
 * end of argv, the bare `--` separator, or the flag-shaped token that was
 * found where the value should be.
 */
export function missingFlagValueError(
	flag: string,
	got: string | undefined,
	valueName: string,
): CentrsError {
	if (got !== undefined) {
		const equal = got.indexOf("=");
		if (equal > 0 && got.startsWith("--")) {
			const name = got.slice(0, equal);
			got = `${name}=${name.includes("password") ? "<password>" : redactTargetInput(got.slice(equal + 1))}`;
		}
	}
	if (got === undefined) {
		return new CentrsError({
			code: "usage/missing-flag-value",
			summary: `\`${flag}\` needs a value.`,
			remediation: `Pass one: \`${flag} ${valueName}\`.`,
			context: { flag, got: null },
		});
	}
	if (got === "--") {
		return new CentrsError({
			code: "usage/missing-flag-value",
			summary: `\`${flag}\` needs a value but got \`--\`, which ends option parsing.`,
			remediation: `Pass the value before \`--\`: \`${flag} ${valueName} -- …\`.`,
			context: { flag, got },
		});
	}
	return new CentrsError({
		code: "usage/missing-flag-value",
		summary: `\`${flag}\` needs a value but got \`${got}\`, which looks like another flag.`,
		remediation: `Put the value first: \`${flag} ${valueName} ${got}\`.`,
		context: { flag, got },
	});
}

/**
 * True when `value` is shaped like a flag rather than a value: any
 * `--`-prefixed token, or a single-dash token that is a known flag of this
 * command. A bare `-` is never flag-shaped (the stdin convention:
 * `explain --file -`), and neither is an unknown single-dash token — `-1`
 * stays a value for the flag's own validator to accept or reject.
 */
function isFlagShaped(
	value: string,
	options: readonly CliCommandOption[],
): boolean {
	if (value === "-") {
		return false;
	}
	if (value.startsWith("--")) {
		return true;
	}
	return value.startsWith("-") && knownFlags(options).includes(value);
}

export function expectValue(
	args: readonly string[],
	index: number,
	flag: string,
	options: readonly CliCommandOption[],
): string {
	const value = args[index];
	const valueName = valueNameFor(flag, options);
	if (value === undefined) {
		throw missingFlagValueError(flag, undefined, valueName);
	}
	if (LITERAL_VALUE_FLAGS.has(flag)) {
		return value;
	}
	if (value === "--help" || value === "-h" || isFlagShaped(value, options)) {
		throw missingFlagValueError(flag, value, valueName);
	}
	return value;
}

/** Every flag token (long and short) whose option takes a value. */
export function valueFlagTokens(
	options: readonly CliCommandOption[],
): ReadonlySet<string> {
	const tokens = new Set<string>();
	for (const option of options) {
		if (option.valueName === undefined) {
			continue;
		}
		for (const token of option.flag.split("/")) {
			const trimmed = token.trim();
			if (trimmed.startsWith("-") && trimmed !== "--") {
				tokens.add(trimmed);
			}
		}
	}
	return tokens;
}

/**
 * Split `--flag=value` into `--flag value` for known value-taking long flags
 * (#625). Only tokens before the first bare `--` are split — everything after
 * it is literal RouterOS input. Unknown `--x=y` and boolean `--bool=v` tokens
 * are left whole for `unknownFlagError`. An explicit empty value is preserved.
 */
export function expandEqualsArgs(
	args: readonly string[],
	options: readonly CliCommandOption[],
): string[] {
	const values = valueFlagTokens(options);
	const expanded: string[] = [];
	let endOfOptions = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] as string;
		if (endOfOptions) {
			expanded.push(arg);
			continue;
		}
		if (arg === "--") {
			endOfOptions = true;
			expanded.push(arg);
			continue;
		}
		const equal = arg.indexOf("=");
		if (equal > 2 && arg.startsWith("--")) {
			const name = arg.slice(0, equal);
			const given = arg.slice(equal + 1);
			if (values.has(name)) {
				expanded.push(name, given);
				continue;
			}
		}
		expanded.push(arg);
		// Values are opaque, even when they look like an inline option or `--`.
		if (values.has(arg) && args[index + 1] !== undefined) {
			expanded.push(args[++index] as string);
		}
	}
	return expanded;
}

/**
 * True when `--help`/`-h` appears before the first bare `--` (#625). Every
 * parser checks this before anything else so help wins even in a
 * value-taking flag's value position (`--host --help`) or after an unknown
 * flag. Tokens after `--` are RouterOS input, never help.
 */
export function helpRequested(args: readonly string[]): boolean {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") {
			return false;
		}
		if (arg === "--help" || arg === "-h") {
			return true;
		}
		// A password equal to `--` does not end option parsing.
		if (
			arg !== undefined &&
			LITERAL_VALUE_FLAGS.has(arg) &&
			args[index + 1] === "--"
		)
			index += 1;
	}
	return false;
}

/** Recover rendering options without reading values as flags or throwing. */
export function cliRenderOptions(
	args: readonly string[],
	options: readonly CliCommandOption[],
): { format?: string; verbose: boolean } {
	const values = valueFlagTokens(options);
	const known = new Set(knownFlags(options));
	let format: string | undefined;
	let verbose = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined || arg === "--") break;
		if (values.has(arg)) {
			if (arg === "--format") format = args[index + 1];
			index += 1;
			continue;
		}
		const equal = arg.indexOf("=");
		if (equal > 2 && arg.startsWith("--")) {
			if (arg.slice(0, equal) === "--format" && values.has("--format")) {
				format = arg.slice(equal + 1);
			}
			continue;
		}
		if (known.has(arg)) {
			if (["--json", "--yaml", "--csv"].includes(arg)) format = arg.slice(2);
			if (arg === "--verbose") verbose = true;
		}
	}
	return { format, verbose };
}

/** Shared parse-error format selection, with the command's normal default. */
export function inferCliFormat<F extends string>(
	args: readonly string[],
	options: readonly CliCommandOption[],
	formats: readonly F[],
	defaultFormat: F,
	envFormat?: string,
): F {
	const { format } = cliRenderOptions(args, options);
	const isFormat = (value: string | undefined): value is F =>
		value !== undefined && (formats as readonly string[]).includes(value);
	return isFormat(format)
		? format
		: isFormat(envFormat)
			? envFormat
			: defaultFormat;
}

/**
 * Parse a strictly-integer flag value, or `undefined` when the whole token is
 * not an integer. Rejects numeric prefixes (`2abc` → undefined, not `2`) and
 * decimals (`1.5`), which a bare `Number.parseInt` would silently truncate —
 * the trap shared by `--port` / `--count` / `--concurrency`.
 */
export function parseStrictInteger(value: string): number | undefined {
	const trimmed = value.trim();
	return /^-?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : undefined;
}

/** Flatten an option's `flag` field ("-X / --method") into individual `-`/`--` tokens. */
export function knownFlags(options: readonly CliCommandOption[]): string[] {
	const flags: string[] = [];
	for (const option of options) {
		for (const token of option.flag.split("/")) {
			const trimmed = token.trim();
			if (trimmed.startsWith("-")) {
				flags.push(trimmed);
			}
		}
	}
	return flags;
}

function editDistance(a: string, b: string): number {
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i += 1) {
		const curr = [i];
		for (let j = 1; j <= b.length; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(
				(curr[j - 1] ?? 0) + 1,
				(prev[j] ?? 0) + 1,
				(prev[j - 1] ?? 0) + cost,
			);
		}
		prev = curr;
	}
	return prev[b.length] ?? 0;
}

/** Closest known flags to `arg` (Levenshtein ≤ 2 — tight enough to avoid noise), nearest first, capped at 3. */
export function closestFlags(arg: string, flags: readonly string[]): string[] {
	return [...new Set(flags)]
		.map((flag) => ({ flag, distance: editDistance(arg, flag) }))
		.filter(({ distance }) => distance <= 2)
		.sort((left, right) => left.distance - right.distance)
		.slice(0, 3)
		.map(({ flag }) => flag);
}

/**
 * Actionable "unknown flag" error: lists the closest canonical matches (and
 * aliases) so humans and agents can recover (commands/AGENTS.md → "Did you
 * mean?"). Shared seam — parsers pass their own `command` + option metadata.
 *
 * Also the landing spot for the `--flag=value` spellings `expandEqualsArgs`
 * leaves whole (#625): a value on a boolean flag.
 */
export function unknownFlagError(
	command: string,
	arg: string,
	options: readonly CliCommandOption[],
): CentrsError {
	const equal = arg.indexOf("=");
	if (equal > 2 && arg.startsWith("--")) {
		const name = arg.slice(0, equal);
		const option = options.find((candidate) =>
			candidate.flag
				.split("/")
				.map((token) => token.trim())
				.includes(name),
		);
		if (option !== undefined && option.valueName === undefined) {
			return new CentrsError({
				code: "input/invalid-command",
				summary: `\`${name}\` takes no value; use a bare \`${name}\`.`,
				remediation: `Use a bare \`${name}\` to enable it, or omit it to keep the default.`,
				context: { flag: name, suggestions: [] },
			});
		}
		if (
			option !== undefined &&
			option.valueName !== undefined &&
			arg.slice(equal + 1) === ""
		) {
			return missingFlagValueError(name, undefined, option.valueName);
		}
		// An unknown `--x=y`: suggest on the base name, where the typo is. The
		// value is never echoed — an unknown name (a mistyped `--pasword=…`,
		// or a `--password=…` this command lacks) may carry a credential.
		const shown = `${name}=<value>`;
		const suggestions = closestFlags(name, knownFlags(options));
		const hint =
			suggestions.length > 0 ? ` Did you mean ${suggestions.join(", ")}?` : "";
		return new CentrsError({
			code: "input/invalid-command",
			summary: `Unknown ${command} flag: ${shown}.${hint}`,
			remediation: `Run \`centrs ${command} --help\` to see the supported flags${suggestions.length > 0 ? " and their aliases" : ""}.`,
			context: { flag: shown, suggestions },
		});
	}
	const shown = redactTargetInput(arg);
	const suggestions = closestFlags(arg, knownFlags(options));
	const hint =
		suggestions.length > 0 ? ` Did you mean ${suggestions.join(", ")}?` : "";
	return new CentrsError({
		code: "input/invalid-command",
		summary: `Unknown ${command} flag: ${shown}.${hint}`,
		remediation: `Run \`centrs ${command} --help\` to see the supported flags${suggestions.length > 0 ? " and their aliases" : ""}.`,
		context: { flag: shown, suggestions },
	});
}

/** Single-quote a token for a shell line a user can copy, unless it is plain. */
function shellQuote(token: string): string {
	return /^[\w/:=.,@%+-]+$/.test(token)
		? token
		: `'${token.replaceAll("'", `'\\''`)}'`;
}

/**
 * A centrs flag written after a bare `--` (#459).
 *
 * `--` makes every later token RouterOS input, so a trailing `--json` (the
 * habitual position: `execute r1 -- '/cmd' --json`) went to the router and
 * failed there as `unknown-attribute`. The RouterOS command is one quoted
 * argument in every documented form, so a later token that is exactly one of
 * this command's LONG flags (or its `--flag=value` spelling) is this mistake.
 * Short aliases (`-u`, `-h`) are left alone: a lone `-x` is plausible
 * RouterOS input, `--json` is not. A command that really needs such a token
 * can carry it inside the quoted command.
 *
 * Throws `usage/flag-after-separator` with the command line rewritten with the
 * flags (and their values) moved before `--`. Password values are never
 * echoed. A no-op when there is no `--`.
 */
export function rejectFlagsAfterSeparator(
	command: string,
	args: readonly string[],
	options: readonly CliCommandOption[],
): void {
	const optionByFlag = new Map<string, CliCommandOption>();
	for (const option of options) {
		for (const token of option.flag.split("/")) {
			const trimmed = token.trim();
			if (trimmed.startsWith("-") && trimmed !== "--") {
				optionByFlag.set(trimmed, option);
			}
		}
	}
	let separator = -1;
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] ?? "";
		if (token === "--") {
			separator = index;
			break;
		}
		// A flag's value may itself be `--`; only the parser's separator counts.
		if (optionByFlag.get(token)?.valueName !== undefined) index += 1;
	}
	if (separator === -1) return;
	const secret = (flag: string) =>
		flag.startsWith("-") && flag.includes("password");
	const before: string[] = [];
	for (let index = 0; index < separator; index += 1) {
		const token = args[index] ?? "";
		const [name = ""] = token.split("=");
		const equal = token.indexOf("=");
		if (equal >= 0 && optionByFlag.get(name)?.valueName !== undefined) {
			before.push(
				name,
				secret(name) ? "<password>" : redactTargetInput(token.slice(equal + 1)),
			);
			continue;
		}
		if (equal >= 0 && secret(name)) {
			before.push(`${name}=<password>`);
			continue;
		}
		before.push(redactTargetInput(token));
		if (optionByFlag.get(name)?.valueName !== undefined || secret(name)) {
			const value = args[index + 1];
			if (index + 1 < separator && value !== undefined) {
				before.push(secret(name) ? "<password>" : redactTargetInput(value));
				index += 1;
			}
		}
	}
	const unsupportedInlineBooleans: string[] = [];
	const moved: string[] = [];
	const kept: string[] = [];
	const flags: string[] = [];
	const after = args.slice(separator + 1);
	for (let index = 0; index < after.length; index += 1) {
		const token = after[index] ?? "";
		const [name = "", ...valueParts] = token.split("=");
		const option = name.startsWith("--") ? optionByFlag.get(name) : undefined;
		if (option === undefined) {
			kept.push(token);
			continue;
		}
		flags.push(name);
		// The fixed line splits a value flag's value into the next-token form
		// (`--timeout 30s`); only a boolean's supported `=` form
		// (`--validate=no`) is kept as typed.
		if (valueParts.length > 0) {
			if (option.valueName === undefined) {
				if (command !== "execute" || name !== "--validate") {
					unsupportedInlineBooleans.push(name);
				}
				moved.push(token);
			} else {
				moved.push(name, secret(name) ? "<password>" : valueParts.join("="));
			}
			continue;
		}
		moved.push(name);
		const value = after[index + 1];
		if (option.valueName !== undefined && value !== undefined) {
			moved.push(secret(name) ? "<password>" : value);
			index += 1;
		}
	}
	if (flags.length === 0) return;
	// A moved --host value needs the same redaction as a positional target.
	// Keep the RouterOS command itself verbatim; it is not a target.
	const fixed = [
		"centrs",
		command,
		...before,
		...moved.map((token) => redactTargetInput(token)),
		"--",
		...kept,
	]
		.map(shellQuote)
		.join(" ");
	const list = flags.map((flag) => `\`${flag}\``).join(", ");
	throw new CentrsError({
		code: "usage/flag-after-separator",
		summary: `${list} ${flags.length === 1 ? "comes" : "come"} after \`--\`, so ${flags.length === 1 ? "it" : "they"} would be sent to RouterOS as part of the command.`,
		remediation:
			unsupportedInlineBooleans.length > 0
				? `Put centrs flags before \`--\`. These flags accept no value: ${unsupportedInlineBooleans.map((flag) => `\`${flag}\``).join(", ")}. Use a bare flag to enable it, or omit it to keep the default.`
				: `Put centrs flags before \`--\`: \`${fixed}\``,
		context: { flags },
	});
}

export function renderCommandHelp(
	describe: string,
	command: CliCommandMetadata,
): string {
	return [
		describe,
		"",
		command.summary,
		"",
		`Usage: ${command.usage}`,
		"",
		"Options:",
		...command.options.map((option) => {
			const flag = option.valueName
				? `${option.flag} ${option.valueName}`
				: option.flag;
			return `  ${flag.padEnd(28)} ${option.description}`;
		}),
	].join("\n");
}
