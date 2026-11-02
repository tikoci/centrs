/**
 * #586: a `#` or `?` in a read path cut the appended `/print` off the REST URL,
 * so `retrieve '/system/reboot#' --no-validate` posted to `/rest/system/reboot`
 * and rebooted a CHR 7.24.5; `api` with `--attribute` did the same. These pin
 * the menu-path grammar, the REST URL backstop, and that nothing is sent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	assertRestRequestPath,
	assertRouterOsMenuPath,
	invalidMenuSegments,
} from "../../src/core/menu-path.ts";
import {
	api,
	CentrsError,
	createProtocolAdapter,
	retrieve,
	validateApiRequestShape,
	validateRetrieveRequestShape,
} from "../../src/index.ts";

const originalFetch = globalThis.fetch;
const fetched: string[] = [];

function stubFetch(): void {
	fetched.length = 0;
	globalThis.fetch = (async (input: string | URL | Request) => {
		fetched.push(String(input instanceof Request ? input.url : input));
		return new Response("[]", {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function errorCode(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error) {
		return error instanceof CentrsError ? error.code : String(error);
	}
	return undefined;
}

async function asyncErrorCode(
	fn: () => Promise<unknown>,
): Promise<string | undefined> {
	try {
		await fn();
	} catch (error) {
		return error instanceof CentrsError ? error.code : String(error);
	}
	return undefined;
}

/** The URL tricks that rewrite `<path>/print` (WHATWG parsing, Bun 1.4). */
const URL_REWRITING = [
	"/system/reboot#",
	"/system/reboot?",
	"/system/reset-configuration#",
	"/system/shutdown?x",
	"/system/reboot\\",
	"/system/reboot\t",
	"/system/reboot\n",
	"/system/reboot/..",
	"/ip/address/./x",
	"/system/identity/%2e%2e/reboot",
	"/system/identity/.%2E/reboot",
	"/ip/%2e/address",
];

describe("menu-path grammar (#586)", () => {
	test("accepts real menu names, including a leading digit", () => {
		for (const path of [
			"/system/resource",
			"/ip/address",
			"/interface/6to4",
			"/IP/Address",
			"/ip/dhcp-server/lease",
			"/ip/address/",
		]) {
			expect(invalidMenuSegments(path)).toEqual([]);
			expect(() => assertRouterOsMenuPath(path)).not.toThrow();
		}
	});

	test("rejects every URL-rewriting form and other non-menu segments", () => {
		for (const path of [
			...URL_REWRITING,
			"/system/reboot%23",
			"/ip address",
			"/ip/-address",
		]) {
			expect(errorCode(() => assertRouterOsMenuPath(path))).toBe(
				"input/invalid-routeros-path",
			);
		}
	});

	test("names the offending segment in context", () => {
		try {
			assertRouterOsMenuPath("/system/reboot#");
			throw new Error("expected a rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(CentrsError);
			const centrs = error as CentrsError;
			expect(centrs.context).toMatchObject({
				path: "/system/reboot#",
				invalidSegments: ["reboot#"],
			});
			expect(centrs.remediation).toContain("--query");
		}
	});
});

describe("REST URL backstop (#586)", () => {
	test("refuses paths the URL parser would rewrite", () => {
		for (const path of URL_REWRITING) {
			expect(errorCode(() => assertRestRequestPath(`${path}/print`))).toBe(
				"input/invalid-routeros-path",
			);
		}
	});

	test("leaves ordinary REST paths alone, including ids and names", () => {
		for (const path of [
			"/ip/address/print",
			"/ip/address/*1A",
			// A space cannot reinterpret the URL (RouterOS does not decode
			// `%20`), so the backstop passes it; it is not a working address.
			"/interface/ether 1",
			"/execute",
			"/console/inspect",
			"/a/%2e%2e%2e/b",
		]) {
			expect(() => assertRestRequestPath(path)).not.toThrow();
		}
	});

	test("the REST adapter sends nothing for a rewriting path", async () => {
		stubFetch();
		const adapter = createProtocolAdapter({
			protocol: "rest-api",
			host: "192.0.2.10",
			port: 80,
			tls: false,
			baseUrl: "http://192.0.2.10:80/rest",
			username: "admin",
			password: "secret",
			timeoutMs: 1_000,
		});
		for (const path of ["/system/reboot#", "/system/reboot?"]) {
			expect(
				await asyncErrorCode(() =>
					adapter.list(path, { proplist: ["uptime"] }),
				),
			).toBe("input/invalid-routeros-path");
			expect(await asyncErrorCode(() => adapter.list(path, {}))).toBe(
				"input/invalid-routeros-path",
			);
			expect(
				await asyncErrorCode(() => adapter.execute({ path, command: "print" })),
			).toBe("input/invalid-routeros-path");
		}
		expect(fetched).toEqual([]);
	});
});

describe("read surfaces reject before resolution (#586)", () => {
	test("retrieve's request shape rejects a non-menu path with validation off", () => {
		for (const path of URL_REWRITING) {
			expect(
				errorCode(() =>
					validateRetrieveRequestShape({
						path,
						validate: false,
						attribute: "uptime",
					}),
				),
			).toBe("input/invalid-routeros-path");
		}
	});

	test("api's request shape rejects a non-menu endpoint", () => {
		for (const endpoint of [
			"/system/reboot#",
			"system/reboot?",
			"/rest/system/reboot#",
		]) {
			expect(
				errorCode(() => validateApiRequestShape({ endpoint, validate: false })),
			).toBe("input/invalid-routeros-path");
		}
		// The lenient forms still normalize: `/rest` prefix, row id, `listen`.
		for (const endpoint of [
			"/rest/ip/address",
			"ip address",
			"ip/address/*1",
			"ip/address/listen",
		]) {
			expect(() => validateApiRequestShape({ endpoint })).not.toThrow();
		}
	});

	test("library retrieve() and api() send no request for the reported paths", async () => {
		stubFetch();
		const target = {
			host: "192.0.2.10",
			username: "admin",
			password: "secret",
			via: "rest-api",
			validate: false,
		};
		expect(
			await asyncErrorCode(() =>
				retrieve(
					{ ...target, path: "/system/reboot#", attribute: "uptime" },
					{},
				),
			),
		).toBe("input/invalid-routeros-path");
		expect(
			await asyncErrorCode(() =>
				api(
					{ ...target, endpoint: "/system/reboot#", proplist: ["uptime"] },
					{},
				),
			),
		).toBe("input/invalid-routeros-path");
		expect(fetched).toEqual([]);
	});
});
