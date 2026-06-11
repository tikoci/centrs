/**
 * Shared parser for the CDB comment "kv-soup" of per-device option overrides.
 *
 * The CDB `comment` field is free text. centrs additionally parses tokens
 * shaped like `key=value` out of it and treats the allowlisted ones as
 * per-device defaults. See `commands/devices/README.md` (Comment kv-soup) and
 * `docs/CONSTITUTION.md` (Settings precedence) for the contract this module
 * implements.
 *
 * Rules implemented here:
 * - Tokens are shell-word tokenized: whitespace separates tokens unless inside
 *   double quotes. Inside double quotes, `\"` and `\\` are the only escapes;
 *   any other backslash is literal. `=` inside a quoted span is literal.
 * - A token is a kv token only when it *starts* with a bare-word key
 *   (`[A-Za-z][A-Za-z0-9_-]*`) drawn entirely from unquoted characters,
 *   immediately followed by an unquoted `=`. The value is the remainder of the
 *   token (which may have been quoted).
 * - Free-form text outside well-formed `key=value` tokens is inert: no value,
 *   no warning.
 * - Allowlisted keys populate `values`. First-class CDB keys are rejected with
 *   a `cdb/reserved-option` warning (they have dedicated CDB tags and must not
 *   live in the comment). Any other key emits `cdb/unknown-option`.
 *
 * This module is intentionally pure: it returns raw string values. Type
 * coercion (`validate` -> boolean, `timeout`/`port` -> integer) and settings
 * precedence belong to the resolver that consumes this output.
 */

/** Keys the comment kv-soup may legitimately carry. */
export const commentKvAllowlist = [
	"via",
	"validate",
	"timeout",
	"port",
	"source",
	"mcp",
	"ssh-key",
	"insecure",
] as const;

export type CommentKvKey = (typeof commentKvAllowlist)[number];

/**
 * Comment keys that resolve `<router>` to a record, distinct from the setting
 * *override* keys above. The non-`target` identifiers ride here so one record is
 * resolvable by identity / MAC / IP regardless of which is stored as `target`.
 * See `commands/devices/README.md` (Identity model) and `docs/CONSTITUTION.md`
 * (Identity and CDB). Values are returned raw; normalization + matching belong
 * to the resolver that consumes them.
 */
export const commentKvLookupKeys = ["identity", "mac", "ip"] as const;

export type CommentKvLookupKey = (typeof commentKvLookupKeys)[number];

/**
 * First-class CDB fields. These have dedicated CDB tags and must never be
 * expressed through the comment kv-soup; `devices set` refuses to write them
 * and the parser refuses to read them.
 */
export const commentKvReservedKeys = [
	"user",
	"password",
	"group",
	"profile",
	"session",
] as const;

export interface CommentKvWarning {
	code: "cdb/unknown-option" | "cdb/reserved-option";
	message: string;
	context: { key: string };
}

export interface CommentKvResult {
	/** Allowlisted overrides, last-wins on duplicate keys, raw string values. */
	values: Partial<Record<CommentKvKey, string>>;
	/** Lookup keys (identity/mac/ip), last-wins, raw string values. */
	lookups: Partial<Record<CommentKvLookupKey, string>>;
	warnings: CommentKvWarning[];
}

interface ShellWord {
	/** Final, unquoted text of the word. */
	text: string;
	/** Per-character flag: true when the character came from inside quotes. */
	quoted: boolean[];
	/** Source start offset (inclusive) of the word in the original comment. */
	start: number;
	/** Source end offset (exclusive) of the word in the original comment. */
	end: number;
}

const BARE_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

const allowSet = new Set<string>(commentKvAllowlist);
const reservedSet = new Set<string>(commentKvReservedKeys);
const lookupSet = new Set<string>(commentKvLookupKeys);

function isAllowlistKey(key: string): key is CommentKvKey {
	return allowSet.has(key);
}

function isLookupKey(key: string): key is CommentKvLookupKey {
	return lookupSet.has(key);
}

/**
 * Shell-word tokenize a comment, tracking which characters originated inside a
 * quoted span so the kv splitter can require a bare, unquoted key.
 */
function tokenize(comment: string): ShellWord[] {
	const words: ShellWord[] = [];
	let text = "";
	let quoted: boolean[] = [];
	let inWord = false;
	let inQuotes = false;
	let wordStart = -1;

	const flush = (end: number): void => {
		if (inWord) {
			words.push({ text, quoted, start: wordStart, end });
			text = "";
			quoted = [];
			inWord = false;
			wordStart = -1;
		}
	};

	const beginWord = (index: number): void => {
		if (!inWord) {
			inWord = true;
			wordStart = index;
		}
	};

	for (let index = 0; index < comment.length; index += 1) {
		const char = comment[index] as string;

		if (inQuotes) {
			if (char === "\\") {
				const next = comment[index + 1];
				if (next === '"' || next === "\\") {
					text += next;
					quoted.push(true);
					index += 1;
					continue;
				}
				text += char;
				quoted.push(true);
				continue;
			}
			if (char === '"') {
				inQuotes = false;
				continue;
			}
			text += char;
			quoted.push(true);
			continue;
		}

		if (char === '"') {
			beginWord(index);
			inQuotes = true;
			continue;
		}

		if (char === " " || char === "\t" || char === "\n" || char === "\r") {
			flush(index);
			continue;
		}

		beginWord(index);
		text += char;
		quoted.push(false);
	}

	// An unterminated quote consumes the rest of the input as quoted text; the
	// word is still flushed so its value survives (best-effort, not an error).
	flush(comment.length);
	return words;
}

/**
 * Split a shell word into a bare, unquoted key and its raw value. Returns
 * `undefined` when the word is not a well-formed `key=value` token (inert).
 */
function splitKv(word: ShellWord): { key: string; value: string } | undefined {
	const eq = word.text.indexOf("=");
	if (eq <= 0) {
		return undefined;
	}
	// The `=` and the entire key must be unquoted.
	if (word.quoted[eq]) {
		return undefined;
	}
	for (let index = 0; index < eq; index += 1) {
		if (word.quoted[index]) {
			return undefined;
		}
	}
	const key = word.text.slice(0, eq);
	if (!BARE_KEY.test(key)) {
		return undefined;
	}
	return { key, value: word.text.slice(eq + 1) };
}

export function parseCommentKv(comment: string): CommentKvResult {
	const values: Partial<Record<CommentKvKey, string>> = {};
	const lookups: Partial<Record<CommentKvLookupKey, string>> = {};
	const warnings: CommentKvWarning[] = [];

	for (const word of tokenize(comment)) {
		const kv = splitKv(word);
		if (!kv) {
			continue;
		}
		if (isLookupKey(kv.key)) {
			lookups[kv.key] = kv.value;
			continue;
		}
		if (isAllowlistKey(kv.key)) {
			values[kv.key] = kv.value;
			continue;
		}
		if (reservedSet.has(kv.key)) {
			warnings.push({
				code: "cdb/reserved-option",
				message: `Comment option "${kv.key}" is a first-class CDB field and is ignored; set it through the CDB record instead.`,
				context: { key: kv.key },
			});
			continue;
		}
		warnings.push({
			code: "cdb/unknown-option",
			message: `Unknown comment option "${kv.key}"; it has no effect.`,
			context: { key: kv.key },
		});
	}

	return { values, lookups, warnings };
}

/**
 * A single comment kv-soup mutation. `value: null` removes every token whose
 * bare key matches; any other value upserts `key=value` (the value is quoted
 * when needed so it survives re-tokenization as one token).
 */
export interface CommentKvUpdate {
	key: string;
	value: string | null;
}

/**
 * Quote a value so it tokenizes back to exactly `value`. Bare values with no
 * whitespace, quotes, or backslashes are emitted unquoted; everything else is
 * double-quoted with `\"` / `\\` escapes (the only escapes the parser honors).
 */
function quoteCommentValue(value: string): string {
	if (value.length > 0 && !/[\s"\\]/.test(value)) {
		return value;
	}
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}"`;
}

/** Render a kv token whose value round-trips through {@link parseCommentKv}. */
export function renderCommentKvToken(key: string, value: string): string {
	return `${key}=${quoteCommentValue(value)}`;
}

interface SpanEdit {
	start: number;
	end: number;
	replacement: string;
}

/** Apply one upsert/remove to a comment string, preserving free-form text. */
function applyOne(comment: string, update: CommentKvUpdate): string {
	const matches = tokenize(comment).filter((word) => {
		const kv = splitKv(word);
		return kv !== undefined && kv.key === update.key;
	});

	const edits: SpanEdit[] = [];
	if (update.value === null) {
		for (const word of matches) {
			edits.push(removalEdit(comment, word.start, word.end));
		}
	} else {
		const token = renderCommentKvToken(update.key, update.value);
		const [first, ...rest] = matches;
		if (first) {
			edits.push({ start: first.start, end: first.end, replacement: token });
			for (const word of rest) {
				edits.push(removalEdit(comment, word.start, word.end));
			}
		} else {
			return appendToken(comment, token);
		}
	}

	return applyEdits(comment, edits);
}

/**
 * Expand a token's span to swallow one adjacent whitespace run so removal does
 * not leave a doubled space or a leading/trailing gap.
 */
function removalEdit(comment: string, start: number, end: number): SpanEdit {
	let from = start;
	let to = end;
	if (from > 0 && isSpace(comment[from - 1])) {
		from -= 1;
	} else {
		while (to < comment.length && isSpace(comment[to])) {
			to += 1;
		}
	}
	return { start: from, end: to, replacement: "" };
}

function appendToken(comment: string, token: string): string {
	if (comment.length === 0) {
		return token;
	}
	if (isSpace(comment[comment.length - 1])) {
		return `${comment}${token}`;
	}
	return `${comment} ${token}`;
}

function applyEdits(comment: string, edits: readonly SpanEdit[]): string {
	let result = comment;
	for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
		result =
			result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
	}
	return result;
}

function isSpace(char: string | undefined): boolean {
	return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/**
 * Apply comment kv-soup updates in order, returning the new comment string.
 * Free-form (non-kv) text and untouched kv tokens are preserved verbatim; only
 * the targeted keys are upserted or removed.
 */
export function applyCommentKv(
	comment: string,
	updates: readonly CommentKvUpdate[],
): string {
	let result = comment;
	for (const update of updates) {
		result = applyOne(result, update);
	}
	return result;
}
