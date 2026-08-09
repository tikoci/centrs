/**
 * #202c-2's transport rules and their fail-closed neighbors.
 *
 * The positive rows are the Q8 shapes runtime-exercised on CHR 7.23.2 and
 * 7.24rc2. These unit tests pin their offline projection; they do not replace
 * that already-recorded device evidence with mocks.
 *
 * Four rules are keyed on a literal verb (`add`/`get`/`set`/`remove`), `print`
 * has its three shapes, and the fifth — exercised as `/ip/dns/cache flush` —
 * was recorded as the RULE `action → POST /rest/<path>/<command>`, so every
 * other verb rides it. What that rule does NOT claim is that the verb exists;
 * see `src/explain/transport.ts` for why a catalog miss narrows the basis
 * instead of the classification.
 */

import { describe, expect, test } from "bun:test";
import {
	explainCommand,
	explainEnvelope,
	renderExplainEnvelope,
} from "../../src/explain.ts";

function transport(input: string, curl = false) {
	const statement = explainCommand(input, { curl }).structure.statements[0];
	if (statement?.kind !== "command" || statement.transport === undefined)
		throw new Error(`expected a classified command for ${input}`);
	return statement.transport;
}

describe("the runtime-exercised Q8 REST shapes", () => {
	const cases = [
		["bare print", "/ip/address print", "GET", "/rest/ip/address", undefined],
		[
			"singleton print",
			"/system/identity print",
			"GET",
			"/rest/system/identity",
			undefined,
		],
		[
			"print proplist",
			"/ip/address print proplist=name,address",
			"POST",
			"/rest/ip/address/print",
			{ ".proplist": ["name", "address"] },
		],
		[
			"print where",
			"/ip/address print where interface=ether1",
			"POST",
			"/rest/ip/address/print",
			{ ".query": ["interface=ether1"] },
		],
		[
			"add",
			"/ip/address add address=198.51.100.10/32 interface=ether1",
			"PUT",
			"/rest/ip/address",
			{ address: "198.51.100.10/32", interface: "ether1" },
		],
		["get", "/ip/address get *A", "GET", "/rest/ip/address/*A", undefined],
		[
			"set",
			"/ip/address set *A comment=uplink",
			"PATCH",
			"/rest/ip/address/*A",
			{ comment: "uplink" },
		],
		[
			"remove",
			"/ip/address remove *A",
			"DELETE",
			"/rest/ip/address/*A",
			undefined,
		],
		// The action row exactly as the probe ran it, empty body included.
		["action", "/ip/dns/cache flush", "POST", "/rest/ip/dns/cache/flush", {}],
		[
			"action with attributes",
			"/system/script run .id=*A",
			"POST",
			"/rest/system/script/run",
			{ ".id": "*A" },
		],
	] as const;

	for (const [name, input, method, path, body] of cases)
		test(name, () => {
			const result = transport(input);
			expect(result.classification).toBe("api-candidate");
			expect(result.rest).toEqual({
				method,
				path,
				...(body === undefined ? {} : { body }),
			});
			expect(result.centrs).toContain("centrs api");
			expect(result.curl).toBeUndefined();
		});

	test("print facets keep centrs api on the semantic GET/print surface", () => {
		const result = transport("/ip/address print proplist=name,address");
		expect(result.centrs).toBe(
			"centrs api '<router>' '/ip/address' --proplist 'name,address'",
		);
		expect(result.centrs).not.toContain("-X POST");
	});
});

describe("the boundary stays closed", () => {
	test("an action operand offline cannot name refuses the POST", () => {
		for (const input of [
			"/ip/address enable 0",
			"/ip/address enable *A",
			"/interface/ethernet monitor 0",
		]) {
			const result = transport(input, true);
			expect(result.classification).toBe("unknown");
			expect(result.basis).toContain("offline cannot name the operand");
			expect(result.rest).toBeUndefined();
			expect(result.curl).toBeUndefined();
		}
	});

	test("find has no standalone mapping", () => {
		for (const input of [
			"/ip/address find where interface=ether1",
			"/ip/address find",
		]) {
			const result = transport(input);
			expect(result.classification).toBe("unknown");
			expect(result.basis).toContain("selects rows");
		}
	});

	test("the action rule names its evidence in both directions", () => {
		expect(transport("/system/reboot").basis).toContain(
			"the CLI Reference catalog names /system/reboot a command",
		);
		// A catalog MISS is not a refusal — `catalog.ts` does not enumerate the
		// generic leaves — so it lands in the basis, not in the classification.
		const missed = transport("/system/script run .id=*A");
		expect(missed.classification).toBe("api-candidate");
		expect(missed.basis).toContain("no offline source can confirm");
	});

	test("an inherited Object.prototype key is not a verb rule", () => {
		// `TESTED_REST_RULES["constructor"]` is a function, not `undefined`. If the
		// lookup were unguarded it would satisfy the rule check and then read
		// `undefined` out of every shape field, emitting a request with no method.
		const result = transport("/ip/address constructor comment=x", true);
		expect(result.rest?.method).toBe("POST");
		expect(result.rest?.path).toBe("/rest/ip/address/constructor");
		expect(result.curl).not.toContain("undefined");
	});

	test("the action endpoint keeps the verb as written", () => {
		// RouterOS paths are case-sensitive; lower-casing is for lookups only.
		expect(transport("/ip/address toString comment=x").rest?.path).toBe(
			"/rest/ip/address/toString",
		);
	});

	test("get needs one literal RouterOS id", () => {
		expect(transport("/ip/address get").classification).toBe("unknown");
		expect(transport("/ip/address get 0").classification).toBe("unknown");
	});

	test("selector-less set preserves the singleton/table ambiguity", () => {
		const result = transport("/ip/dns set allow-remote-requests=yes", true);
		expect(result.classification).toBe("unknown");
		expect(result.basis).toContain("singleton menu");
		expect(result.curl).toBeUndefined();
	});

	test("selector writes and dynamic values route to execute before verb mapping", () => {
		for (const input of [
			"/ip/address remove [find comment=x]",
			"/ip/address enable [find comment=x]",
			"/ip/route add gateway=$GW",
		]) {
			const result = transport(input, true);
			expect(result.classification).toBe("execute");
			expect(result.centrs).toContain("centrs execute");
			expect(result.curl).toBeUndefined();
		}
	});

	test("unsupported print operands do not hitchhike on bare GET", () => {
		const result = transport("/ip/address print detail", true);
		expect(result.classification).toBe("unknown");
		expect(result.basis).toContain("outside the tested");
		expect(result.curl).toBeUndefined();
	});

	test("unexercised empty bodies and raw print queries stay unknown", () => {
		for (const input of [
			"/ip/address add",
			"/ip/address set *A",
			"/ip/address print proplist=",
			"/ip/address print ?interface=ether1",
		])
			expect(transport(input, true).classification).toBe("unknown");
	});

	test("only the exercised name=value where spelling becomes a .query", () => {
		for (const input of [
			// A bare property name — RouterOS `where` accepts it, `.query` was never
			// exercised with it.
			"/ip/address print where disabled",
			// An empty value.
			"/ip/address print where interface=",
			// An infix comparison.
			"/ip/address print where address>1.1.1.1",
			// A repeated `where`: the second one is a token like any other, and a
			// permissive bare-name rule would have swallowed it as a query term.
			"/ip/address print where a=1 where b=2",
		]) {
			const result = transport(input, true);
			expect(result.classification).toBe("unknown");
			expect(result.basis).toContain("has no tested .query translation");
			expect(result.rest).toBeUndefined();
		}
	});

	test("REST's own comparison word is not a where spelling", () => {
		// `>name=value` is how `.query` writes a comparison on the wire; typed into
		// a `where` clause it is not an argument name at all, so the lexer refuses
		// the list one layer earlier and the statement routes to execute.
		const result = transport("/ip/address print where >interface=ether1", true);
		expect(result.classification).toBe("execute");
		expect(result.rest).toBeUndefined();
	});

	test("a query word carries the decoded value, not the source bytes", () => {
		// `comment="my thing"` filters on `my thing`. Shipping the quotes would
		// query for a value no row holds.
		expect(
			transport('/ip/address print where comment="my thing"').rest?.body,
		).toEqual({ ".query": ["comment=my thing"] });
	});

	test("projection is rejected on either side of where", () => {
		for (const input of [
			"/ip/address print proplist=name where interface=ether1",
			"/ip/address print where interface=ether1 proplist=name",
		]) {
			const result = transport(input, true);
			expect(result.classification).toBe("unknown");
			expect(result.basis).toContain("combined print projection and query");
			expect(result.rest).toBeUndefined();
		}
	});

	test("classification is attached independently to every statement", () => {
		const statements = explainCommand(
			"/ip/address print; :put done; /ip/address enable 0",
		).structure.statements;
		expect(
			statements.map((statement) => statement.transport?.classification),
		).toEqual(["api-candidate", "execute", "unknown"]);
		expect(statements[1]?.transport?.centrs).toContain("':put done'");
	});

	test("menus, refusals, and subcommands do not acquire transport fields", () => {
		for (const input of ["/ip/address", "nonsense"]) {
			const statement = explainCommand(input).structure.statements[0];
			expect(statement).toBeDefined();
			expect(statement === undefined ? true : "transport" in statement).toBe(
				false,
			);
		}
		const subcommand = explainCommand("/ip/address remove [find comment=x]")
			.structure.subcommands[0];
		expect(subcommand).toBeDefined();
		expect(subcommand === undefined ? true : "transport" in subcommand).toBe(
			false,
		);
	});
});

describe("rendering", () => {
	test("curl is opt-in and carries only placeholders", () => {
		const hidden = transport("/ip/address print");
		const shown = transport("/ip/address print", true);
		expect(hidden.curl).toBeUndefined();
		expect(shown.curl).toBe(
			"curl --user '<username>:<password>' --request GET 'https://<router>/rest/ip/address'",
		);
	});

	test("body values are shell-quoted without changing JSON", () => {
		const result = transport('/ip/address add comment="owner\'s uplink"', true);
		expect(result.classification).toBe("api-candidate");
		expect(result.rest?.body).toEqual({ comment: "owner's uplink" });
		expect(result.curl).toContain("owner");
		expect(result.curl).toContain("'\"'\"'");
	});

	test("body curl and centrs fields retain source order", () => {
		const result = transport(
			"/ip/address add interface=ether1 address=198.51.100.10/32",
			true,
		);
		expect(result.curl).toBe(
			"curl --user '<username>:<password>' --request PUT --header 'Content-Type: application/json' --data '{\"interface\":\"ether1\",\"address\":\"198.51.100.10/32\"}' 'https://<router>/rest/ip/address'",
		);
		expect(result.centrs).toBe(
			"centrs api '<router>' '/ip/address' -X PUT -f 'interface=ether1' -f 'address=198.51.100.10/32'",
		);
	});

	test("text rendering shows the selected route and optional commands", () => {
		const text = renderExplainEnvelope(
			explainEnvelope("/ip/address print", { curl: true }),
			"text",
		);
		expect(text).toContain("via=api-candidate");
		expect(text).toContain("centrs: centrs api '<router>' '/ip/address'");
		expect(text).toContain("curl: curl --user '<username>:<password>'");
	});

	test("a refused route states its reason in the default surface", () => {
		const text = renderExplainEnvelope(
			explainEnvelope("/ip/dns set allow-remote-requests=yes"),
			"text",
		);
		expect(text).toContain("via=unknown");
		expect(text).toContain("why: offline cannot distinguish a singleton menu");
	});

	test("transport facts cite their own canonicalizer pass", () => {
		const data = explainCommand("/ip/address print");
		const result = data.structure.statements[0]?.transport;
		expect(
			data.evidence.find((entry) => entry.id === result?.ev),
		).toMatchObject({
			probe: "classifyExplainTransport",
			basis: "heuristic",
		});
	});
});
