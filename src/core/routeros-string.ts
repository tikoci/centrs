/**
 * Quote RouterOS command text as one double-quoted string literal.
 *
 * `$` is load-bearing here: RouterOS expands variables inside double quotes,
 * so leaving it bare changes the bytes seen by wrappers such as
 * `:put [:parse "<input>"]` before the parser receives them.
 * Raw tabs are load-bearing too: RouterOS expands each to four spaces while
 * reading a string literal. Escape all control whitespace so the decoded
 * string carries the caller's original bytes.
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
