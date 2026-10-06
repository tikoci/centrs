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
	| "trap-unacknowledged"
	| "delayed-done"
	| "burst"
	| "delete";

async function run(
	mode: Mode,
	extra: string[] = [],
	endpoint = "tool/ping",
	confirmed = true,
	stream = true,
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
					if (mode === "trap-unacknowledged") {
						reply("!trap", "=category=0", "=message=no such command");
						continue;
					}
					if (mode === "delayed-done") {
						setTimeout(() => reply("!done", "=ret=*A"), 250);
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
					if (mode === "late-trap") {
						// This case requires an already received failure. Separate writes
						// allow Linux TCP to deliver the first row before the trap exists.
						socket.write(
							Buffer.concat([
								encodeSentence([
									"!re",
									"=seq=0",
									"=.section=7",
									...(tag ? [tag] : []),
								]),
								encodeSentence([
									"!trap",
									"=category=0",
									"=message=no such command",
									...(tag ? [tag] : []),
								]),
								encodeSentence(["!done", ...(tag ? [tag] : [])]),
							]),
						);
						continue;
					}
					if (mode === "burst") {
						socket.write(
							Buffer.concat([
								encodeSentence(["!re", "=seq=0", ...(tag ? [tag] : [])]),
								encodeSentence(["!re", "=seq=1", ...(tag ? [tag] : [])]),
								encodeSentence([
									"!done",
									"=ret=fixture-result",
									...(tag ? [tag] : []),
								]),
							]),
						);
						continue;
					}
					if (mode === "delete") reply("!re", "=.id=*1", "=.dead=true");
					if (mode === "done") reply("!re", "=seq=0", "=.section=7");
					if (mode === "trap")
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
				...(stream ? ["--stream"] : []),
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
			lines: !stream
				? [JSON.parse(result.stdoutText || result.stderrText)]
				: result.stdoutText
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
		expect(result.lines[1].data.done).toEqual({ ret: "fixture-result" });
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
	test("one-shot and streamed POST print keep identical command options", async () => {
		for (const stream of [false, true]) {
			const result = await run(
				"done",
				[
					"-f",
					"interval=1",
					"--query",
					"interface=ether1",
					"--proplist",
					"address",
				],
				"ip/address/print",
				true,
				stream,
			);
			expect(result.exitCode).toBe(0);
			const words = result.sent.find((w) => w[0] === "/ip/address/print");
			expect(words).toContain("=interval=1");
			expect(words).toContain("?interface=ether1");
			expect(words).toContain("=.proplist=address");
		}
	});
	for (const stream of [false, true])
		for (const method of ["PUT", "PATCH", "DELETE"]) {
			test(`${method} query/projection flags fail before dispatch (stream=${stream})`, async () => {
				for (const flags of [
					["--query", "address=192.0.2.1"],
					["--raw-query", "address"],
					["--proplist", "address"],
				]) {
					const result = await run(
						"done",
						["-X", method, ...flags],
						method === "PUT" ? "ip/address" : "ip/address/*1",
						true,
						stream,
					);
					expect(result.exitCode).toBe(1);
					expect(result.sent).toHaveLength(0);
					expect(result.lines[0].error.code).toBe("usage/conflicting-flags");
				}
			});
		}
	test("failed summary retains the unacknowledged cancellation warning", async () => {
		const result = await run("trap-unacknowledged", ["--duration", "100ms"]);
		expect(result.exitCode).toBe(1);
		expect(result.lines.at(-1)).toMatchObject({
			ok: false,
			warnings: [{ code: "transport/cancel-unacknowledged" }],
			meta: { operation: { stream: { stopReason: "routeros-error" } } },
		});
	});
	test("a local duration stop preserves terminal mutation attributes received later", async () => {
		const result = await run(
			"delayed-done",
			["-X", "PUT", "--duration", "100ms"],
			"ip/address",
		);
		expect(result.exitCode).toBe(0);
		expect(result.lines.at(-1)).toMatchObject({
			ok: true,
			data: { done: { ret: "*A" } },
			meta: { operation: { stream: { stopReason: "duration-elapsed" } } },
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
