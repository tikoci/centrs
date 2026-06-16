import { describe, expect, test } from "bun:test";
import {
	mapRouterOsError,
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

	test("maps 'no such item' to routeros/unknown-path", () => {
		expect(mapRouterOsError("no such item").code).toBe("routeros/unknown-path");
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

	test("maps 'Session closed' to routeros/session-closed with 60-second fix", () => {
		const error = mapRouterOsError("Session closed");
		expect(error.code).toBe("routeros/session-closed");
		expect(error.remediation).toMatch(/60-second/);
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
		expect(error.code).toBe("routeros/unknown-path");
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
			"unknown parameter foo",
			"invalid value for argument address",
			"Session closed",
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

	test("preserves the original string in context.detail", () => {
		const raw = "  unknown parameter weird  ";
		const error = mapRouterOsError(raw);
		expect(ctx(error).detail).toBe(raw);
		expect(ctx(error).parameter).toBe("weird");
	});

	test("matching is case-insensitive and whitespace tolerant", () => {
		expect(mapRouterOsError("   NO SUCH ITEM   ").code).toBe(
			"routeros/unknown-path",
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
			"https://tikoci.github.io/centrs/errors/routeros/unknown-path",
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
