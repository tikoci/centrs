import { describe, expect, test } from "bun:test";
import {
	mapRouterOsError,
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
