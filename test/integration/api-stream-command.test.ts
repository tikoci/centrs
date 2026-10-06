import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	encodeSentence,
	SentenceReader,
} from "../../src/protocols/native-api.ts";
import { runCliProcess } from "./cli-process.ts";

// Process-level regressions use a loopback peer and dummy credentials. CHR
// command semantics and examples are covered separately in api-listen.test.ts.
const taskHome = mkdtempSync(join(tmpdir(), "centrs-stream-command-"));
afterAll(() => rmSync(taskHome, { recursive: true, force: true }));

type Mode =
	| "done"
	| "empty"
	| "trap"
	| "late-trap"
	| "close"
	| "fatal"
	| "interrupted"
	| "delayed-interrupted"
	| "script-error"
	| "burst"
	| "delete";

async function run(
	mode: Mode,
	extra: string[] = [],
	endpoint = "tool/ping",
	confirmed = true,
) {
	const sent: string[][] = [];
	const readers = new WeakMap<object, SentenceReader>();
	const peer = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data(socket, chunk) {
				const reader = readers.get(socket) ?? new SentenceReader();
				readers.set(socket, reader);
				for (const words of reader.push(new Uint8Array(chunk))) {
					sent.push(words);
					const tag = words.find((w) => w.startsWith(".tag="));
					const reply = (...words: string[]) =>
						socket.write(encodeSentence([...words, ...(tag ? [tag] : [])]));
					if (words[0] === "/login") {
						reply("!done");
						continue;
					}
					if (words[0] === "/console/inspect") {
						for (const name of [
							"tool",
							"ip",
							"address",
							"ping",
							"print",
							"monitor-traffic",
							"add",
						])
							reply("!re", `=name=${name}`, "=type=cmd");
						for (const name of ["address", "count", "interval", "interface"])
							reply("!re", `=name=${name}`, "=type=child");
						reply("!done");
						continue;
					}
					if (words[0] === "/cancel") {
						reply("!done");
						continue;
					}
					if (mode === "delayed-interrupted") {
						reply("!trap", "=category=2", "=message=interrupted");
						setTimeout(() => reply("!done"), 250);
						continue;
					}
					if (mode === "close") {
						socket.end();
						continue;
					}
					if (mode === "fatal") {
						reply("!fatal", "=message=fixture fatal");
						continue;
					}
					if (mode === "burst") {
						reply("!re", "=seq=0");
						reply("!re", "=seq=1");
					}
					if (mode === "delete") reply("!re", "=.id=*1", "=.dead=true");
					if (mode === "done" || mode === "late-trap")
						reply("!re", "=seq=0", "=.section=7");
					if (mode === "trap" || mode === "late-trap")
						reply("!trap", "=category=0", "=message=no such command");
					if (mode === "interrupted")
						reply("!trap", "=category=2", "=message=interrupted");
					if (mode === "empty") reply("!empty");
					reply(
						"!done",
						mode === "script-error"
							? "=ret=no such item"
							: "=ret=fixture-result",
					);
				}
			},
		},
	});
	try {
		const result = await runCliProcess({
			args: [
				"api",
				"127.0.0.1",
				endpoint,
				"-X",
				"POST",
				"--stream",
				...(confirmed ? ["--yes"] : []),
				"--via",
				"native-api",
				"--port",
				String(peer.port),
				"--username",
				"fixture",
				"--password",
				"dummy",
				"--timeout",
				"500ms",
				"--json",
				...extra,
			],
			env: { HOME: taskHome, XDG_CONFIG_HOME: join(taskHome, ".config") },
			killAfterMs: 5000,
		});
		return {
			...result,
			sent,
			lines: result.stdoutText
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		};
	} finally {
		peer.stop(true);
	}
}

describe("api --stream command lifecycle (#399)", () => {
	test("streams POST attributes and preserves natural completion attributes", async () => {
		const result = await run("done", [
			"-f",
			"address=192.0.2.1",
			"-f",
			"count=1",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stderrText).toBe("");
		expect(result.sent.find((words) => words[0] === "/tool/ping")).toContain(
			"=address=192.0.2.1",
		);
		expect(result.sent.some((words) => words[0]?.endsWith("/listen"))).toBe(
			false,
		);
		expect(result.lines).toHaveLength(2);
		expect(result.lines[0].data[".section"]).toBe("7");
		expect(result.lines[1]).toMatchObject({
			ok: true,
			data: {
				stopReason: "completed",
				frames: 1,
				done: { ret: "fixture-result" },
			},
		});
	});
	test("count stop stays truthful when rows and done arrive in one chunk", async () => {
		const result = await run("burst", ["--count", "1"]);
		expect(result.exitCode).toBe(0);
		expect(result.lines).toHaveLength(2);
		expect(result.lines[1].data).toMatchObject({
			stopReason: "count-reached",
			frames: 1,
		});
		expect(result.lines[1].data.done).toBeUndefined();
	});
	test("count stop does not discard an already received RouterOS failure", async () => {
		const result = await run("late-trap", ["--count", "1"]);
		expect(result.exitCode).toBe(1);
		expect(result.lines.at(-1)).toMatchObject({
			ok: false,
			meta: {
				operation: {
					stream: { kind: "summary", frames: 1, stopReason: "routeros-error" },
				},
			},
		});
	});
	test("script runtime rejection in terminal ret fails the stream", async () => {
		const result = await run(
			"script-error",
			["-f", "script=/ip/address/get *FFFFFF address"],
			"execute",
		);
		expect(result.exitCode).toBe(1);
		expect(result.lines.at(-1)).toMatchObject({
			ok: false,
			error: { code: "routeros/unknown-path" },
		});
	});
	test("a later duration abort cannot hide an unsolicited interruption", async () => {
		const result = await run("delayed-interrupted", ["--duration", "100ms"]);
		expect(result.exitCode).toBe(1);
		expect(result.lines.at(-1)).toMatchObject({
			ok: false,
			meta: { operation: { stream: { stopReason: "routeros-error" } } },
		});
	});
	test("GET projection retains deletion fields and addressed-row query", async () => {
		const result = await run(
			"delete",
			["-X", "GET", "--proplist", "address,.id,address"],
			"ip/address/*1",
		);
		expect(result.exitCode).toBe(0);
		const words = result.sent.find(
			(words) => words[0] === "/ip/address/listen",
		);
		expect(words).toContain("=.proplist=address,.id,.dead");
		expect(words).toContain("?.id=*1");
		expect(result.lines[0].data).toEqual({ ".id": "*1", ".dead": "true" });
	});
	test("empty completion is successful and does not invent a row", async () => {
		const result = await run("empty");
		expect(result.exitCode).toBe(0);
		expect(result.lines).toHaveLength(1);
		expect(result.lines[0].data).toMatchObject({
			stopReason: "completed",
			frames: 0,
		});
	});
	for (const mode of [
		"trap",
		"late-trap",
		"close",
		"fatal",
		"interrupted",
	] as const) {
		test(`${mode} emits one failed terminal summary and exits nonzero`, async () => {
			const result = await run(mode);
			expect(result.exitCode).toBe(1);
			expect(result.stderrText).toBe("");
			const terminal = result.lines.at(-1);
			expect(terminal.ok).toBe(false);
			expect(
				result.lines.filter(
					(line) => line.meta.operation.stream?.kind === "summary",
				),
			).toHaveLength(1);
			expect(terminal.meta.operation.stream).toMatchObject({
				kind: "summary",
				frames: mode === "late-trap" ? 1 : 0,
				stopReason: mode === "close" ? "transport-error" : "routeros-error",
			});
		});
	}
	test("POST print interval and projection reach the device unchanged", async () => {
		const result = await run(
			"done",
			[
				"-f",
				"interval=1",
				"--proplist",
				"address",
				"--query",
				"interface=ether1",
			],
			"ip/address/print",
		);
		expect(result.exitCode).toBe(0);
		const command = result.sent.find(
			(words) => words[0] === "/ip/address/print",
		);
		expect(command).toContain("=interval=1");
		expect(command).toContain("=.proplist=address");
		expect(command).toContain("?interface=ether1");
	});
	test("GET fields and filtered follows fail before connecting", async () => {
		for (const flags of [
			["--query", "interface=ether1"],
			["--raw-query", "interface=ether1"],
			["-f", "interval=1"],
		]) {
			const result = await run("done", ["-X", "GET", ...flags], "ip/address");
			expect(result.exitCode).toBe(1);
			expect(result.sent).toHaveLength(0);
			expect(result.lines[0].error.code).toBe("usage/conflicting-flags");
		}
	});
	test("a command stream still requires write confirmation", async () => {
		const result = await run("done", [], "tool/ping", false);
		expect(result.exitCode).toBe(1);
		expect(result.sent).toHaveLength(0);
		expect(result.lines[0].error.code).toBe("usage/confirmation-required");
	});
	test("raw failures retain stderr and a nonzero exit after successful rows", async () => {
		const result = await run("late-trap", ["--raw", "--validate=true"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderrText).not.toBe("");
		expect(result.lines).toHaveLength(1);
		expect(result.lines[0]).toEqual({ seq: "0", ".section": "7" });
	});
});
