/**
 * Shared target-selection flag parser.
 *
 * The fan-out grammar (`--group` / `--where` / `--all` / `--default` /
 * `--concurrency`) is parsed ONCE here so every command's hand-rolled `switch`
 * loop delegates to it instead of re-implementing the grammar. This helper owns
 * ONLY the flag selectors — it does NOT consume positionals, because a
 * positional means a different thing per command (endpoint / path / command /
 * transfer verb + paths). Each command splits its own positionals into
 * `(targetPositionals, operationArgs)` and hands the target positionals to
 * {@link buildTargetSelection}. See `docs/CONSTITUTION.md` (Target selection).
 */

import { CentrsError } from "../errors.ts";
import {
	type BboxPredicate,
	type NearPredicate,
	parseBbox,
	parseNear,
	type SelectionWhereClause,
	type TargetSelection,
} from "../resolver/index.ts";
import {
	type CliCommandOption,
	expectValue,
	parseStrictInteger,
} from "./common.ts";

/**
 * The shared target-selection flags, as command-help rows. Spread into each
 * fan-out command's `options` so `<command> --help` lists them and the
 * "did you mean?" suggester knows them — one source, so a future command can't
 * forget them.
 */
export const selectionCommandOptions: readonly CliCommandOption[] = [
	{
		flag: "--group",
		valueName: "<name>",
		description:
			"Fan out across every CDB record in the group (repeatable; de-duped by record index).",
	},
	{
		flag: "--where",
		valueName: "<attr>=<value>",
		description:
			"Device-class selector over CDB facts + core fields (repeatable, AND-combined).",
	},
	{
		flag: "--near",
		valueName: "<lat>,<lon>,<radius>",
		description:
			"Geo selector: devices whose GPS is within radius (m/km/mi/ft; bare number = km). Lat-first.",
	},
	{
		flag: "--bbox",
		valueName: "<south>,<west>,<north>,<east>",
		description:
			"Geo selector: devices whose GPS is inside the lat-first bounding box.",
	},
	{
		flag: "--all",
		description: "Fan out across every CDB record (excludes `__default__`).",
	},
	{
		flag: "--default",
		description: "Select the reserved `__default__` record.",
	},
	{
		flag: "--concurrency",
		valueName: "<n>",
		description:
			"Max in-flight targets during fan-out (transport-aware default: rest-api 8, native-api 4).",
	},
];

/** Mutable accumulator a command threads through its parse loop. */
export interface SelectionFlags {
	groups: string[];
	where: SelectionWhereClause[];
	near?: NearPredicate;
	bbox?: BboxPredicate;
	all: boolean;
	default: boolean;
	concurrency?: number;
}

export function emptySelectionFlags(): SelectionFlags {
	return { groups: [], where: [], all: false, default: false };
}

/** The selection flag tokens, for a command's `--help` table + unknown-flag suggestions. */
export const selectionFlagTokens = [
	"--group",
	"--where",
	"--near",
	"--bbox",
	"--all",
	"--default",
	"--concurrency",
] as const;

function parseWhereClause(raw: string): SelectionWhereClause {
	const eq = raw.indexOf("=");
	if (eq <= 0) {
		throw new CentrsError({
			code: "input/invalid-command",
			summary: `--where must be \`<attr>=<value>\`; received: ${raw}`,
			remediation:
				"Pass a device-class selector like `--where board=RB5009` (matches a CDB fact or core field).",
			context: { where: raw },
		});
	}
	return { key: raw.slice(0, eq), value: raw.slice(eq + 1) };
}

/**
 * Try to consume one selection flag at `args[index]`. Returns the new loop index
 * when consumed (the caller sets its index to this and continues), or `null`
 * when the arg is not a selection flag (the caller handles it). Mutates `acc`.
 */
export function consumeSelectionFlag(
	args: readonly string[],
	index: number,
	acc: SelectionFlags,
): number | null {
	const arg = args[index];
	switch (arg) {
		case "--all":
			acc.all = true;
			return index;
		case "--default":
			acc.default = true;
			return index;
		case "--group":
			acc.groups.push(expectValue(args, index + 1, arg));
			return index + 1;
		case "--where":
			acc.where.push(parseWhereClause(expectValue(args, index + 1, arg)));
			return index + 1;
		case "--near":
			acc.near = parseNear(expectValue(args, index + 1, arg));
			return index + 1;
		case "--bbox":
			acc.bbox = parseBbox(expectValue(args, index + 1, arg));
			return index + 1;
		case "--concurrency": {
			const raw = expectValue(args, index + 1, arg);
			const parsed = parseStrictInteger(raw);
			if (parsed === undefined || parsed < 1) {
				throw new CentrsError({
					code: "usage/invalid-concurrency",
					summary: `--concurrency must be an integer >= 1. Received: ${raw}`,
					remediation: "Pass a positive integer, e.g. `--concurrency 4`.",
					context: { concurrency: raw },
				});
			}
			acc.concurrency = parsed;
			return index + 1;
		}
		default:
			return null;
	}
}

/** Assemble a {@link TargetSelection} from parsed flags + the command's target positionals. */
export function buildTargetSelection(
	flags: SelectionFlags,
	positionals: readonly string[],
): TargetSelection {
	return {
		positionals,
		groups: flags.groups,
		all: flags.all,
		default: flags.default,
		where: flags.where,
		near: flags.near,
		bbox: flags.bbox,
	};
}

/**
 * Fan-out mode is keyed on INTENT, not resolved count: any selector flag, or more
 * than one positional target. A plain single-positional call stays single-target
 * (never `FanoutData`); a selector that resolves to one/zero members is still
 * fan-out mode. See `docs/CONSTITUTION.md` (Target selection).
 */
export function isFanoutMode(
	flags: SelectionFlags,
	targetPositionalCount: number,
): boolean {
	return (
		flags.all ||
		flags.default ||
		flags.groups.length > 0 ||
		flags.where.length > 0 ||
		flags.near !== undefined ||
		flags.bbox !== undefined ||
		targetPositionalCount > 1
	);
}
