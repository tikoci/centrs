/** A loopback port that was just listening and now refuses connections. */
export function closedPort(): number {
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data() {} },
	});
	const { port } = listener;
	listener.stop(true);
	return port;
}
