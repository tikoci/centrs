import { describe, expect, test } from "bun:test";
import {
	applyCommentKv,
	commentKvAllowlist,
	commentKvLookupKeys,
	commentKvReservedKeys,
	parseCommentKv,
	renderCommentKvToken,
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
			"via=ssh validate=false timeout=4000 port=2222 source=mndp mcp=rw",
		);
		expect(result.values).toEqual({
			via: "ssh",
			validate: "false",
			timeout: "4000",
			port: "2222",
			source: "mndp",
			mcp: "rw",
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

	test("the allowlist is exactly the documented keys", () => {
		expect([...commentKvAllowlist]).toEqual([
			"via",
			"validate",
			"timeout",
			"port",
			"source",
			"mcp",
			"ssh-key",
			"insecure",
		]);
	});

	test("the lookup keys are exactly identity/mac/ip", () => {
		expect([...commentKvLookupKeys]).toEqual(["identity", "mac", "ip"]);
	});

	test("parses lookup keys into lookups, not values, with no warnings", () => {
		const result = parseCommentKv(
			"identity=edge1 mac=AA:BB:CC:DD:EE:FF ip=192.0.2.5 via=ssh",
		);
		expect(result.lookups).toEqual({
			identity: "edge1",
			mac: "AA:BB:CC:DD:EE:FF",
			ip: "192.0.2.5",
		});
		expect(result.values).toEqual({ via: "ssh" });
		expect(result.warnings).toEqual([]);
	});

	test("lookup keys are recognized, not unknown-option", () => {
		const result = parseCommentKv("identity=edge1");
		expect(result.warnings).toEqual([]);
		expect(result.lookups.identity).toBe("edge1");
	});

	test("last occurrence wins on duplicate lookup keys", () => {
		expect(parseCommentKv("identity=old identity=new").lookups.identity).toBe(
			"new",
		);
	});

	test("a lookup value may be quoted with spaces", () => {
		const result = parseCommentKv('identity="My Edge Router"');
		expect(result.lookups.identity).toBe("My Edge Router");
		expect(result.warnings).toEqual([]);
	});

	test("lookups are empty for prose and override-only comments", () => {
		expect(parseCommentKv("via=ssh rack 7").lookups).toEqual({});
		expect(parseCommentKv("").lookups).toEqual({});
	});
});

describe("applyCommentKv", () => {
	test("appends a kv token while preserving free-form prose", () => {
		const next = applyCommentKv("owned by neteng", [
			{ key: "via", value: "ssh" },
		]);
		expect(next).toBe("owned by neteng via=ssh");
		expect(parseCommentKv(next).values.via).toBe("ssh");
	});

	test("upserts an existing key in place without duplicating", () => {
		const next = applyCommentKv("via=rest-api site=x", [
			{ key: "via", value: "ssh" },
		]);
		expect(next).toBe("via=ssh site=x");
	});

	test("removes a key and collapses the surrounding whitespace", () => {
		const next = applyCommentKv("via=ssh rack 7", [
			{ key: "via", value: null },
		]);
		expect(next).toBe("rack 7");
	});

	test("quotes values with spaces so they round-trip as one token", () => {
		const next = applyCommentKv("note here", [
			{ key: "source", value: "rack 7 row B" },
		]);
		expect(next).toBe('note here source="rack 7 row B"');
		expect(parseCommentKv(next).values.source).toBe("rack 7 row B");
	});

	test("escapes embedded quotes and backslashes", () => {
		const value = 'a "b" \\c';
		const token = renderCommentKvToken("source", value);
		const parsed = parseCommentKv(token);
		expect(parsed.values.source).toBe(value);
	});

	test("applies multiple updates in order", () => {
		const next = applyCommentKv("keep me", [
			{ key: "via", value: "ssh" },
			{ key: "validate", value: "false" },
			{ key: "via", value: "rest-api" },
		]);
		const parsed = parseCommentKv(next);
		expect(parsed.values.via).toBe("rest-api");
		expect(parsed.values.validate).toBe("false");
		expect(next).toContain("keep me");
	});
});
