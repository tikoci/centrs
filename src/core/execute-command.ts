/**
 * The **script-vs-structured execution gate** and its canonical command shape.
 *
 * `execute.ts` owned this pair, which put every consumer of the gate — the MCP
 * tool surface and `explain`'s offline analysis among them — one import away
 * from the transport stack (`mac-telnet` -> `node:dgram`, `native-api` ->
 * `node:crypto`). The functions themselves are pure string work, so they live in
 * `src/core/` and `execute.ts` re-exports them: the public API, the locked
 * contract table in `test/unit/execute-canonicalize-contract.test.ts`, and the
 * gate's behavior are all unchanged by the move (#312).
 *
 * Nothing here reads settings, the filesystem, CDB, or a device. Changing that
 * re-couples `explain`'s browser entry to the transport graph.
 */

export interface CanonicalExecuteCommand {
	mode: "structured" | "script";
	input: string;
	path: string;
	verb: string;
	attributes: Record<string, string>;
	queries: string[];
}

/**
 * The **script-vs-structured execution gate** — centrs's load-bearing
 * discriminator (with {@link isWriteShaped}) for which validation runs and
 * whether the write-confirmation prompt fires. centrs owns this gate; the shared,
 * prose-tolerant, multi-command canonicalizer that `rosetta` / `lsp-routeros-ts`
 * publish is for *canonicalization*, never the structured-mode predicate —
 * widening what counts as `structured` is a product regression. Behavior is
 * pinned by `test/unit/execute-canonicalize-contract.test.ts`.
 *
 * centrs deliberately does **not** vendor the shared parser yet. Preconditions
 * for adopting it: (1) that contract stays green (no gate widening); (2) the
 * vendored file is clean under centrs's strict `tsconfig` (or explicitly
 * quarantined with justification); (3) `lsp-routeros-ts` also vendors/consumes
 * the same parser shape, so it is genuinely shared, not a premature first copy.
 */
export function canonicalizeExecuteCommand(
	input: string,
): CanonicalExecuteCommand {
	const asScript = (): CanonicalExecuteCommand => ({
		mode: "script",
		input,
		path: "",
		verb: "",
		attributes: {},
		queries: [],
	});

	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) {
		return asScript();
	}

	const tokens = tokenizeRouterOsCli(trimmed);
	const pathToken = tokens[0] ?? "";
	const pathParts = pathToken.split("/").filter(Boolean);
	if (pathParts.length < 2) {
		return asScript();
	}

	const verb = pathParts.at(-1) ?? "";
	const path = `/${pathParts.slice(0, -1).join("/")}`;
	const attributes: Record<string, string> = {};
	const queries: string[] = [];
	for (const token of tokens.slice(1)) {
		// `[...]` subshell selectors (e.g. `numbers=[find ...]`) cannot be
		// represented as a structured attribute map: the inner command contains
		// spaces this tokenizer splits on, which would mangle a write-shaped
		// command into corrupt key=value pairs. Fall back to the raw-script path
		// so RouterOS evaluates the subshell with its real semantics.
		if (token.includes("[") || token.includes("]")) {
			return asScript();
		}
		if (token.startsWith("?")) {
			queries.push(token);
			continue;
		}
		const separator = token.indexOf("=");
		if (separator <= 0) {
			return asScript();
		}
		attributes[token.slice(0, separator)] = token.slice(separator + 1);
	}

	return {
		mode: "structured",
		input,
		path,
		verb,
		attributes,
		queries,
	};
}

export function isWriteShaped(command: CanonicalExecuteCommand): boolean {
	return (
		command.mode === "structured" &&
		["add", "set", "remove"].includes(command.verb)
	);
}

function tokenizeRouterOsCli(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const char of input) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (escaped) {
		current += "\\";
	}
	if (current.length > 0) {
		tokens.push(current);
	}
	return tokens;
}
