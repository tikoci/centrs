/**
 * Anchor tests for `--query` (`src/core/query.ts`) and its retrieve wiring.
 * The compiled words are pinned here; whether they select the rows RouterOS's
 * own `print where` selects is grounded on CHR in
 * `test/integration/retrieve-query.test.ts` (#397).
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { api, buildApiQuery, resolveApiRequest } from "../../src/api.ts";
import { inspectWhereBooleans } from "../../src/core/inspect.ts";
import { compileQueryWords, parseQueries } from "../../src/core/query.ts";
import { CentrsError } from "../../src/errors.ts";
import { type RetrieveRequest, retrieve } from "../../src/retrieve.ts";

const ENV = {
	HOME: "/nonexistent-centrs-query-test",
	CENTRS_SKIP_ENV_FILE: "1",
};

function words(
	expressions: string | string[],
	booleans: string[] = [],
): string[] {
	return compileQueryWords(
		parseQueries([expressions].flat()),
		new Set(booleans),
	);
}

function refusal(expression: string): CentrsError {
	try {
		parseQueries([expression]);
	} catch (error) {
		if (error instanceof CentrsError) return error;
		throw error;
	}
	throw new Error(`expected ${expression} to be refused`);
}

describe("compileQueryWords", () => {
	test("comparisons map to query words", () => {
		expect(words("name=ether1")).toEqual(["name=ether1"]);
		expect(words("name!=ether1")).toEqual(["name=ether1", "#!"]);
		// `where` counts a row without the property as smaller than any value.
		expect(words("mtu<1500")).toEqual(["<mtu=1500", "-mtu", "#|"]);
		expect(words("mtu>1500")).toEqual([">mtu=1500"]);
		expect(words("mtu<=1500")).toEqual([">mtu=1500", "#!"]);
		expect(words("mtu>=1500")).toEqual(["<mtu=1500", "-mtu", "#|", "#!"]);
	});

	test("a bare name is =yes for a boolean and 'is set' otherwise", () => {
		expect(words("disabled", ["disabled"])).toEqual(["disabled=yes"]);
		expect(words("!disabled", ["disabled"])).toEqual(["disabled=yes", "#!"]);
		expect(words("comment")).toEqual(["comment"]);
		expect(words("!comment")).toEqual(["comment", "#!"]);
	});

	test("and binds tighter than or; parentheses and ! group", () => {
		expect(words("a=1 or b=2 and c=3")).toEqual([
			"a=1",
			"b=2",
			"c=3",
			"#&",
			"#|",
		]);
		expect(words("(a=1 or b=2) and c=3")).toEqual([
			"a=1",
			"b=2",
			"#|",
			"c=3",
			"#&",
		]);
		expect(words("a=1 && b=2 || c=3")).toEqual([
			"a=1",
			"b=2",
			"#&",
			"c=3",
			"#|",
		]);
		expect(words("!(a=1 or b=2)")).toEqual(["a=1", "b=2", "#|", "#!"]);
	});

	test("several expressions are AND-ed", () => {
		expect(words(["a=1", "b=2 or c=3"])).toEqual([
			"a=1",
			"b=2",
			"c=3",
			"#|",
			"#&",
		]);
	});

	test("a value runs to whitespace or a parenthesis; quotes decode RouterOS escapes", () => {
		// The old api splitter found `>` anywhere and sent `>comment=a=b`.
		expect(words("comment=a>b")).toEqual(["comment=a>b"]);
		expect(words("comment!=x<y")).toEqual(["comment=x<y", "#!"]);
		expect(words('comment="uplink a"')).toEqual(["comment=uplink a"]);
		expect(words('comment="say \\"hi\\" \\$5 \\41"')).toEqual([
			'comment=say "hi" $5 A',
		]);
		// The device's escape set: named \a \b \f \v, uppercase-only hex, and a
		// backslash before whitespace joins lines (CHR 7.24.5).
		expect(words('comment="\\a\\b\\f\\v\\07"')).toEqual([
			"comment=\x07\b\f\v\x07",
		]);
		expect(words('comment="\\ff"')).toEqual(["comment=\ff"]);
		expect(words('comment="x\\ "')).toEqual(["comment=x"]);
		expect(words('comment="x\\\r\ny"')).toEqual(["comment=xy"]);
		expect(words("(name=ether1)")).toEqual(["name=ether1"]);
		expect(words("dst-address=0.0.0.0/0")).toEqual(["dst-address=0.0.0.0/0"]);
		expect(words(".id=*1")).toEqual([".id=*1"]);
	});

	test("names and bare names are reported for validation", () => {
		const parsed = parseQueries(["disabled and mtu>1", "!comment or mtu<9"]);
		expect(parsed.names.sort()).toEqual(["comment", "disabled", "mtu"]);
		expect(parsed.bareNames.sort()).toEqual(["comment", "disabled"]);
	});
});

describe("refusals", () => {
	test("regex and in have no query word", () => {
		const regex = refusal('name~"^ether"');
		expect(regex.code).toBe("input/unsupported-query");
		expect(regex.context).toMatchObject({ operator: "~" });
		expect(refusal("address in 10.0.0.0/8").code).toBe(
			"input/unsupported-query",
		);
	});

	test("script values need an evaluator", () => {
		for (const expression of [
			"name=$x",
			"name=[/system/identity/get name]",
			'name="$x"',
		]) {
			expect(refusal(expression).code).toBe("input/unsupported-query");
		}
	});

	test("spellings RouterOS reads differently are refused with a fix", () => {
		const bang = refusal("!list=qa");
		expect(bang.code).toBe("input/invalid-query");
		expect(bang.summary).toContain("!(list");
		expect(refusal("not disabled").summary).toContain("use `!`");
		expect(refusal("a=1 b=2").summary).toContain("`and` or `or`");
	});

	test("malformed expressions name the offset", () => {
		for (const [expression, offset] of [
			["(a=1", 0],
			["a=1)", 3],
			["a=", 1],
			['a="open', 2],
			["a=1 and", 7],
			['a="\\q"', 3],
			['a="\\0a"', 3],
			['a="\\FF"', 3],
			["a= 1", 2],
			["a= and b=1", 2],
			["=1", 0],
		] as const) {
			const error = refusal(expression);
			expect(error.code).toBe("input/invalid-query");
			expect(error.context).toMatchObject({ query: expression, offset });
		}
	});
});

describe("inspectWhereBooleans", () => {
	test("asks completion after `where <name>=` and keeps exact yes/no arg rows", async () => {
		const inputs: Array<string | undefined> = [];
		const backend = {
			async inspect(_request: string, _path: string, input?: string) {
				inputs.push(input);
				const meta = { completion: "(", show: "false", style: "syntax-meta" };
				if (input?.endsWith("disabled=")) {
					return [
						meta,
						{ completion: "no", show: "true", style: "arg" },
						{ completion: "yes", show: "true", style: "arg" },
					];
				}
				// An enum that happens to offer yes/no as values is not a boolean.
				if (input?.endsWith("mode=")) {
					return [
						meta,
						{ completion: "no", show: "true", style: "none" },
						{ completion: "yes", show: "true", style: "none" },
					];
				}
				return [meta, { completion: "<value>", show: "false", style: "none" }];
			},
		};
		const booleans = await inspectWhereBooleans(backend, "/ip/address/", [
			"disabled",
			"mode",
			"comment",
		]);
		expect([...booleans]).toEqual(["disabled"]);
		expect(inputs).toEqual([
			"/ip/address/print where disabled=",
			"/ip/address/print where mode=",
			"/ip/address/print where comment=",
		]);
	});
});

describe("api --query", () => {
	test("summaries compile bare names as 'is set' and keep raw words last", () => {
		expect(
			buildApiQuery({
				endpoint: "/interface",
				query: ["running", "type=ether"],
				rawQuery: ["-comment"],
			}),
		).toEqual(["running", "type=ether", "#&", "-comment"]);
	});

	test("a bare name is probed in the menu, not the parent of a menu POST", async () => {
		const router = new FakeRouter();
		routers.push(router);
		for (const endpoint of [
			"/ip/firewall/address-list",
			"/ip/firewall/address-list/print",
		]) {
			await api(
				{
					endpoint,
					method: "POST",
					yes: true,
					targetInput: router.url,
					username: "u",
					password: "p",
					query: ["disabled"],
				},
				ENV,
			);
		}
		const probes = router.posts
			.map((post) => post.body["input"])
			.filter((input) => input !== undefined);
		expect(probes).toEqual([
			"/ip/firewall/address-list/print where disabled=",
			"/ip/firewall/address-list/print where disabled=",
		]);
		expect(
			router.posts
				.filter((post) => post.path.startsWith("/ip/firewall/address-list"))
				.map((post) => post.body[".query"]),
		).toEqual([["disabled=yes"], ["disabled=yes"]]);
	});

	test("a bare name without validation is refused", async () => {
		const promise = resolveApiRequest(
			{
				endpoint: "/interface",
				targetInput: "127.0.0.1",
				username: "u",
				password: "p",
				validate: false,
				query: ["running"],
			},
			ENV,
		);
		await expect(promise).rejects.toMatchObject({
			code: "input/invalid-query",
		});
	});
});

type Row = Record<string, string>;

/**
 * Loopback RouterOS REST with one list menu (`/ip/firewall/address-list`,
 * `disabled` a boolean) and one singleton. Records every POST body.
 */
class FakeRouter {
	readonly posts: Array<{ path: string; body: Record<string, unknown> }> = [];
	private readonly server: Server<undefined>;
	constructor() {
		this.server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (req) => {
				const path = new URL(req.url).pathname.replace(/^\/rest/, "");
				const body =
					req.method === "POST"
						? ((await req.json()) as Record<string, unknown>)
						: {};
				this.posts.push({ path, body });
				if (path === "/console/inspect") return Response.json(inspect(body));
				if (path === "/ip/firewall/address-list/print") {
					return Response.json([{ ".id": "*1", list: "qa" } satisfies Row]);
				}
				return Response.json([]);
			},
		});
	}
	get url(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}
	stop(): void {
		this.server.stop(true);
	}
}

function inspect(body: Record<string, unknown>): unknown[] {
	const cmd = (name: string) => ({ name, "node-type": "cmd", type: "child" });
	const arg = (name: string) => ({ name, "node-type": "arg", type: "child" });
	const input = body["input"] as string | undefined;
	if (input !== undefined) {
		return input.endsWith(" disabled=")
			? ["no", "yes"].map((completion) => ({
					completion,
					show: "true",
					style: "arg",
				}))
			: [{ completion: "<value>", show: "false", style: "none" }];
	}
	if (body["request"] === "completion") {
		return ["list", "address", "comment", "disabled"].map((completion) => ({
			completion,
			show: "true",
			style: "none",
		}));
	}
	switch (body["path"]) {
		case "ip,firewall":
			return [{ name: "address-list", "node-type": "dir", type: "child" }];
		case "ip,firewall,address-list":
			return [cmd("print"), cmd("get")];
		case "ip,firewall,address-list,get":
			return [arg("number"), arg("value-name")];
		case "system,identity":
			return [cmd("print"), cmd("get")];
		case "system,identity,get":
			return [arg("value-name")];
		default:
			return [];
	}
}

const routers: FakeRouter[] = [];
afterEach(() => {
	while (routers.length > 0) routers.pop()?.stop();
});

function request(
	router: FakeRouter,
	extra: Partial<RetrieveRequest>,
): RetrieveRequest {
	return {
		targetInput: router.url,
		path: "/ip/firewall/address-list",
		username: "u",
		password: "p",
		...extra,
	};
}

describe("retrieve --query", () => {
	test("validates names, probes bare names, and posts the compiled words", async () => {
		const router = new FakeRouter();
		routers.push(router);
		const envelope = await retrieve(
			request(router, {
				query: ["disabled or comment"],
				filter: "list=qa",
			}),
			ENV,
		);
		expect(envelope.data).toEqual([{ ".id": "*1", list: "qa" }]);
		const probes = router.posts
			.map((post) => post.body["input"])
			.filter((input) => input !== undefined);
		expect(probes.sort()).toEqual([
			"/ip/firewall/address-list/print where comment=",
			"/ip/firewall/address-list/print where disabled=",
		]);
		// One attribute inspect serves both --query and --attributes checks.
		expect(
			router.posts.filter(
				(post) =>
					post.body["request"] === "completion" &&
					post.body["input"] === undefined,
			),
		).toHaveLength(1);
		const read = router.posts.find(
			(post) => post.path === "/ip/firewall/address-list/print",
		);
		// `--filter` comes first, then `--query`, AND-ed.
		expect(read?.body[".query"]).toEqual([
			"list=qa",
			"disabled=yes",
			"comment",
			"#|",
			"#&",
		]);
		expect(envelope.meta.operation).toMatchObject({
			request: { query: ["list=qa", "disabled or comment"] },
		});
	});

	test("an unknown property fails before the read", async () => {
		const router = new FakeRouter();
		routers.push(router);
		await expect(
			retrieve(request(router, { query: "lists=qa" }), ENV),
		).rejects.toMatchObject({
			code: "validation/unknown-attribute",
			context: { parameter: "lists", flag: "--query" },
		});
		expect(
			router.posts.some(
				(post) => post.path === "/ip/firewall/address-list/print",
			),
		).toBe(false);
	});

	test("a singleton has no rows to filter", async () => {
		const router = new FakeRouter();
		routers.push(router);
		await expect(
			retrieve(
				request(router, { path: "/system/identity", query: "name=x" }),
				ENV,
			),
		).rejects.toMatchObject({ code: "usage/conflicting-flags" });
		expect(
			router.posts.some((post) => post.body["request"] === "completion"),
		).toBe(false);
	});

	test("an empty --query is refused, not read as no filter", async () => {
		for (const query of ["", "  "]) {
			await expect(
				retrieve({ targetInput: "127.0.0.1", path: "/ip/address", query }, ENV),
			).rejects.toMatchObject({ code: "input/invalid-query" });
		}
	});

	test("--validate=false sends spelled-out words and refuses bare names", async () => {
		const router = new FakeRouter();
		routers.push(router);
		await retrieve(
			request(router, { query: "disabled=yes", validate: false }),
			ENV,
		);
		expect(router.posts).toEqual([
			{
				path: "/ip/firewall/address-list/print",
				body: { ".query": ["disabled=yes"] },
			},
		]);
		await expect(
			retrieve(request(router, { query: "disabled", validate: false }), ENV),
		).rejects.toMatchObject({ code: "input/invalid-query" });
	});

	test("a bad expression fails offline; --follow and --list-attributes refuse --query", async () => {
		await expect(
			retrieve(
				{ targetInput: "127.0.0.1", path: "/ip/address", query: "a=1)" },
				ENV,
			),
		).rejects.toMatchObject({ code: "input/invalid-query" });
		await expect(
			retrieve(
				{
					targetInput: "127.0.0.1",
					path: "/ip/address",
					query: "a=1",
					listAttributes: true,
				},
				ENV,
			),
		).rejects.toMatchObject({ code: "usage/conflicting-flags" });
	});
});
