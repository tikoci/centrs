/**
 * Shared CLI plumbing: command metadata shape, help rendering, and small arg
 * helpers used by every `centrs <command>` runner. Per-command parsing,
 * dispatch, and error-to-envelope handling live in the sibling modules
 * (`./retrieve.ts`, `./devices.ts`, `./execute.ts`); `../cli.ts` wires them
 * together.
 */

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
