/**
 * Shared `/console/inspect` client primitives.
 *
 * `retrieve` and `execute` each grew their own private copy of these helpers
 * (path tokenizing, the comma-path join, node-type predicates, completion-name
 * extraction). This module is the single home so a third consumer — `api`, and a
 * future `explain`/`check` — reuses one grounded implementation instead of
 * forking a fourth. It deliberately holds only the transport-agnostic
 * *primitives*; each command composes its own discovery strategy on top (their
 * strategies differ: `retrieve` probes print/get support, `execute` unions
 * child-args with completions), so the strategy stays in the command.
 *
 * Grounding: the request modes mirror `tikoci/lsp-routeros-ts`
 * (`server/src/routeros.ts` `InspectRequest`). The behavioral facts (the array-
 * typed `path`, completion shapes) are confirmed on CHR 7.23.1 in
 * `commands/api/AGENTS.md` — read that before changing wire behavior here.
 */

import { CentrsError } from "../errors.ts";

/**
 * The transport seam this module needs. A {@link ProtocolAdapter} satisfies it
 * structurally; depending on the narrow shape keeps `core/` decoupled from the
 * protocol layer (no import cycle).
 */
export interface InspectBackend {
	inspect(request: "child" | "completion", path: string): Promise<unknown[]>;
}

/**
 * The `/console/inspect` request modes (lsp's `InspectRequest`). Only `child`
 * and `completion` are wired today (the two the {@link InspectBackend} seam
 * exposes); `highlight` (token-level error detection) and `syntax` (parse tree),
 * plus the `input`/`.query`/`.proplist` request fields, are the documented
 * Phase-2 extension point for value-level validation — widen the adapter seam
 * when adding them.
 */
export type InspectRequestKind =
	| "child"
	| "completion"
	| "highlight"
	| "syntax";

/** A row from `request=child`: a menu/argument node under a path. */
export interface InspectChildItem {
	type?: string;
	name?: string;
	"node-type"?: string;
}

/** A row from `request=completion`: a candidate token for a path/argument. */
export interface InspectCompletionItem {
	type?: string;
	name?: string;
	completion?: string;
	value?: string;
	text?: string;
}

/**
 * Split a slash RouterOS path into menu tokens, dropping the leading slash and
 * empties: `"/ip/address"` → `["ip", "address"]`.
 */
export function pathTokens(path: string): string[] {
	return path.split("/").filter(Boolean);
}

/**
 * Join menu tokens into the COMMA form `/console/inspect` expects for its `path`
 * argument: `["ip", "address"]` → `"ip,address"`.
 *
 * The inspect `path` argument is internally a RouterOS *array*: a comma string
 * is `:toarray`-split into the menu-walk tokens, whereas a `/`-prefixed command
 * string is not split and matches no menu (confirmed on CHR 7.23.1 — slash forms
 * return nothing; see `commands/api/AGENTS.md`). So callers must pass tokens
 * joined by comma, never a slash command.
 */
export function inspectPath(tokens: readonly string[]): string {
	return tokens.join(",");
}

/** True for an argument (`arg`) node from `request=child`. */
export function isArgumentNode(child: InspectChildItem): boolean {
	return child.type === "arg" || child["node-type"] === "arg";
}

/** True for a command (`cmd`) node with the given name (e.g. `print`, `get`). */
export function isCommandNode(child: InspectChildItem, name: string): boolean {
	return (
		child.name === name &&
		(child.type === "cmd" || child["node-type"] === "cmd")
	);
}

/**
 * Flatten completion rows into attribute names. Reads every name-ish field a
 * RouterOS build might populate (`completion`/`name`/`value`/`text`), strips a
 * trailing `=value` suffix, and drops blanks. Returns the names in row order
 * **without** de-duplication or sorting — callers that need a stable set wrap
 * with `[...new Set(names)].sort()` (both current callers do).
 */
export function extractCompletionNames(
	rows: readonly InspectCompletionItem[],
): string[] {
	return rows
		.flatMap((row) => [row.completion, row.name, row.value, row.text])
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.replace(/=.*$/, "").trim())
		.filter((value) => value.length > 0);
}

/** `request=child` for a token path. */
export async function inspectChildren(
	backend: InspectBackend,
	tokens: readonly string[],
): Promise<InspectChildItem[]> {
	return (await backend.inspect(
		"child",
		inspectPath(tokens),
	)) as InspectChildItem[];
}

/** `request=completion` for a token path. */
export async function inspectCompletions(
	backend: InspectBackend,
	tokens: readonly string[],
): Promise<InspectCompletionItem[]> {
	return (await backend.inspect(
		"completion",
		inspectPath(tokens),
	)) as InspectCompletionItem[];
}

/**
 * {@link inspectChildren} that swallows a "path not found" trap to an empty
 * list, so the caller can classify the absence itself (REST returns an empty
 * child list; native traps). Only the two grounded not-found codes are
 * swallowed — `routeros/unknown-path` (the classified form) and the legacy
 * `routeros/api-trap` catch-all; every other error propagates. Use this for the
 * existence probe, not for attribute/value discovery (where a trap is a real
 * failure).
 */
export async function inspectChildrenOrEmpty(
	backend: InspectBackend,
	tokens: readonly string[],
): Promise<InspectChildItem[]> {
	try {
		return await inspectChildren(backend, tokens);
	} catch (error) {
		if (
			error instanceof CentrsError &&
			(error.code === "routeros/api-trap" ||
				error.code === "routeros/unknown-path")
		) {
			return [];
		}
		throw error;
	}
}
