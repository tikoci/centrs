/**
 * The browser consumer itself (#312) — a Worker that runs the bundled offline
 * analysis with no host API in scope.
 *
 * Two things make this a proof rather than a re-run:
 *
 *   1. It evaluates the `--target browser` BUNDLE, not `src/explain.ts`. The
 *      bundle is what a browser or editor would ship, polyfill substitutions
 *      included.
 *   2. Every host global is shadowed as a parameter of the wrapper function, so
 *      a bare `Bun`, `process`, `require`, `module`, `exports`, `__dirname` or
 *      `__filename` inside the bundle reads `undefined` instead of reaching
 *      this runtime's real one. `Bun` is a non-configurable global — deleting
 *      it throws — so shadowing is the only way to make the absence real.
 *
 * `globalThis` is deliberately NOT shadowed: the bundle contains no reference
 * to it (the consumer script's boundary half is what keeps that true), and
 * shadowing it would also hide `TextDecoder`, which the coordinate pass needs
 * and every browser has.
 */

declare const self: {
	onmessage: ((event: MessageEvent) => void) | null;
	postMessage: (value: unknown) => void;
};

interface Request {
	code: string;
	cases: { input: string; options: { tokens?: boolean; curl?: boolean } }[];
}

type Analyze = (input: string, options: unknown) => unknown;

self.onmessage = (event: MessageEvent) => {
	const { code, cases } = event.data as Request;
	try {
		const sink: { api?: { explainCommand: Analyze } } = {};
		const load = new Function(
			"__sink",
			"Bun",
			"process",
			"require",
			"module",
			"exports",
			"__dirname",
			"__filename",
			code,
		);
		load(
			sink,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		);
		const explainCommand = sink.api?.explainCommand;
		if (typeof explainCommand !== "function")
			throw new Error("bundle did not expose explainCommand");
		self.postMessage({
			ok: true,
			results: cases.map((c) =>
				JSON.stringify(explainCommand(c.input, c.options)),
			),
		});
	} catch (error) {
		self.postMessage({
			ok: false,
			error:
				error instanceof Error
					? `${error.message}\n${error.stack}`
					: String(error),
		});
	}
};
