/**
 * The one rule for turning piped or file bytes into a password, shared by
 * `devices add|set --password-stdin` (#582) and the `*_FILE` secret sources
 * (#672) so the two cannot drift.
 *
 * Exactly one trailing `\n` or `\r\n` is stripped (at the byte level), so
 * `echo pw > file` works; any other whitespace is part of the password. The
 * rest must be valid UTF-8 without a leading byte-order mark: the CDB stores
 * strings as UTF-8 and drops a leading BOM when it reads them back, so either
 * would silently become a credential different from the bytes given.
 */

export type PasswordBytesResult =
	| { ok: true; value: string }
	| { ok: false; reason: "empty" | "invalid-utf8" | "bom"; byteLength: number };

// `fatal` rejects malformed UTF-8 instead of substituting U+FFFD; `ignoreBOM`
// keeps a leading U+FEFF visible so it can be refused rather than dropped.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function decodePasswordBytes(raw: Uint8Array): PasswordBytesResult {
	const end = raw.length;
	const trimmed =
		end >= 2 && raw[end - 2] === 0x0d && raw[end - 1] === 0x0a
			? raw.subarray(0, end - 2)
			: end >= 1 && raw[end - 1] === 0x0a
				? raw.subarray(0, end - 1)
				: raw;
	if (trimmed.length === 0) {
		return { ok: false, reason: "empty", byteLength: 0 };
	}
	let value: string;
	try {
		value = decoder.decode(trimmed);
	} catch {
		return { ok: false, reason: "invalid-utf8", byteLength: trimmed.length };
	}
	if (value.startsWith("﻿")) {
		return { ok: false, reason: "bom", byteLength: trimmed.length };
	}
	return { ok: true, value };
}

/** Human wording for a refused {@link PasswordBytesResult} reason. */
export function passwordBytesReason(
	reason: "empty" | "invalid-utf8" | "bom",
): string {
	switch (reason) {
		case "empty":
			return "an empty password";
		case "invalid-utf8":
			return "bytes that are not valid UTF-8";
		case "bom":
			return "a leading byte-order mark (U+FEFF)";
	}
}
