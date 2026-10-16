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

import { isKnownMenuPath } from "../explain/is-known-menu.ts";

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
		if (Object.keys(command.attributes).some(isFileOutputAttribute)) {
			return true;
		}
		return !READ_ONLY_EXECUTE_VERBS.has(command.verb.toLowerCase());
	}
	return scriptContainsWriteShapedCommand(command.input);
}

/**
 * The attributes that turn an otherwise read-only command into a device write.
 *
 * RouterOS routes command output to a file on the device when `file=` is
 * supplied, so a read verb creates a file: `/ip/address/export file=address`
 * writes `address.rsc`, and `/file/print file=test` writes `test.txt` (both
 * from the RouterOS manual — "Configuration Export" and "Scripting Tips and
 * Tricks", where that idiom is the documented way to create a file and needs
 * the script `write` policy). `:serialize` spells it `file-name=` (its
 * `/console/inspect` arguments, 7.13.5 through 7.26beta1). The verb and
 * directive allowlists cannot see either, so they are checked independently.
 */
const FILE_OUTPUT_ATTRIBUTES: readonly string[] = ["file", "file-name"];

/**
 * RouterOS accepts argument prefixes (`fi=`, `file-n=`), including on
 * `:serialize` (CHR 7.26beta1). An ambiguous prefix stays write-shaped too:
 * only the device can disambiguate it, so the local gate fails closed.
 */
function isFileOutputAttribute(name: string): boolean {
	return (
		name.length > 0 &&
		FILE_OUTPUT_ATTRIBUTES.some((full) => full.startsWith(name))
	);
}

/** True for an output-file argument, including its abbreviated spellings. */
function isFileOutputToken(token: string): boolean {
	const separator = token.indexOf("=");
	return separator > 0 && isFileOutputAttribute(token.slice(0, separator));
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

/**
 * Script directives that are safe to run without device-write confirmation:
 * output, control flow and pure value functions, all members of `explain`'s
 * grounded root-cmd vocabulary (`ROOT_CMDS` in `src/explain/write.ts`) and
 * present on 7.26beta1. A directive's `do={…}` or `[…]` body is its own
 * command head and is checked on its own. That holds because a script-typed
 * argument (`:do command=`, `:if do=`, `:retry command=`, `:time`, `:onerror
 * in=`) runs only a `{…}` block: RouterOS refuses a quoted string or a variable
 * holding one there as an invalid value (CHR 7.24.5 and 7.26beta1, #458), so
 * no body can hide in text the gate blanks. The value functions (#458) take
 * only values; `:serialize` alone can write, through `file-name=` (it creates
 * the file on 7.26beta1), which the file-output check catches.
 *
 * Deliberately absent: `:execute` and `:parse` (run built code), `:global` and
 * `:set` (outlive the script), and `:import`, `:password`, `:undo`, `:redo`
 * (configuration changes). A directive missing here costs `--yes`; one wrongly
 * here bypasses the gate.
 */
const READ_ONLY_SCRIPT_DIRECTIVES: ReadonlySet<string> = new Set([
	":break",
	":continue",
	":convert",
	":delay",
	":deserialize",
	":do",
	":error",
	":find",
	":for",
	":foreach",
	":if",
	":jobname",
	":len",
	":local",
	":nothing",
	":onerror",
	":pick",
	":put",
	":range",
	":retry",
	":return",
	":rndnum",
	":rndstr",
	":serialize",
	":time",
	":timestamp",
	":toarray",
	":tobool",
	":tocrlf",
	":toid",
	":toip",
	":toip6",
	":tolf",
	":tonsec",
	":tonum",
	":tostr",
	":totime",
	":typeof",
	":while",
]);

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
		// Every command the statement runs must be proven read-only, not just the
		// first: `:foreach i in=[/ip address find] do={/user expire-password $i}`
		// reads with `find` and writes with an unlearned mutator.
		if (
			!commandHeads(statement).every(
				(head) => !head.spacedFileOutput && isReadOnlyCommand(head.words),
			)
		) {
			return true;
		}
	}
	return false;
}

/**
 * The commands a statement runs: one at its start and one after every `[` or
 * `{`, wherever that opener sits — an argument value (`in=[/ip address find]`,
 * `do={/user expire-password $i}`), a sigil (`$[…]`), a concatenation
 * (`"x".[…]`) or a token of its own (`do={ /user … }`). Parentheses group
 * expressions, not commands, so they do not start one. Each head reads only up
 * to the next opener, which begins its own head.
 */
function commandHeads(
	statement: string,
): { words: string[]; spacedFileOutput: boolean }[] {
	const heads: { words: string[]; spacedFileOutput: boolean }[] = [];
	const starts = [0];
	// Match group ends once. Each command can then skip its nested bodies
	// without rescanning them; deeply nested reads stay linear in input size.
	const closes = new Map<number, number>();
	const open: number[] = [];
	for (let index = 0; index < statement.length; index += 1) {
		const char = statement[index] ?? "";
		if (char === "[" || char === "{") starts.push(index + 1);
		if ("[{(".includes(char)) open.push(index);
		else if ("]})".includes(char)) {
			const start = open.pop();
			if (start !== undefined) closes.set(start, index);
		}
	}
	for (const start of starts) {
		const nextOpener = statement.slice(start).search(/[[{(]/);
		const segment =
			nextOpener < 0
				? statement.slice(start)
				: statement.slice(start, start + nextOpener);
		const tokens = tokenizeRouterOsCli(segment);
		const head = tokens[0];
		if (head === undefined) continue;
		const words = commandWords(head, tokens.slice(1));
		// A lone closer (`}` ending a multi-line block) runs nothing.
		if (words.length > 0)
			heads.push({
				words,
				spacedFileOutput: hasSpacedFileOutput(statement, start, words, closes),
			});
	}
	return heads;
}

/**
 * RouterOS also accepts `file value` / `file-name value` without `=`. These
 * belong to print/export/serialize, not a loop variable or a pure function's
 * value. Read the command's own tokens, skipping nested expressions and
 * blocks: `:serialize value=[:tostr file] file-n "out"` has one file argument
 * after its nested read. Quoted text is already masked by the statement split.
 * Grounded on CHR 7.26beta1, with export also checked on long-term.
 */
function hasSpacedFileOutput(
	statement: string,
	start: number,
	words: readonly string[],
	closes: ReadonlyMap<number, number>,
): boolean {
	let commandWords: number;
	if (words[0] === ":serialize") {
		commandWords = 1;
	} else {
		const depth = menuDepth(words);
		if (words[depth] !== "print" && words[depth] !== "export") return false;
		commandWords = depth + 1;
	}
	let own = "";
	for (let index = start; index < statement.length; index += 1) {
		const char = statement[index] ?? "";
		if ("[{(".includes(char)) {
			own += " ";
			index = closes.get(index) ?? statement.length;
		} else if ("]})".includes(char)) {
			break;
		} else own += char;
	}
	let consumed = 0;
	for (const token of tokenizeRouterOsCli(own)) {
		if (consumed < commandWords) {
			consumed += token.split("/").filter(Boolean).length;
			continue;
		}
		if (!token.includes("=") && isFileOutputAttribute(token)) return true;
	}
	return false;
}

/**
 * The path segments and verb of one command, from its head token and the bare
 * words after it. The space-separated spelling puts menu segments and the verb
 * in those words (`/ip firewall filter print`, `/interface 6to4 print`, `/ip
 * firewall/filter print`). A word opening a bracket starts a nested command
 * (`new-mutator [find]`) and a word trailing a closer ends this one (`:put [/ip
 * address find]`), so the run stops at either.
 */
function commandWords(head: string, following: readonly string[]): string[] {
	const words: string[] = [];
	const headWord = trimGroupingPunctuation(head);
	if (headWord.startsWith(":")) return [headWord];
	// `/serialize …` is the root command `:serialize`: at statement start the
	// sigil is optional and `/` binds the root vocabulary (CHR 7.23.2, see
	// `src/explain/symbols.ts`). Only the absolute one-segment form is read
	// this way. A bare `delay` may be a relative menu command after earlier
	// navigation, so it keeps the menu-verb rule and fails closed.
	const root = /^\/([A-Za-z0-9-]+)$/.exec(headWord)?.[1]?.toLowerCase();
	if (
		root !== undefined &&
		READ_ONLY_SCRIPT_DIRECTIVES.has(`:${root}`) &&
		!isKnownMenuPath([root])
	) {
		return [`:${root}`];
	}
	words.push(...headWord.split("/").filter(Boolean));
	if (headWord !== head) return words;
	for (const token of following) {
		if (/^[{[(]/.test(token)) break;
		const word = trimGroupingPunctuation(token);
		if (!/^[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9-]*)*$/.test(word))
			break;
		words.push(...word.split("/"));
		if (word !== token) break;
	}
	return words;
}

/**
 * A command is read-only when it is a read-only script directive, or when the
 * first word past the longest known menu prefix is a read verb. Walking the
 * menu table rather than taking the first known verb keeps an unlearned
 * command from borrowing a later argument: `/user expire-password print` names
 * `expire-password` (a published command, absent from every allowlist) with
 * the username `print`. The menu table is a floor, so an unknown menu fails
 * closed here, as does a run of menus with no verb (navigation for a later
 * relative command).
 */
function isReadOnlyCommand(words: readonly string[]): boolean {
	const head = words[0] ?? "";
	if (head.startsWith(":")) return READ_ONLY_SCRIPT_DIRECTIVES.has(head);
	const verb = words[menuDepth(words)];
	return verb !== undefined && READ_ONLY_EXECUTE_VERBS.has(verb.toLowerCase());
}

function menuDepth(words: readonly string[]): number {
	let depth = 0;
	while (depth < words.length && isKnownMenuPath(words.slice(0, depth + 1))) {
		depth += 1;
	}
	return depth;
}

function trimGroupingPunctuation(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && "{[(".includes(value[start] ?? "")) start += 1;
	while (end > start && "}])".includes(value[end - 1] ?? "")) end -= 1;
	return value.slice(start, end);
}

/**
 * Split at real statement boundaries and blank quoted text, which does not
 * execute — except a `$[…]` or `$(…)` substitution inside a double-quoted
 * string, which is code: `:put "$[/system identity set name=x]"` runs the set.
 * Its body is kept (with its opener, so it becomes a command head) and may nest
 * strings of its own. The frame grammar is `explain`'s (`stepFrame` in
 * `src/explain/quoted-string.ts`).
 */
function splitUnquotedStatements(input: string): string[] {
	const statements: string[] = [];
	let current = "";
	// `"` / `'` are string frames; `]` / `)` are the closer a code frame inside
	// a string is waiting for. An empty stack is top-level code.
	const frames: string[] = [];
	let escaped = false;
	for (let index = 0; index < input.length; index += 1) {
		const char = input[index] ?? "";
		const top = frames.at(-1);
		const inString = top === '"' || top === "'";
		if (escaped) {
			current += inString ? " " : char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			current += inString ? " " : char;
			continue;
		}
		if (inString) {
			if (char === top) {
				frames.pop();
			} else if (
				top === '"' &&
				char === "$" &&
				(input[index + 1] === "[" || input[index + 1] === "(")
			) {
				const opener = input[index + 1] ?? "";
				frames.push(opener === "[" ? "]" : ")");
				current += ` ${opener}`;
				index += 1;
				continue;
			}
			current += " ";
			continue;
		}
		if (char === '"' || char === "'") {
			frames.push(char);
			current += " ";
			continue;
		}
		if (top !== undefined) {
			// Inside a string's code frame: track nesting to find its closer.
			if (char === top) frames.pop();
			else if (char === "[") frames.push("]");
			else if (char === "(") frames.push(")");
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
