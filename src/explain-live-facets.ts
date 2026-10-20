/**
 * Live `--schema` (describe) and `--complete` (cursor completion) for explain
 * (#492). Read-only `/console/inspect` only; the analyzed input never runs.
 *
 * ## Which probe shapes are allowed (CHR 7.12.2 / 7.20.8 / 7.23.8 / 7.24.5)
 *
 * - `child` at any path: names, node kinds, unique-abbreviation resolution.
 * - `syntax` at an ARGUMENT path (`ip,address,add,comment`, `put,message`):
 *   declared type text.
 * - `completion` with `input=` (the text before the cursor) at any position,
 *   scripting keywords included: the device's own candidates.
 *
 * Never sent: `syntax` or `completion` with `path=` set to a COMMAND
 * (`ip,address,set`). On 7.12.2 and 7.20.8 REST stops answering for about
 * 30 s and native API closes the connection (`commands/api/AGENTS.md`). The
 * restraml crawlers never hit this: they send `syntax` to `arg` nodes only.
 *
 * ## Where the cursor is comes from the device
 *
 * Candidates and their replace offset come from input completion, so a
 * relative path, a block or a `where` clause completes exactly as on the
 * console. The highlight classes of the input before the cursor name the
 * context (path, argument name, variable, value). The command whose argument
 * syntax is read for a value is the offline statement when it resolved,
 * otherwise the `dir`/`cmd` runs the device highlighted.
 */
import {
	extractCompletionNames,
	type InspectCompletionItem,
	pathTokens,
} from "./core/inspect.ts";
import { CentrsError } from "./errors.ts";
import {
	analyzeCoordinates,
	byteToPosition,
	positionToByte,
	runAtByte,
} from "./explain/coordinates.ts";
import type {
	ExplainCompletion,
	ExplainCompletionCandidate,
	ExplainEvidence,
	ExplainSchema,
	ExplainSchemaChild,
	ExplainStatement,
	ExplainSubcommand,
	ExplainSyntaxRow,
} from "./explain.ts";
import type { LiveProbeContext } from "./explain-live.ts";

export interface ExplainLiveFacets {
	schema?: boolean;
	complete?: boolean;
	/**
	 * Default: end of input. A number is an analyzed byte offset (the device's
	 * UTF-8 byte offset); an object is an original-document position. Either
	 * snaps back to a character boundary.
	 */
	cursor?: number | { line: number; character: number };
	/** Lift the sizing limits up to the safety ceiling. */
	full?: boolean;
}

/** Listed names per list, and expansion probes per describe. */
export const EXPLAIN_FACET_LIMITS = {
	items: { default: 64, full: 1024 },
	probes: { default: 16, full: 128 },
} as const;

/** Validate a cursor before any connection is made. */
export function resolveExplainCursor(
	input: string,
	cursor: ExplainLiveFacets["cursor"],
): number {
	const coordinates = analyzeCoordinates(input);
	const bytes = coordinates.analyzed.length;
	if (cursor === undefined) return bytes;
	let byte: number;
	if (typeof cursor === "number") byte = cursor;
	else {
		try {
			byte = positionToByte(coordinates, cursor.line, cursor.character);
		} catch {
			throw invalidCursor(
				`(line ${cursor.line}, character ${cursor.character})`,
				bytes,
			);
		}
	}
	if (!Number.isInteger(byte) || byte < 0 || byte > bytes)
		throw invalidCursor(String(cursor), bytes);
	return byte === bytes ? byte : runAtByte(coordinates, byte).byteStart;
}

function invalidCursor(value: string, bytes: number): CentrsError {
	return new CentrsError({
		code: "usage/invalid-cursor",
		summary: `Cursor ${value} is not inside the ${bytes}-byte input.`,
		remediation: `Pass a UTF-8 byte offset from 0 to ${bytes}; omit --cursor to complete at the end of the input.`,
		context: { cursor: value, bytes },
	});
}

export async function collectExplainFacets(
	ctx: LiveProbeContext,
	facets: ExplainLiveFacets,
): Promise<void> {
	const cursor = resolveExplainCursor(ctx.input, facets.cursor);
	const limits = {
		items: EXPLAIN_FACET_LIMITS.items[facets.full ? "full" : "default"],
		probes: EXPLAIN_FACET_LIMITS.probes[facets.full ? "full" : "default"],
	};
	if (facets.schema) ctx.data.schema = await describe(ctx, cursor, limits);
	if (facets.complete)
		ctx.data.completion = await complete(ctx, cursor, limits);
}

type Limits = { items: number; probes: number };
type ChildRow = { type?: string; name?: string; "node-type"?: string };
type Reading = ExplainStatement | ExplainSubcommand;

// ---------------------------------------------------------------- describe

async function describe(
	ctx: LiveProbeContext,
	cursor: number,
	limits: Limits,
): Promise<ExplainSchema> {
	const reading = readingAt(ctx, cursor);
	const tokens = describeTokens(ctx, reading);
	const path = slashPath(tokens ?? []);
	const base = {
		path,
		...statementIdOf(reading),
		counts: {},
		truncated: false,
		next: [] as string[],
	};
	if (tokens === undefined) {
		const ev = ctx.evidence("child", {
			facet: "schema",
			outcome: "skipped",
			reason:
				"The statement at the cursor is not an absolute path or a resolved command.",
		});
		return {
			...base,
			path: "",
			ev: ev.id,
			node: "unknown",
			reason: ev.reason,
		};
	}
	const probe = await childProbe(ctx, tokens, "schema");
	const schema: ExplainSchema = { ...base, ev: probe.ev.id, node: "unknown" };
	if (!probe.rows) {
		schema.reason = probe.ev.reason;
		return schema;
	}
	const self = probe.rows.find((row) => row.type === "self");
	const children = probe.rows.filter((row) => row.type === "child");
	const kind = self?.["node-type"];
	if (!self || kind === undefined) {
		schema.reason = "The device reports nothing at this path.";
		return schema;
	}
	if (kind === "arg") {
		schema.node = "argument";
		const syntax = await syntaxProbe(ctx, tokens, "schema");
		if (syntax.rows) schema.syntax = syntax.rows;
		return schema;
	}
	if (kind === "cmd") {
		schema.node = "command";
		const names = childNames(children, (k) => k === "arg");
		schema.counts.arguments = names.length;
		const listed = cut(names, limits.items, schema);
		schema.arguments = listed.map((name) => ({ name }));
		if (listed.length <= limits.probes)
			for (const argument of schema.arguments) {
				const syntax = await syntaxProbe(
					ctx,
					[...tokens, argument.name],
					"schema",
				);
				argument.ev = syntax.ev.id;
				if (syntax.rows) argument.syntax = syntax.rows;
			}
		else {
			schema.truncated = true;
			schema.next = listed.slice(0, 3).map((name) => `${path}/${name}`);
		}
		if (tokens.at(-1) === "print" && tokens.length > 1)
			schema.proplist = await proplist(
				ctx,
				tokens.slice(0, -1),
				schema,
				limits,
			);
		return schema;
	}
	schema.node = "menu";
	const verbs = childNames(children, (k) => k === "cmd");
	const menus = childNames(children, (k) => k === "dir" || k === "path");
	schema.counts.verbs = verbs.length;
	schema.counts.menus = menus.length;
	schema.verbs = cut(verbs, limits.items, schema).map((name) => ({ name }));
	schema.menus = cut(menus, limits.items, schema).map((name) => ({ name }));
	const expand = [...schema.verbs, ...schema.menus];
	if (expand.length <= limits.probes)
		for (const child of expand) await expandChild(ctx, tokens, child);
	else {
		schema.truncated = true;
		schema.next = [...schema.verbs, ...schema.menus]
			.slice(0, 3)
			.map((child) => `${path === "/" ? "" : path}/${child.name}`);
	}
	return schema;
}

/** One more `child` per listed name: argument counts for a verb, sizes for a menu. */
async function expandChild(
	ctx: LiveProbeContext,
	tokens: string[],
	child: ExplainSchemaChild,
): Promise<void> {
	const probe = await childProbe(ctx, [...tokens, child.name], "schema");
	child.ev = probe.ev.id;
	if (!probe.rows) return;
	const rows = probe.rows.filter((row) => row.type === "child");
	const kind = probe.rows.find((row) => row.type === "self")?.["node-type"];
	if (kind === "cmd")
		child.arguments = childNames(rows, (k) => k === "arg").length;
	else {
		child.verbs = childNames(rows, (k) => k === "cmd").length;
		child.menus = childNames(rows, (k) => k === "dir" || k === "path").length;
	}
}

/**
 * `print proplist=` names; a singleton settings menu offers none, so its
 * `get value-name=` set answers instead (CHR 7.24.5: `/ip/dns`, `/system/identity`).
 */
async function proplist(
	ctx: LiveProbeContext,
	menu: string[],
	schema: ExplainSchema,
	limits: Limits,
): Promise<ExplainSchema["proplist"]> {
	let result: ExplainSchema["proplist"];
	for (const [source, verb, input] of [
		["print-proplist", "print", `${slashPath(menu)}/print proplist=`],
		["get-value-name", "get", `${slashPath(menu)}/get value-name=`],
	] as const) {
		const probe = await completionProbe(
			ctx,
			input,
			slashPath([...menu, verb]),
			"schema",
		);
		if (!probe.rows) return result;
		const names = [...new Set(shownNames(probe.rows))].sort();
		result = { ev: probe.ev.id, source, names };
		if (names.length > 0) break;
	}
	if (result) {
		schema.counts.proplist = result.names.length;
		result.names = cut(result.names, limits.items, schema);
	}
	return result;
}

/** The path `--schema` describes: the resolved statement, or an absolute path as typed. */
function describeTokens(
	ctx: LiveProbeContext,
	reading: Reading | undefined,
): string[] | undefined {
	if (reading?.resolution === "resolved")
		return pathTokens(
			reading.kind === "command"
				? `${reading.command.path}/${reading.command.verb}`
				: reading.command.path,
		);
	const text = reading
		? ctx.analyzed.slice(reading.span.start, reading.span.end).trim()
		: ctx.analyzed.trim();
	return /^\/[A-Za-z0-9._/-]*$/.test(text) ? pathTokens(text) : undefined;
}

// ---------------------------------------------------------------- complete

type CursorRole =
	| { context: "path"; start: number }
	| { context: "argument-name"; start: number }
	| { context: "variable"; start: number }
	| { context: "value"; start: number; argument: string; query: boolean }
	| { context: "unsupported"; start: number; reason: string };

async function complete(
	ctx: LiveProbeContext,
	cursor: number,
	limits: Limits,
): Promise<ExplainCompletion> {
	const at = byteToPosition(analyzeCoordinates(ctx.input), cursor);
	const reading = readingAt(ctx, cursor);
	const result: ExplainCompletion = {
		cursor,
		at: { line: at.line, character: at.col },
		...statementIdOf(reading),
		context: "unsupported",
		replace: { start: cursor, end: cursor },
		prefix: "",
		candidates: [],
		count: 0,
		truncated: false,
	};
	const classes = await cursorClasses(ctx, cursor);
	if (!classes) {
		result.reason =
			"No device highlight covers the cursor, so its role is unknown.";
		return result;
	}
	const role = cursorRole(ctx.analyzed, classes, cursor);
	result.replace = { start: role.start, end: cursor };
	result.prefix = ctx.analyzed.slice(role.start, cursor);
	if (role.context === "unsupported") {
		result.reason = role.reason;
		return result;
	}
	result.context = role.context;
	const command =
		role.context === "path"
			? undefined
			: reading?.resolution === "resolved" && reading.kind === "command"
				? pathTokens(`${reading.command.path}/${reading.command.verb}`)
				: commandPath(ctx.analyzed, classes, role.start);
	if (command) result.path = slashPath(command);
	if (role.context === "value") result.argument = role.argument;

	const probe = await completionProbe(
		ctx,
		ctx.analyzed.slice(0, cursor),
		result.path ?? "",
		"complete",
	);
	const rows = probe.rows ?? [];
	// Navigation punctuation (`/`, `:`, `..`) is offered everywhere; it names nothing.
	const shown = rows.filter(
		(row) =>
			row["show"] === "true" &&
			row["style"] !== "syntax-meta" &&
			/[A-Za-z0-9]/.test(String(row["completion"] ?? "")),
	);
	const offset = Number(shown[0]?.["offset"]);
	if (Number.isInteger(offset) && offset >= 0 && offset <= cursor) {
		result.replace = { start: offset, end: cursor };
		result.prefix = ctx.analyzed.slice(offset, cursor);
	}
	const candidates = new Map<string, ExplainCompletionCandidate>();
	for (const row of shown) {
		const text = String(row["completion"]).trim();
		const kind: ExplainCompletionCandidate["kind"] =
			role.context === "path"
				? row["style"] === "cmd"
					? "verb"
					: "menu"
				: role.context === "argument-name"
					? "argument"
					: role.context;
		if (!candidates.has(text))
			candidates.set(text, {
				text,
				kind,
				match: text === result.prefix ? "exact" : "partial",
				ev: probe.ev.id,
			});
	}
	if (
		role.context === "argument-name" &&
		candidates.get(result.prefix)?.match === "exact"
	)
		// The device offers `=` right at the cursor only for a name that takes a value.
		result.takesValue = rows.some(
			(row) =>
				row["style"] === "syntax-meta" &&
				row["completion"] === "=" &&
				Number(row["offset"]) === cursor,
		);
	if (role.context === "value" && command && !role.query) {
		const syntax = await syntaxProbe(
			ctx,
			[...command, role.argument],
			"complete",
		);
		if (syntax.rows) result.syntax = syntax.rows;
	}
	return finish(result, [...candidates.values()], limits, probe.ev);
}

function finish(
	result: ExplainCompletion,
	candidates: ExplainCompletionCandidate[],
	limits: Limits,
	ev: ExplainEvidence,
): ExplainCompletion {
	result.count = candidates.length;
	result.truncated = candidates.length > limits.items;
	result.candidates = candidates.slice(0, limits.items);
	if (ev.outcome !== "ok" && ev.outcome !== "empty") result.reason = ev.reason;
	return result;
}

/** Highlight classes for the input before the cursor, reusing the full probe at the end. */
async function cursorClasses(
	ctx: LiveProbeContext,
	cursor: number,
): Promise<string[] | undefined> {
	if (cursor === ctx.analyzed.length) return ctx.data.live?.highlight?.classes;
	if (cursor === 0) return [];
	const prefix = ctx.analyzed.slice(0, cursor);
	const ev = ctx.evidence("highlight", {
		facet: "complete",
		coverage: { start: 0, end: cursor },
		inputSha256: ctx.sha256(prefix),
		normalization: "sub-per-non-ascii-byte",
	});
	if (cursor > ctx.highlightBytes) {
		ev.outcome = "skipped";
		ev.reason = `The input before the cursor exceeds the ${ctx.highlightBytes}-byte highlight limit.`;
		delete ev.coverage;
		return undefined;
	}
	const rows = await ctx.run(ev, () =>
		ctx.backend.inspect("highlight", "", prefix),
	);
	const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
	const classes =
		row &&
		typeof row === "object" &&
		"highlight" in row &&
		typeof row.highlight === "string"
			? row.highlight.split(",")
			: undefined;
	if (rows !== undefined && classes?.length !== cursor) {
		ev.outcome = "invalid-response";
		ev.reason = "Highlight length does not match the bytes before the cursor.";
		delete ev.coverage;
		return undefined;
	}
	return classes;
}

// cspell:ignore omm forw
const WORD = /[A-Za-z0-9._-]/;

/**
 * The cursor's role from the device classes (CHR 7.24.5):
 * `dir[/ip/address] cmd[add] error[c] arg[omm]`, `arg[chain] syntax-meta[=] none[forw]`.
 * A word the device cannot resolve there is `obj-inactive` (`dir[:] obj-inactive[lo]`,
 * `cmd[add] none[ ] obj-inactive[zz]`); what precedes it gives its role.
 */
export function cursorRole(
	text: string,
	classes: readonly string[],
	cursor: number,
): CursorRole {
	const before = text[cursor - 1];
	if (before === undefined) return { context: "path", start: 0 };
	if (!/\s/.test(before)) {
		const cls = classes[cursor - 1];
		let start = cursor;
		while (start > 0 && WORD.test(text[start - 1] ?? "")) start--;
		if (cls === "arg") return { context: "argument-name", start };
		if (cls === "dir" || cls === "cmd") return { context: "path", start };
		if (cls?.startsWith("variable-")) return { context: "variable", start };
		const value = valueStart(text, classes, cursor);
		if (value) return { context: "value", ...value };
		if (cls === "obj-inactive") return followingRole(text, classes, start);
		return {
			context: "unsupported",
			start: cursor,
			reason: `The cursor is in a \`${cls ?? "unknown"}\` token; completion covers paths, argument names and argument values.`,
		};
	}
	if (/[\r\n]/.test(before)) return { context: "path", start: cursor };
	if (classes[cursor - 1] === "syntax-obsolete")
		return {
			context: "unsupported",
			start: cursor,
			reason:
				"The cursor follows an argument name and a space (obsolete `name value` spelling); use `name=`.",
		};
	// `where ⎀`: the device marks the query's separating space as syntax.
	if (classes[cursor - 1] === "syntax-meta")
		return { context: "variable", start: cursor };
	return followingRole(text, classes, cursor);
}

/** The role of a word starting at `start`, from the token before it. */
function followingRole(
	text: string,
	classes: readonly string[],
	start: number,
): CursorRole {
	let last = start - 1;
	while (last >= 0 && /[ \t]/.test(text[last] ?? "")) last--;
	const cls = classes[last];
	if (
		cls === "cmd" ||
		cls === "arg" ||
		(cls === "none" && valueStart(text, classes, last + 1))
	)
		return { context: "argument-name", start };
	if (cls === "dir") return { context: "path", start };
	return {
		context: "unsupported",
		start,
		reason: "The cursor does not follow a path, a command or an argument.",
	};
}

/**
 * `arg[name] syntax-meta[=] none[value]` ending at `end`. In a `where` clause
 * the name is a `variable-*` (`variable-local[disabled] syntax-meta[=]`).
 */
function valueStart(
	text: string,
	classes: readonly string[],
	end: number,
): { start: number; argument: string; query: boolean } | undefined {
	let equals = end - 1;
	while (equals >= 0 && classes[equals] === "none") equals--;
	if (text[equals] !== "=" || classes[equals] !== "syntax-meta") return;
	const nameClass = classes[equals - 1];
	const query = nameClass?.startsWith("variable-") === true;
	if (nameClass !== "arg" && !query) return;
	let name = equals;
	while (name > 0 && classes[name - 1] === nameClass) name--;
	return { start: equals + 1, argument: text.slice(name, equals), query };
}

/**
 * The command (menu tokens plus the verb) from the `dir`/`cmd` runs before
 * `start`. Groups closed before the cursor are skipped; a `{` continues
 * outward only after a menu (`/ip { address …`). Relative runs are accepted at
 * the start of the input only, where the context is the root.
 */
function commandPath(
	text: string,
	classes: readonly string[],
	start: number,
): string[] | undefined {
	const runs: string[] = [];
	let command: string | undefined;
	let depth = 0;
	let i = start - 1;
	for (; i >= 0; i--) {
		const ch = text[i] ?? "";
		const cls = classes[i];
		if (cls === "syntax-meta" && (ch === "]" || ch === ")" || ch === "}")) {
			depth++;
			continue;
		}
		if (cls === "syntax-meta" && (ch === "[" || ch === "(" || ch === "{")) {
			if (depth > 0) {
				depth--;
				continue;
			}
			if (ch !== "{" || runs.length === 0 || command === undefined) return;
			continue;
		}
		if (depth > 0) continue;
		if (ch === ";" || ch === "\n" || ch === "\r") return;
		if (cls === "cmd") {
			if (command !== undefined || runs.length > 0) return;
			let s = i;
			while (s > 0 && classes[s - 1] === "cmd") s--;
			command = text.slice(s, i + 1);
			i = s;
			continue;
		}
		if (cls === "dir") {
			let s = i;
			while (s > 0 && classes[s - 1] === "dir") s--;
			const run = text.slice(s, i + 1);
			runs.unshift(run);
			i = s;
			if (run.startsWith("/") || run.startsWith(":")) break;
		}
	}
	if (command === undefined) return;
	const absolute = runs[0]?.startsWith("/") || runs[0]?.startsWith(":");
	if (!absolute && i >= 0) return;
	return [
		...runs.flatMap((run) => run.split(/[/\s:]+/).filter(Boolean)),
		command,
	];
}

// ---------------------------------------------------------------- probes

/**
 * The innermost statement or `[…]` substitution at the cursor. Trailing
 * spaces belong to the reading before them (`/ip/address add ⎀`).
 */
function readingAt(ctx: LiveProbeContext, cursor: number): Reading | undefined {
	let found: Reading | undefined;
	const { statements, subcommands } = ctx.data.structure;
	for (const reading of [...statements, ...subcommands]) {
		const { start, end } = reading.span;
		const inside =
			start <= cursor &&
			(cursor <= end || /^[ \t]*$/.test(ctx.analyzed.slice(end, cursor)));
		if (inside && (!found || start >= found.span.start)) found = reading;
	}
	return found;
}

function statementIdOf(reading: Reading | undefined): { statementId?: string } {
	if (!reading) return {};
	return { statementId: "owner" in reading ? reading.owner : reading.id };
}

async function childProbe(
	ctx: LiveProbeContext,
	tokens: string[],
	facet: "schema" | "complete",
): Promise<{ ev: ExplainEvidence; rows?: ChildRow[] }> {
	const ev = ctx.evidence("child", { facet, path: slashPath(tokens) });
	const rows = await ctx.run(ev, async () => {
		try {
			return await ctx.backend.inspect("child", tokens.join(","));
		} catch (error) {
			// REST answers an unknown path with []; native API traps.
			if (
				error instanceof CentrsError &&
				(error.code === "routeros/unknown-path" ||
					error.code === "routeros/api-trap")
			)
				return [];
			throw error;
		}
	});
	return { ev, rows: objectRows(ev, rows) as ChildRow[] | undefined };
}

/** Argument paths only: a command path hangs REST on 7.12.2 and 7.20.8. */
async function syntaxProbe(
	ctx: LiveProbeContext,
	tokens: string[],
	facet: "schema" | "complete",
): Promise<{ ev: ExplainEvidence; rows?: ExplainSyntaxRow[] }> {
	const ev = ctx.evidence("syntax", { facet, path: slashPath(tokens) });
	const rows = objectRows(
		ev,
		await ctx.run(ev, () => ctx.backend.inspect("syntax", tokens.join(","))),
	);
	return {
		ev,
		rows: rows
			?.map((row) => ({
				symbol: String(row["symbol"] ?? ""),
				kind: String(row["symbol-type"] ?? ""),
				text: String(row["text"] ?? ""),
				depth: Number(row["nested"] ?? 0),
			}))
			// A flag's only row is blank (`detail`, `disabled`); it says nothing.
			.filter((row) => row.symbol !== "" || row.text !== ""),
	};
}

/** Input-based only; `path=` completion at a command hangs REST on 7.12.2. */
async function completionProbe(
	ctx: LiveProbeContext,
	input: string,
	path: string,
	facet: "schema" | "complete",
): Promise<{ ev: ExplainEvidence; rows?: Record<string, unknown>[] }> {
	const ev = ctx.evidence("completion", {
		facet,
		...(path ? { path } : {}),
		inputSha256: ctx.sha256(input),
		normalization: "sub-per-non-ascii-byte",
	});
	return {
		ev,
		rows: objectRows(
			ev,
			await ctx.run(ev, () => ctx.backend.inspect("completion", "", input)),
		),
	};
}

function objectRows(
	ev: ExplainEvidence,
	rows: unknown[] | undefined,
): Record<string, unknown>[] | undefined {
	if (rows === undefined) return undefined;
	if (
		!Array.isArray(rows) ||
		rows.some((row) => row === null || typeof row !== "object")
	) {
		ev.outcome = "invalid-response";
		ev.reason = "Response is not an array of rows.";
		return undefined;
	}
	if (rows.length === 0) ev.outcome = "empty";
	return rows as Record<string, unknown>[];
}

function shownNames(rows: readonly Record<string, unknown>[]): string[] {
	return extractCompletionNames(rows as readonly InspectCompletionItem[]);
}

function childNames(
	rows: readonly ChildRow[],
	kind: (nodeType: string | undefined) => boolean,
): string[] {
	return [
		...new Set(
			rows
				.filter((row) => kind(row["node-type"]))
				.map((row) => row.name)
				.filter(
					(name): name is string => typeof name === "string" && name.length > 0,
				),
		),
	];
}

function cut(names: string[], limit: number, schema: ExplainSchema): string[] {
	if (names.length <= limit) return names;
	schema.truncated = true;
	return names.slice(0, limit);
}

function slashPath(tokens: readonly string[]): string {
	return `/${tokens.join("/")}`;
}
