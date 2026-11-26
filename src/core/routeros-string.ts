/**
 * Quote RouterOS command text as one double-quoted string literal.
 *
 * `$` is load-bearing here: RouterOS expands variables inside double quotes,
 * so leaving it bare changes the bytes seen by wrappers such as
 * `:put [:parse "<input>"]` before the parser receives them.
 * Control whitespace (`\t`/`\r`/`\n`) is escaped so the decoded string
 * carries the caller's original bytes. This is defensive: RouterOS 7.20
 * changelog says "replace TAB characters with spaces when editing scripts
 * and added `tab-width` in `/console/settings`" (absent before 7.20).
 * Measured on CHR 7.23.8 and 7.24.5 for #676: `tab-width` defaults to 4, a
 * value stored over REST keeps its literal TAB (SSH returns it), and the
 * console still advances a TAB to the next multiple of 8. Whether a TAB
 * inside a string literal is expanded is not measured (see #276).
 * Escaping preserves the caller's bytes whether the device expands or
 * preserves a raw tab.
 */
export function routerOsStringLiteral(value: string): string {
	return `"${value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$")
		.replaceAll("\t", "\\t")
		.replaceAll("\r", "\\r")
		.replaceAll("\n", "\\n")}"`;
}
