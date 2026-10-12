/**
 * `host:port` for messages and endpoint labels. An IPv6 host is bracketed
 * (`[2001:db8::5]:9`), because a bare `2001:db8::5:9` reads as another address.
 * Sockets still take the bare host.
 */
export function formatEndpoint(host: string, port: number): string {
	const bracketed =
		host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
	return `${bracketed}:${port}`;
}
