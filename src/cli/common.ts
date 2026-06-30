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
