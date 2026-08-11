/**
 * Quote arbitrary text as one RouterOS double-quoted string literal.
 *
 * `$` is load-bearing here: RouterOS expands variables inside double quotes,
 * so leaving it bare changes the bytes seen by wrappers such as
 * `:put [:parse "<input>"]` before the parser receives them.
 */
export function routerOsStringLiteral(value: string): string {
	return `"${value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$")}"`;
}
