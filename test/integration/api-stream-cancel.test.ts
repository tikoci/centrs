import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TCPSocketListener } from "bun";
import {
	encodeSentence,
	SentenceReader,
} from "../../src/protocols/native-api.ts";
import { runCliProcess } from "./cli-process.ts";

/**
 * `api --stream` against a loopback native-API peer, run as a real CLI process
 * (#385). The contract under test is that the PROCESS exits within a bound
 * when the stream stops, whether or not the router acknowledges `/cancel`.
 * Emitting a summary frame is not enough; the session must close too.
 *
 * Network-free (loopback peer, dummy credentials), so like `cli-smoke` it is not
 * CHR-gated and runs in the fast `bun test` gate. Boundedness is the kill guard:
 * a child still running at `killAfterMs` is SIGKILLed and never prints the
 * summary line every case asserts on. No wall-clock assertion, since CI
 * runners and a CPU-throttled laptop differ several-fold in startup time.
 */

// A throwaway HOME keeps the developer's default CDB and centrs.env out of it.
const HOME = mkdtempSync(join(tmpdir(), "centrs-stream-cancel-"));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

interface Peer {
	port: number;
	cancels: number;
	stop(): void;
}

function startPeer(acknowledgeCancel: boolean): Peer {
	const state = { cancels: 0 };
	const readers = new WeakMap<object, SentenceReader>();
	const listener: TCPSocketListener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data(socket, chunk) {
				const reader = readers.get(socket) ?? new SentenceReader();
				readers.set(socket, reader);
				for (const words of reader.push(new Uint8Array(chunk))) {
					const tag = words.find((w) => w.startsWith(".tag="));
					const send = (...sentence: string[]): void => {
						socket.write(encodeSentence(tag ? [...sentence, tag] : sentence));
					};
					switch (words[0]) {
						case "/login":
							send("!done");
							break;
						case "/console/inspect":
							send("!re", "=name=print", "=type=cmd");
							send("!done");
							break;
						case "/ip/address/listen":
							listenTag = tag;
							send("!re", "=.id=*1", "=state=fixture");
							break;
						case "/cancel": {
							state.cancels += 1;
							if (!acknowledgeCancel) break;
							const listen = listenTag ? [listenTag] : [];
							socket.write(
								encodeSentence([
									"!trap",
									"=category=2",
									"=message=interrupted",
									...listen,
								]),
							);
							socket.write(encodeSentence(["!done", ...listen]));
							send("!done");
							break;
						}
						default:
							send("!done");
					}
				}
			},
		},
	});
	let listenTag: string | undefined;
	return {
		port: listener.port,
		get cancels() {
			return state.cancels;
		},
		stop: () => listener.stop(true),
	};
}

async function runStream(
	peer: Peer,
	extra: string[],
	onFirstFrame?: (child: Bun.Subprocess) => void,
): Promise<{ exitCode: number; lines: unknown[] }> {
	let frames = 0;
	const result = await runCliProcess({
		args: [
			"api",
			"127.0.0.1",
			"/ip/address",
			"--stream",
			"--via",
			"native-api",
			"--port",
			String(peer.port),
			"--username",
			"fixture",
			"--password",
			"dummy",
			"--timeout",
			"300ms",
			"--json",
			...extra,
		],
		env: { HOME, XDG_CONFIG_HOME: join(HOME, ".config") },
		killAfterMs: 8000,
		onStdoutLine: (line, child) => {
			if (line.trim().length === 0) return;
			frames += 1;
			if (frames === 1) onFirstFrame?.(child);
		},
	});
	const lines = result.stdoutText
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as unknown);
	return { exitCode: result.exitCode, lines };
}

type Summary = {
	data: { stopReason: string; frames: number };
	warnings: { code: string }[];
};

let peer: Peer | undefined;
afterEach(() => peer?.stop());

describe("api --stream stops within a bound (#385)", () => {
	test("--duration against a peer that ignores /cancel exits with an unacknowledged warning", async () => {
		peer = startPeer(false);
		const run = await runStream(peer, ["--duration", "200ms"]);
		expect(run.exitCode).toBe(0);
		expect(peer.cancels).toBe(1);
		const summary = run.lines.at(-1) as Summary;
		expect(summary.data.stopReason).toBe("duration-elapsed");
		expect(summary.data.frames).toBe(1);
		expect(summary.warnings.map((w) => w.code)).toContain(
			"transport/cancel-unacknowledged",
		);
	}, 15_000);

	test("SIGINT against a peer that ignores /cancel exits", async () => {
		peer = startPeer(false);
		const run = await runStream(peer, [], (proc) => proc.kill("SIGINT"));
		const summary = run.lines.at(-1) as Summary;
		expect(summary.data.stopReason).toBe("interrupted");
		expect(summary.warnings.map((w) => w.code)).toContain(
			"transport/cancel-unacknowledged",
		);
	}, 15_000);

	test("a cooperative peer's cancel is acknowledged: no warning", async () => {
		peer = startPeer(true);
		const run = await runStream(peer, ["--duration", "200ms"]);
		expect(run.exitCode).toBe(0);
		const summary = run.lines.at(-1) as Summary;
		expect(summary.data.stopReason).toBe("duration-elapsed");
		expect(summary.warnings.map((w) => w.code)).not.toContain(
			"transport/cancel-unacknowledged",
		);
	}, 15_000);

	test("--count against a peer that ignores /cancel exits", async () => {
		peer = startPeer(false);
		const run = await runStream(peer, ["--count", "1"]);
		expect(run.exitCode).toBe(0);
		const summary = run.lines.at(-1) as Summary;
		expect(summary.data.stopReason).toBe("count-reached");
	}, 15_000);
});
