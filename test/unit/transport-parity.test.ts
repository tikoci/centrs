import { describe, expect, test } from "bun:test";
import type { ProtocolAdapter } from "../../src/index.ts";
import {
	captureNative,
	captureRest,
	type LogicalOp,
	logicalFromNative,
	logicalFromRest,
	type ScriptedReply,
} from "./parity-harness.ts";

/**
 * Cross-transport parity suite (#129): every logical operation both structured
 * transports claim must normalize to the SAME {@link LogicalOp} on the wire,
 * and surface the same data for equivalent canned replies. A failure here
 * means the REST and native adapters silently diverged (the #125 `as-string`
 * class) — fix the adapter, not the normalizer, unless the divergence is a
 * documented transport idiom (then teach the normalizer the equivalence with
 * a comment citing `src/protocols/adapter.ts`).
 */

interface WireParityCase {
	name: string;
	op: (adapter: ProtocolAdapter) => Promise<unknown>;
	/** Canned REST responses, one per expected call. */
	restResponses: readonly unknown[];
	/** Canned native replies, one per expected command sentence. */
	nativeReplies: readonly ScriptedReply[];
	/** Expected op count on each transport (default 1). */
	wireOps?: number;
	/**
	 * Attributes the (single-op) normalized wire op MUST carry, asserted on both
	 * transports independently. Guards against a vacuous pass where both adapters
	 * drop a required word (e.g. `as-string`) and still compare equal.
	 */
	requireAttributes?: Record<string, string | true>;
}

const wireCases: readonly WireParityCase[] = [
	{
		name: "list (plain)",
		op: (adapter) => adapter.list("/interface", {}),
		restResponses: [[]],
		nativeReplies: [[["!done"]]],
	},
	{
		name: "list (proplist + detail)",
		op: (adapter) =>
			adapter.list("/interface", {
				proplist: ["name", "type"],
				detail: true,
			}),
		restResponses: [[]],
		nativeReplies: [[["!done"]]],
	},
	{
		name: "getSingleton",
		op: (adapter) => adapter.getSingleton("/system/resource"),
		restResponses: [{}],
		nativeReplies: [[["!done"]]],
	},
	{
		name: "inspect (child)",
		op: (adapter) => adapter.inspect("child", "system,resource"),
		restResponses: [[]],
		nativeReplies: [[["!done"]]],
	},
	{
		name: "execute (structured add)",
		op: (adapter) =>
			adapter.execute({
				path: "/ip/address",
				command: "add",
				attributes: { address: "192.0.2.5/24", interface: "ether1" },
			}),
		restResponses: [[]],
		nativeReplies: [[["!done"]]],
	},
	{
		// The #125 regression class: both transports MUST send `as-string` so a
		// script /execute blocks and returns captured output, not an async job id.
		name: "execute (script carries as-string)",
		op: (adapter) =>
			adapter.execute({
				path: "/system/resource",
				command: "print",
				script: ":put [/system/resource/ get version]",
			}),
		restResponses: [{ ret: "" }],
		nativeReplies: [[["!done", "=ret="]]],
		requireAttributes: { "as-string": true },
	},
	{
		name: "apiRequest print (id + query + proplist)",
		op: (adapter) =>
			adapter.apiRequest({
				verb: "print",
				path: "/ip/address",
				id: "*1",
				query: ["dynamic=false"],
				proplist: ["address"],
			}),
		restResponses: [[{ address: "192.0.2.5/24" }]],
		nativeReplies: [[["!re", "=address=192.0.2.5/24"], ["!done"]]],
	},
	{
		name: "apiRequest add",
		op: (adapter) =>
			adapter.apiRequest({
				verb: "add",
				path: "/ip/address",
				attributes: { address: "192.0.2.5/24", interface: "ether1" },
			}),
		restResponses: [{ ".id": "*A" }],
		nativeReplies: [[["!done", "=ret=*A"]]],
	},
	{
		name: "apiRequest set",
		op: (adapter) =>
			adapter.apiRequest({
				verb: "set",
				path: "/ip/address",
				id: "*1",
				attributes: { comment: "lab" },
			}),
		restResponses: [null],
		nativeReplies: [[["!done"]]],
	},
	{
		name: "apiRequest remove",
		op: (adapter) =>
			adapter.apiRequest({ verb: "remove", path: "/ip/address", id: "*1" }),
		restResponses: [null],
		nativeReplies: [[["!done"]]],
	},
	{
		name: "apiRequest run (script carries as-string)",
		op: (adapter) =>
			adapter.apiRequest({
				verb: "run",
				path: "/",
				script: ":put 1",
			}),
		restResponses: [{ ret: "1" }],
		nativeReplies: [[["!done", "=ret=1"]]],
		requireAttributes: { "as-string": true },
	},
	{
		name: "apiRequest run (structured command)",
		op: (adapter) =>
			adapter.apiRequest({
				verb: "run",
				path: "/tool/fetch",
				attributes: { url: "http://192.0.2.1/x" },
			}),
		restResponses: [[]],
		nativeReplies: [[["!done"]]],
	},
];

describe("wire parity: rest-api and native-api emit the same logical op", () => {
	for (const parityCase of wireCases) {
		test(parityCase.name, async () => {
			const rest = await captureRest(parityCase.restResponses, parityCase.op);
			const native = await captureNative(
				parityCase.nativeReplies,
				parityCase.op,
			);
			const expected = parityCase.wireOps ?? 1;
			expect(rest.calls).toHaveLength(expected);
			expect(native.sentences).toHaveLength(expected);
			for (let index = 0; index < expected; index += 1) {
				const restOp = logicalFromRest(rest.calls[index] as never);
				const nativeOp = logicalFromNative(native.sentences[index] as never);
				expect(restOp).toEqual(nativeOp as LogicalOp);
				if (parityCase.requireAttributes && expected === 1) {
					for (const [key, value] of Object.entries(
						parityCase.requireAttributes,
					)) {
						// Assert on BOTH sides, not just via equality: if both adapters
						// dropped the word they would still compare equal (a vacuous pass).
						expect(restOp.attributes[key]).toEqual(value);
						expect(nativeOp.attributes[key]).toEqual(value);
					}
				}
			}
		});
	}
});

describe("harness self-test: the normalizers can detect divergence", () => {
	test("a script execute missing as-string on one side does NOT match", () => {
		// Re-create the #125 bug shape by hand: REST sends `as-string`, native
		// forgets it. The logical ops must differ, or the whole suite is vacuous.
		const restOp = logicalFromRest({
			method: "POST",
			path: "/execute",
			body: { script: ":put 1", "as-string": "" },
		});
		const brokenNativeOp = logicalFromNative(["/execute", "=script=:put 1"]);
		expect(restOp).not.toEqual(brokenNativeOp);
		const fixedNativeOp = logicalFromNative([
			"/execute",
			"=script=:put 1",
			"=as-string=",
		]);
		expect(restOp).toEqual(fixedNativeOp);
	});

	test("a dropped query word does NOT match", () => {
		const restOp = logicalFromRest({
			method: "POST",
			path: "/ip/address/print",
			body: { ".query": ["dynamic=false"] },
		});
		expect(restOp).not.toEqual(logicalFromNative(["/ip/address/print"]));
		expect(restOp).toEqual(
			logicalFromNative(["/ip/address/print", "?dynamic=false"]),
		);
	});
});

describe("result parity: equivalent replies surface identical data", () => {
	test("list returns the same records", async () => {
		const rows = [{ name: "ether1", type: "ether" }];
		const op = (adapter: ProtocolAdapter) => adapter.list("/interface", {});
		const rest = await captureRest([rows], op);
		const native = await captureNative(
			[[["!re", "=name=ether1", "=type=ether"], ["!done"]]],
			op,
		);
		expect(native.result).toEqual(rest.result);
		expect(rest.result).toEqual(rows);
	});

	test("execute script returns the same captured ret", async () => {
		const op = (adapter: ProtocolAdapter) =>
			adapter.execute({
				path: "/system/identity",
				command: "print",
				script: ":put [/system/identity/ get name]",
			});
		const rest = await captureRest([{ ret: "MikroTik" }], op);
		const native = await captureNative([[["!done", "=ret=MikroTik"]]], op);
		expect(native.result).toEqual(rest.result);
		expect(rest.result).toEqual({ records: [], ret: "MikroTik" });
	});

	test("apiRequest print by id unwraps to one object on both", async () => {
		const row = { ".id": "*1", address: "192.0.2.5/24" };
		const op = (adapter: ProtocolAdapter) =>
			adapter.apiRequest({ verb: "print", path: "/ip/address", id: "*1" });
		const rest = await captureRest([row], op);
		const native = await captureNative(
			[[["!re", "=.id=*1", "=address=192.0.2.5/24"], ["!done"]]],
			op,
		);
		expect(native.result).toEqual(rest.result);
		expect(rest.result).toEqual({ data: row });
	});

	test("apiRequest set/remove surface null on both (bare done)", async () => {
		const op = (adapter: ProtocolAdapter) =>
			adapter.apiRequest({
				verb: "remove",
				path: "/ip/address",
				id: "*1",
			});
		const rest = await captureRest([null], op);
		const native = await captureNative([[["!done"]]], op);
		expect(native.result).toEqual(rest.result);
		expect(rest.result).toEqual({ data: null });
	});

	test("apiRequest add carries the new id on both (documented shape delta)", async () => {
		// Intentional cross-transport delta (src/protocols/adapter.ts,
		// restStyleMutationData): REST returns the created object, native only
		// `{".id"}`. Parity here is the id itself, not the full body.
		const op = (adapter: ProtocolAdapter) =>
			adapter.apiRequest({
				verb: "add",
				path: "/ip/address",
				attributes: { address: "192.0.2.5/24" },
			});
		const rest = await captureRest(
			[{ ".id": "*A", address: "192.0.2.5/24" }],
			op,
		);
		const native = await captureNative([[["!done", "=ret=*A"]]], op);
		const restId = (rest.result as { data: Record<string, string> }).data[
			".id"
		];
		const nativeId = (native.result as { data: Record<string, string> }).data[
			".id"
		];
		expect(nativeId).toBe("*A");
		expect(restId).toBe(nativeId);
	});
});
