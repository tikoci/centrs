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
] as const;

export type CommentKvKey = (typeof commentKvAllowlist)[number];

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
	warnings: CommentKvWarning[];
}

interface ShellWord {
	/** Final, unquoted text of the word. */
	text: string;
	/** Per-character flag: true when the character came from inside quotes. */
	quoted: boolean[];
}

const BARE_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

const allowSet = new Set<string>(commentKvAllowlist);
const reservedSet = new Set<string>(commentKvReservedKeys);

function isAllowlistKey(key: string): key is CommentKvKey {
	return allowSet.has(key);
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

	const flush = (): void => {
		if (inWord) {
			words.push({ text, quoted });
			text = "";
			quoted = [];
			inWord = false;
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
			inWord = true;
			inQuotes = true;
			continue;
		}

		if (char === " " || char === "\t" || char === "\n" || char === "\r") {
			flush();
			continue;
		}

		inWord = true;
		text += char;
		quoted.push(false);
	}

	// An unterminated quote consumes the rest of the input as quoted text; the
	// word is still flushed so its value survives (best-effort, not an error).
	flush();
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
	const warnings: CommentKvWarning[] = [];

	for (const word of tokenize(comment)) {
		const kv = splitKv(word);
		if (!kv) {
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

	return { values, warnings };
}
