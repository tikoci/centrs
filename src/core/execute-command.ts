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
 * discriminator for which validation and transport path runs. Write-shape
 * detection is intentionally independent: a raw-script fallback must not bypass
 * confirmation merely because it cannot be represented as attributes. centrs
 * owns this gate; the shared,
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
	if (command.mode === "structured") {
		if (FILE_OUTPUT_ATTRIBUTE in command.attributes) {
			return true;
		}
		return !READ_ONLY_EXECUTE_VERBS.has(command.verb.toLowerCase());
	}
	return scriptContainsWriteShapedCommand(command.input);
}

/**
 * The attribute that turns an otherwise read-only verb into a device write.
 *
 * RouterOS routes command output to a file on the device when `file=` is
 * supplied, so a read verb creates a file: `/ip/address/export file=address`
 * writes `address.rsc`, and `/file/print file=test` writes `test.txt` (both
 * from the RouterOS manual — "Configuration Export" and "Scripting Tips and
 * Tricks", where that idiom is the documented way to create a file and needs
 * the script `write` policy). The verb allowlist cannot see that, so the
 * attribute is checked independently of it.
 */
const FILE_OUTPUT_ATTRIBUTE = "file";

/** True for a `file=<name>` token — the write-shaping output redirect. */
function isFileOutputToken(token: string): boolean {
	return token.startsWith(`${FILE_OUTPUT_ATTRIBUTE}=`);
}

/**
 * Commands that are safe to execute without write confirmation.
 *
 * This is deliberately an allowlist: RouterOS publishes no mutation bit for a
 * command, and treating a newly introduced verb as read-only would silently
 * widen the execution boundary. False positives require `--yes`; false
 * negatives mutate a router. API uses the same conservative rule (only
 * print/get/listen are read-classed).
 */
const READ_ONLY_EXECUTE_VERBS: ReadonlySet<string> = new Set([
	"check",
	"check-installation",
	"export",
	"find",
	"get",
	"monitor",
	"monitor-traffic",
	"ping",
	"print",
	"scan",
	"sniff",
	"torch",
	"traceroute",
]);

/** Known mutators disambiguate the space-separated CLI spelling from a menu. */
const KNOWN_WRITE_EXECUTE_VERBS: ReadonlySet<string> = new Set([
	"add",
	"comment",
	"delete",
	"disable",
	"edit",
	"enable",
	"flush",
	"format",
	"format-drive",
	"import",
	"install",
	"move",
	"password",
	"reboot",
	"redo",
	"remove",
	"reset",
	"reset-configuration",
	"reset-counters",
	"reset-counters-all",
	"run",
	"set",
	"shutdown",
	"sign",
	"start",
	"stop",
	"unset",
	"upgrade",
	"undo",
]);

/** Script directives that can launch a command outside the visible statement. */
const WRITE_SHAPED_SCRIPT_DIRECTIVES: ReadonlySet<string> = new Set([
	":execute",
]);

/** Script directives that are safe to run without device-write confirmation. */
const READ_ONLY_SCRIPT_DIRECTIVES: ReadonlySet<string> = new Set([
	":error",
	":local",
	":put",
]);

function isKnownExecuteVerb(value: string): boolean {
	const normalized = value.toLowerCase();
	return (
		READ_ONLY_EXECUTE_VERBS.has(normalized) ||
		KNOWN_WRITE_EXECUTE_VERBS.has(normalized)
	);
}

function scriptContainsWriteShapedCommand(input: string): boolean {
	for (const statement of splitUnquotedStatements(input)) {
		const tokens = tokenizeRouterOsCli(statement);
		// `file=` redirects output to a device file, so it is a write even under a
		// read verb. Checked before the verb rules for the same reason the
		// structured branch checks it independently of the allowlist.
		if (
			tokens.some((token) => isFileOutputToken(trimGroupingPunctuation(token)))
		) {
			return true;
		}
		// A script may navigate to a menu on one line and use a relative verb on
		// the next. Recognize grounded mutators even when no slash appears in that
		// statement; quoted words were masked before tokenization.
		if (
			tokens.some((token) =>
				KNOWN_WRITE_EXECUTE_VERBS.has(trimGroupingPunctuation(token)),
			)
		) {
			return true;
		}
		if (
			tokens.some((token) =>
				WRITE_SHAPED_SCRIPT_DIRECTIVES.has(token.replace(/^[{[(]+/, "")),
			)
		) {
			return true;
		}
		const pathIndex = tokens.findIndex((token) => /^[{[(]*\//.test(token));
		if (pathIndex < 0) {
			const normalizedTokens = tokens
				.map(trimGroupingPunctuation)
				.filter((token) => token.length > 0);
			if (normalizedTokens.length === 0) continue;
			if (READ_ONLY_SCRIPT_DIRECTIVES.has(normalizedTokens[0] ?? "")) {
				continue;
			}
			if (
				normalizedTokens.some((token) =>
					READ_ONLY_EXECUTE_VERBS.has(token.toLowerCase()),
				)
			) {
				continue;
			}
			// A space-separated path or relative command with an unknown head cannot
			// be proven read-only. Fail closed so new RouterOS mutators do not bypass
			// confirmation merely because centrs has not learned their verb yet.
			return true;
		}

		const pathToken = (tokens[pathIndex] ?? "").replace(/^[{[(]+/, "");
		const pathParts = pathToken.split("/").filter(Boolean);
		const lastPathPart = pathParts.at(-1) ?? "";
		const following = tokens[pathIndex + 1];
		const spacedVerb =
			following !== undefined && /^[A-Za-z][A-Za-z0-9-]*$/.test(following)
				? following
				: undefined;
		if (
			pathParts.length < 2 &&
			!isKnownExecuteVerb(lastPathPart) &&
			(spacedVerb === undefined || !isKnownExecuteVerb(spacedVerb))
		) {
			// A slash-rooted statement that cannot be proven to end in a known read
			// verb may be menu navigation for a following relative command. Fail
			// closed for the whole script rather than trying to infer that context.
			return true;
		}
		const verb = (
			spacedVerb !== undefined && isKnownExecuteVerb(spacedVerb)
				? spacedVerb
				: isKnownExecuteVerb(lastPathPart)
					? lastPathPart
					: (spacedVerb ?? lastPathPart)
		).toLowerCase();
		if (verb.length > 0 && !READ_ONLY_EXECUTE_VERBS.has(verb)) {
			return true;
		}
	}
	return false;
}

function trimGroupingPunctuation(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && "{[(".includes(value[start] ?? "")) start += 1;
	while (end > start && "}])".includes(value[end - 1] ?? "")) end -= 1;
	return value.slice(start, end);
}

/** Split only at real statement boundaries; quoted output is not executable. */
function splitUnquotedStatements(input: string): string[] {
	const statements: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const char of input) {
		if (escaped) {
			current += quote ? " " : char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			current += quote ? " " : char;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			current += " ";
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += " ";
			continue;
		}
		if (char === ";" || char === "\n" || char === "\r") {
			statements.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	statements.push(current);
	return statements;
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
