import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	type ApiReply,
	attributeWord,
	challengeResponse,
	decodeLength,
	encodeLength,
	encodeSentence,
	encodeWord,
	isNativeAuthFailure,
	type NativeApiByteSink,
	NativeApiSession,
	parseReply,
	readAttribute,
	SentenceReader,
} from "../../src/protocols/native-api.ts";

function hex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

describe("native-api length encoding", () => {
	const vectors: Array<{ length: number; bytes: number[] }> = [
		{ length: 0x00, bytes: [0x00] },
		{ length: 0x01, bytes: [0x01] },
		{ length: 0x7f, bytes: [0x7f] },
		{ length: 0x80, bytes: [0x80, 0x80] },
		{ length: 0x87, bytes: [0x80, 0x87] },
		{ length: 0x3fff, bytes: [0xbf, 0xff] },
		{ length: 0x4000, bytes: [0xc0, 0x40, 0x00] },
		{ length: 0x4321, bytes: [0xc0, 0x43, 0x21] },
		{ length: 0x1fffff, bytes: [0xdf, 0xff, 0xff] },
		{ length: 0x200000, bytes: [0xe0, 0x20, 0x00, 0x00] },
		{ length: 0x2acdef, bytes: [0xe0, 0x2a, 0xcd, 0xef] },
		{ length: 0xfffffff, bytes: [0xef, 0xff, 0xff, 0xff] },
		{ length: 0x10000080, bytes: [0xf0, 0x10, 0x00, 0x00, 0x80] },
	];

	for (const { length, bytes } of vectors) {
		test(`encodes 0x${length.toString(16)}`, () => {
			expect(hex(encodeLength(length))).toBe(hex(Uint8Array.from(bytes)));
		});

		test(`round-trips 0x${length.toString(16)}`, () => {
			const encoded = encodeLength(length);
			const decoded = decodeLength(encoded, 0);
			expect(decoded).not.toBeNull();
			expect(decoded?.value).toBe(length);
			expect(decoded?.size).toBe(encoded.length);
		});
	}

	test("rejects negative lengths", () => {
		expect(() => encodeLength(-1)).toThrow();
	});

	test("rejects lengths beyond the 32-bit limit", () => {
		expect(() => encodeLength(0x100000000)).toThrow();
	});

	test("encodes the 4-byte boundary 0x0fffffff", () => {
		expect(hex(encodeLength(0x0fffffff))).toBe(
			hex(Uint8Array.of(0xef, 0xff, 0xff, 0xff)),
		);
		expect(decodeLength(encodeLength(0x0fffffff), 0)?.value).toBe(0x0fffffff);
	});

	test("round-trips the 5-byte value 0xffffffff", () => {
		const encoded = encodeLength(0xffffffff);
		expect(encoded[0]).toBe(0xf0);
		expect(decodeLength(encoded, 0)?.value).toBe(0xffffffff);
	});

	test("decodeLength returns null when prefix incomplete", () => {
		// 0xC0 starts a 3-byte prefix; only one byte available.
		expect(decodeLength(Uint8Array.of(0xc0), 0)).toBeNull();
	});

	test("decodeLength returns null at end of buffer", () => {
		expect(decodeLength(new Uint8Array(0), 0)).toBeNull();
	});

	test("decodeLength throws on invalid descriptor", () => {
		expect(() => decodeLength(Uint8Array.of(0xf8), 0)).toThrow();
	});
});

describe("native-api word and sentence framing", () => {
	test("encodes a short word with a 1-byte prefix", () => {
		expect(hex(encodeWord("/login"))).toBe(
			hex(Uint8Array.of(0x06, 0x2f, 0x6c, 0x6f, 0x67, 0x69, 0x6e)),
		);
	});

	test("encodes UTF-8 multibyte content by byte length", () => {
		const encoded = encodeWord("é"); // 2 UTF-8 bytes
		expect(encoded[0]).toBe(0x02);
		expect(encoded.length).toBe(3);
	});

	test("sentence ends with a zero-length terminator word", () => {
		const sentence = encodeSentence(["/login"]);
		expect(sentence[sentence.length - 1]).toBe(0x00);
	});

	test("empty sentence is a single zero byte", () => {
		expect(hex(encodeSentence([]))).toBe("00");
	});

	test("round-trips a full login sentence", () => {
		const words = ["/login", "=name=admin", "=password=secret"];
		const reader = new SentenceReader();
		const sentences = reader.push(encodeSentence(words));
		expect(sentences).toHaveLength(1);
		expect(sentences[0]).toEqual(words);
	});
});

/**
 * JG-15 — attribute *value* round-trip across the codec, the worry case the
 * other transports escape but native-api does not. The API protocol is
 * length-prefix framed, not delimiter-escaped: a word is a UTF-8 byte count, so
 * any UTF-8 content — `=`, spaces, CR/LF, NUL, multibyte characters — survives
 * verbatim with no escaping. `parseReply` splits `=name=value` on the *second* `=`
 * ({@link parseReply} uses `indexOf("=", 1)`), so a value that itself contains
 * `=` is returned whole, not truncated. This pins that no caller-side trimming
 * or naive `split("=")` corrupts a value end-to-end:
 * `attributeWord → encodeSentence → SentenceReader → parseReply`.
 */
describe("native-api attribute value round-trip (JG-15)", () => {
	/** Send one `=name=value` attribute through the full codec and read it back. */
	function roundTrip(name: string, value: string): string | undefined {
		const words = ["!re", attributeWord(name, value)];
		const reader = new SentenceReader();
		const [sentence, ...rest] = reader.push(encodeSentence(words));
		expect(rest).toHaveLength(0);
		if (!sentence) throw new Error("codec decoded no sentence");
		return readAttribute(parseReply(sentence), name);
	}

	const cases: Array<[label: string, value: string]> = [
		["a value containing '=' (split on the second =)", "key1=val1=val2"],
		["an embedded RouterOS expression with =", "([/system/clock/get date]=x)"],
		["spaces (an unquoted comment)", "office uplink — do not touch"],
		["a literal CR/LF inside the value", "line1\r\nline2"],
		["a tab and other control bytes", "a\tb\x01c"],
		["a NUL byte mid-value (framing is length-prefixed)", "before\x00after"],
		["multibyte UTF-8", "café — ☃ — 日本語 — 🛰️"],
		[
			"RouterOS escapes left literal (no double-escaping)",
			'\\"quoted\\" $x \\n ;',
		],
		["leading/trailing whitespace is preserved", "  padded  "],
		["the empty value", ""],
		["a long value spanning a multi-byte length prefix", "z".repeat(0x250)],
	];

	for (const [label, value] of cases) {
		test(label, () => {
			expect(roundTrip("comment", value)).toBe(value);
		});
	}

	test("a value-less attribute (`=name=`) reads back as the empty string", () => {
		// parseReply maps both `=name=` and a bare `=name` to "".
		expect(roundTrip("disabled", "")).toBe("");
		const reader = new SentenceReader();
		const [sentence] = reader.push(encodeSentence(["!re", "=name"]));
		if (!sentence) throw new Error("codec decoded no sentence");
		expect(readAttribute(parseReply(sentence), "name")).toBe("");
	});
});

describe("native-api SentenceReader streaming", () => {
	test("reassembles a sentence split across arbitrary byte boundaries", () => {
		const sentence = encodeSentence(["!re", "=name=ether1", "=type=ether"]);
		const reader = new SentenceReader();
		const collected: string[][] = [];
		for (const byte of sentence) {
			collected.push(...reader.push(Uint8Array.of(byte)));
		}
		expect(collected).toHaveLength(1);
		expect(collected[0]).toEqual(["!re", "=name=ether1", "=type=ether"]);
		expect(reader.pending).toBe(0);
	});

	test("emits multiple sentences from one chunk", () => {
		const a = encodeSentence(["!re", "=name=ether1"]);
		const b = encodeSentence(["!done"]);
		const merged = new Uint8Array(a.length + b.length);
		merged.set(a, 0);
		merged.set(b, a.length);
		const reader = new SentenceReader();
		const sentences = reader.push(merged);
		expect(sentences).toHaveLength(2);
		expect(sentences[0]).toEqual(["!re", "=name=ether1"]);
		expect(sentences[1]).toEqual(["!done"]);
	});

	test("buffers a partial multi-byte length prefix", () => {
		const word = encodeWord("x".repeat(0x200)); // 3-byte prefix
		const reader = new SentenceReader();
		// Feed only the first prefix byte: nothing should complete.
		expect(reader.push(word.subarray(0, 1))).toHaveLength(0);
		expect(reader.pending).toBe(1);
	});
});

describe("native-api reply parsing", () => {
	test("parses =name=value attributes, splitting on the second =", () => {
		const reply = parseReply(["!re", "=.id=*1", "=name=iu=c3Eeg", "=comment="]);
		expect(reply.type).toBe("!re");
		expect(readAttribute(reply, ".id")).toBe("*1");
		expect(readAttribute(reply, "name")).toBe("iu=c3Eeg");
		expect(readAttribute(reply, "comment")).toBe("");
	});

	test("captures the .tag word", () => {
		const reply = parseReply(["!done", ".tag=t7"]);
		expect(reply.tag).toBe("t7");
	});

	test("recognizes all reply types", () => {
		expect(parseReply(["!re"]).type).toBe("!re");
		expect(parseReply(["!done"]).type).toBe("!done");
		expect(parseReply(["!trap"]).type).toBe("!trap");
		expect(parseReply(["!fatal"]).type).toBe("!fatal");
		expect(parseReply(["!empty"]).type).toBe("!empty");
	});

	test("treats an unknown head word as fatal", () => {
		expect(parseReply(["garbage"]).type).toBe("!fatal");
	});

	test("attributeWord builds =name=value", () => {
		expect(attributeWord("name", "admin")).toBe("=name=admin");
	});
});

describe("native-api challenge response", () => {
	test("matches the documented construction (00 + md5(0x00||pass||challenge))", () => {
		const password = "passTest";
		const challengeHex = "abc123";
		const expected = createHash("md5")
			.update(Buffer.from([0]))
			.update(Buffer.from(password, "utf8"))
			.update(Buffer.from(challengeHex, "hex"))
			.digest("hex");
		expect(challengeResponse(challengeHex, password)).toBe(`00${expected}`);
	});

	test("response is the literal '00' prefix plus 32 hex chars", () => {
		const response = challengeResponse("00112233445566778899aabbccddeeff", "x");
		expect(response).toHaveLength(34);
		expect(response.startsWith("00")).toBe(true);
	});
});

/** In-memory sink + scripted server for driving a session without a socket. */
class FakeTransport implements NativeApiByteSink {
	readonly sent: string[][] = [];
	closed = false;
	private readonly session: NativeApiSession;

	constructor() {
		this.session = new NativeApiSession({ sink: this, endpoint: "fake:8728" });
	}

	get apiSession(): NativeApiSession {
		return this.session;
	}

	write(bytes: Uint8Array): void {
		const reader = new SentenceReader();
		for (const sentence of reader.push(bytes)) {
			this.sent.push(sentence);
		}
	}

	close(): void {
		this.closed = true;
	}

	/** Simulate the server replying with the given sentences. */
	reply(...sentences: string[][]): void {
		for (const words of sentences) {
			this.session.handleData(encodeSentence(words));
		}
	}

	lastTag(): string {
		const last = this.sent.at(-1) ?? [];
		const tagWord = last.find((word) => word.startsWith(".tag="));
		return tagWord?.slice(".tag=".length) ?? "";
	}
}

describe("native-api session command flow", () => {
	test("collects !re records and resolves on !done", async () => {
		const transport = new FakeTransport();
		const promise = transport.apiSession.talk({ command: "/interface/print" });
		const tag = transport.lastTag();
		transport.reply(
			["!re", "=name=ether1", `.tag=${tag}`],
			["!re", "=name=ether2", `.tag=${tag}`],
			["!done", `.tag=${tag}`],
		);
		const records = await promise;
		expect(records).toHaveLength(2);
		expect(readAttribute(records[0] as ApiReply, "name")).toBe("ether1");
	});

	test("includes a !done sentence that carries attributes", async () => {
		const transport = new FakeTransport();
		const promise = transport.apiSession.talk({
			command: "/system/identity/print",
		});
		const tag = transport.lastTag();
		transport.reply(["!done", "=ret=router1", `.tag=${tag}`]);
		const records = await promise;
		expect(records).toHaveLength(1);
		expect(readAttribute(records[0] as ApiReply, "ret")).toBe("router1");
	});

	test("rejects with a routeros/api-trap error", async () => {
		const transport = new FakeTransport();
		const promise = transport.apiSession.talk({ command: "/bogus/print" });
		const tag = transport.lastTag();
		transport.reply(
			["!trap", "=category=0", "=message=no such command", `.tag=${tag}`],
			["!done", `.tag=${tag}`],
		);
		await expect(promise).rejects.toMatchObject({ code: "routeros/api-trap" });
	});

	test("multiplexes concurrent tagged commands", async () => {
		const transport = new FakeTransport();
		const first = transport.apiSession.talk({ command: "/a/print" });
		const firstTag = transport.lastTag();
		const second = transport.apiSession.talk({ command: "/b/print" });
		const secondTag = transport.lastTag();
		expect(firstTag).not.toBe(secondTag);
		// Reply to the second command first to prove routing by tag.
		transport.reply(["!done", "=ret=B", `.tag=${secondTag}`]);
		transport.reply(["!done", "=ret=A", `.tag=${firstTag}`]);
		expect(readAttribute((await second)[0] as ApiReply, "ret")).toBe("B");
		expect(readAttribute((await first)[0] as ApiReply, "ret")).toBe("A");
	});

	test("builds .proplist and query words", async () => {
		const transport = new FakeTransport();
		const promise = transport.apiSession.talk({
			command: "/interface/print",
			proplist: ["name", "type"],
			queries: ["?type=ether"],
		});
		const tag = transport.lastTag();
		const sent = transport.sent.at(-1) ?? [];
		expect(sent).toContain("=.proplist=name,type");
		expect(sent).toContain("?type=ether");
		transport.reply(["!done", `.tag=${tag}`]);
		await promise;
	});

	test("!fatal rejects all in-flight commands", async () => {
		const transport = new FakeTransport();
		const promise = transport.apiSession.talk({ command: "/a/print" });
		transport.reply(["!fatal", "=message=session terminated"]);
		await expect(promise).rejects.toMatchObject({ code: "routeros/api-fatal" });
	});

	test("transport close rejects pending commands", async () => {
		const transport = new FakeTransport();
		const promise = transport.apiSession.talk({ command: "/a/print" });
		transport.apiSession.handleClose();
		await expect(promise).rejects.toMatchObject({
			code: "transport/connection-closed",
		});
	});
});

describe("native-api login flow", () => {
	test("modern plaintext login succeeds on bare !done", async () => {
		const transport = new FakeTransport();
		const promise = transport.apiSession.login("admin", "secret");
		const tag = transport.lastTag();
		const sent = transport.sent.at(-1) ?? [];
		expect(sent[0]).toBe("/login");
		expect(sent).toContain("=name=admin");
		expect(sent).toContain("=password=secret");
		transport.reply(["!done", `.tag=${tag}`]);
		await expect(promise).resolves.toBeUndefined();
	});

	test("legacy challenge login sends a second =response= login", async () => {
		const transport = new FakeTransport();
		const challenge = "abc123";
		const promise = transport.apiSession.login("admin", "secret");
		const firstTag = transport.lastTag();
		transport.reply(["!done", `=ret=${challenge}`, `.tag=${firstTag}`]);
		// The second /login is sent on a microtask after the first resolves;
		// poll the transport until that second write actually lands.
		for (let i = 0; i < 100 && transport.sent.length < 2; i++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(transport.sent.length).toBeGreaterThan(1);
		// Second /login carries =response=.
		const secondTag = transport.lastTag();
		const secondSent = transport.sent.at(-1) ?? [];
		expect(secondSent).toContain(
			`=response=${challengeResponse(challenge, "secret")}`,
		);
		transport.reply(["!done", `.tag=${secondTag}`]);
		await expect(promise).resolves.toBeUndefined();
	});

	test("login failure maps to transport/auth-failed", async () => {
		const transport = new FakeTransport();
		const promise = transport.apiSession.login("admin", "wrong");
		const tag = transport.lastTag();
		transport.reply(
			["!trap", "=message=invalid user name or password (6)", `.tag=${tag}`],
			["!done", `.tag=${tag}`],
		);
		await expect(promise).rejects.toMatchObject({
			code: "transport/auth-failed",
		});
	});
});

describe("isNativeAuthFailure (grounded auth classification)", () => {
	test("classifies live RouterOS auth trap strings as auth failures", () => {
		const authMessages = [
			"could not authenticate - radius timeout (13)",
			"invalid user name or password (6)",
			"not logged in",
			"access denied",
			"bad password",
		];
		for (const message of authMessages) {
			expect(isNativeAuthFailure("/ip/address/print", message)).toBe(true);
		}
	});

	test("treats any failure on /login as an auth failure", () => {
		expect(isNativeAuthFailure("/login", "unexpected")).toBe(true);
	});

	test("does not misclassify a genuine syntax/parse trap as auth", () => {
		expect(
			isNativeAuthFailure("/ip/address/print", "no such command or directory"),
		).toBe(false);
		expect(
			isNativeAuthFailure(
				"/ip/address/print",
				"syntax error (line 1 column 5)",
			),
		).toBe(false);
	});
});
