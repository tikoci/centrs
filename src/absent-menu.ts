/**
 * Tell a menu this device does not have apart from a real syntax error (GH#361).
 *
 * RouterOS's `:parse` reports an absent menu as if it were a syntax fault, in two
 * spellings that both name the segment it could not resolve (CHR 7.23.7):
 *
 *   /zerotier/print       -> syntax error (line 1 column 10)
 *   /zerotier print       -> (<%% bad command name zerotier (line 1 column 2) …)
 *
 * The slash spelling points at the `/` right AFTER the absent segment; the space
 * spelling names the segment and points at its first byte. The column is a 1-based
 * BYTE column on the given line (`:put "é"; /zerotier/print` -> column 21, not 20).
 * Nesting moves the column but not the rule: `:put [/interface/w60g/get …]`,
 * `/ip/address { /zerotier/print }` and a second line all point at the `/` after
 * the absent segment.
 *
 * Once the segment is located, the path catalog says what it is. Both shipped
 * tables are built from all-extra-packages builds, so a path they carry exists in
 * SOME RouterOS 7 build, and its published gates explain why this one lacks it:
 *
 * The path can end in a command (`/system/license/output`, gated `nochr`), not
 * only a menu; the summary uses the catalog's kind.
 *
 * - a package gate alone           -> `validation/package-missing`
 * - any other gate, or none        -> `validation/menu-unavailable`
 * - not in either table            -> `validation/unknown-path`
 *
 * Anything this cannot locate exactly returns `undefined`, and the caller keeps
 * its `validation/syntax`. Abstaining is always safe; guessing a path is not.
 */

import { CentrsError, type RouterOsErrorPosition } from "./errors.ts";
import {
	type CatalogGate,
	effectiveGates,
	PATH_CATALOG,
} from "./explain/catalog.ts";
import { MENU_PATHS } from "./explain/menus.ts";
import { explainCommand } from "./explain.ts";

const NAME = /[a-z0-9-]/i;
const BAD_COMMAND_NAME = /bad command name\s+(\S+)\s+\(line \d+ column \d+\)/i;
const BARE_SYNTAX_ERROR = /^[ \t]*syntax error \(line \d+ column \d+\)/im;
/** What may precede the leading `/` of an absolute path run. */
const RUN_BOUNDARY = /[\s[{;(]/;

/** The located absent segment, as a path from the root. */
interface AbsentPath {
	/** Lower-cased segments from the root through the absent one. */
	segments: string[];
	/** The segment RouterOS could not resolve, as written. */
	segment: string;
}

export function absentMenuError(
	cli: string,
	output: string,
	position: RouterOsErrorPosition | undefined,
	via: string,
): CentrsError | undefined {
	if (position === undefined) return undefined;
	const offset = offsetOf(cli, position);
	if (offset === undefined) return undefined;
	const absent = locateAbsentPath(cli, output, offset);
	if (absent === undefined) return undefined;

	const segments = expandAbbreviations(absent.segments);
	const path = `/${segments.join("/")}`;
	const context = {
		command: cli,
		path,
		segment: absent.segment,
		validationSource: `:put [:parse ...] over ${via}`,
		detail: output,
	};

	if (!isPublished(path)) {
		return new CentrsError({
			code: "validation/unknown-path",
			summary: `RouterOS has no \`${path}\` menu or command, and centrs's path catalog has none.`,
			remediation: `Check the spelling of \`${absent.segment}\`: the catalog covers every RouterOS 7.10–7.25 build with all extra packages. \`centrs explain '<command>'\` shows how the rest of the command reads.`,
			context,
			position,
		});
	}

	const noun = PATH_CATALOG.get(path)?.kind === "command" ? "command" : "menu";
	const gates = gatesOf(segments);
	const packages = unique(gates.flatMap((gate) => gate.package ?? []));
	const others = gates.filter(
		(gate) => gate.conditions !== undefined || gate.syscap !== undefined,
	);
	if (packages.length > 0 && others.length === 0) {
		const named = packages.map((name) => `\`${name}\``).join(", ");
		return new CentrsError({
			code: "validation/package-missing",
			summary: `This device has no \`${path}\` ${noun}; MikroTik publishes it in package ${named}, which is likely not installed.`,
			remediation: `The command is not the problem. Check the installed packages with \`/system/package/print\`; install ${named} (MikroTik's published name; the installable package can be named differently) and reboot, or run this only on devices that have it.`,
			context: { ...context, packages, gates },
			position,
		});
	}
	return new CentrsError({
		code: "validation/menu-unavailable",
		summary: `This device has no \`${path}\` ${noun}, although RouterOS 7 publishes one.`,
		remediation: `The command is not the problem. ${gateAdvice(gates)}`,
		context: { ...context, gates },
		position,
	});
}

/** The UTF-16 index of RouterOS's 1-based line / byte column, or `undefined`. */
function offsetOf(
	cli: string,
	{ line, column }: RouterOsErrorPosition,
): number | undefined {
	const lines = cli.split("\n");
	const text = lines[line - 1];
	if (text === undefined || column < 1) return undefined;
	const bytes = new TextEncoder().encode(text);
	if (column - 1 > bytes.length) return undefined;
	const prefix = new TextDecoder("utf-8", { fatal: true }).decode(
		bytes.slice(0, column - 1),
	);
	let start = 0;
	for (let index = 0; index < line - 1; index++)
		start += (lines[index] as string).length + 1;
	return start + prefix.length;
}

function locateAbsentPath(
	cli: string,
	output: string,
	offset: number,
): AbsentPath | undefined {
	const named = output.match(BAD_COMMAND_NAME);
	if (named) {
		const segment = named[1] as string;
		if (cli.slice(offset, offset + segment.length) !== segment)
			return undefined;
		return cli[offset - 1] === "/"
			? slashRun(cli, offset, offset + segment.length)
			: spaceSpelling(cli, offset, segment);
	}
	if (!BARE_SYNTAX_ERROR.test(output) || cli[offset] !== "/") return undefined;
	let start = offset;
	while (start > 0 && NAME.test(cli[start - 1] as string)) start--;
	if (start === offset || cli[start - 1] !== "/") return undefined;
	return slashRun(cli, start, offset);
}

/**
 * `/a/b/<segment>` — walk back over `name/` pairs to the run's leading `/`, which
 * must sit at a statement boundary. A relative run (`../x`, `ip/x`) abstains.
 */
function slashRun(
	cli: string,
	start: number,
	end: number,
): AbsentPath | undefined {
	let runStart = start - 1;
	while (runStart > 0 && cli[runStart] === "/") {
		let nameStart = runStart;
		while (nameStart > 0 && NAME.test(cli[nameStart - 1] as string))
			nameStart--;
		if (nameStart === runStart) break;
		if (cli[nameStart - 1] !== "/") return undefined;
		runStart = nameStart - 1;
	}
	if (runStart > 0 && !RUN_BOUNDARY.test(cli[runStart - 1] as string))
		return undefined;
	const segments = cli
		.slice(runStart + 1, end)
		.toLowerCase()
		.split("/");
	return { segments, segment: cli.slice(start, end) };
}

/**
 * `/ip nosuchmenu print` — the parent comes from the offline analyzer's reading
 * of the statement that holds the segment. Menu-scope blocks and anything else
 * the analyzer did not resolve abstain, and so does a segment that appears more
 * than once (`/ip ip print`): which occurrence RouterOS rejected is not mapped.
 */
function spaceSpelling(
	cli: string,
	offset: number,
	segment: string,
): AbsentPath | undefined {
	const { structure } = explainCommand(cli);
	const holders = [...structure.statements, ...structure.subcommands]
		.filter(
			(entry) =>
				entry.resolution === "resolved" &&
				entry.command !== undefined &&
				entry.span.start <= offset &&
				offset < entry.span.end,
		)
		.sort((a, b) => a.span.end - a.span.start - (b.span.end - b.span.start));
	const command = holders[0]?.command;
	if (command === undefined) return undefined;
	const words = [
		...command.path.split("/").filter(Boolean),
		...("verb" in command ? [command.verb] : []),
	].map((word) => word.toLowerCase());
	const index = words.indexOf(segment.toLowerCase());
	if (index < 0 || words.lastIndexOf(segment.toLowerCase()) !== index)
		return undefined;
	return { segments: words.slice(0, index + 1), segment };
}

/** RouterOS accepts a unique prefix; resolve one against the catalog's children. */
function expandAbbreviations(segments: readonly string[]): string[] {
	const out: string[] = [];
	for (const segment of segments) {
		const parent = out.length === 0 ? "" : `/${out.join("/")}`;
		if (isPublished(`${parent}/${segment}`)) {
			out.push(segment);
			continue;
		}
		const children = new Set<string>();
		for (const path of publishedPaths())
			if (path.startsWith(`${parent}/${segment}`)) {
				const child = path.slice(parent.length + 1).split("/")[0] as string;
				children.add(child);
			}
		out.push(children.size === 1 ? ([...children][0] as string) : segment);
	}
	return out;
}

function* publishedPaths(): Iterable<string> {
	yield* PATH_CATALOG.keys();
	yield* MENU_PATHS;
}

/** A path, or anything under it, is in one of the two shipped tables. */
function isPublished(path: string): boolean {
	if (PATH_CATALOG.has(path) || MENU_PATHS.has(path)) return true;
	for (const known of publishedPaths())
		if (known.startsWith(`${path}/`)) return true;
	return false;
}

/**
 * The path's own gates, root-first. A container row the publication left ungated
 * (`/iot`) borrows the package every catalog row under it agrees on — all 62
 * `/iot/*` rows say `iot` — and borrows nothing when they disagree.
 */
function gatesOf(segments: readonly string[]): CatalogGate[] {
	const gates = effectiveGates(segments);
	if (gates.some((gate) => gate.package !== undefined)) return gates;
	const path = `/${segments.join("/")}`;
	const below = [...PATH_CATALOG].filter(([known]) =>
		known.startsWith(`${path}/`),
	);
	const packages = unique(below.map(([, entry]) => entry.package ?? ""));
	if (below.length > 0 && packages.length === 1 && packages[0] !== "")
		return [...gates, { path, package: packages[0] as string }];
	return gates;
}

function gateAdvice(gates: readonly CatalogGate[]): string {
	if (gates.length === 0)
		return "MikroTik publishes no package or hardware requirement for it, so the usual cause is the RouterOS version: compare `/system/resource/print` with the version that introduced the menu.";
	const parts = gates.map((gate) =>
		[
			gate.package && `package \`${gate.package}\``,
			gate.syscap && `hardware capability \`${gate.syscap}\``,
			gate.conditions && `build \`${gate.conditions}\``,
		]
			.filter(Boolean)
			.join(" and "),
	);
	return `MikroTik publishes it as needing ${unique(parts).join("; ")}. Check \`/system/package/print\` and the device model, or run this only on devices that have it.`;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}
