import { describe, expect, test } from "bun:test";
import {
	mapRouterOsError,
	mapRouterOsResultError,
	parseRouterOsPosition,
	routerOsErrorRules,
} from "../../src/core/routeros-errors.ts";
import type { CentrsError } from "../../src/errors.ts";

interface ErrorContext {
	detail?: string;
	parameter?: string;
	argument?: string;
	failure?: string;
	httpStatus?: number;
	path?: string;
}

function ctx(error: CentrsError): ErrorContext {
	return (error.context ?? {}) as ErrorContext;
}

describe("mapRouterOsError grounded vocabulary", () => {
	test("maps 'no such command prefix' to routeros/unknown-path", () => {
		const error = mapRouterOsError("no such command prefix");
		expect(error.code).toBe("routeros/unknown-path");
		expect(ctx(error).detail).toBe("no such command prefix");
	});

	// #659, CHR 7.25.1: an unknown path is `no such command …` on both
	// transports; a missing item in a known menu is `no such item`.
	test("maps every 'no such command' form to routeros/unknown-path", () => {
		for (const raw of [
			"no such command",
			"no such command prefix",
			"no such command or directory (nosuch)",
		]) {
			for (const transport of ["rest-api", "native-api"] as const) {
				expect(mapRouterOsError(raw, { transport, httpStatus: 400 }).code).toBe(
					"routeros/unknown-path",
				);
			}
		}
	});

	test("maps 'no such item' to routeros/no-such-item, not unknown-path", () => {
		for (const raw of [
			"no such item",
			"no such item (4)",
			"no such item (4) (/ip/address/set; line 1)",
		]) {
			expect(mapRouterOsError(raw).code).toBe("routeros/no-such-item");
		}
	});

	test("maps a bare REST 404 body to routeros/no-such-item", () => {
		const body = '{"error":404,"message":"Not Found"}';
		const error = mapRouterOsError(body, {
			transport: "rest-api",
			httpStatus: 404,
		});
		expect(error.code).toBe("routeros/no-such-item");
		expect(ctx(error).detail).toBe(body);
		expect(error.summary).toContain("HTTP 404");
	});

	test("the 404 rule needs the 404 status", () => {
		// The same text without the status is not a REST reply; it falls back
		// to the path-shaped 'not found' rule.
		const body = '{"error":404,"message":"Not Found"}';
		expect(mapRouterOsError(body, { transport: "rest-api" }).code).not.toBe(
			"routeros/no-such-item",
		);
	});

	test("maps path-shaped 'not found' to routeros/unknown-path", () => {
		expect(mapRouterOsError("/ip/foo not found").code).toBe(
			"routeros/unknown-path",
		);
	});

	test("maps 'unknown parameter <x>' and extracts the parameter", () => {
		const error = mapRouterOsError("unknown parameter foo");
		expect(error.code).toBe("routeros/unknown-attribute");
		expect(ctx(error).parameter).toBe("foo");
	});

	test("maps 'invalid value for argument <y>' and extracts the argument", () => {
		const error = mapRouterOsError("invalid value for argument address");
		expect(error.code).toBe("routeros/invalid-value");
		expect(ctx(error).argument).toBe("address");
	});

	test("maps 'invalid value of <y>' and extracts the argument", () => {
		const error = mapRouterOsError("invalid value of disabled");
		expect(error.code).toBe("routeros/invalid-value");
		expect(ctx(error).argument).toBe("disabled");
	});

	test("maps 'input does not match' runtime rejection to invalid-value", () => {
		const error = mapRouterOsError(
			"input does not match any value of certificate",
		);
		expect(error.code).toBe("routeros/invalid-value");
		expect(ctx(error).detail).toBe(
			"input does not match any value of certificate",
		);
	});

	test("maps 'Session closed' to routeros/session-closed with 60-second fix", () => {
		const error = mapRouterOsError("Session closed");
		expect(error.code).toBe("routeros/session-closed");
		expect(error.remediation).toMatch(/60 seconds/);
		// #639: a sent command may have run; the REST cap stays its own limit.
		expect(error.remediation).toMatch(/may still be running/);
		expect(error.remediation).toMatch(/`--timeout` cannot extend/);
		expect(error.remediation).toMatch(/--wait \d+[a-z]+ --until/);
	});

	test("maps native 'action timed out (13)' to routeros/action-timed-out (#639)", () => {
		const error = mapRouterOsError("action timed out (13)", {
			transport: "native-api",
		});
		expect(error.code).toBe("routeros/action-timed-out");
		expect(ctx(error).detail).toBe("action timed out (13)");
		expect(error.summary).toMatch(/may still be running/);
		// A per-command limit, not a native-API one, and nothing centrs-side
		// extends it: no `--via native-api` workaround, no "router may be busy".
		expect(error.remediation).toMatch(/`--timeout` does not extend it/);
		expect(error.remediation).toMatch(/\/container\/shell timeout=<seconds>/);
		// `--wait` takes a deadline; bare, it would read `--until` as one (#445).
		expect(error.remediation).toMatch(/--wait \d+[a-z]+ --until/);
		expect(error.remediation).not.toMatch(/--via|native API|may be busy/i);
	});

	test("maps generic 'failure: <msg>' to routeros/command-failed", () => {
		const error = mapRouterOsError(
			"failure: cannot add already have such entry",
		);
		expect(error.code).toBe("routeros/command-failed");
		expect(ctx(error).failure).toBe("cannot add already have such entry");
		expect(ctx(error).detail).toBe(
			"failure: cannot add already have such entry",
		);
	});

	test("strips an optional 'failure: ' prefix before specific matching", () => {
		const error = mapRouterOsError("failure: no such item");
		expect(error.code).toBe("routeros/no-such-item");
	});

	test("maps 'failure: <object> not found' to routeros/command-failed", () => {
		// A `failure:` command rejection whose message merely contains 'not found'
		// is a command failure, not a path mismatch — the anchored command-failed
		// rule must win over the bare 'not found' path heuristic.
		const error = mapRouterOsError("failure: interface not found");
		expect(error.code).toBe("routeros/command-failed");
		expect(ctx(error).failure).toBe("interface not found");
	});

	test("native-api catch-all is routeros/api-trap", () => {
		const error = mapRouterOsError("some brand new message", {
			transport: "native-api",
		});
		expect(error.code).toBe("routeros/api-trap");
		expect(error.causeData).toBe("some brand new message");
	});

	test("REST and native-api classify grounded RouterOS strings identically", () => {
		for (const raw of [
			"no such command prefix",
			"no such command",
			"no such item",
			"unknown parameter foo",
			"invalid value for argument address",
			"Session closed",
			"action timed out (13)",
			"failure: cannot add already have such entry",
		]) {
			const rest = mapRouterOsError(raw, {
				transport: "rest-api",
				httpStatus: 400,
			});
			const native = mapRouterOsError(raw, { transport: "native-api" });
			expect(rest.code).toBe(native.code);
			expect(rest.causeData).toBe(raw);
			expect(native.causeData).toBe(raw);
		}
	});

	test("rest-api catch-all is routeros/request-failed", () => {
		const error = mapRouterOsError("some brand new message", {
			transport: "rest-api",
		});
		expect(error.code).toBe("routeros/request-failed");
	});

	// #663: a script that stops on `:error` keeps its earlier steps (CHR 7.25.1),
	// so the catch-all must not invite a blind rerun of a write.
	test("catch-all remediation asks for a state check before a rerun", () => {
		for (const transport of ["native-api", "rest-api"] as const) {
			const error = mapRouterOsError("pr663 deliberate stop", { transport });
			expect(error.remediation).toContain("may have partly run");
			expect(error.remediation).toContain("check the router's state");
		}
	});

	test("preserves the original string in context.detail", () => {
		const raw = "  unknown parameter weird  ";
		const error = mapRouterOsError(raw);
		expect(ctx(error).detail).toBe(raw);
		expect(ctx(error).parameter).toBe("weird");
	});

	test("matching is case-insensitive and whitespace tolerant", () => {
		expect(mapRouterOsError("   NO SUCH ITEM   ").code).toBe(
			"routeros/no-such-item",
		);
		expect(ctx(mapRouterOsError("UNKNOWN PARAMETER Foo")).parameter).toBe(
			"Foo",
		);
	});

	test("merges caller-supplied context and httpStatus", () => {
		const error = mapRouterOsError("Session closed", {
			transport: "rest-api",
			httpStatus: 400,
			context: { path: "/interface" },
		});
		expect(ctx(error).httpStatus).toBe(400);
		expect(ctx(error).path).toBe("/interface");
	});

	test("sets details_url from the normalized code", () => {
		const error = mapRouterOsError("no such item");
		expect(error.detailsUrl).toBe(
			"https://tikoci.dev/centrs/errors/routeros/no-such-item/",
		);
	});

	test("exposes an ordered, introspectable rule table", () => {
		expect(routerOsErrorRules.length).toBeGreaterThan(0);
		for (const rule of routerOsErrorRules) {
			expect(rule.code.startsWith("routeros/")).toBe(true);
			expect(rule.test).toBeInstanceOf(RegExp);
			expect(typeof rule.build).toBe("function");
		}
	});
});

describe("mapRouterOsResultError", () => {
	test("recognizes grounded /execute runtime rejection shapes", () => {
		expect(
			mapRouterOsResultError("input does not match any value of certificate", {
				transport: "rest-api",
			})?.code,
		).toBe("routeros/invalid-value");
		expect(
			mapRouterOsResultError("no such item", {
				transport: "native-api",
			})?.code,
		).toBe("routeros/no-such-item");
		expect(
			mapRouterOsResultError("no such item (4) (/ip/address/set; line 1)", {
				transport: "rest-api",
			})?.code,
		).toBe("routeros/no-such-item");
		expect(
			mapRouterOsResultError("syntax error (line 1 column 7)", {
				transport: "rest-api",
			})?.code,
		).toBe("routeros/request-failed");
	});

	// #665 review: the result matchers take the whole grounded diagnostic
	// only, so prose that starts with the phrase stays ordinary output.
	test("classifies every grounded 'no such' result form", () => {
		for (const [raw, code] of [
			["no such command", "routeros/unknown-path"],
			["no such command prefix", "routeros/unknown-path"],
			["no such command or directory (nosuch)", "routeros/unknown-path"],
			["no such item", "routeros/no-such-item"],
			["no such item (4)", "routeros/no-such-item"],
			["no such item (4) (/ip/address/set; line 1)", "routeros/no-such-item"],
			["no such item (/interface/set; line 1)\n", "routeros/no-such-item"],
		] as const) {
			expect(mapRouterOsResultError(raw)?.code, raw).toBe(code);
		}
	});

	test("does not classify prose that starts with a 'no such' phrase", () => {
		for (const raw of [
			"no such command was found in the help text",
			"no such command prefix exists here, all good",
			"no such item matched, so nothing to do",
			"no such entry in the cache yet",
		]) {
			expect(mapRouterOsResultError(raw), raw).toBeUndefined();
		}
	});

	test("does not classify arbitrary output containing error-like prose", () => {
		expect(
			mapRouterOsResultError("status: no such item appears in the help text"),
		).toBeUndefined();
		expect(
			mapRouterOsResultError(
				"the phrase input does not match is ordinary script output",
			),
		).toBeUndefined();
		expect(mapRouterOsResultError("1")).toBeUndefined();
		expect(mapRouterOsResultError("")).toBeUndefined();
	});
});

describe("parseRouterOsPosition (JG-16)", () => {
	test("extracts the byte line/column from a console parse string", () => {
		// Grounded console form: `bad parameter <name> (line N column M)`.
		expect(
			parseRouterOsPosition("bad parameter address (line 1 column 35)"),
		).toEqual({ line: 1, column: 35 });
		expect(parseRouterOsPosition("syntax error (line 2 column 7)")).toEqual({
			line: 2,
			column: 7,
		});
	});

	test("finds the position embedded in the parsed `(evl …)` console form", () => {
		// The grounded console capture (CHR 7.23.1): the position sits mid-string,
		// not as a suffix — see test/unit/mac-telnet-console.test.ts fixtures.
		expect(
			parseRouterOsPosition(
				"(evl bad parameter no-such-arg (line 1 column 28) /ip/address/add)",
			),
		).toEqual({ line: 1, column: 28 });
	});

	test("returns undefined when no position is present", () => {
		// REST/native say `unknown parameter <name>` with no source location.
		expect(parseRouterOsPosition("unknown parameter foo")).toBeUndefined();
		expect(parseRouterOsPosition("")).toBeUndefined();
	});
});

describe("mapRouterOsError surfaces error.position when present (JG-16)", () => {
	test("attaches the byte offset from a positioned console string", () => {
		const error = mapRouterOsError("bad parameter address (line 1 column 35)");
		expect(error.position).toEqual({ line: 1, column: 35 });
		// The raw string is still preserved verbatim.
		expect(ctx(error).detail).toBe("bad parameter address (line 1 column 35)");
	});

	test("omits position for a REST/native string without a source location", () => {
		expect(mapRouterOsError("unknown parameter foo").position).toBeUndefined();
	});
});

describe("routeros/permission-denied (CHR 7.25 strings)", () => {
	test("maps the native trap and REST detail for a missing write policy", () => {
		for (const transport of ["native-api", "rest-api"] as const) {
			expect(
				mapRouterOsError("not enough permissions (9)", { transport }).code,
			).toBe("routeros/permission-denied");
		}
	});

	test("maps REST's refusal when the group has rest-api but not api", () => {
		expect(
			mapRouterOsError("std failure: not allowed (9)", {
				transport: "rest-api",
			}).code,
		).toBe("routeros/permission-denied");
	});

	test.each([
		"not enough permissions (9)",
		"not enough permissions (9) (/system/identity/set; line 1)",
	])("maps /execute as-string denial: %s", (output) => {
		expect(
			mapRouterOsResultError(output, { transport: "rest-api" })?.code,
		).toBe("routeros/permission-denied");
	});

	test.each([
		// #549: earlier statements' stdout precedes the refusal, CRLF (REST)
		// and LF alike; identical shape on native-api.
		"p5-first\r\nnot enough permissions (9) (/system/identity/set; line 1)",
		"p5-first\nnot enough permissions (9) (/system/identity/set; line 1)",
		"one\ntwo\r\nnot enough permissions (9) (/ip/address/add; line 3)",
	])("maps a trailed mid-script denial: %s", (output) => {
		for (const transport of ["native-api", "rest-api"] as const) {
			expect(mapRouterOsResultError(output, { transport })?.code).toBe(
				"routeros/permission-denied",
			);
		}
	});

	test.each([
		"note: not enough permissions here",
		"not enough permissions (9) is an example from the manual",
		"not enough permissions (9) (/system/identity/set; line 1) is an example",
		// A script that merely prints the bare phrase, even last, is output.
		"p5-first\nnot enough permissions (9)",
		// Trailing prose after the refusal is not the device's verdict line.
		"p5-first\nnot enough permissions (9) (/system/identity/set; line 1)\nmore output",
	])("leaves ordinary output alone: %s", (output) => {
		expect(
			mapRouterOsResultError(output, {
				transport: "rest-api",
			}),
		).toBeUndefined();
	});
});
