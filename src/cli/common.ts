/**
 * Shared CLI plumbing: command metadata shape, help rendering, and small arg
 * helpers used by every `centrs <command>` runner. Per-command parsing,
 * dispatch, and error-to-envelope handling live in the sibling modules
 * (`./retrieve.ts`, `./devices.ts`, `./execute.ts`); `../cli.ts` wires them
 * together.
 */

import { CentrsError } from "../errors.ts";

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
}

export function expectValue(
	args: readonly string[],
	index: number,
	flag: string,
): string {
	const value = args[index];
	if (value === undefined) {
		throw new Error(`Missing value for ${flag}.`);
	}
	return value;
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
 */
export function unknownFlagError(
	command: string,
	arg: string,
	options: readonly CliCommandOption[],
): CentrsError {
	const suggestions = closestFlags(arg, knownFlags(options));
	const hint =
		suggestions.length > 0 ? ` Did you mean ${suggestions.join(", ")}?` : "";
	return new CentrsError({
		code: "input/invalid-command",
		summary: `Unknown ${command} flag: ${arg}.${hint}`,
		remediation: `Run \`centrs ${command} --help\` to see the supported flags${suggestions.length > 0 ? " and their aliases" : ""}.`,
		context: { flag: arg, suggestions },
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
	const separator = args.indexOf("--");
	if (separator === -1) return;
	const optionByFlag = new Map<string, CliCommandOption>();
	for (const option of options) {
		for (const token of option.flag.split("/")) {
			const trimmed = token.trim();
			if (trimmed.startsWith("--") && trimmed !== "--") {
				optionByFlag.set(trimmed, option);
			}
		}
	}
	const secret = (flag: string) =>
		flag.startsWith("-") && flag.includes("password");
	const before = args.slice(0, separator).map((token, index, all) => {
		const [name = ""] = token.split("=");
		if (token.includes("=") && secret(name)) return `${name}=<password>`;
		const previous = all[index - 1];
		return previous !== undefined && secret(previous) ? "<password>" : token;
	});
	const moved: string[] = [];
	const kept: string[] = [];
	const flags: string[] = [];
	const after = args.slice(separator + 1);
	for (let index = 0; index < after.length; index += 1) {
		const token = after[index] ?? "";
		const [name = "", ...valueParts] = token.split("=");
		const option = optionByFlag.get(name);
		if (option === undefined) {
			kept.push(token);
			continue;
		}
		flags.push(name);
		// The parsers take a value flag's value as the next token (`--timeout 30s`,
		// never `--timeout=30s`), so the fixed line splits it; only a boolean's
		// `=` form (`--validate=no`) is kept as typed.
		if (valueParts.length > 0) {
			if (option.valueName === undefined) {
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
	const fixed = ["centrs", command, ...before, ...moved, "--", ...kept]
		.map(shellQuote)
		.join(" ");
	const list = flags.map((flag) => `\`${flag}\``).join(", ");
	throw new CentrsError({
		code: "usage/flag-after-separator",
		summary: `${list} ${flags.length === 1 ? "comes" : "come"} after \`--\`, so ${flags.length === 1 ? "it" : "they"} would be sent to RouterOS as part of the command.`,
		remediation: `Put centrs flags before \`--\`: \`${fixed}\``,
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
