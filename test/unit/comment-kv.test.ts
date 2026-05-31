import { describe, expect, test } from "bun:test";
import {
	commentKvAllowlist,
	commentKvReservedKeys,
	parseCommentKv,
} from "../../src/resolver/comment-kv.ts";

describe("parseCommentKv", () => {
	test("empty and whitespace comments yield nothing", () => {
		for (const comment of ["", "   ", "\t\n  "]) {
			const result = parseCommentKv(comment);
			expect(result.values).toEqual({});
			expect(result.warnings).toEqual([]);
		}
	});

	test("free-form prose without tokens is inert", () => {
		const result = parseCommentKv("edge router in rack 4, owned by neteng");
		expect(result.values).toEqual({});
		expect(result.warnings).toEqual([]);
	});

	test("parses allowlisted keys interleaved with prose", () => {
		const result = parseCommentKv("primary edge via=native-api port=8729 ok");
		expect(result.values).toEqual({ via: "native-api", port: "8729" });
		expect(result.warnings).toEqual([]);
	});

	test("parses every allowlisted key", () => {
		const result = parseCommentKv(
			"via=ssh validate=false timeout=4000 port=2222 source=mndp",
		);
		expect(result.values).toEqual({
			via: "ssh",
			validate: "false",
			timeout: "4000",
			port: "2222",
			source: "mndp",
		});
		expect(result.warnings).toEqual([]);
	});

	test("last occurrence wins on duplicate keys", () => {
		const result = parseCommentKv("via=rest-api via=native-api");
		expect(result.values).toEqual({ via: "native-api" });
	});

	test("double-quoted values may contain spaces and equals", () => {
		const result = parseCommentKv('source="dude import: a=b c" via=ssh');
		expect(result.values).toEqual({ source: "dude import: a=b c", via: "ssh" });
		expect(result.warnings).toEqual([]);
	});

	test('backslash escapes inside quotes: \\" and \\\\', () => {
		const result = parseCommentKv('source="say \\"hi\\" \\\\ path"');
		expect(result.values.source).toBe('say "hi" \\ path');
	});

	test("newlines act as token separators outside quotes", () => {
		const result = parseCommentKv("via=ssh\nport=2222\ttimeout=1000");
		expect(result.values).toEqual({
			via: "ssh",
			port: "2222",
			timeout: "1000",
		});
	});

	test("unknown keys warn but do not populate values", () => {
		const result = parseCommentKv("color=blue via=ssh");
		expect(result.values).toEqual({ via: "ssh" });
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]?.code).toBe("cdb/unknown-option");
		expect(result.warnings[0]?.context.key).toBe("color");
	});

	test("first-class CDB keys are reserved and ignored with a warning", () => {
		for (const key of commentKvReservedKeys) {
			const result = parseCommentKv(`${key}=value via=ssh`);
			expect(result.values).toEqual({ via: "ssh" });
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]?.code).toBe("cdb/reserved-option");
			expect(result.warnings[0]?.context.key).toBe(key);
		}
	});

	test("a quoted key is not a kv token (key must be bare)", () => {
		const result = parseCommentKv('"via"=ssh');
		expect(result.values).toEqual({});
		expect(result.warnings).toEqual([]);
	});

	test("a quoted-before-equals key is inert, not a reserved/unknown warning", () => {
		// The `=` originates after a quoted span, so this is not a kv token.
		const result = parseCommentKv('vi"a"=ssh');
		expect(result.values).toEqual({});
		expect(result.warnings).toEqual([]);
	});

	test("leading-equals and empty key tokens are inert", () => {
		const result = parseCommentKv("=ssh ==x");
		expect(result.values).toEqual({});
		expect(result.warnings).toEqual([]);
	});

	test("keys with invalid characters are inert (not partial matches)", () => {
		const result = parseCommentKv("1via=ssh foo.bar=baz");
		expect(result.values).toEqual({});
		expect(result.warnings).toEqual([]);
	});

	test("empty value is preserved for an allowlisted key", () => {
		const result = parseCommentKv("source= via=ssh");
		expect(result.values.source).toBe("");
		expect(result.values.via).toBe("ssh");
	});

	test("unterminated quote consumes the remainder as a value (best effort)", () => {
		const result = parseCommentKv('source="open ended value');
		expect(result.values.source).toBe("open ended value");
		expect(result.warnings).toEqual([]);
	});

	test("the allowlist is exactly the documented five keys", () => {
		expect([...commentKvAllowlist]).toEqual([
			"via",
			"validate",
			"timeout",
			"port",
			"source",
		]);
	});
});
